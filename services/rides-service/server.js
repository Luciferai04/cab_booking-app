require('./tracing');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const Queue = require('bullmq').Queue;
const Worker = require('bullmq').Worker;
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const pinoHttp = require('pino-http');
const client = require('prom-client');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const { randomUUID, createHash } = require('crypto');

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

// Request ID & Logger & Metrics
app.use((req, res, next) => { const id = req.headers['x-correlation-id'] || req.headers['x-request-id'] || randomUUID(); req.id = id; res.setHeader('x-correlation-id', id); next(); });
app.use(pinoHttp({ customProps: req => ({ reqId: req.id, service: 'rides' }) }));
client.collectDefaultMetrics();
const httpReqDuration = new client.Histogram({ name: 'http_request_duration_seconds', help: 'request duration', labelNames: ['method','route','code'] });
app.use((req, res, next) => { const end = httpReqDuration.startTimer({ method: req.method }); res.on('finish', ()=>{ end({ route: req.route?.path || req.path, code: String(res.statusCode) }); }); next(); });

const publishLimiter = rateLimit({ windowMs: 60*1000, max: 600 });

// Environment and Redis connections must be defined before any usage
const MAPS_BASE_URL = process.env.MAPS_BASE_URL || 'http://maps-service:4001';
const SOCKET_BASE_URL = process.env.SOCKET_BASE_URL || 'http://socket-service:4002';
const REDIS_URL = process.env.REDIS_URL || '';
const REDIS_CONN = REDIS_URL ? (() => { try { const u = new URL(REDIS_URL); return { connection: { host: u.hostname, port: Number(u.port)||6379, password: u.password || undefined } }; } catch { return { connection: {} }; } })() : { connection: {} };
let redisPub = null;
if (REDIS_URL) { redisPub = new Redis(REDIS_URL); }

// Job queue for offer ack/timeout
const OFFERS_QUEUE = 'ride_offers';
let offersQueue = null;
if (REDIS_URL) {
  offersQueue = new Queue(OFFERS_QUEUE, REDIS_CONN);
}

// Register minimal models so Mongoose populate works across services
mongoose.model('user', new mongoose.Schema({ socketId: String }, { strict: false }));
mongoose.model('captain', new mongoose.Schema({}, { strict: false }));

const Ride = mongoose.model('ride', new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  captain: { type: mongoose.Schema.Types.ObjectId, ref: 'captain' },
  pickup: { type: String, required: true },
  destination: { type: String, required: true },
  fare: { type: Number, required: true },
  status: { type: String, enum: ['pending','accepted','ongoing','completed','cancelled'], default: 'pending' },
  duration: { type: Number },
  distance: { type: Number },
  otp: { type: String, select: false, required: true }
}));

// Dispatch persistence for auditability and retries
const Dispatch = mongoose.model('dispatch', new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  pickup: String,
  destination: String,
  vehicleType: String,
  candidates: [{
    captainId: mongoose.Schema.Types.ObjectId,
    socketId: String,
    etaSec: Number,
    status: { type: String, enum: ['pending','offered','ack','timeout','rejected','skipped','assigned'], default: 'pending' }
  }],
  currentIndex: { type: Number, default: 0 },
  rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'ride' },
  status: { type: String, enum: ['pending','assigned','completed','cancelled'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
}));

// Helper to parse "lat,lon" strings
function parseLatLon(addr) {
  const m = /^\s*([+-]?[0-9]*\.?[0-9]+)\s*,\s*([+-]?[0-9]*\.?[0-9]+)\s*$/.exec(addr || '');
  return m ? { lat: parseFloat(m[1]), lon: parseFloat(m[2]) } : null;
}


function auth(tokenHeader) {
  const token = tokenHeader || '';
  if (!token) throw new Error('Unauthorized');
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  return decoded;
}

async function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function requestWithRetry(fn, retries=3, backoff=200){
  let lastErr;
  for (let i=0;i<=retries;i++){
    try { return await fn(); } catch(e){ lastErr=e; if (i<retries) await delay(backoff*Math.pow(2,i)); }
  }
  throw lastErr;
}

async function getDistanceTime(pickup, destination) {
  const res = await requestWithRetry(() => axios.get(`${MAPS_BASE_URL}/get-distance-time`, { params: { origin: pickup, destination } }));
  return res.data;
}

async function getSurgeFactor(pickup) {
  try {
    // pickup might be "lat,lon" or address; resolve to lat,lon where possible
    let p = parseLatLon(pickup);
    if (!p) {
      const geo = await axios.get(`${MAPS_BASE_URL}/get-coordinates`, { params: { address: pickup } }).then(r => r.data);
      p = { lat: geo.ltd, lon: geo.lng };
    }
    const r = await axios.get(`${MAPS_BASE_URL}/surge/factor`, { params: { loc: `${p.lat},${p.lon}` } });
    const f = Number(r.data?.factor);
    return Number.isFinite(f) ? f : 1.0;
  } catch (_) { return 1.0; }
}

function getOtp(num) {
  return String(Math.floor(Math.random() * 10 ** num)).padStart(num, '0');
}

async function connect() {
  await mongoose.connect(process.env.DB_CONNECT);
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'rides' }));
app.get('/ready', (req, res) => { const state = mongoose.connection.readyState; const redis = (!REDIS_URL || !redisPub) ? 'disabled' : (redisPub.status || 'unknown'); return state === 1 ? res.json({ status: 'ready', db: 'connected', redis }) : res.status(503).json({ status: 'not_ready', dbState: state, redis }); });
app.get('/metrics', async (_req, res) => { res.set('Content-Type', client.register.contentType); res.end(await client.register.metrics()); });

// Core dispatch computation reused by /dispatch and /auto-assign
async function computeDispatch({ pickup, radiusKm = 5, limit = 10, boundSec, vehicleType }) {
  // Normalize vehicleType
  let vt = vehicleType;
  if (vt === 'moto') vt = 'motorcycle';

  // Resolve pickup to coordinates
  let latLon = parseLatLon(pickup);
  if (!latLon) {
    const geo = await axios.get(`${MAPS_BASE_URL}/get-coordinates`, { params: { address: pickup } }).then(r => r.data);
    latLon = { lat: geo.ltd, lon: geo.lng };
  }

  // Query captains near pickup
  const Captain = mongoose.model('captain');
  const query = {
    status: 'active',
    ...(vt ? { 'vehicle.vehicleType': vt } : {}),
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: [ latLon.lon, latLon.lat ] },
        $maxDistance: Math.max(1, Number(radiusKm) * 1000)
      }
    }
  };
  const captains = await Captain.find(query).limit(Number(limit)).lean();
  if (!captains.length) return { latLon, captains: [], durations: [], bestIndex: -1 };

  // Build sources list (lat,lon;...)
  const sources = captains
    .map(c => (Array.isArray(c.location?.coordinates) ? `${c.location.coordinates[1]},${c.location.coordinates[0]}` : null))
    .filter(Boolean)
    .join(';');
  if (!sources) return { latLon, captains: [], durations: [], bestIndex: -1 };

  // Call multi-eta
  let params = { sources, destination: `${latLon.lat},${latLon.lon}` };
  if (typeof boundSec !== 'undefined') params.boundSec = Number(boundSec);
  let r = await requestWithRetry(() => axios.get(`${MAPS_BASE_URL}/multi-eta`, { params }));
  let { durations, bestIndex } = r.data;

  // Optional ML ETA calibration
  const ML_BASE_URL = process.env.ML_BASE_URL;
  if (ML_BASE_URL && Array.isArray(durations)) {
    try {
      const now = new Date();
      const payloads = durations.map(d => ({ osrmDuration: d, hour: now.getHours(), dow: now.getDay() }));
      const calibrated = await Promise.all(payloads.map(p => requestWithRetry(() => axios.post(`${ML_BASE_URL}/eta/calibrate`, p)).then(x => x.data?.calibratedDuration).catch(()=>null)));
      durations = durations.map((d, i) => (typeof calibrated[i] === 'number' ? calibrated[i] : d));
      // Recompute bestIndex after calibration
      bestIndex = durations.reduce((best, d, i) => (d !== null && (best < 0 || d < durations[best]) ? i : best), -1);
    } catch (_) {}
  }

  // If bounded selection yields none, fall back to unbounded
  if (typeof boundSec !== 'undefined' && (bestIndex === -1 || durations.every(d => d === null))) {
    r = await requestWithRetry(() => axios.get(`${MAPS_BASE_URL}/multi-eta`, { params: { sources, destination: `${latLon.lat},${latLon.lon}` } }));
    durations = r.data.durations;
    bestIndex = r.data.bestIndex;
  }

  return { latLon, captains, durations, bestIndex };
}

// Start offers-based dispatch: persist and enqueue ack/timeout flow
app.post('/offers/start', [
  body('pickup').isString().isLength({ min: 3 }),
  body('destination').isString().isLength({ min: 3 }),
  body('vehicleType').optional().isIn(['auto','car','moto','motorcycle']),
  body('radiusKm').optional().isFloat({ min: 0.1, max: 50 }),
  body('limit').optional().isInt({ min: 1, max: 50 }),
  body('boundSec').optional().isInt({ min: 1 }),
  body('ackSec').optional().isInt({ min: 5, max: 120 })
], async (req, res) => {
  try {
    const token = req.cookies?.token || (req.headers.authorization || '').split(' ')[1];
    const decoded = auth(token);
    const { pickup, destination } = req.body;
    let { vehicleType } = req.body;
    const radiusKm = Number(req.body.radiusKm || 5);
    const limit = Number(req.body.limit || 5);
    const boundSec = typeof req.body.boundSec !== 'undefined' ? Number(req.body.boundSec) : undefined;
    const ackSec = Number(req.body.ackSec || 30);
    if (vehicleType === 'moto') vehicleType = 'motorcycle';

    const { latLon, captains, durations, bestIndex } = await computeDispatch({ pickup, radiusKm, limit, boundSec, vehicleType });
    if (!captains.length) return res.status(404).json({ message: 'No captains nearby' });

    const candidates = captains.map((c, i) => ({
      captainId: c._id,
      socketId: c.socketId,
      etaSec: durations[i] ?? null,
      status: 'pending'
    }));

    const doc = await mongoose.model('dispatch').create({
      user: decoded._id,
      pickup,
      destination,
      vehicleType,
      candidates,
      currentIndex: Math.max(0, bestIndex || 0),
      status: 'pending'
    });

    if (offersQueue) {
      await offersQueue.add('offer', { dispatchId: String(doc._id), ackSec });
    }

    return res.status(201).json({ dispatchId: doc._id, candidates: candidates.length, currentIndex: doc.currentIndex, ackSec });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

// Dispatch endpoint: prefilter captains and select best by ETA via maps multi-eta
app.post('/dispatch', [
  body('pickup').isString().isLength({ min: 3 }),
  body('radiusKm').optional().isFloat({ min: 0.1, max: 50 }),
  body('limit').optional().isInt({ min: 1, max: 50 }),
  body('boundSec').optional().isInt({ min: 1 }),
  body('vehicleType').optional().isIn(['car','auto','motorcycle','moto'])
], async (req, res) => {
  try {
    const { pickup } = req.body;
    const radiusKm = Number(req.body.radiusKm || 5);
    const limit = Number(req.body.limit || 10);
    const boundSec = typeof req.body.boundSec !== 'undefined' ? Number(req.body.boundSec) : undefined;
    let vehicleType = req.body.vehicleType;
    if (vehicleType === 'moto') vehicleType = 'motorcycle';

    // Resolve pickup to coordinates
    let latLon = parseLatLon(pickup);
    if (!latLon) {
      const geo = await axios.get(`${MAPS_BASE_URL}/get-coordinates`, { params: { address: pickup } }).then(r => r.data);
      latLon = { lat: geo.ltd, lon: geo.lng };
    }

    // Query captains near pickup
    const Captain = mongoose.model('captain');
    const query = {
      status: 'active',
      ...(vehicleType ? { 'vehicle.vehicleType': vehicleType } : {}),
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [ latLon.lon, latLon.lat ] },
          $maxDistance: Math.max(1, radiusKm * 1000)
        }
      }
    };
    const captains = await Captain.find(query).limit(limit).lean();
    if (!captains.length) return res.status(404).json({ message: 'No captains nearby' });

    // Build sources list (lat,lon;...)
    const sources = captains
      .map(c => (Array.isArray(c.location?.coordinates) ? `${c.location.coordinates[1]},${c.location.coordinates[0]}` : null))
      .filter(Boolean)
      .join(';');
    if (!sources) return res.status(404).json({ message: 'No captains with valid locations' });

    // Call multi-eta
    let params = { sources, destination: `${latLon.lat},${latLon.lon}` };
    if (typeof boundSec !== 'undefined') params.boundSec = boundSec;
    let r = await axios.get(`${MAPS_BASE_URL}/multi-eta`, { params });
    let { durations, bestIndex } = r.data;

    // If bounded selection yields none, fall back to unbounded
    if (typeof boundSec !== 'undefined' && (bestIndex === -1 || durations.every(d => d === null))) {
      r = await axios.get(`${MAPS_BASE_URL}/multi-eta`, { params: { sources, destination: `${latLon.lat},${latLon.lon}` } });
      durations = r.data.durations;
      bestIndex = r.data.bestIndex;
    }

    if (bestIndex < 0) return res.status(404).json({ message: 'No captain within bound' });
    const bestCaptain = captains[bestIndex];

    return res.json({
      pickup: { lat: latLon.lat, lon: latLon.lon },
      candidates: captains.map((c, i) => ({
        id: c._id,
        name: c.fullname?.firstname,
        vehicle: c.vehicle,
        location: c.location,
        etaSec: durations[i]
      })),
      bestIndex,
      bestCaptainId: bestCaptain?._id,
      bestEtaSec: durations[bestIndex]
    });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

// Captain ack endpoint
app.post('/ack-offer', [
  body('dispatchId').isString().isLength({ min: 8 }),
  body('captainId').isString().isLength({ min: 8 }),
  body('accepted').isBoolean()
], async (req, res) => {
  try {
    const { dispatchId, captainId, accepted } = req.body;
    const d = await mongoose.model('dispatch').findById(dispatchId);
    if (!d || d.status !== 'pending') return res.status(404).json({ message: 'Dispatch not pending' });
    const idx = d.candidates.findIndex(c => String(c.captainId) === String(captainId));
    if (idx < 0) return res.status(404).json({ message: 'Captain not in candidates' });
    const field = `candidates.${idx}.status`;
    await mongoose.model('dispatch').updateOne({ _id: dispatchId }, { $set: { [field]: accepted ? 'ack' : 'rejected' } });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

// Auto-assign: switched to staged offers workflow by default
app.post('/auto-assign', [
  body('pickup').isString().isLength({ min: 3 }),
  body('destination').isString().isLength({ min: 3 }),
  body('vehicleType').optional().isIn(['auto','car','moto','motorcycle']),
  body('radiusKm').optional().isFloat({ min: 0.1, max: 50 }),
  body('limit').optional().isInt({ min: 1, max: 50 }),
  body('boundSec').optional().isInt({ min: 1 }),
  body('ackSec').optional().isInt({ min: 5, max: 120 })
], async (req, res) => {
  try {
    const token = req.cookies?.token || (req.headers.authorization || '').split(' ')[1];
    const decoded = auth(token);
    const { pickup, destination } = req.body;
    let { vehicleType } = req.body;
    const radiusKm = Number(req.body.radiusKm || 5);
    const limit = Number(req.body.limit || 5);
    const boundSec = typeof req.body.boundSec !== 'undefined' ? Number(req.body.boundSec) : undefined;
    const ackSec = Number(req.body.ackSec || 30);
    if (vehicleType === 'moto') vehicleType = 'motorcycle';

    // Compute candidates and ETAs
    const { captains, durations, bestIndex } = await computeDispatch({ pickup, radiusKm, limit, boundSec, vehicleType });
    if (!captains.length) return res.status(404).json({ message: 'No captains nearby' });

    // Persist dispatch and enqueue worker
    const candidates = captains.map((c, i) => ({
      captainId: c._id,
      socketId: c.socketId,
      etaSec: durations[i] ?? null,
      status: 'pending'
    }));
    const doc = await mongoose.model('dispatch').create({
      user: decoded._id,
      pickup,
      destination,
      vehicleType,
      candidates,
      currentIndex: Math.max(0, bestIndex || 0),
      status: 'pending'
    });
    if (offersQueue) {
      await offersQueue.add('offer', { dispatchId: String(doc._id), ackSec });
    }

    return res.status(202).json({ status: 'pending', dispatchId: doc._id, ackSec, candidates: candidates.length });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

app.get('/get-fare', [
  query('pickup').isString().isLength({ min: 3 }),
  query('destination').isString().isLength({ min: 3 })
], async (req, res) => {
  try {
    const { pickup, destination } = req.query;
    const dist = await getDistanceTime(pickup, destination);
    const surge = await getSurgeFactor(pickup);
    const baseFare = { auto: 30, car: 50, moto: 20 };
    const perKmRate = { auto: 10, car: 15, moto: 8 };
    const perMinuteRate = { auto: 2, car: 3, moto: 1.5 };
    const calc = (vt) => baseFare[vt] + (dist.distance.value/1000)*perKmRate[vt] + (dist.duration.value/60)*perMinuteRate[vt];
    const fare = {
      auto: Math.round(calc('auto') * surge),
      car: Math.round(calc('car') * surge),
      moto: Math.round(calc('moto') * surge)
    };
    return res.json({ ...fare, surge });
  } catch (e) { return res.status(500).json({ message: e.message }); }
});

// Idempotency helper
async function getIdemKey(req, userId){
  const idem = req.get('Idempotency-Key');
  if (idem) return `idem:rides:create:${userId}:${idem}`;
  try {
    const h = createHash('sha256').update(JSON.stringify({ pickup: req.body?.pickup, destination: req.body?.destination, vehicleType: req.body?.vehicleType })).digest('hex');
    return `idem:rides:create:${userId}:${h}`;
  } catch { return `idem:rides:create:${userId}:${randomUUID()}`; }
}

app.post('/create', [
  body('pickup').isString().isLength({ min: 3 }),
  body('destination').isString().isLength({ min: 3 }),
  body('vehicleType').isIn(['auto','car','moto'])
], async (req, res) => {
  try {
    const token = req.cookies.token || (req.headers.authorization || '').split(' ')[1];
    const decoded = auth(token);
    const { pickup, destination, vehicleType } = req.body;
    // Idempotency check
    const key = await getIdemKey(req, decoded._id);
    if (redisPub) {
      const cached = await redisPub.get(key).catch(()=>null);
      if (cached) return res.status(201).json(JSON.parse(cached));
    }
    const dist = await getDistanceTime(pickup, destination);
    const surge = await getSurgeFactor(pickup);
    const fareTable = { auto: 30, car: 50, moto: 20 };
    const perKmRate = { auto: 10, car: 15, moto: 8 };
    const perMinuteRate = { auto: 2, car: 3, moto: 1.5 };
    const rawFare = fareTable[vehicleType] + (dist.distance.value/1000)*perKmRate[vehicleType] + (dist.duration.value/60)*perMinuteRate[vehicleType];
    const fare = Math.round(rawFare * surge);
    const ride = await Ride.create({ user: decoded._id, pickup, destination, otp: getOtp(6), fare });
    const out = { ...ride.toObject(), surge };
    if (redisPub) { try { await redisPub.setex(key, 3600, JSON.stringify(out)); } catch(_) {} }
    return res.status(201).json(out);
  } catch (e) { return res.status(500).json({ message: e.message }); }
});

app.post('/confirm', [
  body('rideId').isString().isLength({ min: 8 })
], async (req, res) => {
  try {
    const token = req.cookies.token || (req.headers.authorization || '').split(' ')[1];
    const decoded = auth(token);
    const { rideId } = req.body;
    await Ride.findByIdAndUpdate(rideId, { status: 'accepted', captain: decoded._id });
    const ride = await Ride.findById(rideId).populate('user').populate('captain').select('+otp');
    // sanitize nested sensitive fields
    const out = ride.toObject();
    if (out.user && out.user.password) delete out.user.password;
    if (out.captain && out.captain.password) delete out.captain.password;
    if (redisPub) {
      await redisPub.publish('events', JSON.stringify({ socketId: out.user.socketId, event: 'ride-confirmed', data: out }));
    } else {
      await axios.post(`${SOCKET_BASE_URL}/emit`, { socketId: out.user.socketId, event: 'ride-confirmed', data: out }).catch(()=>{});
    }
    return res.json(out);
  } catch (e) { return res.status(500).json({ message: e.message }); }
});

app.get('/start-ride', [
  query('rideId').isString().isLength({ min: 8 }),
  query('otp').isString().isLength({ min: 6, max: 6 })
], async (req, res) => {
  try {
    const token = req.cookies.token || (req.headers.authorization || '').split(' ')[1];
    auth(token);
    const { rideId, otp } = req.query;
    const ride = await Ride.findById(rideId).populate('user').populate('captain').select('+otp');
    if (!ride) return res.status(404).json({ message: 'Ride not found' });
    if (ride.status !== 'accepted') return res.status(400).json({ message: 'Ride not accepted' });
    if (ride.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });
    await Ride.findByIdAndUpdate(rideId, { status: 'ongoing' });
    const out = ride.toObject();
    if (out.user && out.user.password) delete out.user.password;
    if (out.captain && out.captain.password) delete out.captain.password;
    if (redisPub) {
      await redisPub.publish('events', JSON.stringify({ socketId: out.user.socketId, event: 'ride-started', data: out }));
    } else {
      await axios.post(`${SOCKET_BASE_URL}/emit`, { socketId: out.user.socketId, event: 'ride-started', data: out }).catch(()=>{});
    }
    return res.json(out);
  } catch (e) { return res.status(500).json({ message: e.message }); }
});

app.post('/end-ride', [
  body('rideId').isString().isLength({ min: 8 })
], async (req, res) => {
  try {
    const token = req.cookies.token || (req.headers.authorization || '').split(' ')[1];
    const decoded = auth(token);
    const { rideId } = req.body;
    const ride = await Ride.findOne({ _id: rideId, captain: decoded._id }).populate('user').populate('captain').select('+otp');
    if (!ride) return res.status(404).json({ message: 'Ride not found' });
    if (ride.status !== 'ongoing') return res.status(400).json({ message: 'Ride not ongoing' });
    await Ride.findByIdAndUpdate(rideId, { status: 'completed' });
    const out = ride.toObject();
    if (out.user && out.user.password) delete out.user.password;
    if (out.captain && out.captain.password) delete out.captain.password;
    if (redisPub) {
      await redisPub.publish('events', JSON.stringify({ socketId: out.user.socketId, event: 'ride-ended', data: out }));
    } else {
      await axios.post(`${SOCKET_BASE_URL}/emit`, { socketId: out.user.socketId, event: 'ride-ended', data: out }).catch(()=>{});
    }
    return res.json(out);
  } catch (e) { return res.status(500).json({ message: e.message }); }
});

const port = process.env.PORT || 4005;
let server;
connect().then(() => { server = app.listen(port, () => console.log(`rides-service on ${port}`)); });

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`${signal} received, shutting down rides-service...`);
  if (server) await new Promise(r => server.close(r));
  try { if (offersQueue) await offersQueue.close(); } catch(_) {}
  try { if (redisPub) await redisPub.quit(); } catch(_) {}
  try { if (mongoose.connection.readyState !== 0) await mongoose.connection.close(false); } catch(_) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

