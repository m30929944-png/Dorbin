// ============================================
// 🚀 ULTIMATE CORE ENGINE - m1.js
// ============================================
// این فایل شامل: سرور اصلی، دیتابیس ۱۰۰ شاردی،
// رمزنگاری نظامی، مدیریت کاربران، احراز هویت
// ============================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');

const numCPUs = os.cpus().length;
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 2e9
});

// ============================================
// 📁 CONSTANTS & CONFIG
// ============================================
const PORT = process.env.PORT || 3000;
const SHARD_COUNT = 100;
const CACHE_TTL = 5 * 60 * 1000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB
const ADMIN_EMAIL = 'milad.yari1377m@gmail.com';
const ADMIN_PASSWORD = 'M09145978426M';
const ADMIN_USERNAME = 'milad_admin';

// ============================================
// 📁 CREATE DIRECTORIES
// ============================================
const dirs = [
    './uploads', './uploads/posts', './uploads/stories',
    './uploads/avatars', './uploads/live', './uploads/documents',
    './uploads/temp', './uploads/thumbnails', './public', './logs', './backups'
];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ============================================
// 🔐 MILITARY GRADE ENCRYPTION
// ============================================
class MilitaryEncryption {
    constructor() {
        this.SECRET_KEY = crypto.randomBytes(64).toString('hex');
        this.MASTER_KEY = crypto.createHash('sha512').update(this.SECRET_KEY).digest();
        this.ALGORITHM = 'aes-256-gcm';
        this.ITERATIONS = 100000;
        this.KEY_LENGTH = 64;
        this.DIGEST = 'sha512';
        this.sessions = new Map();
        this.tokenBlacklist = new Set();
        this.onlineUsers = new Map();
    }

    hashPassword(password) {
        const salt = crypto.randomBytes(32).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, this.ITERATIONS, this.KEY_LENGTH, this.DIGEST).toString('hex');
        return `${salt}:${hash}`;
    }

    verifyPassword(password, stored) {
        const [salt, hash] = stored.split(':');
        const verifyHash = crypto.pbkdf2Sync(password, salt, this.ITERATIONS, this.KEY_LENGTH, this.DIGEST).toString('hex');
        return hash === verifyHash;
    }

    encrypt(text, key) {
        try {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag().toString('hex');
            return `${iv.toString('hex')}:${authTag}:${encrypted}`;
        } catch (error) {
            return text;
        }
    }

    decrypt(encrypted, key) {
        try {
            const parts = encrypted.split(':');
            if (parts.length !== 3) return '[پیام رمزنگاری شده]';
            const [iv, authTag, data] = parts;
            const decipher = crypto.createDecipheriv(this.ALGORITHM, key, Buffer.from(iv, 'hex'));
            decipher.setAuthTag(Buffer.from(authTag, 'hex'));
            let decrypted = decipher.update(data, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) {
            return '[پیام رمزنگاری شده]';
        }
    }

    generateToken() {
        return crypto.randomBytes(64).toString('hex') + crypto.randomBytes(32).toString('hex');
    }

    generateId(prefix) {
        return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
    }

    getUserKey(userId) {
        return crypto.createHash('sha256').update(this.MASTER_KEY + userId).digest();
    }

    generateRoomId(user1, user2) {
        return [user1, user2].sort().join('_');
    }

    // ===== SESSION MANAGEMENT =====
    createSession(userId) {
        const token = this.generateToken();
        this.sessions.set(token, userId);
        this.onlineUsers.set(userId, { socketId: null, username: '' });
        return token;
    }

    getSession(token) {
        if (this.tokenBlacklist.has(token)) return null;
        return this.sessions.get(token) || null;
    }

    destroySession(token) {
        const userId = this.sessions.get(token);
        if (userId) {
            this.onlineUsers.delete(userId);
        }
        this.sessions.delete(token);
        this.tokenBlacklist.add(token);
        return true;
    }

    isOnline(userId) {
        return this.onlineUsers.has(userId);
    }

    getOnlineUsers() {
        return Array.from(this.onlineUsers.keys());
    }

    getOnlineCount() {
        return this.onlineUsers.size;
    }
}

const encryption = new MilitaryEncryption();

// ============================================
// 💾 ULTRA SHARDED DATABASE (100 Shards)
// ============================================
class UltraShardedDatabase {
    constructor() {
        this.SHARD_COUNT = SHARD_COUNT;
        this.shards = {};
        this.cache = new Map();
        this.cacheTTL = CACHE_TTL;
        this.cacheStats = { hits: 0, misses: 0, sets: 0 };
        this.transactionLog = [];
        this.backupInterval = null;
        
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            this.shards[i] = {
                users: new Map(),
                posts: [],
                stories: [],
                messages: new Map(),
                likes: new Set(),
                comments: new Map(),
                followers: new Map(),
                following: new Map(),
                bookmarks: new Map(),
                hashtags: new Map(),
                notifications: [],
                liveStreams: new Map(),
                views: new Map(),
                shares: new Map(),
                reports: [],
                analytics: new Map(),
                sessions: new Map(),
                temp: new Map()
            };
        }

        this.startAutoBackup();
        this.startCleanupScheduler();
    }

    getShardIndex(key) {
        const hash = crypto.createHash('md5').update(key.toString()).digest('hex');
        return parseInt(hash.substring(0, 4), 16) % this.SHARD_COUNT;
    }

    generateId(prefix) {
        return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
    }

    // ===== CACHE SYSTEM =====
    getCache(key) {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            this.cacheStats.hits++;
            return cached.data;
        }
        this.cacheStats.misses++;
        return null;
    }

    setCache(key, data) {
        this.cache.set(key, { data, timestamp: Date.now() });
        this.cacheStats.sets++;
        if (this.cache.size > 100000) {
            const entries = Array.from(this.cache.keys());
            for (let i = 0; i < 1000; i++) {
                this.cache.delete(entries[i]);
            }
        }
        return data;
    }

    clearCache(pattern = null) {
        if (pattern) {
            for (const key of this.cache.keys()) {
                if (key.includes(pattern)) {
                    this.cache.delete(key);
                }
            }
        } else {
            this.cache.clear();
        }
        return true;
    }

    // ===== TRANSACTION LOGGING =====
    logTransaction(operation, data) {
        this.transactionLog.push({
            id: this.generateId('txn'),
            operation,
            data,
            timestamp: new Date().toISOString()
        });
        if (this.transactionLog.length > 10000) {
            this.transactionLog = this.transactionLog.slice(-5000);
        }
    }

    // ===== AUTO BACKUP =====
    startAutoBackup() {
        this.backupInterval = setInterval(() => {
            this.createBackup();
        }, 60 * 60 * 1000);
    }

    createBackup() {
        try {
            const backup = {
                timestamp: new Date().toISOString(),
                shards: {},
                stats: this.cacheStats
            };
            for (let i = 0; i < this.SHARD_COUNT; i++) {
                backup.shards[i] = {
                    users: Array.from(this.shards[i].users.entries()),
                    posts: this.shards[i].posts,
                    stories: this.shards[i].stories,
                    messages: Array.from(this.shards[i].messages.entries()),
                    likes: Array.from(this.shards[i].likes),
                    comments: Array.from(this.shards[i].comments.entries()),
                    followers: Array.from(this.shards[i].followers.entries()),
                    following: Array.from(this.shards[i].following.entries()),
                    bookmarks: Array.from(this.shards[i].bookmarks.entries()),
                    hashtags: Array.from(this.shards[i].hashtags.entries()),
                    notifications: this.shards[i].notifications
                };
            }
            fs.writeFileSync(
                `./backups/backup_${Date.now()}.json`,
                JSON.stringify(backup, null, 2)
            );
        } catch (error) {
            console.error('Backup failed:', error);
        }
    }

    // ===== CLEANUP =====
    startCleanupScheduler() {
        setInterval(() => this.cleanup(), 60 * 60 * 1000);
    }

    cleanup() {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const oneMonth = 30 * oneDay;

        for (let i = 0; i < this.SHARD_COUNT; i++) {
            this.shards[i].stories = this.shards[i].stories.filter(s => {
                const age = now - new Date(s.createdAt).getTime();
                return age < oneDay;
            });
        }

        for (let i = 0; i < this.SHARD_COUNT; i++) {
            this.shards[i].notifications = this.shards[i].notifications.filter(n => {
                const age = now - new Date(n.createdAt).getTime();
                return age < oneMonth;
            });
        }

        this.clearCache();
    }

    // ============================================
    // 👤 USER MANAGEMENT
    // ============================================
    saveUser(user) {
        const idx = this.getShardIndex(user.userId);
        this.shards[idx].users.set(user.userId, user);
        this.setCache(`user:${user.userId}`, user);
        this.logTransaction('saveUser', { userId: user.userId });
        return user;
    }

    getUser(userId) {
        const cached = this.getCache(`user:${userId}`);
        if (cached) return cached;
        const idx = this.getShardIndex(userId);
        const user = this.shards[idx].users.get(userId);
        if (user) this.setCache(`user:${userId}`, user);
        return user || null;
    }

    getUserByEmail(email) {
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            for (const [key, user] of this.shards[i].users) {
                if (user.email === email) return user;
            }
        }
        return null;
    }

    getUserByUsername(username) {
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            for (const [key, user] of this.shards[i].users) {
                if (user.username === username) return user;
            }
        }
        return null;
    }

    getAllUsers() {
        const all = [];
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            all.push(...Array.from(this.shards[i].users.values()));
        }
        return all;
    }

    updateUser(userId, data) {
        const idx = this.getShardIndex(userId);
        const user = this.shards[idx].users.get(userId);
        if (user) {
            const updated = { ...user, ...data };
            this.shards[idx].users.set(userId, updated);
            this.setCache(`user:${userId}`, updated);
            this.logTransaction('updateUser', { userId, data });
            return updated;
        }
        return null;
    }

    deleteUser(userId) {
        const idx = this.getShardIndex(userId);
        if (this.shards[idx].users.has(userId)) {
            this.shards[idx].users.delete(userId);
            this.cache.delete(`user:${userId}`);
            this.logTransaction('deleteUser', { userId });
            return true;
        }
        return false;
    }

    searchUsers(query, limit = 20) {
        const q = query.toLowerCase();
        const results = [];
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            for (const [key, user] of this.shards[i].users) {
                if (results.length >= limit) break;
                if (user.username.toLowerCase().includes(q) || 
                    user.email.toLowerCase().includes(q) ||
                    (user.fullName && user.fullName.toLowerCase().includes(q))) {
                    results.push(user);
                }
            }
        }
        return results;
    }

    // ===== STATS =====
    getStats() {
        let totalUsers = 0, totalPosts = 0, totalStories = 0;
        let totalMessages = 0, totalLikes = 0, totalComments = 0;
        let totalViews = 0, totalShares = 0, totalNotifications = 0;

        for (let i = 0; i < this.SHARD_COUNT; i++) {
            totalUsers += this.shards[i].users.size;
            totalPosts += this.shards[i].posts.length;
            totalStories += this.shards[i].stories.length;
            totalLikes += this.shards[i].likes.size;
            totalViews += this.shards[i].views.size;
            totalShares += this.shards[i].shares.size;
            totalNotifications += this.shards[i].notifications.length;
            for (const post of this.shards[i].posts) {
                totalComments += (post.comments || []).length;
            }
            for (const [key, msgs] of this.shards[i].messages) {
                totalMessages += msgs.length;
            }
        }

        return {
            totalUsers,
            totalPosts,
            totalStories,
            totalMessages,
            totalLikes,
            totalComments,
            totalViews,
            totalShares,
            totalNotifications,
            shardCount: this.SHARD_COUNT,
            cacheHits: this.cacheStats.hits,
            cacheMisses: this.cacheStats.misses,
            cacheSize: this.cache.size,
            transactionLog: this.transactionLog.length,
            onlineUsers: encryption.getOnlineCount()
        };
    }
}

const db = new UltraShardedDatabase();

// ============================================
// 👑 CREATE ADMIN ACCOUNT
// ============================================
function createAdminAccount() {
    const existing = db.getUserByEmail(ADMIN_EMAIL);
    if (!existing) {
        const adminId = encryption.generateId('admin');
        const admin = {
            userId: adminId,
            username: ADMIN_USERNAME,
            email: ADMIN_EMAIL,
            fullName: 'مدیر ارشد سیستم',
            password: encryption.hashPassword(ADMIN_PASSWORD),
            bio: 'مدیر ارشد پلتفرم سوشال مدیا',
            avatar: '',
            followers: 0,
            following: 0,
            postsCount: 0,
            language: 'fa',
            theme: 'dark',
            isOnline: false,
            isAdmin: true,
            isBanned: false,
            isVerified: true,
            createdAt: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        };
        db.saveUser(admin);
        console.log('═'.repeat(50));
        console.log('👑 ADMIN ACCOUNT CREATED');
        console.log('═'.repeat(50));
        console.log(`📧 Email: ${ADMIN_EMAIL}`);
        console.log(`🔑 Password: ${ADMIN_PASSWORD}`);
        console.log(`👤 Username: ${ADMIN_USERNAME}`);
        console.log('═'.repeat(50));
    }
}
createAdminAccount();

// ============================================
// 🔐 AUTH MIDDLEWARE
// ============================================
const authMiddleware = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'دسترسی غیرمجاز' });
    }

    const userId = encryption.getSession(token);
    if (!userId) {
        return res.status(401).json({ error: 'توکن نامعتبر' });
    }

    const user = db.getUser(userId);
    if (!user || user.isBanned) {
        return res.status(401).json({ error: 'کاربر نامعتبر' });
    }

    req.user = user;
    req.token = token;
    next();
};

const adminMiddleware = async (req, res, next) => {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).json({ error: 'دسترسی ادمین مورد نیاز است' });
    }
    next();
};

// ============================================
// ⚙️ CONFIGURE EXPRESS
// ============================================
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false
}));
app.use(compression());
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '2gb' }));
app.use(express.urlencoded({ extended: true, limit: '2gb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(morgan('combined'));

// ============================================
// 🏠 ROUTE FOR INDEX.HTML
// ============================================
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// ============================================
// 📡 API ROUTES - AUTH
// ============================================
app.post('/api/auth/register', async (req, res) => {
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

    const userId = encryption.generateId('user');
    const isAdmin = email === ADMIN_EMAIL;

    const user = {
        userId: userId,
        username: username,
        email: email,
        fullName: fullName || username,
        password: encryption.hashPassword(password),
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
    const token = encryption.createSession(userId);

    res.json({
        success: true,
        token: token,
        user: { ...user, password: undefined }
    });
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'ایمیل و رمز عبور الزامی است' });
    }

    const user = db.getUserByEmail(email);
    if (!user) {
        return res.status(401).json({ error: 'ایمیل یا رمز عبور اشتباه است' });
    }

    if (!encryption.verifyPassword(password, user.password)) {
        return res.status(401).json({ error: 'ایمیل یا رمز عبور اشتباه است' });
    }

    if (user.isBanned) {
        return res.status(403).json({ error: 'این کاربر مسدود شده است' });
    }

    const token = encryption.createSession(user.userId);
    db.updateUser(user.userId, { isOnline: true, lastSeen: new Date().toISOString() });

    res.json({
        success: true,
        token: token,
        user: { ...user, password: undefined }
    });
});

app.post('/api/auth/logout', (req, res) => {
    const { token } = req.body;
    if (token) {
        const userId = encryption.getSession(token);
        if (userId) {
            db.updateUser(userId, { isOnline: false, lastSeen: new Date().toISOString() });
        }
        encryption.destroySession(token);
    }
    res.json({ success: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json({ ...req.user, password: undefined });
});

// ============================================
// 📡 API ROUTES - USERS
// ============================================
app.get('/api/users', authMiddleware, (req, res) => {
    const users = db.getAllUsers().map(u => ({ ...u, password: undefined }));
    res.json(users);
});

app.get('/api/users/:userId', authMiddleware, (req, res) => {
    const user = db.getUser(req.params.userId);
    if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
    res.json({ ...user, password: undefined });
});

app.put('/api/users/:userId/profile', authMiddleware, (req, res) => {
    const { userId } = req.params;
    if (userId !== req.user.userId) {
        return res.status(403).json({ error: 'این پروفایل متعلق به شما نیست' });
    }

    const { bio, avatar, fullName, username, theme, language } = req.body;
    const updates = {};
    if (bio !== undefined) updates.bio = bio;
    if (avatar !== undefined) updates.avatar = avatar;
    if (fullName !== undefined) updates.fullName = fullName;
    if (theme !== undefined) updates.theme = theme;
    if (language !== undefined) updates.language = language;
    if (username !== undefined) {
        const existing = db.getUserByUsername(username);
        if (existing && existing.userId !== userId) {
            return res.status(400).json({ error: 'این نام کاربری قبلاً ثبت شده است' });
        }
        updates.username = username;
    }

    const updated = db.updateUser(userId, updates);
    res.json({ success: true, user: { ...updated, password: undefined } });
});

app.get('/api/users/search', authMiddleware, (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const results = db.searchUsers(q);
    res.json(results.map(u => ({ ...u, password: undefined })));
});

// ============================================
// 📡 API ROUTES - ADMIN
// ============================================
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
    const users = db.getAllUsers().map(u => ({ ...u, password: undefined }));
    res.json(users);
});

app.put('/api/admin/users/:userId/ban', authMiddleware, adminMiddleware, (req, res) => {
    const { userId } = req.params;
    const { banned } = req.body;
    const user = db.getUser(userId);
    if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
    if (user.isAdmin) return res.status(403).json({ error: 'نمی‌توان ادمین را مسدود کرد' });
    db.updateUser(userId, { isBanned: banned });
    if (banned) encryption.onlineUsers.delete(userId);
    res.json({ success: true });
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
    res.json(db.getStats());
});

app.post('/api/admin/broadcast', authMiddleware, adminMiddleware, (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'متن پیام الزامی است' });
    io.emit('broadcast', { message, from: req.user.username, timestamp: new Date().toISOString() });
    res.json({ success: true });
});

// ============================================
// 💬 WEBSOCKET
// ============================================
io.on('connection', (socket) => {
    console.log('🔌 Socket connected:', socket.id);

    socket.on('register', (data) => {
        const { userId, username } = data;
        const onlineUser = encryption.onlineUsers.get(userId);
        if (onlineUser) {
            onlineUser.socketId = socket.id;
            onlineUser.username = username;
        }
        socket.userId = userId;
        socket.username = username;
        db.updateUser(userId, { isOnline: true, lastSeen: new Date().toISOString() });
        io.emit('users-online', encryption.getOnlineUsers());
        console.log('👤 User online:', username);
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            const onlineUser = encryption.onlineUsers.get(socket.userId);
            if (onlineUser && onlineUser.socketId === socket.id) {
                encryption.onlineUsers.delete(socket.userId);
            }
            db.updateUser(socket.userId, { isOnline: false, lastSeen: new Date().toISOString() });
            io.emit('users-online', encryption.getOnlineUsers());
            console.log('👋 User disconnected:', socket.userId);
        }
    });
});

// ============================================
// 🚀 START SERVER
// ============================================
server.listen(PORT, '0.0.0.0', () => {
    console.log('═'.repeat(60));
    console.log('🚀 ULTIMATE SOCIAL MEDIA ENGINE');
    console.log('═'.repeat(60));
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`💾 ${SHARD_COUNT} Shards`);
    console.log(`⚡ ${numCPUs} CPU Cores`);
    console.log(`🔐 AES-256-GCM Encryption`);
    console.log(`📦 2GB Max Payload Size`);
    console.log(`👑 Admin: ${ADMIN_EMAIL}`);
    console.log('═'.repeat(60));
});

// ============================================
// 📤 EXPORTS
// ============================================
module.exports = {
    app,
    server,
    io,
    db,
    encryption,
    authMiddleware,
    adminMiddleware,
    SHARD_COUNT,
    PORT,
    ADMIN_EMAIL,
    ADMIN_PASSWORD
};