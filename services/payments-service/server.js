require('./tracing');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const client = require('prom-client');
const { randomUUID } = require('crypto');

const app = express();
app.use(helmet());
function getAllowedOrigins() {
  return (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:8080')
    .split(',').map(s => s.trim()).filter(Boolean);
}
const allowedOrigins = getAllowedOrigins();
app.use(cors({ origin: (origin, cb) => { if (!origin) return cb(null, true); if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true); cb(new Error('CORS not allowed')); }, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => { const id = req.headers['x-correlation-id'] || req.headers['x-request-id'] || randomUUID(); req.id = id; res.setHeader('x-correlation-id', id); next(); });
app.use(pinoHttp({ customProps: req => ({ reqId: req.id, service: 'payments' }) }));
client.collectDefaultMetrics();
app.get('/metrics', async (_req, res) => { res.set('Content-Type', client.register.contentType); res.end(await client.register.metrics()); });

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'payments' }));
app.get('/ready', (req, res) => res.json({ status: 'ready' }));

// Stub: create payment intent
app.post('/create-intent', (req, res) => {
  const { amount, currency } = req.body || {};
  if (!amount || !currency) return res.status(400).json({ message: 'amount and currency required' });
  return res.json({ id: 'pi_test_' + Date.now(), amount, currency, status: 'requires_payment_method' });
});

// Stub: webhook endpoint (validates signature in real impl)
app.post('/webhook', (req, res) => {
  // Acknowledge receipt
  return res.json({ received: true });
});

const port = process.env.PORT || 4006;
app.listen(port, () => console.log(`payments-service on ${port}`));

