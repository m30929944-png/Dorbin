const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const DatabaseManager = require('./database');
const IntelligentAssistant = require('./assistant_logic');

// ============================================
// تنظیمات امنیتی و محدودیت‌ها
// ============================================
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000,
    pingInterval: 25000
});

// میدلورهای امنیتی
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

// محدودیت نرخ درخواست (Rate Limiting)
const rateLimits = new Map();
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const window = 60000; // 1 دقیقه
    const limit = 100; // 100 درخواست در دقیقه

    if (!rateLimits.has(ip)) {
        rateLimits.set(ip, { count: 1, reset: now + window });
        return next();
    }

    const data = rateLimits.get(ip);
    if (now > data.reset) {
        data.count = 1;
        data.reset = now + window;
        return next();
    }

    data.count++;
    if (data.count > limit) {
        return res.status(429).json({ error: 'تعداد درخواست‌ها بیش از حد مجاز است' });
    }
    next();
});

const db = new DatabaseManager();

// ============================================
// تأیید ادمین
// ============================================
function isAdmin(req, res, next) {
    const { userId } = req.body;
    if (userId === 'admin_milad') {
        return next();
    }
    res.status(403).json({ error: 'دسترسی غیرمجاز' });
}

// ============================================
// API‌های کاربر
// ============================================
app.post('/api/user/register', async (req, res) => {
    try {
        const { name, avatar } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'نام الزامی است' });
        }
        const id = 'user_' + crypto.randomBytes(8).toString('hex');
        const channelId = 'channel_' + id;

        await db.query(id, `
            INSERT INTO users (id, name, avatar, created_at) 
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        `, [id, name.trim(), avatar || null]);
        
        await db.query(id, `
            INSERT INTO channels (id, user_id, name, created_at) 
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        `, [channelId, id, name.trim() + ' - کانال']);

        res.json({ success: true, user: { id, name: name.trim(), avatar: avatar || null, score: 0, followers: 0 } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const u = await db.query(id, `
            SELECT id, name, avatar, score, bio, is_verified, role 
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
        await db.query(userId, `
            UPDATE users SET avatar = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [avatar, userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// API پروفایل عمومی
// ============================================
app.get('/api/profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { viewerId } = req.query;

        const u = await db.query(userId, `
            SELECT id, name, avatar, bio, score, is_verified 
            FROM users WHERE id = $1
        `, [userId]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'کاربر یافت نشد' });

        const ch = await db.query(userId, `SELECT * FROM channels WHERE user_id = $1`, [userId]);
        const channel = ch.rows[0];

        const posts = await db.query(userId, `
            SELECT * FROM posts WHERE channel_id = $1 AND is_published = 1
            ORDER BY created_at DESC LIMIT 30
        `, [channel?.id]);

        let isFollowing = false;
        if (viewerId) {
            const f = await db.query(userId, `
                SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2
            `, [viewerId, userId]);
            isFollowing = f.rows.length > 0;
        }

        res.json({ user: u.rows[0], channel, posts: posts.rows, isFollowing });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// فالو / آنفالو
// ============================================
app.post('/api/follow', async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        if (followerId === followingId) {
            return res.status(400).json({ success: false, error: 'نمی‌توانید خودتان را فالو کنید' });
        }

        const existing = await db.query(followerId, `
            SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2
        `, [followerId, followingId]);
        if (existing.rows.length > 0) {
            return res.json({ success: true, alreadyFollowing: true });
        }

        await db.query(followerId, `
            INSERT INTO follows (follower_id, following_id, created_at) 
            VALUES ($1, $2, CURRENT_TIMESTAMP)
        `, [followerId, followingId]);
        
        await db.query(followingId, `
            UPDATE channels SET followers_count = followers_count + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE user_id = $1
        `, [followingId]);

        const assistant = new IntelligentAssistant(followerId, db);
        await assistant.updateUserActivity('follow');

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/unfollow', async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        await db.query(followerId, `
            DELETE FROM follows WHERE follower_id = $1 AND following_id = $2
        `, [followerId, followingId]);
        await db.query(followingId, `
            UPDATE channels SET followers_count = MAX(followers_count - 1, 0), updated_at = CURRENT_TIMESTAMP 
            WHERE user_id = $1
        `, [followingId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// ساخت پست جدید با پشتیبانی از ویدیو
// ============================================
app.post('/api/post/create', async (req, res) => {
    try {
        const { userId, content, mediaUrl, mediaType } = req.body;
        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, error: 'متن پست الزامی است' });
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

        await db.query(userId, `
            UPDATE channels SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE user_id = $1
        `, [userId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('post');
        const boost = await assistant.boostVisibility();

        res.json({ success: true, postId, boost });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// لایک / کامنت
// ============================================
app.post('/api/post/:postId/like', async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId } = req.body;

        const existing = await db.query(userId, `
            SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2
        `, [postId, userId]);
        let liked;
        if (existing.rows.length > 0) {
            await db.query(userId, `
                DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2
            `, [postId, userId]);
            await db.query(postId, `
                UPDATE posts SET likes = MAX(likes - 1, 0), updated_at = CURRENT_TIMESTAMP 
                WHERE id = $1
            `, [postId]);
            liked = false;
        } else {
            await db.query(userId, `
                INSERT INTO post_likes (post_id, user_id, created_at) 
                VALUES ($1, $2, CURRENT_TIMESTAMP)
            `, [postId, userId]);
            await db.query(postId, `
                UPDATE posts SET likes = likes + 1, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $1
            `, [postId]);
            const assistant = new IntelligentAssistant(userId, db);
            await assistant.updateUserActivity('like');
            liked = true;
        }

        const p = await db.query(postId, `SELECT likes FROM posts WHERE id = $1`, [postId]);
        res.json({ success: true, liked, likes: p.rows[0]?.likes || 0 });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

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
        await db.query(postId, `
            UPDATE posts SET comments = comments + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
        `, [postId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('comment');

        const u = await db.query(userId, `SELECT name, avatar FROM users WHERE id = $1`, [userId]);
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
// دستیار هوشمند
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

// زمان‌بندی پست‌ها با پشتیبانی از ویدیو
app.post('/api/assistant/schedule', async (req, res) => {
    try {
        const { userId, posts } = req.body;
        
        const channel = await db.query(userId, `SELECT id FROM channels WHERE user_id = $1`, [userId]);
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

// چت با دستیار
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
// کانال / اکسپلور
// ============================================
app.get('/api/channel/:userId/posts', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await db.query(userId, `
            SELECT p.*, c.name as channel_name
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC LIMIT 50
        `, [userId]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/explore', async (req, res) => {
    try {
        const result = await db.query(null, `
            SELECT c.id, c.name, c.followers_count, c.posts_count, c.boost_level, 
                   c.activity_score, u.id as user_id, u.avatar, u.name as user_name
            FROM channels c JOIN users u ON u.id = c.user_id
            ORDER BY c.activity_score DESC, c.followers_count DESC
            LIMIT 30
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// چت خصوصی رمزنگاری شده
// ============================================
app.post('/api/chat/save', async (req, res) => {
    try {
        const { from, to, message } = req.body;
        const id = crypto.randomUUID();
        // رمزنگاری پیام
        const encrypted = db.encrypt(message);
        
        await db.query(from, `
            INSERT INTO messages (id, from_user, to_user, message, encrypted, created_at) 
            VALUES ($1, $2, $3, $4, 1, CURRENT_TIMESTAMP)
        `, [id, from, to, encrypted]);
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
            ORDER BY created_at ASC LIMIT 100
        `, [userId, targetId]);

        // رمزگشایی پیام‌ها
        const decrypted = result.rows.map(row => ({
            ...row,
            message: row.encrypted ? db.decrypt(row.message) : row.message
        }));

        res.json(decrypted);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/chat/list/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await db.query(userId, `
            SELECT DISTINCT
                CASE WHEN from_user = $1 THEN to_user ELSE from_user END as id,
                u.name, u.avatar,
                (SELECT message FROM messages 
                 WHERE (from_user = u.id AND to_user = $1) OR (from_user = $1 AND to_user = u.id)
                 ORDER BY created_at DESC LIMIT 1) as lastMessage
            FROM messages m
            JOIN users u ON u.id = CASE WHEN m.from_user = $1 THEN m.to_user ELSE m.from_user END
            WHERE m.from_user = $1 OR m.to_user = $1
        `, [userId]);

        // رمزگشایی آخرین پیام
        const decrypted = result.rows.map(row => ({
            ...row,
            lastMessage: row.lastMessage ? db.decrypt(row.lastMessage) : null
        }));

        res.json(decrypted);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// پنل مدیریت
// ============================================
// ارسال پیام همگانی
app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    try {
        const { message, title } = req.body;
        const users = await db.query(null, `SELECT id FROM users`);
        
        for (const user of users.rows) {
            const id = crypto.randomUUID();
            await db.query(null, `
                INSERT INTO system_notifications (id, user_id, title, message, type, created_at)
                VALUES ($1, $2, $3, $4, 'broadcast', CURRENT_TIMESTAMP)
            `, [id, user.id, title || 'اعلان سیستمی', message]);
            
            // ارسال از طریق سوکت
            io.to(`user_${user.id}`).emit('broadcast', { title, message });
        }
        
        res.json({ success: true, message: `پیام به ${users.rows.length} کاربر ارسال شد` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// مدیریت کاربران
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

app.post('/api/admin/user/status', isAdmin, async (req, res) => {
    try {
        const { userId, action } = req.body;
        if (action === 'ban') {
            await db.query(null, `UPDATE users SET role = 'banned' WHERE id = $1`, [userId]);
        } else if (action === 'unban') {
            await db.query(null, `UPDATE users SET role = 'user' WHERE id = $1`, [userId]);
        } else if (action === 'verify') {
            await db.query(null, `UPDATE users SET is_verified = 1 WHERE id = $1`, [userId]);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// مدیریت پست‌ها
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
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// مدیریت کانال‌ها
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

// ============================================
// WebSocket
// ============================================
io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);

    socket.on('join', (userId) => {
        socket.join(`user_${userId}`);
        console.log(`User ${userId} joined room`);
    });

    socket.on('private_message', async (data) => {
        const { from, to, message, timestamp } = data;
        
        // رمزنگاری پیام
        const encrypted = db.encrypt(message);
        
        // ذخیره در دیتابیس
        try {
            const id = crypto.randomUUID();
            await db.query(from, `
                INSERT INTO messages (id, from_user, to_user, message, encrypted, created_at) 
                VALUES ($1, $2, $3, $4, 1, CURRENT_TIMESTAMP)
            `, [id, from, to, encrypted]);
        } catch (e) {
            console.error('save message error', e);
        }

        // ارسال به گیرنده
        io.to(`user_${to}`).emit('new_message', { from, message, timestamp });
        socket.emit('message_sent', { success: true, timestamp });
    });

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// ============================================
// راه‌اندازی
// ============================================
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await db.initTables();
        console.log('✅ Database ready');

        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📍 http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();