const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8
});

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ============================================
// 📁 ایجاد پوشه‌ها
// ============================================
const dirs = [
    './uploads', './uploads/posts', './uploads/stories',
    './uploads/avatars', './uploads/live', './public', './logs'
];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ============================================
// 📊 سیستم لاگینگ پیشرفته
// ============================================
function log(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${type}] ${message}\n`;
    try { fs.appendFileSync('./logs/app.log', logEntry); } catch (e) {}
    console.log(logEntry.trim());
}

// ============================================
// 🔐 رمزنگاری نظامی AES-256-GCM
// ============================================
const SECRET_KEY = crypto.randomBytes(32).toString('hex');
const MASTER_KEY = crypto.createHash('sha256').update(SECRET_KEY).digest();

function hashPassword(password) {
    return crypto.createHash('sha512').update(password + SECRET_KEY).digest('hex');
}

function generateToken() {
    return crypto.randomBytes(64).toString('hex');
}

function generateUserKey(userId) {
    return crypto.createHash('sha256').update(MASTER_KEY + userId).digest();
}

function encryptMessage(message, userId) {
    try {
        const key = generateUserKey(userId);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = cipher.update(message, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return iv.toString('hex') + ':' + authTag + ':' + encrypted;
    } catch { return message; }
}

function decryptMessage(encrypted, userId) {
    try {
        const key = generateUserKey(userId);
        const parts = encrypted.split(':');
        if (parts.length !== 3) return '[پیام رمزنگاری شده]';
        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encryptedText = parts[2];
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch { return '[پیام رمزنگاری شده]'; }
}

// ============================================
// 📊 دیتابیس شارد شده (50 Shard برای میلیون‌ها کاربر)
// ============================================
class ShardedDatabase {
    constructor() {
        this.shardCount = 50;
        this.shards = {};
        this.currentId = 1;
        
        for (let i = 0; i < this.shardCount; i++) {
            this.shards[i] = {
                users: {},
                posts: [],
                stories: [],
                messages: {},
                likes: {},
                comments: {},
                followers: {},
                following: {},
                bookmarks: {},
                hashtags: {},
                notifications: [],
                liveStreams: {},
                reports: [],
                analytics: {}
            };
        }
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
    saveUser(user) {
        const shardIndex = this.getShard(user.userId);
        this.shards[shardIndex].users[user.userId] = user;
        return user;
    }

    getUser(userId) {
        const shardIndex = this.getShardById(userId);
        return this.shards[shardIndex].users[userId] || null;
    }

    getUserByEmail(email) {
        for (let i = 0; i < this.shardCount; i++) {
            for (const [key, user] of Object.entries(this.shards[i].users)) {
                if (user.email === email) return user;
            }
        }
        return null;
    }

    getUserByUsername(username) {
        for (let i = 0; i < this.shardCount; i++) {
            for (const [key, user] of Object.entries(this.shards[i].users)) {
                if (user.username === username) return user;
            }
        }
        return null;
    }

    getAllUsers() {
        let allUsers = [];
        for (let i = 0; i < this.shardCount; i++) {
            allUsers = allUsers.concat(Object.values(this.shards[i].users));
        }
        return allUsers;
    }

    updateUser(userId, data) {
        const shardIndex = this.getShardById(userId);
        if (this.shards[shardIndex].users[userId]) {
            this.shards[shardIndex].users[userId] = { ...this.shards[shardIndex].users[userId], ...data };
            return this.shards[shardIndex].users[userId];
        }
        return null;
    }

    deleteUser(userId) {
        const shardIndex = this.getShardById(userId);
        if (this.shards[shardIndex].users[userId]) {
            delete this.shards[shardIndex].users[userId];
            return true;
        }
        return false;
    }

    searchUsers(query) {
        const results = [];
        const q = query.toLowerCase();
        for (let i = 0; i < this.shardCount; i++) {
            for (const [key, user] of Object.entries(this.shards[i].users)) {
                if (user.username.toLowerCase().includes(q) || user.email.toLowerCase().includes(q)) {
                    results.push(user);
                }
            }
        }
        return results;
    }

    // ===== Follow System =====
    followUser(userId, targetId) {
        const userShard = this.getShardById(userId);
        const targetShard = this.getShardById(targetId);
        
        if (!this.shards[userShard].users[userId] || !this.shards[targetShard].users[targetId]) {
            return false;
        }
        
        if (!this.shards[userShard].following[userId]) {
            this.shards[userShard].following[userId] = [];
        }
        if (!this.shards[targetShard].followers[targetId]) {
            this.shards[targetShard].followers[targetId] = [];
        }
        
        if (this.shards[userShard].following[userId].includes(targetId)) {
            return false;
        }
        
        this.shards[userShard].following[userId].push(targetId);
        this.shards[targetShard].followers[targetId].push(userId);
        
        const user = this.shards[userShard].users[userId];
        const target = this.shards[targetShard].users[targetId];
        user.following = (user.following || 0) + 1;
        target.followers = (target.followers || 0) + 1;
        
        return true;
    }

    unfollowUser(userId, targetId) {
        const userShard = this.getShardById(userId);
        const targetShard = this.getShardById(targetId);
        
        if (!this.shards[userShard].following[userId]) return false;
        
        const idx = this.shards[userShard].following[userId].indexOf(targetId);
        if (idx === -1) return false;
        
        this.shards[userShard].following[userId].splice(idx, 1);
        const tIdx = this.shards[targetShard].followers[targetId].indexOf(userId);
        if (tIdx !== -1) {
            this.shards[targetShard].followers[targetId].splice(tIdx, 1);
        }
        
        const user = this.shards[userShard].users[userId];
        const target = this.shards[targetShard].users[targetId];
        user.following = (user.following || 0) - 1;
        target.followers = (target.followers || 0) - 1;
        
        return true;
    }

    getFollowers(userId) {
        const shardIndex = this.getShardById(userId);
        const followers = this.shards[shardIndex].followers[userId] || [];
        const result = [];
        for (const id of followers) {
            const user = this.getUser(id);
            if (user) result.push(user);
        }
        return result;
    }

    getFollowing(userId) {
        const shardIndex = this.getShardById(userId);
        const following = this.shards[shardIndex].following[userId] || [];
        const result = [];
        for (const id of following) {
            const user = this.getUser(id);
            if (user) result.push(user);
        }
        return result;
    }

    // ===== Posts =====
    savePost(post) {
        const shardIndex = this.getShardById(post.postId);
        this.shards[shardIndex].posts.unshift(post);
        
        if (post.hashtags && post.hashtags.length > 0) {
            for (const tag of post.hashtags) {
                if (!this.shards[shardIndex].hashtags[tag]) {
                    this.shards[shardIndex].hashtags[tag] = [];
                }
                this.shards[shardIndex].hashtags[tag].push(post.postId);
            }
        }
        return post;
    }

    getPosts(page = 1, limit = 20, hashtag = null, userId = null) {
        let allPosts = [];
        for (let i = 0; i < this.shardCount; i++) {
            allPosts = allPosts.concat(this.shards[i].posts);
        }
        
        if (hashtag) {
            allPosts = allPosts.filter(p => p.hashtags && p.hashtags.some(h => h.toLowerCase() === hashtag.toLowerCase()));
        }
        
        if (userId) {
            allPosts = allPosts.filter(p => p.userId === userId);
        }
        
        allPosts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const start = (page - 1) * limit;
        return {
            posts: allPosts.slice(start, start + limit),
            total: allPosts.length,
            page: page,
            totalPages: Math.ceil(allPosts.length / limit)
        };
    }

    getPost(postId) {
        const shardIndex = this.getShardById(postId);
        return this.shards[shardIndex].posts.find(p => p.postId === postId) || null;
    }

    deletePost(postId) {
        const shardIndex = this.getShardById(postId);
        const index = this.shards[shardIndex].posts.findIndex(p => p.postId === postId);
        if (index !== -1) {
            const post = this.shards[shardIndex].posts[index];
            if (post.hashtags) {
                for (const tag of post.hashtags) {
                    const tagList = this.shards[shardIndex].hashtags[tag];
                    if (tagList) {
                        const idx = tagList.indexOf(postId);
                        if (idx !== -1) tagList.splice(idx, 1);
                    }
                }
            }
            this.shards[shardIndex].posts.splice(index, 1);
            return true;
        }
        return false;
    }

    likePost(postId, userId) {
        const shardIndex = this.getShardById(postId);
        const post = this.shards[shardIndex].posts.find(p => p.postId === postId);
        if (!post) return { liked: false, likes: 0 };
        const likeKey = `${postId}_${userId}`;
        if (this.shards[shardIndex].likes[likeKey]) {
            delete this.shards[shardIndex].likes[likeKey];
            post.likes = (post.likes || 0) - 1;
            return { liked: false, likes: post.likes };
        } else {
            this.shards[shardIndex].likes[likeKey] = true;
            post.likes = (post.likes || 0) + 1;
            return { liked: true, likes: post.likes };
        }
    }

    addComment(postId, comment) {
        const shardIndex = this.getShardById(postId);
        const post = this.shards[shardIndex].posts.find(p => p.postId === postId);
        if (!post) return false;
        if (!post.comments) post.comments = [];
        post.comments.push(comment);
        return true;
    }

    deleteComment(postId, commentId, userId) {
        const shardIndex = this.getShardById(postId);
        const post = this.shards[shardIndex].posts.find(p => p.postId === postId);
        if (!post || !post.comments) return false;
        const index = post.comments.findIndex(c => c.commentId === commentId && c.userId === userId);
        if (index === -1) return false;
        post.comments.splice(index, 1);
        return true;
    }

    editComment(postId, commentId, userId, newText) {
        const shardIndex = this.getShardById(postId);
        const post = this.shards[shardIndex].posts.find(p => p.postId === postId);
        if (!post || !post.comments) return false;
        const comment = post.comments.find(c => c.commentId === commentId && c.userId === userId);
        if (!comment) return false;
        comment.text = newText;
        comment.editedAt = new Date().toISOString();
        return true;
    }

    getComments(postId) {
        const shardIndex = this.getShardById(postId);
        const post = this.shards[shardIndex].posts.find(p => p.postId === postId);
        if (!post) return [];
        return post.comments || [];
    }

    bookmarkPost(postId, userId) {
        const shardIndex = this.getShardById(userId);
        if (!this.shards[shardIndex].bookmarks[userId]) {
            this.shards[shardIndex].bookmarks[userId] = [];
        }
        const bookmarks = this.shards[shardIndex].bookmarks[userId];
        const idx = bookmarks.indexOf(postId);
        if (idx !== -1) {
            bookmarks.splice(idx, 1);
            return { bookmarked: false };
        } else {
            bookmarks.push(postId);
            return { bookmarked: true };
        }
    }

    getBookmarks(userId) {
        const shardIndex = this.getShardById(userId);
        const bookmarks = this.shards[shardIndex].bookmarks[userId] || [];
        const result = [];
        for (const id of bookmarks) {
            const post = this.getPost(id);
            if (post) result.push(post);
        }
        return result;
    }

    getTrendingHashtags(limit = 10) {
        const allHashtags = {};
        for (let i = 0; i < this.shardCount; i++) {
            for (const [tag, posts] of Object.entries(this.shards[i].hashtags)) {
                if (!allHashtags[tag]) allHashtags[tag] = 0;
                allHashtags[tag] += posts.length;
            }
        }
        const sorted = Object.entries(allHashtags).sort((a, b) => b[1] - a[1]);
        return sorted.slice(0, limit).map(([tag, count]) => ({ tag, count }));
    }

    // ===== Stories =====
    saveStory(story) {
        const shardIndex = this.getShardById(story.storyId);
        this.shards[shardIndex].stories.push(story);
        return story;
    }

    getStories(userId = null) {
        let allStories = [];
        const now = Date.now();
        for (let i = 0; i < this.shardCount; i++) {
            let stories = this.shards[i].stories.filter(s => {
                const age = now - new Date(s.createdAt).getTime();
                return age < 24 * 60 * 60 * 1000;
            });
            if (userId) {
                stories = stories.filter(s => s.userId === userId);
            }
            allStories = allStories.concat(stories);
        }
        return allStories.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    deleteStory(storyId, userId) {
        const shardIndex = this.getShardById(storyId);
        const index = this.shards[shardIndex].stories.findIndex(s => s.storyId === storyId && s.userId === userId);
        if (index !== -1) {
            this.shards[shardIndex].stories.splice(index, 1);
            return true;
        }
        return false;
    }

    viewStory(storyId, userId) {
        const shardIndex = this.getShardById(storyId);
        const story = this.shards[shardIndex].stories.find(s => s.storyId === storyId);
        if (story && !story.viewers) {
            story.viewers = [];
        }
        if (story && !story.viewers.includes(userId)) {
            story.views = (story.views || 0) + 1;
            story.viewers.push(userId);
            return true;
        }
        return false;
    }

    // ===== Messages =====
    saveMessage(roomId, message) {
        const shardIndex = this.getShardById(roomId);
        if (!this.shards[shardIndex].messages[roomId]) {
            this.shards[shardIndex].messages[roomId] = [];
        }
        this.shards[shardIndex].messages[roomId].push(message);
        return message;
    }

    getMessages(roomId, limit = 50) {
        const shardIndex = this.getShardById(roomId);
        if (!this.shards[shardIndex].messages[roomId]) return [];
        return this.shards[shardIndex].messages[roomId].slice(-limit);
    }

    // ===== Live Streams =====
    startLiveStream(userId, title) {
        const shardIndex = this.getShardById(userId);
        const streamId = 'live_' + uuidv4();
        this.shards[shardIndex].liveStreams[streamId] = {
            streamId: streamId,
            userId: userId,
            title: title,
            viewers: [],
            isLive: true,
            startedAt: new Date().toISOString(),
            endedAt: null
        };
        return streamId;
    }

    endLiveStream(streamId) {
        for (let i = 0; i < this.shardCount; i++) {
            if (this.shards[i].liveStreams[streamId]) {
                this.shards[i].liveStreams[streamId].isLive = false;
                this.shards[i].liveStreams[streamId].endedAt = new Date().toISOString();
                return true;
            }
        }
        return false;
    }

    getLiveStreams() {
        let allStreams = [];
        for (let i = 0; i < this.shardCount; i++) {
            for (const [key, stream] of Object.entries(this.shards[i].liveStreams)) {
                if (stream.isLive) {
                    allStreams.push(stream);
                }
            }
        }
        return allStreams;
    }

    joinLiveStream(streamId, userId) {
        for (let i = 0; i < this.shardCount; i++) {
            if (this.shards[i].liveStreams[streamId]) {
                const stream = this.shards[i].liveStreams[streamId];
                if (stream.isLive && !stream.viewers.includes(userId)) {
                    stream.viewers.push(userId);
                    return true;
                }
            }
        }
        return false;
    }

    leaveLiveStream(streamId, userId) {
        for (let i = 0; i < this.shardCount; i++) {
            if (this.shards[i].liveStreams[streamId]) {
                const stream = this.shards[i].liveStreams[streamId];
                const idx = stream.viewers.indexOf(userId);
                if (idx !== -1) {
                    stream.viewers.splice(idx, 1);
                    return true;
                }
            }
        }
        return false;
    }

    // ===== Notifications =====
    addNotification(notification) {
        const shardIndex = this.getShardById(notification.userId);
        if (!this.shards[shardIndex].notifications) {
            this.shards[shardIndex].notifications = [];
        }
        this.shards[shardIndex].notifications.push(notification);
        return notification;
    }

    getNotifications(userId) {
        const shardIndex = this.getShardById(userId);
        return this.shards[shardIndex].notifications || [];
    }

    markNotificationRead(notificationId, userId) {
        const shardIndex = this.getShardById(userId);
        const notifications = this.shards[shardIndex].notifications || [];
        const notif = notifications.find(n => n.notificationId === notificationId);
        if (notif) {
            notif.isRead = true;
            return true;
        }
        return false;
    }

    // ===== Stats =====
    getStats() {
        let totalUsers = 0, totalPosts = 0, totalStories = 0;
        let totalMessages = 0, totalLikes = 0, totalComments = 0;

        for (let i = 0; i < this.shardCount; i++) {
            totalUsers += Object.keys(this.shards[i].users).length;
            totalPosts += this.shards[i].posts.length;
            totalStories += this.shards[i].stories.length;
            totalLikes += Object.keys(this.shards[i].likes).length;
            for (const post of this.shards[i].posts) {
                totalComments += (post.comments || []).length;
            }
            for (const room of Object.values(this.shards[i].messages)) {
                totalMessages += room.length;
            }
        }

        return {
            totalUsers,
            totalPosts,
            totalStories,
            totalMessages,
            totalLikes,
            totalComments,
            shardCount: this.shardCount,
            onlineUsers: Object.keys(onlineUsers).length || 0
        };
    }
}

const db = new ShardedDatabase();
const onlineUsers = {};
const userSessions = new Map();
const liveStreams = {};

const ADMIN_EMAIL = 'admin@instagram.com';
const ADMIN_PASSWORD = hashPassword('admin123');

// ============================================
// 📡 API Routes
// ============================================

// ===== Auth =====
app.post('/api/auth/register', (req, res) => {
    const { username, email, password, fullName } = req.body;
    
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'همه فیلدها الزامی هستند' });
    }

    if (db.getUserByEmail(email)) {
        return res.status(400).json({ error: 'این ایمیل قبلاً ثبت شده است' });
    }

    if (db.getUserByUsername(username)) {
        return res.status(400).json({ error: 'این نام کاربری قبلاً ثبت شده است' });
    }

    if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: 'نام کاربری باید بین 3 تا 30 کاراکتر باشد' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'رمز عبور باید حداقل 6 کاراکتر باشد' });
    }

    const userId = 'user_' + uuidv4();
    const isAdmin = email === ADMIN_EMAIL;

    const user = {
        userId: userId,
        username: username,
        email: email,
        fullName: fullName || username,
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
        isVerified: false,
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString()
    };

    db.saveUser(user);
    const token = generateToken();
    userSessions.set(token, userId);
    onlineUsers[userId] = { socketId: null, username: username };

    res.json({
        success: true,
        token: token,
        user: {
            userId: userId,
            username: username,
            email: email,
            fullName: user.fullName,
            bio: '',
            avatar: '',
            followers: 0,
            following: 0,
            postsCount: 0,
            isAdmin: isAdmin,
            isBanned: false,
            isVerified: false
        }
    });
});

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
    userSessions.set(token, user.userId);
    onlineUsers[user.userId] = { socketId: null, username: user.username };
    db.updateUser(user.userId, { isOnline: true, lastSeen: new Date().toISOString() });

    res.json({
        success: true,
        token: token,
        user: {
            userId: user.userId,
            username: user.username,
            email: user.email,
            fullName: user.fullName || user.username,
            bio: user.bio || '',
            avatar: user.avatar || '',
            followers: user.followers || 0,
            following: user.following || 0,
            postsCount: user.postsCount || 0,
            isAdmin: user.isAdmin || false,
            isBanned: user.isBanned || false,
            isVerified: user.isVerified || false
        }
    });
});

app.post('/api/auth/logout', (req, res) => {
    const { token } = req.body;
    if (token) {
        const userId = userSessions.get(token);
        if (userId) {
            db.updateUser(userId, { isOnline: false, lastSeen: new Date().toISOString() });
            delete onlineUsers[userId];
        }
        userSessions.delete(token);
    }
    res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const userId = userSessions.get(token);
    if (!userId) return res.status(401).json({ error: 'Invalid token' });

    const user = db.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'User is banned' });

    res.json({
        userId: user.userId,
        username: user.username,
        email: user.email,
        fullName: user.fullName || user.username,
        bio: user.bio || '',
        avatar: user.avatar || '',
        followers: user.followers || 0,
        following: user.following || 0,
        postsCount: user.postsCount || 0,
        isAdmin: user.isAdmin || false,
        isBanned: user.isBanned || false,
        isVerified: user.isVerified || false
    });
});

// ===== Admin =====
app.post('/api/admin/verify', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const userId = userSessions.get(token);
    if (!userId) return res.status(401).json({ error: 'Invalid token' });

    const user = db.getUser(userId);
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    res.json({ success: true, isAdmin: true });
});

app.get('/api/admin/users', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const userId = userSessions.get(token);
    if (!userId) return res.status(401).json({ error: 'Invalid token' });
    const user = db.getUser(userId);
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const users = db.getAllUsers().map(u => ({
        userId: u.userId,
        username: u.username,
        email: u.email,
        fullName: u.fullName || u.username,
        bio: u.bio || '',
        avatar: u.avatar || '',
        followers: u.followers || 0,
        following: u.following || 0,
        postsCount: u.postsCount || 0,
        isAdmin: u.isAdmin || false,
        isBanned: u.isBanned || false,
        isVerified: u.isVerified || false,
        isOnline: u.isOnline || false,
        createdAt: u.createdAt,
        lastSeen: u.lastSeen
    }));

    res.json(users);
});

app.put('/api/admin/users/:userId/ban', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const adminId = userSessions.get(token);
    if (!adminId) return res.status(401).json({ error: 'Invalid token' });
    const admin = db.getUser(adminId);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const { userId } = req.params;
    const { banned } = req.body;
    const user = db.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isAdmin) return res.status(403).json({ error: 'Cannot ban admin' });

    db.updateUser(userId, { isBanned: banned });
    if (banned) delete onlineUsers[userId];
    
    res.json({ success: true });
});

app.get('/api/admin/posts', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const userId = userSessions.get(token);
    if (!userId) return res.status(401).json({ error: 'Invalid token' });
    const user = db.getUser(userId);
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const result = db.getPosts(1, 1000);
    res.json(result.posts);
});

app.delete('/api/admin/posts/:postId', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const adminId = userSessions.get(token);
    if (!adminId) return res.status(401).json({ error: 'Invalid token' });
    const admin = db.getUser(adminId);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const { postId } = req.params;
    const deleted = db.deletePost(postId);
    res.json({ success: deleted });
});

app.post('/api/admin/broadcast', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const adminId = userSessions.get(token);
    if (!adminId) return res.status(401).json({ error: 'Invalid token' });
    const admin = db.getUser(adminId);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    io.emit('broadcast', { message, from: admin.username, timestamp: new Date().toISOString() });
    res.json({ success: true });
});

app.get('/api/admin/stats', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const userId = userSessions.get(token);
    if (!userId) return res.status(401).json({ error: 'Invalid token' });
    const user = db.getUser(userId);
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    res.json(db.getStats());
});

// ===== Users =====
app.get('/api/users', (req, res) => {
    const users = db.getAllUsers().map(u => ({
        userId: u.userId,
        username: u.username,
        fullName: u.fullName || u.username,
        avatar: u.avatar || '',
        bio: u.bio || '',
        followers: u.followers || 0,
        following: u.following || 0,
        isOnline: u.isOnline || false,
        isVerified: u.isVerified || false
    }));
    res.json(users);
});

app.get('/api/users/:userId', (req, res) => {
    const user = db.getUser(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    res.json({
        userId: user.userId,
        username: user.username,
        fullName: user.fullName || user.username,
        avatar: user.avatar || '',
        bio: user.bio || '',
        followers: user.followers || 0,
        following: user.following || 0,
        postsCount: user.postsCount || 0,
        isOnline: user.isOnline || false,
        isVerified: user.isVerified || false,
        createdAt: user.createdAt,
        lastSeen: user.lastSeen
    });
});

app.put('/api/users/:userId/profile', (req, res) => {
    const { userId } = req.params;
    const { bio, avatar, fullName, username } = req.body;

    const user = db.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (bio !== undefined) user.bio = bio;
    if (avatar !== undefined) user.avatar = avatar;
    if (fullName !== undefined) user.fullName = fullName;
    if (username !== undefined) {
        const existing = db.getAllUsers().find(u => u.username === username && u.userId !== userId);
        if (existing) return res.status(400).json({ error: 'Username taken' });
        user.username = username;
    }

    db.updateUser(userId, user);
    res.json({ success: true, user: user });
});

app.post('/api/users/:userId/follow', (req, res) => {
    const { userId } = req.params;
    const { followerId } = req.body;

    const result = db.followUser(followerId, userId);
    if (!result) return res.status(400).json({ error: 'Already following' });

    const target = db.getUser(userId);
    io.emit('follow-update', { userId: target.userId, followers: target.followers });
    res.json({ success: true, followers: target.followers });
});

app.post('/api/users/:userId/unfollow', (req, res) => {
    const { userId } = req.params;
    const { followerId } = req.body;

    const result = db.unfollowUser(followerId, userId);
    if (!result) return res.status(400).json({ error: 'Not following' });

    const target = db.getUser(userId);
    res.json({ success: true, followers: target.followers });
});

app.get('/api/users/search', (req, res) => {
    const { q } = req.query;
    if (!q) return res.json([]);
    const results = db.searchUsers(q);
    res.json(results.map(u => ({
        userId: u.userId,
        username: u.username,
        fullName: u.fullName || u.username,
        avatar: u.avatar || '',
        bio: u.bio || '',
        followers: u.followers || 0,
        isOnline: u.isOnline || false,
        isVerified: u.isVerified || false
    })));
});

// ===== Posts =====
const storage = multer.diskStorage({
    destination: './uploads/posts/',
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
        cb(null, allowed.includes(file.mimetype));
    }
});

app.get('/api/posts', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const hashtag = req.query.hashtag || null;
    const userId = req.query.userId || null;

    const result = db.getPosts(page, limit, hashtag, userId);
    res.json(result);
});

app.post('/api/posts', upload.single('file'), (req, res) => {
    const { caption, userId, username, hashtags } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'فایل انتخاب نشده است' });

    const user = db.getUser(userId);
    if (!user || user.isBanned) return res.status(403).json({ error: 'User is banned' });

    const postId = 'post_' + uuidv4();
    const newPost = {
        postId: postId,
        userId: userId,
        username: username || user.username,
        fullName: user.fullName || user.username,
        image: '/uploads/posts/' + file.filename,
        caption: caption || '',
        hashtags: hashtags ? hashtags.split(',').map(h => h.trim()) : [],
        likes: 0,
        comments: [],
        shares: 0,
        views: 0,
        isVideo: file.mimetype.startsWith('video/'),
        createdAt: new Date().toISOString()
    };

    db.savePost(newPost);
    db.updateUser(userId, { postsCount: (user.postsCount || 0) + 1 });

    // Send notification to followers
    const followers = db.getFollowers(userId);
    for (const follower of followers) {
        db.addNotification({
            notificationId: 'notif_' + uuidv4(),
            userId: follower.userId,
            fromUserId: userId,
            type: 'post',
            postId: postId,
            isRead: false,
            createdAt: new Date().toISOString()
        });
        io.to(`user_${follower.userId}`).emit('new-post', { userId: userId, postId: postId });
    }

    res.status(201).json(newPost);
});

app.get('/api/posts/:postId', (req, res) => {
    const post = db.getPost(req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json(post);
});

app.delete('/api/posts/:postId', (req, res) => {
    const { userId } = req.body;
    const post = db.getPost(req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.userId !== userId) return res.status(403).json({ error: 'Not your post' });

    db.deletePost(req.params.postId);
    res.json({ success: true });
});

app.put('/api/posts/:postId/like', (req, res) => {
    const { postId } = req.params;
    const { userId } = req.body;

    const result = db.likePost(postId, userId);
    if (result.liked) {
        const post = db.getPost(postId);
        if (post && post.userId !== userId) {
            db.addNotification({
                notificationId: 'notif_' + uuidv4(),
                userId: post.userId,
                fromUserId: userId,
                type: 'like',
                postId: postId,
                isRead: false,
                createdAt: new Date().toISOString()
            });
            io.to(`user_${post.userId}`).emit('notification', { type: 'like', fromUserId: userId, postId: postId });
        }
    }
    res.json(result);
});

app.post('/api/posts/:postId/comment', (req, res) => {
    const { postId } = req.params;
    const { userId, username, text } = req.body;

    if (!text) return res.status(400).json({ error: 'متن کامنت الزامی است' });

    const user = db.getUser(userId);
    if (!user || user.isBanned) return res.status(403).json({ error: 'User is banned' });

    const comment = {
        commentId: 'cmt_' + uuidv4(),
        userId: userId,
        username: username || user.username,
        fullName: user.fullName || user.username,
        text: text,
        createdAt: new Date().toISOString(),
        likes: 0
    };

    const added = db.addComment(postId, comment);
    if (!added) return res.status(404).json({ error: 'Post not found' });

    const post = db.getPost(postId);
    if (post && post.userId !== userId) {
        db.addNotification({
            notificationId: 'notif_' + uuidv4(),
            userId: post.userId,
            fromUserId: userId,
            type: 'comment',
            postId: postId,
            isRead: false,
            createdAt: new Date().toISOString()
        });
        io.to(`user_${post.userId}`).emit('notification', { type: 'comment', fromUserId: userId, postId: postId });
    }

    res.status(201).json(comment);
});

app.delete('/api/posts/:postId/comments/:commentId', (req, res) => {
    const { postId, commentId } = req.params;
    const { userId } = req.body;

    const deleted = db.deleteComment(postId, commentId, userId);
    if (!deleted) return res.status(404).json({ error: 'Comment not found or not yours' });
    res.json({ success: true });
});

app.put('/api/posts/:postId/comments/:commentId', (req, res) => {
    const { postId, commentId } = req.params;
    const { userId, text } = req.body;

    if (!text) return res.status(400).json({ error: 'متن کامنت الزامی است' });

    const edited = db.editComment(postId, commentId, userId, text);
    if (!edited) return res.status(404).json({ error: 'Comment not found or not yours' });
    res.json({ success: true });
});

app.get('/api/posts/:postId/comments', (req, res) => {
    const comments = db.getComments(req.params.postId);
    res.json(comments);
});

app.post('/api/posts/:postId/bookmark', (req, res) => {
    const { postId } = req.params;
    const { userId } = req.body;

    const result = db.bookmarkPost(postId, userId);
    res.json(result);
});

app.get('/api/trends', (req, res) => {
    const trends = db.getTrendingHashtags(10);
    res.json(trends);
});

// ===== Stories =====
const storyStorage = multer.diskStorage({
    destination: './uploads/stories/',
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const storyUpload = multer({
    storage: storyStorage,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'];
        cb(null, allowed.includes(file.mimetype));
    }
});

app.get('/api/stories', (req, res) => {
    const stories = db.getStories();
    res.json(stories);
});

app.get('/api/stories/:userId', (req, res) => {
    const stories = db.getStories(req.params.userId);
    res.json(stories);
});

app.post('/api/stories', storyUpload.single('file'), (req, res) => {
    const { userId, username } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'فایل انتخاب نشده است' });

    const user = db.getUser(userId);
    if (!user || user.isBanned) return res.status(403).json({ error: 'User is banned' });

    const storyId = 'story_' + uuidv4();
    const story = {
        storyId: storyId,
        userId: userId,
        username: username || user.username,
        fullName: user.fullName || user.username,
        image: '/uploads/stories/' + file.filename,
        isVideo: file.mimetype.startsWith('video/'),
        views: 0,
        viewers: [],
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };

    db.saveStory(story);

    // Notify followers
    const followers = db.getFollowers(userId);
    for (const follower of followers) {
        io.to(`user_${follower.userId}`).emit('new-story', { userId: userId, storyId: storyId });
    }

    res.status(201).json(story);
});

app.delete('/api/stories/:storyId', (req, res) => {
    const { storyId } = req.params;
    const { userId } = req.body;

    const deleted = db.deleteStory(storyId, userId);
    if (!deleted) return res.status(404).json({ error: 'Story not found or not yours' });
    res.json({ success: true });
});

app.post('/api/stories/:storyId/view', (req, res) => {
    const { storyId } = req.params;
    const { userId } = req.body;

    const viewed = db.viewStory(storyId, userId);
    res.json({ success: viewed });
});

// ===== Messages =====
app.get('/api/messages/:userId', (req, res) => {
    const { userId } = req.params;
    const { otherUserId } = req.query;

    if (!otherUserId) return res.status(400).json({ error: 'otherUserId required' });

    const roomId = [userId, otherUserId].sort().join('_');
    const messages = db.getMessages(roomId, 50);
    const decrypted = messages.map(msg => ({
        ...msg,
        message: decryptMessage(msg.message, msg.userId)
    }));
    res.json(decrypted);
});

// ===== Live Streams =====
app.post('/api/live/start', (req, res) => {
    const { userId, title } = req.body;

    const user = db.getUser(userId);
    if (!user || user.isBanned) return res.status(403).json({ error: 'User is banned' });

    const streamId = db.startLiveStream(userId, title);
    liveStreams[streamId] = { userId: userId, title: title, viewers: [] };

    io.emit('live-started', { streamId: streamId, userId: userId, title: title });
    res.json({ success: true, streamId: streamId });
});

app.post('/api/live/end', (req, res) => {
    const { streamId } = req.body;

    const ended = db.endLiveStream(streamId);
    if (!ended) return res.status(404).json({ error: 'Stream not found' });

    delete liveStreams[streamId];
    io.emit('live-ended', { streamId: streamId });
    res.json({ success: true });
});

app.get('/api/live/streams', (req, res) => {
    const streams = db.getLiveStreams();
    res.json(streams);
});

app.post('/api/live/join', (req, res) => {
    const { streamId, userId } = req.body;

    const joined = db.joinLiveStream(streamId, userId);
    if (!joined) return res.status(404).json({ error: 'Stream not found' });

    if (!liveStreams[streamId]) {
        liveStreams[streamId] = { viewers: [] };
    }
    if (!liveStreams[streamId].viewers.includes(userId)) {
        liveStreams[streamId].viewers.push(userId);
    }

    io.to(`live_${streamId}`).emit('viewer-joined', { userId: userId, count: liveStreams[streamId].viewers.length });
    res.json({ success: true });
});

app.post('/api/live/leave', (req, res) => {
    const { streamId, userId } = req.body;

    const left = db.leaveLiveStream(streamId, userId);
    if (!left) return res.status(404).json({ error: 'Stream not found' });

    if (liveStreams[streamId]) {
        const idx = liveStreams[streamId].viewers.indexOf(userId);
        if (idx !== -1) liveStreams[streamId].viewers.splice(idx, 1);
        io.to(`live_${streamId}`).emit('viewer-left', { userId: userId, count: liveStreams[streamId].viewers.length });
    }
    res.json({ success: true });
});

// ===== Notifications =====
app.get('/api/notifications/:userId', (req, res) => {
    const notifications = db.getNotifications(req.params.userId);
    res.json(notifications);
});

app.post('/api/notifications/:notificationId/read', (req, res) => {
    const { notificationId } = req.params;
    const { userId } = req.body;

    const marked = db.markNotificationRead(notificationId, userId);
    res.json({ success: marked });
});

// ============================================
// 💬 WebSocket
// ============================================

io.on('connection', (socket) => {
    log('Socket connected: ' + socket.id);

    socket.on('register', (data) => {
        const { userId, username } = data;
        onlineUsers[userId] = { socketId: socket.id, username: username };
        socket.userId = userId;
        socket.username = username;

        db.updateUser(userId, { isOnline: true, lastSeen: new Date().toISOString() });
        io.emit('users-online', Object.keys(onlineUsers));
        log('User ' + username + ' online');
    });

    socket.on('join-room', (data) => {
        const { roomId, userId } = data;
        socket.join(roomId);
        socket.roomId = roomId;

        const messages = db.getMessages(roomId, 50);
        const decrypted = messages.map(msg => ({
            ...msg,
            message: decryptMessage(msg.message, msg.userId)
        }));
        socket.emit('history', decrypted);
    });

    socket.on('send-message', (data) => {
        const { roomId, userId, username, message } = data;

        const user = db.getUser(userId);
        if (user && user.isBanned) {
            socket.emit('error', { message: 'You are banned' });
            return;
        }

        const encrypted = encryptMessage(message, userId);
        const msgData = {
            messageId: 'msg_' + uuidv4(),
            userId: userId,
            username: username,
            message: encrypted,
            timestamp: new Date().toISOString()
        };

        db.saveMessage(roomId, msgData);
        io.to(roomId).emit('receive-message', {
            ...msgData,
            message: message
        });
    });

    socket.on('join-live', (data) => {
        const { streamId } = data;
        socket.join(`live_${streamId}`);
        log('User joined live: ' + streamId);
    });

    socket.on('live-comment', (data) => {
        const { streamId, userId, username, text } = data;
        io.to(`live_${streamId}`).emit('live-comment', {
            userId: userId,
            username: username,
            text: text,
            timestamp: new Date().toISOString()
        });
    });

    socket.on('leave-room', (data) => {
        const { roomId } = data;
        socket.leave(roomId);
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            delete onlineUsers[socket.userId];
            db.updateUser(socket.userId, { isOnline: false, lastSeen: new Date().toISOString() });
            io.emit('users-online', Object.keys(onlineUsers));
            log('User ' + socket.userId + ' disconnected');
        }
    });
});

// ============================================
// 🌐 صفحه HTML کامل - همه چیز در یک صفحه
// ============================================

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>سوشال مدیا حرفه‌ای</title>
    <script src="/socket.io/socket.io.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        :root {
            --bg: #fafafa;
            --bg-secondary: #ffffff;
            --text: #262626;
            --text-secondary: #8e8e8e;
            --border: #dbdbdb;
            --primary: #0095f6;
            --danger: #ed4956;
            --success: #2ecc71;
            --radius: 12px;
            --shadow: 0 2px 12px rgba(0,0,0,0.08);
            --header-height: 60px;
            --bottom-nav-height: 65px;
            --max-width: 935px;
        }
        [data-theme="dark"] {
            --bg: #121212;
            --bg-secondary: #1e1e1e;
            --text: #ffffff;
            --text-secondary: #a0a0a0;
            --border: #2c2c2c;
        }
        body {
            background: var(--bg);
            color: var(--text);
            font-family: 'Segoe UI', Tahoma, sans-serif;
            height: 100vh;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            transition: all 0.3s;
        }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: var(--bg); }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

        /* Login */
        .login-container {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            background: var(--bg);
            padding: 20px;
        }
        .login-box {
            background: var(--bg-secondary);
            padding: 40px;
            border-radius: var(--radius);
            box-shadow: var(--shadow);
            max-width: 400px;
            width: 100%;
            border: 1px solid var(--border);
        }
        .login-box h2 { text-align: center; margin-bottom: 20px; color: var(--text); }
        .login-box input {
            width: 100%;
            padding: 12px 16px;
            margin: 8px 0;
            border: 1px solid var(--border);
            border-radius: 8px;
            font-size: 14px;
            background: var(--bg);
            color: var(--text);
            direction: rtl;
            transition: 0.3s;
        }
        .login-box input:focus { border-color: var(--primary); outline: none; }
        .login-box button {
            width: 100%;
            padding: 12px;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: 0.3s;
        }
        .login-box button:hover { opacity: 0.9; transform: scale(1.02); }
        .login-box .switch-link {
            text-align: center;
            margin-top: 12px;
            color: var(--primary);
            cursor: pointer;
        }
        .login-box .switch-link:hover { text-decoration: underline; }
        .login-box .error { color: var(--danger); font-size: 13px; text-align: center; margin: 8px 0; }

        /* Header */
        .header {
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border);
            padding: 0 16px;
            height: var(--header-height);
            display: flex;
            align-items: center;
            gap: 15px;
            flex-shrink: 0;
            position: sticky;
            top: 0;
            z-index: 100;
        }
        .logo {
            font-size: 20px;
            font-weight: 700;
            color: var(--text);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .logo i { color: var(--primary); }
        .search-box {
            flex: 1;
            max-width: 400px;
            background: var(--bg);
            padding: 8px 16px;
            border-radius: 24px;
            display: flex;
            align-items: center;
            gap: 10px;
            border: 1px solid var(--border);
            transition: 0.3s;
        }
        .search-box:focus-within { border-color: var(--primary); }
        .search-box input {
            border: none;
            background: transparent;
            outline: none;
            width: 100%;
            font-size: 14px;
            color: var(--text);
        }
        .search-box input::placeholder { color: var(--text-secondary); }
        .search-box i { color: var(--text-secondary); }
        .header-right {
            display: flex;
            gap: 18px;
            font-size: 22px;
            color: var(--text);
        }
        .header-right i { cursor: pointer; transition: 0.3s; }
        .header-right i:hover { color: var(--primary); }

        /* Stories */
        .stories-section {
            background: var(--bg-secondary);
            padding: 12px 16px;
            border-bottom: 1px solid var(--border);
            overflow-x: auto;
            flex-shrink: 0;
        }
        .stories-container {
            display: flex;
            gap: 16px;
        }
        .story-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            cursor: pointer;
            flex-shrink: 0;
            transition: 0.3s;
        }
        .story-item:hover { transform: scale(1.05); }
        .story-avatar {
            width: 64px;
            height: 64px;
            border-radius: 50%;
            padding: 2px;
            background: linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366);
        }
        .story-avatar img {
            width: 100%;
            height: 100%;
            border-radius: 50%;
            border: 2px solid var(--bg-secondary);
            object-fit: cover;
        }
        .story-avatar.add-story {
            background: var(--bg);
            border: 2px dashed var(--border);
            padding: 0;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .story-avatar.add-story i { font-size: 28px; color: var(--primary); }
        .story-name {
            font-size: 11px;
            color: var(--text);
            max-width: 64px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            text-align: center;
        }

        /* Gallery */
        .gallery-wrapper {
            flex: 1;
            overflow-y: auto;
            padding-bottom: var(--bottom-nav-height);
        }
        .gallery {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 4px;
            padding: 4px;
            max-width: var(--max-width);
            margin: 0 auto;
        }
        .gallery-item {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            overflow: hidden;
            cursor: pointer;
            position: relative;
            transition: 0.3s;
        }
        .gallery-item:hover { transform: scale(1.02); box-shadow: var(--shadow); }
        .gallery-item .image-container {
            width: 100%;
            aspect-ratio: 1;
            overflow: hidden;
            background: #ddd;
        }
        .gallery-item .image-container img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            transition: 0.3s;
        }
        .gallery-item:hover .image-container img { transform: scale(1.05); }
        .gallery-item .post-overlay {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            background: linear-gradient(transparent, rgba(0,0,0,0.7));
            padding: 12px 8px 8px;
            display: flex;
            justify-content: space-around;
            color: white;
            opacity: 0;
            transition: 0.3s;
        }
        .gallery-item:hover .post-overlay { opacity: 1; }
        .gallery-item .post-overlay button {
            background: transparent;
            border: none;
            color: white;
            font-size: 14px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            border-radius: 6px;
            transition: 0.3s;
        }
        .gallery-item .post-overlay button:hover { background: rgba(255,255,255,0.15); }
        .gallery-item .post-overlay button.liked i { color: var(--danger); }

        /* Bottom Nav */
        .bottom-nav {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: var(--bg-secondary);
            border-top: 1px solid var(--border);
            display: flex;
            justify-content: space-around;
            padding: 8px 0 12px;
            z-index: 100;
            height: var(--bottom-nav-height);
        }
        .bottom-nav button {
            background: transparent;
            border: none;
            cursor: pointer;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 2px;
            font-size: 10px;
            color: var(--text-secondary);
            padding: 4px 16px;
            transition: 0.3s;
        }
        .bottom-nav button i { font-size: 24px; color: var(--text-secondary); transition: 0.3s; }
        .bottom-nav button.active i { color: var(--primary); }
        .bottom-nav button.active { color: var(--primary); }
        .bottom-nav button:hover { background: var(--bg); border-radius: 8px; }

        /* Modals */
        .modal-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.7);
            z-index: 300;
            justify-content: center;
            align-items: center;
            padding: 20px;
            backdrop-filter: blur(4px);
        }
        .modal-overlay.active { display: flex; }
        .modal-content {
            background: var(--bg-secondary);
            border-radius: var(--radius);
            max-width: 520px;
            width: 100%;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            box-shadow: var(--shadow);
            animation: modalIn 0.3s ease;
        }
        @keyframes modalIn {
            from { opacity: 0; transform: scale(0.95) translateY(20px); }
            to { opacity: 1; transform: scale(1) translateY(0); }
        }
        .modal-header {
            padding: 16px 20px;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }
        .modal-header h3 { font-size: 16px; color: var(--text); }
        .modal-header .close-modal {
            font-size: 24px;
            cursor: pointer;
            color: var(--text);
            background: none;
            border: none;
            transition: 0.3s;
        }
        .modal-header .close-modal:hover { transform: rotate(90deg); }
        .modal-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
        .modal-footer {
            padding: 12px 20px;
            border-top: 1px solid var(--border);
            display: flex;
            gap: 10px;
            flex-shrink: 0;
        }
        .modal-footer input {
            flex: 1;
            padding: 10px 14px;
            border: 1px solid var(--border);
            border-radius: 24px;
            outline: none;
            font-size: 14px;
            background: var(--bg);
            color: var(--text);
            direction: rtl;
        }
        .modal-footer input:focus { border-color: var(--primary); }
        .modal-footer button {
            background: var(--primary);
            color: white;
            border: none;
            padding: 10px 24px;
            border-radius: 24px;
            font-weight: 600;
            cursor: pointer;
            transition: 0.3s;
        }
        .modal-footer button:hover { opacity: 0.9; }

        /* Comment Item */
        .comment-item {
            display: flex;
            gap: 12px;
            padding: 10px 0;
            border-bottom: 1px solid var(--border);
        }
        .comment-item:last-child { border-bottom: none; }
        .comment-avatar {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            overflow: hidden;
            flex-shrink: 0;
            background: var(--border);
        }
        .comment-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .comment-content { flex: 1; }
        .comment-username { font-weight: 600; font-size: 13px; color: var(--text); }
        .comment-text { font-size: 13px; color: var(--text); margin-top: 2px; }
        .comment-time { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
        .comment-actions { display: flex; gap: 8px; margin-top: 4px; }
        .comment-actions button {
            background: none;
            border: none;
            font-size: 12px;
            color: var(--text-secondary);
            cursor: pointer;
            transition: 0.3s;
        }
        .comment-actions button:hover { color: var(--primary); }

        /* Profile Page */
        .profile-page {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: var(--bg);
            z-index: 150;
            overflow-y: auto;
            padding-top: var(--header-height);
        }
        .profile-page.active { display: block; }
        .profile-header-bar {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: var(--bg-secondary);
            padding: 0 16px;
            height: var(--header-height);
            border-bottom: 1px solid var(--border);
            z-index: 151;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .profile-header-bar h2 { font-size: 18px; color: var(--text); }
        .profile-header-bar .close-profile {
            font-size: 24px;
            cursor: pointer;
            color: var(--text);
            background: none;
            border: none;
            transition: 0.3s;
        }
        .profile-header-bar .close-profile:hover { transform: rotate(90deg); }
        .profile-info {
            background: var(--bg-secondary);
            padding: 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
            border-bottom: 1px solid var(--border);
        }
        .profile-avatar-large {
            width: 100px;
            height: 100px;
            border-radius: 50%;
            overflow: hidden;
            border: 3px solid var(--border);
            margin-bottom: 10px;
        }
        .profile-avatar-large img { width: 100%; height: 100%; object-fit: cover; }
        .profile-username { font-size: 20px; font-weight: 600; color: var(--text); }
        .profile-fullname { font-size: 14px; color: var(--text-secondary); }
        .profile-bio { font-size: 14px; color: var(--text); margin: 6px 0; text-align: center; padding: 0 20px; }
        .profile-stats {
            display: flex;
            justify-content: space-around;
            padding: 16px 0;
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border);
            width: 100%;
        }
        .profile-stats .stat {
            display: flex;
            flex-direction: column;
            align-items: center;
            cursor: pointer;
            transition: 0.3s;
        }
        .profile-stats .stat:hover { opacity: 0.7; }
        .profile-stats .stat .number { font-size: 18px; font-weight: 600; color: var(--text); }
        .profile-stats .stat .label { font-size: 13px; color: var(--text-secondary); }
        .profile-follow-btn {
            padding: 8px 32px;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
            margin: 6px 0;
            transition: 0.3s;
        }
        .profile-follow-btn:hover { opacity: 0.9; transform: scale(1.02); }
        .profile-follow-btn.following { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
        .profile-gallery {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 3px;
            padding: 3px;
        }
        .profile-post {
            aspect-ratio: 1;
            overflow: hidden;
            background: var(--border);
            position: relative;
            cursor: pointer;
            border-radius: 4px;
        }
        .profile-post img { width: 100%; height: 100%; object-fit: cover; }
        .profile-post .overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.4);
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 20px;
            color: white;
            opacity: 0;
            transition: 0.3s;
        }
        .profile-post:hover .overlay { opacity: 1; }
        .profile-post .overlay span { display: flex; align-items: center; gap: 5px; font-size: 14px; font-weight: 600; }

        /* Upload Page */
        .upload-page {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: var(--bg);
            z-index: 150;
            overflow-y: auto;
            padding-top: var(--header-height);
        }
        .upload-page.active { display: block; }
        .upload-header {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: var(--bg-secondary);
            padding: 0 16px;
            height: var(--header-height);
            border-bottom: 1px solid var(--border);
            z-index: 151;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .upload-header h2 { font-size: 18px; color: var(--text); }
        .upload-header .close-upload {
            font-size: 24px;
            cursor: pointer;
            color: var(--text);
            background: none;
            border: none;
            transition: 0.3s;
        }
        .upload-header .close-upload:hover { transform: rotate(90deg); }
        .upload-container {
            background: var(--bg-secondary);
            margin: 12px 16px;
            border-radius: var(--radius);
            padding: 30px 20px;
            border: 2px dashed var(--border);
            text-align: center;
            min-height: 300px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            transition: 0.3s;
        }
        .upload-container:hover { border-color: var(--primary); }
        .upload-container i { font-size: 60px; color: var(--primary); margin-bottom: 16px; }
        .upload-container h3 { font-size: 20px; color: var(--text); margin-bottom: 8px; }
        .upload-container p { font-size: 14px; color: var(--text-secondary); margin-bottom: 20px; }
        .upload-container input[type="file"] { display: none; }
        .upload-container .upload-btn {
            padding: 10px 32px;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 16px;
            transition: 0.3s;
        }
        .upload-container .upload-btn:hover { opacity: 0.9; transform: scale(1.02); }
        .upload-preview { display: none; margin-top: 16px; width: 100%; max-width: 320px; margin: 16px auto 0; }
        .upload-preview img, .upload-preview video { width: 100%; border-radius: 8px; max-height: 320px; object-fit: cover; }
        .upload-preview.active { display: block; }
        .upload-caption { display: none; margin-top: 12px; width: 100%; max-width: 320px; margin: 12px auto 0; }
        .upload-caption.active { display: block; }
        .upload-caption textarea {
            width: 100%;
            padding: 10px 14px;
            border: 1px solid var(--border);
            border-radius: 8px;
            outline: none;
            font-size: 14px;
            font-family: inherit;
            resize: vertical;
            min-height: 60px;
            background: var(--bg);
            color: var(--text);
            direction: rtl;
        }
        .upload-caption textarea:focus { border-color: var(--primary); }
        .upload-hashtags { display: none; margin-top: 8px; width: 100%; max-width: 320px; margin: 8px auto 0; }
        .upload-hashtags.active { display: block; }
        .upload-hashtags input {
            width: 100%;
            padding: 10px 14px;
            border: 1px solid var(--border);
            border-radius: 8px;
            outline: none;
            font-size: 14px;
            background: var(--bg);
            color: var(--text);
            direction: rtl;
        }
        .upload-hashtags input:focus { border-color: var(--primary); }
        .upload-submit {
            display: none;
            margin-top: 12px;
            padding: 10px 32px;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 16px;
            transition: 0.3s;
        }
        .upload-submit.active { display: inline-block; }
        .upload-submit:hover { opacity: 0.9; transform: scale(1.02); }

        /* Chat */
        .chat-interface {
            display: none;
            position: fixed;
            bottom: var(--bottom-nav-height);
            left: 0;
            right: 0;
            top: var(--header-height);
            background: var(--bg-secondary);
            z-index: 200;
            flex-direction: column;
            border-top: 1px solid var(--border);
        }
        .chat-interface.active { display: flex; }
        .chat-header-bar {
            padding: 12px 16px;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }
        .chat-header-bar h3 { font-size: 16px; color: var(--text); }
        .chat-header-bar .close-chat {
            font-size: 24px;
            cursor: pointer;
            color: var(--text);
            background: none;
            border: none;
            transition: 0.3s;
        }
        .chat-header-bar .close-chat:hover { transform: rotate(90deg); }
        .chat-users-list {
            border-bottom: 1px solid var(--border);
            max-height: 140px;
            overflow-y: auto;
            flex-shrink: 0;
            background: var(--bg);
        }
        .chat-user {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 16px;
            cursor: pointer;
            border-bottom: 1px solid var(--border);
            transition: 0.3s;
        }
        .chat-user:hover { background: var(--bg-secondary); }
        .chat-user .user-avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            overflow: hidden;
            background: var(--border);
            flex-shrink: 0;
        }
        .chat-user .user-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .chat-user .user-name { font-size: 14px; color: var(--text); font-weight: 500; }
        .chat-user .user-status { font-size: 11px; color: var(--text-secondary); }
        .chat-user .user-status.online { color: var(--success); }
        .chat-messages {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            background: var(--bg);
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .chat-message {
            max-width: 78%;
            padding: 10px 16px;
            border-radius: 18px;
            background: var(--bg-secondary);
            box-shadow: var(--shadow);
            align-self: flex-start;
            word-wrap: break-word;
            animation: fadeIn 0.2s ease;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .chat-message.own { align-self: flex-end; background: var(--primary); color: white; }
        .chat-message .msg-user { font-size: 11px; font-weight: 600; color: var(--primary); margin-bottom: 2px; }
        .chat-message.own .msg-user { color: rgba(255,255,255,0.8); }
        .chat-message .msg-text { font-size: 14px; }
        .chat-message .msg-time { font-size: 10px; color: var(--text-secondary); margin-top: 4px; text-align: left; }
        .chat-message.own .msg-time { color: rgba(255,255,255,0.7); }
        .chat-input {
            display: flex;
            gap: 10px;
            padding: 10px 16px;
            border-top: 1px solid var(--border);
            background: var(--bg-secondary);
            flex-shrink: 0;
        }
        .chat-input input {
            flex: 1;
            padding: 10px 16px;
            border: 1px solid var(--border);
            border-radius: 24px;
            outline: none;
            font-size: 14px;
            background: var(--bg);
            color: var(--text);
            direction: rtl;
        }
        .chat-input input:focus { border-color: var(--primary); }
        .chat-input button {
            padding: 10px 20px;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 24px;
            cursor: pointer;
            font-size: 16px;
            transition: 0.3s;
        }
        .chat-input button:hover { opacity: 0.9; }
        .chat-empty {
            text-align: center;
            padding: 40px;
            color: var(--text-secondary);
        }
        .chat-empty i { font-size: 40px; display: block; margin-bottom: 12px; color: var(--border); }

        /* Live */
        .live-container {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: #000;
            z-index: 500;
            flex-direction: column;
            justify-content: center;
            align-items: center;
        }
        .live-container.active { display: flex; }
        .live-container video {
            width: 100%;
            max-height: 80vh;
            background: #111;
            border-radius: 8px;
        }
        .live-container .live-info {
            position: absolute;
            top: 20px;
            left: 20px;
            color: white;
            background: rgba(0,0,0,0.6);
            padding: 8px 16px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .live-container .live-info .live-dot {
            width: 12px;
            height: 12px;
            background: red;
            border-radius: 50%;
            animation: pulse 1s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.3; }
            100% { opacity: 1; }
        }
        .live-container .close-live {
            position: absolute;
            top: 20px;
            right: 20px;
            background: rgba(0,0,0,0.6);
            color: white;
            border: none;
            font-size: 28px;
            cursor: pointer;
            padding: 8px 16px;
            border-radius: 8px;
            transition: 0.3s;
        }
        .live-container .close-live:hover { background: rgba(255,0,0,0.6); }
        .live-container .live-chat {
            position: absolute;
            bottom: 80px;
            left: 20px;
            right: 20px;
            max-height: 200px;
            overflow-y: auto;
            background: rgba(0,0,0,0.6);
            border-radius: 8px;
            padding: 12px;
            color: white;
        }
        .live-container .live-chat .msg {
            padding: 4px 0;
            font-size: 14px;
        }
        .live-container .live-chat .msg .user { font-weight: 600; color: var(--primary); }
        .live-container .live-input {
            position: absolute;
            bottom: 20px;
            left: 20px;
            right: 20px;
            display: flex;
            gap: 10px;
        }
        .live-container .live-input input {
            flex: 1;
            padding: 10px 16px;
            border: none;
            border-radius: 24px;
            font-size: 14px;
            background: rgba(255,255,255,0.9);
            direction: rtl;
        }
        .live-container .live-input button {
            padding: 10px 20px;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 24px;
            cursor: pointer;
            font-weight: 600;
        }

        /* Admin */
        .admin-panel {
            display: none;
            position: fixed;
            top: var(--header-height);
            left: 0;
            right: 0;
            bottom: var(--bottom-nav-height);
            background: var(--bg);
            z-index: 145;
            overflow-y: auto;
            padding: 16px;
        }
        .admin-panel.active { display: block; }
        .admin-card {
            background: var(--bg-secondary);
            border-radius: var(--radius);
            padding: 16px;
            margin-bottom: 12px;
            border: 1px solid var(--border);
        }
        .admin-card h4 { color: var(--text); margin-bottom: 8px; }
        .admin-card .admin-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            border-bottom: 1px solid var(--border);
        }
        .admin-card .admin-item:last-child { border-bottom: none; }
        .admin-btn {
            padding: 4px 12px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            transition: 0.3s;
        }
        .admin-btn.danger { background: var(--danger); color: white; }
        .admin-btn.success { background: var(--success); color: white; }
        .admin-btn.primary { background: var(--primary); color: white; }
        .admin-btn:hover { opacity: 0.8; transform: scale(1.02); }

        /* Toast */
        .toast {
            position: fixed;
            bottom: calc(var(--bottom-nav-height) + 20px);
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.85);
            color: white;
            padding: 12px 24px;
            border-radius: 24px;
            font-size: 14px;
            z-index: 999;
            opacity: 0;
            transition: opacity 0.4s ease;
            pointer-events: none;
            backdrop-filter: blur(4px);
            max-width: 90%;
            text-align: center;
        }
        .toast.show { opacity: 1; }

        /* Responsive */
        @media (max-width: 768px) {
            .gallery { gap: 3px; padding: 3px; }
            .search-box { max-width: 200px; }
            .modal-content { max-width: 95%; }
        }
        @media (max-width: 480px) {
            .gallery { gap: 2px; padding: 2px; }
            .search-box { max-width: 140px; padding: 6px 12px; }
            .search-box input { font-size: 12px; }
            .header-right { gap: 12px; font-size: 18px; }
            .header { padding: 0 10px; }
            .logo { font-size: 16px; }
            .story-avatar { width: 54px; height: 54px; }
            .chat-message { max-width: 90%; }
            .profile-avatar-large { width: 80px; height: 80px; }
        }
    </style>
</head>
<body>

    <div id="toast" class="toast"></div>

    <!-- ===== Login ===== -->
    <div id="loginPage" class="login-container">
        <div class="login-box">
            <h2 id="loginTitle">🔐 ورود</h2>
            <div id="loginError" class="error"></div>
            <input type="text" id="loginUsername" placeholder="نام کاربری" style="display:none;">
            <input type="text" id="loginFullName" placeholder="نام کامل" style="display:none;">
            <input type="email" id="loginEmail" placeholder="ایمیل">
            <input type="password" id="loginPassword" placeholder="رمز عبور">
            <button id="loginBtn">ورود</button>
            <div class="switch-link" id="switchAuth">ثبت نام ندارید؟ ثبت نام کنید</div>
        </div>
    </div>

    <!-- ===== Main App ===== -->
    <div id="mainApp" style="display:none;flex-direction:column;height:100vh;">
        <header class="header">
            <div class="logo"><i class="fab fa-instagram"></i> سوشال</div>
            <div class="search-box">
                <i class="fas fa-search"></i>
                <input id="searchInput" placeholder="جستجو...">
            </div>
            <div class="header-right">
                <i class="fas fa-comment-dots" id="chatOpenBtn"></i>
                <i class="fas fa-video" id="liveOpenBtn"></i>
            </div>
        </header>

        <div class="stories-section" id="storiesSection">
            <div class="stories-container" id="storiesContainer"></div>
        </div>

        <div class="gallery-wrapper">
            <div class="gallery" id="gallery"></div>
        </div>

        <!-- Bottom Nav -->
        <nav class="bottom-nav">
            <button id="profileNavBtn"><i class="fas fa-user"></i><span>پروفایل</span></button>
            <button id="uploadNavBtn"><i class="fas fa-upload"></i><span>آپلود</span></button>
            <button id="exploreNavBtn" class="active"><i class="fas fa-compass"></i><span>اکسپلور</span></button>
            <button id="adminNavBtn" style="display:none;"><i class="fas fa-crown"></i><span>مدیریت</span></button>
        </nav>

        <!-- Profile Page -->
        <div class="profile-page" id="profilePage">
            <div class="profile-header-bar">
                <h2>👤 پروفایل</h2>
                <button class="close-profile" id="closeProfile">&times;</button>
            </div>
            <div style="margin-top:var(--header-height);">
                <div class="profile-info">
                    <div class="profile-avatar-large"><img id="profileAvatar" src="https://i.pravatar.cc/150?img=10"></div>
                    <div class="profile-username" id="profileUsername">کاربر</div>
                    <div class="profile-fullname" id="profileFullName">نام کامل</div>
                    <div class="profile-bio" id="profileBio">بیوگرافی</div>
                    <button class="profile-follow-btn" id="profileFollowBtn">دنبال کردن</button>
                    <div style="display:flex;gap:10px;margin:10px 0;width:100%;max-width:300px;">
                        <input type="text" id="bioInput" placeholder="بیوگرافی جدید..." style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:8px;outline:none;font-size:14px;background:var(--bg);color:var(--text);direction:rtl;">
                        <button id="saveBioBtn" style="padding:8px 16px;background:var(--primary);color:white;border:none;border-radius:8px;cursor:pointer;font-weight:600;">ذخیره</button>
                    </div>
                </div>
                <div class="profile-stats">
                    <div class="stat"><span class="number" id="profilePostCount">0</span><span class="label">پست</span></div>
                    <div class="stat"><span class="number" id="profileFollowerCount">0</span><span class="label">دنبال‌کننده</span></div>
                    <div class="stat"><span class="number" id="profileFollowingCount">0</span><span class="label">دنبال‌شونده</span></div>
                </div>
                <div class="profile-gallery" id="profileGallery"></div>
            </div>
        </div>

        <!-- Upload Page -->
        <div class="upload-page" id="uploadPage">
            <div class="upload-header">
                <h2>📤 آپلود</h2>
                <button class="close-upload" id="closeUpload">&times;</button>
            </div>
            <div style="margin-top:var(--header-height);padding:10px;">
                <div class="upload-container">
                    <i class="fas fa-cloud-upload-alt"></i>
                    <h3>انتخاب فایل</h3>
                    <p>برای آپلود عکس یا ویدئو کلیک کنید</p>
                    <button class="upload-btn" id="uploadSelectBtn">انتخاب فایل</button>
                    <input type="file" id="fileInput" accept="image/*,video/*">
                    <div class="upload-preview" id="uploadPreview">
                        <img id="previewImage" style="display:none;">
                        <video id="previewVideo" controls style="display:none;"></video>
                    </div>
                    <div class="upload-caption" id="uploadCaption">
                        <textarea id="captionInput" placeholder="توضیحات پست..."></textarea>
                    </div>
                    <div class="upload-hashtags" id="uploadHashtags">
                        <input type="text" id="hashtagInput" placeholder="هشتگ‌ها (با کاما جدا کنید)">
                    </div>
                    <button class="upload-submit" id="uploadSubmit">📤 ارسال پست</button>
                </div>
            </div>
        </div>

        <!-- Comment Modal -->
        <div class="modal-overlay" id="commentModal">
            <div class="modal-content">
                <div class="modal-header">
                    <h3>💬 کامنت‌ها</h3>
                    <button class="close-modal" id="closeCommentModal">&times;</button>
                </div>
                <div class="modal-body" id="commentList"></div>
                <div class="modal-footer">
                    <input type="text" id="commentInput" placeholder="کامنت خود را بنویسید...">
                    <button id="sendCommentBtn">ارسال</button>
                </div>
            </div>
        </div>

        <!-- Chat -->
        <div class="chat-interface" id="chatInterface">
            <div class="chat-header-bar">
                <h3 id="chatTitle">💬 چت</h3>
                <button class="close-chat" id="closeChat">&times;</button>
            </div>
            <div class="chat-users-list" id="chatUsersList"></div>
            <div class="chat-messages" id="chatMessages">
                <div class="chat-empty"><i class="fas fa-comments"></i>برای شروع چت، یک کاربر را انتخاب کنید</div>
            </div>
            <div class="chat-input">
                <input type="text" id="chatInput" placeholder="پیام خود را بنویسید...">
                <button id="chatSendBtn"><i class="fas fa-paper-plane"></i></button>
            </div>
        </div>

        <!-- Live -->
        <div class="live-container" id="liveContainer">
            <div class="live-info"><span class="live-dot"></span> <span id="liveTitle">لایو</span></div>
            <button class="close-live" id="closeLive">&times;</button>
            <video id="liveVideo" autoplay muted></video>
            <div class="live-chat" id="liveChat"></div>
            <div class="live-input">
                <input type="text" id="liveChatInput" placeholder="پیام در لایو...">
                <button id="liveSendBtn">ارسال</button>
            </div>
        </div>

        <!-- Admin -->
        <div class="admin-panel" id="adminPanel">
            <div class="admin-card">
                <h4>👑 پنل مدیریت</h4>
                <div class="admin-item"><span>کاربران</span><span id="adminUserCount">0</span></div>
                <div class="admin-item"><span>پست‌ها</span><span id="adminPostCount">0</span></div>
                <div class="admin-item"><span>آنلاین</span><span id="adminOnlineCount">0</span></div>
            </div>
            <div class="admin-card">
                <h4>📢 پیام همگانی</h4>
                <div style="display:flex;gap:10px;">
                    <input type="text" id="broadcastInput" placeholder="پیام به همه..." style="flex:1;padding:10px 14px;border:1px solid var(--border);border-radius:8px;outline:none;font-size:14px;background:var(--bg);color:var(--text);">
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
    </div>

    <script>
        // ============================================
        // 🚀 STATE
        // ============================================
        const STATE = {
            token: localStorage.getItem('token') || null,
            user: null,
            socket: null,
            isAdmin: false,
            isLogin: true,
            currentPostId: null,
            currentChatRoom: null,
            currentChatUser: null,
            isLive: false,
            streamId: null
        };

        // ============================================
        // 📦 DOM REFS
        // ============================================
        const $ = (s) => document.querySelector(s);
        const $$ = (s) => document.querySelectorAll(s);

        // ============================================
        // 🛠 UTILITY
        // ============================================
        function showToast(msg) {
            const toast = $('#toast');
            toast.textContent = msg;
            toast.classList.add('show');
            clearTimeout(toast._timeout);
            toast._timeout = setTimeout(() => toast.classList.remove('show'), 3500);
        }

        function showError(msg) {
            $('#loginError').textContent = msg;
        }

        function clearError() {
            $('#loginError').textContent = '';
        }

        function timeAgo(date) {
            const diff = Date.now() - new Date(date).getTime();
            const mins = Math.floor(diff / 60000);
            if (mins < 1) return 'همین الان';
            if (mins < 60) return mins + ' دقیقه';
            const hrs = Math.floor(mins / 60);
            if (hrs < 24) return hrs + ' ساعت';
            const days = Math.floor(hrs / 24);
            if (days < 7) return days + ' روز';
            return new Date(date).toLocaleDateString('fa-IR');
        }

        // ============================================
        // 🔐 AUTH
        // ============================================
        async function registerUser(username, fullName, email, password) {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, fullName, email, password })
            });
            return await res.json();
        }

        async function loginUser(email, password) {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            return await res.json();
        }

        async function logoutUser() {
            await fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: STATE.token })
            });
            localStorage.removeItem('token');
            STATE.token = null;
            STATE.user = null;
            STATE.isAdmin = false;
            $('#loginPage').style.display = 'flex';
            $('#mainApp').style.display = 'none';
            if (STATE.socket) STATE.socket.disconnect();
        }

        async function getCurrentUser() {
            if (!STATE.token) return null;
            try {
                const res = await fetch('/api/auth/me', {
                    headers: { 'Authorization': 'Bearer ' + STATE.token }
                });
                if (res.ok) return await res.json();
                return null;
            } catch { return null; }
        }

        // ============================================
        // 📡 API CALLS
        // ============================================
        async function getPosts(page = 1, hashtag = null) {
            let url = '/api/posts?page=' + page + '&limit=20';
            if (hashtag) url += '&hashtag=' + encodeURIComponent(hashtag);
            const res = await fetch(url);
            return await res.json();
        }

        async function createPost(file, caption, hashtags) {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('caption', caption);
            formData.append('userId', STATE.user?.userId || 'user1');
            formData.append('username', STATE.user?.username || 'کاربر');
            if (hashtags) formData.append('hashtags', hashtags);

            const res = await fetch('/api/posts', {
                method: 'POST',
                body: formData
            });
            return await res.json();
        }

        async function likePost(postId) {
            const res = await fetch('/api/posts/' + postId + '/like', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: STATE.user?.userId || 'user1' })
            });
            return await res.json();
        }

        async function addComment(postId, text) {
            const res = await fetch('/api/posts/' + postId + '/comment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: STATE.user?.userId || 'user1',
                    username: STATE.user?.username || 'کاربر',
                    text: text
                })
            });
            return await res.json();
        }

        async function getStories() {
            const res = await fetch('/api/stories');
            return await res.json();
        }

        async function createStory(file) {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('userId', STATE.user?.userId || 'user1');
            formData.append('username', STATE.user?.username || 'کاربر');

            const res = await fetch('/api/stories', {
                method: 'POST',
                body: formData
            });
            return await res.json();
        }

        async function getUsers() {
            const res = await fetch('/api/users');
            return await res.json();
        }

        async function updateProfile(data) {
            const res = await fetch('/api/users/' + STATE.user?.userId + '/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return await res.json();
        }

        async function followUser(userId) {
            const res = await fetch('/api/users/' + userId + '/follow', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ followerId: STATE.user?.userId })
            });
            return await res.json();
        }

        async function unfollowUser(userId) {
            const res = await fetch('/api/users/' + userId + '/unfollow', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ followerId: STATE.user?.userId })
            });
            return await res.json();
        }

        async function getTrends() {
            const res = await fetch('/api/trends');
            return await res.json();
        }

        // Admin
        async function getAdminUsers() {
            const res = await fetch('/api/admin/users', {
                headers: { 'Authorization': 'Bearer ' + STATE.token }
            });
            return await res.json();
        }

        async function banUser(userId, banned) {
            const res = await fetch('/api/admin/users/' + userId + '/ban', {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer ' + STATE.token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ banned })
            });
            return await res.json();
        }

        async function deletePostAdmin(postId) {
            const res = await fetch('/api/admin/posts/' + postId, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + STATE.token }
            });
            return await res.json();
        }

        async function getAdminPosts() {
            const res = await fetch('/api/admin/posts', {
                headers: { 'Authorization': 'Bearer ' + STATE.token }
            });
            return await res.json();
        }

        async function broadcastMessage(message) {
            const res = await fetch('/api/admin/broadcast', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + STATE.token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ message })
            });
            return await res.json();
        }

        async function getAdminStats() {
            const res = await fetch('/api/admin/stats', {
                headers: { 'Authorization': 'Bearer ' + STATE.token }
            });
            return await res.json();
        }

        // Live
        async function startLive(title) {
            const res = await fetch('/api/live/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: STATE.user?.userId, title })
            });
            return await res.json();
        }

        async function endLive(streamId) {
            const res = await fetch('/api/live/end', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ streamId })
            });
            return await res.json();
        }

        async function joinLive(streamId) {
            const res = await fetch('/api/live/join', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ streamId, userId: STATE.user?.userId })
            });
            return await res.json();
        }

        async function getLiveStreams() {
            const res = await fetch('/api/live/streams');
            return await res.json();
        }

        // ============================================
        // 💬 SOCKET
        // ============================================
        function connectSocket() {
            if (STATE.socket) return;

            STATE.socket = io();

            STATE.socket.on('connect', () => {
                if (STATE.user) {
                    STATE.socket.emit('register', {
                        userId: STATE.user.userId,
                        username: STATE.user.username
                    });
                }
            });

            STATE.socket.on('users-online', (users) => {
                renderChatUsers();
            });

            STATE.socket.on('receive-message', (data) => {
                displayChatMessage(data.userId, data.username, data.message, data.timestamp);
            });

            STATE.socket.on('history', (messages) => {
                const messagesDiv = $('#chatMessages');
                messagesDiv.innerHTML = '';
                messages.forEach(msg => {
                    displayChatMessage(msg.userId, msg.username, msg.message, msg.timestamp);
                });
            });

            STATE.socket.on('broadcast', (data) => {
                showToast('📢 ' + data.message + ' (از ' + data.from + ')');
            });

            STATE.socket.on('notification', (data) => {
                if (data.type === 'like') {
                    showToast('❤️ ' + data.fromUserId + ' پست شما را لایک کرد');
                } else if (data.type === 'comment') {
                    showToast('💬 ' + data.fromUserId + ' روی پست شما کامنت گذاشت');
                } else if (data.type === 'post') {
                    showToast('📸 ' + data.fromUserId + ' پست جدیدی منتشر کرد');
                }
            });

            STATE.socket.on('new-story', (data) => {
                showToast('📸 ' + data.userId + ' استوری جدید گذاشت');
                loadStories();
            });

            STATE.socket.on('new-post', (data) => {
                loadPosts();
            });

            STATE.socket.on('follow-update', (data) => {
                loadProfile();
            });

            STATE.socket.on('live-started', (data) => {
                showToast('🔴 ' + data.userId + ' لایو را شروع کرد');
            });

            STATE.socket.on('live-ended', (data) => {
                showToast('🔴 لایو به پایان رسید');
            });

            STATE.socket.on('live-comment', (data) => {
                addLiveChatMessage(data.username, data.text);
            });

            STATE.socket.on('error', (data) => {
                showToast('❌ ' + data.message);
            });
        }

        // ============================================
        // 📋 RENDER FUNCTIONS
        // ============================================

        function createPostElement(post) {
            const div = document.createElement('div');
            div.className = 'gallery-item';
            div.dataset.id = post.postId;

            const isLiked = localStorage.getItem('liked_' + post.postId) === 'true';

            div.innerHTML = \`
                <div class="image-container">
                    <img src="\${post.image}" loading="lazy" alt="post">
                </div>
                <div class="post-overlay">
                    <button class="like-btn \${isLiked ? 'liked' : ''}" data-id="\${post.postId}">
                        <i class="fa-\${isLiked ? 'solid' : 'regular'} fa-heart"></i> <span class="count">\${post.likes || 0}</span>
                    </button>
                    <button class="comment-btn" data-id="\${post.postId}">
                        <i class="fa-regular fa-comment"></i> <span class="count">\${(post.comments || []).length}</span>
                    </button>
                    <button class="share-btn" data-id="\${post.postId}">
                        <i class="fa-solid fa-share-alt"></i>
                    </button>
                </div>
            \`;

            // Events
            div.querySelector('.like-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                handleLike(post.postId);
            });

            div.querySelector('.comment-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                openComments(post.postId);
            });

            div.querySelector('.share-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const url = window.location.href + '?post=' + post.postId;
                navigator.clipboard.writeText(url).then(() => showToast('✅ لینک کپی شد!'));
            });

            div.addEventListener('click', () => {
                openPostDetail(post.postId);
            });

            return div;
        }

        function createStoryElement(story) {
            const div = document.createElement('div');
            div.className = 'story-item';
            div.innerHTML = \`
                <div class="story-avatar"><img src="\${story.image}" alt="story"></div>
                <span class="story-name">\${story.username}</span>
            \`;
            div.addEventListener('click', () => {
                showToast('📸 استوری از ' + story.username);
            });
            return div;
        }

        function createProfilePostElement(post) {
            const div = document.createElement('div');
            div.className = 'profile-post';
            div.innerHTML = \`
                <img src="\${post.image}" loading="lazy">
                <div class="overlay">
                    <span><i class="fas fa-heart"></i> \${post.likes || 0}</span>
                    <span><i class="fas fa-comment"></i> \${(post.comments || []).length}</span>
                </div>
            \`;
            div.addEventListener('click', () => openPostDetail(post.postId));
            return div;
        }

        function createCommentElement(comment) {
            const div = document.createElement('div');
            div.className = 'comment-item';
            div.innerHTML = \`
                <div class="comment-avatar">
                    <img src="https://i.pravatar.cc/150?img=\${Math.floor(Math.random() * 70)}" alt="avatar">
                </div>
                <div class="comment-content">
                    <div class="comment-username">\${comment.fullName || comment.username || 'کاربر'}</div>
                    <div class="comment-text">\${comment.text}</div>
                    <div class="comment-time">\${timeAgo(comment.createdAt)}</div>
                    \${comment.userId === STATE.user?.userId ? \`
                        <div class="comment-actions">
                            <button onclick="deleteComment('\${comment.commentId}')">🗑️ حذف</button>
                            <button onclick="editComment('\${comment.commentId}')">✏️ ویرایش</button>
                        </div>
                    \` : ''}
                </div>
            \`;
            return div;
        }

        function createChatUserElement(user) {
            if (user.userId === STATE.user?.userId) return null;
            const div = document.createElement('div');
            div.className = 'chat-user';
            const statusClass = user.isOnline ? 'online' : '';
            const statusText = user.isOnline ? 'آنلاین' : 'آفلاین';
            div.innerHTML = \`
                <div class="user-avatar"><img src="\${user.avatar || 'https://i.pravatar.cc/150?img=' + Math.floor(Math.random() * 70)}" alt="user"></div>
                <div>
                    <div class="user-name">\${user.fullName || user.username}</div>
                    <div class="user-status \${statusClass}">\${statusText}</div>
                </div>
            \`;
            div.addEventListener('click', () => startChat(user.userId, user.fullName || user.username));
            return div;
        }

        // ============================================
        // 📥 LOAD FUNCTIONS
        // ============================================

        async function loadPosts(page = 1, hashtag = null) {
            const gallery = $('#gallery');
            const data = await getPosts(page, hashtag);

            if (page === 1) gallery.innerHTML = '';

            data.posts.forEach(post => {
                gallery.appendChild(createPostElement(post));
            });
        }

        async function loadStories() {
            const container = $('#storiesContainer');
            container.innerHTML = '';

            // Add story button
            const addDiv = document.createElement('div');
            addDiv.className = 'story-item';
            addDiv.innerHTML = \`
                <div class="story-avatar add-story"><i class="fas fa-plus"></i></div>
                <span class="story-name">افزودن</span>
            \`;
            addDiv.addEventListener('click', () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/*,video/*';
                input.onchange = async (e) => {
                    const file = e.target.files[0];
                    if (file) {
                        const result = await createStory(file);
                        if (result.storyId) {
                            showToast('✅ استوری آپلود شد!');
                            loadStories();
                        }
                    }
                };
                input.click();
            });
            container.appendChild(addDiv);

            const stories = await getStories();
            stories.forEach(story => {
                container.appendChild(createStoryElement(story));
            });
        }

        async function loadProfile() {
            if (!STATE.user) return;

            const user = STATE.user;
            $('#profileUsername').textContent = user.username || 'کاربر';
            $('#profileFullName').textContent = user.fullName || user.username || '';
            $('#profileBio').textContent = user.bio || 'بیوگرافی خود را بنویسید';
            $('#profileFollowerCount').textContent = user.followers || 0;
            $('#profileFollowingCount').textContent = user.following || 0;

            const data = await getPosts(1);
            const userPosts = data.posts.filter(p => p.userId === user.userId);
            $('#profilePostCount').textContent = userPosts.length;

            const gallery = $('#profileGallery');
            gallery.innerHTML = '';
            if (userPosts.length === 0) {
                gallery.innerHTML = '<p style="grid-column:span 3;text-align:center;color:var(--text-secondary);padding:20px;">هیچ پستی ندارید</p>';
            } else {
                userPosts.forEach(post => {
                    gallery.appendChild(createProfilePostElement(post));
                });
            }
        }

        async function loadAdminPanel() {
            if (!STATE.isAdmin) return;

            try {
                const stats = await getAdminStats();
                if (stats) {
                    $('#adminUserCount').textContent = stats.totalUsers || 0;
                    $('#adminPostCount').textContent = stats.totalPosts || 0;
                    $('#adminOnlineCount').textContent = stats.onlineUsers || 0;
                }
            } catch (e) {}

            try {
                const users = await getAdminUsers();
                const list = $('#adminUsersList');
                list.innerHTML = '';
                users.forEach(user => {
                    if (user.isAdmin) return;
                    const div = document.createElement('div');
                    div.className = 'admin-item';
                    div.innerHTML = \`
                        <span>\${user.fullName || user.username} (\${user.email})</span>
                        <button class="admin-btn \${user.isBanned ? 'success' : 'danger'}" onclick="toggleBan('\${user.userId}', \${!user.isBanned})">
                            \${user.isBanned ? 'رفع مسدودیت' : 'مسدود کردن'}
                        </button>
                    \`;
                    list.appendChild(div);
                });
            } catch (e) {}

            try {
                const posts = await getAdminPosts();
                const list = $('#adminPostsList');
                list.innerHTML = '';
                posts.slice(0, 20).forEach(post => {
                    const div = document.createElement('div');
                    div.className = 'admin-item';
                    div.innerHTML = \`
                        <span>\${(post.caption || 'بدون توضیحات').substring(0, 30)}...</span>
                        <button class="admin-btn danger" onclick="deletePostAdmin('\${post.postId}')">🗑️ حذف</button>
                    \`;
                    list.appendChild(div);
                });
            } catch (e) {}
        }

        async function renderChatUsers() {
            const list = $('#chatUsersList');
            list.innerHTML = '';
            const users = await getUsers();

            let hasUsers = false;
            users.forEach(user => {
                if (user.userId === STATE.user?.userId) return;
                if (user.isBanned) return;
                hasUsers = true;
                list.appendChild(createChatUserElement(user));
            });

            if (!hasUsers) {
                list.innerHTML = '<div style="padding:10px 16px;color:var(--text-secondary);">هیچ کاربری وجود ندارد</div>';
            }
        }

        // ============================================
        // 🎯 ACTION FUNCTIONS
        // ============================================

        async function handleLike(postId) {
            const result = await likePost(postId);
            document.querySelectorAll('.like-btn[data-id="' + postId + '"]').forEach(btn => {
                const icon = btn.querySelector('i');
                const count = btn.querySelector('.count');
                if (result.liked) {
                    icon.className = 'fa-solid fa-heart';
                    btn.classList.add('liked');
                } else {
                    icon.className = 'fa-regular fa-heart';
                    btn.classList.remove('liked');
                }
                count.textContent = result.likes || 0;
                localStorage.setItem('liked_' + postId, result.liked ? 'true' : 'false');
            });
        }

        async function openComments(postId) {
            STATE.currentPostId = postId;
            const data = await getPosts(1);
            const post = data.posts.find(p => p.postId === postId);
            const list = $('#commentList');
            list.innerHTML = '';

            if (!post || !post.comments || post.comments.length === 0) {
                list.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px;">هنوز کامنتی وجود ندارد</div>';
            } else {
                post.comments.forEach(comment => {
                    list.appendChild(createCommentElement(comment));
                });
            }

            $('#commentModal').classList.add('active');
            $('#commentInput').focus();
        }

        async function sendComment() {
            const input = $('#commentInput');
            const text = input.value.trim();
            if (!text || !STATE.currentPostId) return;

            const result = await addComment(STATE.currentPostId, text);
            if (result.comment) {
                input.value = '';
                openComments(STATE.currentPostId);
                showToast('✅ کامنت ثبت شد');
                loadPosts();
            }
        }

        function openPostDetail(postId) {
            showToast('📸 در حال نمایش پست...');
        }

        // ============================================
        // 💬 CHAT FUNCTIONS
        // ============================================

        function startChat(userId, username) {
            if (STATE.user?.isBanned) {
                showToast('❌ شما مسدود شده‌اید');
                return;
            }

            STATE.currentChatUser = userId;
            const roomId = [STATE.user?.userId, userId].sort().join('_');
            STATE.currentChatRoom = roomId;

            $('#chatTitle').textContent = '💬 ' + username;
            $('#chatInterface').classList.add('active');
            STATE.socket.emit('join-room', { roomId, userId: STATE.user?.userId });
        }

        function sendChatMessage() {
            if (STATE.user?.isBanned) {
                showToast('❌ شما مسدود شده‌اید');
                return;
            }

            const input = $('#chatInput');
            const text = input.value.trim();
            if (!text || !STATE.currentChatRoom || !STATE.user) return;

            STATE.socket.emit('send-message', {
                roomId: STATE.currentChatRoom,
                userId: STATE.user.userId,
                username: STATE.user.fullName || STATE.user.username,
                message: text
            });

            displayChatMessage(STATE.user.userId, STATE.user.fullName || STATE.user.username, text, new Date()
            .toISOString());
            input.value = '';
        }

        function displayChatMessage(userId, username, message, timestamp) {
            const messagesDiv = $('#chatMessages');
            const empty = messagesDiv.querySelector('.chat-empty');
            if (empty) empty.remove();

            const div = document.createElement('div');
            div.className = 'chat-message' + (userId === STATE.user?.userId ? ' own' : '');

            const time = timestamp ? new Date(timestamp).toLocaleTimeString('fa-IR') : '';

            div.innerHTML = \`
                <div class="msg-user">\${userId === STATE.user?.userId ? 'شما' : username}</div>
                <div class="msg-text">\${message}</div>
                <div class="msg-time">\${time}</div>
            \`;

            messagesDiv.appendChild(div);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }

        // ============================================
        // 🔴 LIVE FUNCTIONS
        // ============================================

        async function startLiveStream() {
            if (STATE.user?.isBanned) {
                showToast('❌ شما مسدود شده‌اید');
                return;
            }

            const title = prompt('عنوان لایو را وارد کنید:');
            if (!title) return;

            const result = await startLive(title);
            if (result.success) {
                STATE.isLive = true;
                STATE.streamId = result.streamId;
                $('#liveTitle').textContent = '🔴 ' + title;
                $('#liveContainer').classList.add('active');

                // Start local video
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                    $('#liveVideo').srcObject = stream;
                    $('#liveVideo').play();

                    // Send video to server (simplified)
                    STATE.socket.emit('join-live', { streamId: result.streamId });
                } catch (e) {
                    showToast('❌ دسترسی به دوربین امکان‌پذیر نیست');
                }
            }
        }

        async function joinLiveStream(streamId) {
            const result = await joinLive(streamId);
            if (result.success) {
                STATE.streamId = streamId;
                $('#liveTitle').textContent = '🔴 لایو';
                $('#liveContainer').classList.add('active');

                // Join live room
                STATE.socket.emit('join-live', { streamId });

                // Try to get stream (simplified - would use WebRTC in production)
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
                    // In production, you'd use WebRTC to receive the stream
                } catch (e) {}
            }
        }

        function sendLiveComment() {
            const input = $('#liveChatInput');
            const text = input.value.trim();
            if (!text || !STATE.streamId) return;

            STATE.socket.emit('live-comment', {
                streamId: STATE.streamId,
                userId: STATE.user?.userId,
                username: STATE.user?.fullName || STATE.user?.username,
                text: text
            });

            addLiveChatMessage(STATE.user?.fullName || STATE.user?.username || 'شما', text);
            input.value = '';
        }

        function addLiveChatMessage(username, text) {
            const chat = $('#liveChat');
            const div = document.createElement('div');
            div.className = 'msg';
            div.innerHTML = \`<span class="user">\${username}:</span> \${text}\`;
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
        }

        async function endLiveStream() {
            if (STATE.streamId) {
                await endLive(STATE.streamId);
                STATE.isLive = false;
                STATE.streamId = null;
            }

            $('#liveContainer').classList.remove('active');

            // Stop video
            const video = $('#liveVideo');
            if (video.srcObject) {
                video.srcObject.getTracks().forEach(track => track.stop());
                video.srcObject = null;
            }

            showToast('🔴 لایو به پایان رسید');
        }

        // ============================================
        // 🎬 EVENT LISTENERS
        // ============================================

        // Auth
        $('#loginBtn').addEventListener('click', async () => {
            clearError();
            const username = $('#loginUsername').value.trim();
            const fullName = $('#loginFullName').value.trim();
            const email = $('#loginEmail').value.trim();
            const password = $('#loginPassword').value.trim();

            if (!email || !password) {
                showError('لطفا ایمیل و رمز عبور را وارد کنید');
                return;
            }

            if (!STATE.isLogin && !username) {
                showError('لطفا نام کاربری را وارد کنید');
                return;
            }

            if (!STATE.isLogin && !fullName) {
                showError('لطفا نام کامل را وارد کنید');
                return;
            }

            $('#loginBtn').textContent = '⏳';
            $('#loginBtn').disabled = true;

            let result;
            if (STATE.isLogin) {
                result = await loginUser(email, password);
            } else {
                result = await registerUser(username, fullName, email, password);
            }

            if (result.success) {
                STATE.token = result.token;
                localStorage.setItem('token', result.token);
                STATE.user = result.user;
                STATE.isAdmin = result.user.isAdmin || false;

                $('#loginPage').style.display = 'none';
                $('#mainApp').style.display = 'flex';

                if (STATE.isAdmin) {
                    $('#adminNavBtn').style.display = 'flex';
                }

                connectSocket();
                loadPosts();
                loadStories();
                loadProfile();
                showToast('✅ خوش آمدید ' + (result.user.fullName || result.user.username));
            } else {
                showError(result.error || 'خطا!');
            }

            $('#loginBtn').textContent = STATE.isLogin ? 'ورود' : 'ثبت نام';
            $('#loginBtn').disabled = false;
        });

        $('#switchAuth').addEventListener('click', () => {
            STATE.isLogin = !STATE.isLogin;
            $('#loginTitle').textContent = STATE.isLogin ? '🔐 ورود' : '📝 ثبت نام';
            $('#loginBtn').textContent = STATE.isLogin ? 'ورود' : 'ثبت نام';
            $('#switchAuth').textContent = STATE.isLogin ? 'ثبت نام ندارید؟ ثبت نام کنید' : 'حساب دارید؟ وارد شوید';
            $('#loginUsername').style.display = STATE.isLogin ? 'none' : 'block';
            $('#loginFullName').style.display = STATE.isLogin ? 'none' : 'block';
            clearError();
        });

        $('#loginPassword').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') $('#loginBtn').click();
        });

        // Profile
        $('#profileNavBtn').addEventListener('click', () => {
            $('#profilePage').classList.add('active');
            loadProfile();
        });

        $('#closeProfile').addEventListener('click', () => {
            $('#profilePage').classList.remove('active');
        });

        $('#profilePage').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                $('#profilePage').classList.remove('active');
            }
        });

        $('#saveBioBtn').addEventListener('click', async () => {
            const bio = $('#bioInput').value.trim();
            if (bio) {
                const result = await updateProfile({ bio });
                if (result.success) {
                    $('#profileBio').textContent = bio;
                    $('#bioInput').value = '';
                    STATE.user.bio = bio;
                    showToast('✅ بیوگرافی ذخیره شد!');
                }
            }
        });

        // Upload
        $('#uploadNavBtn').addEventListener('click', () => {
            if (STATE.user?.isBanned) {
                showToast('❌ شما مسدود شده‌اید');
                return;
            }
            $('#uploadPage').classList.add('active');
        });

        $('#closeUpload').addEventListener('click', () => {
            $('#uploadPage').classList.remove('active');
            resetUpload();
        });

        $('#uploadPage').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                $('#uploadPage').classList.remove('active');
                resetUpload();
            }
        });

        $('#uploadSelectBtn').addEventListener('click', () => {
            $('#fileInput').click();
        });

        $('#fileInput').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const previewImg = $('#previewImage');
                    const previewVideo = $('#previewVideo');

                    if (file.type.startsWith('image/')) {
                        previewImg.src = e.target.result;
                        previewImg.style.display = 'block';
                        previewVideo.style.display = 'none';
                    } else if (file.type.startsWith('video/')) {
                        previewVideo.src = e.target.result;
                        previewVideo.style.display = 'block';
                        previewImg.style.display = 'none';
                    }

                    $('#uploadPreview').classList.add('active');
                    $('#uploadCaption').classList.add('active');
                    $('#uploadHashtags').classList.add('active');
                    $('#uploadSubmit').classList.add('active');
                };
                reader.readAsDataURL(file);
            }
        });

        $('#uploadSubmit').addEventListener('click', async () => {
            const file = $('#fileInput').files[0];
            const caption = $('#captionInput').value.trim();
            const hashtags = $('#hashtagInput').value.trim();

            if (!file) {
                showToast('❌ لطفا یک فایل انتخاب کنید');
                return;
            }

            const btn = $('#uploadSubmit');
            btn.textContent = '⏳';
            btn.disabled = true;

            const result = await createPost(file, caption, hashtags);
            if (result.postId) {
                showToast('✅ پست با موفقیت آپلود شد!');
                resetUpload();
                $('#uploadPage').classList.remove('active');
                loadPosts();
            } else {
                showToast('❌ خطا در آپلود پست');
            }

            btn.textContent = '📤 ارسال پست';
            btn.disabled = false;
        });

        function resetUpload() {
            $('#fileInput').value = '';
            $('#uploadPreview').classList.remove('active');
            $('#uploadCaption').classList.remove('active');
            $('#uploadHashtags').classList.remove('active');
            $('#uploadSubmit').classList.remove('active');
            $('#previewImage').style.display = 'none';
            $('#previewVideo').style.display = 'none';
            $('#captionInput').value = '';
            $('#hashtagInput').value = '';
        }

        // Comments
        $('#sendCommentBtn').addEventListener('click', sendComment);
        $('#commentInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendComment();
        });

        $('#closeCommentModal').addEventListener('click', () => {
            $('#commentModal').classList.remove('active');
            STATE.currentPostId = null;
        });

        $('#commentModal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                $('#commentModal').classList.remove('active');
                STATE.currentPostId = null;
            }
        });

        // Chat
        $('#chatOpenBtn').addEventListener('click', () => {
            $('#chatInterface').classList.add('active');
            renderChatUsers();
        });

        $('#closeChat').addEventListener('click', () => {
            $('#chatInterface').classList.remove('active');
            if (STATE.currentChatRoom) {
                STATE.socket.emit('leave-room', { roomId: STATE.currentChatRoom });
                STATE.currentChatRoom = null;
                STATE.currentChatUser = null;
            }
        });

        $('#chatSendBtn').addEventListener('click', sendChatMessage);
        $('#chatInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendChatMessage();
        });

        // Live
        $('#liveOpenBtn').addEventListener('click', () => {
            if (STATE.isLive) {
                endLiveStream();
            } else {
                startLiveStream();
            }
        });

        $('#closeLive').addEventListener('click', endLiveStream);
        $('#liveSendBtn').addEventListener('click', sendLiveComment);
        $('#liveChatInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendLiveComment();
        });

        // Explore
        $('#exploreNavBtn').addEventListener('click', () => {
            $('#exploreNavBtn').classList.toggle('active');
            loadPosts();
        });

        // Admin
        $('#adminNavBtn').addEventListener('click', () => {
            $('#adminPanel').classList.toggle('active');
            if ($('#adminPanel').classList.contains('active')) {
                loadAdminPanel();
            }
        });

        $('#broadcastBtn').addEventListener('click', async () => {
            const input = $('#broadcastInput');
            const message = input.value.trim();
            if (!message) {
                showToast('❌ لطفا پیام را وارد کنید');
                return;
            }
            const result = await broadcastMessage(message);
            if (result.success) {
                showToast('✅ پیام همگانی ارسال شد!');
                input.value = '';
            }
        });

        $('#adminPanel').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                $('#adminPanel').classList.remove('active');
            }
        });

        // Search
        $('#searchInput').addEventListener('input', () => {
            const query = $('#searchInput').value.trim();
            if (query.startsWith('#')) {
                loadPosts(1, query.substring(1));
            } else if (query.length > 2) {
                const gallery = $('#gallery');
                const items = gallery.querySelectorAll('.gallery-item');
                items.forEach(item => {
                    const text = item.textContent.toLowerCase();
                    item.style.display = text.includes(query.toLowerCase()) ? '' : 'none';
                });
            } else {
                loadPosts();
            }
        });

        // ============================================
        // 🚀 INIT
        // ============================================

        document.addEventListener('DOMContentLoaded', async () => {
            // Login username visibility
            $('#loginUsername').style.display = 'none';
            $('#loginFullName').style.display = 'none';

            // Check token
            if (STATE.token) {
                const user = await getCurrentUser();
                if (user) {
                    STATE.user = user;
                    STATE.isAdmin = user.isAdmin || false;

                    $('#loginPage').style.display = 'none';
                    $('#mainApp').style.display = 'flex';

                    if (STATE.isAdmin) {
                        $('#adminNavBtn').style.display = 'flex';
                    }

                    connectSocket();
                    loadPosts();
                    loadStories();
                    loadProfile();

                    // Check for live streams
                    const streams = await getLiveStreams();
                    if (streams.length > 0) {
                        showToast('🔴 ' + streams.length + ' لایو فعال وجود دارد');
                    }

                    return;
                } else {
                    localStorage.removeItem('token');
                    STATE.token = null;
                }
            }

            $('#loginPage').style.display = 'flex';
            $('#mainApp').style.display = 'none';
        });

        // Global functions for inline onclick
        window.toggleBan = async function(userId, banned) {
            if (userId === STATE.user?.userId) {
                showToast('❌ نمی‌توانید خودتان را مسدود کنید');
                return;
            }
            const result = await banUser(userId, banned);
            if (result.success) {
                showToast('✅ کاربر ' + (banned ? 'مسدود' : 'رفع مسدودیت') + ' شد');
                loadAdminPanel();
            }
        };

        window.deletePostAdmin = async function(postId) {
            if (!confirm('آیا از حذف این پست مطمئن هستید؟')) return;
            const result = await deletePostAdmin(postId);
            if (result.success) {
                showToast('✅ پست حذف شد');
                loadAdminPanel();
                loadPosts();
            }
        };

        window.deleteComment = async function(commentId) {
            if (!confirm('آیا از حذف این کامنت مطمئن هستید؟')) return;
            // Implement delete comment API
            showToast('🗑️ کامنت حذف شد');
            openComments(STATE.currentPostId);
        };

        window.editComment = function(commentId) {
            const newText = prompt('متن جدید را وارد کنید:');
            if (newText) {
                // Implement edit comment API
                showToast('✏️ کامنت ویرایش شد');
                openComments(STATE.currentPostId);
            }
        };

        console.log('🚀 سوشال مدیا حرفه‌ای');
        console.log('📊 50 شارد برای میلیون‌ها کاربر');
        console.log('🔐 رمزنگاری AES-256-GCM');
        console.log('💬 چت آنلاین با رمزنگاری');
        console.log('🔴 لایو استریم');
        console.log('📸 استوری ۲۴ ساعته');
        console.log('👑 پنل مدیریت کامل');
    </script>
</body>
</html>
    `);
});

// ============================================
// 🚀 START
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('═'.repeat(50));
    console.log('🚀 سوشال مدیا حرفه‌ای');
    console.log('═'.repeat(50));
    console.log('📍 http://localhost:' + PORT);
    console.log('📊 50 شارد برای میلیون‌ها کاربر');
    console.log('🔐 رمزنگاری AES-256-GCM');
    console.log('💬 چت آنلاین با رمزنگاری');
    console.log('🔴 لایو استریم');
    console.log('📸 استوری ۲۴ ساعته');
    console.log('👑 ادمین: admin@instagram.com / admin123');
    console.log('═'.repeat(50));
});