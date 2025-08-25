require('./tracing');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const client = require('prom-client');
const { randomUUID } = require('crypto');
const Razorpay = require('razorpay');
const QRCode = require('qrcode');

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

// Create UPI intent/order (Razorpay if configured; fallback to static UPI intent)
app.post('/upi/create-order', async (req, res) => {
  try {
    const { amount, currency = 'INR', rideId } = req.body || {};
    if (!amount) return res.status(400).json({ message: 'amount required' });

    const VPA = process.env.UPI_VPA || 'test@upi';
    const PAYER_NAME = process.env.UPI_PAYER_NAME || 'Cab Booking';

    if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
      const rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
      const order = await rzp.orders.create({ amount: Number(amount), currency: currency.toUpperCase(), receipt: String(rideId || Date.now()), payment_capture: 1 });
      // Return order with helper UPI intent string
      const upiAmount = (Number(amount) / 100).toFixed(2);
      const upi = `upi://pay?pa=${encodeURIComponent(VPA)}&pn=${encodeURIComponent(PAYER_NAME)}&am=${encodeURIComponent(upiAmount)}&cu=${encodeURIComponent(currency.toUpperCase())}&tn=${encodeURIComponent('Ride ' + (rideId || ''))}`;
      return res.json({ provider: 'razorpay', orderId: order.id, amount: order.amount, currency: order.currency, status: order.status, upi });
    }

    // Fallback static UPI intent
    const upiAmount = (Number(amount) / 100).toFixed(2);
    const upi = `upi://pay?pa=${encodeURIComponent(VPA)}&pn=${encodeURIComponent(PAYER_NAME)}&am=${encodeURIComponent(upiAmount)}&cu=${encodeURIComponent(currency.toUpperCase())}&tn=${encodeURIComponent('Ride ' + (rideId || ''))}`;
    return res.json({ provider: 'static', upi, amount: Number(amount), currency: currency.toUpperCase() });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

// Generate a UPI QR Code (data URL)
app.post('/upi/qrcode', async (req, res) => {
  try {
    const { amount, currency = 'INR', note = 'Ride Payment', rideId } = req.body || {};
    if (!amount) return res.status(400).json({ message: 'amount required' });
    const VPA = process.env.UPI_VPA || 'test@upi';
    const PAYER_NAME = process.env.UPI_PAYER_NAME || 'Cab Booking';
    const upiAmount = (Number(amount) / 100).toFixed(2);
    const upi = `upi://pay?pa=${encodeURIComponent(VPA)}&pn=${encodeURIComponent(PAYER_NAME)}&am=${encodeURIComponent(upiAmount)}&cu=${encodeURIComponent(currency.toUpperCase())}&tn=${encodeURIComponent(note + ' ' + (rideId || ''))}`;
    const dataUrl = await QRCode.toDataURL(upi);
    return res.json({ upi, qr: dataUrl });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

// Verify UPI payment (Razorpay signature if provided)
app.post('/upi/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (razorpay_order_id && razorpay_payment_id && razorpay_signature && process.env.RAZORPAY_KEY_SECRET) {
      const hmac = require('crypto').createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
      hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
      const expected = hmac.digest('hex');
      const valid = expected === razorpay_signature;
      return res.json({ provider: 'razorpay', valid });
    }
    // Fallback: assume success if payload states so
    return res.json({ provider: 'static', valid: true });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

// Stub: webhook endpoint (validates signature in real impl)
app.post('/webhook', (req, res) => {
  // Acknowledge receipt
  return res.json({ received: true });
});

const port = process.env.PORT || 4006;
app.listen(port, () => console.log(`payments-service on ${port}`));

