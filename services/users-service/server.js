require('./tracing');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const { body } = require('express-validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const client = require('prom-client');
const { randomUUID, randomInt, createHash } = require('crypto');
const Redis = require('ioredis');
const axios = require('axios');

const app = express();
app.use(helmet());

// Configurable CORS
function getAllowedOrigins() {
  return (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:8080')
    .split(',').map(s => s.trim()).filter(Boolean);
}
const allowedOrigins = getAllowedOrigins();
app.use(cors({ origin: (origin, cb) => {
  if (!origin) return cb(null, true);
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
  cb(new Error('CORS not allowed'));
}, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Request ID & Correlation header
app.use((req, res, next) => { const id = req.headers['x-correlation-id'] || req.headers['x-request-id'] || randomUUID(); req.id = id; res.setHeader('x-correlation-id', id); next(); });
// Logger
app.use(pinoHttp({ customProps: req => ({ reqId: req.id, service: 'users' }) }));
// Metrics
client.collectDefaultMetrics();
const httpReqDuration = new client.Histogram({ name: 'http_request_duration_seconds', help: 'request duration', labelNames: ['method','route','code'] });
app.use((req, res, next) => { const end = httpReqDuration.startTimer({ method: req.method }); res.on('finish', ()=>{ end({ route: req.route?.path || req.path, code: String(res.statusCode) }); }); next(); });

// Rate limiters
const authLimiter = rateLimit({ windowMs: 10*60*1000, max: 100 });

// Models with sanitization
const userSchema = new mongoose.Schema({
  fullname: {
    firstname: { type: String, required: true, minlength: 3 },
    lastname: { type: String, minlength: 3 }
  },
  email: { type: String, required: true, unique: true, minlength: 5 },
  password: { type: String, required: true, select: false },
  socketId: { type: String }
});
userSchema.set('toJSON', { transform: (_doc, ret) => { ret.id = ret._id; delete ret._id; delete ret.__v; delete ret.password; return ret; } });
userSchema.set('toObject', { transform: (_doc, ret) => { ret.id = ret._id; delete ret._id; delete ret.__v; delete ret.password; return ret; } });
const User = mongoose.model('user', userSchema);

const BlacklistToken = mongoose.model('BlacklistToken', new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 }
}));

function genToken(id) {
  return jwt.sign({ _id: id }, process.env.JWT_SECRET, { expiresIn: '24h' });
}

let redis = null;
if (process.env.REDIS_URL) { try { redis = new Redis(process.env.REDIS_URL); } catch(_) { redis = null; } }
const NOTIFICATION_BASE_URL = process.env.NOTIFICATION_BASE_URL || 'http://notification-service:4008';

function genRefreshToken() {
  return randomUUID();
}

async function connect() {
  const uri = process.env.DB_CONNECT;
  await mongoose.connect(uri);
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'users' }));
app.get('/ready', (req, res) => { const state = mongoose.connection.readyState; return state === 1 ? res.json({ status: 'ready', db: 'connected' }) : res.status(503).json({ status: 'not_ready', dbState: state }); });
app.get('/metrics', async (_req, res) => { res.set('Content-Type', client.register.contentType); res.end(await client.register.metrics()); });

app.post('/register', authLimiter, [
  body('email').isEmail(),
  body('fullname.firstname').isLength({ min: 3 }),
  body('password').isLength({ min: 6 })
], async (req, res) => {
  const { fullname, email, password } = req.body;
  const exists = await User.findOne({ email });
  if (exists) return res.status(400).json({ message: 'User already exist' });
  const hash = await bcrypt.hash(password, 10);
  const user = await User.create({ fullname: { firstname: fullname.firstname, lastname: fullname.lastname }, email, password: hash });
  const token = genToken(user._id);
  return res.status(201).json({ token, user: user.toJSON() });
});

app.post('/login', authLimiter, [
  body('email').isEmail(),
  body('password').isLength({ min: 6 })
], async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select('+password');
  if (!user) return res.status(401).json({ message: 'Invalid email or password' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ message: 'Invalid email or password' });
const token = genToken(user._id);
  let refreshToken = null;
  if (redis) {
    try {
      refreshToken = genRefreshToken();
      await redis.setex(`refresh:users:${refreshToken}`, 7*24*3600, String(user._id));
      res.cookie('refreshToken', refreshToken, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7*24*3600*1000 });
    } catch(_) {}
  }
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 86400000 });
  return res.json({ token, refreshToken, user: user.toJSON() });
});

app.get('/profile', async (req, res) => {
  const token = req.cookies.token || (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  const bl = await BlacklistToken.findOne({ token });
  if (bl) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded._id);
    return res.json(user);
  } catch (e) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
});

app.post('/refresh', async (req, res) => {
  try {
    if (!redis) return res.status(400).json({ message: 'refresh disabled' });
    const rt = req.cookies.refreshToken || null;
    if (!rt) return res.status(401).json({ message: 'Unauthorized' });
    const userId = await redis.get(`refresh:users:${rt}`);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const token = genToken(userId);
    // rotate refresh
    await redis.del(`refresh:users:${rt}`);
    const newRt = genRefreshToken();
    await redis.setex(`refresh:users:${newRt}`, 7*24*3600, String(userId));
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 86400000 });
    res.cookie('refreshToken', newRt, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7*24*3600*1000 });
    return res.json({ token, refreshToken: newRt });
  } catch (e) { return res.status(500).json({ message: 'refresh failed' }); }
});

app.get('/logout', async (req, res) => {
  const token = req.cookies.token || (req.headers.authorization || '').split(' ')[1];
  if (token) await BlacklistToken.create({ token });
  // revoke refresh token if present
  try {
    if (redis && req.cookies.refreshToken) {
      await redis.del(`refresh:users:${req.cookies.refreshToken}`);
    }
  } catch(_) {}
  res.clearCookie('token');
  res.clearCookie('refreshToken');
  return res.json({ message: 'Logged out' });
});

// OTP helpers and endpoints
function maskEmail(email) { const [u, d] = email.split('@'); return `${u[0]}***@${d}`; }
function maskPhone(phone) { return phone ? phone.replace(/.(?=.{4})/g, '*') : ''; }
function makeOtp() { return String(randomInt(100000, 1000000)); }

// Metrics for OTP
const otpRequests = new client.Counter({ name: 'otp_requests_total', help: 'Total OTP requests', labelNames: ['channel','result'] });
const otpVerifications = new client.Counter({ name: 'otp_verifications_total', help: 'Total OTP verifications', labelNames: ['result'] });

// Request OTP for login/2FA
app.post('/otp/request', authLimiter, [
  body('email').optional().isEmail(),
  body('phone').optional().isString().isLength({ min: 8, max: 20 }),
  body('purpose').optional().isIn(['login','2fa'])
], async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ message: 'OTP unavailable' });
    const { email, phone } = req.body;
    const ident = email || phone;
    const channel = email ? 'email' : 'sms';
    if (!ident) { otpRequests.inc({ channel: 'unknown', result: 'bad_request' }); return res.status(400).json({ message: 'email or phone required' }); }

    // rate limit per identifier
    const rlKey = `otp:rl:${ident}`;
    const count = await redis.incr(rlKey);
    if (count === 1) await redis.expire(rlKey, 60); // window 60s
    if (count > 3) { otpRequests.inc({ channel, result: 'rate_limited' }); return res.status(429).json({ message: 'Too many requests' }); }

    const otp = makeOtp();
    const key = `otp:users:${ident}`;
    const pepper = process.env.OTP_PEPPER || '';
    const hashed = createHash('sha256').update(otp + pepper).digest('hex');
    await redis.setex(key, 300, hashed); // 5 minutes TTL (hashed)

    // Try to send via notification-service (best-effort)
    try {
      const headers = process.env.NOTIFICATION_API_TOKEN ? { Authorization: `Bearer ${process.env.NOTIFICATION_API_TOKEN}` } : undefined;
      if (email) {
        await axios.post(`${NOTIFICATION_BASE_URL}/send-otp`, { toEmail: email, otp, purpose: 'login' }, { timeout: 2000, headers });
      } else if (phone) {
        await axios.post(`${NOTIFICATION_BASE_URL}/send-otp`, { toPhone: phone, otp, purpose: 'login' }, { timeout: 2000, headers });
      }
    } catch (_) {
      // ignore delivery errors in request endpoint
    }

    // Log and return masked address; include devOtp in non-production for local testing
    req.log?.info?.({ ident, otp }, 'OTP generated');

    otpRequests.inc({ channel, result: 'ok' });
    const payload = { sent: true, channel, to: email ? maskEmail(email) : maskPhone(phone) };
    if (process.env.NODE_ENV !== 'production') payload.devOtp = otp;
    return res.json(payload);
  } catch (e) {
    otpRequests.inc({ channel: 'unknown', result: 'error' });
    return res.status(500).json({ message: 'failed' });
  }
});

// Verify OTP and issue token
app.post('/otp/verify', authLimiter, [
  body('email').optional().isEmail(),
  body('phone').optional().isString().isLength({ min: 8, max: 20 }),
  body('otp').isString().isLength({ min: 6, max: 6 })
], async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ message: 'OTP unavailable' });
    const { email, phone, otp } = req.body;
    const ident = email || phone;
    if (!ident) { otpVerifications.inc({ result: 'bad_request' }); return res.status(400).json({ message: 'email or phone required' }); }

    // attempts guard
    const attemptsKey = `otp:attempts:${ident}`;
    const attempts = await redis.incr(attemptsKey);
    if (attempts === 1) await redis.expire(attemptsKey, 600); // 10m window
    if (attempts > 5) { otpVerifications.inc({ result: 'blocked' }); return res.status(429).json({ message: 'Too many attempts, try later' }); }

    const key = `otp:users:${ident}`;
    const stored = await redis.get(key);
    if (!stored) { otpVerifications.inc({ result: 'expired' }); return res.status(400).json({ message: 'OTP expired or not found' }); }
    const candidate = createHash('sha256').update(otp + (process.env.OTP_PEPPER || '')).digest('hex');
    if (stored !== candidate) { otpVerifications.inc({ result: 'invalid' }); return res.status(401).json({ message: 'Invalid OTP' }); }

    // one-time use
    await redis.del(key);

    // login existing user by email (preferred) or reject if not found
    let user = null;
    if (email) user = await User.findOne({ email });
    // For phone-based flows, extend schema in future
    if (!user) { otpVerifications.inc({ result: 'no_user' }); return res.status(404).json({ message: 'User not found, please register' }); }

    const token = genToken(user._id);
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 86400000 });
    otpVerifications.inc({ result: 'ok' });
    return res.json({ token, user: user.toJSON() });
  } catch (e) {
    otpVerifications.inc({ result: 'error' });
    return res.status(500).json({ message: 'failed' });
  }
});

const port = process.env.PORT || 4003;
let server;
connect().then(() => { server = app.listen(port, () => console.log(`users-service on ${port}`)); });

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`${signal} received, shutting down users-service...`);
  if (server) await new Promise(r => server.close(r));
  try { if (mongoose.connection.readyState !== 0) await mongoose.connection.close(false); } catch(_) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
