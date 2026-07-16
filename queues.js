// ============================================
// queues.js - صف‌بندی پیشرفته با Bull و Redis
// ============================================
const Bull = require('bull');
const { createClient } = require('ioredis');
const { processMediaJob } = require('./media_processor');
const { createLogger } = require('./logger');
const { v4: uuidv4 } = require('uuid');

const logger = createLogger('queues');

// ============================================
// اتصال Redis
// ============================================
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 50, 2000)
};

const redisClient = createClient({ url: redisUrl, ...redisOptions });

(async () => {
    try {
        await redisClient.connect();
        logger.info('✅ Redis connected for Bull');
    } catch (err) {
        logger.error('❌ Redis connection failed for Bull:', err);
    }
})();

// ============================================
// تنظیمات صف‌ها
// ============================================
function setupQueues(db, redis) {
    // ============================================
    // صف مدیا (آپلود و فشرده‌سازی)
    // ============================================
    const mediaQueue = new Bull('media-processing', {
        redis: { 
            host: process.env.REDIS_HOST || 'localhost', 
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined
        },
        defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: 100,
            removeOnFail: 500,
            timeout: 7200000, // 2 ساعت
            priority: 5
        },
        settings: {
            stalledInterval: 30000,
            maxStalledCount: 3,
            guardInterval: 5000,
            retryProcessDelay: 5000
        }
    });

    // ============================================
    // صف نوتیفیکیشن
    // ============================================
    const notificationQueue = new Bull('notifications', {
        redis: { 
            host: process.env.REDIS_HOST || 'localhost', 
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined
        },
        defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: 1000,
            removeOnFail: 500,
            priority: 3
        },
        settings: {
            stalledInterval: 10000,
            maxStalledCount: 2
        }
    });

    // ============================================
    // صف ایمیل
    // ============================================
    const emailQueue = new Bull('emails', {
        redis: { 
            host: process.env.REDIS_HOST || 'localhost', 
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined
        },
        defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'fixed', delay: 5000 },
            removeOnComplete: 1000,
            removeOnFail: 500,
            priority: 7,
            timeout: 60000
        }
    });

    // ============================================
    // صف تحلیل داده
    // ============================================
    const analyticsQueue = new Bull('analytics', {
        redis: { 
            host: process.env.REDIS_HOST || 'localhost', 
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined
        },
        defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },
            removeOnComplete: 50,
            removeOnFail: 100,
            priority: 10,
            timeout: 300000 // 5 دقیقه
        }
    });

    // ============================================
    // صف گزارش‌ها
    // ============================================
    const reportQueue = new Bull('reports', {
        redis: { 
            host: process.env.REDIS_HOST || 'localhost', 
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined
        },
        defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 3000 },
            removeOnComplete: 200,
            removeOnFail: 100,
            priority: 2
        }
    });

    // ============================================
    // پردازش‌گر صف مدیا (با Worker Pool)
    // ============================================
    const mediaWorkers = parseInt(process.env.MEDIA_WORKERS || '5', 10);
    mediaQueue.process(mediaWorkers, async (job) => {
        logger.info(`Processing media job ${job.id} (attempt ${job.attemptsMade + 1})`);
        try {
            const result = await processMediaJob(job);
            // ذخیره نتیجه در Redis برای دسترسی سریع
            await redis.setex(`media_result:${job.id}`, 3600, JSON.stringify(result));
            return result;
        } catch (error) {
            logger.error(`Media job ${job.id} failed:`, error);
            throw error;
        }
    });

    // ============================================
    // پردازش‌گر صف نوتیفیکیشن
    // ============================================
    notificationQueue.process(20, async (job) => {
        const { userId, title, message, type, data } = job.data;
        logger.debug(`Sending notification to ${userId}: ${title}`);
        
        try {
            const id = uuidv4();
            await db.query(userId, `
                INSERT INTO system_notifications (id, user_id, title, message, type, data, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            `, [id, userId, title, message, type, JSON.stringify(data || {})]);

            // ارسال از طریق WebSocket
            const io = require('./server').io;
            if (io) {
                io.to(`user_${userId}`).emit('notification', { 
                    id, 
                    title, 
                    message, 
                    type, 
                    data,
                    created_at: new Date().toISOString()
                });
            }

            // ارسال Push Notification (اگر تنظیم شده باشد)
            if (process.env.PUSH_NOTIFICATION_ENABLED === 'true') {
                await sendPushNotification(userId, title, message, data);
            }

            return { success: true, notificationId: id };
        } catch (error) {
            logger.error(`Notification job ${job.id} failed:`, error);
            throw error;
        }
    });

    // ============================================
    // پردازش‌گر صف ایمیل
    // ============================================
    emailQueue.process(10, async (job) => {
        const { to, subject, html, text, from, replyTo, attachments } = job.data;
        logger.info(`Sending email to ${to}: ${subject}`);
        
        try {
            // اینجا می‌توانید سرویس ایمیل مثل Nodemailer یا SendGrid را اضافه کنید
            // فعلاً فقط لاگ می‌کنیم و در دیتابیس ذخیره می‌کنیم
            
            if (process.env.SEND_EMAIL_ENABLED === 'true') {
                // پیاده‌سازی ارسال ایمیل
                // await sendEmail({ to, subject, html, text, from, replyTo, attachments });
            }

            // ذخیره تاریخچه ارسال ایمیل
            const id = uuidv4();
            await db.query(null, `
                INSERT INTO email_logs (id, to_email, subject, status, sent_at)
                VALUES ($1, $2, $3, 'sent', CURRENT_TIMESTAMP)
            `, [id, to, subject]);

            return { success: true, to, subject };
        } catch (error) {
            logger.error(`Email job ${job.id} failed:`, error);
            throw error;
        }
    });

    // ============================================
    // پردازش‌گر صف تحلیل داده
    // ============================================
    analyticsQueue.process(5, async (job) => {
        const { type, data, userId } = job.data;
        logger.debug(`Analytics job: ${type} for user ${userId}`);
        
        try {
            switch (type) {
                case 'user_activity':
                    await analyzeUserActivity(userId, data);
                    break;
                case 'content_analysis':
                    await analyzeContent(data);
                    break;
                case 'engagement_metrics':
                    await calculateEngagementMetrics(userId);
                    break;
                case 'realtime_stats':
                    await updateRealtimeStats(data);
                    break;
                default:
                    logger.warn(`Unknown analytics type: ${type}`);
            }
            return { success: true, type, userId };
        } catch (error) {
            logger.error(`Analytics job ${job.id} failed:`, error);
            throw error;
        }
    });

    // ============================================
    // پردازش‌گر صف گزارش‌ها
    // ============================================
    reportQueue.process(5, async (job) => {
        const { reportId, action } = job.data;
        logger.info(`Processing report ${reportId}: ${action}`);
        
        try {
            if (action === 'process') {
                const report = await db.query(null, `
                    SELECT * FROM reports WHERE id = $1
                `, [reportId]);
                
                if (report.rows.length > 0) {
                    // پردازش خودکار گزارش
                    await autoProcessReport(report.rows[0]);
                }
            }
            return { success: true, reportId, action };
        } catch (error) {
            logger.error(`Report job ${job.id} failed:`, error);
            throw error;
        }
    });

    // ============================================
    // رویدادهای صف
    // ============================================
    const queues = {
        mediaQueue,
        notificationQueue,
        emailQueue,
        analyticsQueue,
        reportQueue
    };

    // ثبت رویدادها برای همه صف‌ها
    Object.values(queues).forEach((queue, index) => {
        const name = Object.keys(queues)[index];
        
        queue.on('completed', (job, result) => {
            logger.info(`[${name}] Job ${job.id} completed successfully`);
        });

        queue.on('failed', (job, err) => {
            logger.error(`[${name}] Job ${job.id} failed:`, err);
        });

        queue.on('stalled', (job) => {
            logger.warn(`[${name}] Job ${job.id} stalled`);
        });

        queue.on('progress', (job, progress) => {
            if (progress % 10 === 0) {
                logger.debug(`[${name}] Job ${job.id} progress: ${progress}%`);
            }
        });

        queue.on('error', (err) => {
            logger.error(`[${name}] Queue error:`, err);
        });

        queue.on('paused', () => {
            logger.info(`[${name}] Queue paused`);
        });

        queue.on('resumed', () => {
            logger.info(`[${name}] Queue resumed`);
        });

        queue.on('drained', () => {
            logger.info(`[${name}] Queue drained`);
        });
    });

    // ============================================
    // توابع کمکی برای صف‌ها
    // ============================================
    async function getQueueStats() {
        const stats = {};
        for (const [name, queue] of Object.entries(queues)) {
            stats[name] = {
                waiting: await queue.count(),
                active: await queue.getActiveCount(),
                completed: await queue.getCompletedCount(),
                failed: await queue.getFailedCount(),
                delayed: await queue.getDelayedCount(),
                paused: await queue.isPaused()
            };
        }
        return stats;
    }

    async function cleanQueues() {
        for (const queue of Object.values(queues)) {
            await queue.clean(86400000, 'completed');
            await queue.clean(86400000, 'failed');
        }
        logger.info('Queues cleaned');
    }

    async function pauseAllQueues() {
        for (const queue of Object.values(queues)) {
            await queue.pause();
        }
        logger.info('All queues paused');
    }

    async function resumeAllQueues() {
        for (const queue of Object.values(queues)) {
            await queue.resume();
        }
        logger.info('All queues resumed');
    }

    return {
        ...queues,
        getQueueStats,
        cleanQueues,
        pauseAllQueues,
        resumeAllQueues
    };
}

// ============================================
// توابع کمکی
// ============================================
async function analyzeUserActivity(userId, data) {
    // تحلیل فعالیت کاربر
    // محاسبه امتیاز، تعامل، الگوهای رفتاری و ...
    return { analyzed: true };
}

async function analyzeContent(data) {
    // تحلیل محتوا
    // تشخیص هرزنامه، محتوای نامناسب، کیفیت و ...
    return { analyzed: true };
}

async function calculateEngagementMetrics(userId) {
    // محاسبه معیارهای تعامل
    return { calculated: true };
}

async function updateRealtimeStats(data) {
    // به‌روزرسانی آمار لحظه‌ای
    return { updated: true };
}

async function autoProcessReport(report) {
    // پردازش خودکار گزارش
    return { processed: true };
}

async function sendPushNotification(userId, title, message, data) {
    // ارسال Push Notification
    return { sent: true };
}

module.exports = { setupQueues };