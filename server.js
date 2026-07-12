const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 2e9
});

// ============================================================
// 🛡️ Middleware
// ============================================================

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10gb' }));
app.use(express.urlencoded({ extended: true, limit: '10gb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ============================================================
// 📁 ایجاد پوشه‌ها
// ============================================================

const dirs = [
    './uploads', './uploads/posts', './uploads/stories', './uploads/avatars',
    './uploads/videos', './uploads/thumbnails', './uploads/audios',
    './public', './logs', './backup', './temp', './cache'
];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ============================================================
// 📊 سیستم لاگینگ
// ============================================================

function log(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${type}] ${message}\n`;
    try { fs.appendFileSync('./logs/app.log', logEntry); } catch (e) {}
    console.log(logEntry.trim());
}

// ============================================================
// 🔐 رمزنگاری
// ============================================================

const SECRET_KEY = crypto.randomBytes(64).toString('hex');
const MASTER_KEY = crypto.createHash('sha512').update(SECRET_KEY + 'ENTERPRISE_2026').digest();

function hashPassword(password) {
    return crypto.createHash('sha512').update(password + SECRET_KEY + MASTER_KEY.toString('hex')).digest('hex');
}

function generateToken() {
    return crypto.randomBytes(128).toString('hex');
}

function generateUserKey(userId) {
    return crypto.createHash('sha512').update(MASTER_KEY + userId + SECRET_KEY).digest();
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

// ============================================================
// 👑 ادمین
// ============================================================

const ADMIN_EMAIL = 'milad.yari1377m@gmail.com';
const ADMIN_PASSWORD_HASH = hashPassword('M09145978426M@@$$##');

function isAdminUser(user) {
    return user && user.isAdmin === true;
}

function isAdminToken(token) {
    const userId = userSessions.get(token);
    if (!userId) return false;
    const user = db.getUser(userId);
    return isAdminUser(user);
}

// ============================================================
// 🗄️ پایگاه داده
// ============================================================

class MegaDatabase {
    constructor() {
        this.shardCount = 256;
        this.shards = {};
        this.indexes = {
            users_by_email: new Map(),
            users_by_username: new Map(),
            posts_by_hashtag: new Map(),
            posts_by_user: new Map()
        };
        
        for (let i = 0; i < this.shardCount; i++) {
            this.shards[i] = {
                users: new Map(),
                posts: [],
                stories: [],
                messages: new Map(),
                likes: new Map(),
                comments: new Map(),
                followers: new Map(),
                following: new Map(),
                bookmarks: new Map(),
                hashtags: new Map(),
                notifications: [],
                analytics: [],
                reports: []
            };
        }
        log('🚀 Database initialized with ' + this.shardCount + ' shards');
    }

    getShard(key) {
        const hash = crypto.createHash('sha256').update(key).digest('hex');
        return parseInt(hash.substring(0, 8), 16) % this.shardCount;
    }

    getShardById(id) {
        return id ? this.getShard(id) : 0;
    }

    saveUser(user) {
        const shardIndex = this.getShard(user.userId);
        this.shards[shardIndex].users.set(user.userId, user);
        this.indexes.users_by_email.set(user.email, user.userId);
        this.indexes.users_by_username.set(user.username, user.userId);
        return user;
    }

    getUser(userId) {
        const shardIndex = this.getShardById(userId);
        return this.shards[shardIndex].users.get(userId) || null;
    }

    getUserByEmail(email) {
        const userId = this.indexes.users_by_email.get(email);
        return userId ? this.getUser(userId) : null;
    }

    getUserByUsername(username) {
        const userId = this.indexes.users_by_username.get(username);
        return userId ? this.getUser(userId) : null;
    }

    getAllUsers() {
        let allUsers = [];
        for (let i = 0; i < this.shardCount; i++) {
            allUsers = allUsers.concat(Array.from(this.shards[i].users.values()));
        }
        return allUsers;
    }

    updateUser(userId, data) {
        const user = this.getUser(userId);
        if (user) {
            const updated = { ...user, ...data };
            const shardIndex = this.getShardById(userId);
            this.shards[shardIndex].users.set(userId, updated);
            return updated;
        }
        return null;
    }

    searchUsers(query) {
        const results = [];
        const q = query.toLowerCase();
        const allUsers = this.getAllUsers();
        for (const user of allUsers) {
            if (user.username.toLowerCase().includes(q) || 
                user.email.toLowerCase().includes(q) ||
                (user.fullName && user.fullName.toLowerCase().includes(q))) {
                results.push(user);
            }
        }
        return results;
    }

    followUser(userId, targetId) {
        const userShard = this.getShardById(userId);
        const targetShard = this.getShardById(targetId);
        
        if (!this.shards[userShard].users.has(userId) || !this.shards[targetShard].users.has(targetId)) {
            return false;
        }
        
        if (!this.shards[userShard].following.has(userId)) {
            this.shards[userShard].following.set(userId, new Set());
        }
        if (!this.shards[targetShard].followers.has(targetId)) {
            this.shards[targetShard].followers.set(targetId, new Set());
        }
        
        const following = this.shards[userShard].following.get(userId);
        if (following.has(targetId)) return false;
        
        following.add(targetId);
        this.shards[targetShard].followers.get(targetId).add(userId);
        
        const user = this.shards[userShard].users.get(userId);
        const target = this.shards[targetShard].users.get(targetId);
        user.following = (user.following || 0) + 1;
        target.followers = (target.followers || 0) + 1;
        
        return true;
    }

    unfollowUser(userId, targetId) {
        const userShard = this.getShardById(userId);
        const targetShard = this.getShardById(targetId);
        
        if (!this.shards[userShard].following.has(userId)) return false;
        
        const following = this.shards[userShard].following.get(userId);
        if (!following.has(targetId)) return false;
        
        following.delete(targetId);
        this.shards[targetShard].followers.get(targetId).delete(userId);
        
        const user = this.shards[userShard].users.get(userId);
        const target = this.shards[targetShard].users.get(targetId);
        user.following = (user.following || 0) - 1;
        target.followers = (target.followers || 0) - 1;
        
        return true;
    }

    getFollowers(userId) {
        const shardIndex = this.getShardById(userId);
        if (!this.shards[shardIndex].followers.has(userId)) return [];
        const followers = this.shards[shardIndex].followers.get(userId);
        const result = [];
        for (const id of followers) {
            const user = this.getUser(id);
            if (user) result.push(user);
        }
        return result;
    }

    getFollowing(userId) {
        const shardIndex = this.getShardById(userId);
        if (!this.shards[shardIndex].following.has(userId)) return [];
        const following = this.shards[shardIndex].following.get(userId);
        const result = [];
        for (const id of following) {
            const user = this.getUser(id);
            if (user) result.push(user);
        }
        return result;
    }

    savePost(post) {
        const shardIndex = this.getShard(post.postId);
        this.shards[shardIndex].posts.unshift(post);
        
        if (post.hashtags && post.hashtags.length > 0) {
            for (const tag of post.hashtags) {
                const tagKey = tag.toLowerCase();
                if (!this.shards[shardIndex].hashtags.has(tagKey)) {
                    this.shards[shardIndex].hashtags.set(tagKey, new Set());
                }
                this.shards[shardIndex].hashtags.get(tagKey).add(post.postId);
                
                if (!this.indexes.posts_by_hashtag.has(tagKey)) {
                    this.indexes.posts_by_hashtag.set(tagKey, new Set());
                }
                this.indexes.posts_by_hashtag.get(tagKey).add(post.postId);
            }
        }
        
        if (!this.indexes.posts_by_user.has(post.userId)) {
            this.indexes.posts_by_user.set(post.userId, []);
        }
        this.indexes.posts_by_user.get(post.userId).push(post.postId);
        
        return post;
    }

    getPosts(page = 1, limit = 20, hashtag = null, userId = null) {
        let allPosts = [];
        for (let i = 0; i < this.shardCount; i++) {
            allPosts = allPosts.concat(this.shards[i].posts);
        }
        
        if (hashtag) {
            const tagKey = hashtag.toLowerCase();
            const postIds = this.indexes.posts_by_hashtag.get(tagKey) || new Set();
            allPosts = allPosts.filter(p => postIds.has(p.postId));
        }
        
        if (userId) {
            const postIds = this.indexes.posts_by_user.get(userId) || [];
            allPosts = allPosts.filter(p => postIds.includes(p.postId));
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

    deletePost(postId, userId = null) {
        const shardIndex = this.getShardById(postId);
        const index = this.shards[shardIndex].posts.findIndex(p => p.postId === postId);
        if (index !== -1) {
            const post = this.shards[shardIndex].posts[index];
            if (userId && post.userId !== userId) return false;
            
            if (post.hashtags) {
                for (const tag of post.hashtags) {
                    const tagKey = tag.toLowerCase();
                    if (this.shards[shardIndex].hashtags.has(tagKey)) {
                        this.shards[shardIndex].hashtags.get(tagKey).delete(postId);
                    }
                    if (this.indexes.posts_by_hashtag.has(tagKey)) {
                        this.indexes.posts_by_hashtag.get(tagKey).delete(postId);
                    }
                }
            }
            
            if (this.indexes.posts_by_user.has(post.userId)) {
                const idx = this.indexes.posts_by_user.get(post.userId).indexOf(postId);
                if (idx !== -1) this.indexes.posts_by_user.get(post.userId).splice(idx, 1);
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
        
        const likeKey = postId + '_' + userId;
        if (this.shards[shardIndex].likes.has(likeKey)) {
            this.shards[shardIndex].likes.delete(likeKey);
            post.likes = (post.likes || 0) - 1;
            return { liked: false, likes: post.likes };
        } else {
            this.shards[shardIndex].likes.set(likeKey, true);
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

    getComments(postId) {
        const shardIndex = this.getShardById(postId);
        const post = this.shards[shardIndex].posts.find(p => p.postId === postId);
        if (!post) return [];
        return post.comments || [];
    }

    bookmarkPost(postId, userId) {
        const shardIndex = this.getShardById(userId);
        if (!this.shards[shardIndex].bookmarks.has(userId)) {
            this.shards[shardIndex].bookmarks.set(userId, new Set());
        }
        const bookmarks = this.shards[shardIndex].bookmarks.get(userId);
        if (bookmarks.has(postId)) {
            bookmarks.delete(postId);
            return { bookmarked: false };
        } else {
            bookmarks.add(postId);
            return { bookmarked: true };
        }
    }

    getBookmarks(userId) {
        const shardIndex = this.getShardById(userId);
        if (!this.shards[shardIndex].bookmarks.has(userId)) return [];
        const bookmarks = this.shards[shardIndex].bookmarks.get(userId);
        const result = [];
        for (const id of bookmarks) {
            const post = this.getPost(id);
            if (post) result.push(post);
        }
        return result;
    }

    incrementView(postId) {
        const shardIndex = this.getShardById(postId);
        const post = this.shards[shardIndex].posts.find(p => p.postId === postId);
        if (post) {
            post.views = (post.views || 0) + 1;
            return true;
        }
        return false;
    }

    saveStory(story) {
        const shardIndex = this.getShard(story.storyId);
        this.shards[shardIndex].stories.push(story);
        return story;
    }

    getStories() {
        let allStories = [];
        const now = Date.now();
        for (let i = 0; i < this.shardCount; i++) {
            allStories = allStories.concat(
                this.shards[i].stories.filter(s => {
                    const age = now - new Date(s.createdAt).getTime();
                    return age < 24 * 60 * 60 * 1000;
                })
            );
        }
        return allStories.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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

    saveMessage(roomId, message) {
        const shardIndex = this.getShardById(roomId);
        if (!this.shards[shardIndex].messages.has(roomId)) {
            this.shards[shardIndex].messages.set(roomId, []);
        }
        this.shards[shardIndex].messages.get(roomId).push(message);
        return message;
    }

    getMessages(roomId, limit = 50) {
        const shardIndex = this.getShardById(roomId);
        if (!this.shards[shardIndex].messages.has(roomId)) return [];
        const messages = this.shards[shardIndex].messages.get(roomId);
        return messages.slice(-limit);
    }

    getStats() {
        let totalUsers = 0, totalPosts = 0, totalStories = 0;
        let totalMessages = 0, totalLikes = 0, totalComments = 0;

        for (let i = 0; i < this.shardCount; i++) {
            totalUsers += this.shards[i].users.size;
            totalPosts += this.shards[i].posts.length;
            totalStories += this.shards[i].stories.length;
            totalLikes += this.shards[i].likes.size;
            for (const post of this.shards[i].posts) {
                totalComments += (post.comments || []).length;
            }
            for (const room of this.shards[i].messages.values()) {
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

const db = new MegaDatabase();
const onlineUsers = {};
const userSessions = new Map();

// ============================================================
// 📡 API
// ============================================================

// ===== Auth =====
app.post('/api/auth/register', (req, res) => {
    try {
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

        if (password.length < 8) {
            return res.status(400).json({ error: 'رمز عبور باید حداقل 8 کاراکتر باشد' });
        }

        const userId = 'user_' + uuidv4();
        const isAdmin = email === ADMIN_EMAIL && hashPassword(password) === ADMIN_PASSWORD_HASH;

        const user = {
            userId,
            username,
            email,
            fullName: fullName || username,
            password: hashPassword(password),
            bio: '',
            avatar: '',
            followers: 0,
            following: 0,
            postsCount: 0,
            isAdmin,
            isBanned: false,
            isVerified: isAdmin,
            createdAt: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        };

        db.saveUser(user);
        const token = generateToken();
        userSessions.set(token, userId);
        onlineUsers[userId] = { socketId: null, username };

        if (isAdmin) log('👑 Admin user created: ' + username);

        res.json({
            success: true,
            token,
            user: {
                userId,
                username,
                email,
                fullName: user.fullName,
                bio: '',
                avatar: '',
                followers: 0,
                following: 0,
                postsCount: 0,
                isAdmin,
                isBanned: false,
                isVerified: isAdmin
            }
        });
    } catch (error) {
        log('❌ Register error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در ثبت نام' });
    }
});

app.post('/api/auth/login', (req, res) => {
    try {
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
            token,
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
    } catch (error) {
        log('❌ Login error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در ورود' });
    }
});

app.get('/api/auth/me', (req, res) => {
    try {
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
    } catch (error) {
        log('❌ Me error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در دریافت اطلاعات' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    try {
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
    } catch (error) {
        log('❌ Logout error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در خروج' });
    }
});

// ===== Admin =====
function adminAuth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    if (!isAdminToken(token)) return res.status(403).json({ error: 'Admin access required' });
    next();
}

app.post('/api/admin/verify', adminAuth, (req, res) => {
    res.json({ success: true, isAdmin: true });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
    try {
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
    } catch (error) {
        log('❌ Admin users error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در دریافت کاربران' });
    }
});

app.put('/api/admin/users/:userId/ban', adminAuth, (req, res) => {
    try {
        const { userId } = req.params;
        const { banned } = req.body;
        const user = db.getUser(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.isAdmin) return res.status(403).json({ error: 'Cannot ban admin' });

        db.updateUser(userId, { isBanned: banned });
        if (banned) delete onlineUsers[userId];
        res.json({ success: true });
    } catch (error) {
        log('❌ Ban error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در مسدودیت' });
    }
});

app.get('/api/admin/posts', adminAuth, (req, res) => {
    try {
        const result = db.getPosts(1, 1000);
        res.json(result.posts);
    } catch (error) {
        log('❌ Admin posts error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در دریافت پست‌ها' });
    }
});

app.delete('/api/admin/posts/:postId', adminAuth, (req, res) => {
    try {
        const { postId } = req.params;
        const deleted = db.deletePost(postId);
        res.json({ success: deleted });
    } catch (error) {
        log('❌ Delete post error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در حذف پست' });
    }
});

app.post('/api/admin/broadcast', adminAuth, (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: 'Message required' });

        const token = req.headers.authorization?.split(' ')[1];
        const adminId = userSessions.get(token);
        const admin = db.getUser(adminId);

        io.emit('broadcast', {
            message,
            from: admin?.username || 'Admin',
            timestamp: new Date().toISOString()
        });
        res.json({ success: true });
    } catch (error) {
        log('❌ Broadcast error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در ارسال پیام' });
    }
});

app.get('/api/admin/stats', adminAuth, (req, res) => {
    try {
        res.json(db.getStats());
    } catch (error) {
        log('❌ Stats error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در دریافت آمار' });
    }
});

app.post('/api/admin/add-shard', adminAuth, (req, res) => {
    try {
        const newShardIndex = db.shardCount;
        db.shards[newShardIndex] = {
            users: new Map(),
            posts: [],
            stories: [],
            messages: new Map(),
            likes: new Map(),
            comments: new Map(),
            followers: new Map(),
            following: new Map(),
            bookmarks: new Map(),
            hashtags: new Map(),
            notifications: [],
            analytics: [],
            reports: []
        };
        db.shardCount++;
        log('📊 New shard ' + newShardIndex + ' added');
        res.json({ success: true, shardCount: db.shardCount });
    } catch (error) {
        log('❌ Add shard error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در افزودن شارد' });
    }
});

// ===== Users =====
app.get('/api/users', (req, res) => {
    try {
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
    } catch (error) {
        log('❌ Users error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در دریافت کاربران' });
    }
});

app.put('/api/users/:userId/profile', (req, res) => {
    try {
        const { userId } = req.params;
        const { bio, avatar, fullName, username } = req.body;

        const user = db.getUser(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (bio !== undefined) user.bio = bio;
        if (avatar !== undefined) user.avatar = avatar;
        if (fullName !== undefined) user.fullName = fullName;
        if (username !== undefined) {
            const existing = db.getUserByUsername(username);
            if (existing && existing.userId !== userId) {
                return res.status(400).json({ error: 'Username taken' });
            }
            user.username = username;
        }

        db.updateUser(userId, user);
        res.json({ success: true, user });
    } catch (error) {
        log('❌ Profile update error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در به‌روزرسانی' });
    }
});

app.post('/api/users/:userId/follow', (req, res) => {
    try {
        const { userId } = req.params;
        const { followerId } = req.body;

        const result = db.followUser(followerId, userId);
        if (!result) return res.status(400).json({ error: 'Already following' });

        const target = db.getUser(userId);
        io.emit('follow-update', { userId: target.userId, followers: target.followers });
        res.json({ success: true, followers: target.followers });
    } catch (error) {
        log('❌ Follow error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در دنبال کردن' });
    }
});

app.post('/api/users/:userId/unfollow', (req, res) => {
    try {
        const { userId } = req.params;
        const { followerId } = req.body;

        const result = db.unfollowUser(followerId, userId);
        if (!result) return res.status(400).json({ error: 'Not following' });

        const target = db.getUser(userId);
        res.json({ success: true, followers: target.followers });
    } catch (error) {
        log('❌ Unfollow error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در آنفالو' });
    }
});

// ===== Posts =====
const storage = multer.diskStorage({
    destination: './uploads/posts/',
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
        cb(null, allowed.includes(file.mimetype));
    }
});

app.get('/api/posts', (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const hashtag = req.query.hashtag || null;
        const userId = req.query.userId || null;

        const result = db.getPosts(page, limit, hashtag, userId);
        res.json(result);
    } catch (error) {
        log('❌ Posts error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در دریافت پست‌ها' });
    }
});

app.get('/api/posts/:postId', (req, res) => {
    try {
        const post = db.getPost(req.params.postId);
        if (!post) return res.status(404).json({ error: 'Post not found' });
        db.incrementView(req.params.postId);
        post.views = (post.views || 0) + 1;
        res.json(post);
    } catch (error) {
        log('❌ Post error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در دریافت پست' });
    }
});

app.post('/api/posts', upload.single('file'), (req, res) => {
    try {
        const { caption, userId, username, hashtags } = req.body;
        const file = req.file;

        if (!file) return res.status(400).json({ error: 'فایل انتخاب نشده است' });

        const user = db.getUser(userId);
        if (!user || user.isBanned) return res.status(403).json({ error: 'User is banned' });

        const postId = 'post_' + uuidv4();
        const newPost = {
            postId,
            userId,
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

        res.status(201).json(newPost);
    } catch (error) {
        log('❌ Create post error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در ایجاد پست' });
    }
});

app.put('/api/posts/:postId/like', (req, res) => {
    try {
        const { postId } = req.params;
        const { userId } = req.body;

        const result = db.likePost(postId, userId);
        res.json(result);
    } catch (error) {
        log('❌ Like error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در لایک' });
    }
});

app.post('/api/posts/:postId/comment', (req, res) => {
    try {
        const { postId } = req.params;
        const { userId, username, text } = req.body;

        const user = db.getUser(userId);
        if (!user || user.isBanned) return res.status(403).json({ error: 'User is banned' });

        const comment = {
            commentId: 'cmt_' + uuidv4(),
            userId,
            username: username || user.username,
            fullName: user.fullName || user.username,
            text,
            createdAt: new Date().toISOString(),
            likes: 0
        };

        const added = db.addComment(postId, comment);
        if (!added) return res.status(404).json({ error: 'Post not found' });

        res.status(201).json(comment);
    } catch (error) {
        log('❌ Comment error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در ارسال کامنت' });
    }
});

app.get('/api/posts/:postId/comments', (req, res) => {
    try {
        const comments = db.getComments(req.params.postId);
        res.json(comments);
    } catch (error) {
        log('❌ Comments error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در دریافت کامنت‌ها' });
    }
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
    try {
        const stories = db.getStories();
        res.json(stories);
    } catch (error) {
        log('❌ Stories error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در دریافت استوری‌ها' });
    }
});

app.post('/api/stories', storyUpload.single('file'), (req, res) => {
    try {
        const { userId, username } = req.body;
        const file = req.file;

        if (!file) return res.status(400).json({ error: 'فایل انتخاب نشده است' });

        const user = db.getUser(userId);
        if (!user || user.isBanned) return res.status(403).json({ error: 'User is banned' });

        const storyId = 'story_' + uuidv4();
        const story = {
            storyId,
            userId,
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
        res.status(201).json(story);
    } catch (error) {
        log('❌ Create story error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در ایجاد استوری' });
    }
});

app.post('/api/stories/:storyId/view', (req, res) => {
    try {
        const { storyId } = req.params;
        const { userId } = req.body;

        const viewed = db.viewStory(storyId, userId);
        res.json({ success: viewed });
    } catch (error) {
        log('❌ View story error: ' + error.message, 'ERROR');
        res.status(500).json({ error: 'خطا در بازدید استوری' });
    }
});

// ============================================================
// 💬 WebSocket
// ============================================================

io.on('connection', (socket) => {
    log('Socket connected: ' + socket.id);

    socket.on('register', (data) => {
        const { userId, username } = data;
        onlineUsers[userId] = { socketId: socket.id, username };
        socket.userId = userId;
        socket.username = username;

        db.updateUser(userId, { isOnline: true, lastSeen: new Date().toISOString() });
        io.emit('users-online', Object.keys(onlineUsers));
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
            userId,
            username,
            message: encrypted,
            timestamp: new Date().toISOString()
        };

        db.saveMessage(roomId, msgData);
        io.to(roomId).emit('receive-message', {
            ...msgData,
            message
        });
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            delete onlineUsers[socket.userId];
            db.updateUser(socket.userId, { isOnline: false, lastSeen: new Date().toISOString() });
            io.emit('users-online', Object.keys(onlineUsers));
        }
    });
});

// ============================================================
// 🌐 Serve HTML
// ============================================================

// مسیر فایل index.html
const htmlPath = path.join(__dirname, 'public', 'index.html');

// اگر فایل index.html وجود ندارد، ایجادش کن
if (!fs.existsSync(htmlPath)) {
    log('📄 Creating index.html file...', 'SYSTEM');
    const basicHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>سوشال مدیا</title></head>
<body>
<h1>🚀 سوشال مدیا</h1>
<p>سیستم در حال راه‌اندازی است...</p>
<script>
window.location.href = '/';
</script>
</body>
</html>`;
    fs.writeFileSync(htmlPath, basicHtml);
    log('✅ index.html created', 'SYSTEM');
}

// سرویس فایل index.html
app.get('/', (req, res) => {
    res.sendFile(htmlPath);
});

// ============================================================
// 🚀 START
// ============================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('═'.repeat(60));
    console.log('🚀 سوشال مدیا سازمانی');
    console.log('═'.repeat(60));
    console.log('📍 http://localhost:' + PORT);
    console.log('🗄️  ' + db.shardCount + ' شارد');
    console.log('🔐 رمزنگاری AES-256-GCM');
    console.log('👑 ادمین: (مخفی)');
    console.log('═'.repeat(60));
});