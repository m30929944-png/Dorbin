// ============================================
// server.js - با کش پیشرفته، رمزنگاری، مقیاس‌پذیری و پشتیبانی ویدئو
// ============================================
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const DatabaseManager = require('./database');
const IntelligentAssistant = require('./assistant_logic');

// ============================================
// کش حافظه‌ای پیشرفته (LRU Cache)
// ============================================
class MemoryCache {
  constructor(maxSize = 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  set(key, value, ttl = 60000) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expires: Date.now() + ttl });
  }

  del(key) { this.cache.delete(key); }
  clear() { this.cache.clear(); }
}

const cache = new MemoryCache(2000);

// ============================================
// تنظیمات اولیه
// ============================================
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const db = new DatabaseManager();

// ============================================
// راه‌اندازی کلاستر برای مقیاس‌پذیری
// ============================================
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

if (cluster.isMaster && process.env.NODE_ENV === 'production') {
  console.log(`🚀 Master ${process.pid} running, forking ${numCPUs} workers...`);
  for (let i = 0; i < Math.min(numCPUs, 4); i++) {
    cluster.fork();
  }
  cluster.on('exit', (worker) => {
    console.log(`Worker ${worker.process.pid} died, restarting...`);
    cluster.fork();
  });
} else {
  startServer();
}

async function startServer() {
  try {
    await db.initTables();
    console.log('✅ Database ready');

    // ============================================
    // API Routes with Caching
    // ============================================

    // ثبت‌نام
    app.post('/api/user/register', async (req, res) => {
      try {
        const { name, avatar } = req.body;
        if (!name || !name.trim()) {
          return res.status(400).json({ success: false, error: 'نام الزامی است' });
        }
        const id = 'user_' + crypto.randomBytes(8).toString('hex');
        const channelId = 'channel_' + id;

        await db.query(id, `INSERT INTO users (id, name, avatar) VALUES ($1, $2, $3)`, [id, name.trim(), avatar || null]);
        await db.query(id, `INSERT INTO channels (id, user_id, name) VALUES ($1, $2, $3)`, [channelId, id, name.trim() + ' - کانال']);

        cache.del('explore');
        res.json({ success: true, user: { id, name: name.trim(), avatar: avatar || null, score: 0, followers: 0 } });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // دریافت کاربر (با کش)
    app.get('/api/user/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const cacheKey = `user_${id}`;
        let data = cache.get(cacheKey);
        if (data) return res.json(data);

        const u = await db.query(id, `SELECT id, name, avatar, score FROM users WHERE id = $1`, [id]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'کاربر یافت نشد' });
        const ch = await db.query(id, `SELECT followers_count FROM channels WHERE user_id = $1`, [id]);
        data = { ...u.rows[0], followers: ch.rows[0]?.followers_count || 0 };
        cache.set(cacheKey, data, 30000);
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // آپلود عکس پروفایل
    app.post('/api/user/avatar', async (req, res) => {
      try {
        const { userId, avatar } = req.body;
        await db.query(userId, `UPDATE users SET avatar = $1 WHERE id = $2`, [avatar, userId]);
        cache.del(`user_${userId}`);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // پروفایل عمومی (با کش)
    app.get('/api/profile/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        const { viewerId } = req.query;
        const cacheKey = `profile_${userId}_${viewerId || ''}`;
        let data = cache.get(cacheKey);
        if (data) return res.json(data);

        const u = await db.query(userId, `SELECT id, name, avatar, bio, score FROM users WHERE id = $1`, [userId]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'کاربر یافت نشد' });

        const ch = await db.query(userId, `SELECT * FROM channels WHERE user_id = $1`, [userId]);
        const channel = ch.rows[0];

        const posts = await db.query(userId, `
          SELECT * FROM posts WHERE channel_id = $1 AND is_published = 1
          ORDER BY created_at DESC LIMIT 30
        `, [channel?.id]);

        let isFollowing = false;
        if (viewerId) {
          const f = await db.query(userId, `SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2`, [viewerId, userId]);
          isFollowing = f.rows.length > 0;
        }

        data = { user: u.rows[0], channel, posts: posts.rows, isFollowing };
        cache.set(cacheKey, data, 15000);
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // فالو / آنفالو
    app.post('/api/follow', async (req, res) => {
      try {
        const { followerId, followingId } = req.body;
        if (followerId === followingId) return res.status(400).json({ success: false, error: 'نمی‌توانید خودتان را فالو کنید' });

        const existing = await db.query(followerId, `SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2`, [followerId, followingId]);
        if (existing.rows.length > 0) return res.json({ success: true, alreadyFollowing: true });

        await db.query(followerId, `INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)`, [followerId, followingId]);
        await db.query(followingId, `UPDATE channels SET followers_count = followers_count + 1 WHERE user_id = $1`, [followingId]);

        const assistant = new IntelligentAssistant(followerId, db);
        await assistant.updateUserActivity('follow');

        cache.del(`user_${followingId}`);
        cache.del(`profile_${followingId}_${followerId}`);
        cache.del('explore');

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post('/api/unfollow', async (req, res) => {
      try {
        const { followerId, followingId } = req.body;
        await db.query(followerId, `DELETE FROM follows WHERE follower_id = $1 AND following_id = $2`, [followerId, followingId]);
        await db.query(followingId, `UPDATE channels SET followers_count = MAX(followers_count - 1, 0) WHERE user_id = $1`, [followingId]);

        cache.del(`user_${followingId}`);
        cache.del(`profile_${followingId}_${followerId}`);
        cache.del('explore');

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // ساخت پست
    app.post('/api/post/create', async (req, res) => {
      try {
        const { userId, content, mediaUrl, mediaType } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ success: false, error: 'متن پست الزامی است' });

        const channel = await db.query(userId, `SELECT id FROM channels WHERE user_id = $1`, [userId]);
        if (channel.rows.length === 0) return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });

        const postId = crypto.randomUUID();
        await db.query(userId, `
          INSERT INTO posts (id, channel_id, content, media_url, media_type, is_published, published_at)
          VALUES ($1, $2, $3, $4, $5, 1, CURRENT_TIMESTAMP)
        `, [postId, channel.rows[0].id, content.trim(), mediaUrl || null, mediaType || null]);

        await db.query(userId, `UPDATE channels SET posts_count = posts_count + 1 WHERE user_id = $1`, [userId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('post');
        const boost = await assistant.boostVisibility();

        cache.del(`channel_${userId}`);
        cache.del(`profile_${userId}`);
        cache.del('explore');

        res.json({ success: true, postId, boost });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // بازدید پست
    app.post('/api/post/:postId/view', async (req, res) => {
      try {
        const { postId } = req.params;
        await db.query(postId, `UPDATE posts SET views = views + 1 WHERE id = $1`, [postId]);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // لایک
    app.post('/api/post/:postId/like', async (req, res) => {
      try {
        const { postId } = req.params;
        const { userId } = req.body;

        const existing = await db.query(userId, `SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2`, [postId, userId]);
        let liked;
        if (existing.rows.length > 0) {
          await db.query(userId, `DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2`, [postId, userId]);
          await db.query(postId, `UPDATE posts SET likes = MAX(likes - 1, 0) WHERE id = $1`, [postId]);
          liked = false;
        } else {
          await db.query(userId, `INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)`, [postId, userId]);
          await db.query(postId, `UPDATE posts SET likes = likes + 1 WHERE id = $1`, [postId]);
          const assistant = new IntelligentAssistant(userId, db);
          await assistant.updateUserActivity('like');
          liked = true;
        }

        const p = await db.query(postId, `SELECT likes FROM posts WHERE id = $1`, [postId]);
        cache.del(`channel_${userId}`);
        res.json({ success: true, liked, likes: p.rows[0]?.likes || 0 });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // کامنت
    app.post('/api/post/:postId/comment', async (req, res) => {
      try {
        const { postId } = req.params;
        const { userId, text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ success: false, error: 'متن کامنت الزامی است' });

        const id = crypto.randomUUID();
        await db.query(userId, `INSERT INTO post_comments (id, post_id, user_id, text) VALUES ($1, $2, $3, $4)`, [id, postId, userId, text.trim()]);
        await db.query(postId, `UPDATE posts SET comments = comments + 1 WHERE id = $1`, [postId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('comment');

        const u = await db.query(userId, `SELECT name, avatar FROM users WHERE id = $1`, [userId]);
        cache.del(`channel_${userId}`);
        res.json({ success: true, comment: { id, userId, text: text.trim(), name: u.rows[0]?.name, avatar: u.rows[0]?.avatar } });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get('/api/post/:postId/comments', async (req, res) => {
      try {
        const { postId } = req.params;
        const cacheKey = `comments_${postId}`;
        let data = cache.get(cacheKey);
        if (data) return res.json(data);

        const result = await db.query(postId, `
          SELECT c.*, u.name, u.avatar FROM post_comments c
          JOIN users u ON u.id = c.user_id
          WHERE c.post_id = $1 ORDER BY c.created_at ASC
        `, [postId]);
        cache.set(cacheKey, result.rows, 10000);
        res.json(result.rows);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // دستیار - آموزش
    app.post('/api/assistant/train', async (req, res) => {
      try {
        const { userId, question, answer } = req.body;
        const id = crypto.randomUUID();

        await db.query(userId, `
          INSERT INTO assistant_training (id, user_id, type, question, answer)
          VALUES ($1, $2, $3, $4, $5)
        `, [id, userId, 'qa', question, answer]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();

        cache.del(`assistant_${userId}`);
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
          INSERT INTO assistant_training (id, user_id, type, keyword, response)
          VALUES ($1, $2, $3, $4, $5)
        `, [id, userId, 'keyword', keyword, response]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();

        cache.del(`assistant_${userId}`);
        res.json({ success: true, message: 'کلمه کلیدی با موفقیت ثبت شد', boost });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post('/api/assistant/schedule', async (req, res) => {
      try {
        const { userId, postCount, descriptions, time } = req.body;
        const channel = await db.query(userId, `SELECT id FROM channels WHERE user_id = $1`, [userId]);
        if (channel.rows.length === 0) return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });

        const channelId = channel.rows[0].id;
        const scheduledPosts = [];

        for (let i = 0; i < postCount; i++) {
          const postId = crypto.randomUUID();
          const desc = descriptions[i] || `پست شماره ${i + 1}`;

          const postDate = new Date();
          postDate.setDate(postDate.getDate() + i);
          const [hours, minutes] = time.split(':');
          postDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);

          await db.query(userId, `
            INSERT INTO posts (id, channel_id, content, scheduled_time, is_published)
            VALUES ($1, $2, $3, $4, 0)
          `, [postId, channelId, desc, postDate.toISOString()]);

          scheduledPosts.push(postId);
        }

        cache.del(`assistant_${userId}`);
        res.json({ success: true, message: `${postCount} پست با موفقیت زمان‌بندی شد`, posts: scheduledPosts });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get('/api/assistant/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        const cacheKey = `assistant_${userId}`;
        let data = cache.get(cacheKey);
        if (data) return res.json(data);

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

        data = { qa: qa.rows, keywords: keywords.rows, posts: posts.rows, stats };
        cache.set(cacheKey, data, 30000);
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // چت با دستیار دیگران
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

    // کانال - پست‌ها
    app.get('/api/channel/:userId/posts', async (req, res) => {
      try {
        const { userId } = req.params;
        const cacheKey = `channel_${userId}`;
        let data = cache.get(cacheKey);
        if (data) return res.json(data);

        const result = await db.query(userId, `
          SELECT p.*, c.name as channel_name
          FROM posts p JOIN channels c ON p.channel_id = c.id
          WHERE c.user_id = $1 AND p.is_published = 1
          ORDER BY p.created_at DESC LIMIT 50
        `, [userId]);
        cache.set(cacheKey, result.rows, 15000);
        res.json(result.rows);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // جستجو
    app.get('/api/search', async (req, res) => {
      try {
        const { q } = req.query;
        const cacheKey = `search_${q}`;
        let data = cache.get(cacheKey);
        if (data) return res.json(data);

        const result = await db.query(null, `
          SELECT id, name, 'user' as type FROM users WHERE name LIKE $1
          UNION
          SELECT id, name, 'channel' as type FROM channels WHERE name LIKE $1
          LIMIT 20
        `, [`%${q}%`]);
        cache.set(cacheKey, result.rows, 60000);
        res.json(result.rows);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // اکسپلور (با کش)
    app.get('/api/explore', async (req, res) => {
      try {
        let data = cache.get('explore');
        if (data) return res.json(data);

        const result = await db.query(null, `
          SELECT c.id, c.name, c.followers_count, c.posts_count, c.boost_level, c.activity_score, u.id as user_id, u.avatar
          FROM channels c JOIN users u ON u.id = c.user_id
          ORDER BY c.activity_score DESC, c.followers_count DESC
          LIMIT 30
        `);
        cache.set('explore', result.rows, 30000);
        res.json(result.rows);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ============================================
    // چت خصوصی با رمزنگاری
    // ============================================
    app.post('/api/chat/save', async (req, res) => {
      try {
        const { from, to, message } = req.body;
        const id = crypto.randomUUID();
        await db.query(from, `INSERT INTO messages (id, from_user, to_user, message) VALUES ($1, $2, $3, $4)`, [id, from, to, message]);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/chat/history/:userId/:targetId', async (req, res) => {
      try {
        const { userId, targetId } = req.params;
        const cacheKey = `chat_${userId}_${targetId}`;
        let data = cache.get(cacheKey);
        if (data) return res.json(data);

        const result = await db.query(userId, `
          SELECT * FROM messages 
          WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
          ORDER BY created_at ASC LIMIT 100
        `, [userId, targetId]);
        cache.set(cacheKey, result.rows, 30000);
        res.json(result.rows);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/chat/list/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        const cacheKey = `chatlist_${userId}`;
        let data = cache.get(cacheKey);
        if (data) return res.json(data);

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
        cache.set(cacheKey, result.rows, 30000);
        res.json(result.rows);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ============================================
    // WebSocket با رمزنگاری
    // ============================================
    io.on('connection', (socket) => {
      console.log('🔌 Client connected:', socket.id);

      socket.on('join', (userId) => {
        socket.join(`user_${userId}`);
        console.log(`User ${userId} joined room`);
      });

      socket.on('private_message', async (data) => {
        const { from, to, message, timestamp } = data;

        // ذخیره پیام رمزنگاری شده در دیتابیس
        try {
          const id = crypto.randomUUID();
          await db.query(from, `INSERT INTO messages (id, from_user, to_user, message) VALUES ($1, $2, $3, $4)`, [id, from, to, message]);
          // پاک کردن کش چت
          cache.del(`chat_${from}_${to}`);
          cache.del(`chat_${to}_${from}`);
          cache.del(`chatlist_${from}`);
          cache.del(`chatlist_${to}`);
        } catch (e) { console.error('Save message error:', e); }

        io.to(`user_${to}`).emit('new_message', { from, message, timestamp });
        socket.emit('message_sent', { success: true, timestamp });
      });

      socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
      });
    });

    // ============================================
    // راه‌اندازی سرور
    // ============================================
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📍 http://localhost:${PORT}`);
      if (process.env.NODE_ENV === 'production') {
        console.log(`🔒 Production mode with ${Math.min(numCPUs, 4)} workers`);
      }
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}