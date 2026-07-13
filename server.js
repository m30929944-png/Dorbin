const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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
    maxHttpBufferSize: 1e8 // 100MB
});

// ============================================
// امنیت و بهینه‌سازی
// ============================================
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors());

// محدودیت نرخ درخواست
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    message: { error: 'تعداد درخواست‌ها بیش از حد مجاز است' }
});
app.use('/api/', limiter);

app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(__dirname, {
    maxAge: '1d',
    etag: true
}));

const db = new DatabaseManager();

// ============================================
// بررسی ادمین
// ============================================
function isAdmin(req, res, next) {
    const userId = req.headers.userid || req.body.userId;
    if (userId === 'admin_milad') {
        return next();
    }
    res.status(403).json({ error: 'دسترسی غیرمجاز' });
}

// ============================================
// API ثبت‌نام
// ============================================
app.post('/api/user/register', async (req, res) => {
    try {
        const { name, avatar } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'نام الزامی است' });
        }
        
        let id;
        const nameLower = name.trim().toLowerCase();
        if (nameLower === 'milad' || nameLower === 'مدیر سیستم' || nameLower === 'admin') {
            id = 'admin_milad';
        } else {
            id = 'user_' + crypto.randomBytes(8).toString('hex');
        }
        
        const channelId = 'channel_' + id;

        const check = await db.query(`SELECT id FROM users WHERE id = $1`, [id]);
        if (!check || check.length === 0) {
            await db.query(`
                INSERT INTO users (id, name, avatar, role, is_verified, score, created_at) 
                VALUES ($1, $2, $3, $4, 1, $5, CURRENT_TIMESTAMP)
            `, [id, name.trim(), avatar || null, id === 'admin_milad' ? 'admin' : 'user', id === 'admin_milad' ? 999999 : 0]);
            
            await db.query(`
                INSERT INTO channels (id, user_id, name, boost_level, created_at) 
                VALUES ($1, $2, $3, 'normal', CURRENT_TIMESTAMP)
            `, [channelId, id, name.trim() + ' - کانال']);
        }

        const u = await db.query(`SELECT id, name, avatar, score, role FROM users WHERE id = $1`, [id]);
        res.json({ success: true, user: u[0] });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// API کاربر
// ============================================
app.get('/api/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const u = await db.query(`
            SELECT id, name, avatar, score, bio, role, is_verified, created_at 
            FROM users WHERE id = $1
        `, [id]);
        if (!u || u.length === 0) return res.status(404).json({ error: 'کاربر یافت نشد' });
        const ch = await db.query(`SELECT followers_count FROM channels WHERE user_id = $1`, [id]);
        res.json({ ...u[0], followers: ch[0]?.followers_count || 0 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/user/avatar', async (req, res) => {
    try {
        const { userId, avatar } = req.body;
        await db.query(`UPDATE users SET avatar = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [avatar, userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/bio', async (req, res) => {
    try {
        const { userId, bio } = req.body;
        await db.query(`UPDATE users SET bio = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [bio, userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// پروفایل عمومی با کش
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

        const u = await db.query(`
            SELECT id, name, avatar, bio, score, is_verified, created_at 
            FROM users WHERE id = $1
        `, [userId]);
        if (!u || u.length === 0) return res.status(404).json({ error: 'کاربر یافت نشد' });

        const ch = await db.query(`SELECT * FROM channels WHERE user_id = $1`, [userId]);
        const channel = ch[0] || null;

        const posts = await db.query(`
            SELECT p.*, c.name as channel_name, u.name as user_name, u.avatar as user_avatar
            FROM posts p 
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC LIMIT 30
        `, [userId]);

        let isFollowing = false;
        if (viewerId && viewerId !== userId) {
            const f = await db.query(`
                SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2
            `, [viewerId, userId]);
            isFollowing = f && f.length > 0;
        }

        const data = { user: u[0], channel, posts: posts || [], isFollowing };
        profileCache.set(cacheKey, { data, timestamp: Date.now() });
        
        res.json(data);
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// کانال و پست‌ها
// ============================================
app.get('/api/channel/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const posts = await db.query(`
            SELECT p.*, c.name as channel_name, u.name as user_name, u.avatar as user_avatar
            FROM posts p 
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC LIMIT 50
        `, [userId]);
        res.json(posts || []);
    } catch (error) {
        console.error('Channel posts error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// فالو / آنفالو با تراکنش
// ============================================
app.post('/api/follow', async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        if (followerId === followingId) {
            return res.status(400).json({ success: false, error: 'نمی‌توانید خودتان را فالو کنید' });
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
// پست‌ها با پشتیبانی ویدیو و کیفیت بالا
// ============================================
app.post('/api/post/create', async (req, res) => {
    try {
        const { userId, content, mediaUrl, mediaType } = req.body;
        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, error: 'متن پست الزامی است' });
        }

        const channel = await db.query(`SELECT id FROM channels WHERE user_id = $1`, [userId]);
        if (!channel || channel.length === 0) {
            return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });
        }

        const postId = crypto.randomUUID();
        const type = mediaType || 'none';
        
        await db.query(`
            INSERT INTO posts (id, channel_id, content, media_url, media_type, is_published, published_at, created_at)
            VALUES ($1, $2, $3, $4, $5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [postId, channel[0].id, content.trim(), mediaUrl || null, type]);

        await db.query(`UPDATE channels SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`, [userId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('post');
        const boost = await assistant.boostVisibility();

        profileCache.clear();
        exploreCache.clear();

        res.json({ success: true, postId, boost });
    } catch (error) {
        console.error('Create post error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/post/:postId/view', async (req, res) => {
    try {
        const { postId } = req.params;
        await db.query(`UPDATE posts SET views = views + 1 WHERE id = $1`, [postId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// لایک و کامنت با دکمه‌های بزرگ
// ============================================
app.post('/api/post/:postId/like', async (req, res) => {
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
        
        profileCache.clear();
        exploreCache.clear();
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
        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, error: 'متن کامنت الزامی است' });
        }

        const id = crypto.randomUUID();
        await db.query(`
            INSERT INTO post_comments (id, post_id, user_id, text, created_at) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `, [id, postId, userId, text.trim()]);
        await db.query(`UPDATE posts SET comments = comments + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [postId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('comment');

        const u = await db.query(`SELECT name, avatar FROM users WHERE id = $1`, [userId]);
        profileCache.clear();
        exploreCache.clear();
        res.json({ 
            success: true, 
            comment: { 
                id, 
                userId, 
                text: text.trim(), 
                name: u[0]?.name, 
                avatar: u[0]?.avatar 
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
        const result = await db.query(`
            SELECT c.*, u.name, u.avatar FROM post_comments c
            JOIN users u ON u.id = c.user_id
            WHERE c.post_id = $1 ORDER BY c.created_at ASC
        `, [postId]);
        res.json(result || []);
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
        const id = crypto.randomUUID();

        await db.query(`
            INSERT INTO assistant_training (id, user_id, type, question, answer, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [id, userId, 'qa', question, answer]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();

        res.json({ success: true, message: 'آموزش با موفقیت ثبت شد', boost });
    } catch (error) {
        console.error('Train error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/assistant/keyword', async (req, res) => {
    try {
        const { userId, keyword, response } = req.body;
        const id = crypto.randomUUID();

        await db.query(`
            INSERT INTO assistant_training (id, user_id, type, keyword, response, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [id, userId, 'keyword', keyword, response]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();

        res.json({ success: true, message: 'کلمه کلیدی با موفقیت ثبت شد', boost });
    } catch (error) {
        console.error('Keyword error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/assistant/schedule', async (req, res) => {
    try {
        const { userId, posts } = req.body;
        
        const channel = await db.query(`SELECT id FROM channels WHERE user_id = $1`, [userId]);
        if (!channel || channel.length === 0) {
            return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });
        }

        const assistant = new IntelligentAssistant(userId, db);
        const scheduled = await assistant.schedulePosts(posts);

        res.json({ success: true, message: `${posts.length} پست با موفقیت زمان‌بندی شد`, posts: scheduled });
    } catch (error) {
        console.error('Schedule error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/assistant/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const qa = await db.query(`
            SELECT question, answer FROM assistant_training 
            WHERE user_id = $1 AND type = 'qa' ORDER BY created_at DESC
        `, [userId]);

        const keywords = await db.query(`
            SELECT keyword, response FROM assistant_training 
            WHERE user_id = $1 AND type = 'keyword' ORDER BY created_at DESC
        `, [userId]);

        const posts = await db.query(`
            SELECT p.*, c.name as channel_name 
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 0
            ORDER BY p.scheduled_time ASC
        `, [userId]);

        const assistant = new IntelligentAssistant(userId, db);
        const stats = await assistant.getStats();

        res.json({ 
            qa: qa || [], 
            keywords: keywords || [], 
            posts: posts || [], 
            stats 
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

        const assistant = new IntelligentAssistant(targetUserId, db);
        const reply = await assistant.autoReply(message);

        res.json({ reply: reply || 'دستیار هنوز برای این موضوع آموزش ندیده 🤖' });
    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// اکسپلور با کش و کیفیت بالا
// ============================================
const exploreCache = new Map();
const EXPLORE_CACHE_TTL = 15000;

app.get('/api/explore', async (req, res) => {
    try {
        const cached = exploreCache.get('explore');
        if (cached && (Date.now() - cached.timestamp) < EXPLORE_CACHE_TTL) {
            return res.json(cached.data);
        }

        const result = await db.query(`
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
                            'created_at', p.created_at,
                            'user_id', u2.id,
                            'user_name', u2.name,
                            'user_avatar', u2.avatar
                        )
                    )
                    FROM posts p
                    JOIN channels c2 ON p.channel_id = c2.id
                    JOIN users u2 ON c2.user_id = u2.id
                    WHERE p.channel_id = c.id AND p.is_published = 1
                    ORDER BY p.created_at DESC
                    LIMIT 5
                ) as recent_posts
            FROM channels c
            JOIN users u ON u.id = c.user_id
            WHERE c.posts_count > 0
            ORDER BY c.activity_score DESC, c.followers_count DESC
            LIMIT 50
        `);
        
        const items = (result || []).map(row => ({
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
        
        const result = await db.query(`
            SELECT id, name, avatar, 'user' as type FROM users 
            WHERE name LIKE $1 AND id != 'admin_milad'
            UNION
            SELECT id, name, NULL as avatar, 'channel' as type FROM channels 
            WHERE name LIKE $1
            LIMIT 20
        `, [`%${q}%`]);
        res.json(result || []);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// چت خصوصی با تاریخچه کامل
// ============================================
app.post('/api/chat/save', async (req, res) => {
    try {
        const { from, to, message } = req.body;
        const id = crypto.randomUUID();
        
        await db.query(`
            INSERT INTO messages (id, from_user, to_user, message, created_at) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `, [id, from, to, message]);
        res.json({ success: true });
    } catch (error) {
        console.error('Save message error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/chat/history/:userId/:targetId', async (req, res) => {
    try {
        const { userId, targetId } = req.params;
        const result = await db.query(`
            SELECT * FROM messages 
            WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
            ORDER BY created_at ASC LIMIT 200
        `, [userId, targetId]);
        res.json(result || []);
    } catch (error) {
        console.error('Chat history error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/chat/list/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await db.query(`
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
        res.json(result || []);
    } catch (error) {
        console.error('Chat list error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/chat/read', async (req, res) => {
    try {
        const { userId, fromUser } = req.body;
        await db.query(`
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
        const users = await db.query(`
            SELECT u.*, c.followers_count, c.posts_count 
            FROM users u
            LEFT JOIN channels c ON u.id = c.user_id
            ORDER BY u.created_at DESC
        `);
        res.json(users || []);
    } catch (error) {
        console.error('Admin users error:', error);
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
            unban: `UPDATE users SET role = 'user', updated_at = CURRENT_TIMESTAMP WHERE id = $1`
        };
        
        if (!actions[action]) return res.status(400).json({ error: 'عملیات نامعتبر' });
        await db.query(actions[action], [userId]);
        profileCache.clear();
        res.json({ success: true });
    } catch (error) {
        console.error('Admin user action error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/posts', isAdmin, async (req, res) => {
    try {
        const posts = await db.query(`
            SELECT p.*, u.name as user_name, c.name as channel_name
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            ORDER BY p.created_at DESC LIMIT 100
        `);
        res.json(posts || []);
    } catch (error) {
        console.error('Admin posts error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/post/delete', isAdmin, async (req, res) => {
    try {
        const { postId } = req.body;
        await db.query(`DELETE FROM posts WHERE id = $1`, [postId]);
        profileCache.clear();
        exploreCache.clear();
        res.json({ success: true });
    } catch (error) {
        console.error('Delete post error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/channels', isAdmin, async (req, res) => {
    try {
        const channels = await db.query(`
            SELECT c.*, u.name as user_name, u.avatar
            FROM channels c
            JOIN users u ON c.user_id = u.id
            ORDER BY c.followers_count DESC
        `);
        res.json(channels || []);
    } catch (error) {
        console.error('Admin channels error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    try {
        const { message, title } = req.body;
        const users = await db.query(`SELECT id FROM users`);
        
        const dbInstance = db.getDb();
        const insert = dbInstance.prepare(`
            INSERT INTO system_notifications (id, user_id, title, message, type, created_at) 
            VALUES (?, ?, ?, ?, 'broadcast', CURRENT_TIMESTAMP)
        `);
        
        const transaction = dbInstance.transaction(() => {
            for (const user of (users || [])) {
                const id = crypto.randomUUID();
                insert.run(id, user.id, title || 'اعلان سیستمی', message);
                io.to(`user_${user.id}`).emit('broadcast', { title: title || 'اعلان سیستمی', message });
            }
        });
        
        transaction();
        res.json({ success: true, message: `پیام به ${(users || []).length} کاربر ارسال شد` });
    } catch (error) {
        console.error('Broadcast error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const users = await db.query(`SELECT COUNT(*) as total FROM users`);
        const posts = await db.query(`SELECT COUNT(*) as total FROM posts WHERE is_published = 1`);
        const channels = await db.query(`SELECT COUNT(*) as total FROM channels`);
        const messages = await db.query(`SELECT COUNT(*) as total FROM messages`);
        const follows = await db.query(`SELECT COUNT(*) as total FROM follows`);
        const comments = await db.query(`SELECT COUNT(*) as total FROM post_comments`);
        const trainings = await db.query(`SELECT COUNT(*) as total FROM assistant_training`);
        
        res.json({
            users: users[0]?.total || 0,
            posts: posts[0]?.total || 0,
            channels: channels[0]?.total || 0,
            messages: messages[0]?.total || 0,
            follows: follows[0]?.total || 0,
            comments: comments[0]?.total || 0,
            trainings: trainings[0]?.total || 0
        });
    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// WebSocket با پشتیبانی از میلیون‌ها کاربر
// ============================================
io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);

    socket.on('join', (userId) => {
        socket.join(`user_${userId}`);
        console.log(`User ${userId} joined room`);
    });

    socket.on('private_message', async (data) => {
        const { from, to, message, timestamp } = data;
        
        try {
            const id = crypto.randomUUID();
            await db.query(`
                INSERT INTO messages (id, from_user, to_user, message, created_at) 
                VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            `, [id, from, to, message]);
        } catch (e) {
            console.error('save message error', e);
        }

        io.to(`user_${to}`).emit('new_message', { from, message, timestamp });
        io.to(`user_${from}`).emit('message_sent', { success: true, timestamp });
    });

    socket.on('typing', (data) => {
        const { from, to } = data;
        io.to(`user_${to}`).emit('user_typing', { from });
    });

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
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

        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📍 http://localhost:${PORT}`);
            console.log(`👑 Admin: milad / M09145978426m`);
            console.log(`📊 Mode: ${process.env.NODE_ENV || 'development'}`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();

module.exports = { app, server, io };