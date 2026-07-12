// ============================================
// 🔔 NOTIFICATIONS & EVENTS SYSTEM
// ============================================

const { db, encryption } = require('../A/m1.js');

class NotificationService {
    constructor() {
        this.notificationQueue = [];
        this.eventBus = new Map();
        this.realtimeNotifications = new Map();
        this.notificationPreferences = new Map();
        this.pushTokens = new Map();
        this.emailQueue = [];
        this.smsQueue = [];
        this.MAX_QUEUE = 10000;
        this.MAX_NOTIFICATIONS_PER_USER = 500;
    }

    // ===== NOTIFICATION MANAGEMENT =====
    async createNotification(data) {
        const { userId, fromUserId, type, postId, commentId, message, metadata = {} } = data;

        const notification = {
            notificationId: encryption.generateId('notif'),
            userId,
            fromUserId: fromUserId || null,
            type, // 'like', 'comment', 'follow', 'mention', 'post', 'story', 'live', 'message', 'system'
            postId: postId || null,
            commentId: commentId || null,
            message: message || this.getDefaultMessage(type, fromUserId),
            metadata,
            isRead: false,
            isDelivered: false,
            createdAt: new Date().toISOString(),
            readAt: null,
            deliveredAt: null
        };

        // Check preferences
        const prefs = this.getPreferences(userId);
        if (prefs[type] === false) {
            return null;
        }

        // Save to database
        db.addNotification(notification);

        // Add to queue
        this.notificationQueue.push(notification);
        if (this.notificationQueue.length > this.MAX_QUEUE) {
            this.notificationQueue = this.notificationQueue.slice(-this.MAX_QUEUE);
        }

        // Store for realtime
        if (!this.realtimeNotifications.has(userId)) {
            this.realtimeNotifications.set(userId, []);
        }
        const userNotifs = this.realtimeNotifications.get(userId);
        userNotifs.push(notification);
        if (userNotifs.length > this.MAX_NOTIFICATIONS_PER_USER) {
            userNotifs.splice(0, userNotifs.length - this.MAX_NOTIFICATIONS_PER_USER);
        }

        // Emit event
        this.emitEvent('notification', notification);

        return notification;
    }

    getDefaultMessage(type, fromUserId) {
        const fromUser = fromUserId ? db.getUser(fromUserId) : null;
        const fromName = fromUser?.fullName || fromUser?.username || 'کاربر';
        
        const messages = {
            like: `${fromName} پست شما را لایک کرد`,
            comment: `${fromName} روی پست شما کامنت گذاشت`,
            follow: `${fromName} شما را دنبال کرد`,
            mention: `${fromName} شما را منشن کرد`,
            post: `${fromName} پست جدیدی منتشر کرد`,
            story: `${fromName} استوری جدیدی منتشر کرد`,
            live: `${fromName} لایو را شروع کرد`,
            message: `${fromName} به شما پیام داد`,
            system: 'پیام سیستم'
        };
        return messages[type] || 'اعلان جدید';
    }

    async getNotifications(userId, limit = 50, offset = 0) {
        const all = db.getNotifications(userId, limit + offset);
        return all.slice(offset, offset + limit);
    }

    async markRead(notificationId, userId) {
        const marked = db.markNotificationRead(notificationId, userId);
        if (marked) {
            const notifs = db.getNotifications(userId);
            const notif = notifs.find(n => n.notificationId === notificationId);
            if (notif) {
                notif.isRead = true;
                notif.readAt = new Date().toISOString();
                
                // Update realtime
                if (this.realtimeNotifications.has(userId)) {
                    const userNotifs = this.realtimeNotifications.get(userId);
                    const index = userNotifs.findIndex(n => n.notificationId === notificationId);
                    if (index !== -1) {
                        userNotifs[index].isRead = true;
                        userNotifs[index].readAt = new Date().toISOString();
                    }
                }
            }
        }
        return { success: marked };
    }

    async markAllRead(userId) {
        const notifs = db.getNotifications(userId);
        for (const notif of notifs) {
            if (!notif.isRead) {
                db.markNotificationRead(notif.notificationId, userId);
                notif.isRead = true;
                notif.readAt = new Date().toISOString();
            }
        }
        
        if (this.realtimeNotifications.has(userId)) {
            const userNotifs = this.realtimeNotifications.get(userId);
            for (const notif of userNotifs) {
                notif.isRead = true;
                notif.readAt = new Date().toISOString();
            }
        }

        return { success: true };
    }

    async deleteNotification(notificationId, userId) {
        // In production, implement delete from database
        return { success: true };
    }

    getUnreadCount(userId) {
        const notifs = db.getNotifications(userId);
        return notifs.filter(n => !n.isRead).length;
    }

    // ===== EVENT BUS =====
    onEvent(event, callback) {
        if (!this.eventBus.has(event)) {
            this.eventBus.set(event, []);
        }
        this.eventBus.get(event).push(callback);
    }

    emitEvent(event, data) {
        if (this.eventBus.has(event)) {
            for (const callback of this.eventBus.get(event)) {
                try {
                    callback(data);
                } catch (error) {
                    console.error('Event callback error:', error);
                }
            }
        }
    }

    // ===== NOTIFICATION TYPES =====
    async notifyLike(userId, fromUserId, postId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'like',
            postId,
            message: `${db.getUser(fromUserId)?.username || 'کاربر'} پست شما را لایک کرد`
        });
    }

    async notifyComment(userId, fromUserId, postId, commentId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'comment',
            postId,
            commentId,
            message: `${db.getUser(fromUserId)?.username || 'کاربر'} روی پست شما کامنت گذاشت`
        });
    }

    async notifyFollow(userId, fromUserId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'follow',
            message: `${db.getUser(fromUserId)?.username || 'کاربر'} شما را دنبال کرد`
        });
    }

    async notifyMention(userId, fromUserId, postId, commentId = null) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'mention',
            postId,
            commentId,
            message: `${db.getUser(fromUserId)?.username || 'کاربر'} شما را منشن کرد`
        });
    }

    async notifyPost(userId, fromUserId, postId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'post',
            postId,
            message: `${db.getUser(fromUserId)?.username || 'کاربر'} پست جدیدی منتشر کرد`
        });
    }

    async notifyStory(userId, fromUserId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'story',
            message: `${db.getUser(fromUserId)?.username || 'کاربر'} استوری جدیدی منتشر کرد`
        });
    }

    async notifyLive(userId, fromUserId, streamId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'live',
            metadata: { streamId },
            message: `${db.getUser(fromUserId)?.username || 'کاربر'} لایو را شروع کرد`
        });
    }

    async notifyMessage(userId, fromUserId, message) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'message',
            message: message || `${db.getUser(fromUserId)?.username || 'کاربر'} به شما پیام داد`
        });
    }

    // ===== PUSH NOTIFICATIONS =====
    async registerPushToken(userId, token, deviceId, platform) {
        if (!this.pushTokens.has(userId)) {
            this.pushTokens.set(userId, new Map());
        }
        this.pushTokens.get(userId).set(deviceId, {
            token,
            platform,
            registeredAt: new Date().toISOString()
        });
        return { success: true };
    }

    async unregisterPushToken(userId, deviceId) {
        if (this.pushTokens.has(userId)) {
            this.pushTokens.get(userId).delete(deviceId);
        }
        return { success: true };
    }

    async sendPushNotification(userId, notification) {
        if (!this.pushTokens.has(userId)) return false;
        
        const tokens = this.pushTokens.get(userId);
        let sent = 0;
        
        for (const [deviceId, data] of tokens) {
            try {
                // In production, send via FCM/APNS
                sent++;
            } catch (error) {
                console.error('Push notification error:', error);
            }
        }
        
        return { success: true, sent };
    }

    // ===== NOTIFICATION PREFERENCES =====
    setPreferences(userId, preferences) {
        if (!this.notificationPreferences.has(userId)) {
            this.notificationPreferences.set(userId, {});
        }
        const current = this.notificationPreferences.get(userId);
        this.notificationPreferences.set(userId, { ...current, ...preferences });
        return { success: true };
    }

    getPreferences(userId) {
        const defaults = {
            like: true,
            comment: true,
            follow: true,
            mention: true,
            post: true,
            story: true,
            live: true,
            message: true,
            system: true
        };
        
        const userPrefs = this.notificationPreferences.get(userId) || {};
        return { ...defaults, ...userPrefs };
    }

    // ===== EMAIL NOTIFICATIONS =====
    async queueEmail(to, subject, body, data = {}) {
        this.emailQueue.push({
            to,
            subject,
            body,
            data,
            queuedAt: new Date().toISOString()
        });
        
        if (this.emailQueue.length > this.MAX_QUEUE) {
            this.emailQueue = this.emailQueue.slice(-this.MAX_QUEUE);
        }
        
        return { success: true };
    }

    // ===== SMS NOTIFICATIONS =====
    async queueSms(to, message) {
        this.smsQueue.push({
            to,
            message,
            queuedAt: new Date().toISOString()
        });
        
        if (this.smsQueue.length > this.MAX_QUEUE) {
            this.smsQueue = this.smsQueue.slice(-this.MAX_QUEUE);
        }
        
        return { success: true };
    }

    // ===== CLEANUP =====
    cleanup() {
        const now = Date.now();
        const oneMonth = 30 * 24 * 60 * 60 * 1000;

        // Clean old notifications
        for (const [userId, notifs] of this.realtimeNotifications) {
            this.realtimeNotifications.set(
                userId,
                notifs.filter(n => now - new Date(n.createdAt).getTime() < oneMonth)
            );
        }

        // Clean queue
        if (this.notificationQueue.length > this.MAX_QUEUE) {
            this.notificationQueue = this.notificationQueue.slice(-this.MAX_QUEUE);
        }

        // Clean email queue
        if (this.emailQueue.length > this.MAX_QUEUE) {
            this.emailQueue = this.emailQueue.slice(-this.MAX_QUEUE);
        }

        // Clean SMS queue
        if (this.smsQueue.length > this.MAX_QUEUE) {
            this.smsQueue = this.smsQueue.slice(-this.MAX_QUEUE);
        }
    }

    // ===== STATS =====
    getStats() {
        return {
            totalNotifications: this.notificationQueue.length,
            totalPushTokens: this.pushTokens.size,
            totalEmailQueue: this.emailQueue.length,
            totalSmsQueue: this.smsQueue.length,
            realtimeNotifications: this.realtimeNotifications.size,
            eventListeners: this.eventBus.size
        };
    }

    // ===== PROCESS QUEUES =====
    async processEmailQueue() {
        const emails = this.emailQueue.splice(0, 10);
        for (const email of emails) {
            try {
                // In production, send email
                console.log('Sending email:', email.to, email.subject);
            } catch (error) {
                console.error('Email error:', error);
            }
        }
        return emails.length;
    }

    async processSmsQueue() {
        const sms = this.smsQueue.splice(0, 10);
        for (const s of sms) {
            try {
                // In production, send SMS
                console.log('Sending SMS:', s.to, s.message);
            } catch (error) {
                console.error('SMS error:', error);
            }
        }
        return sms.length;
    }

    // ===== START PROCESSORS =====
    startProcessors() {
        this.emailProcessor = setInterval(() => this.processEmailQueue(), 5000);
        this.smsProcessor = setInterval(() => this.processSmsQueue(), 5000);
        this.cleanupProcessor = setInterval(() => this.cleanup(), 60000);
    }

    stopProcessors() {
        if (this.emailProcessor) clearInterval(this.emailProcessor);
        if (this.smsProcessor) clearInterval(this.smsProcessor);
        if (this.cleanupProcessor) clearInterval(this.cleanupProcessor);
    }
}

module.exports = new NotificationService();
