const userModel = require('./models/user.model');
const captainModel = require('./models/captain.model');
const axios = require('axios');

const SOCKET_BASE_URL = process.env.SOCKET_BASE_URL || '';
let io; // retained for backward compatibility when running monolith

function initializeSocket(server) {
    if (!SOCKET_BASE_URL) {
        // Legacy in-process Socket.IO (monolith mode)
        const socketIo = require('socket.io');
        const allowedOrigins = (process.env.CORS_ORIGIN || '*')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

        io = socketIo(server, {
            cors: {
                origin: function (origin, callback) {
                    if (!origin) return callback(null, true);
                    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
                        return callback(null, true);
                    }
                    return callback(new Error('CORS not allowed'), false);
                },
                methods: [ 'GET', 'POST' ],
                credentials: true
            }
        });

        io.on('connection', (socket) => {
            console.log(`Client connected: ${socket.id}`);

            socket.on('join', async (data) => {
                const { userId, userType } = data;

                if (userType === 'user') {
                    await userModel.findByIdAndUpdate(userId, { socketId: socket.id });
                } else if (userType === 'captain') {
                    await captainModel.findByIdAndUpdate(userId, { socketId: socket.id });
                }
            });

            socket.on('update-location-captain', async (data) => {
                const { userId, location } = data;

                if (!location || typeof location.ltd !== 'number' || typeof location.lng !== 'number') {
                    return socket.emit('error', { message: 'Invalid location data' });
                }

                await captainModel.findByIdAndUpdate(userId, {
                    location: {
                        type: 'Point',
                        coordinates: [ location.lng, location.ltd ]
                    }
                }, { new: true });
            });

            socket.on('disconnect', () => {
                console.log(`Client disconnected: ${socket.id}`);
            });
        });
    }
}

const sendMessageToSocketId = async (socketId, messageObject) => {
    console.log(messageObject);

    if (SOCKET_BASE_URL) {
        try {
            await axios.post(`${SOCKET_BASE_URL}/emit`, {
                socketId,
                event: messageObject.event,
                data: messageObject.data
            });
        } catch (e) {
            console.error('socket-service emit failed', e.message);
        }
        return;
    }

    if (io) {
        io.to(socketId).emit(messageObject.event, messageObject.data);
    } else {
        console.log('Socket.io not initialized.');
    }
}

module.exports = { initializeSocket, sendMessageToSocketId };
