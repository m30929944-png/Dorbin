// ============================================
// server.js - نسخه نهایی قدرتمند با تمام قابلیت‌ها
// ============================================

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
const DatabaseManager = require('./database');
const IntelligentAssistant = require('./assistant_logic');

// ============================================
// تنظیمات سرور
// ============================================
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8,
    transports: ['websocket', 'polling']
});

// ============================================
// امنیت و بهینه‌سازی
// ============================================
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false
}));

app.use(compression({
    level: 9,
    threshold: 1024,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }
}));

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'userId'],
    credentials: true
}));

// محدودیت نرخ درخواست
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 500,
    message: { error: 'تعداد درخواست‌ها بیش از حد مجاز است' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/', limiter);

// محدودیت سنگین‌تر برای عملیات حساس
const strictLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'درخواست‌های شما بیش از حد زیاد است، لطفاً کمی صبر کنید' }
});
app.use('/api/admin/', strictLimiter);
app.use('/api/post/create', strictLimiter);
app.use('/api/assistant/train', strictLimiter);

app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(__dirname, {
    maxAge: '7d',
    etag: true,
    immutable: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

// ============================================
// دیتابیس
// ============================================
const db = new DatabaseManager();

// ============================================
// کش‌ها
// ============================================
const profileCache = new Map();
const exploreCache = new Map();
const PROFILE_CACHE_TTL = 30000;
const EXPLORE_CACHE_TTL = 15000;
const POST_CACHE_TTL = 30000;
const postCache = new Map();

// ============================================
// توابع کمکی و اعتبارسنجی
// ============================================
function generateId() {
    return crypto.randomUUID();
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeInput(str) {
    if (!str) return '';
    return str.replace(/[<>]/g, '').trim();
}

function isAdmin(req, res, next) {
    const userId = req.headers.userid || req.body.userId || req.query.userId;
    if (userId === 'admin_milad') {
        return next();
    }
    res.status(403).json({ error: 'دسترسی غیرمجاز - فقط مدیر سیستم' });
}

function checkUserBlocked(req, res, next) {
    const userId = req.headers.userid || req.body.userId || req.query.userId;
    if (!userId) return next();
    
    try {
        const blocked = db.getDb().prepare(`
            SELECT 1 FROM blocked_users 
            WHERE user_id = ? AND expires_at > datetime('now')
        `).get(userId);
        
        if (blocked) {
            return res.status(403).json({ error: 'حساب کاربری شما به طور موقت مسدود شده است' });
        }
    } catch (e) {}
    next();
}

// ============================================
// API احراز هویت و ثبت‌نام
// ============================================
app.post('/api/user/register', async (req, res) => {
    try {
        const { email, password, name, avatar } = req.body;
        
        if (!email || !isValidEmail(email)) {
            return res.status(400).json({ success: false, error: 'ایمیل معتبر وارد کنید' });
        }
        if (!password || password.length < 6) {
            return res.status(400).json({ success: false, error: 'رمز عبور حداقل ۶ کاراکتر' });
        }
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'نام نمایشی الزامی است' });
        }

        // بررسی وجود ایمیل
        const existing = await db.query(null, `SELECT id FROM users WHERE email = $1`, [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'این ایمیل قبلاً ثبت شده است' });
        }

        // تعیین ID کاربر
        let id;
        const nameLower = name.trim().toLowerCase();
        if (email === 'milad.yari1377m@gmail.com' && password === '(mortza)#1377[@nik]=admin<') {
            id = 'admin_milad';
        } else {
            id = 'user_' + crypto.randomBytes(8).toString('hex');
        }

        const channelId = 'channel_' + id;
        const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

        const dbInstance = db.getDb();
        const transaction = dbInstance.transaction(() => {
            dbInstance.prepare(`
                INSERT INTO users (id, name, email, password, avatar, role, is_verified, score, created_at) 
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
            `).run(id, name.trim(), email, hashedPassword, avatar || null, id === 'admin_milad' ? 'admin' : 'user', id === 'admin_milad' ? 999999 : 0);
            
            dbInstance.prepare(`
                INSERT INTO channels (id, user_id, name, boost_level, created_at) 
                VALUES (?, ?, ?, 'normal', CURRENT_TIMESTAMP)
            `).run(channelId, id, name.trim() + ' - کانال');
        });

        transaction();

        const u = await db.query(id, `
            SELECT id, name, avatar, score, role, email, is_verified 
            FROM users WHERE id = $1
        `, [id]);

        res.json({ 
            success: true, 
            user: u.rows[0],
            message: id === 'admin_milad' ? '✅ مدیر سیستم با موفقیت وارد شد' : '✅ ثبت‌نام با موفقیت انجام شد'
        });

    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'ایمیل و رمز عبور الزامی است' });
        }

        const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
        const result = await db.query(null, `
            SELECT id, name, avatar, score, role, email, is_verified 
            FROM users WHERE email = $1 AND password = $2
        `, [email, hashedPassword]);

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, error: 'ایمیل یا رمز عبور اشتباه است' });
        }

        const user = result.rows[0];
        res.json({ 
            success: true, 
            user,
            message: '✅ خوش آمدید ' + user.name
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// API کاربر
// ============================================
app.get('/api/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const u = await db.query(id, `
            SELECT id, name, avatar, score, bio, role, is_verified, email, created_at 
            FROM users WHERE id = $1
        `, [id]);
        
        if (u.rows.length === 0) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }
        
        const ch = await db.query(id, `
            SELECT followers_count, posts_count, boost_level 
            FROM channels WHERE user_id = $1
        `, [id]);
        
        res.json({ 
            ...u.rows[0], 
            followers: ch.rows[0]?.followers_count || 0,
            posts: ch.rows[0]?.posts_count || 0,
            boostLevel: ch.rows[0]?.boost_level || 'normal'
        });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/user/avatar', async (req, res) => {
    try {
        const { userId, avatar } = req.body;
        await db.query(userId, `
            UPDATE users SET avatar = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [avatar, userId]);
        
        profileCache.clear();
        res.json({ success: true });
    } catch (error) {
        console.error('Avatar update error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/bio', async (req, res) => {
    try {
        const { userId, bio } = req.body;
        await db.query(userId, `
            UPDATE users SET bio = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [sanitizeInput(bio), userId]);
        
        profileCache.clear();
        res.json({ success: true });
    } catch (error) {
        console.error('Bio update error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// پروفایل عمومی با کش
// ============================================
app.get('/api/profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { viewerId } = req.query;
        
        const cacheKey = `${userId}_${viewerId || 'guest'}`;
        const cached = profileCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < PROFILE_CACHE_TTL) {
            return res.json(cached.data);
        }

        const u = await db.query(userId, `
            SELECT id, name, avatar, bio, score, is_verified, created_at, role 
            FROM users WHERE id = $1
        `, [userId]);
        
        if (u.rows.length === 0) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }

        const ch = await db.query(userId, `
            SELECT * FROM channels WHERE user_id = $1
        `, [userId]);
        const channel = ch.rows[0];

        const posts = await db.query(userId, `
            SELECT p.*, c.name as channel_name, u.name as user_name, u.avatar as user_avatar
            FROM posts p 
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC LIMIT 30
        `, [userId]);

        let isFollowing = false;
        let isBlocked = false;
        if (viewerId && viewerId !== userId) {
            const f = await db.query(userId, `
                SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2
            `, [viewerId, userId]);
            isFollowing = f.rows.length > 0;
            
            const b = await db.query(userId, `
                SELECT 1 FROM blocked_users WHERE user_id = $1 AND blocked_by = $2
            `, [userId, viewerId]);
            isBlocked = b.rows.length > 0;
        }

        const data = { 
            user: u.rows[0], 
            channel, 
            posts: posts.rows, 
            isFollowing,
            isBlocked
        };
        
        profileCache.set(cacheKey, { data, timestamp: Date.now() });
        res.json(data);
        
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// فالو / آنفالو با تراکنش
// ============================================
app.post('/api/follow', async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        
        if (!followerId || !followingId) {
            return res.status(400).json({ success: false, error: 'اطلاعات ناقص است' });
        }
        
        if (followerId === followingId) {
            return res.status(400).json({ success: false, error: 'نمی‌توانید خودتان را فالو کنید' });
        }

        // بررسی مسدودیت
        const blocked = db.getDb().prepare(`
            SELECT 1 FROM blocked_users WHERE user_id = ? AND blocked_by = ?
        `).get(followingId, followerId);
        
        if (blocked) {
            return res.status(403).json({ success: false, error: 'این کاربر شما را مسدود کرده است' });
        }

        const dbInstance = db.getDb();
        let result;
        
        const transaction = dbInstance.transaction(() => {
            const existing = dbInstance.prepare(`
                SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?
            `).get(followerId, followingId);
            
            if (existing) return { success: true, alreadyFollowing: true };

            dbInstance.prepare(`
                INSERT INTO follows (follower_id, following_id, created_at) 
                VALUES (?, ?, CURRENT_TIMESTAMP)
            `).run(followerId, followingId);
            
            dbInstance.prepare(`
                UPDATE channels SET followers_count = followers_count + 1, updated_at = CURRENT_TIMESTAMP 
                WHERE user_id = ?
            `).run(followingId);

            return { success: true };
        });

        result = transaction();
        
        if (result.success && !result.alreadyFollowing) {
            const assistant = new IntelligentAssistant(followerId, db);
            await assistant.updateUserActivity('follow');
            profileCache.clear();
            exploreCache.clear();
            
            // ارسال نوتیفیکیشن
            const user = await db.query(followerId, `SELECT name FROM users WHERE id = $1`, [followerId]);
            if (user.rows.length > 0) {
                await db.query(followingId, `
                    INSERT INTO system_notifications (id, user_id, title, message, type, created_at) 
                    VALUES (?, ?, '👤 فالو جدید', ?, 'follow', CURRENT_TIMESTAMP)
                `, [generateId(), followingId, `${user.rows[0].name} شما را فالو کرد`]);
                
                io.to(`user_${followingId}`).emit('broadcast', {
                    title: '👤 فالو جدید',
                    message: `${user.rows[0].name} شما را فالو کرد`
                });
            }
        }
        
        res.json(result);
    } catch (error) {
        console.error('Follow error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/unfollow', async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        
        if (!followerId || !followingId) {
            return res.status(400).json({ success: false, error: 'اطلاعات ناقص است' });
        }
        
        const dbInstance = db.getDb();
        const transaction = dbInstance.transaction(() => {
            dbInstance.prepare(`
                DELETE FROM follows WHERE follower_id = ? AND following_id = ?
            `).run(followerId, followingId);
            
            dbInstance.prepare(`
                UPDATE channels SET followers_count = MAX(followers_count - 1, 0), updated_at = CURRENT_TIMESTAMP 
                WHERE user_id = ?
            `).run(followingId);
        });

        transaction();
        profileCache.clear();
        exploreCache.clear();
        res.json({ success: true });
    } catch (error) {
        console.error('Unfollow error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// پست‌ها با پشتیبانی ویدیو و کش
// ============================================
app.post('/api/post/create', async (req, res) => {
    try {
        const { userId, content, mediaUrl, mediaType } = req.body;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'شناسه کاربر الزامی است' });
        }
        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, error: 'متن پست الزامی است' });
        }

        const channel = await db.query(userId, `
            SELECT id FROM channels WHERE user_id = $1
        `, [userId]);
        
        if (channel.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });
        }

        const postId = generateId();
        const type = mediaType || 'none';
        
        await db.query(userId, `
            INSERT INTO posts (id, channel_id, content, media_url, media_type, is_published, published_at, created_at)
            VALUES ($1, $2, $3, $4, $5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [postId, channel.rows[0].id, content.trim(), mediaUrl || null, type]);

        await db.query(userId, `
            UPDATE channels SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE user_id = $1
        `, [userId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('post');
        const boost = await assistant.boostVisibility();

        // پاک کردن کش‌ها
        profileCache.clear();
        exploreCache.clear();
        postCache.clear();

        // ارسال نوتیفیکیشن به فالوورها
        const followers = await db.query(userId, `
            SELECT follower_id FROM follows WHERE following_id = $1
        `, [userId]);
        
        for (const f of followers.rows) {
            io.to(`user_${f.follower_id}`).emit('broadcast', {
                title: '📝 پست جدید',
                message: `یک پست جدید در کانال منتشر شد`
            });
        }

        res.json({ success: true, postId, boost });
    } catch (error) {
        console.error('Create post error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/post/:postId', async (req, res) => {
    try {
        const { postId } = req.params;
        
        const cached = postCache.get(postId);
        if (cached && (Date.now() - cached.timestamp) < POST_CACHE_TTL) {
            return res.json(cached.data);
        }
        
        const result = await db.query(postId, `
            SELECT 
                p.*,
                u.id as user_id,
                u.name as user_name,
                u.avatar as user_avatar,
                u.is_verified,
                c.name as channel_name
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE p.id = $1 AND p.is_published = 1
        `, [postId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'پست یافت نشد' });
        }
        
        const post = {
            ...result.rows[0],
            user: {
                id: result.rows[0].user_id,
                name: result.rows[0].user_name,
                avatar: result.rows[0].user_avatar,
                is_verified: result.rows[0].is_verified
            }
        };
        
        postCache.set(postId, { data: post, timestamp: Date.now() });
        res.json(post);
        
        // افزایش بازدید
        await db.query(postId, `UPDATE posts SET views = views + 1 WHERE id = $1`, [postId]);
        
    } catch (error) {
        console.error('Get post error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/post/:postId/view', async (req, res) => {
    try {
        const { postId } = req.params;
        await db.query(postId, `UPDATE posts SET views = views + 1 WHERE id = $1`, [postId]);
        res.json({ success: true });
    } catch (error) {
        console.error('View error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/channel/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await db.query(userId, `
            SELECT 
                p.*,
                c.name as channel_name,
                u.name as user_name,
                u.avatar as user_avatar
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC LIMIT 50
        `, [userId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Channel posts error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// لایک و کامنت
// ============================================
app.post('/api/post/:postId/like', async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'شناسه کاربر الزامی است' });
        }

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
        
        profileCache.clear();
        exploreCache.clear();
        postCache.clear();
        res.json({ success: true, liked, likes });
    } catch (error) {
        console.error('Like error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/post/:postId/comment', async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId, text } = req.body;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'شناسه کاربر الزامی است' });
        }
        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, error: 'متن کامنت الزامی است' });
        }

        const id = generateId();
        await db.query(userId, `
            INSERT INTO post_comments (id, post_id, user_id, text, created_at) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `, [id, postId, userId, sanitizeInput(text)]);
        
        await db.query(postId, `
            UPDATE posts SET comments = comments + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
        `, [postId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('comment');

        const u = await db.query(userId, `
            SELECT name, avatar FROM users WHERE id = $1
        `, [userId]);
        
        profileCache.clear();
        exploreCache.clear();
        postCache.clear();
        
        res.json({ 
            success: true, 
            comment: { 
                id, 
                user_id: userId,
                text: sanitizeInput(text), 
                name: u.rows[0]?.name, 
                avatar: u.rows[0]?.avatar 
            } 
        });
    } catch (error) {
        console.error('Comment error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/post/:postId/comments', async (req, res) => {
    try {
        const { postId } = req.params;
        const result = await db.query(postId, `
            SELECT c.*, u.name, u.avatar FROM post_comments c
            JOIN users u ON u.id = c.user_id
            WHERE c.post_id = $1 ORDER BY c.created_at ASC
        `, [postId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Get comments error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// دستیار هوشمند
// ============================================
app.post('/api/assistant/train', async (req, res) => {
    try {
        const { userId, question, answer } = req.body;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'شناسه کاربر الزامی است' });
        }
        if (!question || !question.trim() || !answer || !answer.trim()) {
            return res.status(400).json({ success: false, error: 'سوال و جواب کامل وارد کنید' });
        }

        const id = generateId();
        await db.query(userId, `
            INSERT INTO assistant_training (id, user_id, type, question, answer, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [id, userId, 'qa', sanitizeInput(question), sanitizeInput(answer)]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();
        assistant.clearCache();

        res.json({ 
            success: true, 
            message: 'آموزش با موفقیت ثبت شد', 
            boost,
            qa: { id, question: sanitizeInput(question), answer: sanitizeInput(answer) }
        });
    } catch (error) {
        console.error('Train error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/assistant/keyword', async (req, res) => {
    try {
        const { userId, keyword, response } = req.body;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'شناسه کاربر الزامی است' });
        }
        if (!keyword || !keyword.trim() || !response || !response.trim()) {
            return res.status(400).json({ success: false, error: 'کلمه کلیدی و پاسخ کامل وارد کنید' });
        }

        const id = generateId();
        await db.query(userId, `
            INSERT INTO assistant_training (id, user_id, type, keyword, response, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [id, userId, 'keyword', sanitizeInput(keyword), sanitizeInput(response)]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();
        assistant.clearCache();

        res.json({ 
            success: true, 
            message: 'کلمه کلیدی با موفقیت ثبت شد', 
            boost,
            keyword: { id, keyword: sanitizeInput(keyword), response: sanitizeInput(response) }
        });
    } catch (error) {
        console.error('Keyword error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/assistant/schedule', async (req, res) => {
    try {
        const { userId, posts } = req.body;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'شناسه کاربر الزامی است' });
        }
        if (!posts || !Array.isArray(posts) || posts.length === 0) {
            return res.status(400).json({ success: false, error: 'لیست پست‌ها الزامی است' });
        }
        
        const channel = await db.query(userId, `
            SELECT id FROM channels WHERE user_id = $1
        `, [userId]);
        
        if (channel.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });
        }

        const assistant = new IntelligentAssistant(userId, db);
        const scheduled = await assistant.schedulePosts(posts);

        res.json({ 
            success: true, 
            message: `${posts.length} پست با موفقیت زمان‌بندی شد`, 
            posts: scheduled 
        });
    } catch (error) {
        console.error('Schedule error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/assistant/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const qa = await db.query(userId, `
            SELECT id, question, answer FROM assistant_training 
            WHERE user_id = $1 AND type = 'qa' ORDER BY created_at DESC LIMIT 50
        `, [userId]);

        const keywords = await db.query(userId, `
            SELECT id, keyword, response FROM assistant_training 
            WHERE user_id = $1 AND type = 'keyword' ORDER BY created_at DESC LIMIT 50
        `, [userId]);

        const posts = await db.query(userId, `
            SELECT p.*, c.name as channel_name 
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 0
            ORDER BY p.scheduled_time ASC
        `, [userId]);

        const assistant = new IntelligentAssistant(userId, db);
        const stats = await assistant.getStats();

        res.json({ 
            qa: qa.rows, 
            keywords: keywords.rows, 
            posts: posts.rows, 
            stats,
            assistantStatus: assistant.getStatus()
        });
    } catch (error) {
        console.error('Assistant data error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/assistant/chat/:targetUserId', async (req, res) => {
    try {
        const { targetUserId } = req.params;
        const { message } = req.body;
        
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'متن پیام الزامی است' });
        }

        const assistant = new IntelligentAssistant(targetUserId, db);
        const reply = await assistant.autoReply(message);

        res.json({ 
            reply: reply || 'دستیار هنوز برای این موضوع آموزش ندیده 🤖',
            confidence: reply ? 0.85 : 0
        });
    } catch (error) {
        console.error('Assistant chat error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// اکسپلور با کش
// ============================================
app.get('/api/explore', async (req, res) => {
    try {
        const cached = exploreCache.get('explore');
        if (cached && (Date.now() - cached.timestamp) < EXPLORE_CACHE_TTL) {
            return res.json(cached.data);
        }

        const result = await db.query(null, `
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
                    WHERE p.channel_id = c.id AND p.is_published = 1
                    ORDER BY p.created_at DESC
                    LIMIT 10
                ) as recent_posts
            FROM channels c
            JOIN users u ON u.id = c.user_id
            WHERE c.posts_count > 0 AND u.role != 'banned'
            ORDER BY c.activity_score DESC, c.followers_count DESC, c.posts_count DESC
            LIMIT 50
        `);
        
        const items = result.rows.map(row => ({
            ...row,
            recent_posts: row.recent_posts ? JSON.parse(row.recent_posts) : []
        }));
        
        exploreCache.set('explore', { data: items, timestamp: Date.now() });
        res.json(items);
    } catch (error) {
        console.error('Explore error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) return res.json([]);
        
        const result = await db.query(null, `
            SELECT id, name, avatar, 'user' as type, is_verified, score FROM users 
            WHERE name LIKE $1 AND id != 'admin_milad' AND role != 'banned'
            UNION
            SELECT id, name, NULL as avatar, 'channel' as type, 0 as is_verified, 0 as score FROM channels 
            WHERE name LIKE $1
            LIMIT 20
        `, [`%${q}%`]);
        res.json(result.rows);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// چت خصوصی با تاریخچه کامل و رمزنگاری
// ============================================
app.post('/api/chat/save', async (req, res) => {
    try {
        const { from, to, message } = req.body;
        
        if (!from || !to || !message) {
            return res.status(400).json({ success: false, error: 'اطلاعات ناقص است' });
        }
        
        const id = generateId();
        // رمزنگاری پیام
        const encrypted = db.encrypt(message);
        
        await db.query(from, `
            INSERT INTO messages (id, from_user, to_user, message, encrypted, created_at) 
            VALUES ($1, $2, $3, $4, 1, CURRENT_TIMESTAMP)
        `, [id, from, to, encrypted]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Save message error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/chat/history/:userId/:targetId', async (req, res) => {
    try {
        const { userId, targetId } = req.params;
        const result = await db.query(userId, `
            SELECT * FROM messages 
            WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
            ORDER BY created_at ASC LIMIT 300
        `, [userId, targetId]);
        
        // رمزگشایی پیام‌ها
        const decrypted = result.rows.map(msg => ({
            ...msg,
            message: msg.encrypted ? db.decrypt(msg.message) : msg.message
        }));
        
        res.json(decrypted);
    } catch (error) {
        console.error('Chat history error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/chat/list/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
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
                    SELECT encrypted FROM messages 
                    WHERE (from_user = u.id AND to_user = $1) OR (from_user = $1 AND to_user = u.id)
                    ORDER BY created_at DESC LIMIT 1
                ) as lastEncrypted,
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
            AND u.role != 'banned'
            ORDER BY lastTime DESC
        `, [userId]);
        
        // رمزگشایی آخرین پیام
        const chats = result.rows.map(chat => ({
            ...chat,
            lastMessage: chat.lastEncrypted ? db.decrypt(chat.lastMessage) : chat.lastMessage
        }));
        
        res.json(chats);
    } catch (error) {
        console.error('Chat list error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/chat/read', async (req, res) => {
    try {
        const { userId, fromUser } = req.body;
        await db.query(userId, `
            UPDATE messages SET is_read = 1 
            WHERE from_user = $1 AND to_user = $2 AND is_read = 0
        `, [fromUser, userId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// پنل مدیریت کامل
// ============================================
app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const users = await db.query(null, `
            SELECT u.*, c.followers_count, c.posts_count, c.boost_level,
                   (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers,
                   (SELECT COUNT(*) FROM posts p JOIN channels ch ON p.channel_id = ch.id WHERE ch.user_id = u.id AND p.is_published = 1) as total_posts
            FROM users u
            LEFT JOIN channels c ON u.id = c.user_id
            WHERE u.role != 'admin'
            ORDER BY u.created_at DESC
        `);
        res.json(users.rows);
    } catch (error) {
        console.error('Admin users error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/user/ban', isAdmin, async (req, res) => {
    try {
        const { userId, reason } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'شناسه کاربر الزامی است' });
        }
        
        await db.query(userId, `
            UPDATE users SET role = 'banned', updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
        `, [userId]);
        
        await db.query(userId, `
            INSERT INTO system_notifications (id, user_id, title, message, type, created_at) 
            VALUES (?, ?, '⛔ حساب شما مسدود شد', ?, 'warning', CURRENT_TIMESTAMP)
        `, [generateId(), userId, reason || 'حساب کاربری شما توسط مدیریت مسدود شده است']);
        
        io.to(`user_${userId}`).emit('broadcast', {
            title: '⛔ حساب مسدود شد',
            message: 'حساب کاربری شما توسط مدیریت مسدود شده است'
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Ban error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/user/unban', isAdmin, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'شناسه کاربر الزامی است' });
        }
        
        await db.query(userId, `
            UPDATE users SET role = 'user', updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
        `, [userId]);
        
        await db.query(userId, `
            INSERT INTO system_notifications (id, user_id, title, message, type, created_at) 
            VALUES (?, ?, '✅ حساب شما فعال شد', 'حساب کاربری شما توسط مدیریت فعال شد', 'general', CURRENT_TIMESTAMP)
        `, [generateId(), userId]);
        
        io.to(`user_${userId}`).emit('broadcast', {
            title: '✅ حساب فعال شد',
            message: 'حساب کاربری شما توسط مدیریت فعال شد'
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Unban error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/user/verify', isAdmin, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'شناسه کاربر الزامی است' });
        }
        
        await db.query(userId, `
            UPDATE users SET is_verified = 1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
        `, [userId]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Verify error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/user/warn', isAdmin, async (req, res) => {
    try {
        const { userId, reason } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'شناسه کاربر الزامی است' });
        }
        
        await db.query(userId, `
            INSERT INTO system_notifications (id, user_id, title, message, type, created_at) 
            VALUES (?, ?, '⚠️ اخطار از مدیریت', ?, 'warning', CURRENT_TIMESTAMP)
        `, [generateId(), userId, reason || 'رفتار نامناسب در سیستم']);
        
        io.to(`user_${userId}`).emit('broadcast', {
            title: '⚠️ اخطار',
            message: 'شما یک اخطار از مدیریت دریافت کردید'
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Warn error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/user/addscore', isAdmin, async (req, res) => {
    try {
        const { userId, points } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'شناسه کاربر الزامی است' });
        }
        
        const p = parseInt(points) || 10;
        await db.query(userId, `
            UPDATE users SET score = score + $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [p, userId]);
        
        res.json({ success: true, pointsAdded: p });
    } catch (error) {
        console.error('Add score error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/post/delete', isAdmin, async (req, res) => {
    try {
        const { postId } = req.body;
        if (!postId) {
            return res.status(400).json({ error: 'شناسه پست الزامی است' });
        }
        
        // دریافت اطلاعات پست برای کاهش count
        const post = await db.query(postId, `
            SELECT channel_id FROM posts WHERE id = $1
        `, [postId]);
        
        await db.query(postId, `DELETE FROM posts WHERE id = $1`, [postId]);
        
        if (post.rows.length > 0) {
            await db.query(postId, `
                UPDATE channels SET posts_count = MAX(posts_count - 1, 0), updated_at = CURRENT_TIMESTAMP 
                WHERE id = $1
            `, [post.rows[0].channel_id]);
        }
        
        profileCache.clear();
        exploreCache.clear();
        postCache.clear();
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete post error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    try {
        const { message, title } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'متن پیام الزامی است' });
        }
        
        const users = await db.query(null, `SELECT id FROM users WHERE role != 'banned'`);
        
        const dbInstance = db.getDb();
        const insert = dbInstance.prepare(`
            INSERT INTO system_notifications (id, user_id, title, message, type, created_at) 
            VALUES (?, ?, ?, ?, 'broadcast', CURRENT_TIMESTAMP)
        `);
        
        const transaction = dbInstance.transaction(() => {
            for (const user of users.rows) {
                const id = generateId();
                insert.run(id, user.id, title || '📢 اعلان سیستمی', message);
                io.to(`user_${user.id}`).emit('broadcast', { 
                    title: title || '📢 اعلان سیستمی', 
                    message 
                });
            }
        });
        
        transaction();
        res.json({ 
            success: true, 
            message: `✅ پیام به ${users.rows.length} کاربر ارسال شد` 
        });
    } catch (error) {
        console.error('Broadcast error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const users = await db.query(null, `SELECT COUNT(*) as total FROM users WHERE role != 'admin'`);
        const posts = await db.query(null, `SELECT COUNT(*) as total FROM posts WHERE is_published = 1`);
        const channels = await db.query(null, `SELECT COUNT(*) as total FROM channels`);
        const messages = await db.query(null, `SELECT COUNT(*) as total FROM messages`);
        const follows = await db.query(null, `SELECT COUNT(*) as total FROM follows`);
        const comments = await db.query(null, `SELECT COUNT(*) as total FROM post_comments`);
        const trainings = await db.query(null, `SELECT COUNT(*) as total FROM assistant_training`);
        const reports = await db.query(null, `SELECT COUNT(*) as total FROM reports WHERE status = 'pending'`);
        const online = await db.query(null, `SELECT COUNT(*) as total FROM users WHERE role != 'admin' AND strftime('%s', 'now') - strftime('%s', updated_at) < 300`);
        
        res.json({
            users: users.rows[0]?.total || 0,
            posts: posts.rows[0]?.total || 0,
            channels: channels.rows[0]?.total || 0,
            messages: messages.rows[0]?.total || 0,
            follows: follows.rows[0]?.total || 0,
            comments: comments.rows[0]?.total || 0,
            trainings: trainings.rows[0]?.total || 0,
            reports: reports.rows[0]?.total || 0,
            online: online.rows[0]?.total || 0
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/channels', isAdmin, async (req, res) => {
    try {
        const channels = await db.query(null, `
            SELECT c.*, u.name as user_name, u.avatar, u.email
            FROM channels c
            JOIN users u ON c.user_id = u.id
            ORDER BY c.followers_count DESC
        `);
        res.json(channels.rows);
    } catch (error) {
        console.error('Admin channels error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// الگوریتم‌های هوش مصنوعی - تشخیص رفتارهای نامناسب
// ============================================
async function checkUserBehavior(userId) {
    try {
        // بررسی تعداد آنفالوهای اخیر
        const unfollowData = await db.query(userId, `
            SELECT COUNT(*) as count FROM follows 
            WHERE following_id = $1 AND created_at > datetime('now', '-7 days')
        `, [userId]);
        
        const unfollowCount = unfollowData.rows[0]?.count || 0;
        
        if (unfollowCount > 30) {
            await db.query(userId, `
                INSERT INTO system_notifications (id, user_id, title, message, type, created_at) 
                VALUES (?, ?, '⚠️ هشدار سیستمی', 
                'تعداد زیادی از کاربران شما را در ۷ روز اخیر آنفالو کرده‌اند (${unfollowCount} نفر). لطفاً رفتار خود را بررسی کنید.',
                'warning', CURRENT_TIMESTAMP)
            `, [generateId(), userId]);
        }
        
        // بررسی پست‌های پرگزارش
        const reportedPosts = await db.query(userId, `
            SELECT p.id, COUNT(r.id) as report_count
            FROM posts p
            JOIN reports r ON r.target_id = p.id
            WHERE p.channel_id IN (SELECT id FROM channels WHERE user_id = $1)
            AND r.target_type = 'post'
            AND r.status = 'pending'
            AND r.created_at > datetime('now', '-7 days')
            GROUP BY p.id
            HAVING COUNT(r.id) >= 5
        `, [userId]);
        
        for (const post of reportedPosts.rows) {
            if (post.report_count >= 10) {
                // ارسال اخطار حذف
                await db.query(userId, `
                    INSERT INTO system_notifications (id, user_id, title, message, type, created_at) 
                    VALUES (?, ?, '⚠️ اخطار حذف پست', 
                    'پست شما بیش از ${post.report_count} بار گزارش شده است. لطفاً ظرف ۲۴ ساعت آن را حذف کنید، در غیر این صورت حساب شما مسدود خواهد شد.',
                    'danger', CURRENT_TIMESTAMP)
                `, [generateId(), userId]);
                
                // مسدود کردن موقت اگر بیش از ۲۰ گزارش
                if (post.report_count > 20) {
                    await db.query(userId, `
                        INSERT INTO blocked_users (user_id, blocked_by, reason, expires_at, created_at) 
                        VALUES (?, 'admin_milad', 'گزارش بیش از حد پست‌ها', datetime('now', '+24 hours'), CURRENT_TIMESTAMP)
                    `, [userId]);
                    
                    await db.query(userId, `
                        UPDATE users SET role = 'banned' WHERE id = $1
                    `, [userId]);
                }
            }
        }
        
        // بررسی فعالیت مشکوک
        const suspiciousActivity = await db.query(userId, `
            SELECT COUNT(*) as count FROM posts 
            WHERE channel_id IN (SELECT id FROM channels WHERE user_id = $1)
            AND created_at > datetime('now', '-1 hour')
        `, [userId]);
        
        if (suspiciousActivity.rows[0]?.count > 20) {
            await db.query(userId, `
                INSERT INTO system_notifications (id, user_id, title, message, type, created_at) 
                VALUES (?, ?, '⚠️ فعالیت مشکوک', 
                'تعداد پست‌های شما در یک ساعت اخیر بسیار بالا است (${suspiciousActivity.rows[0].count} پست). لطفاً سرعت انتشار را کاهش دهید.',
                'warning', CURRENT_TIMESTAMP)
            `, [generateId(), userId]);
        }
        
    } catch (e) {
        console.error('AI check error for user:', userId, e);
    }
}

// اجرای بررسی‌های هوش مصنوعی هر ۳۰ دقیقه
setInterval(async () => {
    try {
        console.log('🤖 Running AI behavior checks...');
        const users = await db.query(null, `
            SELECT id FROM users WHERE role NOT IN ('admin', 'banned')
        `);
        
        for (const user of users.rows) {
            await checkUserBehavior(user.id);
        }
        console.log(`✅ AI checks completed for ${users.rows.length} users`);
    } catch (e) {
        console.error('AI check error:', e);
    }
}, 1800000);

// ============================================
// گزارش‌دهی پست‌ها
// ============================================
app.post('/api/report', async (req, res) => {
    try {
        const { reporterId, targetId, targetType, reason } = req.body;
        
        if (!reporterId || !targetId || !targetType || !reason) {
            return res.status(400).json({ success: false, error: 'اطلاعات ناقص است' });
        }
        
        const id = generateId();
        await db.query(reporterId, `
            INSERT INTO reports (id, reporter_id, target_id, target_type, reason, status, created_at) 
            VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP)
        `, [id, reporterId, targetId, targetType, sanitizeInput(reason)]);
        
        res.json({ success: true, reportId: id });
    } catch (error) {
        console.error('Report error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// WebSocket با پشتیبانی از میلیون‌ها کاربر
// ============================================
io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
    
    let userId = null;

    socket.on('join', (id) => {
        userId = id;
        socket.join(`user_${id}`);
        socket.join('global');
        console.log(`👤 User ${id} joined room`);
        
        // به‌روزرسانی وضعیت آنلاین
        db.query(id, `UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
    });

    socket.on('private_message', async (data) => {
        const { from, to, message, timestamp } = data;
        
        try {
            const id = generateId();
            const encrypted = db.encrypt(message);
            await db.query(from, `
                INSERT INTO messages (id, from_user, to_user, message, encrypted, created_at) 
                VALUES ($1, $2, $3, $4, 1, CURRENT_TIMESTAMP)
            `, [id, from, to, encrypted]);
            
            // ارسال به گیرنده
            io.to(`user_${to}`).emit('new_message', { 
                from, 
                message, 
                timestamp,
                messageId: id
            });
            
            // تایید ارسال به فرستنده
            io.to(`user_${from}`).emit('message_sent', { 
                success: true, 
                timestamp,
                messageId: id
            });
        } catch (e) {
            console.error('Save message error:', e);
            io.to(`user_${from}`).emit('message_error', { 
                error: 'خطا در ارسال پیام',
                timestamp
            });
        }
    });

    socket.on('typing', (data) => {
        const { from, to } = data;
        io.to(`user_${to}`).emit('user_typing', { from });
    });

    socket.on('message_read', async (data) => {
        const { userId, messageId } = data;
        try {
            await db.query(userId, `
                UPDATE messages SET is_read = 1 WHERE id = $1
            `, [messageId]);
        } catch (e) {}
    });

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
        if (userId) {
            db.query(userId, `UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [userId]);
        }
    });
});

// ============================================
// راه‌اندازی سرور
// ============================================
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await db.initTables();
        console.log('✅ Database ready');
        console.log('✅ Tables created/verified');

        // پاک کردن کش‌های قدیمی هر ۵ دقیقه
        setInterval(() => {
            profileCache.clear();
            if (Math.random() < 0.1) {
                postCache.clear();
                exploreCache.clear();
            }
        }, 300000);

        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📍 http://localhost:${PORT}`);
            console.log(`👑 Admin: milad.yari1377m@gmail.com`);
            console.log(`📊 Mode: ${process.env.NODE_ENV || 'development'}`);
            console.log(`💻 Process: ${process.pid}`);
            console.log(`📦 Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
        });

        // مدیریت خروج
        process.on('SIGINT', async () => {
            console.log('🛑 Shutting down gracefully...');
            await db.close();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            console.log('🛑 Shutting down gracefully...');
            await db.close();
            process.exit(0);
        });

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();

module.exports = { app, server, io };