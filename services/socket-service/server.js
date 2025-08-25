require('./tracing');
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const pinoHttp = require('pino-http');
const client = require('prom-client');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);

function getAllowedOrigins() {
  return (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:8080')
    .split(',').map(s => s.trim()).filter(Boolean);
}
const allowedOrigins = getAllowedOrigins();
const io = new Server(server, {
  cors: { origin: (origin, cb) => { if (!origin) return cb(null, true); if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true); cb(new Error('CORS not allowed')); }, credentials: true },
});

app.use(helmet());
app.use(cors({ origin: (origin, cb) => { if (!origin) return cb(null, true); if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true); cb(new Error('CORS not allowed')); } }));
app.use(express.json());
app.use((req, res, next) => { const id = req.headers['x-correlation-id'] || req.headers['x-request-id'] || randomUUID(); req.id = id; res.setHeader('x-correlation-id', id); next(); });
app.use(pinoHttp({ customProps: req => ({ reqId: req.id, service: 'socket' }) }));
client.collectDefaultMetrics();
app.get('/metrics', async (_req, res) => { res.set('Content-Type', client.register.contentType); res.end(await client.register.metrics()); });

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'socket' }));
app.get('/ready', (req, res) => res.json({ status: 'ready' }));

// Internal API to emit events by socketId
app.post('/emit', (req, res) => {
  const { socketId, event, data } = req.body || {};
  if (!socketId || !event) return res.status(400).json({ message: 'socketId and event required' });
  io.to(socketId).emit(event, data);
  return res.json({ ok: true });
});

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);
  socket.on('disconnect', () => console.log('socket disconnected', socket.id));
});

// Optional Redis subscription for event fanout
const REDIS_URL = process.env.REDIS_URL || '';
let sub = null;
if (REDIS_URL) {
  sub = new Redis(REDIS_URL);
  sub.subscribe('events').then(()=>console.log('socket-service subscribed to events'));
  sub.on('message', (_channel, message) => {
    try {
      const { socketId, event, data } = JSON.parse(message);
      if (socketId && event) io.to(socketId).emit(event, data);
    } catch (e) { console.error('Redis message parse error', e.message); }
  });
}

const port = process.env.PORT || 4002;
server.listen(port, () => console.log(`socket-service listening on ${port}`));

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`${signal} received, shutting down socket-service...`);
  try { io.close(); } catch(_) {}
  await new Promise(r => server.close(r));
  try { if (sub) await sub.quit(); } catch(_) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

