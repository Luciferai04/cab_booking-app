require('./tracing');
const { Worker, Queue } = require('bullmq');
const mongoose = require('mongoose');
const axios = require('axios');

const OFFERS_QUEUE = 'ride_offers';

function parseRedis(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port)||6379, password: u.password || undefined };
  } catch (_) { return {}; }
}

async function main() {
  const redisUrl = process.env.REDIS_URL;
  const mongo = process.env.DB_CONNECT;
  const socketBase = process.env.SOCKET_BASE_URL || 'http://socket-service:4002';
  const ridesBase = process.env.RIDES_BASE_URL || 'http://rides-service:4005';

  if (!redisUrl || !mongo) {
    console.error('dispatcher-worker missing REDIS_URL or DB_CONNECT');
    process.exit(1);
  }

  await mongoose.connect(mongo);
  const Dispatch = mongoose.model('dispatch', new mongoose.Schema({}, { strict: false }));
  const Ride = mongoose.model('ride', new mongoose.Schema({}, { strict: false }));
  const Captain = mongoose.model('captain', new mongoose.Schema({}, { strict: false }));
  const User = mongoose.model('user', new mongoose.Schema({}, { strict: false }));

  const worker = new Worker(OFFERS_QUEUE, async (job) => {
    const { dispatchId, ackSec: jobAckSec } = job.data || {};
    if (!dispatchId) return;
    const d = await Dispatch.findById(dispatchId);
    if (!d || d.status !== 'pending') return;

    let i = d.currentIndex || 0;
    while (i < d.candidates.length) {
      const c = d.candidates[i];
      // Send offer
      try {
        await axios.post(`${socketBase}/emit`, {
          socketId: c.socketId,
          event: 'ride-offer',
          data: { dispatchId: String(d._id), captainId: String(c.captainId), pickup: d.pickup, destination: d.destination, etaSec: c.etaSec }
        });
      } catch (_) {}

      // Wait for ack timeout window
      const ackSec = Number(jobAckSec || process.env.OFFER_ACK_SEC || 30);
      const started = Date.now();
      let acked = false;
      while (Date.now() - started < ackSec * 1000) {
        const cur = await Dispatch.findById(dispatchId);
        if (!cur || cur.status !== 'pending') return; // cancelled or assigned elsewhere
        const cand = cur.candidates[i];
        if (cand && cand.status === 'ack') { acked = true; break; }
        await new Promise(r => setTimeout(r, 1000));
      }

      if (acked) {
        // Create/mark ride accepted and notify
        const cur = await Dispatch.findById(dispatchId);
        const cand = cur.candidates[i];
        // Compute fare via rides-service helper
        let fare = 0;
        try {
          const fr = await axios.get(`${ridesBase}/get-fare`, { params: { pickup: cur.pickup, destination: cur.destination } });
          const vt = cur.vehicleType === 'motorcycle' ? 'moto' : (cur.vehicleType || 'car');
          fare = fr.data?.[vt] || 0;
        } catch (_) {}
        // Lock captain inactive
        try { await Captain.updateOne({ _id: cand.captainId }, { $set: { status: 'inactive' } }); } catch (_) {}
        // Generate OTP
        const otp = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
        // Create ride
        const ride = await Ride.create({ user: cur.user, captain: cand.captainId, pickup: cur.pickup, destination: cur.destination, fare, status: 'accepted', otp });
        await Dispatch.findByIdAndUpdate(dispatchId, { status: 'assigned', currentIndex: i, rideId: ride._id, $set: { [`candidates.${i}.status`]: 'assigned' } });
        // Notify captain
        try {
          await axios.post(`${socketBase}/emit`, { socketId: cand.socketId, event: 'ride-offer-accepted', data: { dispatchId, rideId: String(ride._id) } });
        } catch (_) {}
        // Notify user
        try {
          const u = await User.findById(cur.user);
          if (u?.socketId) {
            await axios.post(`${socketBase}/emit`, { socketId: u.socketId, event: 'ride-assigned', data: { rideId: String(ride._id) } });
          }
        } catch (_) {}
        return;
      } else {
        // Mark timeout and try next
        await Dispatch.findByIdAndUpdate(dispatchId, { $set: { [`candidates.${i}.status`]: 'timeout' }, currentIndex: i + 1 });
        i++;
        continue;
      }
    }

    // No candidate accepted
    await Dispatch.findByIdAndUpdate(dispatchId, { status: 'cancelled' });
  }, { connection: parseRedis(redisUrl) });

  worker.on('completed', job => console.log('offer flow completed', job.id));
  worker.on('failed', (job, err) => console.error('offer flow failed', job?.id, err?.message));
}

main().catch(err => { console.error(err); process.exit(1); });

