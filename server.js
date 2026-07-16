const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('./database');
const IntelligentAssistant = require('./assistant_logic');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = socketIO(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8
});
const db = new DatabaseManager();

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors());

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    message: { error: 'تعداد درخواست‌ها بیش از حد مجاز است' }
});
app.use('/api/', limiter);

app.use(bodyParser.json({ limit: '3mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '3mb' }));
app.use(express.static(__dirname, { maxAge: '1d', etag: true }));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
            cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
        }
    }),
    limits: { fileSize: parseInt(process.env.MAX_UPLOAD_MB || '300', 10) * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        const allowed = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime|ogg))$/;
        if (allowed.test(file.mimetype)) return cb(null, true);
        cb(new Error('نوع فایل مجاز نیست (فقط عکس یا ویدیو)'));
    }
});

const uploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    message: { success: false, error: 'تعداد آپلودها بیش از حد مجاز است' }
});

app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', etag: true }));

app.post('/api/upload', uploadLimiter, (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ success: false, error: `حجم فایل بیشتر از حد مجاز (${process.env.MAX_UPLOAD_MB || 300} مگابایت) است` });
            }
            return res.status(400).json({ success: false, error: 'خطا در آپلود فایل: ' + err.message });
        } else if (err) {
            return res.status(400).json({ success: false, error: err.message || 'خطا در آپلود فایل' });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'فایلی ارسال نشده' });
        }
        const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
        res.json({ success: true, url: `/uploads/${req.file.filename}`, mediaType, size: req.file.size });
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', pid: process.pid, uptime: process.uptime(), memory: process.memoryUsage().rss, shards: db.shardCount });
});

function isAdmin(req, res, next) {
    const userId = req.headers.userid || req.body.userId;
    if (userId === 'admin_milad') {
        return next();
    }
    res.status(403).json({ error: 'دسترسی غیرمجاز' });
}

// ============================================
// ثبت‌نام
// ============================================
app.post('/api/user/register', async (req, res) => {
    try {
        const { name, avatar, email, password } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'نام الزامی است' });
        }
        
        let id;
        const nameLower = name.trim().toLowerCase();
        if (nameLower === 'milad' || nameLower === 'مدیر سیستم' || nameLower === 'admin' || nameLower === 'milad13777') {
            id = 'admin_milad';
        } else {
            id = 'user_' + crypto.randomBytes(8).toString('hex');
        }
        
        const channelId = 'channel_' + id;

        const check = await db.query(id, `SELECT id FROM users WHERE id = $1`, [id]);
        if (check.rows.length === 0) {
            await db.query(id, `
                INSERT INTO users (id, name, avatar, email, password_hash, role, is_verified, score, created_at) 
                VALUES ($1, $2, $3, $4, $5, $6, 1, $7, CURRENT_TIMESTAMP)
            `, [id, name.trim(), avatar || null, email || null, password || null, id === 'admin_milad' ? 'admin' : 'user', id === 'admin_milad' ? 999999 : 0]);
            
            await db.query(id, `
                INSERT INTO channels (id, user_id, name, boost_level, created_at) 
                VALUES ($1, $2, $3, 'normal', CURRENT_TIMESTAMP)
            `, [channelId, id, name.trim() + ' - کانال']);
        }

        const u = await db.query(id, `SELECT id, name, avatar, score, role FROM users WHERE id = $1`, [id]);
        res.json({ success: true, user: u.rows[0] });
    } catch (error) {
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
            SELECT id, name, avatar, score, bio, role, is_verified, created_at 
            FROM users WHERE id = $1
        `, [id]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'کاربر یافت نشد' });
        const ch = await db.query(id, `SELECT followers_count FROM channels WHERE user_id = $1`, [id]);
        res.json({ ...u.rows[0], followers: ch.rows[0]?.followers_count || 0 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/user/avatar', async (req, res) => {
    try {
        const { userId, avatar } = req.body;
        if (!userId || !avatar) return res.status(400).json({ success: false, error: 'اطلاعات ناقص' });
        await db.query(userId, `UPDATE users SET avatar = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [avatar, userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/bio', async (req, res) => {
    try {
        const { userId, bio } = req.body;
        await db.query(userId, `UPDATE users SET bio = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [bio, userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// پروفایل با کش
// ============================================
const profileCache = new Map();
const PROFILE_CACHE_TTL = 30000;

app.get('/api/profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { viewerId } = req.query;
        
        const cacheKey = `${userId}_${viewerId}`;
        const cached = profileCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < PROFILE_CACHE_TTL) {
            return res.json(cached.data);
        }

        const u = await db.query(userId, `
            SELECT id, name, avatar, bio, score, is_verified, created_at 
            FROM users WHERE id = $1
        `, [userId]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'کاربر یافت نشد' });

        const ch = await db.query(userId, `SELECT * FROM channels WHERE user_id = $1`, [userId]);
        const channel = ch.rows[0];

        const posts = await db.query(userId, `
            SELECT p.*, c.name as channel_name, u.name as user_name
            FROM posts p 
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC LIMIT 30
        `, [userId]);

        let isFollowing = false;
        if (viewerId && viewerId !== userId) {
            const f = await db.query(userId, `
                SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2
            `, [viewerId, userId]);
            isFollowing = f.rows.length > 0;
        }

        const data = { user: u.rows[0], channel, posts: posts.rows, isFollowing };
        profileCache.set(cacheKey, { data, timestamp: Date.now() });
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// فالو
// ============================================
app.post('/api/follow', async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        if (!followerId || !followingId) {
            return res.status(400).json({ success: false, error: 'اطلاعات ناقص است' });
        }
        const result = db.followUser(followerId, followingId);
        if (result.success && !result.alreadyFollowing) {
            const assistant = new IntelligentAssistant(followerId, db);
            await assistant.updateUserActivity('follow');
            profileCache.clear();
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/unfollow', async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        db.unfollowUser(followerId, followingId);
        profileCache.clear();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// پست‌ها
// ============================================
app.post('/api/post/create', async (req, res) => {
    try {
        const { userId, content, mediaUrl, mediaType } = req.body;
        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, error: 'متن پست الزامی است' });
        }

        const userRow = await db.query(userId, `SELECT role, restricted FROM users WHERE id = $1`, [userId]);
        const u = userRow.rows[0];
        if (u?.role === 'banned') {
            return res.status(403).json({ success: false, error: 'حساب شما مسدود شده است' });
        }
        if (u?.restricted) {
            return res.status(403).json({ success: false, error: 'حساب شما محدود شده است' });
        }

        const channel = await db.query(userId, `SELECT id FROM channels WHERE user_id = $1`, [userId]);
        if (channel.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });
        }

        const postId = crypto.randomUUID();
        const type = mediaType || 'none';
        
        await db.query(userId, `
            INSERT INTO posts (id, channel_id, content, media_url, media_type, is_published, published_at, created_at)
            VALUES ($1, $2, $3, $4, $5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [postId, channel.rows[0].id, content.trim(), mediaUrl || null, type]);

        await db.query(userId, `UPDATE channels SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`, [userId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('post');
        const boost = await assistant.boostVisibility();

        profileCache.clear();
        exploreCache.clear();

        res.json({ success: true, postId, boost });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/post/:postId/view', async (req, res) => {
    try {
        const { postId } = req.params;
        await db.query(postId, `UPDATE posts SET views = views + 1 WHERE id = $1`, [postId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// لایک
// ============================================
app.post('/api/post/:postId/like', async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ success: false, error: 'کاربر نامعتبر' });

        const result = db.toggleLike(postId, userId);
        if (!result.success) {
            return res.status(400).json(result);
        }

        if (result.liked) {
            const assistant = new IntelligentAssistant(userId, db);
            await assistant.updateUserActivity('like');
        }

        profileCache.clear();
        exploreCache.clear();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// کامنت
// ============================================
app.post('/api/post/:postId/comment', async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId, text } = req.body;
        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, error: 'متن کامنت الزامی است' });
        }

        const id = crypto.randomUUID();
        await db.query(userId, `
            INSERT INTO post_comments (id, post_id, user_id, text, created_at) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `, [id, postId, userId, text.trim()]);
        await db.query(postId, `UPDATE posts SET comments = comments + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [postId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('comment');

        const u = await db.query(userId, `SELECT name, avatar FROM users WHERE id = $1`, [userId]);
        profileCache.clear();
        exploreCache.clear();
        res.json({ success: true, comment: { id, userId, text: text.trim(), name: u.rows[0]?.name, avatar: u.rows[0]?.avatar } });
    } catch (error) {
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
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// دستیار
// ============================================
app.post('/api/assistant/train', async (req, res) => {
    try {
        const { userId, question, answer } = req.body;
        const id = crypto.randomUUID();
        await db.query(userId, `
            INSERT INTO assistant_training (id, user_id, type, question, answer, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [id, userId, 'qa', question, answer]);
        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();
        res.json({ success: true, message: 'آموزش با موفقیت ثبت شد', boost });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/assistant/keyword', async (req, res) => {
    try {
        const { userId, keyword, response } = req.body;
        const id = crypto.randomUUID();
        await db.query(userId, `
            INSERT INTO assistant_training (id, user_id, type, keyword, response, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [id, userId, 'keyword', keyword, response]);
        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();
        res.json({ success: true, message: 'کلمه کلیدی با موفقیت ثبت شد', boost });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/assistant/schedule', async (req, res) => {
    try {
        const { userId, posts } = req.body;
        const channel = await db.query(userId, `SELECT id FROM channels WHERE user_id = $1`, [userId]);
        if (channel.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });
        }
        const assistant = new IntelligentAssistant(userId, db);
        const scheduled = await assistant.schedulePosts(posts);
        res.json({ success: true, message: `${posts.length} پست با موفقیت زمان‌بندی شد`, posts: scheduled });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/assistant/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const qa = await db.query(userId, `
            SELECT question, answer FROM assistant_training 
            WHERE user_id = $1 AND type = 'qa' ORDER BY created_at DESC
        `, [userId]);
        const keywords = await db.query(userId, `
            SELECT keyword, response FROM assistant_training 
            WHERE user_id = $1 AND type = 'keyword' ORDER BY created_at DESC
        `, [userId]);
        const posts = await db.query(userId, `
            SELECT p.*, c.name as channel_name 
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 0
            ORDER BY p.scheduled_time ASC
        `, [userId]);
        const assistant = new IntelligentAssistant(userId, db);
        const stats = await assistant.getStats();
        res.json({ qa: qa.rows, keywords: keywords.rows, posts: posts.rows, stats });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/assistant/chat/:targetUserId', async (req, res) => {
    try {
        const { targetUserId } = req.params;
        const { message } = req.body;
        const assistant = new IntelligentAssistant(targetUserId, db);
        const reply = await assistant.autoReply(message);
        res.json({ reply: reply || 'دستیار هنوز برای این موضوع آموزش ندیده 🤖' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// اکسپلور
// ============================================
const exploreCache = new Map();
const EXPLORE_CACHE_TTL = 15000;

app.get('/api/explore', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const offset = (page - 1) * limit;

        const cacheKey = `explore_${page}`;
        const cached = exploreCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < EXPLORE_CACHE_TTL) {
            return res.json(cached.data);
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
                    WHERE p.channel_id = c.id AND p.is_published = 1
                    ORDER BY p.created_at DESC
                    LIMIT 5
                ) as recent_posts
            FROM channels c
            JOIN users u ON u.id = c.user_id
            WHERE c.posts_count > 0
            ORDER BY c.activity_score DESC, c.followers_count DESC
            LIMIT $1 OFFSET $2
        `, [limit, offset]);

        const items = result.rows.map(row => ({
            ...row,
            recent_posts: row.recent_posts ? JSON.parse(row.recent_posts) : []
        }));

        exploreCache.set(cacheKey, { data: items, timestamp: Date.now() });
        res.json(items);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/channel/:userId/posts', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await db.query(userId, `
            SELECT p.*, c.name as channel_name, u.name as user_name
            FROM posts p 
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC LIMIT 50
        `, [userId]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) return res.json([]);
        const result = await db.query(null, `
            SELECT id, name, avatar, 'user' as type FROM users 
            WHERE name LIKE $1 AND id != 'admin_milad'
            UNION
            SELECT id, name, NULL as avatar, 'channel' as type FROM channels 
            WHERE name LIKE $1
            LIMIT 20
        `, [`%${q}%`]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// چت
// ============================================
app.post('/api/chat/save', async (req, res) => {
    try {
        const { from, to, message } = req.body;
        const id = crypto.randomUUID();
        await db.query(from, `
            INSERT INTO messages (id, from_user, to_user, message, created_at) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `, [id, from, to, message]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/chat/history/:userId/:targetId', async (req, res) => {
    try {
        const { userId, targetId } = req.params;
        const result = await db.query(userId, `
            SELECT * FROM messages 
            WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
            ORDER BY created_at ASC LIMIT 200
        `, [userId, targetId]);
        res.json(result.rows);
    } catch (error) {
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
                (
                    SELECT message FROM messages 
                    WHERE (from_user = u.id AND to_user = $1) OR (from_user = $1 AND to_user = u.id)
                    ORDER BY created_at DESC LIMIT 1
                ) as lastMessage,
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
        res.json(result.rows);
    } catch (error) {
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
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// استوری
// ============================================
app.post('/api/stories/add', async (req, res) => {
    try {
        const { userId, mediaUrl, mediaType } = req.body;
        if (!userId || !mediaUrl) return res.status(400).json({ success: false, error: 'اطلاعات ناقص' });
        const id = crypto.randomUUID();
        await db.query(userId, `
            INSERT INTO stories (id, user_id, media_url, media_type, created_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `, [id, userId, mediaUrl, mediaType || 'image']);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/stories/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await db.query(userId, `
            SELECT s.*, u.name as user_name, u.avatar as user_avatar
            FROM stories s
            JOIN users u ON s.user_id = u.id
            WHERE s.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1)
            OR s.user_id = $1
            ORDER BY s.created_at DESC LIMIT 50
        `, [userId]);
        res.json({ stories: result.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// پرداخت
// ============================================
app.post('/api/payment/submit', async (req, res) => {
    try {
        const { userId, receiptUrl } = req.body;
        if (!userId || !receiptUrl) return res.status(400).json({ success: false, error: 'اطلاعات ناقص' });
        const id = crypto.randomUUID();
        await db.query(userId, `
            INSERT INTO payments (id, user_id, receipt_url, status, created_at)
            VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP)
        `, [id, userId, receiptUrl]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/payments', isAdmin, async (req, res) => {
    try {
        const payments = await db.query(null, `
            SELECT p.*, u.name as user_name, u.avatar
            FROM payments p
            JOIN users u ON p.user_id = u.id
            ORDER BY p.created_at DESC LIMIT 200
        `);
        res.json(payments.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/payment/approve', isAdmin, async (req, res) => {
    try {
        const { paymentId } = req.body;
        await db.query(null, `UPDATE payments SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [paymentId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/payment/reject', isAdmin, async (req, res) => {
    try {
        const { paymentId } = req.body;
        await db.query(null, `UPDATE payments SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [paymentId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// پنل مدیریت
// ============================================
app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const users = await db.query(null, `
            SELECT u.*, c.followers_count, c.posts_count 
            FROM users u
            LEFT JOIN channels c ON u.id = c.user_id
            ORDER BY u.created_at DESC
        `);
        res.json(users.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/user/:action', isAdmin, async (req, res) => {
    try {
        const { action } = req.params;
        const { userId } = req.body;
        const actions = {
            verify: `UPDATE users SET is_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            unverify: `UPDATE users SET is_verified = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            ban: `UPDATE users SET role = 'banned', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            unban: `UPDATE users SET role = 'user', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            restrict: `UPDATE users SET restricted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            unrestrict: `UPDATE users SET restricted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`
        };
        if (!actions[action]) return res.status(400).json({ error: 'عملیات نامعتبر' });
        await db.query(null, actions[action], [userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/posts', isAdmin, async (req, res) => {
    try {
        const posts = await db.query(null, `
            SELECT p.*, u.name as user_name, c.name as channel_name
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            ORDER BY p.created_at DESC LIMIT 100
        `);
        res.json(posts.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/post/delete', isAdmin, async (req, res) => {
    try {
        const { postId } = req.body;
        await db.query(null, `DELETE FROM posts WHERE id = $1`, [postId]);
        profileCache.clear();
        exploreCache.clear();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/channels', isAdmin, async (req, res) => {
    try {
        const channels = await db.query(null, `
            SELECT c.*, u.name as user_name, u.avatar
            FROM channels c
            JOIN users u ON c.user_id = u.id
            ORDER BY c.followers_count DESC
        `);
        res.json(channels.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    try {
        const { message, title } = req.body;
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'متن پیام الزامی است' });
        }
        let totalSent = 0;
        for (const conn of db.getAllShards()) {
            const users = conn.prepare(`SELECT id FROM users`).all();
            if (!users.length) continue;
            const insert = conn.prepare(`
                INSERT INTO system_notifications (id, user_id, title, message, type, created_at) 
                VALUES (?, ?, ?, ?, 'broadcast', CURRENT_TIMESTAMP)
            `);
            const transaction = conn.transaction(() => {
                for (const user of users) {
                    insert.run(crypto.randomUUID(), user.id, title || 'اعلان سیستمی', message);
                }
            });
            transaction();
            for (const user of users) {
                io.to(`user_${user.id}`).emit('broadcast', { title: title || 'اعلان سیستمی', message });
            }
            totalSent += users.length;
        }
        res.json({ success: true, message: `پیام به ${totalSent} کاربر ارسال شد` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const users = await db.query(null, `SELECT COUNT(*) as total FROM users`);
        const posts = await db.query(null, `SELECT COUNT(*) as total FROM posts WHERE is_published = 1`);
        const channels = await db.query(null, `SELECT COUNT(*) as total FROM channels`);
        const messages = await db.query(null, `SELECT COUNT(*) as total FROM messages`);
        const follows = await db.query(null, `SELECT COUNT(*) as total FROM follows`);
        const comments = await db.query(null, `SELECT COUNT(*) as total FROM post_comments`);
        const trainings = await db.query(null, `SELECT COUNT(*) as total FROM assistant_training`);
        const reports = await db.query(null, `SELECT COUNT(*) as total FROM reports WHERE status = 'pending'`);
        const payments = await db.query(null, `SELECT COUNT(*) as total FROM payments WHERE status = 'pending'`);

        res.json({
            users: users.rows[0]?.total || 0,
            posts: posts.rows[0]?.total || 0,
            channels: channels.rows[0]?.total || 0,
            messages: messages.rows[0]?.total || 0,
            follows: follows.rows[0]?.total || 0,
            comments: comments.rows[0]?.total || 0,
            trainings: trainings.rows[0]?.total || 0,
            pendingReports: reports.rows[0]?.total || 0,
            pendingPayments: payments.rows[0]?.total || 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// گزارش‌ها
// ============================================
app.post('/api/report', async (req, res) => {
    try {
        const { reporterId, targetId, targetType, reason } = req.body;
        if (!reporterId || !targetId || !targetType || !reason || !reason.trim()) {
            return res.status(400).json({ success: false, error: 'اطلاعات گزارش ناقص است' });
        }
        if (!['user', 'post', 'comment'].includes(targetType)) {
            return res.status(400).json({ success: false, error: 'نوع گزارش نامعتبر است' });
        }
        const id = crypto.randomUUID();
        await db.query(null, `
            INSERT INTO reports (id, reporter_id, target_id, target_type, reason, status, created_at)
            VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP)
        `, [id, reporterId, targetId, targetType, reason.trim().substring(0, 500)]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/reports', isAdmin, async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const reports = await db.query(null, `
            SELECT * FROM reports WHERE status = $1 ORDER BY created_at DESC LIMIT 200
        `, [status]);
        res.json(reports.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/report/:action', isAdmin, async (req, res) => {
    try {
        const { action } = req.params;
        const { reportId } = req.body;
        if (!['resolve', 'dismiss'].includes(action)) {
            return res.status(400).json({ error: 'عملیات نامعتبر' });
        }
        const status = action === 'resolve' ? 'resolved' : 'dismissed';
        await db.query(null, `UPDATE reports SET status = $1, resolved_at = CURRENT_TIMESTAMP WHERE id = $2`, [status, reportId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// مسدود کردن
// ============================================
app.post('/api/user/block', async (req, res) => {
    try {
        const { blockerId, blockedId } = req.body;
        if (!blockerId || !blockedId) return res.status(400).json({ success: false, error: 'اطلاعات ناقص است' });
        res.json(db.blockUser(blockerId, blockedId));
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/unblock', async (req, res) => {
    try {
        const { blockerId, blockedId } = req.body;
        res.json(db.unblockUser(blockerId, blockedId));
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/user/:userId/is-blocked/:targetId', async (req, res) => {
    try {
        const { userId, targetId } = req.params;
        res.json({ blocked: db.isBlocked(userId, targetId) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// تبلیغات
// ============================================
app.get('/api/ads/active', async (req, res) => {
    try {
        const ads = await db.query(null, `SELECT * FROM ads WHERE is_active = 1 ORDER BY created_at DESC LIMIT 20`);
        res.json(ads.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/ads', isAdmin, async (req, res) => {
    try {
        const ads = await db.query(null, `SELECT * FROM ads ORDER BY created_at DESC`);
        res.json(ads.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/ads/create', isAdmin, async (req, res) => {
    try {
        const { title, content, mediaUrl, mediaType, linkUrl } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ success: false, error: 'عنوان تبلیغ الزامی است' });
        const id = crypto.randomUUID();
        await db.query(null, `
            INSERT INTO ads (id, title, content, media_url, media_type, link_url, is_active, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, 1, CURRENT_TIMESTAMP)
        `, [id, title.trim(), content || '', mediaUrl || null, mediaType || 'none', linkUrl || null]);
        res.json({ success: true, adId: id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/ads/toggle', isAdmin, async (req, res) => {
    try {
        const { adId, active } = req.body;
        await db.query(null, `UPDATE ads SET is_active = $1 WHERE id = $2`, [active ? 1 : 0, adId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/ads/delete', isAdmin, async (req, res) => {
    try {
        const { adId } = req.body;
        await db.query(null, `DELETE FROM ads WHERE id = $1`, [adId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 404
// ============================================
app.use('/api/', (req, res) => {
    res.status(404).json({ success: false, error: 'مسیر یافت نشد' });
});

app.use((err, req, res, next) => {
    console.error('Unhandled route error:', err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ success: false, error: 'خطای داخلی سرور' });
});

// ============================================
// WebSocket
// ============================================
io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);
    let msgTimestamps = [];

    socket.on('join', (userId) => {
        if (!userId) return;
        socket.data.userId = userId;
        socket.join(`user_${userId}`);
        console.log(`User ${userId} joined room`);
    });

    socket.on('private_message', async (data) => {
        const { from, to, message, timestamp } = data || {};
        if (!from || !to || typeof message !== 'string' || !message.trim()) {
            return io.to(`user_${from}`).emit('message_sent', { success: false, error: 'پیام نامعتبر است', timestamp });
        }
        if (message.length > 4000) {
            return io.to(`user_${from}`).emit('message_sent', { success: false, error: 'پیام خیلی طولانیه', timestamp });
        }
        if (db.isBlocked(from, to)) {
            return io.to(`user_${from}`).emit('message_sent', { success: false, error: 'امکان ارسال پیام به این کاربر وجود ندارد', timestamp });
        }

        const now = Date.now();
        msgTimestamps = msgTimestamps.filter(t => now - t < 10000);
        if (msgTimestamps.length >= 20) {
            return io.to(`user_${from}`).emit('message_sent', { success: false, error: 'خیلی سریع پیام می‌فرستی، کمی صبر کن', timestamp });
        }
        msgTimestamps.push(now);

        const trimmed = message.trim();
        try {
            const id = crypto.randomUUID();
            await db.query(from, `
                INSERT INTO messages (id, from_user, to_user, message, created_at) 
                VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            `, [id, from, to, trimmed]);

            io.to(`user_${to}`).emit('new_message', { from, message: trimmed, timestamp });
            io.to(`user_${from}`).emit('message_sent', { success: true, timestamp });
        } catch (e) {
            console.error('save message error', e);
            io.to(`user_${from}`).emit('message_sent', { success: false, error: 'ذخیره پیام ناموفق بود', timestamp });
        }
    });

    socket.on('typing', (data) => {
        const { from, to } = data || {};
        if (!from || !to) return;
        io.to(`user_${to}`).emit('user_typing', { from });
    });

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// ============================================
// راه‌اندازی
// ============================================
const PORT = process.env.PORT || 3000;

async function publishDueScheduledPosts() {
    try {
        const now = new Date().toISOString();
        const due = await db.query(null, `
            SELECT p.id, p.channel_id, c.user_id 
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE p.is_published = 0 AND p.scheduled_time IS NOT NULL AND p.scheduled_time <= $1
            LIMIT 200
        `, [now]);

        for (const row of due.rows) {
            try {
                const claim = await db.query(row.id, `
                    UPDATE posts SET is_published = 1, published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = $1 AND is_published = 0
                `, [row.id]);
                if (!claim.rowCount) continue;

                await db.query(row.user_id, `UPDATE channels SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.channel_id]);

                const assistant = new IntelligentAssistant(row.user_id, db);
                await assistant.updateUserActivity('post');
                await assistant.boostVisibility();

                profileCache.clear();
                exploreCache.clear();
            } catch (e) {
                console.error('خطا در انتشار پست زمان‌بندی‌شده', row.id, e.message);
            }
        }
        if (due.rows.length) console.log(`📅 ${due.rows.length} پست زمان‌بندی‌شده منتشر شد`);
    } catch (e) {
        console.error('خطا در بررسی پست‌های زمان‌بندی‌شده:', e.message);
    }
}

async function startServer() {
    try {
        await db.initTables();
        console.log('✅ Database ready');

        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT} (pid ${process.pid})`);
            console.log(`📍 http://localhost:${PORT}`);
            console.log(`📊 Shards: ${db.shardCount}`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

setInterval(publishDueScheduledPosts, 60 * 1000);
publishDueScheduledPosts();

process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
    gracefulExit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled Rejection:', reason);
});

function gracefulExit(code) {
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 10000).unref();
}

process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM دریافت شد، خاموشی مرتب...');
    gracefulExit(0);
});

startServer();

module.exports = { app, server, io };