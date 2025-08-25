require('./tracing');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const Redis = require('ioredis');

const app = express();
app.use(helmet());
function getAllowedOrigins() {
  return (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:8080')
    .split(',').map(s => s.trim()).filter(Boolean);
}
const allowedOrigins = getAllowedOrigins();
app.use(cors({ origin: (origin, cb) => { if (!origin) return cb(null, true); if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true); cb(new Error('CORS not allowed')); }, credentials: true }));
app.use(express.json());

// Simple in-memory TTL cache for /table results
const CACHE_TTL_MS = (Number(process.env.ROUTING_CACHE_TTL_SEC) || 60) * 1000;
const cache = new Map(); // key -> { expiry, value }
const REDIS_URL = process.env.REDIS_URL || '';
let redis = null;
if (REDIS_URL) { try { redis = new Redis(REDIS_URL); } catch (_) { redis = null; } }
function makeKey(src, dst) {
  // src, dst are arrays of [lat, lon]
  const norm = (arr) => arr.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(';');
  return `${norm(src)}|${norm(dst)}`;
}
async function getCached(key) {
  if (redis) {
    try { const v = await redis.get(`rt:${key}`); if (v) return JSON.parse(v); } catch (_) {}
  }
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiry) { cache.delete(key); return null; }
  return e.value;
}
async function setCached(key, value) {
  cache.set(key, { expiry: Date.now() + CACHE_TTL_MS, value });
  if (redis) {
    try { await redis.setex(`rt:${key}`, Math.ceil(CACHE_TTL_MS/1000), JSON.stringify(value)); } catch (_) {}
  }
}

// Haversine distance in meters between two [lat, lon]
function haversine(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371000; // meters
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

// Simple ETA estimate given meters and assumed speed (m/s)
function estimateDurationMeters(distanceMeters, speedMps = 8.33 /* ~30 km/h */) {
  return distanceMeters / speedMps; // seconds
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'routing' }));
app.get('/ready', (req, res) => { const redisState = redis ? (redis.status || 'unknown') : 'disabled'; return res.json({ status: 'ready', redis: redisState }); });

// OSRM-like /table endpoint
// Query params: sources=lat1,lon1;lat2,lon2&destinations=lat3,lon3;lat4,lon4
// Returns: { durations: [[s11, s12, ...], [s21, s22, ...]], distances: [[m11, ...], ...] }
app.get('/table', async (req, res) => {
  const { sources, destinations } = req.query;
  if (!sources || !destinations) return res.status(400).json({ message: 'sources and destinations required' });
  const osrmBase = process.env.OSRM_BASE_URL;
  try {
    const parse = s => s.split(';').map(pair => pair.split(',').map(Number));
    const src = parse(sources); // [[lat, lon], ...]
    const dst = parse(destinations);

    // Cache lookup
    const key = makeKey(src, dst);
    const cached = await getCached(key);
    if (cached) return res.json(cached);

    // Try OSRM if configured
    if (osrmBase) {
      // OSRM expects all coordinates in one list as lon,lat; sources/destinations are indices into that list
      const toLonLat = ([lat, lon]) => `${lon},${lat}`;
      const coords = src.map(toLonLat).concat(dst.map(toLonLat)).join(';');
      const sourcesIdx = src.map((_, i) => i).join(';');
      const destIdx = dst.map((_, i) => i + src.length).join(';');
      const url = `${osrmBase}/table/v1/driving/${coords}?sources=${sourcesIdx}&destinations=${destIdx}&annotations=duration,distance`;
      try {
        const r = await fetch(url);
        if (r.ok) {
          const data = await r.json();
          let durations = data.durations;
          let distances = data.distances;
          // Fallback fill if OSRM returns nulls or missing distances
          if (!distances) {
            distances = durations.map(row => row.map(sec => (sec == null ? null : sec * 8.33)));
          }
          // Replace nulls with haversine-based estimates
          for (let i = 0; i < src.length; i++) {
            for (let j = 0; j < dst.length; j++) {
              const samePoint = src[i][0] === dst[j][0] && src[i][1] === dst[j][1];
              if (durations[i][j] == null || (!samePoint && durations[i][j] === 0)) {
                const m = haversine(src[i], dst[j]);
                durations[i][j] = estimateDurationMeters(m);
                distances[i][j] = m;
              } else if (distances[i][j] == null || (!samePoint && distances[i][j] === 0)) {
                distances[i][j] = durations[i][j] * 8.33;
              }
            }
          }
          const result = { durations, distances };
          await setCached(key, result);
          return res.json(result);
        }
      } catch (_) {
        // fall through to haversine
      }
    }

    // Fallback: haversine
    const distances = src.map(s => dst.map(d => haversine(s, d)));
    const durations = distances.map(row => row.map(m => estimateDurationMeters(m)));
    const result = { durations, distances };
    await setCached(key, result);
    return res.json(result);
  } catch (e) {
    return res.status(400).json({ message: 'invalid coordinates' });
  }
});

const port = process.env.PORT || 4010;
const server = app.listen(port, () => console.log(`routing-service listening on ${port}`));

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`${signal} received, shutting down routing-service...`);
  await new Promise(r => server.close(r));
  try { if (redis) await redis.quit(); } catch(_) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

