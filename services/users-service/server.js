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
const { randomUUID } = require('crypto');
const Redis = require('ioredis');

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
