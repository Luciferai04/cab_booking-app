const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const app = express();
const cookieParser = require('cookie-parser');
const connectToDb = require('./db/db');
const userRoutes = require('./routes/user.routes');
const captainRoutes = require('./routes/captain.routes');
const mapsRoutes = require('./routes/maps.routes');
const rideRoutes = require('./routes/ride.routes');

connectToDb();

// trust proxy for secure cookies behind reverse proxy
app.set('trust proxy', 1);

// Correlation IDs for tracing across services
app.use((req, res, next) => {
    const cid = req.headers['x-correlation-id'] || randomUUID();
    req.correlationId = cid;
    res.setHeader('x-correlation-id', cid);
    next();
});

// Logging (JSON with correlation id); disabled in test
if (process.env.NODE_ENV !== 'test') {
    const serviceName = process.env.SERVICE_NAME || 'backend';
    app.use(morgan((tokens, req, res) => JSON.stringify({
        service: serviceName,
        time: tokens.date(req, res, 'iso'),
        correlationId: req.correlationId,
        method: tokens.method(req, res),
        url: tokens.url(req, res),
        status: Number(tokens.status(req, res)),
        responseTimeMs: Number(tokens['response-time'](req, res)),
        contentLength: tokens.res(req, res, 'content-length'),
        userAgent: req.headers['user-agent'],
        remoteAddr: tokens['remote-addr'](req, res)
    })));
}

// Security headers
app.use(helmet());

// Basic rate limiting (adjust per endpoint below as needed)
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// Configurable CORS for production safety
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:8080')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true); // allow non-browser clients and same-origin
        if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('CORS not allowed'), false);
    },
    credentials: true
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());



app.get('/', (req, res) => {
    res.send('Hello World');
});

// Liveness probe
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

// Readiness probe - checks DB connectivity
app.get('/ready', (req, res) => {
    const state = mongoose.connection.readyState; // 1=connected
    if (state === 1) {
        return res.status(200).json({ status: 'ready', db: 'connected' });
    }
    res.status(503).json({ status: 'not_ready', dbState: state });
});

app.use('/users', userRoutes);
app.use('/captains', captainRoutes);
app.use('/maps', mapsRoutes);
app.use('/rides', rideRoutes);




module.exports = app;

