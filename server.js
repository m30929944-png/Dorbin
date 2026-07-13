// ============================================================
// server.js - نسخه کامل اصلاح شده
// سرور اصلی پلتفرم یارِ من
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

// تنظیمات Socket.IO
const io = socketIO(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization', 'userId'],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8,
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    perMessageDeflate: {
        threshold: 1024
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
            imgSrc: ["'self'", "data:", "https://api.dicebear.com"],
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
    threshold: 1024
}));

// CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'userId'],
    credentials: true,
    maxAge: 86400
}));

// Logging - با try/catch برای جلوگیری از خطا
try {
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    app.use(morgan('combined', {
        stream: fs.createWriteStream(path.join(logDir, 'access.log'), { flags: 'a' })
    }));
} catch (e) {
    console.log('⚠️ Logging disabled:', e.message);
}

// ===== محدودیت نرخ درخواست - اصلاح شده =====
const limiter = rateLimit({
    windowMs: 60 * 1000, // ۱ دقیقه
    max: 200, // حداکثر ۲۰۰ درخواست
    message: { 
        success: false,
        error: 'تعداد درخواست‌ها بیش از حد مجاز است. لطفاً بعداً تلاش کنید.' 
    },
    headers: true,
    standardHeaders: true,
    legacyHeaders: false,
    // کلید سفارشی برای مدیریت صحیح IP
    keyGenerator: (req) => {
        const forwarded = req.headers['x-forwarded-for'];
        let ip = forwarded ? forwarded.split(',')[0] : 
                 req.socket?.remoteAddress || 
                 req.ip || 
                 '127.0.0.1';
        // حذف پورت از آدرس IPv6
        if (ip.includes(':')) {
            ip = ip.split(':').slice(0, -1).join(':');
        }
        return ip;
    }
});

app.use('/api/', limiter);

// محدودیت شدیدتر برای عملیات‌های سنگین
const strictLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { 
        success: false,
        error: 'تعداد درخواست‌ها بیش از حد مجاز است.' 
    },
    keyGenerator: (req) => {
        const forwarded = req.headers['x-forwarded-for'];
        let ip = forwarded ? forwarded.split(',')[0] : 
                 req.socket?.remoteAddress || 
                 req.ip || 
                 '127.0.0.1';
        if (ip.includes(':')) {
            ip = ip.split(':').slice(0, -1).join(':');
        }
        return ip;
    }
});

app.use('/api/post/create', strictLimiter);
app.use('/api/assistant/train', strictLimiter);

// Body Parser
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

// ============================================================
// بخش ۵: توابع کمکی
// ============================================================

function generateId() {
    return crypto.randomUUID();
}

function generateToken(userId) {
    return Buffer.from(`${userId}:${Date.now()}`).toString('base64');
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

function logError(error, context = '') {
    console.error(`❌ Error${context ? ' (' + context + ')' : ''}:`, error.message);
    try {
        const logDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        fs.appendFileSync(
            path.join(logDir, 'errors.log'),
            `[${new Date().toISOString()}] ${context}: ${error.message}\n${error.stack}\n\n`
        );
    } catch (e) {}
}

function escapeHtml(str) {
    if (!str) return '';
    const d = document ? document.createElement('div') : { textContent: '' };
    d.textContent = str;
    return d.innerHTML;
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    try {
        const diff = (Date.now() - new Date(dateStr + 'Z').getTime()) / 1000;
        if (diff < 60) return 'همین الان';
        if (diff < 3600) return Math.floor(diff / 60) + ' دقیقه پیش';
        if (diff < 86400) return Math.floor(diff / 3600) + ' ساعت پیش';
        if (diff < 2592000) return Math.floor(diff / 86400) + ' روز پیش';
        if (diff < 31536000) return Math.floor(diff / 2592000) + ' ماه پیش';
        return Math.floor(diff / 31536000) + ' سال پیش';
    } catch (e) {
        return '';
    }
}

function formatNumber(num) {
    if (num === undefined || num === null) return '۰';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

const ADMIN_ID = 'admin_milad';

function isAdmin(req, res, next) {
    const userId = req.headers.userid || req.body.userId || req.query.userId;
    
    if (userId === ADMIN_ID) {
        return next();
    }
    
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

// ============================================================
// بخش ۶: API کاربران
// ============================================================

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
        
        let id;
        const nameLower = name.trim().toLowerCase();
        
        if (nameLower === 'milad' || nameLower === 'مدیر سیستم' || nameLower === 'admin') {
            id = ADMIN_ID;
        } else {
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

        const dbInstance = db.getDb();
        const transaction = dbInstance.transaction(() => {
            const check = dbInstance.prepare(`SELECT id FROM users WHERE id = ?`).get(id);
            
            if (!check) {
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
                
                dbInstance.prepare(`
                    INSERT INTO channels (id, user_id, name, boost_level, description, created_at) 
                    VALUES (?, ?, ?, 'normal', ?, CURRENT_TIMESTAMP)
                `).run(
                    channelId, 
                    id, 
                    name.trim() + ' - کانال',
                    'کانال رسمی ' + name.trim()
                );
            }
        });

        transaction();

        const userResult = await db.query(id, 
            `SELECT id, name, avatar, score, role, is_verified, bio FROM users WHERE id = $1`, 
            [id]
        );
        
        const user = userResult.rows[0];
        const token = generateToken(id);
        
        res.json({ 
            success: true, 
            user,
            token
        });
        
    } catch (error) {
        logError(error, 'User registration');
        res.status(500).json({ 
            success: false, 
            error: 'خطا در ثبت‌نام کاربر' 
        });
    }
});

app.get('/api/user/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        
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
        
        res.json(result.rows[0]);
    } catch (error) {
        logError(error, 'Get user');
        res.status(500).json({ error: 'خطا در دریافت اطلاعات کاربر' });
    }
});

app.post('/api/user/avatar', authenticate, async (req, res) => {
    try {
        const { userId, avatar } = req.body;
        
        if (!avatar) {
            return res.status(400).json({ success: false, error: 'تصویر پروفایل الزامی است' });
        }
        
        await db.query(userId, `
            UPDATE users SET avatar = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [avatar, userId]);
        
        res.json({ success: true });
    } catch (error) {
        logError(error, 'Update avatar');
        res.status(500).json({ success: false, error: 'خطا در به‌روزرسانی عکس پروفایل' });
    }
});

// ============================================================
// بخش ۷: API پروفایل عمومی
// ============================================================

app.get('/api/profile/:userId', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        const { viewerId } = req.query;

        const userResult = await db.query(userId, `
            SELECT id, name, avatar, bio, score, is_verified, created_at 
            FROM users 
            WHERE id = $1
        `, [userId]);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }

        const channelResult = await db.query(userId, `
            SELECT * FROM channels WHERE user_id = $1
        `, [userId]);
        
        const channel = channelResult.rows[0] || {};

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
            posts: postsResult.rows,
            isFollowing
        };

        res.json(data);
    } catch (error) {
        logError(error, 'Get profile');
        res.status(500).json({ error: 'خطا در دریافت پروفایل' });
    }
});

// ============================================================
// بخش ۸: API فالو و آنفالو
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

        const dbInstance = db.getDb();
        const transaction = dbInstance.transaction(() => {
            const existing = dbInstance.prepare(`
                SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?
            `).get(followerId, followingId);
            
            if (existing) {
                return { success: true, alreadyFollowing: true };
            }

            dbInstance.prepare(`
                INSERT INTO follows (follower_id, following_id, created_at) 
                VALUES (?, ?, CURRENT_TIMESTAMP)
            `).run(followerId, followingId);
            
            dbInstance.prepare(`
                UPDATE channels 
                SET followers_count = followers_count + 1, updated_at = CURRENT_TIMESTAMP 
                WHERE user_id = ?
            `).run(followingId);

            return { success: true };
        });

        const result = transaction();
        
        if (result.success && !result.alreadyFollowing) {
            const assistant = new IntelligentAssistant(followerId, db);
            await assistant.updateUserActivity('follow');
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
        
        const dbInstance = db.getDb();
        const transaction = dbInstance.transaction(() => {
            dbInstance.prepare(`
                DELETE FROM follows WHERE follower_id = ? AND following_id = ?
            `).run(followerId, followingId);
            
            dbInstance.prepare(`
                UPDATE channels 
                SET followers_count = MAX(followers_count - 1, 0), updated_at = CURRENT_TIMESTAMP 
                WHERE user_id = ?
            `).run(followingId);
        });

        transaction();
        res.json({ success: true });
    } catch (error) {
        logError(error, 'Unfollow');
        res.status(500).json({ success: false, error: 'خطا در آنفالو کردن' });
    }
});

// ============================================================
// بخش ۹: API پست‌ها
// ============================================================

app.post('/api/post/create', authenticate, async (req, res) => {
    try {
        const { userId, content, mediaUrl, mediaType } = req.body;
        
        if (!content || !content.trim()) {
            return res.status(400).json({ 
                success: false, 
                error: 'متن پست الزامی است' 
            });
        }

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

        await db.query(userId, `
            INSERT INTO posts (
                id, channel_id, content, media_url, media_type, 
                is_published, published_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [postId, channelId, content.trim(), mediaUrl || null, type]);

        await db.query(userId, `
            UPDATE channels 
            SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE user_id = $1
        `, [userId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('post');
        const boost = await assistant.boostVisibility();

        res.json({ 
            success: true, 
            postId, 
            boost
        });
    } catch (error) {
        logError(error, 'Create post');
        res.status(500).json({ success: false, error: 'خطا در انتشار پست' });
    }
});

app.get('/api/channel/:userId/posts', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;

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

        res.json(result.rows);
    } catch (error) {
        logError(error, 'Get channel posts');
        res.status(500).json({ error: 'خطا در دریافت پست‌های کانال' });
    }
});

app.get('/api/post/:postId/detail', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        const viewerId = req.userId;

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
        
        let liked = false;
        if (viewerId) {
            const likeCheck = await db.query(postId, `
                SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2
            `, [postId, viewerId]);
            liked = likeCheck.rows.length > 0;
        }

        await db.query(postId, `
            UPDATE posts SET views = views + 1 WHERE id = $1
        `, [postId]);

        res.json({ ...post, is_liked: liked });
    } catch (error) {
        logError(error, 'Get post detail');
        res.status(500).json({ error: 'خطا در دریافت جزئیات پست' });
    }
});

// ============================================================
// بخش ۱۰: API لایک و کامنت
// ============================================================

app.post('/api/post/:postId/like', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId } = req.body;

        const dbInstance = db.getDb();
        let liked, likes;
        
        const transaction = dbInstance.transaction(() => {
            const existing = dbInstance.prepare(`
                SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?
            `).get(postId, userId);
            
            if (existing) {
                dbInstance.prepare(`
                    DELETE FROM post_likes WHERE post_id = ? AND user_id = ?
                `).run(postId, userId);
                
                dbInstance.prepare(`
                    UPDATE posts SET likes = MAX(likes - 1, 0), updated_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                `).run(postId);
                
                liked = false;
            } else {
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

        const id = generateId();
        
        await db.query(userId, `
            INSERT INTO post_comments (id, post_id, user_id, text, created_at, updated_at) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [id, postId, userId, text.trim()]);

        await db.query(postId, `
            UPDATE posts SET comments = comments + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
        `, [postId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('comment');

        const userResult = await db.query(userId, 
            `SELECT name, avatar FROM users WHERE id = $1`, 
            [userId]
        );
        
        const user = userResult.rows[0] || { name: 'کاربر', avatar: null };

        const commentData = {
            id,
            userId,
            text: text.trim(),
            name: user.name,
            avatar: user.avatar,
            created_at: new Date().toISOString()
        };

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
// بخش ۱۱: API اکسپلور
// ============================================================

app.get('/api/explore', authenticate, async (req, res) => {
    try {
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
        
        res.json(items);
    } catch (error) {
        logError(error, 'Get explore');
        res.status(500).json({ error: 'خطا در دریافت اکسپلور' });
    }
});

// ============================================================
// بخش ۱۲: API جستجو
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
// بخش ۱۳: API چت خصوصی
// ============================================================

app.post('/api/chat/save', authenticate, async (req, res) => {
    try {
        const { from, to, message } = req.body;
        
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'متن پیام الزامی است' });
        }

        const id = generateId();
        
        await db.query(from, `
            INSERT INTO messages (id, from_user, to_user, message, is_read, created_at) 
            VALUES ($1, $2, $3, $4, 0, CURRENT_TIMESTAMP)
        `, [id, from, to, message.trim()]);

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
// بخش ۱۴: API دستیار هوشمند
// ============================================================

app.post('/api/assistant/train', authenticate, async (req, res) => {
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

app.post('/api/assistant/keyword', authenticate, async (req, res) => {
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

        const qaResult = await db.query(userId, `
            SELECT question, answer, created_at 
            FROM assistant_training 
            WHERE user_id = $1 AND type = 'qa'
            ORDER BY created_at DESC
            LIMIT 50
        `, [userId]);

        const keywordResult = await db.query(userId, `
            SELECT keyword, response, created_at 
            FROM assistant_training 
            WHERE user_id = $1 AND type = 'keyword'
            ORDER BY created_at DESC
            LIMIT 50
        `, [userId]);

        const assistant = new IntelligentAssistant(userId, db);
        const stats = await assistant.getStats();

        res.json({
            qa: qaResult.rows,
            keywords: keywordResult.rows,
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

// ============================================================
// بخش ۱۵: API مدیریت (Admin)
// ============================================================

app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const dbInstance = db.getDb();
        
        const users = dbInstance.prepare(`SELECT COUNT(*) as total FROM users`).get();
        const posts = dbInstance.prepare(`SELECT COUNT(*) as total FROM posts WHERE is_published = 1`).get();
        const channels = dbInstance.prepare(`SELECT COUNT(*) as total FROM channels`).get();
        const messages = dbInstance.prepare(`SELECT COUNT(*) as total FROM messages`).get();
        const follows = dbInstance.prepare(`SELECT COUNT(*) as total FROM follows`).get();
        const comments = dbInstance.prepare(`SELECT COUNT(*) as total FROM post_comments`).get();
        
        res.json({
            users: users?.total || 0,
            posts: posts?.total || 0,
            channels: channels?.total || 0,
            messages: messages?.total || 0,
            follows: follows?.total || 0,
            comments: comments?.total || 0
        });
    } catch (error) {
        logError(error, 'Admin stats');
        res.status(500).json({ error: 'خطا در دریافت آمار' });
    }
});

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
            unban: `UPDATE users SET role = 'user', updated_at = CURRENT_TIMESTAMP WHERE id = $1`
        };
        
        if (!actions[action]) {
            return res.status(400).json({ error: 'عملیات نامعتبر' });
        }
        
        await db.query(null, actions[action], [userId]);
        
        res.json({ 
            success: true, 
            message: `عملیات ${action} با موفقیت انجام شد` 
        });
    } catch (error) {
        logError(error, 'Admin user action');
        res.status(500).json({ error: 'خطا در انجام عملیات' });
    }
});

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

app.post('/api/admin/post/delete', isAdmin, async (req, res) => {
    try {
        const { postId } = req.body;
        
        if (!postId) {
            return res.status(400).json({ error: 'شناسه پست الزامی است' });
        }
        
        await db.query(null, `DELETE FROM posts WHERE id = $1`, [postId]);
        
        res.json({ 
            success: true, 
            message: 'پست با موفقیت حذف شد' 
        });
    } catch (error) {
        logError(error, 'Admin delete post');
        res.status(500).json({ error: 'خطا در حذف پست' });
    }
});

app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    try {
        const { message, title } = req.body;
        
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'متن پیام الزامی است' });
        }

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
// بخش ۱۶: WebSocket
// ============================================================

io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    socket.on('join', (userId) => {
        if (!userId) return;
        
        const rooms = Array.from(socket.rooms);
        rooms.forEach(room => {
            if (room !== socket.id) {
                socket.leave(room);
            }
        });
        
        socket.join(`user_${userId}`);
        socket.userId = userId;
        
        console.log(`👤 User ${userId} joined room`);
    });

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

            io.to(`user_${to}`).emit('new_message', { 
                from, 
                to, 
                message: message.trim(), 
                timestamp 
            });
            
            socket.emit('message_sent', { 
                success: true, 
                timestamp,
                messageId: id
            });

        } catch (error) {
            logError(error, 'WebSocket private message');
            socket.emit('message_sent', { 
                success: false, 
                error: 'خطا در ذخیره پیام' 
            });
        }
    });

    socket.on('typing', (data) => {
        const { from, to } = data;
        if (from && to) {
            socket.to(`user_${to}`).emit('user_typing', { from });
        }
    });

    socket.on('disconnect', () => {
        const userId = socket.userId;
        console.log(`🔌 Client disconnected: ${socket.id} (User: ${userId})`);
    });

    socket.on('error', (error) => {
        logError(error, 'WebSocket error');
    });
});

// ============================================================
// بخش ۱۷: مسیرهای استاتیک و ریشه
// ============================================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// بخش ۱۸: مدیریت خطاها
// ============================================================

app.use((req, res) => {
    res.status(404).json({ 
        error: 'مسیر مورد نظر یافت نشد' 
    });
});

app.use((err, req, res, next) => {
    logError(err, 'Server error');
    res.status(500).json({ 
        error: 'خطای داخلی سرور',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ============================================================
// بخش ۱۹: راه‌اندازی سرور
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

        await db.initTables();
        console.log('✅ Database ready');

        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📍 http://localhost:${PORT}`);
            console.log(`👑 Admin: ${ADMIN_ID}`);
            console.log(`📊 Mode: ${process.env.NODE_ENV || 'development'}`);
        });

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();

module.exports = { app, server, io, db };

// ============================================================
// پایان فایل server.js
// ============================================================