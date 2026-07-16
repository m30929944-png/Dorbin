// ============================================
// server.js - سرور اصلی با معماری میلیون‌ها کاربر
// ============================================
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const morgan = require('morgan');
const { createClient } = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');
const bcrypt = require('bcrypt');
const sanitize = require('sanitize-html');
const validator = require('validator');
const { v4: uuidv4 } = require('uuid');
const { RateLimiterRedis } = require('rate-limiter-flexible');
const { createBullBoard } = require('@bull-board/express');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { expressjwt: jwt } = require('express-jwt');
const jsonwebtoken = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const xss = require('xss');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { promisify } = require('util');
const cluster = require('cluster');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { performance, PerformanceObserver } = require('perf_hooks');

// ============================================
// ماژول‌های اختصاصی
// ============================================
const DatabaseManager = require('./database');
const IntelligentAssistant = require('./assistant_logic');
const { processImage, processVideo, processMediaJob } = require('./media_processor');
const { uploadToCloud, getFileUrl, deleteFromCloud } = require('./storage');
const { setupQueues } = require('./queues');
const { createLogger, stream } = require('./logger');

// ============================================
// لاگر حرفه‌ای
// ============================================
const logger = createLogger('server');

// ============================================
// کلید JWT
// ============================================
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

// ============================================
// تنظیمات Redis Cluster با failover
// ============================================
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        logger.warn(`Redis reconnecting attempt ${times}, delay: ${delay}ms`);
        return delay;
    },
    reconnectOnError: (err) => {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
            return true;
        }
        return false;
    }
};

const redis = createClient({ url: redisUrl, ...redisOptions });
const pub = createClient({ url: redisUrl, ...redisOptions });
const sub = createClient({ url: redisUrl, ...redisOptions });

// اتصال به Redis با مدیریت خطا
(async () => {
    try {
        await Promise.all([
            redis.connect(),
            pub.connect(),
            sub.connect()
        ]);
        logger.info('✅ Redis Cluster connected successfully');
        
        // تست اتصال
        await redis.ping();
        logger.info('✅ Redis ping successful');
    } catch (err) {
        logger.error('❌ Redis connection failed:', err);
        // در صورت خطا، با ری‌ترای مجدد تلاش می‌کنیم
        setTimeout(() => {
            logger.info('Retrying Redis connection...');
            process.exit(1);
        }, 5000);
    }
})();

// ============================================
// تنظیمات سرور با امنیت فوق‌پیشرفته
// ============================================
const app = express();
app.set('trust proxy', 1);
app.set('etag', 'strong');
app.set('x-powered-by', false);

const server = http.createServer(app);

// تنظیمات Socket.IO با مقیاس‌پذیری بالا
const io = socketIO(server, {
    cors: {
        origin: process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : "*",
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'userId', 'x-requested-with']
    },
    pingTimeout: 120000,
    pingInterval: 30000,
    maxHttpBufferSize: 1e8,
    adapter: createAdapter(pub, sub),
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    perMessageDeflate: {
        threshold: 1024
    },
    httpCompression: {
        threshold: 1024
    }
});

// ============================================
// دیتابیس
// ============================================
const db = new DatabaseManager();

// ============================================
// صف‌ها
// ============================================
const queues = setupQueues(db, redis);

// ============================================
// Bull Board برای مانیتورینگ صف‌ها
// ============================================
const { router: bullRouter } = createBullBoard([
    new BullAdapter(queues.mediaQueue),
    new BullAdapter(queues.notificationQueue),
    new BullAdapter(queues.emailQueue),
    new BullAdapter(queues.analyticsQueue),
    new BullAdapter(queues.reportQueue)
]);
app.use('/admin/queues', bullRouter);

// ============================================
// Security Headers فوق‌پیشرفته
// ============================================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:", "http:", "blob:"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://code.jquery.com"],
            connectSrc: ["'self'", "wss:", "https:", "http:"],
            mediaSrc: ["'self'", "https:", "http:", "blob:"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: { policy: "require-corp" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-site" },
    dnsPrefetchControl: { allow: false },
    frameguard: { action: "deny" },
    hsts: { 
        maxAge: 31536000, 
        includeSubDomains: true, 
        preload: true 
    },
    ieNoOpen: true,
    noSniff: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    xssFilter: true,
    originAgentCluster: true,
    permittedCrossDomainPolicies: { permittedPolicies: "none" }
}));

// ============================================
// Compression با بالاترین سطح
// ============================================
app.use(compression({
    level: 9,
    threshold: 512,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        if (req.path.startsWith('/uploads/')) return true;
        return compression.filter(req, res);
    },
    brotli: {
        enabled: true,
        params: {
            [require('zlib').constants.BROTLI_PARAM_QUALITY]: 11
        }
    }
}));

// ============================================
// CORS با تنظیمات پیشرفته
// ============================================
app.use(cors({
    origin: process.env.CORS_ORIGIN ? 
        (origin, callback) => {
            const allowed = process.env.CORS_ORIGIN.split(',');
            if (!origin || allowed.includes(origin) || allowed.includes('*')) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        } : 
        (origin, callback) => callback(null, true),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'userId', 'x-requested-with', 'Accept', 'Origin'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
    maxAge: 86400
}));

// ============================================
// Morgan با لاگینگ پیشرفته
// ============================================
app.use(morgan('combined', { 
    stream,
    skip: (req) => req.path === '/health' || req.path === '/metrics'
}));

// ============================================
// Rate Limiter فوق‌پیشرفته با Redis
// ============================================
const rateLimiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'ratelimit',
    points: 100,
    duration: 60,
    blockDuration: 300,
    inmemoryBlockOnConsumed: 200,
    inmemoryBlockDuration: 60,
    insuranceLimiter: new RateLimiterRedis({
        storeClient: redis,
        keyPrefix: 'ratelimit_insurance',
        points: 50,
        duration: 60
    })
});

app.use(async (req, res, next) => {
    try {
        const key = `${req.ip}:${req.path}:${req.method}`;
        await rateLimiter.consume(key);
        next();
    } catch (err) {
        if (err instanceof Error) {
            res.status(429).json({ 
                error: 'تعداد درخواست‌ها بیش از حد مجاز است',
                retryAfter: Math.ceil(err.msBeforeNext / 1000) || 60
            });
        } else {
            res.status(429).json({ error: 'محدودیت درخواست' });
        }
    }
});

// ============================================
// Body Parser با محدودیت هوشمند
// ============================================
app.use(bodyParser.json({ 
    limit: '50mb',
    verify: (req, res, buf) => {
        try {
            JSON.parse(buf);
        } catch (e) {
            res.status(400).json({ error: 'JSON نامعتبر' });
            throw new Error('Invalid JSON');
        }
    }
}));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(bodyParser.raw({ limit: '50mb', type: 'application/octet-stream' }));

// ============================================
// Static Files با کش پیشرفته
// ============================================
app.use(express.static(__dirname, { 
    maxAge: '30d', 
    etag: true,
    immutable: true,
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
}));

// ============================================
// آپلود فایل با مسیر سازمان‌یافته و امنیت بالا
// ============================================
const uploadsBaseDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsBaseDir)) fs.mkdirSync(uploadsBaseDir, { recursive: true, mode: 0o755 });

function getUploadPath(userId, ext) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const timestamp = Date.now();
    const random = crypto.randomBytes(32).toString('hex');
    const dir = path.join(uploadsBaseDir, 'users', userId, String(year), month, day);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    return path.join(dir, `${timestamp}_${random}${ext}`);
}

async function checkUserFileLimit(userId) {
    const result = await db.query(userId, `
        SELECT COUNT(*) as count FROM user_uploads WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
    `, [userId]);
    const count = parseInt(result.rows[0]?.count || 0);
    if (count >= 100) {
        throw new Error('شما حداکثر ۱۰۰ فایل در ۳۰ روز می‌توانید آپلود کنید');
    }
    return count;
}

// ============================================
// Multer با تنظیمات امنیتی
// ============================================
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const userId = req.headers.userid || req.body.userId;
            if (!userId) return cb(new Error('userId required'));
            const dir = path.join(uploadsBaseDir, 'temp');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
            const random = crypto.randomBytes(32).toString('hex');
            cb(null, `temp_${Date.now()}_${random}${ext}`);
        }
    }),
    limits: {
        fileSize: parseInt(process.env.MAX_UPLOAD_MB || '500', 10) * 1024 * 1024,
        files: 1,
        fieldSize: 50 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const allowedImages = /^(image\/(jpeg|png|gif|webp|heic|heif|bmp|tiff|svg\+xml))$/;
        const allowedVideos = /^(video\/(mp4|webm|quicktime|ogg|mov|avi|mkv|flv|wmv|3gp))$/;
        const allowedDocuments = /^(application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|zip|rar|7z))$/;
        
        if (allowedImages.test(file.mimetype) || 
            allowedVideos.test(file.mimetype) || 
            allowedDocuments.test(file.mimetype)) {
            return cb(null, true);
        }
        cb(new Error('نوع فایل مجاز نیست (فقط عکس، ویدیو و PDF)'));
    }
});

const uploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 50,
    message: { success: false, error: 'تعداد آپلودها بیش از حد مجاز است' }
});

app.use('/uploads', express.static(uploadsBaseDir, { 
    maxAge: '30d', 
    etag: true,
    immutable: true,
    setHeaders: (res, path) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'");
    }
}));

// ============================================
// API آپلود با پردازش پیشرفته
// ============================================
app.post('/api/upload', uploadLimiter, async (req, res) => {
    const userId = req.headers.userid || req.body.userId;
    if (!userId) {
        return res.status(400).json({ success: false, error: 'userId required' });
    }

    upload.single('file')(req, res, async (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ 
                    success: false, 
                    error: `حجم فایل بیشتر از حد مجاز (${process.env.MAX_UPLOAD_MB || 500}MB) است` 
                });
            }
            if (err.code === 'LIMIT_UNEXPECTED_FILE') {
                return res.status(400).json({ success: false, error: 'فایل غیرمجاز' });
            }
            return res.status(400).json({ success: false, error: err.message });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'فایلی ارسال نشده' });
        }

        try {
            await checkUserFileLimit(userId);

            const tempPath = req.file.path;
            const ext = path.extname(req.file.originalname).toLowerCase();
            const isVideo = req.file.mimetype.startsWith('video/');
            const isDocument = req.file.mimetype.startsWith('application/');
            
            const job = await queues.mediaQueue.add('processMedia', {
                userId,
                tempPath,
                originalName: req.file.originalname,
                mimeType: req.file.mimetype,
                size: req.file.size,
                isVideo,
                isDocument,
                ext
            }, {
                attempts: 5,
                backoff: { type: 'exponential', delay: 5000 },
                timeout: 7200000, // 2 ساعت
                priority: isVideo ? 1 : 2,
                removeOnComplete: 50,
                removeOnFail: 100
            });

            // ذخیره وضعیت آپلود در Redis
            await redis.setex(`upload:${job.id}`, 3600, JSON.stringify({
                userId,
                status: 'processing',
                startTime: Date.now(),
                originalName: req.file.originalname,
                size: req.file.size
            }));

            res.json({
                success: true,
                jobId: job.id,
                message: 'فایل در حال پردازش...',
                status: 'processing',
                progress: 0
            });

        } catch (error) {
            logger.error('Upload error:', error);
            if (req.file?.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (e) {}
            }
            res.status(500).json({ success: false, error: error.message });
        }
    });
});

// ============================================
// دریافت وضعیت پردازش فایل
// ============================================
app.get('/api/upload/status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await queues.mediaQueue.getJob(jobId);
        
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found' });
        }

        const state = await job.getState();
        const progress = job._progress || 0;
        const result = job.returnvalue;
        const failedReason = job.failedReason;

        res.json({
            success: true,
            state,
            progress,
            result: result || null,
            failedReason: failedReason || null,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Upload status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// JWT Authentication
// ============================================
const jwtAuth = jwt({
    secret: JWT_SECRET,
    algorithms: ['HS256', 'RS256'],
    credentialsRequired: false,
    getToken: (req) => {
        if (req.headers.authorization && req.headers.authorization.split(' ')[0] === 'Bearer') {
            return req.headers.authorization.split(' ')[1];
        }
        if (req.headers['x-access-token']) {
            return req.headers['x-access-token'];
        }
        return null;
    }
});

// ============================================
// API کاربر با اعتبارسنجی قوی
// ============================================

// ثبت‌نام با اعتبارسنجی پیشرفته
app.post('/api/user/register', [
    body('name').notEmpty().withMessage('نام الزامی است').isLength({ min: 2, max: 50 }),
    body('email').optional().isEmail().withMessage('ایمیل نامعتبر است'),
    body('password').optional().isLength({ min: 6 }).withMessage('رمز عبور حداقل ۶ کاراکتر')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ 
                success: false, 
                errors: errors.array() 
            });
        }

        const { name, avatar, password, email } = req.body;
        
        // پاک‌سازی و اعتبارسنجی
        const cleanName = xss(name.trim());
        const cleanEmail = email ? xss(email.trim().toLowerCase()) : null;
        
        if (cleanEmail && !validator.isEmail(cleanEmail)) {
            return res.status(400).json({ success: false, error: 'ایمیل نامعتبر است' });
        }

        let id;
        const nameLower = cleanName.toLowerCase();
        if (nameLower === 'milad' || nameLower === 'مدیر سیستم' || nameLower === 'admin') {
            id = 'admin_milad';
        } else {
            id = 'user_' + crypto.randomBytes(32).toString('hex');
        }

        const check = await db.query(id, `SELECT id FROM users WHERE id = $1 OR email = $2`, [id, cleanEmail]);
        if (check.rows.length > 0) {
            return res.status(409).json({ 
                success: false, 
                error: 'این کاربر یا ایمیل قبلاً ثبت شده است' 
            });
        }

        const hashedPassword = password ? await bcrypt.hash(password, 12) : null;
        await db.query(id, `
            INSERT INTO users (id, name, avatar, email, role, is_verified, score, password_hash, created_at) 
            VALUES ($1, $2, $3, $4, $5, 1, $6, $7, CURRENT_TIMESTAMP)
        `, [id, cleanName, avatar || null, cleanEmail, 
            id === 'admin_milad' ? 'admin' : 'user', 
            id === 'admin_milad' ? 999999 : 0, 
            hashedPassword]);

        const channelId = 'channel_' + id;
        await db.query(id, `
            INSERT INTO channels (id, user_id, name, boost_level, created_at) 
            VALUES ($1, $2, $3, 'normal', CURRENT_TIMESTAMP)
        `, [channelId, id, cleanName + ' - کانال']);

        const u = await db.query(id, `SELECT id, name, avatar, score, role, email FROM users WHERE id = $1`, [id]);
        
        // تولید JWT
        const token = jsonwebtoken.sign(
            { userId: id, email: cleanEmail, role: u.rows[0].role },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRY }
        );
        
        await Promise.all([
            redis.del(`profile:${id}:*`),
            redis.del('admin_stats'),
            redis.del('explore:*')
        ]);

        // ارسال ایمیل خوش‌آمدگویی
        if (cleanEmail) {
            await queues.emailQueue.add('sendWelcomeEmail', {
                to: cleanEmail,
                name: cleanName,
                userId: id
            }, { priority: 10 });
        }

        res.json({ 
            success: true, 
            user: u.rows[0],
            token,
            expiresIn: 604800 // 7 روز
        });
    } catch (error) {
        logger.error('Register error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ورود با امنیت بالا
app.post('/api/user/login', [
    body('id').notEmpty().withMessage('شناسه کاربری الزامی است'),
    body('password').notEmpty().withMessage('رمز عبور الزامی است')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ 
                success: false, 
                errors: errors.array() 
            });
        }

        const { id, password } = req.body;

        // محدودیت تلاش برای ورود
        const attemptKey = `login_attempts:${id}`;
        const attempts = await redis.get(attemptKey);
        if (attempts && parseInt(attempts) >= 5) {
            const ttl = await redis.ttl(attemptKey);
            return res.status(429).json({ 
                success: false, 
                error: `تعداد تلاش‌های ناموفق بیش از حد مجاز است، لطفاً ${Math.ceil(ttl / 60)} دقیقه بعد تلاش کنید` 
            });
        }

        const user = await db.query(id, `
            SELECT id, name, avatar, score, role, password_hash, email, is_verified 
            FROM users WHERE id = $1
        `, [id]);

        if (user.rows.length === 0) {
            await redis.incr(attemptKey);
            await redis.expire(attemptKey, 900);
            return res.status(404).json({ success: false, error: 'کاربر یافت نشد' });
        }

        const userData = user.rows[0];
        let valid = false;
        
        if (userData.password_hash) {
            valid = await bcrypt.compare(password, userData.password_hash);
        }

        if (!valid) {
            await redis.incr(attemptKey);
            await redis.expire(attemptKey, 900);
            return res.status(401).json({ success: false, error: 'رمز عبور اشتباه است' });
        }

        // پاک کردن محدودیت پس از ورود موفق
        await redis.del(attemptKey);

        // تولید JWT
        const token = jsonwebtoken.sign(
            { 
                userId: id, 
                email: userData.email, 
                role: userData.role,
                isVerified: userData.is_verified 
            },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRY }
        );

        // ذخیره session در Redis
        await redis.setex(`session:${token}`, 604800, JSON.stringify({
            userId: id,
            loginTime: Date.now(),
            ip: req.ip,
            userAgent: req.headers['user-agent']
        }));

        // لاگ ورود
        logger.info(`User ${id} logged in from ${req.ip}`);

        res.json({ 
            success: true, 
            user: userData,
            token,
            expiresIn: 604800 // 7 روز
        });
    } catch (error) {
        logger.error('Login error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// پروفایل با کش پیشرفته Redis
// ============================================
app.get('/api/profile/:userId', jwtAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        const { viewerId } = req.query;
        
        const cacheKey = `profile:${userId}:${viewerId || 'guest'}:v2`;
        const cached = await redis.get(cacheKey);
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        const u = await db.query(userId, `
            SELECT id, name, avatar, bio, score, is_verified, created_at, email, role
            FROM users WHERE id = $1
        `, [userId]);
        
        if (u.rows.length === 0) return res.status(404).json({ error: 'کاربر یافت نشد' });

        const ch = await db.query(userId, `SELECT * FROM channels WHERE user_id = $1`, [userId]);
        const channel = ch.rows[0];

        const posts = await db.query(userId, `
            SELECT p.*, c.name as channel_name
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC LIMIT 50
        `, [userId]);

        let isFollowing = false;
        if (viewerId && viewerId !== userId) {
            const f = await db.query(userId, `
                SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2
            `, [viewerId, userId]);
            isFollowing = f.rows.length > 0;
        }

        const data = { 
            user: u.rows[0], 
            channel, 
            posts: posts.rows, 
            isFollowing,
            timestamp: Date.now()
        };
        
        await redis.setex(cacheKey, 300, JSON.stringify(data));
        
        res.json(data);
    } catch (error) {
        logger.error('Profile error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// اکسپلور با Pagination و Prefetch
// ============================================
app.get('/api/explore', jwtAuth, async (req, res) => {
    try {
        const { cursor, limit = 20, type = 'all' } = req.query;
        const pageSize = Math.min(parseInt(limit) || 20, 50);

        const cacheKey = `explore:${type}:${cursor || 'first'}:${pageSize}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
            const data = JSON.parse(cached);
            // Prefetch صفحه بعدی
            if (data.nextCursor) {
                const nextKey = `explore:${type}:${data.nextCursor}:${pageSize}`;
                if (!await redis.exists(nextKey)) {
                    setImmediate(() => {
                        fetchExplorePage(type, data.nextCursor, pageSize).catch(() => {});
                    });
                }
            }
            return res.json(data);
        }

        const result = await fetchExplorePage(type, cursor, pageSize);
        
        await redis.setex(cacheKey, 30, JSON.stringify(result));
        
        res.json(result);
    } catch (error) {
        logger.error('Explore error:', error);
        res.status(500).json({ error: error.message });
    }
});

async function fetchExplorePage(type, cursor, pageSize) {
    let query = `
        SELECT 
            u.id as user_id,
            u.name,
            u.avatar,
            u.score,
            u.is_verified,
            c.id as channel_id,
            c.followers_count,
            c.posts_count,
            c.boost_level,
            c.activity_score,
            (
                SELECT json_agg(
                    json_build_object(
                        'id', p.id,
                        'content', p.content,
                        'media_url', p.media_url,
                        'media_type', p.media_type,
                        'likes', p.likes,
                        'comments', p.comments,
                        'views', p.views,
                        'created_at', p.created_at,
                        'is_published', p.is_published
                    ) ORDER BY p.created_at DESC
                )
                FROM posts p
                WHERE p.channel_id = c.id AND p.is_published = 1
                LIMIT 5
            ) as recent_posts
        FROM channels c
        JOIN users u ON u.id = c.user_id
        WHERE c.posts_count > 0
    `;

    if (type === 'video') {
        query += ` AND EXISTS (SELECT 1 FROM posts p WHERE p.channel_id = c.id AND p.media_type = 'video' AND p.is_published = 1)`;
    } else if (type === 'image') {
        query += ` AND EXISTS (SELECT 1 FROM posts p WHERE p.channel_id = c.id AND p.media_type = 'image' AND p.is_published = 1)`;
    }

    const params = [];
    if (cursor) {
        const [activityScore, channelId] = cursor.split('_');
        query += ` AND (c.activity_score < $1 OR (c.activity_score = $1 AND c.id > $2))`;
        params.push(parseInt(activityScore), channelId);
    }

    query += `
        ORDER BY c.activity_score DESC, c.id ASC
        LIMIT $${params.length + 1}
    `;
    params.push(pageSize + 1);

    const result = await db.queryAllShards(query, params);
    
    let items = result.rows.map(row => ({
        ...row,
        recent_posts: row.recent_posts || []
    }));

    let nextCursor = null;
    if (items.length > pageSize) {
        const last = items[items.length - 1];
        nextCursor = `${last.activity_score}_${last.channel_id}`;
        items = items.slice(0, pageSize);
    }

    return { items, nextCursor, timestamp: Date.now() };
}

// ============================================
// پست‌های کانال با کش
// ============================================
app.get('/api/channel/:userId/posts', jwtAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        const { cursor, limit = 20 } = req.query;
        const pageSize = Math.min(parseInt(limit) || 20, 50);
        
        const cacheKey = `channel_posts:${userId}:${cursor || 'first'}:${pageSize}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        let query = `
            SELECT p.*, c.name as channel_name
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 1
        `;
        const params = [userId];

        if (cursor) {
            query += ` AND p.created_at < $2`;
            params.push(cursor);
        }

        query += ` ORDER BY p.created_at DESC LIMIT $${params.length + 1}`;
        params.push(pageSize + 1);

        const result = await db.query(userId, query, params);
        
        let nextCursor = null;
        let posts = result.rows;
        if (posts.length > pageSize) {
            nextCursor = posts[posts.length - 1].created_at;
            posts = posts.slice(0, pageSize);
        }

        const data = { posts, nextCursor };
        await redis.setex(cacheKey, 120, JSON.stringify(data));
        
        res.json(data);
    } catch (error) {
        logger.error('Channel posts error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// لیست چت با کش
// ============================================
app.get('/api/chat/list/:userId', jwtAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const cacheKey = `chat_list:${userId}:v2`;
        const cached = await redis.get(cacheKey);
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        const result = await db.query(userId, `
            SELECT 
                u.id,
                u.name,
                u.avatar,
                u.is_verified,
                (
                    SELECT message FROM messages 
                    WHERE (from_user = u.id AND to_user = $1) OR (from_user = $1 AND to_user = u.id)
                    ORDER BY created_at DESC LIMIT 1
                ) as lastMessage,
                (
                    SELECT media_url FROM messages 
                    WHERE (from_user = u.id AND to_user = $1) OR (from_user = $1 AND to_user = u.id)
                    ORDER BY created_at DESC LIMIT 1
                ) as lastMediaUrl,
                (
                    SELECT media_type FROM messages 
                    WHERE (from_user = u.id AND to_user = $1) OR (from_user = $1 AND to_user = u.id)
                    ORDER BY created_at DESC LIMIT 1
                ) as lastMediaType,
                (
                    SELECT created_at FROM messages 
                    WHERE (from_user = u.id AND to_user = $1) OR (from_user = $1 AND to_user = u.id)
                    ORDER BY created_at DESC LIMIT 1
                ) as lastTime,
                (
                    SELECT COUNT(*) FROM messages 
                    WHERE from_user = u.id AND to_user = $1 AND is_read = 0
                ) as unreadCount
            FROM users u
            WHERE u.id IN (
                SELECT DISTINCT CASE WHEN from_user = $1 THEN to_user ELSE from_user END
                FROM messages
                WHERE from_user = $1 OR to_user = $1
            )
            AND u.id != $1
            ORDER BY lastTime DESC
        `, [userId]);

        await redis.setex(cacheKey, 30, JSON.stringify(result.rows));
        
        res.json(result.rows);
    } catch (error) {
        logger.error('Chat list error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API چت با قابلیت ارسال فایل
// ============================================
app.post('/api/chat/send', [
    jwtAuth,
    body('to').notEmpty().withMessage('گیرنده الزامی است'),
    body('message').optional().isLength({ max: 4000 }).withMessage('پیام حداکثر ۴۰۰۰ کاراکتر')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ 
                success: false, 
                errors: errors.array() 
            });
        }

        const { from, to, message, mediaUrl, mediaType, fileName, fileSize } = req.body;
        const id = uuidv4();
        
        if (!from || !to) {
            return res.status(400).json({ success: false, error: 'اطلاعات ناقص است' });
        }

        // بررسی مسدودیت
        const isBlocked = await db.isBlocked(from, to);
        if (isBlocked) {
            return res.status(403).json({ 
                success: false, 
                error: 'امکان ارسال پیام به این کاربر وجود ندارد' 
            });
        }

        const trimmed = message ? xss(message.trim()) : '';

        await db.query(from, `
            INSERT INTO messages (id, from_user, to_user, message, media_url, media_type, file_name, file_size, created_at) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
        `, [id, from, to, trimmed, mediaUrl || null, mediaType || null, fileName || null, fileSize || null]);

        await Promise.all([
            redis.del(`chat_list:${from}`),
            redis.del(`chat_list:${to}`)
        ]);

        // ارسال از طریق WebSocket
        io.to(`user_${to}`).emit('new_message', { 
            id,
            from, 
            message: trimmed,
            mediaUrl,
            mediaType,
            fileName,
            fileSize,
            created_at: new Date().toISOString()
        });

        // ارسال نوتیفیکیشن
        await queues.notificationQueue.add('sendNotification', {
            userId: to,
            title: 'پیام جدید',
            message: trimmed || 'یک فایل دریافت کردید',
            type: 'message'
        }, { priority: 5 });

        res.json({ success: true, id });
    } catch (error) {
        logger.error('Chat send error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// تاریخچه چت با pagination
// ============================================
app.get('/api/chat/history/:userId/:targetId', jwtAuth, async (req, res) => {
    try {
        const { userId, targetId } = req.params;
        const { limit = 50, before } = req.query;
        const pageSize = Math.min(parseInt(limit) || 50, 100);

        let query = `
            SELECT * FROM messages 
            WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
        `;
        const params = [userId, targetId];

        if (before) {
            query += ` AND created_at < $3`;
            params.push(before);
        }

        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(pageSize + 1);

        const result = await db.query(userId, query, params);
        
        let nextCursor = null;
        let messages = result.rows.reverse();
        if (messages.length > pageSize) {
            nextCursor = messages[0]?.created_at;
            messages = messages.slice(1);
        }

        // علامت‌گذاری به عنوان خوانده شده
        await db.query(userId, `
            UPDATE messages SET is_read = 1 
            WHERE from_user = $1 AND to_user = $2 AND is_read = 0
        `, [targetId, userId]);

        await Promise.all([
            redis.del(`chat_list:${userId}`),
            redis.del(`chat_list:${targetId}`)
        ]);

        res.json({ messages, nextCursor });
    } catch (error) {
        logger.error('Chat history error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API دستیار با قابلیت چت خصوصی و حافظه
// ============================================
app.post('/api/assistant/chat/:targetUserId', jwtAuth, async (req, res) => {
    try {
        const { targetUserId } = req.params;
        const { message, userId } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ success: false, error: 'پیام الزامی است' });
        }

        // دریافت اطلاعات دستیار کاربر
        const assistant = new IntelligentAssistant(targetUserId, db);
        const reply = await assistant.autoReply(message);

        // ذخیره تاریخچه چت با دستیار
        if (userId) {
            const id = uuidv4();
            await db.query(userId, `
                INSERT INTO messages (id, from_user, to_user, message, created_at) 
                VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            `, [id, userId, `assistant_${targetUserId}`, `🤖 ${reply || 'دستیار هنوز برای این موضوع آموزش ندیده'}`]);
            
            // ذخیره سوال کاربر
            await db.query(userId, `
                INSERT INTO assistant_conversations (id, user_id, assistant_id, question, answer, created_at)
                VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            `, [uuidv4(), userId, targetUserId, message.trim(), reply || '']);
        }

        // ثبت فعالیت
        if (reply) {
            const assistantObj = new IntelligentAssistant(targetUserId, db);
            await assistantObj.updateUserActivity('assistant_chat');
        }

        res.json({ 
            reply: reply || 'دستیار هنوز برای این موضوع آموزش ندیده 🤖',
            success: true,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Assistant chat error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// دریافت تاریخچه چت با دستیار
// ============================================
app.get('/api/assistant/history/:userId/:assistantId', jwtAuth, async (req, res) => {
    try {
        const { userId, assistantId } = req.params;
        const { limit = 50 } = req.query;

        const result = await db.query(userId, `
            SELECT * FROM assistant_conversations 
            WHERE user_id = $1 AND assistant_id = $2
            ORDER BY created_at DESC LIMIT $3
        `, [userId, assistantId, parseInt(limit) || 50]);

        res.json(result.rows.reverse());
    } catch (error) {
        logger.error('Assistant history error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ادامه API‌های قبلی با امنیت بالا
// ============================================

// ============================================
// فالو / آنفالو
// ============================================
app.post('/api/follow', jwtAuth, async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        if (!followerId || !followingId) {
            return res.status(400).json({ success: false, error: 'اطلاعات ناقص است' });
        }

        if (followerId === followingId) {
            return res.status(400).json({ success: false, error: 'نمی‌توانید خودتان را فالو کنید' });
        }

        const result = await db.followUser(followerId, followingId);
        if (result.success && !result.alreadyFollowing) {
            const assistant = new IntelligentAssistant(followerId, db);
            await assistant.updateUserActivity('follow');
            await Promise.all([
                invalidateUserCache(followerId),
                invalidateUserCache(followingId),
                redis.del('explore:*'),
                redis.del('admin_stats')
            ]);

            // ارسال نوتیفیکیشن
            await queues.notificationQueue.add('sendNotification', {
                userId: followingId,
                title: 'فالو جدید',
                message: `${followerId} شما را فالو کرد`,
                type: 'follow'
            }, { priority: 3 });
        }

        res.json(result);
    } catch (error) {
        logger.error('Follow error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/unfollow', jwtAuth, async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        await db.unfollowUser(followerId, followingId);
        await Promise.all([
            invalidateUserCache(followerId),
            invalidateUserCache(followingId),
            redis.del('explore:*'),
            redis.del('admin_stats')
        ]);
        res.json({ success: true });
    } catch (error) {
        logger.error('Unfollow error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// پست‌ها با امنیت بالا
// ============================================
app.post('/api/post/create', jwtAuth, async (req, res) => {
    try {
        const { userId, content, mediaUrl, mediaType, scheduledTime } = req.body;
        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, error: 'متن پست الزامی است' });
        }

        // پاک‌سازی محتوا
        const cleanContent = xss(content.trim(), {
            whiteList: {
                b: [], i: [], em: [], strong: [], br: [], p: [],
                a: ['href', 'target', 'rel'],
                img: ['src', 'alt', 'width', 'height'],
                blockquote: [], code: [], pre: []
            },
            stripIgnoreTag: true,
            stripIgnoreTagBody: ['script', 'style']
        });

        const userRow = await db.query(userId, `SELECT role, restricted FROM users WHERE id = $1`, [userId]);
        const u = userRow.rows[0];
        if (u?.role === 'banned') {
            return res.status(403).json({ success: false, error: 'حساب شما مسدود شده است' });
        }
        if (u?.restricted) {
            return res.status(403).json({ success: false, error: 'حساب شما محدود شده و امکان انتشار پست ندارید' });
        }

        const channel = await db.query(userId, `SELECT id FROM channels WHERE user_id = $1`, [userId]);
        if (channel.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });
        }

        const postId = uuidv4();
        const type = mediaType || 'none';
        const isPublished = scheduledTime ? 0 : 1;
        const scheduledTimeStr = scheduledTime || null;
        
        await db.query(userId, `
            INSERT INTO posts (id, channel_id, content, media_url, media_type, is_published, scheduled_time, published_at, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
        `, [postId, channel.rows[0].id, cleanContent, mediaUrl || null, type, isPublished, scheduledTimeStr, isPublished ? 'CURRENT_TIMESTAMP' : null]);

        if (isPublished) {
            await db.query(userId, `UPDATE channels SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`, [userId]);
        }

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('post');
        const boost = await assistant.boostVisibility();

        await Promise.all([
            invalidateUserCache(userId),
            redis.del(`channel_posts:${userId}`),
            redis.del('explore:*'),
            redis.del('admin_stats')
        ]);

        res.json({ 
            success: true, 
            postId, 
            boost,
            published: isPublished === 1,
            scheduledTime: scheduledTimeStr
        });
    } catch (error) {
        logger.error('Post create error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/post/:postId/view', jwtAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId } = req.body;
        
        // جلوگیری از شمارش تکراری
        const viewKey = `view:${postId}:${userId}`;
        const exists = await redis.get(viewKey);
        if (!exists) {
            await db.query(postId, `UPDATE posts SET views = views + 1 WHERE id = $1`, [postId]);
            await redis.setex(viewKey, 3600, '1');
        }
        res.json({ success: true });
    } catch (error) {
        logger.error('View error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// لایک
// ============================================
app.post('/api/post/:postId/like', jwtAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ success: false, error: 'کاربر نامعتبر' });

        const result = await db.toggleLike(postId, userId);

        if (result.liked) {
            const assistant = new IntelligentAssistant(userId, db);
            await assistant.updateUserActivity('like');
        }

        await Promise.all([
            redis.del(`channel_posts:*`),
            redis.del('explore:*'),
            redis.del('admin_stats')
        ]);
        
        res.json(result);
    } catch (error) {
        logger.error('Like error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// کامنت
// ============================================
app.post('/api/post/:postId/comment', jwtAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId, text } = req.body;
        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, error: 'متن کامنت الزامی است' });
        }

        const cleanText = xss(text.trim(), {
            whiteList: {
                b: [], i: [], em: [], strong: []
            },
            stripIgnoreTag: true
        });

        const id = uuidv4();
        await db.query(userId, `
            INSERT INTO post_comments (id, post_id, user_id, text, created_at) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `, [id, postId, userId, cleanText]);
        await db.query(postId, `UPDATE posts SET comments = comments + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [postId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('comment');

        const u = await db.query(userId, `SELECT name, avatar FROM users WHERE id = $1`, [userId]);
        
        await Promise.all([
            redis.del(`channel_posts:*`),
            redis.del('explore:*'),
            redis.del('admin_stats')
        ]);
        
        res.json({ 
            success: true, 
            comment: { 
                id, 
                userId, 
                text: cleanText, 
                name: u.rows[0]?.name, 
                avatar: u.rows[0]?.avatar,
                created_at: new Date().toISOString()
            } 
        });
    } catch (error) {
        logger.error('Comment error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/post/:postId/comments', jwtAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        const { cursor, limit = 20 } = req.query;
        const pageSize = Math.min(parseInt(limit) || 20, 50);

        let query = `
            SELECT c.*, u.name, u.avatar FROM post_comments c
            JOIN users u ON u.id = c.user_id
            WHERE c.post_id = $1
        `;
        const params = [postId];

        if (cursor) {
            query += ` AND c.created_at < $2`;
            params.push(cursor);
        }

        query += ` ORDER BY c.created_at DESC LIMIT $${params.length + 1}`;
        params.push(pageSize + 1);

        const result = await db.query(postId, query, params);
        
        let nextCursor = null;
        let comments = result.rows;
        if (comments.length > pageSize) {
            nextCursor = comments[comments.length - 1].created_at;
            comments = comments.slice(0, pageSize);
        }

        res.json({ comments: comments.reverse(), nextCursor });
    } catch (error) {
        logger.error('Comments error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// دستیار هوشمند
// ============================================
app.post('/api/assistant/train', jwtAuth, async (req, res) => {
    try {
        const { userId, question, answer } = req.body;
        const id = uuidv4();

        const cleanQuestion = xss(question.trim());
        const cleanAnswer = xss(answer.trim(), {
            whiteList: {
                b: [], i: [], em: [], strong: [], br: []
            }
        });

        await db.query(userId, `
            INSERT INTO assistant_training (id, user_id, type, question, answer, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [id, userId, 'qa', cleanQuestion, cleanAnswer]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();

        await invalidateUserCache(userId);

        res.json({ success: true, message: 'آموزش با موفقیت ثبت شد', boost });
    } catch (error) {
        logger.error('Train error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/assistant/keyword', jwtAuth, async (req, res) => {
    try {
        const { userId, keyword, response } = req.body;
        const id = uuidv4();

        const cleanKeyword = xss(keyword.trim().toLowerCase());
        const cleanResponse = xss(response.trim());

        await db.query(userId, `
            INSERT INTO assistant_training (id, user_id, type, keyword, response, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [id, userId, 'keyword', cleanKeyword, cleanResponse]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();

        await invalidateUserCache(userId);

        res.json({ success: true, message: 'کلمه کلیدی با موفقیت ثبت شد', boost });
    } catch (error) {
        logger.error('Keyword error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/assistant/schedule', jwtAuth, async (req, res) => {
    try {
        const { userId, posts } = req.body;
        
        if (!posts || !Array.isArray(posts) || posts.length === 0) {
            return res.status(400).json({ success: false, error: 'لیست پست‌ها نامعتبر است' });
        }

        const channel = await db.query(userId, `SELECT id FROM channels WHERE user_id = $1`, [userId]);
        if (channel.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });
        }

        const assistant = new IntelligentAssistant(userId, db);
        const scheduled = await assistant.schedulePosts(posts);

        await invalidateUserCache(userId);
        await redis.del('explore:*');

        res.json({ 
            success: true, 
            message: `${posts.length} پست با موفقیت زمان‌بندی شد`, 
            posts: scheduled 
        });
    } catch (error) {
        logger.error('Schedule error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/assistant/:userId', jwtAuth, async (req, res) => {
    try {
        const { userId } = req.params;

        const qa = await db.query(userId, `
            SELECT question, answer, created_at FROM assistant_training 
            WHERE user_id = $1 AND type = 'qa' ORDER BY created_at DESC LIMIT 50
        `, [userId]);

        const keywords = await db.query(userId, `
            SELECT keyword, response, created_at FROM assistant_training 
            WHERE user_id = $1 AND type = 'keyword' ORDER BY created_at DESC LIMIT 50
        `, [userId]);

        const posts = await db.query(userId, `
            SELECT p.*, c.name as channel_name 
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 0
            ORDER BY p.scheduled_time ASC LIMIT 100
        `, [userId]);

        const assistant = new IntelligentAssistant(userId, db);
        const stats = await assistant.getStats();

        res.json({ qa: qa.rows, keywords: keywords.rows, posts: posts.rows, stats });
    } catch (error) {
        logger.error('Assistant error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// جستجو
// ============================================
app.get('/api/search', jwtAuth, async (req, res) => {
    try {
        const { q, limit = 20 } = req.query;
        if (!q || q.length < 2) return res.json([]);
        
        const cleanQ = xss(q.trim());
        const pageSize = Math.min(parseInt(limit) || 20, 50);
        
        const result = await db.queryAllShards(`
            SELECT id, name, avatar, 'user' as type, is_verified, score FROM users 
            WHERE name ILIKE $1 AND id != 'admin_milad'
            UNION
            SELECT id, name, NULL as avatar, 'channel' as type, false as is_verified, followers_count as score FROM channels 
            WHERE name ILIKE $1
            LIMIT $2
        `, [`%${cleanQ}%`, pageSize]);
        res.json(result.rows);
    } catch (error) {
        logger.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// مسدود کردن کاربر
// ============================================
app.post('/api/user/block', jwtAuth, async (req, res) => {
    try {
        const { blockerId, blockedId } = req.body;
        if (!blockerId || !blockedId) return res.status(400).json({ success: false, error: 'اطلاعات ناقص است' });
        
        if (blockerId === blockedId) {
            return res.status(400).json({ success: false, error: 'نمی‌توانید خودتان را مسدود کنید' });
        }

        const result = await db.blockUser(blockerId, blockedId);
        await Promise.all([
            invalidateUserCache(blockerId),
            invalidateUserCache(blockedId),
            redis.del(`chat_list:${blockerId}`),
            redis.del(`chat_list:${blockedId}`)
        ]);
        
        res.json(result);
    } catch (error) {
        logger.error('Block error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/unblock', jwtAuth, async (req, res) => {
    try {
        const { blockerId, blockedId } = req.body;
        const result = await db.unblockUser(blockerId, blockedId);
        await Promise.all([
            invalidateUserCache(blockerId),
            invalidateUserCache(blockedId),
            redis.del(`chat_list:${blockerId}`),
            redis.del(`chat_list:${blockedId}`)
        ]);
        res.json(result);
    } catch (error) {
        logger.error('Unblock error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/user/:userId/is-blocked/:targetId', jwtAuth, async (req, res) => {
    try {
        const { userId, targetId } = req.params;
        res.json({ blocked: await db.isBlocked(userId, targetId) });
    } catch (error) {
        logger.error('Is blocked error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// گزارش‌ها
// ============================================
app.post('/api/report', jwtAuth, async (req, res) => {
    try {
        const { reporterId, targetId, targetType, reason } = req.body;
        if (!reporterId || !targetId || !targetType || !reason || !reason.trim()) {
            return res.status(400).json({ success: false, error: 'اطلاعات گزارش ناقص است' });
        }
        if (!['user', 'post', 'comment'].includes(targetType)) {
            return res.status(400).json({ success: false, error: 'نوع گزارش نامعتبر است' });
        }

        const cleanReason = xss(reason.trim().substring(0, 500));
        const id = uuidv4();
        
        await db.query(null, `
            INSERT INTO reports (id, reporter_id, target_id, target_type, reason, status, created_at)
            VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP)
        `, [id, reporterId, targetId, targetType, cleanReason]);

        // ارسال نوتیفیکیشن به ادمین
        await queues.notificationQueue.add('sendNotification', {
            userId: 'admin_milad',
            title: 'گزارش جدید',
            message: `گزارش جدید از ${reporterId} برای ${targetType}: ${cleanReason.substring(0, 50)}...`,
            type: 'report'
        }, { priority: 1 });

        await redis.del('admin_stats');

        res.json({ success: true, reportId: id });
    } catch (error) {
        logger.error('Report error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// پنل مدیریت با امنیت بالا
// ============================================
function isAdmin(req, res, next) {
    const userId = req.headers.userid || req.body.userId || req.auth?.userId;
    if (userId === 'admin_milad') {
        return next();
    }
    res.status(403).json({ error: 'دسترسی غیرمجاز - فقط ادمین' });
}

app.get('/api/admin/users', isAdmin, jwtAuth, async (req, res) => {
    try {
        const { limit = 100, offset = 0 } = req.query;
        const users = await db.queryAllShards(`
            SELECT u.*, c.followers_count, c.posts_count 
            FROM users u
            LEFT JOIN channels c ON u.id = c.user_id
            ORDER BY u.created_at DESC
            LIMIT $1 OFFSET $2
        `, [parseInt(limit), parseInt(offset)]);
        res.json(users.rows);
    } catch (error) {
        logger.error('Admin users error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/user/:action', isAdmin, jwtAuth, async (req, res) => {
    try {
        const { action } = req.params;
        const { userId } = req.body;
        
        const actions = {
            verify: `UPDATE users SET is_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            unverify: `UPDATE users SET is_verified = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            ban: `UPDATE users SET role = 'banned', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            unban: `UPDATE users SET role = 'user', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            restrict: `UPDATE users SET restricted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            unrestrict: `UPDATE users SET restricted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            delete: `DELETE FROM users WHERE id = $1 AND role != 'admin'`
        };
        
        if (!actions[action]) return res.status(400).json({ error: 'عملیات نامعتبر' });
        
        await db.query(null, actions[action], [userId]);
        await Promise.all([
            invalidateUserCache(userId),
            redis.del('admin_stats'),
            redis.del('explore:*')
        ]);

        // لاگ عملیات
        logger.info(`Admin ${req.auth?.userId} performed ${action} on user ${userId}`);

        res.json({ success: true });
    } catch (error) {
        logger.error('Admin user action error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/posts', isAdmin, jwtAuth, async (req, res) => {
    try {
        const { limit = 100, offset = 0 } = req.query;
        const posts = await db.queryAllShards(`
            SELECT p.*, u.name as user_name, c.name as channel_name
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            ORDER BY p.created_at DESC
            LIMIT $1 OFFSET $2
        `, [parseInt(limit), parseInt(offset)]);
        res.json(posts.rows);
    } catch (error) {
        logger.error('Admin posts error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/post/delete', isAdmin, jwtAuth, async (req, res) => {
    try {
        const { postId } = req.body;
        await db.query(null, `DELETE FROM posts WHERE id = $1`, [postId]);
        
        await Promise.all([
            invalidateUserCache('*'),
            redis.del('explore:*'),
            redis.del('admin_stats')
        ]);

        logger.info(`Admin ${req.auth?.userId} deleted post ${postId}`);

        res.json({ success: true });
    } catch (error) {
        logger.error('Admin post delete error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/channels', isAdmin, jwtAuth, async (req, res) => {
    try {
        const { limit = 100, offset = 0 } = req.query;
        const channels = await db.queryAllShards(`
            SELECT c.*, u.name as user_name, u.avatar
            FROM channels c
            JOIN users u ON c.user_id = u.id
            ORDER BY c.followers_count DESC
            LIMIT $1 OFFSET $2
        `, [parseInt(limit), parseInt(offset)]);
        res.json(channels.rows);
    } catch (error) {
        logger.error('Admin channels error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/reports', isAdmin, jwtAuth, async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const { limit = 200, offset = 0 } = req.query;
        const reports = await db.queryAllShards(`
            SELECT * FROM reports WHERE status = $1 
            ORDER BY created_at DESC 
            LIMIT $2 OFFSET $3
        `, [status, parseInt(limit), parseInt(offset)]);
        res.json(reports.rows);
    } catch (error) {
        logger.error('Admin reports error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/report/:action', isAdmin, jwtAuth, async (req, res) => {
    try {
        const { action } = req.params;
        const { reportId } = req.body;
        if (!['resolve', 'dismiss'].includes(action)) {
            return res.status(400).json({ error: 'عملیات نامعتبر' });
        }
        const status = action === 'resolve' ? 'resolved' : 'dismissed';
        await db.query(null, `
            UPDATE reports SET status = $1, resolved_at = CURRENT_TIMESTAMP, resolved_by = $2 WHERE id = $3
        `, [status, req.auth?.userId, reportId]);
        
        await redis.del('admin_stats');
        logger.info(`Admin ${req.auth?.userId} ${action}ed report ${reportId}`);
        
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin report action error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/broadcast', isAdmin, jwtAuth, async (req, res) => {
    try {
        const { message, title } = req.body;
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'متن پیام الزامی است' });
        }

        const cleanMessage = xss(message.trim());
        const cleanTitle = xss(title?.trim() || 'اعلان سیستمی');

        let totalSent = 0;
        const users = await db.queryAllShards(`SELECT id FROM users`);
        
        // ارسال همگانی از طریق صف
        const jobs = [];
        for (const user of users.rows) {
            jobs.push(
                queues.notificationQueue.add('sendNotification', {
                    userId: user.id,
                    title: cleanTitle,
                    message: cleanMessage,
                    type: 'broadcast'
                }, { priority: 10 })
            );
            totalSent++;
        }

        await Promise.all(jobs);

        logger.info(`Admin ${req.auth?.userId} broadcasted to ${totalSent} users`);

        res.json({ 
            success: true, 
            message: `پیام به ${totalSent} کاربر ارسال شد` 
        });
    } catch (error) {
        logger.error('Broadcast error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// آمار با کش طولانی‌تر
// ============================================
app.get('/api/admin/stats', isAdmin, jwtAuth, async (req, res) => {
    try {
        const cacheKey = 'admin_stats:v2';
        const cached = await redis.get(cacheKey);
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        const [
            users, posts, channels, messages, follows, comments, trainings, reports, uploads
        ] = await Promise.all([
            db.queryAllShards(`SELECT COUNT(*) as total FROM users`),
            db.queryAllShards(`SELECT COUNT(*) as total FROM posts WHERE is_published = 1`),
            db.queryAllShards(`SELECT COUNT(*) as total FROM channels`),
            db.queryAllShards(`SELECT COUNT(*) as total FROM messages`),
            db.queryAllShards(`SELECT COUNT(*) as total FROM follows`),
            db.queryAllShards(`SELECT COUNT(*) as total FROM post_comments`),
            db.queryAllShards(`SELECT COUNT(*) as total FROM assistant_training`),
            db.queryAllShards(`SELECT COUNT(*) as total FROM reports WHERE status = 'pending'`),
            db.queryAllShards(`SELECT COUNT(*) as total FROM user_uploads`)
        ]);

        // آمار فعالیت امروز
        const today = new Date().toISOString().split('T')[0];
        const todayStats = await db.queryAllShards(`
            SELECT 
                COUNT(*) as today_posts,
                COUNT(DISTINCT user_id) as today_active_users
            FROM posts 
            WHERE DATE(created_at) = $1 AND is_published = 1
        `, [today]);

        const stats = {
            users: users.rows[0]?.total || 0,
            posts: posts.rows[0]?.total || 0,
            channels: channels.rows[0]?.total || 0,
            messages: messages.rows[0]?.total || 0,
            follows: follows.rows[0]?.total || 0,
            comments: comments.rows[0]?.total || 0,
            trainings: trainings.rows[0]?.total || 0,
            pendingReports: reports.rows[0]?.total || 0,
            uploads: uploads.rows[0]?.total || 0,
            todayPosts: todayStats.rows[0]?.today_posts || 0,
            todayActiveUsers: todayStats.rows[0]?.today_active_users || 0,
            timestamp: Date.now()
        };

        await redis.setex(cacheKey, 600, JSON.stringify(stats));
        
        res.json(stats);
    } catch (error) {
        logger.error('Stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// تابع پاک کردن کش
// ============================================
async function invalidateUserCache(userId) {
    const patterns = [
        `profile:${userId}:*`,
        `channel_posts:${userId}:*`,
        `chat_list:${userId}:*`,
        'admin_stats:*',
        'explore:*'
    ];
    for (const pattern of patterns) {
        const keys = await redis.keys(pattern);
        if (keys.length) {
            await redis.del(keys);
        }
    }
}

// ============================================
// WebSocket با محدودیت نرخ پیشرفته و مقیاس‌پذیری
// ============================================
const userRateLimits = new Map();
const wsClients = new Map();

io.on('connection', (socket) => {
    logger.info('🔌 New WebSocket client connected:', socket.id);
    let msgTimestamps = [];
    let userId = null;
    let rateLimiter = null;

    // ذخیره اطلاعات کلاینت
    wsClients.set(socket.id, {
        socket,
        connectedAt: Date.now(),
        ip: socket.handshake.address,
        userAgent: socket.handshake.headers['user-agent']
    });

    socket.on('join', async (data) => {
        userId = data;
        if (!userId) return;
        socket.data.userId = userId;
        socket.join(`user_${userId}`);
        socket.join('all_users');
        
        // تنظیم محدودیت نرخ برای این کاربر
        rateLimiter = new RateLimiterRedis({
            storeClient: redis,
            keyPrefix: `ws_ratelimit:${userId}`,
            points: 30,
            duration: 10,
            blockDuration: 60,
            inmemoryBlockOnConsumed: 50
        });
        
        logger.info(`User ${userId} joined WebSocket room`);
    });

    socket.on('private_message', async (data) => {
        const { from, to, message, mediaUrl, mediaType, fileName, fileSize, timestamp } = data || {};

        if (!from || !to) {
            return io.to(`user_${from}`).emit('message_sent', { 
                success: false, 
                error: 'اطلاعات ناقص است', 
                timestamp 
            });
        }

        // محدودیت نرخ
        try {
            if (rateLimiter) {
                await rateLimiter.consume(from);
            }
        } catch (err) {
            return io.to(`user_${from}`).emit('message_sent', { 
                success: false, 
                error: 'خیلی سریع پیام می‌فرستی، کمی صبر کن',
                retryAfter: Math.ceil(err.msBeforeNext / 1000) || 60,
                timestamp 
            });
        }

        // اعتبارسنجی پیام
        const cleanMessage = message ? xss(message.trim()) : '';

        if (cleanMessage && cleanMessage.length > 4000) {
            return io.to(`user_${from}`).emit('message_sent', { 
                success: false, 
                error: 'پیام خیلی طولانیه', 
                timestamp 
            });
        }

        // بررسی مسدودیت
        const isBlocked = await db.isBlocked(from, to);
        if (isBlocked) {
            return io.to(`user_${from}`).emit('message_sent', { 
                success: false, 
                error: 'امکان ارسال پیام به این کاربر وجود ندارد', 
                timestamp 
            });
        }

        try {
            const id = uuidv4();
            await db.query(from, `
                INSERT INTO messages (id, from_user, to_user, message, media_url, media_type, file_name, file_size, created_at) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
            `, [id, from, to, cleanMessage || '', mediaUrl || null, mediaType || null, fileName || null, fileSize || null]);

            // ارسال به گیرنده
            io.to(`user_${to}`).emit('new_message', { 
                id,
                from, 
                message: cleanMessage,
                mediaUrl: mediaUrl || null,
                mediaType: mediaType || null,
                fileName: fileName || null,
                fileSize: fileSize || null,
                timestamp,
                created_at: new Date().toISOString()
            });
            
            // تأیید ارسال به فرستنده
            io.to(`user_${from}`).emit('message_sent', { 
                success: true, 
                timestamp,
                id 
            });

            // پاک کردن کش چت‌ها
            await Promise.all([
                redis.del(`chat_list:${from}`),
                redis.del(`chat_list:${to}`)
            ]);

            // ارسال نوتیفیکیشن
            await queues.notificationQueue.add('sendNotification', {
                userId: to,
                title: 'پیام جدید',
                message: cleanMessage || 'یک فایل دریافت کردید',
                type: 'message'
            }, { priority: 5 });

        } catch (e) {
            logger.error('Save message error:', e);
            io.to(`user_${from}`).emit('message_sent', { 
                success: false, 
                error: 'ذخیره پیام ناموفق بود', 
                timestamp 
            });
        }
    });

    socket.on('typing', (data) => {
        const { from, to } = data || {};
        if (!from || !to) return;
        io.to(`user_${to}`).emit('user_typing', { from });
    });

    socket.on('read_messages', async (data) => {
        const { userId, fromUser } = data || {};
        if (!userId || !fromUser) return;
        try {
            await db.query(userId, `
                UPDATE messages SET is_read = 1 
                WHERE from_user = $1 AND to_user = $2 AND is_read = 0
            `, [fromUser, userId]);
            await Promise.all([
                redis.del(`chat_list:${userId}`),
                redis.del(`chat_list:${fromUser}`)
            ]);
        } catch (e) {
            logger.error('Read messages error:', e);
        }
    });

    socket.on('disconnect', () => {
        if (userId) {
            logger.info(`User ${userId} disconnected from WebSocket`);
        }
        wsClients.delete(socket.id);
        logger.info('🔌 WebSocket client disconnected:', socket.id);
    });
});

// ============================================
// سلامت و مانیتورینگ
// ============================================
app.get('/health', async (req, res) => {
    try {
        const queueCounts = {
            media: await queues.mediaQueue.count(),
            notifications: await queues.notificationQueue.count(),
            emails: await queues.emailQueue.count(),
            analytics: await queues.analyticsQueue.count(),
            reports: await queues.reportQueue?.count() || 0
        };

        const stats = {
            status: 'ok',
            pid: process.pid,
            uptime: process.uptime(),
            memory: {
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
                heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
                heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB',
                external: Math.round(process.memoryUsage().external / 1024 / 1024) + 'MB'
            },
            shards: db.shardCount,
            redis: await redis.ping().then(() => 'connected').catch(() => 'disconnected'),
            queues: queueCounts,
            wsConnections: wsClients.size,
            timestamp: new Date().toISOString()
        };
        res.json(stats);
    } catch (error) {
        logger.error('Health check error:', error);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// ============================================
// Metrics برای Prometheus
// ============================================
app.get('/metrics', async (req, res) => {
    try {
        const mem = process.memoryUsage();
        const queueCounts = {
            media: await queues.mediaQueue.count(),
            notifications: await queues.notificationQueue.count(),
            emails: await queues.emailQueue.count()
        };

        const metrics = [
            `# HELP process_cpu_usage CPU usage`,
            `# TYPE process_cpu_usage gauge`,
            `process_cpu_usage ${process.cpuUsage().user / 1000000}`,
            `# HELP process_memory_rss Memory RSS in bytes`,
            `# TYPE process_memory_rss gauge`,
            `process_memory_rss ${mem.rss}`,
            `# HELP process_memory_heap_used Heap used in bytes`,
            `# TYPE process_memory_heap_used gauge`,
            `process_memory_heap_used ${mem.heapUsed}`,
            `# HELP process_uptime_seconds Uptime in seconds`,
            `# TYPE process_uptime_seconds gauge`,
            `process_uptime_seconds ${process.uptime()}`,
            `# HELP websocket_connections WebSocket connections`,
            `# TYPE websocket_connections gauge`,
            `websocket_connections ${wsClients.size}`,
            `# HELP queue_size Queue size`,
            `# TYPE queue_size gauge`,
            `queue_size{name="media"} ${queueCounts.media}`,
            `queue_size{name="notifications"} ${queueCounts.notifications}`,
            `queue_size{name="emails"} ${queueCounts.emails}`,
            `# HELP shard_count Number of database shards`,
            `# TYPE shard_count gauge`,
            `shard_count ${db.shardCount}`
        ];

        res.set('Content-Type', 'text/plain');
        res.send(metrics.join('\n'));
    } catch (error) {
        logger.error('Metrics error:', error);
        res.status(500).send('Error generating metrics');
    }
});

// ============================================
// راه‌اندازی سرور
// ============================================
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await db.initTables();
        logger.info('✅ Database ready with ' + db.shardCount + ' shards');

        server.listen(PORT, () => {
            logger.info(`🚀 Server running on port ${PORT} (pid ${process.pid})`);
            logger.info(`📍 http://localhost:${PORT}`);
            logger.info(`📊 Mode: ${process.env.NODE_ENV || 'development'} | Shards: ${db.shardCount}`);
            logger.info(`🔐 Security: ${Object.keys(helmet).length} headers active`);
            logger.info(`📦 Queues: Media, Notification, Email, Analytics`);
            logger.info(`💾 Redis: ${redisUrl}`);
        });

        // مانیتورینگ پیشرفته سیستم
        setInterval(async () => {
            try {
                const mem = process.memoryUsage();
                const queueCounts = {
                    media: await queues.mediaQueue.count(),
                    notifications: await queues.notificationQueue.count(),
                    emails: await queues.emailQueue.count(),
                    analytics: await queues.analyticsQueue.count()
                };
                logger.info('System stats:', {
                    memory: {
                        rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
                        heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
                        heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
                        external: Math.round(mem.external / 1024 / 1024) + 'MB'
                    },
                    queues: queueCounts,
                    shards: db.shardCount,
                    wsConnections: wsClients.size,
                    uptime: Math.round(process.uptime()) + 's'
                });
            } catch (e) {
                // Silently fail
            }
        }, 30000);

    } catch (error) {
        logger.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// ============================================
// انتشار دوره‌ای پست‌های زمان‌بندی‌شده
// ============================================
async function publishDueScheduledPosts() {
    try {
        const now = new Date().toISOString();
        const due = await db.queryAllShards(`
            SELECT p.id, p.channel_id, c.user_id 
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE p.is_published = 0 
            AND p.scheduled_time IS NOT NULL 
            AND p.scheduled_time <= $1
            LIMIT 500
        `, [now]);

        if (due.rows.length === 0) return;

        let published = 0;
        for (const row of due.rows) {
            try {
                const claim = await db.query(row.id, `
                    UPDATE posts 
                    SET is_published = 1, 
                        published_at = CURRENT_TIMESTAMP, 
                        updated_at = CURRENT_TIMESTAMP 
                    WHERE id = $1 AND is_published = 0
                    RETURNING id
                `, [row.id]);
                
                if (!claim.rowCount) continue;

                await db.query(row.user_id, `
                    UPDATE channels 
                    SET posts_count = posts_count + 1, 
                        updated_at = CURRENT_TIMESTAMP 
                    WHERE id = $1
                `, [row.channel_id]);

                await Promise.all([
                    invalidateUserCache(row.user_id),
                    redis.del('explore:*')
                ]);

                published++;

            } catch (e) {
                logger.error('Error publishing scheduled post:', e);
            }
        }
        
        if (published > 0) {
            logger.info(`📅 ${published} scheduled posts published`);
        }
    } catch (e) {
        logger.error('Error checking scheduled posts:', e);
    }
}
setInterval(publishDueScheduledPosts, 60 * 1000);
publishDueScheduledPosts();

// ============================================
// مدیریت خطا
// ============================================
process.on('uncaughtException', (err) => {
    logger.error('💥 Uncaught Exception:', err);
    logger.error('Stack:', err.stack);
    gracefulExit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('💥 Unhandled Rejection:', reason);
    if (reason instanceof Error) {
        logger.error('Stack:', reason.stack);
    }
    gracefulExit(1);
});

function gracefulExit(code) {
    logger.info('🛑 Graceful shutdown initiated...');
    server.close(() => {
        logger.info('HTTP server closed');
        Promise.all([
            redis.quit().catch(() => {}),
            pub.quit().catch(() => {}),
            sub.quit().catch(() => {}),
            db.close().catch(() => {})
        ]).finally(() => {
            logger.info('All connections closed, exiting...');
            process.exit(code);
        });
    });
    setTimeout(() => {
        logger.error('⚠️ Force exit after timeout');
        process.exit(code);
    }, 30000).unref();
}

process.on('SIGTERM', () => {
    logger.info('🛑 SIGTERM received, graceful shutdown...');
    gracefulExit(0);
});

process.on('SIGINT', () => {
    logger.info('🛑 SIGINT received, graceful shutdown...');
    gracefulExit(0);
});

// ============================================
// شروع سرور
// ============================================
startServer();

module.exports = { app, server, io, redis, queues, db };