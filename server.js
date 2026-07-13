// ================================================================
// server.js - سرور اصلی با تمام قابلیت‌ها
// ================================================================

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');

// ================================================================
// ماژول‌های خودمان
// ================================================================
const db = require('./database');
const cache = require('./cache');
const encryption = require('./encryption');

const app = express();
const server = http.createServer(app);

// ================================================================
// امنیت و بهینه‌سازی
// ================================================================
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

// ================================================================
= Rate Limiting
// ================================================================
const limiter = rateLimit({ windowMs: 60000, max: 100, message: { error: 'درخواست زیاد!' } });
app.use('/api/', limiter);
const strictLimiter = rateLimit({ windowMs: 60000, max: 10 });

// ================================================================
// Socket.IO
// ================================================================
const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  maxHttpBufferSize: 10 * 1024 * 1024,
  transports: ['websocket', 'polling']
});

io.on('connection', (socket) => {
  let userId = null;
  socket.on('join', (id) => { userId = id; socket.join(`user_${id}`); });
  socket.on('private_message', async (data) => {
    const { from, to, message, timestamp } = data;
    const encrypted = encryption.encrypt(message);
    await db.query(`INSERT INTO messages (id, from_user, to_user, message_encrypted, iv, timestamp) VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuidv4(), from, to, encrypted.encrypted, encrypted.iv, timestamp]);
    io.to(`user_${to}`).emit('new_message', { from, message, encrypted: encrypted.encrypted, iv: encrypted.iv, timestamp });
    socket.emit('message_sent', { success: true });
  });
  socket.on('typing', (data) => { io.to(`user_${data.to}`).emit('typing', { from: data.from, isTyping: data.isTyping }); });
  socket.on('follow', (data) => { io.to(`user_${data.to}`).emit('new_follower', { followerName: data.fromName }); });
  socket.on('disconnect', () => {});
});

// ================================================================
// APIها
// ================================================================

// ---------- ثبت‌نام ----------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, avatar, password } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'نام الزامی است' });
    const userId = 'user_' + crypto.randomBytes(8).toString('hex');
    const channelId = 'channel_' + userId;
    const hashed = password ? await bcrypt.hash(password, 10) : null;
    await db.query(`INSERT INTO users (id, name, avatar, password_hash) VALUES ($1,$2,$3,$4)`, [userId, name.trim(), avatar || null, hashed]);
    await db.query(`INSERT INTO channels (id, user_id, name) VALUES ($1,$2,$3)`, [channelId, userId, name.trim() + ' - کانال']);
    const token = jwt.sign({ userId }, process.env.JWT_SECRET || 'secret', { expiresIn: '30d' });
    res.json({ success: true, user: { id: userId, name: name.trim(), avatar: avatar || null, score: 0 }, token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- دریافت کاربر ----------
app.get('/api/user/:id', async (req, res) => {
  try {
    const u = await db.query(`SELECT id, name, avatar, score, bio FROM users WHERE id=$1`, [req.params.id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'یافت نشد' });
    const ch = await db.query(`SELECT followers_count, posts_count FROM channels WHERE user_id=$1`, [req.params.id]);
    res.json({ ...u.rows[0], followers: ch.rows[0]?.followers_count || 0, posts: ch.rows[0]?.posts_count || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- به‌روزرسانی کاربر ----------
app.put('/api/user/update', async (req, res) => {
  try {
    const { userId, name, bio, avatar } = req.body;
    await db.query(`UPDATE users SET name=$1, bio=$2, avatar=$3 WHERE id=$4`, [name, bio, avatar, userId]);
    await db.query(`UPDATE channels SET name=$1 WHERE user_id=$2`, [name + ' - کانال', userId]);
    await cache.del(`user_stats_${userId}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- پست جدید ----------
app.post('/api/post/create', strictLimiter, async (req, res) => {
  try {
    const { userId, content, mediaData, mediaType } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'متن الزامی است' });
    const ch = await db.query(`SELECT id FROM channels WHERE user_id=$1`, [userId]);
    if (!ch.rows[0]) return res.status(404).json({ error: 'کانال یافت نشد' });
    const postId = uuidv4();
    let mediaUrl = null;
    if (mediaData) {
      // ذخیره base64 به عنوان media_url (برای سادگی)
      mediaUrl = mediaData;
    }
    await db.query(`INSERT INTO posts (id, channel_id, content, media_url, media_type, is_published, published_at) VALUES ($1,$2,$3,$4,$5,1,CURRENT_TIMESTAMP)`,
      [postId, ch.rows[0].id, content.trim(), mediaUrl, mediaType || null]);
    await db.query(`UPDATE channels SET posts_count = posts_count + 1 WHERE user_id=$1`, [userId]);
    await db.query(`UPDATE users SET score = score + 20 WHERE id=$1`, [userId]);
    await cache.del(`posts_channel_${userId}`);
    // محاسبه boost
    const stats = await db.query(`SELECT posts_count, activity_score FROM channels WHERE user_id=$1`, [userId]);
    const score = (stats.rows[0]?.posts_count || 0) * 2 + (stats.rows[0]?.activity_score || 0);
    let level = 'normal';
    if (score > 100) level = 'high';
    if (score > 500) level = 'viral';
    if (score > 2000) level = 'superstar';
    await db.query(`UPDATE channels SET boost_level=$1, activity_score=$2 WHERE user_id=$3`, [level, score, userId]);
    res.json({ success: true, postId, boost: { boostLevel: level } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- دریافت پست‌های کانال ----------
app.get('/api/channel/:userId/posts', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const cacheKey = `posts_channel_${req.params.userId}_page_${page}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);
    const result = await db.query(
      `SELECT p.*, c.name as channel_name FROM posts p JOIN channels c ON p.channel_id = c.id WHERE c.user_id=$1 AND p.is_published=1 ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
      [req.params.userId, limit, offset]
    );
    const total = await db.query(`SELECT COUNT(*) as count FROM posts p JOIN channels c ON p.channel_id=c.id WHERE c.user_id=$1 AND p.is_published=1`, [req.params.userId]);
    const data = { posts: result.rows, total: parseInt(total.rows[0]?.count || 0), page, limit, pages: Math.ceil(total.rows[0]?.count / limit) || 1 };
    await cache.set(cacheKey, data, 30);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- لایک ----------
app.post('/api/post/:postId/like', async (req, res) => {
  try {
    const { postId } = req.params;
    const { userId } = req.body;
    const existing = await db.query(`SELECT 1 FROM post_likes WHERE post_id=$1 AND user_id=$2`, [postId, userId]);
    let liked;
    if (existing.rows.length > 0) {
      await db.query(`DELETE FROM post_likes WHERE post_id=$1 AND user_id=$2`, [postId, userId]);
      await db.query(`UPDATE posts SET likes = MAX(likes - 1, 0) WHERE id=$1`, [postId]);
      liked = false;
    } else {
      await db.query(`INSERT INTO post_likes (post_id, user_id) VALUES ($1,$2)`, [postId, userId]);
      await db.query(`UPDATE posts SET likes = likes + 1 WHERE id=$1`, [postId]);
      await db.query(`UPDATE users SET score = score + 2 WHERE id=$1`, [userId]);
      liked = true;
    }
    const p = await db.query(`SELECT likes FROM posts WHERE id=$1`, [postId]);
    res.json({ success: true, liked, likes: p.rows[0]?.likes || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- کامنت ----------
app.post('/api/post/:postId/comment', async (req, res) => {
  try {
    const { postId } = req.params;
    const { userId, text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'متن الزامی است' });
    const id = uuidv4();
    await db.query(`INSERT INTO post_comments (id, post_id, user_id, text) VALUES ($1,$2,$3,$4)`, [id, postId, userId, text.trim()]);
    await db.query(`UPDATE posts SET comments = comments + 1 WHERE id=$1`, [postId]);
    await db.query(`UPDATE users SET score = score + 5 WHERE id=$1`, [userId]);
    const u = await db.query(`SELECT name, avatar FROM users WHERE id=$1`, [userId]);
    res.json({ success: true, comment: { id, userId, text: text.trim(), name: u.rows[0]?.name, avatar: u.rows[0]?.avatar } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- دریافت کامنت‌ها ----------
app.get('/api/post/:postId/comments', async (req, res) => {
  try {
    const result = await db.query(`SELECT c.*, u.name, u.avatar FROM post_comments c JOIN users u ON u.id = c.user_id WHERE c.post_id=$1 ORDER BY c.created_at ASC`, [req.params.postId]);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- فالو ----------
app.post('/api/follow', strictLimiter, async (req, res) => {
  try {
    const { followerId, followingId } = req.body;
    if (followerId === followingId) return res.status(400).json({ error: 'نمی‌توانید خودتان را فالو کنید' });
    const existing = await db.query(`SELECT 1 FROM follows WHERE follower_id=$1 AND following_id=$2`, [followerId, followingId]);
    if (existing.rows.length > 0) return res.json({ success: true, alreadyFollowing: true });
    await db.query(`INSERT INTO follows (follower_id, following_id) VALUES ($1,$2)`, [followerId, followingId]);
    await db.query(`UPDATE channels SET followers_count = followers_count + 1 WHERE user_id=$1`, [followingId]);
    await db.query(`UPDATE users SET score = score + 15 WHERE id=$1`, [followerId]);
    await cache.del(`profile_${followingId}`);
    await cache.del('explore');
    io.to(`user_${followingId}`).emit('new_follower', { followerName: followerId });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- آنفالو ----------
app.post('/api/unfollow', async (req, res) => {
  try {
    const { followerId, followingId } = req.body;
    await db.query(`DELETE FROM follows WHERE follower_id=$1 AND following_id=$2`, [followerId, followingId]);
    await db.query(`UPDATE channels SET followers_count = MAX(followers_count - 1, 0) WHERE user_id=$1`, [followingId]);
    await cache.del(`profile_${followingId}`);
    await cache.del('explore');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- اکسپلور ----------
app.get('/api/explore', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const offset = (page - 1) * limit;
    const cacheKey = `explore_page_${page}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);
    const result = await db.query(
      `SELECT c.id, c.name, c.followers_count, c.posts_count, c.boost_level, c.activity_score, u.id as user_id, u.avatar FROM channels c JOIN users u ON u.id = c.user_id ORDER BY c.activity_score DESC, c.followers_count DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = await db.query(`SELECT COUNT(*) as count FROM channels`);
    const data = { items: result.rows, total: parseInt(total.rows[0]?.count || 0), page, limit, pages: Math.ceil(total.rows[0]?.count / limit) || 1 };
    await cache.set(cacheKey, data, 60);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- پروفایل عمومی ----------
app.get('/api/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { viewerId } = req.query;
    const u = await db.query(`SELECT id, name, avatar, bio, score FROM users WHERE id=$1`, [userId]);
    if (!u.rows[0]) return res.status(404).json({ error: 'یافت نشد' });
    const ch = await db.query(`SELECT * FROM channels WHERE user_id=$1`, [userId]);
    const posts = await db.query(`SELECT * FROM posts WHERE channel_id=$1 AND is_published=1 ORDER BY created_at DESC LIMIT 30`, [ch.rows[0]?.id]);
    let isFollowing = false;
    if (viewerId) {
      const f = await db.query(`SELECT 1 FROM follows WHERE follower_id=$1 AND following_id=$2`, [viewerId, userId]);
      isFollowing = f.rows.length > 0;
    }
    res.json({ user: u.rows[0], channel: ch.rows[0], posts: posts.rows, isFollowing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- دستیار: آموزش ----------
app.post('/api/assistant/train', async (req, res) => {
  try {
    const { userId, question, answer } = req.body;
    const id = uuidv4();
    await db.query(`INSERT INTO assistant_training (id, user_id, type, question, answer) VALUES ($1,$2,'qa',$3,$4)`, [id, userId, question, answer]);
    await db.query(`UPDATE users SET score = score + 10 WHERE id=$1`, [userId]);
    await cache.del(`assistant_trainings_${userId}`);
    // به‌روزرسانی boost
    const stats = await db.query(`SELECT posts_count, activity_score FROM channels WHERE user_id=$1`, [userId]);
    const score = (stats.rows[0]?.posts_count || 0) * 2 + (stats.rows[0]?.activity_score || 0) + 10;
    let level = 'normal';
    if (score > 100) level = 'high';
    if (score > 500) level = 'viral';
    if (score > 2000) level = 'superstar';
    await db.query(`UPDATE channels SET boost_level=$1, activity_score=$2 WHERE user_id=$3`, [level, score, userId]);
    res.json({ success: true, boost: { boostLevel: level } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- دستیار: کلمه کلیدی ----------
app.post('/api/assistant/keyword', async (req, res) => {
  try {
    const { userId, keyword, response } = req.body;
    const id = uuidv4();
    await db.query(`INSERT INTO assistant_training (id, user_id, type, keyword, response) VALUES ($1,$2,'keyword',$3,$4)`, [id, userId, keyword, response]);
    await db.query(`UPDATE users SET score = score + 10 WHERE id=$1`, [userId]);
    await cache.del(`assistant_trainings_${userId}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- دریافت داده‌های دستیار ----------
app.get('/api/assistant/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const qa = await db.query(`SELECT id, question, answer FROM assistant_training WHERE user_id=$1 AND type='qa' ORDER BY created_at DESC`, [userId]);
    const keywords = await db.query(`SELECT id, keyword, response FROM assistant_training WHERE user_id=$1 AND type='keyword' ORDER BY created_at DESC`, [userId]);
    const posts = await db.query(`SELECT p.* FROM posts p JOIN channels c ON p.channel_id = c.id WHERE c.user_id=$1 AND p.is_published=0 ORDER BY p.scheduled_time ASC`, [userId]);
    const stats = await db.query(`SELECT COUNT(*) as total_posts, SUM(likes) as total_likes FROM posts p JOIN channels c ON p.channel_id=c.id WHERE c.user_id=$1 AND p.is_published=1`, [userId]);
    const trainings = await db.query(`SELECT COUNT(*) as total FROM assistant_training WHERE user_id=$1`, [userId]);
    const followers = await db.query(`SELECT followers_count FROM channels WHERE user_id=$1`, [userId]);
    const totalPosts = parseInt(stats.rows[0]?.total_posts || 0);
    const totalLikes = parseInt(stats.rows[0]?.total_likes || 0);
    const engagement = totalPosts > 0 ? Math.round((totalLikes / totalPosts) * 100) : 0;
    res.json({
      qa: qa.rows, keywords: keywords.rows, posts: posts.rows,
      stats: { totalPosts, totalLikes, totalTrainings: parseInt(trainings.rows[0]?.total || 0), followers: parseInt(followers.rows[0]?.followers_count || 0), engagementRate: engagement + '%' }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- چت با دستیار ----------
app.post('/api/assistant/chat/:targetUserId', async (req, res) => {
  try {
    const { targetUserId } = req.params;
    const { message } = req.body;
    const trainings = await db.query(`SELECT * FROM assistant_training WHERE user_id=$1`, [targetUserId]);
    let reply = null;
    for (const t of trainings.rows) {
      if (t.type === 'keyword' && t.keyword && message.includes(t.keyword)) { reply = t.response; break; }
      if (t.type === 'qa' && t.question && (message.includes(t.question) || t.question.includes(message))) { reply = t.answer; break; }
    }
    res.json({ reply: reply || '🤖 دستیار هنوز برای این موضوع آموزش ندیده' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- زمان‌بندی پست ----------
app.post('/api/schedule/posts', strictLimiter, async (req, res) => {
  try {
    const { userId, posts } = req.body;
    if (!posts?.length) return res.status(400).json({ error: 'پستی وجود ندارد' });
    const ch = await db.query(`SELECT id FROM channels WHERE user_id=$1`, [userId]);
    if (!ch.rows[0]) return res.status(404).json({ error: 'کانال یافت نشد' });
    const scheduled = [];
    for (const post of posts) {
      const id = uuidv4();
      await db.query(`INSERT INTO posts (id, channel_id, content, scheduled_time, is_published) VALUES ($1,$2,$3,$4,0)`,
        [id, ch.rows[0].id, post.content, post.scheduledTime]);
      scheduled.push(id);
    }
    res.json({ success: true, posts: scheduled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- لغو پست زمان‌بندی ----------
app.delete('/api/schedule/posts/:postId', async (req, res) => {
  try {
    await db.query(`DELETE FROM posts WHERE id=$1 AND is_published=0`, [req.params.postId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- تاریخچه چت ----------
app.get('/api/chat/history/:userId/:targetId', async (req, res) => {
  try {
    const { userId, targetId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const result = await db.query(
      `SELECT * FROM messages WHERE (from_user=$1 AND to_user=$2) OR (from_user=$2 AND to_user=$1) ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [userId, targetId, limit, offset]
    );
    const decrypted = result.rows.map(msg => {
      if (msg.message_encrypted && msg.iv) {
        try { msg.message = encryption.decrypt(msg.message_encrypted, msg.iv); } catch (e) { msg.message = '[رمزگشایی نشد]'; }
      }
      return msg;
    });
    res.json(decrypted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- لیست چت‌ها ----------
app.get('/api/chat/list/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await db.query(
      `SELECT DISTINCT CASE WHEN from_user=$1 THEN to_user ELSE from_user END as id, u.name, u.avatar,
       (SELECT message_encrypted FROM messages WHERE (from_user=u.id AND to_user=$1) OR (from_user=$1 AND to_user=u.id) ORDER BY created_at DESC LIMIT 1) as lastMessage
       FROM messages m JOIN users u ON u.id = CASE WHEN m.from_user=$1 THEN m.to_user ELSE m.from_user END WHERE m.from_user=$1 OR m.to_user=$1`,
      [userId]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- جستجو ----------
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    const result = await db.query(`SELECT id, name, 'user' as type FROM users WHERE name LIKE $1 LIMIT 20`, [`%${q}%`]);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- نوتیفیکیشن‌ها ----------
app.get('/api/notifications/:userId', async (req, res) => {
  try {
    // برای سادگی، نوتیفیکیشن‌های پیش‌فرض
    res.json({ notifications: [], unread: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// راه‌اندازی
// ================================================================
const PORT = process.env.PORT || 3000;
(async () => {
  await db.initTables();
  await cache.connect();
  server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
})();