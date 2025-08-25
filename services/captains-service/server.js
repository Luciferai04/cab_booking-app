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
app.use(pinoHttp({ customProps: req => ({ reqId: req.id, service: 'captains' }) }));
// Metrics
client.collectDefaultMetrics();
const httpReqDuration = new client.Histogram({ name: 'http_request_duration_seconds', help: 'request duration', labelNames: ['method','route','code'] });
app.use((req, res, next) => { const end = httpReqDuration.startTimer({ method: req.method }); res.on('finish', ()=>{ end({ route: req.route?.path || req.path, code: String(res.statusCode) }); }); next(); });

// Rate limiters
const authLimiter = rateLimit({ windowMs: 10*60*1000, max: 100 });

const captainSchema = new mongoose.Schema({
  fullname: {
    firstname: { type: String, required: true, minlength: 3 },
    lastname: { type: String, minlength: 3 }
  },
  email: { type: String, required: true, unique: true, lowercase: true, match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'] },
  password: { type: String, required: true, select: false },
  socketId: { type: String },
  status: { type: String, enum: ['active','inactive'], default: 'inactive' },
  vehicle: {
    color: { type: String, required: true, minlength: 3 },
    plate: { type: String, required: true, minlength: 3 },
    capacity: { type: Number, required: true, min: 1 },
    vehicleType: { type: String, required: true, enum: ['car','motorcycle','auto'] }
  },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: [0,0] }
  }
});
// Sanitization transforms
captainSchema.set('toJSON', { transform: (_doc, ret) => { ret.id = ret._id; delete ret._id; delete ret.__v; delete ret.password; return ret; } });
captainSchema.set('toObject', { transform: (_doc, ret) => { ret.id = ret._id; delete ret._id; delete ret.__v; delete ret.password; return ret; } });
captainSchema.index({ location: '2dsphere' });
const Captain = mongoose.model('captain', captainSchema);

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

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'captains' }));
app.get('/ready', (req, res) => { const state = mongoose.connection.readyState; return state === 1 ? res.json({ status: 'ready', db: 'connected' }) : res.status(503).json({ status: 'not_ready', dbState: state }); });
app.get('/metrics', async (_req, res) => { res.set('Content-Type', client.register.contentType); res.end(await client.register.metrics()); });

app.post('/register', authLimiter, [
  body('email').isEmail(),
  body('fullname.firstname').isLength({ min: 3 }),
  body('password').isLength({ min: 6 }),
  body('vehicle.color').isLength({ min: 3 }),
  body('vehicle.plate').isLength({ min: 3 }),
  body('vehicle.capacity').isInt({ min: 1 }),
  body('vehicle.vehicleType').isIn(['car','motorcycle','auto'])
], async (req, res) => {
  const { fullname, email, password, vehicle } = req.body;
  const exists = await Captain.findOne({ email });
  if (exists) return res.status(400).json({ message: 'Captain already exist' });
  const hash = await bcrypt.hash(password, 10);
  const captain = await Captain.create({
    fullname: { firstname: fullname.firstname, lastname: fullname.lastname },
    email,
    password: hash,
    vehicle: {
      color: vehicle.color,
      plate: vehicle.plate,
      capacity: vehicle.capacity,
      vehicleType: vehicle.vehicleType
    }
  });
  const token = genToken(captain._id);
  return res.status(201).json({ token, captain: captain.toJSON() });
});

app.post('/login', authLimiter, [
  body('email').isEmail(),
  body('password').isLength({ min: 6 })
], async (req, res) => {
  const { email, password } = req.body;
  const captain = await Captain.findOne({ email }).select('+password');
  if (!captain) return res.status(401).json({ message: 'Invalid email or password' });
  const ok = await bcrypt.compare(password, captain.password);
  if (!ok) return res.status(401).json({ message: 'Invalid email or password' });
const token = genToken(captain._id);
  let refreshToken = null;
  if (redis) {
    try {
      refreshToken = genRefreshToken();
      await redis.setex(`refresh:captains:${refreshToken}`, 7*24*3600, String(captain._id));
      res.cookie('refreshToken', refreshToken, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7*24*3600*1000 });
    } catch(_) {}
  }
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 86400000 });
  return res.json({ token, refreshToken, captain: captain.toJSON() });
});

app.get('/profile', async (req, res) => {
  const token = req.cookies.token || (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  const bl = await BlacklistToken.findOne({ token });
  if (bl) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const captain = await Captain.findById(decoded._id);
    return res.json({ captain });
  } catch (e) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
});

// Update captain location (lat, lon) and optionally status
app.post('/location', async (req, res) => {
  const token = req.cookies.token || (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  const bl = await BlacklistToken.findOne({ token });
  if (bl) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { lat, lon, status } = req.body || {};
    if (typeof lat !== 'number' || typeof lon !== 'number') return res.status(400).json({ message: 'lat and lon required' });
    const update = {
      location: { type: 'Point', coordinates: [ lon, lat ] },
      ...(status ? { status } : {})
    };
    const captain = await Captain.findByIdAndUpdate(decoded._id, update, { new: true });
    if (!captain) return res.status(404).json({ message: 'Captain not found' });
    return res.json({ captain });
  } catch (e) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
});

// Set captain status
app.post('/status', async (req, res) => {
  const token = req.cookies.token || (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  const bl = await BlacklistToken.findOne({ token });
  if (bl) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { status } = req.body || {};
    if (!status || !['active','inactive'].includes(status)) return res.status(400).json({ message: 'invalid status' });
    const captain = await Captain.findByIdAndUpdate(decoded._id, { status }, { new: true });
    if (!captain) return res.status(404).json({ message: 'Captain not found' });
    return res.json({ captain });
  } catch (e) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
});

app.post('/refresh', async (req, res) => {
  try {
    if (!redis) return res.status(400).json({ message: 'refresh disabled' });
    const rt = req.cookies.refreshToken || null;
    if (!rt) return res.status(401).json({ message: 'Unauthorized' });
    const captainId = await redis.get(`refresh:captains:${rt}`);
    if (!captainId) return res.status(401).json({ message: 'Unauthorized' });
    const token = genToken(captainId);
    await redis.del(`refresh:captains:${rt}`);
    const newRt = genRefreshToken();
    await redis.setex(`refresh:captains:${newRt}`, 7*24*3600, String(captainId));
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 86400000 });
    res.cookie('refreshToken', newRt, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7*24*3600*1000 });
    return res.json({ token, refreshToken: newRt });
  } catch (e) { return res.status(500).json({ message: 'refresh failed' }); }
});

app.get('/logout', async (req, res) => {
  const token = req.cookies.token || (req.headers.authorization || '').split(' ')[1];
  if (token) await BlacklistToken.create({ token });
  try {
    if (redis && req.cookies.refreshToken) {
      await redis.del(`refresh:captains:${req.cookies.refreshToken}`);
    }
  } catch(_) {}
  res.clearCookie('token');
  res.clearCookie('refreshToken');
  return res.json({ message: 'Logout successfully' });
});

const port = process.env.PORT || 4004;
let server;
connect().then(() => { server = app.listen(port, () => console.log(`captains-service on ${port}`)); });

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`${signal} received, shutting down captains-service...`);
  if (server) await new Promise(r => server.close(r));
  try { if (mongoose.connection.readyState !== 0) await mongoose.connection.close(false); } catch(_) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

