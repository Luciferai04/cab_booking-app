require('./tracing');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');

async function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function requestWithRetry(fn, retries=3, backoff=200){
  let lastErr;
  for (let i=0;i<=retries;i++){
    try { return await fn(); } catch(e){ lastErr=e; if (i<retries) await delay(backoff*Math.pow(2,i)); }
  }
  throw lastErr;
}
const Redis = require('ioredis');

const app = express();
const ML_BASE_URL = process.env.ML_BASE_URL || '';
const REDIS_URL = process.env.REDIS_URL || '';
let redis = null;
if (REDIS_URL) { try { redis = new Redis(REDIS_URL); } catch(_) { redis = null; } }

// Simple grid zoning for surge (approx)
function zoneIdFromLatLon(lat, lon) {
  const scale = 100; // ~0.01 deg cells
  const zi = Math.floor(lat * scale);
  const zj = Math.floor(lon * scale);
  return `zone_${zi}_${zj}`;
}

async function getSurgeFactorForZone(zoneId) {
  const now = new Date();
  const how = now.getDay() * 24 + now.getHours();
  const cacheKey = `surge:factor:${zoneId}:${how}`;
  if (redis) {
    try { const v = await redis.get(cacheKey); if (v) return parseFloat(v); } catch(_) {}
  }
  let demand = 10.0;
  if (ML_BASE_URL) {
    try {
      const r = await axios.post(`${ML_BASE_URL}/demand/predict`, { zoneId, horizon: 1 });
      if (Array.isArray(r.data?.demand) && typeof r.data.demand[0] === 'number') {
        demand = r.data.demand[0];
      }
    } catch(_) {}
  }
  const baseline = Number(process.env.SURGE_BASELINE || 10);
  const maxMult = Number(process.env.SURGE_MAX_MULT || 1.5);
  const minMult = Number(process.env.SURGE_MIN_MULT || 1.0);
  let factor = minMult;
  if (baseline > 0) {
    const rel = (demand - baseline) / baseline;
    factor = Math.min(maxMult, Math.max(minMult, 1.0 + Math.max(0, rel)));
  }
  if (redis) {
    try { await redis.setex(cacheKey, 300, String(factor)); } catch(_) {}
  }
  return factor;
}
app.use(helmet());
function getAllowedOrigins() {
  return (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:8080')
    .split(',').map(s => s.trim()).filter(Boolean);
}
const allowedOrigins = getAllowedOrigins();
app.use(cors({ origin: (origin, cb) => { if (!origin) return cb(null, true); if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true); cb(new Error('CORS not allowed')); }, credentials: true }));
app.use(express.json());

// Utility to format lat,lon pairs for routing-service
function formatCoordsList(coords) {
  return coords.map(c => `${c.lat},${c.lon}`).join(';');
}

// Parse "lat,lon" string -> {lat, lon} or null
function parseLatLon(addr) {
  const m = /^\s*([+-]?[0-9]*\.?[0-9]+)\s*,\s*([+-]?[0-9]*\.?[0-9]+)\s*$/.exec(addr || '');
  return m ? { lat: parseFloat(m[1]), lon: parseFloat(m[2]) } : null;
}

async function resolveAddressOrCoords(addr) {
  const parsed = parseLatLon(addr);
  if (parsed) return parsed;
  if (useMock()) return { lat: 12.9716, lon: 77.5946 };
  const apiKey = process.env.GOOGLE_MAPS_API;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${apiKey}`;
  const response = await axios.get(url);
  if (response.data.status === 'OK') {
    const loc = response.data.results[0].geometry.location;
    return { lat: loc.lat, lon: loc.lng };
  }
  throw new Error('Unable to geocode address');
}

function useMock() {
  const apiKey = process.env.GOOGLE_MAPS_API;
  return !apiKey || apiKey === 'dummy-key' || process.env.USE_MOCK_MAPS === 'true' || process.env.NODE_ENV === 'test';
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'maps' }));
app.get('/ready', (req, res) => { const redisState = redis ? (redis.status || 'unknown') : 'disabled'; return res.json({ status: 'ready', redis: redisState }); });

// Multi-source ETA: sources (captain coords) -> one destination (pickup)
// Query: sources=lat,lon;lat,lon OR sources as addresses separated by ; and destination as address or lat,lon
// Optional: boundSec to filter
app.get('/multi-eta', async (req, res) => {
  try {
    const { sources, destination, boundSec } = req.query;
    if (!sources || !destination) return res.status(400).json({ message: 'sources and destination required' });

    const routingBase = process.env.ROUTING_BASE_URL;
    // helper to resolve either lat,lon or address into {lat, lon}
    const resolveOne = async (addr) => {
      return await resolveAddressOrCoords(addr);
    };

    const sourcesList = (sources || '').split(';').filter(Boolean);
    const sourcesCoords = await Promise.all(sourcesList.map(resolveOne));
    const destCoord = await resolveOne(destination);

    // cache key for multi-eta
    let cacheKey = null;
    if (redis) {
      try { cacheKey = `maps:multi-eta:${sourcesList.join('|')}::${destCoord.lat},${destCoord.lon}::${boundSec||'none'}`; const cached = await redis.get(cacheKey); if (cached) return res.json(JSON.parse(cached)); } catch(_) {}
    }

    if (useMock() && !routingBase) {
      // simple mock: compute haversine durations from arbitrary base
      return res.json({ durations: sourcesCoords.map(() => 300), bestIndex: 0 });
    }

    if (routingBase) {
      const qs = `sources=${formatCoordsList(sourcesCoords)}&destinations=${destCoord.lat},${destCoord.lon}`;
      const r = await requestWithRetry(() => axios.get(`${routingBase}/table?${qs}`));
      const durations = r.data.durations.map(row => row[0]); // each source -> one destination
      const filtered = typeof boundSec !== 'undefined' ? durations.map(d => (d <= Number(boundSec) ? d : null)) : durations;
      const bestIndex = filtered.reduce((best, d, i) => (d !== null && (best < 0 || d < filtered[best]) ? i : best), -1);
      const payload = { durations: filtered, bestIndex };
      if (redis && cacheKey) { try { await redis.setex(cacheKey, 60, JSON.stringify(payload)); } catch(_) {} }
      return res.json(payload);
    }

    // fallback to Google Distance Matrix (batched)
    const apiKey = process.env.GOOGLE_MAPS_API;
    const origins = await Promise.all(sourcesCoords.map(async c => `${c.lat},${c.lon}`));
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origins.join('|'))}&destinations=${encodeURIComponent(destCoord.lat + ',' + destCoord.lon)}&key=${apiKey}`;
    const response = await requestWithRetry(() => axios.get(url));
    if (response.data.status === 'OK') {
      const durations = response.data.rows.map(row => row.elements[0].duration.value);
      const filtered = typeof boundSec !== 'undefined' ? durations.map(d => (d <= Number(boundSec) ? d : null)) : durations;
      const bestIndex = filtered.reduce((best, d, i) => (d !== null && (best < 0 || d < filtered[best]) ? i : best), -1);
      const payload = { durations: filtered, bestIndex };
      if (redis && cacheKey) { try { await redis.setex(cacheKey, 60, JSON.stringify(payload)); } catch(_) {} }
      return res.json(payload);
    }
    return res.status(500).json({ message: 'Unable to fetch durations' });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

app.get('/get-coordinates', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ message: 'address required' });
  if (useMock()) return res.json({ ltd: 12.9716, lng: 77.5946 });
  const apiKey = process.env.GOOGLE_MAPS_API;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  try {
    const response = await axios.get(url);
    if (response.data.status === 'OK') {
      const loc = response.data.results[0].geometry.location;
      return res.json({ ltd: loc.lat, lng: loc.lng });
    }
    return res.status(500).json({ message: 'Unable to fetch coordinates' });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

app.get('/surge/factor', async (req, res) => {
  try {
    const loc = req.query.loc;
    const zone = req.query.zoneId;
    let zoneId = zone;
    if (!zoneId) {
      if (!loc) return res.status(400).json({ message: 'loc or zoneId required' });
      const p = parseLatLon(loc);
      if (!p) return res.status(400).json({ message: 'invalid loc' });
      zoneId = zoneIdFromLatLon(p.lat, p.lon);
    }
    const factor = await getSurgeFactorForZone(zoneId);
    return res.json({ zoneId, factor });
  } catch (e) { return res.status(500).json({ message: e.message }); }
});

app.get('/get-distance-time', async (req, res) => {
  const { origin, destination } = req.query;
  if (!origin || !destination) return res.status(400).json({ message: 'origin and destination required' });

  // Try routing-service first if available; fallback to Google; finally mock
  const routingBase = process.env.ROUTING_BASE_URL;
  try {
    if (routingBase) {
      const [o, d] = await Promise.all([resolveAddressOrCoords(origin), resolveAddressOrCoords(destination)]);
      const cacheKey = redis ? `maps:dist:${o.lat},${o.lon}::${d.lat},${d.lon}` : null;
      if (cacheKey) {
        try { const cached = await redis.get(cacheKey); if (cached) return res.json(JSON.parse(cached)); } catch(_) {}
      }
      const qs = `sources=${o.lat},${o.lon}&destinations=${d.lat},${d.lon}`;
      const r = await requestWithRetry(() => axios.get(`${routingBase}/table?${qs}`));
      const duration = r.data.durations[0][0];
      const distance = r.data.distances[0][0];
      const payload = { distance: { value: Math.round(distance) }, duration: { value: Math.round(duration) } };
      if (cacheKey) { try { await redis.setex(cacheKey, 60, JSON.stringify(payload)); } catch(_) {} }
      return res.json(payload);
    }
  } catch (_) {
    // fallback below
  }

  if (useMock()) return res.json({ distance: { value: 5000 }, duration: { value: 900 } });

  const apiKey = process.env.GOOGLE_MAPS_API;
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&key=${apiKey}`;
  try {
    const response = await axios.get(url);
    if (response.data.status === 'OK') {
      const el = response.data.rows[0].elements[0];
      if (el.status === 'ZERO_RESULTS') return res.status(404).json({ message: 'No routes found' });
      return res.json(el);
    }
    return res.status(500).json({ message: 'Unable to fetch distance and time' });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

app.get('/get-suggestions', async (req, res) => {
  const { input } = req.query;
  if (!input) return res.status(400).json({ message: 'input required' });
  if (useMock()) return res.json(['Mock Place A', 'Mock Place B']);
  const apiKey = process.env.GOOGLE_MAPS_API;
  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${apiKey}`;
  try {
    const response = await axios.get(url);
    if (response.data.status === 'OK') {
      return res.json(response.data.predictions.map(p => p.description).filter(Boolean));
    }
    return res.status(500).json({ message: 'Unable to fetch suggestions' });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

// Background prefetch for configured zones
if (redis && ML_BASE_URL) {
  const preload = (process.env.SURGE_PRELOAD_ZONES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (preload.length) {
    setInterval(async () => {
      for (const z of preload) {
        try { await getSurgeFactorForZone(z); } catch(_) {}
      }
    }, Number(process.env.SURGE_REFRESH_MS || 60000));
  }
}

const port = process.env.PORT || 4001;
const server = app.listen(port, () => console.log(`maps-service listening on ${port}`));

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`${signal} received, shutting down maps-service...`);
  await new Promise(r => server.close(r));
  try { if (redis) await redis.quit(); } catch(_) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

