const express = require('express');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const winston = require('winston');
const Bull = require('bull');
const Redis = require('ioredis');
const mongoose = require('mongoose');
const prometheus = require('prom-client');

// Initialize logger
const logger = winston.createLogger({
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'notifications.log' })
  ]
});

// Initialize app
const app = express();
app.use(express.json());

// Initialize Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Initialize Firebase Admin for FCM
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (serviceAccount.project_id) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

// Initialize Redis
const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379
});

// Initialize notification queue
const notificationQueue = new Bull('notifications', {
  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: process.env.REDIS_PORT || 6379
  }
});

// Prometheus metrics
const register = new prometheus.Registry();
prometheus.collectDefaultMetrics({ register });

const notificationsSent = new prometheus.Counter({
  name: 'notifications_sent_total',
  help: 'Total number of notifications sent',
  labelNames: ['type', 'status']
});
register.registerMetric(notificationsSent);

// Notification schemas
const notificationSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  type: { 
    type: String, 
    enum: ['sms', 'email', 'push', 'in_app'],
    required: true 
  },
  channel: String,
  template: String,
  data: mongoose.Schema.Types.Mixed,
  status: {
    type: String,
    enum: ['pending', 'sent', 'failed', 'delivered', 'read'],
    default: 'pending'
  },
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal'
  },
  scheduledFor: Date,
  sentAt: Date,
  deliveredAt: Date,
  readAt: Date,
  error: String,
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ status: 1, scheduledFor: 1 });

const Notification = mongoose.model('Notification', notificationSchema);

// User preferences schema
const userPreferencesSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  channels: {
    sms: {
      enabled: { type: Boolean, default: true },
      number: String,
      verified: { type: Boolean, default: false }
    },
    email: {
      enabled: { type: Boolean, default: true },
      address: String,
      verified: { type: Boolean, default: false }
    },
    push: {
      enabled: { type: Boolean, default: true },
      tokens: [{
        token: String,
        platform: { type: String, enum: ['ios', 'android', 'web'] },
        addedAt: Date
      }]
    },
    inApp: {
      enabled: { type: Boolean, default: true }
    }
  },
  preferences: {
    rideUpdates: { type: Boolean, default: true },
    promotions: { type: Boolean, default: true },
    newsletters: { type: Boolean, default: false },
    accountAlerts: { type: Boolean, default: true },
    quietHours: {
      enabled: { type: Boolean, default: false },
      start: String, // "22:00"
      end: String    // "08:00"
    },
    language: { type: String, default: 'en' }
  },
  unsubscribeToken: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const UserPreferences = mongoose.model('UserPreferences', userPreferencesSchema);

class NotificationService {
  constructor() {
    this.templates = this.loadTemplates();
    this.initializeQueues();
  }

  /**
   * Load notification templates
   */
  loadTemplates() {
    return {
      RIDE_CONFIRMED: {
        sms: 'Your ride has been confirmed. Driver {{driverName}} will arrive in {{eta}} minutes.',
        email: {
          subject: 'Ride Confirmed - {{rideId}}',
          html: `
            <h2>Your ride has been confirmed!</h2>
            <p>Driver: {{driverName}}</p>
            <p>Vehicle: {{vehicleDetails}}</p>
            <p>ETA: {{eta}} minutes</p>
            <p>Track your ride: {{trackingLink}}</p>
          `
        },
        push: {
          title: 'Ride Confirmed',
          body: 'Driver {{driverName}} is on the way. ETA: {{eta}} min'
        }
      },
      DRIVER_ARRIVED: {
        sms: 'Your driver {{driverName}} has arrived at the pickup location.',
        email: {
          subject: 'Driver Has Arrived',
          html: '<h2>Your driver has arrived!</h2><p>Please meet them at the pickup location.</p>'
        },
        push: {
          title: 'Driver Arrived',
          body: 'Your driver is waiting at the pickup location'
        }
      },
      RIDE_STARTED: {
        sms: 'Your ride has started. Have a safe journey!',
        push: {
          title: 'Ride Started',
          body: 'Your journey has begun. Have a safe ride!'
        }
      },
      RIDE_COMPLETED: {
        sms: 'Ride completed! Total fare: {{fare}}. Thank you for riding with us.',
        email: {
          subject: 'Ride Receipt - {{rideId}}',
          html: `
            <h2>Ride Completed</h2>
            <p>Total Fare: {{fare}}</p>
            <p>Distance: {{distance}}</p>
            <p>Duration: {{duration}}</p>
            <p>View full receipt: {{receiptLink}}</p>
          `
        },
        push: {
          title: 'Ride Completed',
          body: 'Total fare: {{fare}}. Rate your experience!'
        }
      },
      PAYMENT_SUCCESSFUL: {
        sms: 'Payment of {{amount}} processed successfully.',
        email: {
          subject: 'Payment Confirmation',
          html: '<h2>Payment Successful</h2><p>Amount: {{amount}}</p><p>Transaction ID: {{transactionId}}</p>'
        },
        push: {
          title: 'Payment Successful',
          body: '{{amount}} has been charged to your account'
        }
      },
      PROMO_CODE: {
        sms: 'Special offer! Use code {{code}} for {{discount}} off your next ride.',
        email: {
          subject: 'Exclusive Offer Just for You!',
          html: `
            <h2>Special Promotion</h2>
            <p>Use code: <strong>{{code}}</strong></p>
            <p>Get {{discount}} off your next ride!</p>
            <p>Valid until: {{validUntil}}</p>
          `
        },
        push: {
          title: 'Special Offer!',
          body: 'Use code {{code}} for {{discount}} off'
        }
      },
      SOS_ALERT: {
        sms: 'EMERGENCY: {{userName}} has triggered SOS. Location: {{location}}. Contact immediately.',
        email: {
          subject: 'URGENT: SOS Alert',
          html: `
            <h1 style="color: red;">EMERGENCY SOS ALERT</h1>
            <p>{{userName}} has triggered an emergency alert.</p>
            <p>Location: {{location}}</p>
            <p>Time: {{timestamp}}</p>
            <p>Ride ID: {{rideId}}</p>
            <p>Contact them immediately or call emergency services.</p>
          `
        },
        push: {
          title: '🚨 EMERGENCY SOS',
          body: '{{userName}} needs immediate help at {{location}}'
        }
      },
      OTP_VERIFICATION: {
        sms: 'Your verification code is {{otp}}. Valid for 5 minutes.',
        email: {
          subject: 'Verification Code',
          html: '<h2>Your verification code: {{otp}}</h2><p>This code expires in 5 minutes.</p>'
        }
      },
      ACCOUNT_SECURITY: {
        email: {
          subject: 'Security Alert',
          html: `
            <h2>Security Alert</h2>
            <p>{{alertMessage}}</p>
            <p>If this wasn't you, please secure your account immediately.</p>
          `
        },
        push: {
          title: 'Security Alert',
          body: '{{alertMessage}}'
        }
      }
    };
  }

  /**
   * Initialize processing queues
   */
  initializeQueues() {
    // Process notifications
    notificationQueue.process('sms', async (job) => {
      return this.sendSMS(job.data);
    });

    notificationQueue.process('email', async (job) => {
      return this.sendEmail(job.data);
    });

    notificationQueue.process('push', async (job) => {
      return this.sendPushNotification(job.data);
    });

    // Handle queue events
    notificationQueue.on('completed', (job, result) => {
      logger.info(`Notification ${job.id} completed:`, result);
      notificationsSent.inc({ type: job.name, status: 'success' });
    });

    notificationQueue.on('failed', (job, err) => {
      logger.error(`Notification ${job.id} failed:`, err);
      notificationsSent.inc({ type: job.name, status: 'failed' });
    });
  }

  /**
   * Send notification through appropriate channels
   */
  async sendNotification(userId, templateName, data, options = {}) {
    try {
      // Get user preferences
      const preferences = await UserPreferences.findOne({ userId });
      if (!preferences) {
        throw new Error('User preferences not found');
      }

      // Check quiet hours
      if (this.isQuietHours(preferences) && options.priority !== 'urgent') {
        // Schedule for later
        const scheduledTime = this.getNextAvailableTime(preferences);
        return this.scheduleNotification(userId, templateName, data, scheduledTime);
      }

      const template = this.templates[templateName];
      if (!template) {
        throw new Error(`Template ${templateName} not found`);
      }

      const notifications = [];

      // Send through enabled channels
      if (preferences.channels.sms.enabled && template.sms) {
        notifications.push(
          this.queueNotification('sms', {
            userId,
            to: preferences.channels.sms.number,
            message: this.renderTemplate(template.sms, data),
            priority: options.priority
          })
        );
      }

      if (preferences.channels.email.enabled && template.email) {
        notifications.push(
          this.queueNotification('email', {
            userId,
            to: preferences.channels.email.address,
            subject: this.renderTemplate(template.email.subject, data),
            html: this.renderTemplate(template.email.html, data),
            priority: options.priority
          })
        );
      }

      if (preferences.channels.push.enabled && template.push) {
        for (const device of preferences.channels.push.tokens) {
          notifications.push(
            this.queueNotification('push', {
              userId,
              token: device.token,
              platform: device.platform,
              title: this.renderTemplate(template.push.title, data),
              body: this.renderTemplate(template.push.body, data),
              data: data,
              priority: options.priority
            })
          );
        }
      }

      // Store in-app notification
      if (preferences.channels.inApp.enabled) {
        await this.storeInAppNotification(userId, templateName, data);
      }

      // Save to database
      const notification = new Notification({
        userId,
        type: 'multi',
        template: templateName,
        data,
        priority: options.priority || 'normal',
        status: 'pending'
      });
      await notification.save();

      const results = await Promise.allSettled(notifications);
      
      return {
        success: true,
        notificationId: notification._id,
        channels: results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean)
      };

    } catch (error) {
      logger.error('Error sending notification:', error);
      throw error;
    }
  }

  /**
   * Queue notification for processing
   */
  async queueNotification(type, data) {
    const job = await notificationQueue.add(type, data, {
      priority: data.priority === 'urgent' ? 1 : 
                data.priority === 'high' ? 2 : 
                data.priority === 'normal' ? 3 : 4,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      }
    });

    return { type, jobId: job.id };
  }

  /**
   * Send SMS via Twilio
   */
  async sendSMS(data) {
    try {
      const message = await twilioClient.messages.create({
        body: data.message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: data.to
      });

      await Notification.updateOne(
        { userId: data.userId, 'metadata.jobId': data.jobId },
        { 
          status: 'sent',
          sentAt: new Date(),
          'metadata.twilioSid': message.sid
        }
      );

      logger.info(`SMS sent to ${data.to}: ${message.sid}`);
      return { success: true, messageId: message.sid };

    } catch (error) {
      logger.error('Error sending SMS:', error);
      
      await Notification.updateOne(
        { userId: data.userId, 'metadata.jobId': data.jobId },
        { 
          status: 'failed',
          error: error.message
        }
      );

      throw error;
    }
  }

  /**
   * Send email via SendGrid
   */
  async sendEmail(data) {
    try {
      const msg = {
        to: data.to,
        from: process.env.SENDGRID_FROM_EMAIL,
        subject: data.subject,
        html: data.html,
        trackingSettings: {
          clickTracking: { enable: true },
          openTracking: { enable: true }
        }
      };

      const response = await sgMail.send(msg);

      await Notification.updateOne(
        { userId: data.userId, 'metadata.jobId': data.jobId },
        { 
          status: 'sent',
          sentAt: new Date(),
          'metadata.sendgridId': response[0].headers['x-message-id']
        }
      );

      logger.info(`Email sent to ${data.to}`);
      return { success: true, messageId: response[0].headers['x-message-id'] };

    } catch (error) {
      logger.error('Error sending email:', error);
      
      await Notification.updateOne(
        { userId: data.userId, 'metadata.jobId': data.jobId },
        { 
          status: 'failed',
          error: error.message
        }
      );

      throw error;
    }
  }

  /**
   * Send push notification via FCM
   */
  async sendPushNotification(data) {
    try {
      const message = {
        token: data.token,
        notification: {
          title: data.title,
          body: data.body
        },
        data: data.data || {},
        android: {
          priority: data.priority === 'urgent' ? 'high' : 'normal',
          notification: {
            sound: 'default',
            clickAction: 'OPEN_APP'
          }
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
              contentAvailable: true
            }
          }
        }
      };

      const response = await admin.messaging().send(message);

      await Notification.updateOne(
        { userId: data.userId, 'metadata.jobId': data.jobId },
        { 
          status: 'sent',
          sentAt: new Date(),
          'metadata.fcmId': response
        }
      );

      logger.info(`Push notification sent: ${response}`);
      return { success: true, messageId: response };

    } catch (error) {
      logger.error('Error sending push notification:', error);
      
      // Handle token errors
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        await this.removeInvalidToken(data.userId, data.token);
      }

      await Notification.updateOne(
        { userId: data.userId, 'metadata.jobId': data.jobId },
        { 
          status: 'failed',
          error: error.message
        }
      );

      throw error;
    }
  }

  /**
   * Store in-app notification
   */
  async storeInAppNotification(userId, templateName, data) {
    const notification = {
      userId,
      type: 'in_app',
      template: templateName,
      data,
      status: 'unread',
      createdAt: Date.now()
    };

    // Store in Redis for quick access
    await redis.zadd(
      `user:${userId}:notifications`,
      Date.now(),
      JSON.stringify(notification)
    );

    // Publish to real-time channel
    await redis.publish(`user:${userId}:notifications`, JSON.stringify({
      type: 'NEW_NOTIFICATION',
      notification
    }));

    return notification;
  }

  /**
   * Render template with data
   */
  renderTemplate(template, data) {
    return template.replace(/{{(\w+)}}/g, (match, key) => {
      return data[key] || match;
    });
  }

  /**
   * Check if current time is within quiet hours
   */
  isQuietHours(preferences) {
    if (!preferences.preferences.quietHours.enabled) {
      return false;
    }

    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    const [startHour, startMin] = preferences.preferences.quietHours.start.split(':').map(Number);
    const [endHour, endMin] = preferences.preferences.quietHours.end.split(':').map(Number);
    
    const startTime = startHour * 60 + startMin;
    const endTime = endHour * 60 + endMin;

    if (startTime < endTime) {
      return currentTime >= startTime && currentTime < endTime;
    } else {
      return currentTime >= startTime || currentTime < endTime;
    }
  }

  /**
   * Get next available time after quiet hours
   */
  getNextAvailableTime(preferences) {
    const [endHour, endMin] = preferences.preferences.quietHours.end.split(':').map(Number);
    const nextTime = new Date();
    nextTime.setHours(endHour, endMin, 0, 0);
    
    if (nextTime < new Date()) {
      nextTime.setDate(nextTime.getDate() + 1);
    }
    
    return nextTime;
  }

  /**
   * Schedule notification for later
   */
  async scheduleNotification(userId, templateName, data, scheduledTime) {
    const delay = scheduledTime.getTime() - Date.now();
    
    const job = await notificationQueue.add('scheduled', {
      userId,
      templateName,
      data,
      scheduledFor: scheduledTime
    }, {
      delay,
      attempts: 3
    });

    const notification = new Notification({
      userId,
      template: templateName,
      data,
      status: 'scheduled',
      scheduledFor: scheduledTime,
      metadata: { jobId: job.id }
    });
    await notification.save();

    return {
      success: true,
      notificationId: notification._id,
      scheduledFor: scheduledTime
    };
  }

  /**
   * Remove invalid push token
   */
  async removeInvalidToken(userId, token) {
    await UserPreferences.updateOne(
      { userId },
      { $pull: { 'channels.push.tokens': { token } } }
    );
    
    logger.info(`Removed invalid token for user ${userId}`);
  }

  /**
   * Get user notifications
   */
  async getUserNotifications(userId, limit = 50, offset = 0) {
    const notifications = await redis.zrevrange(
      `user:${userId}:notifications`,
      offset,
      offset + limit - 1
    );

    return notifications.map(n => JSON.parse(n));
  }

  /**
   * Mark notification as read
   */
  async markAsRead(userId, notificationId) {
    await Notification.updateOne(
      { _id: notificationId, userId },
      { 
        status: 'read',
        readAt: new Date()
      }
    );

    // Update in Redis
    const notifications = await this.getUserNotifications(userId, 100);
    const notification = notifications.find(n => n.id === notificationId);
    if (notification) {
      notification.status = 'read';
      notification.readAt = Date.now();
      
      await redis.zadd(
        `user:${userId}:notifications`,
        notification.createdAt,
        JSON.stringify(notification)
      );
    }

    return { success: true };
  }

  /**
   * Update user preferences
   */
  async updatePreferences(userId, updates) {
    const preferences = await UserPreferences.findOneAndUpdate(
      { userId },
      { $set: updates, updatedAt: new Date() },
      { new: true, upsert: true }
    );

    return preferences;
  }

  /**
   * Send bulk notifications
   */
  async sendBulkNotifications(userIds, templateName, data, options = {}) {
    const results = [];
    
    // Process in batches to avoid overwhelming the system
    const batchSize = 100;
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(userId => this.sendNotification(userId, templateName, data, options))
      );
      results.push(...batchResults);
    }

    return {
      total: userIds.length,
      successful: results.filter(r => r.status === 'fulfilled').length,
      failed: results.filter(r => r.status === 'rejected').length,
      results
    };
  }
}

// Initialize service
const notificationService = new NotificationService();

// API endpoints

// Ad-hoc OTP sender for email or SMS
app.post('/send-otp', async (req, res) => {
  try {
    const { toEmail, toPhone, otp, purpose = 'verification' } = req.body || {};
    if (!otp || (!toEmail && !toPhone)) return res.status(400).json({ message: 'otp and toEmail/toPhone required' });

    if (toPhone && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
      await twilioClient.messages.create({
        body: `Your ${purpose} code is ${otp}. It expires in 5 minutes.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: toPhone
      });
    }

    if (toEmail && process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL) {
      await sgMail.send({
        to: toEmail,
        from: process.env.SENDGRID_FROM_EMAIL,
        subject: 'Your verification code',
        html: `<h2>Your verification code: ${otp}</h2><p>This code expires in 5 minutes.</p>`
      });
    }

    return res.json({ sent: true });
  } catch (error) {
    logger.error('send-otp failed', error);
    return res.status(500).json({ message: 'failed' });
  }
});

app.post('/send', async (req, res) => {
  try {
    const { userId, template, data, options } = req.body;
    const result = await notificationService.sendNotification(userId, template, data, options);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-bulk', async (req, res) => {
  try {
    const { userIds, template, data, options } = req.body;
    const result = await notificationService.sendBulkNotifications(userIds, template, data, options);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/user/:userId/notifications', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const notifications = await notificationService.getUserNotifications(
      req.params.userId,
      parseInt(limit),
      parseInt(offset)
    );
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/notification/:id/read', async (req, res) => {
  try {
    const result = await notificationService.markAsRead(req.body.userId, req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/user/:userId/preferences', async (req, res) => {
  try {
    const preferences = await notificationService.updatePreferences(
      req.params.userId,
      req.body
    );
    res.json(preferences);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'notification-service' });
});

// Metrics
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Database connection
mongoose.connect(process.env.DB_CONNECT || 'mongodb://mongo:27017/notifications', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  logger.info('Connected to MongoDB');
  
  // Start server
  const PORT = process.env.PORT || 4008;
  app.listen(PORT, () => {
    logger.info(`Notification service running on port ${PORT}`);
  });
})
.catch(err => {
  logger.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});

module.exports = notificationService;
