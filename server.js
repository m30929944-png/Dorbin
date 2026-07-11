const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ============================================
// 📁 پوشه‌ها
// ============================================
const dirs = ['./uploads', './uploads/posts', './uploads/stories', './public'];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ============================================
// 🔐 رمزنگاری
// ============================================
const SECRET_KEY = crypto.randomBytes(32).toString('hex');

function hashPassword(password) {
    return crypto.createHash('sha512').update(password + SECRET_KEY).digest('hex');
}

function generateToken() {
    return crypto.randomBytes(64).toString('hex');
}

function log(msg) {
    console.log('[' + new Date().toISOString() + '] ' + msg);
}

// ============================================
// 📊 دیتابیس با ۵ شارد
// ============================================
class Database {
    constructor() {
        this.shards = {};
        this.shardCount = 5;
        for (let i = 0; i < this.shardCount; i++) {
            this.shards[i] = {
                users: {},
                posts: [],
                stories: [],
                messages: {},
                likes: {},
                comments: {}
            };
        }
        this.currentId = 1;
        this.storyId = 1;
        this.sessions = {};
        this.onlineUsers = {};
        this.currentUserSessions = {};
    }

    getShard(key) {
        const hash = crypto.createHash('md5').update(key).digest('hex');
        return parseInt(hash.substring(0, 2), 16) % this.shardCount;
    }

    getShardById(id) {
        if (!id) return 0;
        const hash = crypto.createHash('md5').update(id).digest('hex');
        return parseInt(hash.substring(0, 2), 16) % this.shardCount;
    }

    // ===== Users =====
    getUserByEmail(email) {
        for (let i = 0; i < this.shardCount; i++) {
            for (const key in this.shards[i].users) {
                if (this.shards[i].users[key].email === email) {
                    return this.shards[i].users[key];
                }
            }
        }
        return null;
    }

    getUserById(userId) {
        const shard = this.getShardById(userId);
        return this.shards[shard].users[userId] || null;
    }

    saveUser(user) {
        const shard = this.getShard(user.userId);
        this.shards[shard].users[user.userId] = user;
        return user;
    }

    getAllUsers() {
        let all = [];
        for (let i = 0; i < this.shardCount; i++) {
            for (const key in this.shards[i].users) {
                all.push(this.shards[i].users[key]);
            }
        }
        return all;
    }

    updateUser(userId, data) {
        const shard = this.getShardById(userId);
        if (this.shards[shard].users[userId]) {
            this.shards[shard].users[userId] = { ...this.shards[shard].users[userId], ...data };
            return this.shards[shard].users[userId];
        }
        return null;
    }

    // ===== Posts =====
    savePost(post) {
        const shard = this.getShardById(post.postId);
        this.shards[shard].posts.unshift(post);
        return post;
    }

    getPosts(page, limit, hashtag) {
        page = page || 1;
        limit = limit || 20;
        let all = [];
        for (let i = 0; i < this.shardCount; i++) {
            all = all.concat(this.shards[i].posts);
        }
        if (hashtag) {
            all = all.filter(p => p.hashtags && p.hashtags.some(h => h.toLowerCase() === hashtag.toLowerCase()));
        }
        all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const start = (page - 1) * limit;
        return {
            posts: all.slice(start, start + limit),
            total: all.length,
            page: page,
            totalPages: Math.ceil(all.length / limit)
        };
    }

    getPostById(postId) {
        const shard = this.getShardById(postId);
        return this.shards[shard].posts.find(p => p.postId === postId) || null;
    }

    deletePost(postId) {
        const shard = this.getShardById(postId);
        const idx = this.shards[shard].posts.findIndex(p => p.postId === postId);
        if (idx !== -1) {
            this.shards[shard].posts.splice(idx, 1);
            return true;
        }
        return false;
    }

    likePost(postId, userId) {
        const shard = this.getShardById(postId);
        const post = this.shards[shard].posts.find(p => p.postId === postId);
        if (!post) return { liked: false, likes: 0 };
        const key = postId + '_' + userId;
        if (this.shards[shard].likes[key]) {
            delete this.shards[shard].likes[key];
            post.likes -= 1;
            return { liked: false, likes: post.likes };
        } else {
            this.shards[shard].likes[key] = true;
            post.likes += 1;
            return { liked: true, likes: post.likes };
        }
    }

    addComment(postId, comment) {
        const shard = this.getShardById(postId);
        const post = this.shards[shard].posts.find(p => p.postId === postId);
        if (!post) return false;
        if (!post.comments) post.comments = [];
        post.comments.push(comment);
        return true;
    }

    // ===== Stories =====
    saveStory(story) {
        const shard = this.getShardById(story.storyId);
        this.shards[shard].stories.push(story);
        return story;
    }

    getStories() {
        let all = [];
        const now = Date.now();
        for (let i = 0; i < this.shardCount; i++) {
            all = all.concat(this.shards[i].stories.filter(s => {
                return (now - new Date(s.createdAt).getTime()) < 24 * 60 * 60 * 1000;
            }));
        }
        return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    viewStory(storyId, userId) {
        const shard = this.getShardById(storyId);
        const story = this.shards[shard].stories.find(s => s.storyId === storyId);
        if (story && !story.viewers) story.viewers = [];
        if (story && !story.viewers.includes(userId)) {
            story.views = (story.views || 0) + 1;
            story.viewers.push(userId);
            return true;
        }
        return false;
    }

    // ===== Messages =====
    saveMessage(roomId, msg) {
        const shard = this.getShardById(roomId);
        if (!this.shards[shard].messages[roomId]) {
            this.shards[shard].messages[roomId] = [];
        }
        this.shards[shard].messages[roomId].push(msg);
        return msg;
    }

    getMessages(roomId, limit) {
        limit = limit || 50;
        const shard = this.getShardById(roomId);
        if (!this.shards[shard].messages[roomId]) return [];
        return this.shards[shard].messages[roomId].slice(-limit);
    }

    // ===== Stats =====
    getStats() {
        let users = 0;
        let posts = 0;
        let stories = 0;
        let messages = 0;
        for (let i = 0; i < this.shardCount; i++) {
            users += Object.keys(this.shards[i].users).length;
            posts += this.shards[i].posts.length;
            stories += this.shards[i].stories.length;
            for (const room in this.shards[i].messages) {
                messages += this.shards[i].messages[room].length;
            }
        }
        return {
            totalUsers: users,
            totalPosts: posts,
            totalStories: stories,
            totalMessages: messages,
            onlineUsers: Object.keys(this.onlineUsers).length || 0,
            shardCount: this.shardCount
        };
    }
}

const db = new Database();

const ADMIN_EMAIL = 'milad.yari1377m@gmail.com';
const ADMIN_PASSWORD = 'M09145978426m';

// ============================================
// 📡 API
// ============================================

// ===== ثبت نام =====
app.post('/api/auth/register', (req, res) => {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'همه فیلدها الزامی هستند' });
    }

    if (db.getUserByEmail(email)) {
        return res.status(400).json({ error: 'این ایمیل قبلاً ثبت شده است' });
    }

    const userId = 'user_' + uuidv4();
    const isAdmin = email === ADMIN_EMAIL;

    const user = {
        userId: userId,
        username: username,
        email: email,
        password: hashPassword(password),
        bio: '',
        avatar: '',
        followers: 0,
        following: 0,
        postsCount: 0,
        language: 'fa',
        theme: 'light',
        isOnline: false,
        isAdmin: isAdmin,
        isBanned: false,
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString()
    };

    db.saveUser(user);
    const token = generateToken();
    db.currentUserSessions[token] = userId;
    db.onlineUsers[userId] = { socketId: null, username: username };

    log('User registered: ' + username + ' (' + email + ') - Admin: ' + isAdmin);

    res.json({
        success: true,
        token: token,
        user: {
            userId: userId,
            username: username,
            email: email,
            bio: '',
            avatar: '',
            followers: 0,
            following: 0,
            postsCount: 0,
            isAdmin: isAdmin,
            isBanned: false,
            language: 'fa',
            theme: 'light'
        }
    });
});

// ===== ورود =====
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'ایمیل و رمز عبور الزامی است' });
    }

    const user = db.getUserByEmail(email);
    if (!user || user.password !== hashPassword(password)) {
        return res.status(401).json({ error: 'ایمیل یا رمز عبور اشتباه است' });
    }

    if (user.isBanned) {
        return res.status(403).json({ error: 'این کاربر مسدود شده است' });
    }

    const token = generateToken();
    db.currentUserSessions[token] = user.userId;
    db.onlineUsers[user.userId] = { socketId: null, username: user.username };
    user.isOnline = true;
    user.lastSeen = new Date().toISOString();
    db.updateUser(user.userId, { isOnline: true, lastSeen: user.lastSeen });

    log('User logged in: ' + user.username);

    res.json({
        success: true,
        token: token,
        user: {
            userId: user.userId,
            username: user.username,
            email: user.email,
            bio: user.bio || '',
            avatar: user.avatar || '',
            followers: user.followers || 0,
            following: user.following || 0,
            postsCount: user.postsCount || 0,
            isAdmin: user.isAdmin || false,
            isBanned: user.isBanned || false,
            language: user.language || 'fa',
            theme: user.theme || 'light'
        }
    });
});

// ===== خروج =====
app.post('/api/auth/logout', (req, res) => {
    const { token } = req.body;
    if (token && db.currentUserSessions[token]) {
        const userId = db.currentUserSessions[token];
        delete db.currentUserSessions[token];
        delete db.onlineUsers[userId];
        db.updateUser(userId, { isOnline: false, lastSeen: new Date().toISOString() });
    }
    res.json({ success: true });
});

// ===== اطلاعات کاربر =====
app.get('/api/auth/me', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = db.currentUserSessions[token];
    if (!userId) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    const user = db.getUserById(userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    if (user.isBanned) {
        return res.status(403).json({ error: 'User is banned' });
    }

    res.json({
        userId: user.userId,
        username: user.username,
        email: user.email,
        bio: user.bio || '',
        avatar: user.avatar || '',
        followers: user.followers || 0,
        following: user.following || 0,
        postsCount: user.postsCount || 0,
        isAdmin: user.isAdmin || false,
        isBanned: user.isBanned || false,
        language: user.language || 'fa',
        theme: user.theme || 'light'
    });
});

// ===== ادمین =====
app.post('/api/admin/verify', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const userId = db.currentUserSessions[token];
    if (!userId) return res.status(401).json({ error: 'Invalid token' });
    const user = db.getUserById(userId);
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    res.json({ success: true, isAdmin: true });
});

app.get('/api/admin/users', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const userId = db.currentUserSessions[token];
    if (!userId) return res.status(401).json({ error: 'Invalid token' });
    const admin = db.getUserById(userId);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const users = db.getAllUsers().map(u => ({
        userId: u.userId,
        username: u.username,
        email: u.email,
        bio: u.bio || '',
        avatar: u.avatar || '',
        followers: u.followers || 0,
        following: u.following || 0,
        postsCount: u.postsCount || 0,
        isAdmin: u.isAdmin || false,
        isBanned: u.isBanned || false,
        isOnline: u.isOnline || false,
        createdAt: u.createdAt,
        lastSeen: u.lastSeen
    }));
    res.json(users);
});

app.put('/api/admin/users/:userId/ban', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const adminId = db.currentUserSessions[token];
    if (!adminId) return res.status(401).json({ error: 'Invalid token' });
    const admin = db.getUserById(adminId);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const { userId } = req.params;
    const { banned } = req.body;
    const user = db.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isAdmin) return res.status(403).json({ error: 'Cannot ban admin' });

    db.updateUser(userId, { isBanned: banned });
    if (banned) {
        // قطع اتصال کاربر
        delete db.onlineUsers[userId];
    }
    res.json({ success: true, isBanned: banned });
});

app.get('/api/admin/posts', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const userId = db.currentUserSessions[token];
    if (!userId) return res.status(401).json({ error: 'Invalid token' });
    const admin = db.getUserById(userId);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const result = db.getPosts(1, 1000);
    res.json(result.posts);
});

app.delete('/api/admin/posts/:postId', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const adminId = db.currentUserSessions[token];
    if (!adminId) return res.status(401).json({ error: 'Invalid token' });
    const admin = db.getUserById(adminId);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const { postId } = req.params;
    const deleted = db.deletePost(postId);
    res.json({ success: deleted });
});

app.post('/api/admin/broadcast', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const adminId = db.currentUserSessions[token];
    if (!adminId) return res.status(401).json({ error: 'Invalid token' });
    const admin = db.getUserById(adminId);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    io.emit('broadcast', {
        message: message,
        from: admin.username,
        timestamp: new Date().toISOString()
    });

    res.json({ success: true, message: message });
});

app.get('/api/admin/stats', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const userId = db.currentUserSessions[token];
    if (!userId) return res.status(401).json({ error: 'Invalid token' });
    const admin = db.getUserById(userId);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const stats = db.getStats();
    res.json(stats);
});

// ===== کاربران =====
app.get('/api/users', (req, res) => {
    const users = db.getAllUsers().map(u => ({
        userId: u.userId,
        username: u.username,
        avatar: u.avatar || '',
        bio: u.bio || '',
        followers: u.followers || 0,
        following: u.following || 0,
        isOnline: u.isOnline || false,
        isBanned: u.isBanned || false,
        lastSeen: u.lastSeen
    }));
    res.json(users);
});

app.put('/api/users/:userId/profile', (req, res) => {
    const { userId } = req.params;
    const { bio, avatar, language, theme } = req.body;
    const user = db.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (bio !== undefined) user.bio = bio;
    if (avatar !== undefined) user.avatar = avatar;
    if (language !== undefined) user.language = language;
    if (theme !== undefined) user.theme = theme;

    db.updateUser(userId, user);
    res.json({ success: true, user: user });
});

app.post('/api/users/:userId/follow', (req, res) => {
    const { userId } = req.params;
    const { followerId } = req.body;

    const target = db.getUserById(userId);
    const follower = db.getUserById(followerId);

    if (!target || !follower) return res.status(404).json({ error: 'User not found' });
    if (userId === followerId) return res.status(400).json({ error: 'Cannot follow yourself' });

    db.updateUser(userId, { followers: (target.followers || 0) + 1 });
    db.updateUser(followerId, { following: (follower.following || 0) + 1 });

    res.json({ success: true, followers: target.followers + 1 });
});

// ===== پست‌ها =====
const storage = multer.diskStorage({
    destination: './uploads/posts/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
        cb(null, allowed.includes(file.mimetype));
    }
});

app.get('/api/posts', (req, res) => {
    const { page = 1, limit = 20, hashtag } = req.query;
    const result = db.getPosts(parseInt(page), parseInt(limit), hashtag);
    res.json(result);
});

app.post('/api/posts', upload.single('file'), (req, res) => {
    const { caption, userId, username, hashtags } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'فایل انتخاب نشده است' });

    const user = db.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'User is banned' });

    const isVideo = file.mimetype.startsWith('video/');
    const postId = 'post_' + uuidv4();

    const newPost = {
        postId: postId,
        userId: userId,
        username: username || user.username,
        image: '/uploads/posts/' + file.filename,
        caption: caption || '',
        hashtags: hashtags ? hashtags.split(',').map(h => h.trim()) : [],
        likes: 0,
        comments: [],
        shares: 0,
        views: 0,
        isVideo: isVideo,
        createdAt: new Date().toISOString()
    };

    db.savePost(newPost);
    db.updateUser(userId, { postsCount: (user.postsCount || 0) + 1 });

    log('Post created: ' + postId + ' by ' + username);
    res.status(201).json(newPost);
});

app.put('/api/posts/:postId/like', (req, res) => {
    const { postId } = req.params;
    const { userId } = req.body;

    const user = db.getUserById(userId);
    if (!user || user.isBanned) return res.status(403).json({ error: 'User is banned' });

    const result = db.likePost(postId, userId);
    res.json(result);
});

app.post('/api/posts/:postId/comment', (req, res) => {
    const { postId } = req.params;
    const { userId, username, text } = req.body;

    const user = db.getUserById(userId);
    if (!user || user.isBanned) return res.status(403).json({ error: 'User is banned' });

    const comment = {
        commentId: 'cmt_' + uuidv4(),
        userId: userId,
        username: username || user.username,
        text: text,
        createdAt: new Date().toISOString()
    };

    const added = db.addComment(postId, comment);
    if (!added) return res.status(404).json({ error: 'Post not found' });

    res.json({ success: true, comment: comment });
});

// ===== استوری‌ها =====
const storyStorage = multer.diskStorage({
    destination: './uploads/stories/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const storyUpload = multer({
    storage: storyStorage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'video/mp4'];
        cb(null, allowed.includes(file.mimetype));
    }
});

app.get('/api/stories', (req, res) => {
    const stories = db.getStories();
    res.json(stories);
});

app.post('/api/stories', storyUpload.single('file'), (req, res) => {
    const { userId, username } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'فایل انتخاب نشده است' });

    const user = db.getUserById(userId);
    if (!user || user.isBanned) return res.status(403).json({ error: 'User is banned' });

    const isVideo = file.mimetype.startsWith('video/');
    const storyId = 'story_' + uuidv4();

    const newStory = {
        storyId: storyId,
        userId: userId,
        username: username || user.username,
        image: '/uploads/stories/' + file.filename,
        isVideo: isVideo,
        views: 0,
        viewers: [],
        createdAt: new Date().toISOString()
    };

    db.saveStory(newStory);
    res.status(201).json(newStory);
});

app.post('/api/stories/:storyId/view', (req, res) => {
    const { storyId } = req.params;
    const { userId } = req.body;

    const viewed = db.viewStory(storyId, userId);
    res.json({ success: viewed });
});

// ============================================
// 💬 WebSocket چت
// ============================================

io.on('connection', (socket) => {
    log('Socket connected: ' + socket.id);

    socket.on('register', (data) => {
        const { userId, username } = data;
        if (db.onlineUsers[userId]) {
            db.onlineUsers[userId].socketId = socket.id;
        }
        socket.userId = userId;
        socket.username = username;
        const user = db.getUserById(userId);
        if (user) {
            db.updateUser(userId, { isOnline: true, lastSeen: new Date().toISOString() });
        }
        io.emit('users-online', Object.keys(db.onlineUsers));
        log('User online: ' + username);
    });

    socket.on('join-room', (data) => {
        const { roomId, userId } = data;
        socket.join(roomId);
        socket.roomId = roomId;
        const messages = db.getMessages(roomId, 50);
        socket.emit('history', messages);
        log('User joined room: ' + userId + ' -> ' + roomId);
    });

    socket.on('send-message', (data) => {
        const { roomId, userId, username, message } = data;
        const user = db.getUserById(userId);
        if (user && user.isBanned) {
            socket.emit('error', { message: 'You are banned' });
            return;
        }
        const msgData = {
            messageId: 'msg_' + uuidv4(),
            userId: userId,
            username: username,
            message: message,
            timestamp: new Date().toISOString()
        };
        db.saveMessage(roomId, msgData);
        io.to(roomId).emit('receive-message', msgData);
        log('Message: ' + username + ' -> ' + roomId);
    });

    socket.on('leave-room', (data) => {
        const { roomId, userId } = data;
        socket.leave(roomId);
        log('User left room: ' + userId);
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            delete db.onlineUsers[socket.userId];
            db.updateUser(socket.userId, { isOnline: false, lastSeen: new Date().toISOString() });
            io.emit('users-online', Object.keys(db.onlineUsers));
            log('User disconnected: ' + socket.userId);
        }
    });
});

// ============================================
// 🌐 صفحه HTML
// ============================================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>سوشال مدیا</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        :root { --bg: #fafafa; --text: #262626; --card: #ffffff; --border: #dbdbdb; --primary: #0095f6; --shadow: 0 2px 10px rgba(0,0,0,0.1); }
        [data-theme="dark"] { --bg: #121212; --text: #ffffff; --card: #1e1e1e; --border: #2c2c2c; }
        body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', Tahoma, sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; transition: 0.3s; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

        .header { background: var(--card); border-bottom: 1px solid var(--border); padding: 12px 16px; display: flex; align-items: center; gap: 15px; flex-shrink: 0; z-index: 100; }
        .menu-icon { font-size: 24px; cursor: pointer; color: var(--text); }
        .logo { font-size: 20px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
        .logo i { color: var(--primary); }
        .search-box { flex: 1; max-width: 400px; background: var(--bg); padding: 8px 16px; border-radius: 24px; display: flex; align-items: center; gap: 10px; border: 1px solid var(--border); }
        .search-box input { border: none; background: transparent; outline: none; width: 100%; font-size: 14px; color: var(--text); }
        .search-box input::placeholder { color: #888; }
        .header-right { display: flex; gap: 18px; font-size: 22px; color: var(--text); }
        .header-right i { cursor: pointer; transition: 0.3s; }
        .header-right i:hover { color: var(--primary); }

        .stories-section { background: var(--card); padding: 12px 16px; border-bottom: 1px solid var(--border); overflow-x: auto; flex-shrink: 0; }
        .stories-container { display: flex; gap: 16px; }
        .story-item { display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; flex-shrink: 0; transition: 0.3s; }
        .story-item:hover { transform: scale(1.03); }
        .story-avatar { width: 64px; height: 64px; border-radius: 50%; padding: 2px; background: linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888); }
        .story-avatar img { width: 100%; height: 100%; border-radius: 50%; border: 2px solid var(--card); object-fit: cover; }
        .story-avatar.add-story { background: var(--bg); border: 2px dashed var(--border); padding: 0; display: flex; align-items: center; justify-content: center; }
        .story-avatar.add-story i { font-size: 28px; color: var(--primary); }
        .story-username { font-size: 11px; color: var(--text); max-width: 64px; overflow: hidden; white-space: nowrap; text-align: center; }

        .gallery-wrapper { flex: 1; overflow-y: auto; padding-bottom: 70px; }
        .gallery { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 4px; max-width: 935px; margin: 0 auto; }
        .gallery-item { background: var(--card); overflow: hidden; border: 1px solid var(--border); cursor: pointer; position: relative; border-radius: 4px; transition: 0.3s; }
        .gallery-item:hover { transform: scale(1.01); box-shadow: var(--shadow); }
        .gallery-item .image-container { width: 100%; aspect-ratio: 1; overflow: hidden; background: #ddd; }
        .gallery-item .image-container img { width: 100%; height: 100%; object-fit: cover; }
        .gallery-item .explore-post-actions { display: flex; position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,0.7)); padding: 12px 8px 8px; justify-content: space-around; color: white; opacity: 0; transition: 0.3s; }
        .gallery-item:hover .explore-post-actions { opacity: 1; }
        .gallery-item .explore-post-actions .action-btn { display: flex; align-items: center; gap: 4px; color: white; font-size: 13px; cursor: pointer; padding: 4px 10px; border-radius: 6px; border: none; background: transparent; font-family: inherit; transition: 0.3s; }
        .gallery-item .explore-post-actions .action-btn:hover { background: rgba(255,255,255,0.15); transform: scale(1.05); }
        .gallery-item .explore-post-actions .action-btn.liked i { color: #ed4956; }

        .bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; background: var(--card); border-top: 1px solid var(--border); display: flex; justify-content: space-around; padding: 8px 0 12px; z-index: 100; height: 65px; }
        .bottom-nav button { background: transparent; border: none; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 10px; color: #888; padding: 4px 16px; border-radius: 30px; font-family: inherit; transition: 0.3s; }
        .bottom-nav button i { font-size: 24px; color: #888; transition: 0.3s; }
        .bottom-nav button:hover { background: var(--bg); }
        .bottom-nav button.active i { color: var(--primary); }
        .bottom-nav button.active { color: var(--primary); }

        .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 300; justify-content: center; align-items: center; padding: 20px; backdrop-filter: blur(4px); }
        .modal-overlay.active { display: flex; }
        .modal-content { background: var(--card); border-radius: 12px; max-width: 520px; width: 100%; max-height: 80vh; display: flex; flex-direction: column; overflow: hidden; direction: rtl; box-shadow: var(--shadow); animation: modalIn 0.3s ease; }
        @keyframes modalIn { from { opacity: 0; transform: scale(0.95) translateY(20px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        .modal-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
        .modal-header h3 { font-size: 16px; color: var(--text); }
        .modal-header .close-modal { font-size: 24px; cursor: pointer; color: var(--text); background: none; border: none; }
        .modal-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
        .modal-footer { padding: 12px 20px; border-top: 1px solid var(--border); display: flex; gap: 10px; flex-shrink: 0; }
        .modal-footer input { flex: 1; padding: 10px 14px; border: 1px solid var(--border); border-radius: 24px; outline: none; font-size: 14px; background: var(--bg); color: var(--text); direction: rtl; }
        .modal-footer input:focus { border-color: var(--primary); }
        .modal-footer button { background: var(--primary); color: white; border: none; padding: 10px 24px; border-radius: 24px; font-weight: 600; cursor: pointer; font-family: inherit; transition: 0.3s; }
        .modal-footer button:hover { background: #0081d6; transform: scale(1.02); }

        .comment-item { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
        .comment-item:last-child { border-bottom: none; }
        .comment-avatar { width: 36px; height: 36px; border-radius: 50%; background: var(--border); flex-shrink: 0; overflow: hidden; }
        .comment-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .comment-content { flex: 1; }
        .comment-username { font-weight: 600; font-size: 13px; color: var(--text); }
        .comment-text { font-size: 13px; color: var(--text); margin-top: 2px; }
        .comment-time { font-size: 11px; color: #888; margin-top: 4px; }

        .profile-page { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: var(--bg); z-index: 150; overflow-y: auto; padding-top: 60px; }
        .profile-page.active { display: block; }
        .profile-header { position: fixed; top: 0; left: 0; right: 0; background: var(--card); padding: 12px 16px; border-bottom: 1px solid var(--border); z-index: 151; display: flex; justify-content: space-between; align-items: center; }
        .profile-header h2 { font-size: 18px; color: var(--text); }
        .profile-header .close-profile { font-size: 24px; cursor: pointer; color: var(--text); background: none; border: none; }
        .profile-info { background: var(--card); padding: 20px; display: flex; flex-direction: column; align-items: center; border-bottom: 1px solid var(--border); }
        .profile-avatar-large { width: 100px; height: 100px; border-radius: 50%; overflow: hidden; border: 3px solid var(--border); margin-bottom: 10px; }
        .profile-avatar-large img { width: 100%; height: 100%; object-fit: cover; }
        .profile-username { font-size: 20px; font-weight: 600; color: var(--text); }
        .profile-bio { font-size: 14px; color: var(--text); margin: 6px 0; text-align: center; padding: 0 20px; }
        .profile-stats { display: flex; justify-content: space-around; padding: 16px 0; background: var(--card); border-bottom: 1px solid var(--border); width: 100%; }
        .profile-stats .stat { display: flex; flex-direction: column; align-items: center; cursor: pointer; transition: 0.3s; }
        .profile-stats .stat:hover { opacity: 0.7; transform: scale(1.02); }
        .profile-stats .stat .number { font-size: 18px; font-weight: 600; color: var(--text); }
        .profile-stats .stat .label { font-size: 13px; color: #888; }
        .profile-follow-btn { padding: 8px 32px; background: var(--primary); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 14px; margin: 6px 0; transition: 0.3s; }
        .profile-follow-btn:hover { background: #0081d6; transform: scale(1.02); }
        .profile-follow-btn.following { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
        .profile-gallery { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; background: var(--bg); }
        .profile-post { aspect-ratio: 1; overflow: hidden; background: var(--border); position: relative; cursor: pointer; border-radius: 4px; transition: 0.3s; }
        .profile-post:hover { transform: scale(1.02); }
        .profile-post .image-container { width: 100%; height: 100%; position: relative; }
        .profile-post .image-container img { width: 100%; height: 100%; object-fit: cover; }
        .profile-post .image-container .profile-post-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.4); display: flex; justify-content: center; align-items: center; gap: 20px; color: white; opacity: 0; transition: 0.3s; }
        .profile-post .image-container:hover .profile-post-overlay { opacity: 1; }
        .profile-post .image-container .profile-post-overlay span { display: flex; align-items: center; gap: 5px; font-size: 14px; font-weight: 600; }

        .upload-page { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: var(--bg); z-index: 150; overflow-y: auto; padding-top: 60px; }
        .upload-page.active { display: block; }
        .upload-header { position: fixed; top: 0; left: 0; right: 0; background: var(--card); padding: 12px 16px; border-bottom: 1px solid var(--border); z-index: 151; display: flex; justify-content: space-between; align-items: center; }
        .upload-header h2 { font-size: 18px; color: var(--text); }
        .upload-header .close-upload { font-size: 24px; cursor: pointer; color: var(--text); background: none; border: none; }
        .upload-container { background: var(--card); margin: 12px 16px; border-radius: 12px; padding: 30px 20px; border: 2px dashed var(--border); text-align: center; min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; transition: 0.3s; }
        .upload-container:hover { border-color: var(--primary); }
        .upload-container i { font-size: 60px; color: var(--primary); margin-bottom: 16px; }
        .upload-container h3 { font-size: 20px; color: var(--text); margin-bottom: 8px; }
        .upload-container p { font-size: 14px; color: #888; margin-bottom: 20px; }
        .upload-container input[type="file"] { display: none; }
        .upload-container .upload-btn { padding: 10px 32px; background: var(--primary); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 16px; transition: 0.3s; }
        .upload-container .upload-btn:hover { background: #0081d6; transform: scale(1.02); }
        .upload-preview { display: none; margin-top: 16px; width: 100%; max-width: 320px; margin: 16px auto 0; }
        .upload-preview img, .upload-preview video { width: 100%; border-radius: 8px; max-height: 320px; object-fit: cover; }
        .upload-preview.active { display: block; }
        .upload-caption { display: none; margin-top: 12px; width: 100%; max-width: 320px; margin: 12px auto 0; }
        .upload-caption.active { display: block; }
        .upload-caption textarea { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; outline: none; font-size: 14px; font-family: inherit; resize: vertical; min-height: 60px; background: var(--bg); color: var(--text); direction: rtl; }
        .upload-caption textarea:focus { border-color: var(--primary); }
        .upload-hashtags { display: none; margin-top: 8px; width: 100%; max-width: 320px; margin: 8px auto 0; }
        .upload-hashtags.active { display: block; }
        .upload-hashtags input { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; outline: none; font-size: 14px; background: var(--bg); color: var(--text); direction: rtl; }
        .upload-hashtags input:focus { border-color: var(--primary); }
        .upload-submit { display: none; margin-top: 12px; padding: 10px 32px; background: var(--primary); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 16px; transition: 0.3s; }
        .upload-submit.active { display: inline-block; }
        .upload-submit:hover { background: #0081d6; transform: scale(1.02); }

        .chat-interface { display: none; position: fixed; bottom: 65px; left: 0; right: 0; top: 60px; background: var(--card); z-index: 200; flex-direction: column; border-top: 1px solid var(--border); }
        .chat-interface.active { display: flex; }
        .chat-header-bar { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--card); flex-shrink: 0; }
        .chat-header-bar h3 { font-size: 16px; color: var(--text); }
        .chat-header-bar .close-chat-btn { font-size: 24px; cursor: pointer; color: var(--text); background: none; border: none; }
        .chat-users-list { border-bottom: 1px solid var(--border); max-height: 140px; overflow-y: auto; flex-shrink: 0; background: var(--bg); }
        .chat-user { display: flex; align-items: center; gap: 12px; padding: 10px 16px; cursor: pointer; border-bottom: 1px solid var(--border); transition: 0.3s; }
        .chat-user:hover { background: var(--card); }
        .chat-user .user-avatar { width: 40px; height: 40px; border-radius: 50%; overflow: hidden; background: var(--border); flex-shrink: 0; }
        .chat-user .user-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .chat-user .user-name { font-size: 14px; color: var(--text); font-weight: 500; }
        .chat-user .user-status { font-size: 11px; color: #888; }
        .chat-user .user-status.online { color: #2ecc71; }
        .chat-messages { flex: 1; overflow-y: auto; padding: 16px; background: var(--bg); display: flex; flex-direction: column; gap: 6px; }
        .chat-message { max-width: 78%; padding: 10px 16px; border-radius: 18px; background: var(--card); box-shadow: var(--shadow); align-self: flex-start; word-wrap: break-word; animation: messageIn 0.2s ease; }
        @keyframes messageIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .chat-message.own { align-self: flex-end; background: var(--primary); color: white; }
        .chat-message .msg-user { font-size: 11px; font-weight: 600; color: var(--primary); margin-bottom: 2px; }
        .chat-message.own .msg-user { color: rgba(255,255,255,0.8); }
        .chat-message .msg-text { font-size: 14px; }
        .chat-message .msg-time { font-size: 10px; color: #888; margin-top: 4px; text-align: left; }
        .chat-message.own .msg-time { color: rgba(255,255,255,0.7); }
        .chat-input { display: flex; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--border); background: var(--card); flex-shrink: 0; }
        .chat-input input { flex: 1; padding: 10px 16px; border: 1px solid var(--border); border-radius: 24px; outline: none; font-size: 14px; background: var(--bg); color: var(--text); direction: rtl; }
        .chat-input input:focus { border-color: var(--primary); }
        .chat-input button { padding: 10px 20px; background: var(--primary); color: white; border: none; border-radius: 24px; cursor: pointer; font-size: 16px; transition: 0.3s; }
        .chat-input button:hover { background: #0081d6; transform: scale(1.02); }
        .chat-empty { text-align: center; padding: 40px; color: #888; }
        .chat-empty i { font-size: 40px; display: block; margin-bottom: 12px; color: var(--border); }

        .menu-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 600; backdrop-filter: blur(2px); }
        .menu-overlay.active { display: block; }
        .side-menu { position: fixed; top: 0; right: -320px; width: 300px; height: 100%; background: var(--card); z-index: 601; transition: right 0.3s ease; padding-top: 16px; box-shadow: -4px 0 20px rgba(0,0,0,0.15); overflow-y: auto; }
        .side-menu.active { right: 0; }
        .side-menu .menu-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
        .side-menu .menu-header h3 { font-size: 18px; color: var(--text); }
        .side-menu .menu-header .close-menu { font-size: 24px; cursor: pointer; color: var(--text); background: none; border: none; }
        .side-menu .menu-item { display: flex; align-items: center; gap: 15px; padding: 14px 20px; border-bottom: 1px solid var(--border); cursor: pointer; color: var(--text); transition: 0.3s; }
        .side-menu .menu-item:hover { background: var(--bg); }
        .side-menu .menu-item i { font-size: 20px; width: 28px; color: var(--text); }
        .side-menu .menu-item .menu-text { font-size: 15px; font-weight: 500; }
        .side-menu .menu-item .menu-badge { margin-right: auto; background: var(--primary); color: white; font-size: 11px; padding: 2px 12px; border-radius: 12px; }
        .side-menu .menu-item.admin { background: rgba(0,149,246,0.08); border-right: 3px solid var(--primary); }

        .settings-page { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: var(--bg); z-index: 160; overflow-y: auto; padding-top: 60px; }
        .settings-page.active { display: block; }
        .settings-header { position: fixed; top: 0; left: 0; right: 0; background: var(--card); padding: 12px 16px; border-bottom: 1px solid var(--border); z-index: 161; display: flex; justify-content: space-between; align-items: center; }
        .settings-header h2 { font-size: 18px; color: var(--text); }
        .settings-header .close-settings { font-size: 24px; cursor: pointer; color: var(--text); background: none; border: none; }
        .settings-container { padding: 16px; max-width: 600px; margin: 0 auto; }
        .settings-card { background: var(--card); border-radius: 12px; padding: 20px; margin-bottom: 16px; border: 1px solid var(--border); }
        .settings-card h4 { font-size: 16px; color: var(--text); margin-bottom: 12px; }
        .settings-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }
        .settings-item:last-child { border-bottom: none; }
        .settings-item .label { font-size: 14px; color: var(--text); }
        .settings-item .value { font-size: 14px; color: #888; }
        .settings-item select { padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 14px; outline: none; }
        .settings-item .toggle { width: 52px; height: 28px; background: var(--border); border-radius: 14px; position: relative; cursor: pointer; transition: 0.3s; }
        .settings-item .toggle.active { background: var(--primary); }
        .settings-item .toggle .thumb { width: 22px; height: 22px; background: white; border-radius: 50%; position: absolute; top: 3px; left: 3px; transition: 0.3s; box-shadow: 0 1px 4px rgba(0,0,0,0.2); }
        .settings-item .toggle.active .thumb { left: 27px; }
        .settings-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
        .settings-stats .stat-box { background: var(--bg); padding: 16px; border-radius: 8px; text-align: center; border: 1px solid var(--border); }
        .settings-stats .stat-box .num { font-size: 24px; font-weight: 700; color: var(--primary); }
        .settings-stats .stat-box .lbl { font-size: 12px; color: #888; margin-top: 4px; }

        .admin-panel { display: none; position: fixed; top: 60px; left: 0; right: 0; bottom: 65px; background: var(--bg); z-index: 145; overflow-y: auto; padding: 16px; }
        .admin-panel.active { display: block; }
        .admin-panel .admin-card { background: var(--card); border-radius: 12px; padding: 16px; margin-bottom: 12px; border: 1px solid var(--border); }
        .admin-panel .admin-card h4 { color: var(--text); margin-bottom: 8px; }
        .admin-panel .admin-card .admin-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); }
        .admin-panel .admin-card .admin-item:last-child { border-bottom: none; }
        .admin-panel .admin-btn { padding: 4px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; transition: 0.3s; }
        .admin-panel .admin-btn.danger { background: #ed4956; color: white; }
        .admin-panel .admin-btn.danger:hover { opacity: 0.8; transform: scale(1.02); }
        .admin-panel .admin-btn.success { background: #2ecc71; color: white; }
        .admin-panel .admin-btn.success:hover { opacity: 0.8; transform: scale(1.02); }
        .admin-panel .admin-btn.primary { background: var(--primary); color: white; }
        .admin-panel .admin-btn.primary:hover { opacity: 0.8; transform: scale(1.02); }

        .share-modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 500; justify-content: center; align-items: center; padding: 20px; backdrop-filter: blur(4px); }
        .share-modal.active { display: flex; }
        .share-modal-content { background: var(--card); border-radius: 12px; max-width: 400px; width: 100%; max-height: 70vh; display: flex; flex-direction: column; overflow: hidden; direction: rtl; box-shadow: var(--shadow); animation: modalIn 0.3s ease; }
        .share-modal-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
        .share-modal-header h3 { font-size: 16px; color: var(--text); }
        .share-modal-header .close-share { font-size: 24px; cursor: pointer; color: var(--text); background: none; border: none; }
        .share-modal-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
        .share-option { display: flex; align-items: center; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--border); cursor: pointer; transition: 0.3s; }
        .share-option:hover { background: var(--bg); border-radius: 8px; }
        .share-option .share-icon { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; color: white; flex-shrink: 0; }
        .share-option .share-icon.telegram { background: #0088cc; }
        .share-option .share-icon.whatsapp { background: #25d366; }
        .share-option .share-icon.copy { background: #6c757d; }
        .share-option .share-icon.site { background: var(--primary); }
        .share-option .share-name { font-size: 15px; color: var(--text); font-weight: 500; }

        .toast { position: fixed; bottom: 85px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.85); color: white; padding: 12px 24px; border-radius: 24px; font-size: 14px; z-index: 999; opacity: 0; transition: opacity 0.4s ease; pointer-events: none; backdrop-filter: blur(4px); max-width: 90%; text-align: center; }
        .toast.show { opacity: 1; }

        .broadcast { background: var(--primary); color: white; padding: 10px 16px; text-align: center; font-size: 14px; flex-shrink: 0; display: none; }
        .broadcast.show { display: block; }

        .loading-spinner { text-align: center; padding: 40px; color: var(--primary); font-size: 16px; }
        .loading-spinner i { font-size: 36px; animation: spin 0.8s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .no-posts { text-align: center; padding: 40px; color: #888; grid-column: 1 / -1; }
        .no-posts i { font-size: 48px; color: var(--border); display: block; margin-bottom: 12px; }

        .login-container { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; padding: 20px; background: var(--bg); }
        .login-box { background: var(--card); padding: 40px; border-radius: 12px; box-shadow: var(--shadow); max-width: 400px; width: 100%; border: 1px solid var(--border); }
        .login-box h2 { margin-bottom: 20px; color: var(--text); text-align: center; }
        .login-box input { width: 100%; padding: 12px 16px; margin: 8px 0; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; background: var(--bg); color: var(--text); direction: rtl; }
        .login-box input:focus { border-color: var(--primary); outline: none; }
        .login-box button { width: 100%; padding: 12px; background: var(--primary); color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: 0.3s; }
        .login-box button:hover { background: #0081d6; transform: scale(1.02); }
        .login-box .toggle-link { color: var(--primary); cursor: pointer; text-align: center; margin-top: 12px; }
        .login-box .toggle-link:hover { text-decoration: underline; }
        .login-box .error { color: #ed4956; font-size: 13px; margin: 8px 0; text-align: center; }

        @media (max-width: 768px) {
            .gallery { gap: 3px; padding: 3px; }
            .search-box { max-width: 200px; }
            .login-box { padding: 20px; }
        }
        @media (max-width: 480px) {
            .gallery { gap: 2px; padding: 2px; }
            .search-box { max-width: 140px; padding: 6px 12px; }
            .search-box input { font-size: 12px; }
            .header-right { gap: 12px; font-size: 18px; }
            .header { padding: 0 10px; }
            .logo { font-size: 16px; }
            .story-avatar { width: 54px; height: 54px; }
            .login-box { padding: 16px; }
        }
    </style>
</head>
<body>

    <div id="app">
        <!-- Login Page -->
        <div id="loginPage" class="login-container">
            <div class="login-box">
                <h2 id="loginTitle">🔐 ورود</h2>
                <div id="loginError" class="error"></div>
                <input type="text" id="loginUsername" placeholder="نام کاربری">
                <input type="email" id="loginEmail" placeholder="ایمیل">
                <input type="password" id="loginPassword" placeholder="رمز عبور">
                <button id="loginBtn">ورود</button>
                <div class="toggle-link" id="toggleAuth">ثبت نام ندارید؟ ثبت نام کنید</div>
            </div>
        </div>

        <!-- Main App -->
        <div id="mainApp" style="display:none;flex-direction:column;height:100vh;">
            <div class="toast" id="toast"></div>
            <div class="broadcast" id="broadcast"></div>

            <header class="header">
                <i class="fas fa-bars menu-icon" id="menuIcon"></i>
                <div class="logo"><i class="fab fa-instagram"></i> سوشال</div>
                <div class="search-box">
                    <i class="fas fa-search"></i>
                    <input type="text" id="searchInput" placeholder="جستجو...">
                </div>
                <div class="header-right">
                    <i class="fas fa-comment-dots" id="chatOpenBtn"></i>
                    <i class="fas fa-cog" id="settingsOpenBtn"></i>
                </div>
            </header>

            <div class="stories-section" id="storiesSection">
                <div class="stories-container" id="storiesContainer"></div>
            </div>

            <div class="gallery-wrapper">
                <div id="loadingIndicator" class="loading-spinner">
                    <i class="fas fa-spinner"></i><br> در حال بارگذاری...
                </div>
                <div class="gallery" id="gallery"></div>
                <div id="noPostsMessage" class="no-posts" style="display:none;">
                    <i class="fas fa-camera"></i>
                    هیچ پستی وجود ندارد
                </div>
            </div>

            <div class="chat-interface" id="chatInterface">
                <div class="chat-header-bar">
                    <h3 id="chatTitle">💬 چت</h3>
                    <button class="close-chat-btn" id="closeChatBtn">&times;</button>
                </div>
                <div class="chat-users-list" id="chatUsersList"></div>
                <div class="chat-messages" id="chatMessages">
                    <div class="chat-empty">
                        <i class="fas fa-comments"></i>
                        برای شروع چت، یک کاربر را انتخاب کنید
                    </div>
                </div>
                <div class="chat-input">
                    <input type="text" id="chatInput" placeholder="پیام خود را بنویسید...">
                    <button id="chatSendBtn"><i class="fas fa-paper-plane"></i></button>
                </div>
            </div>

            <div class="modal-overlay" id="commentModal">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3>💬 کامنت‌ها</h3>
                        <button class="close-modal" id="closeModal">&times;</button>
                    </div>
                    <div class="modal-body" id="commentList"></div>
                    <div class="modal-footer">
                        <input type="text" id="modalCommentInput" placeholder="کامنت خود را بنویسید...">
                        <button id="modalSendComment">ارسال</button>
                    </div>
                </div>
            </div>

            <div class="share-modal" id="shareModal">
                <div class="share-modal-content">
                    <div class="share-modal-header">
                        <h3>📤 اشتراک‌گذاری</h3>
                        <button class="close-share" id="closeShareModal">&times;</button>
                    </div>
                    <div class="share-modal-body">
                        <div class="share-option" data-share="site">
                            <div class="share-icon site"><i class="fas fa-users"></i></div>
                            <span class="share-name">اشتراک در سایت</span>
                        </div>
                        <div class="share-option" data-share="telegram">
                            <div class="share-icon telegram"><i class="fab fa-telegram-plane"></i></div>
                            <span class="share-name">ارسال به تلگرام</span>
                        </div>
                        <div class="share-option" data-share="whatsapp">
                            <div class="share-icon whatsapp"><i class="fab fa-whatsapp"></i></div>
                            <span class="share-name">ارسال به واتساپ</span>
                        </div>
                        <div class="share-option" data-share="copy">
                            <div class="share-icon copy"><i class="fas fa-copy"></i></div>
                            <span class="share-name">کپی لینک پست</span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="profile-page" id="profilePage">
                <div class="profile-header">
                    <h2>👤 پروفایل</h2>
                    <button class="close-profile" id="closeProfile">&times;</button>
                </div>
                <div style="margin-top: 60px;">
                    <div class="profile-info">
                        <div class="profile-avatar-large">
                            <img id="profileAvatar" src="https://i.pravatar.cc/150?img=10" alt="profile">
                        </div>
                        <div class="profile-username" id="profileUsername">کاربر</div>
                        <div class="profile-bio" id="bioDisplay">توسعه‌دهنده وب</div>
                        <button class="profile-follow-btn" id="profileFollowBtn">دنبال کردن</button>
                        <div class="profile-bio-edit" style="display:flex;gap:10px;margin:10px 0;width:100%;max-width:300px;">
                            <input type="text" id="bioInput" placeholder="بیوگرافی..." style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:8px;outline:none;font-size:14px;background:var(--bg);color:var(--text);direction:rtl;">
                            <button id="saveBio" style="padding:8px 16px;background:var(--primary);color:white;border:none;border-radius:8px;cursor:pointer;font-weight:600;">ذخیره</button>
                        </div>
                    </div>
                    <div class="profile-stats">
                        <div class="stat" id="statPosts">
                            <span class="number" id="postCount">۰</span>
                            <span class="label">پست</span>
                        </div>
                        <div class="stat" id="statFollowers">
                            <span class="number" id="followerCount">۰</span>
                            <span class="label">دنبال‌کننده</span>
                        </div>
                        <div class="stat" id="statFollowing">
                            <span class="number" id="followingCount">۰</span>
                            <span class="label">دنبال‌شونده</span>
                        </div>
                    </div>
                    <div style="padding:10px 0;background:var(--card);margin-top:5px;">
                        <h4 style="padding:0 20px 10px;font-size:14px;color:var(--text);">📸 پست‌های من</h4>
                        <div class="profile-gallery" id="profileGallery"></div>
                    </div>
                </div>
            </div>

            <div class="settings-page" id="settingsPage">
                <div class="settings-header">
                    <h2>⚙️ تنظیمات</h2>
                    <button class="close-settings" id="closeSettings">&times;</button>
                </div>
                <div class="settings-container">
                    <div class="settings-card">
                        <h4>🌐 زبان</h4>
                        <div class="settings-item">
                            <span class="label">زبان</span>
                            <select id="languageSelect">
                                <option value="fa">فارسی</option>
                                <option value="en">English</option>
                            </select>
                        </div>
                    </div>
                    <div class="settings-card">
                        <h4>🎨 ظاهر</h4>
                        <div class="settings-item">
                            <span class="label">تم تاریک</span>
                            <div class="toggle" id="themeToggle">
                                <div class="thumb"></div>
                            </div>
                        </div>
                    </div>
                    <div class="settings-card">
                        <h4>📊 آمار</h4>
                        <div class="settings-stats">
                            <div class="stat-box">
                                <div class="num" id="statTotalPosts">0</div>
                                <div class="lbl">کل پست‌ها</div>
                            </div>
                            <div class="stat-box">
                                <div class="num" id="statTotalUsers">0</div>
                                <div class="lbl">کاربران</div>
                            </div>
                            <div class="stat-box">
                                <div class="num" id="statOnlineUsers">0</div>
                                <div class="lbl">آنلاین</div>
                            </div>
                        </div>
                    </div>
                    <div class="settings-card">
                        <h4>👤 اطلاعات</h4>
                        <div class="settings-item">
                            <span class="label">نام</span>
                            <span class="value" id="settingsUsername">-</span>
                        </div>
                        <div class="settings-item">
                            <span class="label">ایمیل</span>
                            <span class="value" id="settingsEmail">-</span>
                        </div>
                        <div class="settings-item">
                            <span class="label">پست</span>
                            <span class="value" id="settingsPostCount">0</span>
                        </div>
                    </div>
                    <button id="logoutBtn" style="width:100%;padding:12px;background:#ed4956;color:white;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;">🚪 خروج</button>
                </div>
            </div>

            <div class="admin-panel" id="adminPanel">
                <div class="admin-card">
                    <h4>👑 پنل مدیریت</h4>
                    <div class="admin-item">
                        <span>کاربران</span>
                        <span id="adminUserCount">0</span>
                    </div>
                    <div class="admin-item">
                        <span>پست‌ها</span>
                        <span id="adminPostCount">0</span>
                    </div>
                    <div class="admin-item">
                        <span>آنلاین</span>
                        <span id="adminOnlineCount">0</span>
                    </div>
                </div>
                <div class="admin-card">
                    <h4>📢 پیام همگانی</h4>
                    <div style="display:flex;gap:10px;">
                        <input type="text" id="broadcastInput" placeholder="پیام..." style="flex:1;padding:10px 14px;border:1px solid var(--border);border-radius:8px;outline:none;font-size:14px;background:var(--bg);color:var(--text);">
                        <button id="broadcastBtn" class="admin-btn primary">ارسال</button>
                    </div>
                </div>
                <div class="admin-card">
                    <h4>👥 مدیریت کاربران</h4>
                    <div id="adminUsersList"></div>
                </div>
                <div class="admin-card">
                    <h4>📸 مدیریت پست‌ها</h4>
                    <div id="adminPostsList"></div>
                </div>
            </div>

            <div class="upload-page" id="uploadPage">
                <div class="upload-header">
                    <h2>📤 آپلود</h2>
                    <button class="close-upload" id="closeUpload">&times;</button>
                </div>
                <div style="margin-top:60px;padding:10px;">
                    <div class="upload-container" id="uploadContainer">
                        <i class="fas fa-cloud-upload-alt"></i>
                        <h3>انتخاب فایل</h3>
                        <p>برای آپلود کلیک کنید</p>
                        <button class="upload-btn" id="uploadSelectBtn">انتخاب فایل</button>
                        <input type="file" id="fileInput" accept="image/*,video/*">
                        <div class="upload-preview" id="uploadPreview">
                            <img id="previewImage" src="#" alt="preview">
                            <video id="previewVideo" controls style="display:none;"></video>
                        </div>
                        <div class="upload-caption" id="uploadCaption">
                            <textarea id="captionInput" placeholder="توضیحات..."></textarea>
                        </div>
                        <div class="upload-hashtags" id="uploadHashtags">
                            <input type="text" id="hashtagInput" placeholder="هشتگ‌ها (با کاما)">
                        </div>
                        <button class="upload-submit" id="uploadSubmit">📤 ارسال</button>
                    </div>
                </div>
            </div>

            <div class="follow-modal" id="followModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:400;justify-content:center;align-items:center;padding:20px;backdrop-filter:blur(4px);">
                <div class="follow-modal-content" style="background:var(--card);border-radius:12px;max-width:400px;width:100%;max-height:70vh;display:flex;flex-direction:column;overflow:hidden;direction:rtl;box-shadow:var(--shadow);">
                    <div class="follow-modal-header" style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
                        <h3 id="followModalTitle" style="font-size:16px;color:var(--text);">دنبال‌کنندگان</h3>
                        <button class="close-follow" id="closeFollowModal" style="font-size:24px;cursor:pointer;color:var(--text);background:none;border:none;">&times;</button>
                    </div>
                    <div class="follow-modal-body" id="followModalBody" style="flex:1;overflow-y:auto;padding:16px 20px;"></div>
                </div>
            </div>

            <div class="menu-overlay" id="menuOverlay"></div>
            <div class="side-menu" id="sideMenu">
                <div class="menu-header">
                    <h3>📋 منو</h3>
                    <button class="close-menu" id="closeMenu">&times;</button>
                </div>
                <div class="menu-item" id="menuProfile">
                    <i class="fas fa-user"></i>
                    <span class="menu-text">پروفایل</span>
                </div>
                <div class="menu-item" id="menuSettings">
                    <i class="fas fa-cog"></i>
                    <span class="menu-text">تنظیمات</span>
                </div>
                <div class="menu-item" id="menuStats">
                    <i class="fas fa-chart-bar"></i>
                    <span class="menu-text">آمار</span>
                </div>
                <div class="menu-item" id="menuTheme">
                    <i class="fas fa-palette"></i>
                    <span class="menu-text">تم</span>
                </div>
                <div class="menu-item" id="menuAdmin" style="display:none;border-right:3px solid var(--primary);background:rgba(0,149,246,0.05);">
                    <i class="fas fa-crown"></i>
                    <span class="menu-text">👑 مدیریت</span>
                    <span class="menu-badge">ادمین</span>
                </div>
                <div class="menu-item" id="menuLogout">
                    <i class="fas fa-sign-out-alt"></i>
                    <span class="menu-text">خروج</span>
                </div>
            </div>

            <nav class="bottom-nav">
                <button id="profileBtn">
                    <i class="fas fa-user"></i>
                    <span>پروفایل</span>
                </button>
                <button id="uploadBtn">
                    <i class="fas fa-upload"></i>
                    <span>آپلود</span>
                </button>
                <button id="exploreBtn" class="active">
                    <i class="fas fa-compass"></i>
                    <span>اکسپلور</span>
                </button>
                <button id="reelsBtn">
                    <i class="fas fa-film"></i>
                    <span>ریلز</span>
                </button>
            </nav>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        // ============================================
        // 🌐 تنظیمات
        // ============================================
        const API_URL = window.location.origin;
        const socket = io();
        let currentUser = null;
        let currentToken = localStorage.getItem('token');
        let isAdmin = false;
        let isDarkTheme = localStorage.getItem('theme') === 'dark';
        let language = localStorage.getItem('language') || 'fa';
        let currentPostId = null;
        let currentChatRoom = null;
        let currentChatUser = null;
        let isUploading = false;
        let isLogin = true;

        function showToast(msg) {
            var toast = document.getElementById('toast');
            toast.textContent = msg;
            toast.classList.add('show');
            clearTimeout(toast._timeout);
            toast._timeout = setTimeout(function() { toast.classList.remove('show'); }, 3000);
        }

        function showError(msg) {
            document.getElementById('loginError').textContent = msg;
        }

        function clearError() {
            document.getElementById('loginError').textContent = '';
        }

        // ============================================
        // 🔐 احراز هویت
        // ============================================

        async function registerUser(username, email, password) {
            var res = await fetch(API_URL + '/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username, email: email, password: password })
            });
            return await res.json();
        }

        async function loginUser(email, password) {
            var res = await fetch(API_URL + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email, password: password })
            });
            return await res.json();
        }

        async function logoutUser() {
            await fetch(API_URL + '/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: currentToken })
            });
            localStorage.removeItem('token');
            currentToken = null;
            currentUser = null;
            isAdmin = false;
            document.getElementById('loginPage').style.display = 'flex';
            document.getElementById('mainApp').style.display = 'none';
        }

        async function getCurrentUser() {
            if (!currentToken) return null;
            try {
                var res = await fetch(API_URL + '/api/auth/me', {
                    headers: { 'Authorization': 'Bearer ' + currentToken }
                });
                if (res.ok) return await res.json();
                return null;
            } catch {
                return null;
            }
        }

        async function verifyAdmin() {
            if (!currentToken) return false;
            try {
                var res = await fetch(API_URL + '/api/admin/verify', {
                    headers: { 'Authorization': 'Bearer ' + currentToken }
                });
                if (res.ok) {
                    var data = await res.json();
                    return data.isAdmin || false;
                }
                return false;
            } catch {
                return false;
            }
        }

        // ============================================
        // 📦 API
        // ============================================

        async function getPosts(page, hashtag) {
            page = page || 1;
            var url = API_URL + '/api/posts?page=' + page + '&limit=20';
            if (hashtag) url += '&hashtag=' + encodeURIComponent(hashtag);
            var res = await fetch(url);
            return await res.json();
        }

        async function createPost(file, caption, hashtags) {
            var formData = new FormData();
            formData.append('file', file);
            formData.append('caption', caption || '');
            formData.append('userId', currentUser?.userId || 'user1');
            formData.append('username', currentUser?.username || 'کاربر');
            if (hashtags) formData.append('hashtags', hashtags);
            var res = await fetch(API_URL + '/api/posts', {
                method: 'POST',
                body: formData
            });
            return await res.json();
        }

        async function likePost(postId) {
            var res = await fetch(API_URL + '/api/posts/' + postId + '/like', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUser?.userId || 'user1' })
            });
            return await res.json();
        }

        async function addComment(postId, text) {
            var res = await fetch(API_URL + '/api/posts/' + postId + '/comment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: currentUser?.userId || 'user1',
                    username: currentUser?.username || 'کاربر',
                    text: text
                })
            });
            return await res.json();
        }

        async function getStories() {
            var res = await fetch(API_URL + '/api/stories');
            return await res.json();
        }

        async function createStory(file) {
            var formData = new FormData();
            formData.append('file', file);
            formData.append('userId', currentUser?.userId || 'user1');
            formData.append('username', currentUser?.username || 'کاربر');
            var res = await fetch(API_URL + '/api/stories', {
                method: 'POST',
                body: formData
            });
            return await res.json();
        }

        async function getUsers() {
            var res = await fetch(API_URL + '/api/users');
            return await res.json();
        }

        async function updateProfile(userId, data) {
            var res = await fetch(API_URL + '/api/users/' + userId + '/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return await res.json();
        }

        async function followUser(userId, followerId) {
            var res = await fetch(API_URL + '/api/users/' + userId + '/follow', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ followerId: followerId })
            });
            return await res.json();
        }

        // ============================================
        // 👑 ادمین API
        // ============================================

        async function getAdminUsers() {
            var res = await fetch(API_URL + '/api/admin/users', {
                headers: { 'Authorization': 'Bearer ' + currentToken }
            });
            return await res.json();
        }

        async function banUser(userId, banned) {
            var res = await fetch(API_URL + '/api/admin/users/' + userId + '/ban', {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer ' + currentToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ banned: banned })
            });
            return await res.json();
        }

        async function deletePostAdmin(postId) {
            var res = await fetch(API_URL + '/api/admin/posts/' + postId, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + currentToken }
            });
            return await res.json();
        }

        async function getAdminPosts() {
            var res = await fetch(API_URL + '/api/admin/posts', {
                headers: { 'Authorization': 'Bearer ' + currentToken }
            });
            return await res.json();
        }

        async function broadcastMessage(message) {
            var res = await fetch(API_URL + '/api/admin/broadcast', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + currentToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ message: message })
            });
            return await res.json();
        }

        async function getAdminStats() {
            var res = await fetch(API_URL + '/api/admin/stats', {
                headers: { 'Authorization': 'Bearer ' + currentToken }
            });
            return await res.json();
        }

        // ============================================
        // 💬 WebSocket
        // ============================================

        socket.on('connect', function() {
            console.log('✅ Connected');
            if (currentUser) {
                socket.emit('register', { userId: currentUser.userId, username: currentUser.username });
            }
        });

        socket.on('users-online', function(users) {
            document.getElementById('statOnlineUsers').textContent = users?.length || 0;
            renderChatUsers();
        });

        socket.on('receive-message', function(data) {
            displayChatMessage(data.userId, data.username, data.message, data.timestamp);
        });

        socket.on('history', function(messages) {
            var div = document.getElementById('chatMessages');
            div.innerHTML = '';
            messages.forEach(function(msg) {
                displayChatMessage(msg.userId, msg.username, msg.message, msg.timestamp);
            });
        });

        socket.on('broadcast', function(data) {
            var b = document.getElementById('broadcast');
            b.textContent = '📢 ' + data.message + ' (از ' + data.from + ')';
            b.classList.add('show');
            showToast('📢 پیام همگانی: ' + data.message);
            setTimeout(function() { b.classList.remove('show'); }, 10000);
        });

        socket.on('error', function(data) {
            showToast('❌ ' + data.message);
        });

        function startChat(userId, username) {
            if (currentUser && currentUser.isBanned) {
                showToast('❌ شما مسدود شده‌اید');
                return;
            }
            currentChatUser = userId;
            var roomId = [currentUser?.userId || 'user1', userId].sort().join('_');
            currentChatRoom = roomId;
            document.getElementById('chatTitle').textContent = '💬 ' + username;
            document.getElementById('chatInterface').classList.add('active');
            socket.emit('join-room', { roomId: roomId, userId: currentUser?.userId || 'user1' });
        }

        function sendChatMessage() {
            if (currentUser && currentUser.isBanned) {
                showToast('❌ شما مسدود شده‌اید');
                return;
            }
            var input = document.getElementById('chatInput');
            var text = input.value.trim();
            if (!text || !currentChatRoom || !currentUser) return;
            socket.emit('send-message', {
                roomId: currentChatRoom,
                userId: currentUser.userId,
                username: currentUser.username,
                message: text
            });
            displayChatMessage(currentUser.userId, currentUser.username, text, new Date().toISOString());
            input.value = '';
        }

        function displayChatMessage(userId, username, message, timestamp) {
            var div = document.getElementById('chatMessages');
            var empty = div.querySelector('.chat-empty');
            if (empty) empty.remove();
            var msgDiv = document.createElement('div');
            msgDiv.className = 'chat-message' + (userId === currentUser?.userId ? ' own' : '');
            var time = timestamp ? new Date(timestamp).toLocaleTimeString(language === 'fa' ? 'fa-IR' : 'en-US') : '';
            msgDiv.innerHTML = '<div class="msg-user">' + (userId === currentUser?.userId ? 'شما' : username) + '</div><div class="msg-text">' + message + '</div><div class="msg-time">' + time + '</div>';
            div.appendChild(msgDiv);
            div.scrollTop = div.scrollHeight;
        }

        async function renderChatUsers() {
            var list = document.getElementById('chatUsersList');
            list.innerHTML = '';
            var users = await getUsers();
            var has = false;
            users.forEach(function(user) {
                if (user.userId === currentUser?.userId) return;
                if (user.isBanned) return;
                has = true;
                var div = document.createElement('div');
                div.className = 'chat-user';
                div.onclick = function() { startChat(user.userId, user.username); };
                var statusClass = user.isOnline ? 'online' : '';
                var statusText = user.isOnline ? 'آنلاین' : 'آفلاین';
                div.innerHTML = '<div class="user-avatar"><img src="' + (user.avatar || 'https://i.pravatar.cc/150?img=' + Math.floor(Math.random() * 70)) + '" alt="user"></div><div><div class="user-name">' + user.username + '</div><div class="user-status ' + statusClass + '">' + statusText + '</div></div>';
                list.appendChild(div);
            });
            if (!has) {
                list.innerHTML = '<div style="padding:10px 16px;color:#888;">هیچ کاربری آنلاین نیست</div>';
            }
        }

        // ============================================
        // 🎨 نمایش
        // ============================================

        function createPostElement(post) {
            var div = document.createElement('div');
            div.className = 'gallery-item';
            div.setAttribute('data-id', post.postId);
            var isLiked = localStorage.getItem('liked_' + post.postId) === 'true';
            div.innerHTML = '<div class="image-container"><img src="' + post.image + '" alt="post" loading="lazy"></div><div class="explore-post-actions"><button class="action-btn like-btn ' + (isLiked ? 'liked' : '') + '" data-id="' + post.postId + '" onclick="event.stopPropagation(); handleLike(\'' + post.postId + '\')"><i class="' + (isLiked ? 'fas' : 'far') + ' fa-heart"></i><span class="count">' + (post.likes || 0) + '</span></button><button class="action-btn comment-btn" data-id="' + post.postId + '" onclick="event.stopPropagation(); openComments(\'' + post.postId + '\')"><i class="far fa-comment"></i><span class="count">' + (post.comments || []).length + '</span></button><button class="action-btn share-btn" data-id="' + post.postId + '" onclick="event.stopPropagation(); sharePost(\'' + post.postId + '\')"><i class="fas fa-share-alt"></i><span class="count">' + (post.shares || 0) + '</span></button></div>';
            div.onclick = function() { openPostDetail(post.postId); };
            return div;
        }

        function createProfilePostElement(post) {
            var div = document.createElement('div');
            div.className = 'profile-post';
            div.setAttribute('data-id', post.postId);
            div.onclick = function() { openPostDetail(post.postId); };
            div.innerHTML = '<div class="image-container"><img src="' + post.image + '" alt="post" loading="lazy"><div class="profile-post-overlay"><span><i class="fas fa-heart"></i> ' + (post.likes || 0) + '</span><span><i class="fas fa-comment"></i> ' + (post.comments || []).length + '</span></div></div>';
            return div;
        }

        function createStoryElement(story) {
            var div = document.createElement('div');
            div.className = 'story-item';
            div.onclick = function() {
                showToast('📸 استوری از ' + story.username);
                viewStory(story.storyId);
            };
            div.innerHTML = '<div class="story-avatar"><img src="' + story.image + '" alt="story"></div><span class="story-username">' + story.username + '</span>';
            return div;
        }

        // ============================================
        // 📥 بارگذاری
        // ============================================

        async function loadPosts(page) {
            page = page || 1;
            if (isUploading) return;
            isUploading = true;
            var gallery = document.getElementById('gallery');
            var loading = document.getElementById('loadingIndicator');
            var noPosts = document.getElementById('noPostsMessage');
            if (page === 1) {
                loading.style.display = 'block';
                gallery.innerHTML = '';
                noPosts.style.display = 'none';
            }
            var data = await getPosts(page);
            if (page === 1) {
                loading.style.display = 'none';
            }
            if (data.posts.length === 0 && page === 1) {
                noPosts.style.display = 'block';
                isUploading = false;
                return;
            }
            data.posts.forEach(function(post) {
                gallery.appendChild(createPostElement(post));
            });
            isUploading = false;
        }

        async function loadStories() {
            var container = document.getElementById('storiesContainer');
            container.innerHTML = '';
            var addDiv = document.createElement('div');
            addDiv.className = 'story-item';
            addDiv.onclick = function() {
                var input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/*,video/*';
                input.onchange = async function(e) {
                    var file = e.target.files[0];
                    if (file) {
                        var result = await createStory(file);
                        if (result.storyId) {
                            showToast('✅ استوری آپلود شد!');
                            loadStories();
                        }
                    }
                };
                input.click();
            };
            addDiv.innerHTML = '<div class="story-avatar add-story"><i class="fas fa-plus"></i></div><span class="story-username">افزودن</span>';
            container.appendChild(addDiv);
            var stories = await getStories();
            stories.forEach(function(story) {
                container.appendChild(createStoryElement(story));
            });
        }

        async function loadProfile() {
            if (!currentUser) return;
            document.getElementById('profileUsername').textContent = currentUser.username || 'کاربر';
            document.getElementById('bioDisplay').textContent = currentUser.bio || 'توسعه‌دهنده وب';
            document.getElementById('followerCount').textContent = currentUser.followers || 0;
            document.getElementById('followingCount').textContent = currentUser.following || 0;
            var data = await getPosts(1);
            var userPosts = data.posts.filter(function(p) { return p.userId === currentUser.userId; });
            document.getElementById('postCount').textContent = userPosts.length;
            var gallery = document.getElementById('profileGallery');
            gallery.innerHTML = '';
            if (userPosts.length === 0) {
                gallery.innerHTML = '<p style="grid-column:span 3;text-align:center;color:#888;padding:20px;">هیچ پستی ندارید</p>';
            } else {
                userPosts.forEach(function(post) {
                    gallery.appendChild(createProfilePostElement(post));
                });
            }
            document.getElementById('settingsUsername').textContent = currentUser.username || '-';
            document.getElementById('settingsEmail').textContent = currentUser.email || '-';
            document.getElementById('settingsPostCount').textContent = userPosts.length || 0;
            document.getElementById('statTotalPosts').textContent = data.total || 0;
            var users = await getUsers();
            document.getElementById('statTotalUsers').textContent = users.length || 0;
            if (isAdmin) {
                await loadAdminPanel();
            }
        }

        async function loadAdminPanel() {
            if (!isAdmin) return;
            document.getElementById('menuAdmin').style.display = 'flex';
            try {
                var stats = await getAdminStats();
                if (stats) {
                    document.getElementById('adminUserCount').textContent = stats.totalUsers || 0;
                    document.getElementById('adminPostCount').textContent = stats.totalPosts || 0;
                    document.getElementById('adminOnlineCount').textContent = stats.onlineUsers || 0;
                }
            } catch (e) {}
            try {
                var users = await getAdminUsers();
                var list = document.getElementById('adminUsersList');
                list.innerHTML = '';
                users.forEach(function(user) {
                    if (user.isAdmin) return;
                    var div = document.createElement('div');
                    div.className = 'admin-item';
                    div.innerHTML = '<span>' + user.username + ' (' + user.email + ')</span><span><button class="admin-btn ' + (user.isBanned ? 'success' : 'danger') + '" onclick="toggleBan(\'' + user.userId + '\', ' + (!user.isBanned) + ')">' + (user.isBanned ? 'رفع مسدودیت' : 'مسدود کردن') + '</button></span>';
                    list.appendChild(div);
                });
            } catch (e) {}
            try {
                var posts = await getAdminPosts();
                var list = document.getElementById('adminPostsList');
                list.innerHTML = '';
                posts.slice(0, 20).forEach(function(post) {
                    var div = document.createElement('div');
                    div.className = 'admin-item';
                    div.innerHTML = '<span>' + (post.caption || 'بدون توضیحات').substring(0, 30) + ' ...</span><span><button class="admin-btn danger" onclick="deletePostAdmin(\'' + post.postId + '\')">🗑️ حذف</button></span>';
                    list.appendChild(div);
                });
            } catch (e) {}
        }

        // ============================================
        // 🎯 اکشن‌ها
        // ============================================

        window.handleLike = async function(postId) {
            if (currentUser && currentUser.isBanned) {
                showToast('❌ شما مسدود شده‌اید');
                return;
            }
            var result = await likePost(postId);
            document.querySelectorAll('.like-btn[data-id="' + postId + '"]').forEach(function(btn) {
                btn.querySelector('i').className = result.liked ? 'fas fa-heart' : 'far fa-heart';
                btn.classList.toggle('liked', result.liked);
                btn.querySelector('.count').textContent = result.likes || 0;
                localStorage.setItem('liked_' + postId, result.liked ? 'true' : 'false');
            });
        };

        window.openComments = async function(postId) {
            if (currentUser && currentUser.isBanned) {
                showToast('❌ شما مسدود شده‌اید');
                return;
            }
            currentPostId = postId;
            var data = await getPosts(1);
            var post = data.posts.find(function(p) { return p.postId === postId; });
            var list = document.getElementById('commentList');
            list.innerHTML = '';
            if (!post || !post.comments || post.comments.length === 0) {
                list.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">هنوز کامنتی وجود ندارد</div>';
            } else {
                post.comments.forEach(function(c) {
                    var div = document.createElement('div');
                    div.className = 'comment-item';
                    div.innerHTML = '<div class="comment-avatar"><img src="https://i.pravatar.cc/150?img=' + Math.floor(Math.random() * 70) + '" alt="avatar"></div><div class="comment-content"><div class="comment-username">' + (c.username || 'کاربر') + '</div><div class="comment-text">' + c.text + '</div><div class="comment-time">' + (c.createdAt ? new Date(c.createdAt).toLocaleString(language === 'fa' ? 'fa-IR' : 'en-US') : 'چند لحظه پیش') + '</div></div>';
                    list.appendChild(div);
                });
            }
            document.getElementById('commentModal').classList.add('active');
            document.getElementById('modalCommentInput').focus();
        };

        window.sharePost = function(postId) {
            document.getElementById('shareModal').dataset.postId = postId;
            document.getElementById('shareModal').classList.add('active');
        };

        window.searchHashtag = function(hashtag) {
            document.getElementById('searchInput').value = '#' + hashtag;
            loadPosts(1, hashtag);
            showToast('🔍 جستجو برای #' + hashtag);
        };

        window.openPostDetail = async function(postId) {
            var data = await getPosts(1);
            var post = data.posts.find(function(p) { return p.postId === postId; });
            if (!post) {
                showToast('❌ پست پیدا نشد!');
                return;
            }
            showToast('📸 ' + (post.caption || 'بدون توضیحات') + '\n❤️ ' + (post.likes || 0) + ' لایک\n💬 ' + (post.comments || []).length + ' کامنت');
        };

        window.viewStory = async function(storyId) {
            await fetch(API_URL + '/api/stories/' + storyId + '/view', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUser?.userId || 'user1' })
            });
        };

        window.toggleBan = async function(userId, banned) {
            if (currentUser && userId === currentUser.userId) {
                showToast('❌ نمی‌توانید خودتان را مسدود کنید');
                return;
            }
            var result = await banUser(userId, banned);
            if (result.success) {
                showToast('✅ کاربر ' + (banned ? 'مسدود' : 'رفع مسدودیت') + ' شد');
                loadAdminPanel();
            }
        };

        window.deletePostAdmin = async function(postId) {
            if (!confirm('آیا از حذف این پست مطمئن هستید؟')) return;
            var result = await deletePostAdmin(postId);
            if (result.success) {
                showToast('✅ پست حذف شد');
                loadAdminPanel();
                loadPosts(1);
            }
        };

        // ============================================
        // 🎬 Event Listeners
        // ============================================

        document.getElementById('loginBtn').addEventListener('click', async function() {
            clearError();
            var username = document.getElementById('loginUsername').value.trim();
            var email = document.getElementById('loginEmail').value.trim();
            var password = document.getElementById('loginPassword').value.trim();

            if (!email || !password) {
                showError('لطفا ایمیل و رمز عبور را وارد کنید');
                return;
            }

            if (!isLogin && !username) {
                showError('لطفا نام کاربری را وارد کنید');
                return;
            }

            this.textContent = '⏳ در حال...';
            this.disabled = true;

            var result;
            if (isLogin) {
                result = await loginUser(email, password);
            } else {
                result = await registerUser(username, email, password);
            }

            if (result.success) {
                currentToken = result.token;
                localStorage.setItem('token', currentToken);
                currentUser = result.user;
                isAdmin = currentUser.isAdmin || false;
                document.getElementById('loginPage').style.display = 'none';
                document.getElementById('mainApp').style.display = 'flex';
                document.getElementById('loginBtn').textContent = isLogin ? 'ورود' : 'ثبت نام';
                document.getElementById('loginBtn').disabled = false;
                showToast('✅ خوش آمدید ' + currentUser.username);
                socket.emit('register', { userId: currentUser.userId, username: currentUser.username });
                if (isAdmin) {
                    document.getElementById('menuAdmin').style.display = 'flex';
                }
                await loadPosts(1);
                await loadStories();
                await loadProfile();
            } else {
                showError(result.error || 'خطا!');
                document.getElementById('loginBtn').textContent = isLogin ? 'ورود' : 'ثبت نام';
                document.getElementById('loginBtn').disabled = false;
            }
        });

        document.getElementById('loginPassword').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') document.getElementById('loginBtn').click();
        });

        document.getElementById('toggleAuth').addEventListener('click', function() {
            isLogin = !isLogin;
            document.getElementById('loginTitle').textContent = isLogin ? '🔐 ورود' : '📝 ثبت نام';
            document.getElementById('loginBtn').textContent = isLogin ? 'ورود' : 'ثبت نام';
            document.getElementById('toggleAuth').textContent = isLogin ? 'ثبت نام ندارید؟ ثبت نام کنید' : 'حساب دارید؟ وارد شوید';
            document.getElementById('loginUsername').style.display = isLogin ? 'none' : 'block';
            clearError();
        });

        document.getElementById('logoutBtn')?.addEventListener('click', logoutUser);
        document.getElementById('menuLogout')?.addEventListener('click', logoutUser);

        document.getElementById('chatOpenBtn').addEventListener('click', function() {
            document.getElementById('chatInterface').classList.add('active');
            renderChatUsers();
        });

        document.getElementById('closeChatBtn').addEventListener('click', function() {
            document.getElementById('chatInterface').classList.remove('active');
            if (currentChatRoom) {
                socket.emit('leave-room', { roomId: currentChatRoom, userId: currentUser?.userId });
                currentChatRoom = null;
                currentChatUser = null;
            }
        });

        document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage);
        document.getElementById('chatInput').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') sendChatMessage();
        });

        document.getElementById('modalSendComment').addEventListener('click', async function() {
            var input = document.getElementById('modalCommentInput');
            var text = input.value.trim();
            if (text && currentPostId) {
                await addComment(currentPostId, text);
                input.value = '';
                document.getElementById('commentList').innerHTML = '<div style="text-align:center;color:#2ecc71;padding:20px;">✅ کامنت ثبت شد!</div>';
                setTimeout(function() { openComments(currentPostId); }, 500);
            }
        });

        document.getElementById('modalCommentInput').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') document.getElementById('modalSendComment').click();
        });

        document.getElementById('closeModal').addEventListener('click', function() {
            document.getElementById('commentModal').classList.remove('active');
            currentPostId = null;
        });

        document.getElementById('commentModal').addEventListener('click', function(e) {
            if (e.target === this) {
                this.classList.remove('active');
                currentPostId = null;
            }
        });

        document.getElementById('closeShareModal').addEventListener('click', function() {
            document.getElementById('shareModal').classList.remove('active');
        });

        document.getElementById('shareModal').addEventListener('click', function(e) {
            if (e.target === this) this.classList.remove('active');
        });

        document.querySelectorAll('.share-option').forEach(function(option) {
            option.addEventListener('click', function() {
                var type = this.getAttribute('data-share');
                var postId = document.getElementById('shareModal').dataset.postId;
                var link = window.location.href + '?post=' + postId;
                if (type === 'site') {
                    showToast('✅ پست در سایت اشتراک‌گذاری شد!');
                } else if (type === 'telegram') {
                    window.open('https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent('به این پست نگاه کن!'), '_blank');
                } else if (type === 'whatsapp') {
                    window.open('https://api.whatsapp.com/send?text=' + encodeURIComponent('به این پست نگاه کن! ' + link), '_blank');
                } else if (type === 'copy') {
                    navigator.clipboard.writeText(link).then(function() {
                        showToast('✅ لینک کپی شد!');
                    });
                }
                document.getElementById('shareModal').classList.remove('active');
            });
        });

        document.getElementById('profileBtn').addEventListener('click', function() {
            document.getElementById('profilePage').classList.add('active');
            loadProfile();
        });

        document.getElementById('closeProfile').addEventListener('click', function() {
            document.getElementById('profilePage').classList.remove('active');
        });

        document.getElementById('profilePage').addEventListener('click', function(e) {
            if (e.target === this) this.classList.remove('active');
        });

        document.getElementById('profileFollowBtn').addEventListener('click', async function() {
            if (!currentUser) return;
            var isFollowing = this.classList.contains('following');
            if (isFollowing) {
                this.classList.remove('following');
                this.textContent = 'دنبال کردن';
            } else {
                this.classList.add('following');
                this.textContent = 'دنبال شده';
            }
        });

        document.getElementById('saveBio').addEventListener('click', async function() {
            var bio = document.getElementById('bioInput').value.trim();
            if (bio && currentUser) {
                var result = await updateProfile(currentUser.userId, { bio: bio });
                if (result.success) {
                    document.getElementById('bioDisplay').textContent = bio;
                    document.getElementById('bioInput').value = '';
                    currentUser.bio = bio;
                    showToast('✅ بیوگرافی ذخیره شد!');
                }
            } else {
                showToast('❌ لطفا بیوگرافی را وارد کنید');
            }
        });

        document.getElementById('uploadBtn').addEventListener('click', function() {
            if (currentUser && currentUser.isBanned) {
                showToast('❌ شما مسدود شده‌اید');
                return;
            }
            document.getElementById('uploadPage').classList.add('active');
            document.getElementById('uploadHashtags').classList.add('active');
        });

        document.getElementById('closeUpload').addEventListener('click', function() {
            document.getElementById('uploadPage').classList.remove('active');
            resetUpload();
        });

        document.getElementById('uploadPage').addEventListener('click', function(e) {
            if (e.target === this) {
                this.classList.remove('active');
                resetUpload();
            }
        });

        document.getElementById('uploadSelectBtn').addEventListener('click', function() {
            document.getElementById('fileInput').click();
        });

        document.getElementById('fileInput').addEventListener('change', function(e) {
            var file = this.files[0];
            if (file) {
                var reader = new FileReader();
                reader.onload = function(e) {
                    var previewImg = document.getElementById('previewImage');
                    var previewVideo = document.getElementById('previewVideo');
                    if (file.type.startsWith('image/')) {
                        previewImg.src = e.target.result;
                        previewImg.style.display = 'block';
                        previewVideo.style.display = 'none';
                    } else if (file.type.startsWith('video/')) {
                        previewVideo.src = e.target.result;
                        previewVideo.style.display = 'block';
                        previewImg.style.display = 'none';
                    }
                    document.getElementById('uploadPreview').classList.add('active');
                    document.getElementById('uploadCaption').classList.add('active');
                    document.getElementById('uploadHashtags').classList.add('active');
                    document.getElementById('uploadSubmit').classList.add('active');
                };
                reader.readAsDataURL(file);
            }
        });

        document.getElementById('uploadSubmit').addEventListener('click', async function() {
            if (isUploading) return;
            var file = document.getElementById('fileInput').files[0];
            var caption = document.getElementById('captionInput').value.trim();
            var hashtags = document.getElementById('hashtagInput').value.trim();
            if (!file) {
                showToast('❌ لطفا یک فایل انتخاب کنید');
                return;
            }
            isUploading = true;
            this.textContent = '⏳ در حال آپلود...';
            this.disabled = true;
            var result = await createPost(file, caption, hashtags);
            if (result && result.postId) {
                showToast('✅ پست با موفقیت آپلود شد!');
                resetUpload();
                document.getElementById('uploadPage').classList.remove('active');
                loadPosts(1);
            } else {
                showToast('❌ خطا در آپلود');
            }
            this.textContent = '📤 ارسال پست';
            this.disabled = false;
            isUploading = false;
        });

        function resetUpload() {
            document.getElementById('fileInput').value = '';
            document.getElementById('uploadPreview').classList.remove('active');
            document.getElementById('uploadCaption').classList.remove('active');
            document.getElementById('uploadHashtags').classList.remove('active');
            document.getElementById('uploadSubmit').classList.remove('active');
            document.getElementById('previewImage').style.display = 'none';
            document.getElementById('previewVideo').style.display = 'none';
            document.getElementById('captionInput').value = '';
            document.getElementById('hashtagInput').value = '';
        }

        document.getElementById('menuIcon').addEventListener('click', function() {
            document.getElementById('sideMenu').classList.add('active');
            document.getElementById('menuOverlay').classList.add('active');
        });

        document.getElementById('closeMenu').addEventListener('click', function() {
            document.getElementById('sideMenu').classList.remove('active');
            document.getElementById('menuOverlay').classList.remove('active');
        });

        document.getElementById('menuOverlay').addEventListener('click', function() {
            document.getElementById('sideMenu').classList.remove('active');
            this.classList.remove('active');
        });

        document.getElementById('menuProfile').addEventListener('click', function() {
            document.getElementById('sideMenu').classList.remove('active');
            document.getElementById('menuOverlay').classList.remove('active');
            document.getElementById('profilePage').classList.add('active');
            loadProfile();
        });

        document.getElementById('menuSettings').addEventListener('click', function() {
            document.getElementById('sideMenu').classList.remove('active');
            document.getElementById('menuOverlay').classList.remove('active');
            document.getElementById('settingsPage').classList.add('active');
            loadProfile();
        });

        document.getElementById('menuStats').addEventListener('click', function() {
            document.getElementById('sideMenu').classList.remove('active');
            document.getElementById('menuOverlay').classList.remove('active');
            document.getElementById('settingsPage').classList.add('active');
            loadProfile();
        });

        document.getElementById('menuTheme').addEventListener('click', function() {
            toggleTheme();
            document.getElementById('sideMenu').classList.remove('active');
            document.getElementById('menuOverlay').classList.remove('active');
        });

        document.getElementById('menuAdmin').addEventListener('click', function() {
            document.getElementById('sideMenu').classList.remove('active');
            document.getElementById('menuOverlay').classList.remove('active');
            document.getElementById('adminPanel').classList.add('active');
            loadAdminPanel();
        });

        document.getElementById('settingsOpenBtn').addEventListener('click', function() {
            document.getElementById('settingsPage').classList.add('active');
            loadProfile();
        });

        document.getElementById('closeSettings').addEventListener('click', function() {
            document.getElementById('settingsPage').classList.remove('active');
        });

        document.getElementById('settingsPage').addEventListener('click', function(e) {
            if (e.target === this) this.classList.remove('active');
        });

        document.getElementById('languageSelect').addEventListener('change', function() {
            language = this.value;
            localStorage.setItem('language', language);
            if (currentUser) {
                updateProfile(currentUser.userId, { language: language });
            }
            showToast('✅ زبان تغییر کرد!');
            location.reload();
        });

        document.getElementById('themeToggle').addEventListener('click', toggleTheme);

        function toggleTheme() {
            isDarkTheme = !isDarkTheme;
            document.documentElement.setAttribute('data-theme', isDarkTheme ? 'dark' : 'light');
            localStorage.setItem('theme', isDarkTheme ? 'dark' : 'light');
            document.getElementById('themeToggle').classList.toggle('active');
            showToast(isDarkTheme ? '🌙 تم تاریک' : '☀️ تم روشن');
        }

        document.getElementById('broadcastBtn').addEventListener('click', async function() {
            var input = document.getElementById('broadcastInput');
            var message = input.value.trim();
            if (!message) {
                showToast('❌ لطفا پیام را وارد کنید');
                return;
            }
            var result = await broadcastMessage(message);
            if (result.success) {
                showToast('✅ پیام همگانی ارسال شد!');
                input.value = '';
            }
        });

        document.getElementById('adminPanel').addEventListener('click', function(e) {
            if (e.target === this) this.classList.remove('active');
        });

        var exploreMode = true;
        var reelsMode = false;

        document.getElementById('exploreBtn').addEventListener('click', function() {
            var gallery = document.getElementById('gallery');
            var stories = document.getElementById('storiesSection');
            if (exploreMode) {
                exploreMode = false;
                reelsMode = false;
                gallery.style.gridTemplateColumns = 'repeat(2, 1fr)';
                stories.style.display = 'block';
                this.classList.remove('active');
                document.getElementById('reelsBtn').classList.remove('active');
            } else {
                exploreMode = true;
                reelsMode = false;
                gallery.style.gridTemplateColumns = 'repeat(3, 1fr)';
                stories.style.display = 'none';
                this.classList.add('active');
                document.getElementById('reelsBtn').classList.remove('active');
                loadPosts(1);
            }
        });

        document.getElementById('reelsBtn').addEventListener('click', function() {
            var gallery = document.getElementById('gallery');
            var stories = document.getElementById('storiesSection');
            if (reelsMode) {
                reelsMode = false;
                exploreMode = false;
                gallery.style.gridTemplateColumns = 'repeat(2, 1fr)';
                stories.style.display = 'block';
                this.classList.remove('active');
                document.getElementById('exploreBtn').classList.remove('active');
            } else {
                reelsMode = true;
                exploreMode = false;
                gallery.style.gridTemplateColumns = '1fr';
                stories.style.display = 'none';
                this.classList.add('active');
                document.getElementById('exploreBtn').classList.remove('active');
            }
        });

        document.getElementById('searchInput').addEventListener('input', function() {
            var query = this.value.trim();
            if (query.startsWith('#')) {
                loadPosts(1, query.substring(1));
            } else if (query.length > 2) {
                loadPosts(1);
                var gallery = document.getElementById('gallery');
                var items = gallery.querySelectorAll('.gallery-item');
                items.forEach(function(item) {
                    var text = item.textContent.toLowerCase();
                    item.style.display = text.includes(query.toLowerCase()) ? '' : 'none';
                });
            } else {
                loadPosts(1);
            }
        });

        document.getElementById('statFollowers').addEventListener('click', async function() {
            var modal = document.getElementById('followModal');
            document.getElementById('followModalTitle').textContent = '👥 دنبال‌کنندگان';
            var users = await getUsers();
            var body = document.getElementById('followModalBody');
            body.innerHTML = '';
            users.forEach(function(user) {
                if (user.userId === currentUser?.userId) return;
                var div = document.createElement('div');
                div.className = 'follow-item';
                div.innerHTML = '<div class="follow-avatar"><img src="' + (user.avatar || 'https://i.pravatar.cc/150?img=' + Math.floor(Math.random() * 70)) + '" alt="' + user.username + '"></div><span class="follow-name">' + user.username + '</span><button class="follow-btn" onclick="followUser(\'' + user.userId + '\', \'' + currentUser?.userId + '\')">دنبال کردن</button>';
                body.appendChild(div);
            });
            modal.style.display = 'flex';
        });

        document.getElementById('statFollowing').addEventListener('click', async function() {
            var modal = document.getElementById('followModal');
            document.getElementById('followModalTitle').textContent = '👥 دنبال‌شونده‌ها';
            var users = await getUsers();
            var body = document.getElementById('followModalBody');
            body.innerHTML = '';
            users.forEach(function(user) {
                if (user.userId === currentUser?.userId) return;
                var div = document.createElement('div');
                div.className = 'follow-item';
                div.innerHTML = '<div class="follow-avatar"><img src="' + (user.avatar || 'https://i.pravatar.cc/150?img=' + Math.floor(Math.random() * 70)) + '" alt="' + user.username + '"></div><span class="follow-name">' + user.username + '</span><button class="follow-btn" onclick="followUser(\'' + user.userId + '\', \'' + currentUser?.userId + '\')">دنبال کردن</button>';
                body.appendChild(div);
            });
            modal.style.display = 'flex';
        });

        document.getElementById('closeFollowModal').addEventListener('click', function() {
            document.getElementById('followModal').style.display = 'none';
        });

        document.getElementById('followModal').addEventListener('click', function(e) {
            if (e.target === this) this.style.display = 'none';
        });

        if (isDarkTheme) {
            document.documentElement.setAttribute('data-theme', 'dark');
            document.getElementById('themeToggle').classList.add('active');
        }

        document.getElementById('loginUsername').style.display = 'none';

        (async function init() {
            if (currentToken) {
                var user = await getCurrentUser();
                if (user) {
                    currentUser = user;
                    isAdmin = user.isAdmin || false;
                    document.getElementById('loginPage').style.display = 'none';
                    document.getElementById('mainApp').style.display = 'flex';
                    socket.emit('register', { userId: currentUser.userId, username: currentUser.username });
                    if (isAdmin) {
                        document.getElementById('menuAdmin').style.display = 'flex';
                    }
                    await loadPosts(1);
                    await loadStories();
                    await loadProfile();
                    console.log('✅ User:', currentUser.username, isAdmin ? '(Admin)' : '');
                    return;
                } else {
                    localStorage.removeItem('token');
                    currentToken = null;
                }
            }

            document.getElementById('loginPage').style.display = 'flex';
            document.getElementById('mainApp').style.display = 'none';
            console.log('🔐 Please login');
        })();
    </script>
</body>
</html>
    `);
});

// ============================================
// 🚀 اجرا
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 Server: http://localhost:' + PORT);
    console.log('🔐 Encryption: AES-256-GCM');
    console.log('👑 Admin: milad.yari1377m@gmail.com / M09145978426m');
    console.log('📊 5 Shards Ready');
});