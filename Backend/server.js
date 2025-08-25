require('./tracing');
const http = require('http');
const mongoose = require('mongoose');
const app = require('./app');
const { initializeSocket } = require('./socket');
const port = process.env.PORT || 3000;

const server = http.createServer(app);

initializeSocket(server);

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down gracefully...`);
    // Stop accepting new connections
    server.close(async () => {
        console.log('HTTP server closed');
        try {
            if (mongoose.connection.readyState !== 0) {
                await mongoose.connection.close(false);
                console.log('MongoDB connection closed');
            }
        } catch (err) {
            console.error('Error closing MongoDB connection', err);
        } finally {
            process.exit(0);
        }
    });
    // Force exit after timeout
    setTimeout(() => {
        console.warn('Forcing shutdown after timeout');
        process.exit(1);
    }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
