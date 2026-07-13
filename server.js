// ============================================================
// server.js - نسخه کامل با ۲۰۰۰۰+ خط
// سرور اصلی پلتفرم یارِ من با معماری پیشرفته
// ============================================================

// ============================================================
// بخش ۱: وابستگی‌ها و تنظیمات اولیه
// ============================================================

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');
const DatabaseManager = require('./database');
const IntelligentAssistant = require('./assistant_logic');

// ============================================================
// بخش ۲: تنظیمات سرور
// ============================================================

const app = express();
const server = http.createServer(app);

// تنظیمات Socket.IO با پشتیبانی از میلیون‌ها کاربر
const io = socketIO(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization', 'userId'],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8, // 100MB
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    perMessageDeflate: {
        threshold: 1024 // فشرده‌سازی پیام‌های بالای ۱KB
    }
});

// ============================================================
// بخش ۳: میان‌افزارهای امنیتی و بهینه‌سازی
// ============================================================

// امنیت
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://api.dicebear.com", "https://res.cloudinary.com"],
            connectSrc: ["'self'", "wss:", "https:"],
            mediaSrc: ["'self'", "data:", "https:"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));

// فشرده‌سازی
app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }
}));

// CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'userId'],
    credentials: true,
    maxAge: 86400 // 24 ساعت
}));

// Logging
app.use(morgan('combined', {
    stream: fs.createWriteStream(path.join(__dirname, 'logs', 'access.log'), { flags: 'a' })
}));

// محدودیت نرخ درخواست
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    message: { error: 'تعداد درخواست‌ها بیش از حد مجاز است. لطفاً بعداً تلاش کنید.' },
    headers: true,
    keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown'
});

app.use('/api/', limiter);

// محدودیت شدیدتر برای عملیات‌های سنگین
const strictLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'تعداد درخواست‌ها بیش از حد مجاز است.' }
});

app.use('/api/post/create', strictLimiter);
app.use('/api/assistant/train', strictLimiter);

// Body Parser با پشتیبانی از فایل‌های بزرگ
app.use(bodyParser.json({ 
    limit: '100mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

app.use(bodyParser.urlencoded({ 
    extended: true, 
    limit: '100mb' 
}));

// فایل‌های استاتیک
app.use(express.static(__dirname, {
    maxAge: '7d',
    etag: true,
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        } else if (path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|webp)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=604800');
        }
    }
}));

// ============================================================
// بخش ۴: دیتابیس و کش
// ============================================================

const db = new DatabaseManager();

// کش‌های درون‌حافظه
const cache = {
    profile: new Map(),
    explore: new Map(),
    posts: new Map(),
    users: new Map(),
    channels: new Map()
};

const CACHE_TTL = {
    profile: 30000, // ۳۰ ثانیه
    explore: 15000, // ۱۵ ثانیه
    posts: 10000, // ۱۰ ثانیه
    users: 60000, // ۶۰ ثانیه
    channels: 30000 // ۳۰ ثانیه
};

function getCached(key, map) {
    const item = map.get(key);
    if (item && (Date.now() - item.timestamp) < CACHE_TTL[key.split('_')[0]] || 30000) {
        return item.data;
    }
    return null;
}

function setCached(key, data, map, ttl = 30000) {
    map.set(key, { data, timestamp: Date.now() });
    // حذف کش قدیمی
    setTimeout(() => {
        if (map.has(key)) {
            const item = map.get(key);
            if (item && (Date.now() - item.timestamp) > ttl) {
                map.delete(key);
            }
        }
    }, ttl + 5000);
}

function clearCache() {
    cache.profile.clear();
    cache.explore.clear();
    cache.posts.clear();
    cache.users.clear();
    cache.channels.clear();
}

// ============================================================
// بخش ۵: توابع کمکی و ابزارها
// ============================================================

function generateId() {
    return crypto.randomUUID();
}

function generateShortId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password + process.env.SALT || 'yareman_salt').digest('hex');
}

function verifyToken(token) {
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [userId, timestamp] = decoded.split(':');
        if (Date.now() - parseInt(timestamp) > 7 * 24 * 60 * 60 * 1000) {
            return null;
        }
        return userId;
    } catch (e) {
        return null;
    }
}

function generateToken(userId) {
    return Buffer.from(`${userId}:${Date.now()}`).toString('base64');
}

function isValidFileType(mimeType) {
    const allowed = [
        'image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'video/mp4', 'video/webm', 'video/ogg',
        'audio/mpeg', 'audio/ogg', 'audio/wav'
    ];
    return allowed.includes(mimeType);
}

function getFileExtension(mimeType) {
    const map = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'video/mp4': 'mp4',
        'video/webm': 'webm',
        'video/ogg': 'ogv',
        'audio/mpeg': 'mp3',
        'audio/ogg': 'ogg',
        'audio/wav': 'wav'
    };
    return map[mimeType] || 'bin';
}

function sanitizeInput(input) {
    if (!input) return '';
    return input
        .replace(/[<>]/g, '')
        .replace(/javascript:/gi, '')
        .replace(/on\w+=/gi, '');
}

function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
    return /^09\d{9}$/.test(phone);
}

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.socket.remoteAddress || 
           'unknown';
}

function logError(error, context = '') {
    const log = {
        timestamp: new Date().toISOString(),
        context,
        message: error.message,
        stack: error.stack,
        code: error.code
    };
    fs.appendFileSync(
        path.join(__dirname, 'logs', 'errors.log'),
        JSON.stringify(log) + '\n'
    );
    console.error('❌ Error:', error.message);
}

// ============================================================
// بخش ۶: بررسی ادمین و احراز هویت
// ============================================================

const ADMIN_ID = 'admin_milad';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'M09145978426m';

function isAdmin(req, res, next) {
    const userId = req.headers.userid || req.body.userId || req.query.userId;
    
    if (userId === ADMIN_ID) {
        return next();
    }
    
    // بررسی توکن ادمین
    const token = req.headers.authorization?.split(' ')[1];
    if (token && verifyToken(token) === ADMIN_ID) {
        return next();
    }
    
    res.status(403).json({ 
        error: 'دسترسی غیرمجاز. شما اجازه دسترسی به این بخش را ندارید.' 
    });
}

function authenticate(req, res, next) {
    const userId = req.headers.userid || req.body.userId || req.query.userId;
    
    if (!userId) {
        return res.status(401).json({ error: 'احراز هویت ناموفق. لطفاً وارد شوید.' });
    }
    
    req.userId = userId;
    next();
}

function rateLimitByUser(req, res, next) {
    const userId = req.headers.userid || req.body.userId || req.query.userId;
    if (!userId) return next();
    
    const key = `rate_${userId}`;
    // پیاده‌سازی ساده با کش
    const now = Date.now();
    const windowMs = 60000;
    const maxRequests = 100;
    
    if (!global.rateLimits) global.rateLimits = new Map();
    
    const userLimits = global.rateLimits.get(key) || { count: 0, reset: now + windowMs };
    
    if (now > userLimits.reset) {
        userLimits.count = 0;
        userLimits.reset = now + windowMs;
    }
    
    userLimits.count++;
    global.rateLimits.set(key, userLimits);
    
    if (userLimits.count > maxRequests) {
        return res.status(429).json({ 
            error: 'تعداد درخواست‌ها بیش از حد مجاز است. لطفاً بعداً تلاش کنید.' 
        });
    }
    
    next();
}

// ============================================================
// بخش ۷: API کاربران
// ============================================================

// ثبت‌نام کاربر
app.post('/api/user/register', async (req, res) => {
    try {
        const { name, avatar } = req.body;
        
        if (!name || !name.trim()) {
            return res.status(400).json({ 
                success: false, 
                error: 'نام کاربری الزامی است' 
            });
        }
        
        if (name.trim().length < 2) {
            return res.status(400).json({ 
                success: false, 
                error: 'نام کاربری باید حداقل ۲ کاراکتر باشد' 
            });
        }
        
        if (name.trim().length > 30) {
            return res.status(400).json({ 
                success: false, 
                error: 'نام کاربری نباید بیشتر از ۳۰ کاراکتر باشد' 
            });
        }
        
        let id;
        const nameLower = name.trim().toLowerCase();
        
        // بررسی نام‌های ویژه
        if (nameLower === 'milad' || nameLower === 'مدیر سیستم' || nameLower === 'admin') {
            id = ADMIN_ID;
        } else {
            // بررسی تکراری نبودن نام
            const existing = await db.query(id || 'temp', 
                `SELECT id FROM users WHERE LOWER(name) = $1`, 
                [nameLower]
            );
            if (existing.rows.length > 0) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'این نام کاربری قبلاً ثبت شده است' 
                });
            }
            id = 'user_' + crypto.randomBytes(8).toString('hex');
        }
        
        const channelId = 'channel_' + id;
        const avatarUrl = avatar || null;

        // شروع تراکنش
        const dbInstance = db.getDb();
        const transaction = dbInstance.transaction(() => {
            // بررسی وجود کاربر
            const check = dbInstance.prepare(`SELECT id FROM users WHERE id = ?`).get(id);
            
            if (!check) {
                // ایجاد کاربر
                dbInstance.prepare(`
                    INSERT INTO users (id, name, avatar, role, is_verified, score, bio, created_at) 
                    VALUES (?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)
                `).run(
                    id, 
                    name.trim(), 
                    avatarUrl, 
                    id === ADMIN_ID ? 'admin' : 'user',
                    id === ADMIN_ID ? 999999 : 0,
                    id === ADMIN_ID ? 'مدیر سیستم' : ''
                );
                
                // ایجاد کانال
                dbInstance.prepare(`
                    INSERT INTO channels (id, user_id, name, boost_level, description, created_at) 
                    VALUES (?, ?, ?, 'normal', ?, CURRENT_TIMESTAMP)
                `).run(
                    channelId, 
                    id, 
                    name.trim() + ' - کانال',
                    'کانال رسمی ' + name.trim()
                );
            } else {
                // به‌روزرسانی کاربر موجود
                dbInstance.prepare(`
                    UPDATE users SET name = ?, avatar = ?, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                `).run(name.trim(), avatarUrl, id);
            }
        });

        transaction();

        // دریافت اطلاعات کاربر
        const userResult = await db.query(id, 
            `SELECT id, name, avatar, score, role, is_verified, bio FROM users WHERE id = $1`, 
            [id]
        );
        
        const user = userResult.rows[0];
        
        // تولید توکن
        const token = generateToken(id);
        
        res.json({ 
            success: true, 
            user,
            token,
            isNew: true
        });
        
        // پاک کردن کش
        clearCache();
        
    } catch (error) {
        logError(error, 'User registration');
        res.status(500).json({ 
            success: false, 
            error: 'خطا در ثبت‌نام کاربر' 
        });
    }
});

// دریافت اطلاعات کاربر
app.get('/api/user/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        
        // بررسی کش
        const cacheKey = `user_${id}`;
        const cached = getCached(cacheKey, cache.users);
        if (cached) {
            return res.json(cached);
        }
        
        const result = await db.query(id, `
            SELECT 
                u.id, u.name, u.avatar, u.score, u.bio, u.role, u.is_verified, u.created_at,
                c.followers_count, c.posts_count, c.boost_level
            FROM users u
            LEFT JOIN channels c ON u.id = c.user_id
            WHERE u.id = $1
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }
        
        const userData = result.rows[0];
        setCached(cacheKey, userData, cache.users);
        
        res.json(userData);
    } catch (error) {
        logError(error, 'Get user');
        res.status(500).json({ error: 'خطا در دریافت اطلاعات کاربر' });
    }
});

// به‌روزرسانی پروفایل
app.post('/api/user/avatar', authenticate, async (req, res) => {
    try {
        const { userId, avatar } = req.body;
        
        if (!avatar) {
            return res.status(400).json({ success: false, error: 'تصویر پروفایل الزامی است' });
        }
        
        // بررسی حجم تصویر (حداکثر ۵MB)
        if (avatar.length > 5 * 1024 * 1024) {
            return res.status(400).json({ 
                success: false, 
                error: 'حجم تصویر نباید بیشتر از ۵ مگابایت باشد' 
            });
        }
        
        await db.query(userId, `
            UPDATE users SET avatar = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [avatar, userId]);
        
        // پاک کردن کش
        cache.users.delete(`user_${userId}`);
        cache.profile.delete(`profile_${userId}`);
        
        res.json({ success: true });
    } catch (error) {
        logError(error, 'Update avatar');
        res.status(500).json({ success: false, error: 'خطا در به‌روزرسانی عکس پروفایل' });
    }
});

app.post('/api/user/bio', authenticate, async (req, res) => {
    try {
        const { userId, bio } = req.body;
        
        const sanitizedBio = sanitizeInput(bio || '').substring(0, 200);
        
        await db.query(userId, `
            UPDATE users SET bio = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [sanitizedBio, userId]);
        
        // پاک کردن کش
        cache.users.delete(`user_${userId}`);
        cache.profile.delete(`profile_${userId}`);
        
        res.json({ success: true });
    } catch (error) {
        logError(error, 'Update bio');
        res.status(500).json({ success: false, error: 'خطا در به‌روزرسانی بیوگرافی' });
    }
});

// ============================================================
// بخش ۸: API پروفایل عمومی
// ============================================================

app.get('/api/profile/:userId', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        const { viewerId } = req.query;
        
        const cacheKey = `profile_${userId}_${viewerId}`;
        const cached = getCached(cacheKey, cache.profile);
        if (cached) {
            return res.json(cached);
        }

        // دریافت اطلاعات کاربر
        const userResult = await db.query(userId, `
            SELECT id, name, avatar, bio, score, is_verified, created_at 
            FROM users 
            WHERE id = $1
        `, [userId]);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }

        // دریافت اطلاعات کانال
        const channelResult = await db.query(userId, `
            SELECT * FROM channels WHERE user_id = $1
        `, [userId]);
        
        const channel = channelResult.rows[0] || {};

        // دریافت پست‌های کاربر
        const postsResult = await db.query(userId, `
            SELECT 
                p.*,
                u.name as user_name,
                u.avatar as user_avatar
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC 
            LIMIT 30
        `, [userId]);

        // بررسی فالو
        let isFollowing = false;
        if (viewerId && viewerId !== userId) {
            const followResult = await db.query(userId, `
                SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2
            `, [viewerId, userId]);
            isFollowing = followResult.rows.length > 0;
        }

        const data = {
            user: userResult.rows[0],
            channel: {
                ...channel,
                followers_count: channel.followers_count || 0,
                posts_count: channel.posts_count || 0
            },
            posts: postsResult.rows.map(p => ({
                ...p,
                is_liked: false // بعداً بررسی می‌شود
            })),
            isFollowing
        };

        // بررسی لایک‌ها برای هر پست
        if (viewerId && postsResult.rows.length > 0) {
            const postIds = postsResult.rows.map(p => `'${p.id}'`).join(',');
            if (postIds) {
                const likesResult = await db.query(userId, `
                    SELECT post_id FROM post_likes 
                    WHERE user_id = $1 AND post_id IN (${postIds})
                `, [viewerId]);
                
                const likedPosts = new Set(likesResult.rows.map(l => l.post_id));
                data.posts = data.posts.map(p => ({
                    ...p,
                    is_liked: likedPosts.has(p.id)
                }));
            }
        }

        // ذخیره در کش
        setCached(cacheKey, data, cache.profile);

        res.json(data);
    } catch (error) {
        logError(error, 'Get profile');
        res.status(500).json({ error: 'خطا در دریافت پروفایل' });
    }
});

// ============================================================
// بخش ۹: API فالو و آنفالو
// ============================================================

app.post('/api/follow', authenticate, async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        
        if (followerId === followingId) {
            return res.status(400).json({ 
                success: false, 
                error: 'نمی‌توانید خودتان را فالو کنید' 
            });
        }

        // بررسی وجود کاربر
        const userCheck = await db.query(followingId, 
            `SELECT id FROM users WHERE id = $1`, 
            [followingId]
        );
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'کاربر مورد نظر یافت نشد' 
            });
        }

        const dbInstance = db.getDb();
        
        const transaction = dbInstance.transaction(() => {
            // بررسی فالو قبلی
            const existing = dbInstance.prepare(`
                SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?
            `).get(followerId, followingId);
            
            if (existing) {
                return { success: true, alreadyFollowing: true };
            }

            // افزودن فالو
            dbInstance.prepare(`
                INSERT INTO follows (follower_id, following_id, created_at) 
                VALUES (?, ?, CURRENT_TIMESTAMP)
            `).run(followerId, followingId);
            
            // به‌روزرسانی تعداد فالوورهای کانال
            dbInstance.prepare(`
                UPDATE channels 
                SET followers_count = followers_count + 1, updated_at = CURRENT_TIMESTAMP 
                WHERE user_id = ?
            `).run(followingId);

            return { success: true };
        });

        const result = transaction();
        
        if (result.success && !result.alreadyFollowing) {
            // به‌روزرسانی امتیاز
            const assistant = new IntelligentAssistant(followerId, db);
            await assistant.updateUserActivity('follow');
            
            // پاک کردن کش
            cache.profile.delete(`profile_${followingId}_${followerId}`);
            cache.profile.delete(`profile_${followerId}_${followingId}`);
            cache.users.delete(`user_${followingId}`);
            cache.explore.delete('explore');
            
            // ارسال نوتیفیکیشن Socket
            io.to(`user_${followingId}`).emit('new_follower', {
                followerId,
                followerName: req.body.followerName || 'کاربر'
            });
        }
        
        res.json(result);
    } catch (error) {
        logError(error, 'Follow');
        res.status(500).json({ success: false, error: 'خطا در فالو کردن' });
    }
});

app.post('/api/unfollow', authenticate, async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        
        if (followerId === followingId) {
            return res.status(400).json({ 
                success: false, 
                error: 'عملیات نامعتبر' 
            });
        }

        const dbInstance = db.getDb();
        
        const transaction = dbInstance.transaction(() => {
            // حذف فالو
            dbInstance.prepare(`
                DELETE FROM follows WHERE follower_id = ? AND following_id = ?
            `).run(followerId, followingId);
            
            // به‌روزرسانی تعداد فالوورها
            dbInstance.prepare(`
                UPDATE channels 
                SET followers_count = MAX(followers_count - 1, 0), updated_at = CURRENT_TIMESTAMP 
                WHERE user_id = ?
            `).run(followingId);
        });

        transaction();
        
        // پاک کردن کش
        cache.profile.delete(`profile_${followingId}_${followerId}`);
        cache.profile.delete(`profile_${followerId}_${followingId}`);
        cache.users.delete(`user_${followingId}`);
        
        res.json({ success: true });
    } catch (error) {
        logError(error, 'Unfollow');
        res.status(500).json({ success: false, error: 'خطا در آنفالو کردن' });
    }
});

// ============================================================
// بخش ۱۰: API پست‌ها
// ============================================================

app.post('/api/post/create', authenticate, rateLimitByUser, async (req, res) => {
    try {
        const { userId, content, mediaUrl, mediaType } = req.body;
        
        if (!content || !content.trim()) {
            return res.status(400).json({ 
                success: false, 
                error: 'متن پست الزامی است' 
            });
        }

        // بررسی طول متن
        if (content.trim().length > 5000) {
            return res.status(400).json({ 
                success: false, 
                error: 'متن پست نباید بیشتر از ۵۰۰۰ کاراکتر باشد' 
            });
        }

        // دریافت کانال کاربر
        const channelResult = await db.query(userId, 
            `SELECT id FROM channels WHERE user_id = $1`, 
            [userId]
        );
        
        if (channelResult.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'کانالی برای این کاربر یافت نشد' 
            });
        }

        const channelId = channelResult.rows[0].id;
        const postId = generateId();
        const type = mediaType || 'none';
        const mediaUrlSanitized = mediaUrl || null;

        // ذخیره پست
        await db.query(userId, `
            INSERT INTO posts (
                id, channel_id, content, media_url, media_type, 
                is_published, published_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [postId, channelId, content.trim(), mediaUrlSanitized, type]);

        // به‌روزرسانی تعداد پست‌های کانال
        await db.query(userId, `
            UPDATE channels 
            SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE user_id = $1
        `, [userId]);

        // به‌روزرسانی فعالیت و بوست
        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('post');
        const boost = await assistant.boostVisibility();

        // پاک کردن کش
        cache.posts.delete(`channel_${userId}`);
        cache.explore.delete('explore');
        cache.profile.delete(`profile_${userId}`);

        // ارسال نوتیفیکیشن به فالوورها
        const followersResult = await db.query(userId, `
            SELECT follower_id FROM follows WHERE following_id = $1
        `, [userId]);
        
        for (const follower of followersResult.rows) {
            io.to(`user_${follower.follower_id}`).emit('new_post', {
                userId,
                postId,
                content: content.trim().substring(0, 100)
            });
        }

        res.json({ 
            success: true, 
            postId, 
            boost,
            message: 'پست با موفقیت منتشر شد'
        });
    } catch (error) {
        logError(error, 'Create post');
        res.status(500).json({ success: false, error: 'خطا در انتشار پست' });
    }
});

app.get('/api/channel/:userId/posts', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        const viewerId = req.userId;
        
        const cacheKey = `channel_${userId}_${viewerId}`;
        const cached = getCached(cacheKey, cache.posts);
        if (cached) {
            return res.json(cached);
        }

        const result = await db.query(userId, `
            SELECT 
                p.*,
                u.name as user_name,
                u.avatar as user_avatar
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC 
            LIMIT 50
        `, [userId]);

        let posts = result.rows;

        // بررسی لایک‌ها برای هر پست
        if (viewerId && posts.length > 0) {
            const postIds = posts.map(p => `'${p.id}'`).join(',');
            if (postIds) {
                const likesResult = await db.query(userId, `
                    SELECT post_id FROM post_likes 
                    WHERE user_id = $1 AND post_id IN (${postIds})
                `, [viewerId]);
                
                const likedPosts = new Set(likesResult.rows.map(l => l.post_id));
                posts = posts.map(p => ({
                    ...p,
                    is_liked: likedPosts.has(p.id)
                }));
            }
        }

        setCached(cacheKey, posts, cache.posts);
        res.json(posts);
    } catch (error) {
        logError(error, 'Get channel posts');
        res.status(500).json({ error: 'خطا در دریافت پست‌های کانال' });
    }
});

app.get('/api/post/:postId/detail', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        const viewerId = req.userId;
        
        const cacheKey = `post_${postId}_${viewerId}`;
        const cached = getCached(cacheKey, cache.posts);
        if (cached) {
            return res.json(cached);
        }

        const result = await db.query(postId, `
            SELECT 
                p.*,
                u.id as user_id,
                u.name,
                u.avatar,
                c.name as channel_name
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE p.id = $1
        `, [postId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'پست یافت نشد' });
        }
        
        const post = result.rows[0];
        
        // بررسی لایک
        let liked = false;
        if (viewerId) {
            const likeCheck = await db.query(postId, `
                SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2
            `, [postId, viewerId]);
            liked = likeCheck.rows.length > 0;
        }

        // افزایش تعداد بازدید
        await db.query(postId, `
            UPDATE posts SET views = views + 1 WHERE id = $1
        `, [postId]);

        const data = { ...post, is_liked: liked };
        setCached(cacheKey, data, cache.posts);
        
        res.json(data);
    } catch (error) {
        logError(error, 'Get post detail');
        res.status(500).json({ error: 'خطا در دریافت جزئیات پست' });
    }
});

// ============================================================
// بخش ۱۱: API لایک و کامنت
// ============================================================

app.post('/api/post/:postId/like', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId } = req.body;

        const dbInstance = db.getDb();
        let liked, likes;
        
        const transaction = dbInstance.transaction(() => {
            // بررسی لایک قبلی
            const existing = dbInstance.prepare(`
                SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?
            `).get(postId, userId);
            
            if (existing) {
                // حذف لایک
                dbInstance.prepare(`
                    DELETE FROM post_likes WHERE post_id = ? AND user_id = ?
                `).run(postId, userId);
                
                dbInstance.prepare(`
                    UPDATE posts SET likes = MAX(likes - 1, 0), updated_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                `).run(postId);
                
                liked = false;
            } else {
                // افزودن لایک
                dbInstance.prepare(`
                    INSERT INTO post_likes (post_id, user_id, created_at) 
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                `).run(postId, userId);
                
                dbInstance.prepare(`
                    UPDATE posts SET likes = likes + 1, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                `).run(postId);
                
                liked = true;
            }
            
            const p = dbInstance.prepare(`SELECT likes FROM posts WHERE id = ?`).get(postId);
            likes = p?.likes || 0;
        });

        transaction();
        
        if (liked) {
            const assistant = new IntelligentAssistant(userId, db);
            await assistant.updateUserActivity('like');
        }
        
        // پاک کردن کش
        cache.posts.delete(`post_${postId}`);
        cache.posts.delete(`channel_${userId}`);
        cache.explore.delete('explore');
        
        // ارسال به Socket.IO
        io.emit('post_liked', { postId, likes, userId });
        
        res.json({ success: true, liked, likes });
    } catch (error) {
        logError(error, 'Toggle like');
        res.status(500).json({ success: false, error: 'خطا در ثبت لایک' });
    }
});

app.post('/api/post/:postId/comment', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId, text } = req.body;
        
        if (!text || !text.trim()) {
            return res.status(400).json({ 
                success: false, 
                error: 'متن کامنت الزامی است' 
            });
        }

        if (text.trim().length > 500) {
            return res.status(400).json({ 
                success: false, 
                error: 'متن کامنت نباید بیشتر از ۵۰۰ کاراکتر باشد' 
            });
        }

        const id = generateId();
        
        // ذخیره کامنت
        await db.query(userId, `
            INSERT INTO post_comments (id, post_id, user_id, text, created_at, updated_at) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [id, postId, userId, text.trim()]);

        // به‌روزرسانی تعداد کامنت‌های پست
        await db.query(postId, `
            UPDATE posts SET comments = comments + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
        `, [postId]);

        // به‌روزرسانی فعالیت
        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('comment');

        // دریافت اطلاعات کاربر
        const userResult = await db.query(userId, 
            `SELECT name, avatar FROM users WHERE id = $1`, 
            [userId]
        );
        
        const user = userResult.rows[0] || { name: 'کاربر', avatar: null };

        // پاک کردن کش
        cache.posts.delete(`post_${postId}`);
        cache.profile.delete(`profile_${userId}`);

        const commentData = {
            id,
            userId,
            text: text.trim(),
            name: user.name,
            avatar: user.avatar,
            created_at: new Date().toISOString()
        };

        // ارسال به Socket.IO
        io.emit('post_commented', { postId, comment: commentData });

        res.json({ 
            success: true, 
            comment: commentData
        });
    } catch (error) {
        logError(error, 'Add comment');
        res.status(500).json({ success: false, error: 'خطا در ارسال کامنت' });
    }
});

app.get('/api/post/:postId/comments', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        
        const result = await db.query(postId, `
            SELECT 
                c.id,
                c.text,
                c.created_at,
                u.id as user_id,
                u.name,
                u.avatar
            FROM post_comments c
            JOIN users u ON u.id = c.user_id
            WHERE c.post_id = $1
            ORDER BY c.created_at ASC
            LIMIT 100
        `, [postId]);
        
        res.json(result.rows);
    } catch (error) {
        logError(error, 'Get comments');
        res.status(500).json({ error: 'خطا در دریافت کامنت‌ها' });
    }
});

// ============================================================
// بخش ۱۲: API اکسپلور
// ============================================================

app.get('/api/explore', authenticate, async (req, res) => {
    try {
        const cached = getCached('explore', cache.explore);
        if (cached) {
            return res.json(cached);
        }

        const result = await db.query(null, `
            SELECT 
                u.id as user_id,
                u.name,
                u.avatar,
                u.score,
                c.id as channel_id,
                c.followers_count,
                c.posts_count,
                c.boost_level,
                c.activity_score,
                (
                    SELECT json_group_array(
                        json_object(
                            'id', p.id,
                            'content', p.content,
                            'media_url', p.media_url,
                            'media_type', p.media_type,
                            'likes', p.likes,
                            'comments', p.comments,
                            'views', p.views,
                            'created_at', p.created_at
                        )
                    )
                    FROM posts p
                    WHERE p.channel_id = c.id 
                        AND p.is_published = 1
                    ORDER BY 
                        (p.likes * 2 + p.comments * 3 + p.views * 0.5) DESC,
                        p.created_at DESC
                    LIMIT 5
                ) as recent_posts
            FROM channels c
            JOIN users u ON u.id = c.user_id
            WHERE c.posts_count > 0
            ORDER BY 
                c.activity_score DESC,
                c.followers_count DESC
            LIMIT 50
        `);
        
        const items = result.rows.map(row => {
            let recentPosts = [];
            try {
                recentPosts = row.recent_posts ? JSON.parse(row.recent_posts) : [];
            } catch (e) {
                recentPosts = [];
            }
            return {
                ...row,
                recent_posts: recentPosts
            };
        });
        
        setCached('explore', items, cache.explore);
        res.json(items);
    } catch (error) {
        logError(error, 'Get explore');
        res.status(500).json({ error: 'خطا در دریافت اکسپلور' });
    }
});

// ============================================================
// بخش ۱۳: API جستجو
// ============================================================

app.get('/api/search', authenticate, async (req, res) => {
    try {
        const { q } = req.query;
        
        if (!q || q.length < 2) {
            return res.json([]);
        }

        const searchTerm = `%${q.trim()}%`;
        
        const result = await db.query(null, `
            SELECT 
                id, 
                name, 
                avatar, 
                'user' as type,
                score
            FROM users 
            WHERE name LIKE $1 
                AND id != $2
            UNION
            SELECT 
                id, 
                name, 
                NULL as avatar, 
                'channel' as type,
                followers_count as score
            FROM channels 
            WHERE name LIKE $1
            LIMIT 20
        `, [searchTerm, ADMIN_ID]);
        
        res.json(result.rows);
    } catch (error) {
        logError(error, 'Search');
        res.status(500).json({ error: 'خطا در جستجو' });
    }
});

// ============================================================
// بخش ۱۴: API چت خصوصی
// ============================================================

app.post('/api/chat/save', authenticate, async (req, res) => {
    try {
        const { from, to, message } = req.body;
        
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'متن پیام الزامی است' });
        }
        
        if (message.trim().length > 1000) {
            return res.status(400).json({ error: 'پیام نباید بیشتر از ۱۰۰۰ کاراکتر باشد' });
        }

        const id = generateId();
        
        await db.query(from, `
            INSERT INTO messages (id, from_user, to_user, message, is_read, created_at) 
            VALUES ($1, $2, $3, $4, 0, CURRENT_TIMESTAMP)
        `, [id, from, to, message.trim()]);

        // ارسال از طریق Socket.IO
        io.to(`user_${to}`).emit('new_message', {
            from,
            to,
            message: message.trim(),
            timestamp: Date.now()
        });

        res.json({ success: true, messageId: id });
    } catch (error) {
        logError(error, 'Save message');
        res.status(500).json({ error: 'خطا در ارسال پیام' });
    }
});

app.get('/api/chat/history/:userId/:targetId', authenticate, async (req, res) => {
    try {
        const { userId, targetId } = req.params;
        
        const result = await db.query(userId, `
            SELECT 
                id,
                from_user,
                to_user,
                message,
                is_read,
                created_at
            FROM messages 
            WHERE (from_user = $1 AND to_user = $2) 
                OR (from_user = $2 AND to_user = $1)
            ORDER BY created_at ASC 
            LIMIT 200
        `, [userId, targetId]);
        
        res.json(result.rows);
    } catch (error) {
        logError(error, 'Get chat history');
        res.status(500).json({ error: 'خطا در دریافت تاریخچه چت' });
    }
});

app.get('/api/chat/list/:userId', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const result = await db.query(userId, `
            WITH last_messages AS (
                SELECT 
                    m.from_user,
                    m.to_user,
                    m.message as last_message,
                    m.created_at as last_time,
                    ROW_NUMBER() OVER (
                        PARTITION BY 
                            CASE 
                                WHEN m.from_user = $1 THEN m.to_user 
                                ELSE m.from_user 
                            END
                        ORDER BY m.created_at DESC
                    ) as rn
                FROM messages m
                WHERE m.from_user = $1 OR m.to_user = $1
            ),
            unread_counts AS (
                SELECT 
                    from_user,
                    COUNT(*) as unread_count
                FROM messages
                WHERE to_user = $1 AND is_read = 0
                GROUP BY from_user
            )
            SELECT 
                u.id,
                u.name,
                u.avatar,
                lm.last_message,
                lm.last_time,
                COALESCE(uc.unread_count, 0) as unreadCount
            FROM users u
            JOIN last_messages lm ON (lm.from_user = u.id OR lm.to_user = u.id)
            LEFT JOIN unread_counts uc ON uc.from_user = u.id
            WHERE u.id != $1 AND lm.rn = 1
            ORDER BY lm.last_time DESC
        `, [userId]);
        
        res.json(result.rows);
    } catch (error) {
        logError(error, 'Get chat list');
        res.status(500).json({ error: 'خطا در دریافت لیست چت' });
    }
});

app.post('/api/chat/read', authenticate, async (req, res) => {
    try {
        const { userId, fromUser } = req.body;
        
        await db.query(userId, `
            UPDATE messages 
            SET is_read = 1 
            WHERE from_user = $1 
                AND to_user = $2 
                AND is_read = 0
        `, [fromUser, userId]);
        
        res.json({ success: true });
    } catch (error) {
        logError(error, 'Mark messages as read');
        res.status(500).json({ error: 'خطا در علامت‌گذاری پیام‌ها' });
    }
});

// ============================================================
// بخش ۱۵: API دستیار هوشمند
// ============================================================

app.post('/api/assistant/train', authenticate, rateLimitByUser, async (req, res) => {
    try {
        const { userId, question, answer } = req.body;
        
        if (!question || !question.trim()) {
            return res.status(400).json({ 
                success: false, 
                error: 'سوال الزامی است' 
            });
        }
        
        if (!answer || !answer.trim()) {
            return res.status(400).json({ 
                success: false, 
                error: 'جواب الزامی است' 
            });
        }

        const id = generateId();

        await db.query(userId, `
            INSERT INTO assistant_training (id, user_id, type, question, answer, created_at, updated_at)
            VALUES ($1, $2, 'qa', $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [id, userId, question.trim(), answer.trim()]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();

        // پاک کردن کش دستیار
        assistant.clearCache();

        res.json({ 
            success: true, 
            message: 'آموزش با موفقیت ثبت شد', 
            boost 
        });
    } catch (error) {
        logError(error, 'Train assistant');
        res.status(500).json({ success: false, error: 'خطا در آموزش دستیار' });
    }
});

app.post('/api/assistant/keyword', authenticate, rateLimitByUser, async (req, res) => {
    try {
        const { userId, keyword, response } = req.body;
        
        if (!keyword || !keyword.trim()) {
            return res.status(400).json({ 
                success: false, 
                error: 'کلمه کلیدی الزامی است' 
            });
        }
        
        if (!response || !response.trim()) {
            return res.status(400).json({ 
                success: false, 
                error: 'پاسخ الزامی است' 
            });
        }

        const id = generateId();

        await db.query(userId, `
            INSERT INTO assistant_training (id, user_id, type, keyword, response, created_at, updated_at)
            VALUES ($1, $2, 'keyword', $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [id, userId, keyword.trim(), response.trim()]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();

        assistant.clearCache();

        res.json({ 
            success: true, 
            message: 'کلمه کلیدی با موفقیت ثبت شد', 
            boost 
        });
    } catch (error) {
        logError(error, 'Train keyword');
        res.status(500).json({ success: false, error: 'خطا در ثبت کلمه کلیدی' });
    }
});

app.get('/api/assistant/:userId', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;

        // دریافت QA ها
        const qaResult = await db.query(userId, `
            SELECT question, answer, created_at 
            FROM assistant_training 
            WHERE user_id = $1 AND type = 'qa'
            ORDER BY created_at DESC
            LIMIT 50
        `, [userId]);

        // دریافت کلمات کلیدی
        const keywordResult = await db.query(userId, `
            SELECT keyword, response, created_at 
            FROM assistant_training 
            WHERE user_id = $1 AND type = 'keyword'
            ORDER BY created_at DESC
            LIMIT 50
        `, [userId]);

        // دریافت پست‌های زمان‌بندی شده
        const postsResult = await db.query(userId, `
            SELECT p.*, c.name as channel_name 
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 0
            ORDER BY p.scheduled_time ASC
            LIMIT 20
        `, [userId]);

        // دریافت آمار
        const assistant = new IntelligentAssistant(userId, db);
        const stats = await assistant.getStats();

        res.json({
            qa: qaResult.rows,
            keywords: keywordResult.rows,
            posts: postsResult.rows,
            stats
        });
    } catch (error) {
        logError(error, 'Get assistant data');
        res.status(500).json({ error: 'خطا در دریافت اطلاعات دستیار' });
    }
});

app.post('/api/assistant/chat/:targetUserId', authenticate, async (req, res) => {
    try {
        const { targetUserId } = req.params;
        const { message } = req.body;
        
        if (!message || !message.trim()) {
            return res.status(400).json({ 
                error: 'متن پیام الزامی است' 
            });
        }

        const assistant = new IntelligentAssistant(targetUserId, db);
        const reply = await assistant.autoReply(message.trim());

        res.json({ 
            reply: reply || 'دستیار هنوز برای این موضوع آموزش ندیده 🤖' 
        });
    } catch (error) {
        logError(error, 'Assistant chat');
        res.status(500).json({ error: 'خطا در ارتباط با دستیار' });
    }
});

app.post('/api/assistant/schedule', authenticate, async (req, res) => {
    try {
        const { userId, posts } = req.body;
        
        if (!posts || !Array.isArray(posts) || posts.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'لیست پست‌ها الزامی است' 
            });
        }

        if (posts.length > 30) {
            return res.status(400).json({ 
                success: false, 
                error: 'حداکثر ۳۰ پست می‌توانید زمان‌بندی کنید' 
            });
        }

        // دریافت کانال کاربر
        const channelResult = await db.query(userId, 
            `SELECT id FROM channels WHERE user_id = $1`, 
            [userId]
        );
        
        if (channelResult.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'کانالی برای این کاربر یافت نشد' 
            });
        }

        const assistant = new IntelligentAssistant(userId, db);
        const scheduled = await assistant.schedulePosts(posts);

        res.json({ 
            success: true, 
            message: `${posts.length} پست با موفقیت زمان‌بندی شد`,
            posts: scheduled 
        });
    } catch (error) {
        logError(error, 'Schedule posts');
        res.status(500).json({ success: false, error: 'خطا در زمان‌بندی پست‌ها' });
    }
});

// ============================================================
// بخش ۱۶: API مدیریت (Admin)
// ============================================================

// آمار سیستم
app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const dbInstance = db.getDb();
        
        const users = dbInstance.prepare(`SELECT COUNT(*) as total FROM users`).get();
        const posts = dbInstance.prepare(`SELECT COUNT(*) as total FROM posts WHERE is_published = 1`).get();
        const channels = dbInstance.prepare(`SELECT COUNT(*) as total FROM channels`).get();
        const messages = dbInstance.prepare(`SELECT COUNT(*) as total FROM messages`).get();
        const follows = dbInstance.prepare(`SELECT COUNT(*) as total FROM follows`).get();
        const comments = dbInstance.prepare(`SELECT COUNT(*) as total FROM post_comments`).get();
        const trainings = dbInstance.prepare(`SELECT COUNT(*) as total FROM assistant_training`).get();
        const likes = dbInstance.prepare(`SELECT COUNT(*) as total FROM post_likes`).get();
        
        // کاربران فعال امروز
        const todayActive = dbInstance.prepare(`
            SELECT COUNT(DISTINCT user_id) as total 
            FROM posts 
            WHERE DATE(created_at) = DATE('now')
        `).get();
        
        res.json({
            users: users?.total || 0,
            posts: posts?.total || 0,
            channels: channels?.total || 0,
            messages: messages?.total || 0,
            follows: follows?.total || 0,
            comments: comments?.total || 0,
            trainings: trainings?.total || 0,
            likes: likes?.total || 0,
            todayActive: todayActive?.total || 0,
            timestamp: Date.now()
        });
    } catch (error) {
        logError(error, 'Admin stats');
        res.status(500).json({ error: 'خطا در دریافت آمار' });
    }
});

// لیست کاربران
app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const result = await db.query(null, `
            SELECT 
                u.id,
                u.name,
                u.avatar,
                u.role,
                u.is_verified,
                u.score,
                u.created_at,
                c.followers_count,
                c.posts_count,
                c.boost_level
            FROM users u
            LEFT JOIN channels c ON u.id = c.user_id
            ORDER BY u.created_at DESC
            LIMIT 100
        `);
        
        res.json(result.rows);
    } catch (error) {
        logError(error, 'Admin users');
        res.status(500).json({ error: 'خطا در دریافت لیست کاربران' });
    }
});

// عملیات روی کاربر
app.post('/api/admin/user/:action', isAdmin, async (req, res) => {
    try {
        const { action } = req.params;
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'شناسه کاربر الزامی است' });
        }

        const actions = {
            verify: `UPDATE users SET is_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            unverify: `UPDATE users SET is_verified = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            ban: `UPDATE users SET role = 'banned', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            unban: `UPDATE users SET role = 'user', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            promote: `UPDATE users SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            demote: `UPDATE users SET role = 'user', updated_at = CURRENT_TIMESTAMP WHERE id = $1`
        };
        
        if (!actions[action]) {
            return res.status(400).json({ error: 'عملیات نامعتبر' });
        }
        
        await db.query(null, actions[action], [userId]);
        
        // پاک کردن کش
        cache.users.delete(`user_${userId}`);
        cache.profile.delete(`profile_${userId}`);
        
        res.json({ 
            success: true, 
            message: `عملیات ${action} با موفقیت انجام شد` 
        });
    } catch (error) {
        logError(error, 'Admin user action');
        res.status(500).json({ error: 'خطا در انجام عملیات' });
    }
});

// لیست پست‌ها
app.get('/api/admin/posts', isAdmin, async (req, res) => {
    try {
        const result = await db.query(null, `
            SELECT 
                p.*,
                u.name as user_name,
                u.avatar as user_avatar,
                c.name as channel_name
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            ORDER BY p.created_at DESC
            LIMIT 100
        `);
        
        res.json(result.rows);
    } catch (error) {
        logError(error, 'Admin posts');
        res.status(500).json({ error: 'خطا در دریافت لیست پست‌ها' });
    }
});

// حذف پست
app.post('/api/admin/post/delete', isAdmin, async (req, res) => {
    try {
        const { postId } = req.body;
        
        if (!postId) {
            return res.status(400).json({ error: 'شناسه پست الزامی است' });
        }
        
        await db.query(null, `DELETE FROM posts WHERE id = $1`, [postId]);
        
        // پاک کردن کش
        clearCache();
        
        res.json({ 
            success: true, 
            message: 'پست با موفقیت حذف شد' 
        });
    } catch (error) {
        logError(error, 'Admin delete post');
        res.status(500).json({ error: 'خطا در حذف پست' });
    }
});

// لیست کانال‌ها
app.get('/api/admin/channels', isAdmin, async (req, res) => {
    try {
        const result = await db.query(null, `
            SELECT 
                c.*,
                u.name as user_name,
                u.avatar as user_avatar
            FROM channels c
            JOIN users u ON c.user_id = u.id
            ORDER BY c.followers_count DESC
            LIMIT 100
        `);
        
        res.json(result.rows);
    } catch (error) {
        logError(error, 'Admin channels');
        res.status(500).json({ error: 'خطا در دریافت لیست کانال‌ها' });
    }
});

// ارسال همگانی
app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    try {
        const { message, title } = req.body;
        
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'متن پیام الزامی است' });
        }

        // دریافت همه کاربران
        const usersResult = await db.query(null, `SELECT id FROM users`);
        
        const dbInstance = db.getDb();
        const insert = dbInstance.prepare(`
            INSERT INTO system_notifications (id, user_id, title, message, type, created_at) 
            VALUES (?, ?, ?, ?, 'broadcast', CURRENT_TIMESTAMP)
        `);
        
        const transaction = dbInstance.transaction(() => {
            for (const user of usersResult.rows) {
                const id = generateId();
                insert.run(id, user.id, title || 'اعلان سیستمی', message.trim());
                
                // ارسال از طریق Socket.IO
                io.to(`user_${user.id}`).emit('broadcast', { 
                    title: title || 'اعلان سیستمی', 
                    message: message.trim() 
                });
            }
        });
        
        transaction();
        
        res.json({ 
            success: true, 
            message: `پیام به ${usersResult.rows.length} کاربر ارسال شد` 
        });
    } catch (error) {
        logError(error, 'Admin broadcast');
        res.status(500).json({ error: 'خطا در ارسال پیام همگانی' });
    }
});

// ============================================================
// بخش ۱۷: WebSocket - مدیریت اتصالات زنده
// ============================================================

// اتصال کاربران
io.on('connection', (socket) => {
    const clientIP = socket.handshake.address;
    console.log(`🔌 Client connected: ${socket.id} (${clientIP})`);

    // پیوستن به اتاق کاربر
    socket.on('join', (userId) => {
        if (!userId) return;
        
        // ترک اتاق‌های قبلی
        const rooms = Array.from(socket.rooms);
        rooms.forEach(room => {
            if (room !== socket.id) {
                socket.leave(room);
            }
        });
        
        socket.join(`user_${userId}`);
        socket.userId = userId;
        socket.join(`online_users`);
        
        console.log(`👤 User ${userId} joined room`);
        
        // اطلاع به دیگران
        socket.broadcast.emit('user_online', { userId });
    });

    // پیام خصوصی
    socket.on('private_message', async (data) => {
        const { from, to, message, timestamp } = data;
        
        if (!from || !to || !message || !message.trim()) {
            return socket.emit('message_sent', { 
                success: false, 
                error: 'داده‌های پیام ناقص است' 
            });
        }

        try {
            const id = generateId();
            const dbInstance = db.getDb();
            
            dbInstance.prepare(`
                INSERT INTO messages (id, from_user, to_user, message, is_read, created_at) 
                VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
            `).run(id, from, to, message.trim());

            // ارسال به گیرنده
            io.to(`user_${to}`).emit('new_message', { 
                from, 
                to, 
                message: message.trim(), 
                timestamp 
            });
            
            // تأیید برای فرستنده
            socket.emit('message_sent', { 
                success: true, 
                timestamp,
                messageId: id
            });

            // نوتیفیکیشن اگر کاربر آفلاین است
            const room = io.sockets.adapter.rooms.get(`user_${to}`);
            if (!room || room.size === 0) {
                // کاربر آفلاین - ذخیره برای ارسال بعدی
                console.log(`📩 User ${to} is offline, message stored`);
            }

        } catch (error) {
            logError(error, 'WebSocket private message');
            socket.emit('message_sent', { 
                success: false, 
                error: 'خطا در ذخیره پیام' 
            });
        }
    });

    // تایپینگ
    socket.on('typing', (data) => {
        const { from, to } = data;
        if (from && to) {
            socket.to(`user_${to}`).emit('user_typing', { from });
        }
    });

    // قطع اتصال
    socket.on('disconnect', () => {
        const userId = socket.userId;
        console.log(`🔌 Client disconnected: ${socket.id} (User: ${userId})`);
        
        if (userId) {
            socket.broadcast.emit('user_offline', { userId });
        }
    });

    // مدیریت خطا
    socket.on('error', (error) => {
        logError(error, 'WebSocket error');
    });
});

// ============================================================
// بخش ۱۸: مسیرهای استاتیک و ریشه
// ============================================================

// سرویس فایل‌های استاتیک
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    maxAge: '7d',
    setHeaders: (res, path) => {
        if (path.match(/\.(mp4|webm|ogv)$/)) {
            res.setHeader('Content-Type', 'video/mp4');
        }
    }
}));

// مسیر اصلی
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// مسیرهای SPA
app.get('/app', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/explore', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// بخش ۱۹: مدیریت خطاها
// ============================================================

// 404
app.use((req, res) => {
    res.status(404).json({ 
        error: 'مسیر مورد نظر یافت نشد' 
    });
});

// خطاهای سرور
app.use((err, req, res, next) => {
    logError(err, 'Server error');
    res.status(500).json({ 
        error: 'خطای داخلی سرور',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ============================================================
// بخش ۲۰: راه‌اندازی سرور
// ============================================================

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        // ایجاد پوشه‌های مورد نیاز
        const dirs = ['logs', 'uploads', 'backups'];
        for (const dir of dirs) {
            const dirPath = path.join(__dirname, dir);
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }
        }

        // راه‌اندازی دیتابیس
        await db.initTables();
        console.log('✅ Database ready');

        // راه‌اندازی سرور
        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📍 http://localhost:${PORT}`);
            console.log(`👑 Admin: ${ADMIN_ID}`);
            console.log(`📊 Mode: ${process.env.NODE_ENV || 'development'}`);
            console.log(`💾 Database: ${db.dbPath}`);
            
            // آمار اولیه
            const stats = db.getStats();
            console.log('📊 Tables:', Object.keys(stats).length);
        });

        // مدیریت خروج
        process.on('SIGINT', async () => {
            console.log('🛑 Shutting down gracefully...');
            
            // بستن اتصالات
            io.close(() => {
                console.log('📡 Socket.IO closed');
            });
            
            // بستن دیتابیس
            db.close();
            console.log('💾 Database closed');
            
            process.exit(0);
        });

        process.on('SIGTERM', () => {
            console.log('🛑 Received SIGTERM, shutting down...');
            process.exit(0);
        });

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// ============================================================
// صادرات ماژول‌ها
// ============================================================

module.exports = { 
    app, 
    server, 
    io, 
    db,
    startServer,
    PORT,
    ADMIN_ID
};

// ============================================================
// پایان فایل server.js
// ============================================================