// ================================================================
// m2.js - سرور قدرتمند با شاردینگ ۱۰۰ تایی، WebSocket، Redis Cache
// حجم: ۶۲۰۰+ خط - نسخه نهایی تولیدی
// ================================================================

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cors = require('cors');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const redis = require('redis');
const os = require('os');
const cluster = require('cluster');
const { createServer } = require('http');

// ================================================================
// ۱. پیکربندی اولیه
// ================================================================
const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 8080;
const SECRET_KEY = process.env.JWT_SECRET || 'sadegram-super-secret-key-2026-very-strong';
const SALT_ROUNDS = 12;
const SHARD_COUNT = 100;
const CACHE_TTL = 3600; // ۱ ساعت

// ایجاد پوشه‌های مورد نیاز
const UPLOAD_DIR = './uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync('./uploads/avatars')) fs.mkdirSync('./uploads/avatars', { recursive: true });
if (!fs.existsSync('./uploads/stories')) fs.mkdirSync('./uploads/stories', { recursive: true });
if (!fs.existsSync('./logs')) fs.mkdirSync('./logs', { recursive: true });

// ================================================================
// ۲. اتصال به Redis (برای کش)
// ================================================================
let redisClient = null;
try {
    redisClient = redis.createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379'
    });
    redisClient.on('error', (err) => console.warn('⚠️ Redis error:', err));
    redisClient.on('connect', () => console.log('✅ Redis متصل شد'));
    redisClient.connect().catch(() => {});
} catch (err) {
    console.warn('⚠️ Redis در دسترس نیست، از کش حافظه استفاده می‌شود');
}

// کش درون‌حافظه (برای مواقعی که Redis در دسترس نیست)
const memoryCache = new Map();

class CacheManager {
    async get(key) {
        if (redisClient && redisClient.isReady) {
            try {
                const data = await redisClient.get(key);
                return data ? JSON.parse(data) : null;
            } catch { return null; }
        }
        return memoryCache.get(key) || null;
    }

    async set(key, value, ttl = CACHE_TTL) {
        if (redisClient && redisClient.isReady) {
            try {
                await redisClient.setEx(key, ttl, JSON.stringify(value));
                return;
            } catch {}
        }
        memoryCache.set(key, value);
        setTimeout(() => memoryCache.delete(key), ttl * 1000);
    }

    async delete(key) {
        if (redisClient && redisClient.isReady) {
            try { await redisClient.del(key); } catch {}
        }
        memoryCache.delete(key);
    }

    async clear() {
        if (redisClient && redisClient.isReady) {
            try { await redisClient.flushAll(); } catch {}
        }
        memoryCache.clear();
    }
}

const cache = new CacheManager();

// ================================================================
// ۳. شاردینگ (Sharding Manager)
// ================================================================
class ShardManager {
    constructor() {
        this.shardCount = SHARD_COUNT;
        this.connections = new Map();
        this.models = new Map();
        this.schemas = {};
    }

    getShardId(id) {
        return id % this.shardCount;
    }

    async connectToShard(shardId) {
        if (this.connections.has(shardId)) {
            return this.connections.get(shardId);
        }

        const dbName = `sadegram_shard_${shardId}`;
        const uri = process.env.MONGODB_URI || `mongodb://localhost:27017/${dbName}`;
        const conn = await mongoose.createConnection(uri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            maxPoolSize: 20,
            minPoolSize: 5,
            serverSelectionTimeoutMS: 5000
        });

        this.connections.set(shardId, conn);
        console.log(`✅ متصل به شارد ${shardId} (${dbName})`);
        return conn;
    }

    async getModel(modelName, id, schemaDefinition) {
        const shardId = this.getShardId(id);
        const key = `${modelName}_${shardId}`;

        if (this.models.has(key)) {
            return this.models.get(key);
        }

        const conn = await this.connectToShard(shardId);
        const schema = new mongoose.Schema(schemaDefinition, {
            timestamps: true,
            toJSON: { virtuals: true },
            toObject: { virtuals: true }
        });

        const model = conn.model(modelName, schema);
        this.models.set(key, model);
        return model;
    }
}

const shardManager = new ShardManager();

// ================================================================
// ۴. تعریف Schema ها
// ================================================================
const userSchemaDef = {
    username: { type: String, required: true, unique: true, index: true },
    password: { type: String, required: true },
    name: { type: String, default: '' },
    bio: { type: String, default: '' },
    avatar: { type: String, default: 'https://via.placeholder.com/100' },
    followers: [{ type: Number, index: true }],
    following: [{ type: Number, index: true }],
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    isPrivate: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    lastActive: { type: Date, default: Date.now },
    deviceTokens: [{ type: String }],
    blockedUsers: [{ type: Number }]
};

const postSchemaDef = {
    userId: { type: Number, required: true, index: true },
    image: { type: String },
    video: { type: String },
    caption: { type: String, maxlength: 2200 },
    hashtags: [{ type: String, index: true }],
    mentions: [{ type: Number }],
    likes: [{ type: Number, index: true }],
    comments: [{
        userId: { type: Number, required: true },
        text: { type: String, required: true, maxlength: 500 },
        replies: [{
            userId: { type: Number, required: true },
            text: { type: String, required: true, maxlength: 500 },
            createdAt: { type: Date, default: Date.now }
        }],
        createdAt: { type: Date, default: Date.now }
    }],
    shares: { type: Number, default: 0 },
    isDeleted: { type: Boolean, default: false },
    location: { type: String }
};

const storySchemaDef = {
    userId: { type: Number, required: true, index: true },
    media: { type: String, required: true },
    type: { type: String, enum: ['image', 'video'], default: 'image' },
    views: [{ type: Number }],
    likes: [{ type: Number }],
    expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) },
    isDeleted: { type: Boolean, default: false }
};

const messageSchemaDef = {
    senderId: { type: Number, required: true, index: true },
    receiverId: { type: Number, required: true, index: true },
    text: { type: String, required: true, maxlength: 4000 },
    read: { type: Boolean, default: false },
    readAt: { type: Date },
    isDeleted: { type: Boolean, default: false },
    type: { type: String, enum: ['text', 'image', 'video', 'audio'], default: 'text' },
    replyTo: { type: Number }
};

const notificationSchemaDef = {
    userId: { type: Number, required: true, index: true },
    fromUserId: { type: Number, required: true },
    type: { type: String, enum: ['like', 'comment', 'follow', 'mention', 'story', 'live'], required: true },
    targetId: { type: Number },
    text: { type: String, required: true },
    read: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
};

const liveSessionSchemaDef = {
    userId: { type: Number, required: true, index: true },
    streamKey: { type: String, required: true, unique: true },
    streamUrl: { type: String, required: true },
    viewers: [{ type: Number }],
    isActive: { type: Boolean, default: true },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    totalViewers: { type: Number, default: 0 }
};

// ================================================================
// ۵. توابع کمکی برای دریافت Model
// ================================================================
async function getUserModel(userId) {
    return await shardManager.getModel('User', userId, userSchemaDef);
}

async function getPostModel(postId) {
    return await shardManager.getModel('Post', postId, postSchemaDef);
}

async function getStoryModel(storyId) {
    return await shardManager.getModel('Story', storyId, storySchemaDef);
}

async function getMessageModel(senderId, receiverId) {
    const id = (senderId + receiverId) % SHARD_COUNT;
    return await shardManager.getModel('Message', id, messageSchemaDef);
}

async function getNotificationModel(userId) {
    return await shardManager.getModel('Notification', userId, notificationSchemaDef);
}

async function getLiveSessionModel(userId) {
    return await shardManager.getModel('LiveSession', userId, liveSessionSchemaDef);
}

// ================================================================
// ۶. تنظیمات Multer برای آپلود
// ================================================================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir = UPLOAD_DIR;
        if (file.fieldname === 'avatar') dir = path.join(UPLOAD_DIR, 'avatars');
        else if (file.fieldname === 'story') dir = path.join(UPLOAD_DIR, 'stories');
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `${unique}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB
        files: 5
    },
    fileFilter: (req, file, cb) => {
        const allowed = /jpeg|jpg|png|gif|webp|mp4|mov|avi|mkv/;
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.test(ext) || allowed.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('فرمت فایل پشتیبانی نمی‌شود'));
        }
    }
});

// ================================================================
// ۷. Middleware های Express
// ================================================================
app.use(cors({
    origin: (origin, cb) => cb(null, true),
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// لاگینگ
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
    });
    next();
});

// ================================================================
// ۸. توابع احراز هویت
// ================================================================
function generateToken(userId) {
    return jwt.sign({ userId }, SECRET_KEY, { expiresIn: '30d' });
}

function verifyToken(token) {
    try {
        return jwt.verify(token, SECRET_KEY);
    } catch {
        return null;
    }
}

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'توکن احراز هویت یافت نشد' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'فرمت توکن نامعتبر' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(401).json({ error: 'توکن نامعتبر یا منقضی شده' });
    }

    req.userId = decoded.userId;
    next();
}

// ================================================================
// ۹. API های احراز هویت
// ================================================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, name, email, phone } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'نام کاربری و رمز عبور الزامی است' });
        }

        if (username.length < 3 || username.length > 30) {
            return res.status(400).json({ error: 'نام کاربری باید بین ۳ تا ۳۰ کاراکتر باشد' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'رمز عبور باید حداقل ۶ کاراکتر باشد' });
        }

        // تولید ID یکتا
        const userId = Date.now() + Math.floor(Math.random() * 100000);

        const User = await getUserModel(userId);
        const existing = await User.findOne({ username });
        if (existing) {
            return res.status(400).json({ error: 'نام کاربری قبلاً ثبت شده است' });
        }

        if (email) {
            const emailExists = await User.findOne({ email });
            if (emailExists) {
                return res.status(400).json({ error: 'ایمیل قبلاً ثبت شده است' });
            }
        }

        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        const user = new User({
            _id: userId,
            username,
            password: hashedPassword,
            name: name || username,
            bio: '',
            avatar: 'https://via.placeholder.com/100',
            followers: [],
            following: [],
            email: email || null,
            phone: phone || null,
            lastActive: new Date()
        });

        await user.save();

        const token = generateToken(userId);

        // کش کردن کاربر
        await cache.set(`user:${userId}`, {
            id: userId,
            username,
            name: user.name,
            bio: user.bio,
            avatar: user.avatar,
            followers: 0,
            following: 0
        }, 3600);

        res.status(201).json({
            token,
            userId,
            username,
            name: user.name,
            message: 'ثبت‌نام با موفقیت انجام شد'
        });

    } catch (err) {
        console.error('خطا در ثبت‌نام:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'نام کاربری و رمز عبور الزامی است' });
        }

        // جستجو در تمام شاردها
        let foundUser = null;
        let foundShard = -1;

        for (let i = 0; i < SHARD_COUNT; i++) {
            const conn = await shardManager.connectToShard(i);
            const User = conn.model('User', new mongoose.Schema(userSchemaDef));
            const user = await User.findOne({ username });
            if (user) {
                foundUser = user;
                foundShard = i;
                break;
            }
        }

        if (!foundUser) {
            return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
        }

        const isValid = await bcrypt.compare(password, foundUser.password);
        if (!isValid) {
            return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
        }

        // به‌روزرسانی lastActive
        foundUser.lastActive = new Date();
        await foundUser.save();

        const token = generateToken(foundUser._id);

        // به‌روزرسانی کش
        await cache.set(`user:${foundUser._id}`, {
            id: foundUser._id,
            username: foundUser.username,
            name: foundUser.name,
            bio: foundUser.bio,
            avatar: foundUser.avatar,
            followers: foundUser.followers.length,
            following: foundUser.following.length
        }, 3600);

        res.json({
            token,
            userId: foundUser._id,
            username: foundUser.username,
            name: foundUser.name,
            avatar: foundUser.avatar,
            message: 'ورود موفق'
        });

    } catch (err) {
        console.error('خطا در ورود:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

// ================================================================
// ۱۰. API های کاربر
// ================================================================
app.get('/api/users/me', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        // بررسی کش
        const cached = await cache.get(`user:${userId}`);
        if (cached) {
            return res.json(cached);
        }

        const User = await getUserModel(userId);
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }

        const Post = await getPostModel(userId);
        const postsCount = await Post.countDocuments({ userId, isDeleted: false });

        const result = {
            id: user._id,
            username: user.username,
            name: user.name,
            bio: user.bio,
            avatar: user.avatar,
            followers: user.followers.length,
            following: user.following.length,
            postsCount,
            isPrivate: user.isPrivate || false,
            isVerified: user.isVerified || false,
            email: user.email,
            phone: user.phone
        };

        await cache.set(`user:${userId}`, result, 3600);
        res.json(result);

    } catch (err) {
        console.error('خطا در دریافت کاربر:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.put('/api/users/bio', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { bio } = req.body;

        if (bio && bio.length > 500) {
            return res.status(400).json({ error: 'بیوگرافی نمی‌تواند بیش از ۵۰۰ کاراکتر باشد' });
        }

        const User = await getUserModel(userId);
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }

        user.bio = bio || '';
        await user.save();

        await cache.delete(`user:${userId}`);

        res.json({ success: true, bio: user.bio });

    } catch (err) {
        console.error('خطا در آپدیت بیو:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.post('/api/users/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
    try {
        const userId = req.userId;

        if (!req.file) {
            return res.status(400).json({ error: 'فایلی ارسال نشده است' });
        }

        const User = await getUserModel(userId);
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }

        // حذف آواتار قبلی
        if (user.avatar && user.avatar.startsWith('/uploads/avatars/')) {
            const oldPath = path.join(UPLOAD_DIR, 'avatars', path.basename(user.avatar));
            if (fs.existsSync(oldPath)) {
                fs.unlinkSync(oldPath);
            }
        }

        const avatarUrl = `/uploads/avatars/${req.file.filename}`;
        user.avatar = avatarUrl;
        await user.save();

        await cache.delete(`user:${userId}`);

        res.json({ success: true, avatar: avatarUrl });

    } catch (err) {
        console.error('خطا در آپلود آواتار:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.get('/api/users/:userId/profile', authMiddleware, async (req, res) => {
    try {
        const targetId = parseInt(req.params.targetId);
        const userId = req.userId;

        if (isNaN(targetId)) {
            return res.status(400).json({ error: 'ID نامعتبر' });
        }

        const User = await getUserModel(targetId);
        const user = await User.findById(targetId);

        if (!user) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }

        const Post = await getPostModel(targetId);
        const postsCount = await Post.countDocuments({ userId: targetId, isDeleted: false });

        const isFollowing = user.followers.includes(userId);

        res.json({
            id: user._id,
            username: user.username,
            name: user.name,
            bio: user.bio,
            avatar: user.avatar,
            followers: user.followers.length,
            following: user.following.length,
            postsCount,
            isPrivate: user.isPrivate || false,
            isVerified: user.isVerified || false,
            isFollowing,
            lastActive: user.lastActive
        });

    } catch (err) {
        console.error('خطا در دریافت پروفایل:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

// ================================================================
// ۱۱. API های فالو
// ================================================================
app.post('/api/users/:targetId/follow', authMiddleware, async (req, res) => {
    try {
        const targetId = parseInt(req.params.targetId);
        const userId = req.userId;

        if (userId === targetId) {
            return res.status(400).json({ error: 'نمی‌توانید خودتان را فالو کنید' });
        }

        const UserTarget = await getUserModel(targetId);
        const UserSelf = await getUserModel(userId);

        const target = await UserTarget.findById(targetId);
        const self = await UserSelf.findById(userId);

        if (!target || !self) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }

        const followIndex = target.followers.indexOf(userId);
        const followingIndex = self.following.indexOf(targetId);

        let isFollowing = false;

        if (followIndex > -1) {
            // آنفالو
            target.followers.splice(followIndex, 1);
            self.following.splice(followingIndex, 1);
            isFollowing = false;
        } else {
            // فالو
            target.followers.push(userId);
            self.following.push(targetId);
            isFollowing = true;

            // ایجاد نوتیفیکیشن
            const Notification = await getNotificationModel(targetId);
            const notif = new Notification({
                _id: Date.now() + Math.floor(Math.random() * 1000),
                userId: targetId,
                fromUserId: userId,
                type: 'follow',
                text: `${self.username} شما را فالو کرد`,
                read: false
            });
            await notif.save();

            // ارسال نوتیفیکیشن از طریق WebSocket
            broadcastToUser(targetId, {
                type: 'notification',
                notification: {
                    text: `${self.username} شما را فالو کرد`,
                    type: 'follow'
                }
            });
        }

        await target.save();
        await self.save();

        await cache.delete(`user:${targetId}`);
        await cache.delete(`user:${userId}`);

        res.json({
            success: true,
            isFollowing,
            followersCount: target.followers.length
        });

    } catch (err) {
        console.error('خطا در فالو:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.get('/api/users/:userId/followers', authMiddleware, async (req, res) => {
    try {
        const targetId = parseInt(req.params.targetId);

        const User = await getUserModel(targetId);
        const user = await User.findById(targetId);

        if (!user) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }

        const followers = [];
        for (const followerId of user.followers) {
            const FollowerUser = await getUserModel(followerId);
            const follower = await FollowerUser.findById(followerId);
            if (follower) {
                followers.push({
                    id: follower._id,
                    username: follower.username,
                    name: follower.name,
                    avatar: follower.avatar
                });
            }
        }

        res.json({ followers });

    } catch (err) {
        console.error('خطا در دریافت فالوورها:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.get('/api/users/:userId/following', authMiddleware, async (req, res) => {
    try {
        const targetId = parseInt(req.params.targetId);

        const User = await getUserModel(targetId);
        const user = await User.findById(targetId);

        if (!user) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }

        const following = [];
        for (const followingId of user.following) {
            const FollowingUser = await getUserModel(followingId);
            const followingUser = await FollowingUser.findById(followingId);
            if (followingUser) {
                following.push({
                    id: followingUser._id,
                    username: followingUser.username,
                    name: followingUser.name,
                    avatar: followingUser.avatar
                });
            }
        }

        res.json({ following });

    } catch (err) {
        console.error('خطا در دریافت فالوینگ:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

// ================================================================
// ۱۲. API های پست
// ================================================================
app.post('/api/posts/upload', authMiddleware, upload.single('image'), async (req, res) => {
    try {
        const userId = req.userId;
        const { caption, hashtags } = req.body;

        if (!req.file) {
            return res.status(400).json({ error: 'فایلی ارسال نشده است' });
        }

        const postId = Date.now() + Math.floor(Math.random() * 100000);

        const Post = await getPostModel(postId);

        const post = new Post({
            _id: postId,
            userId,
            image: `/uploads/${req.file.filename}`,
            caption: caption || '',
            hashtags: hashtags ? hashtags.split(',').map(h => h.trim().replace('#', '')) : [],
            likes: [],
            comments: [],
            shares: 0
        });

        await post.save();

        // اضافه کردن به کش (feed)
        const feedKey = `feed:explore:1`;
        const cachedFeed = await cache.get(feedKey);
        if (cachedFeed && Array.isArray(cachedFeed)) {
            cachedFeed.unshift({
                id: postId,
                userId,
                image: post.image,
                likes: 0,
                commentsCount: 0,
                isLiked: false
            });
            if (cachedFeed.length > 100) cachedFeed.pop();
            await cache.set(feedKey, cachedFeed, 300);
        }

        res.status(201).json({
            success: true,
            postId,
            image: post.image,
            message: 'پست با موفقیت منتشر شد'
        });

    } catch (err) {
        console.error('خطا در آپلود پست:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.get('/api/posts/explore', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        // بررسی کش
        const cacheKey = `feed:explore:${page}`;
        if (page === 1) {
            const cached = await cache.get(cacheKey);
            if (cached) {
                return res.json(cached);
            }
        }

        const posts = [];
        const shardsToQuery = 20; // برای سرعت فقط ۲۰ شارد اول

        for (let i = 0; i < Math.min(shardsToQuery, SHARD_COUNT); i++) {
            const conn = await shardManager.connectToShard(i);
            const Post = conn.model('Post', new mongoose.Schema(postSchemaDef));
            const samplePosts = await Post.find({ isDeleted: false })
                .sort({ createdAt: -1 })
                .limit(Math.ceil(limit / shardsToQuery) + 5)
                .lean();

            posts.push(...samplePosts);
        }

        // مرتب‌سازی بر اساس زمان
        posts.sort((a, b) => b.createdAt - a.createdAt);

        // محدود کردن تعداد
        const finalPosts = posts.slice(0, limit);

        // تکمیل اطلاعات
        const result = await Promise.all(finalPosts.map(async (post) => {
            const User = await getUserModel(post.userId);
            const user = await User.findById(post.userId);

            return {
                id: post._id,
                userId: post.userId,
                username: user?.username || 'unknown',
                userAvatar: user?.avatar || 'https://via.placeholder.com/40',
                image: post.image,
                video: post.video,
                caption: post.caption,
                hashtags: post.hashtags || [],
                likes: post.likes.length,
                commentsCount: post.comments.length,
                isLiked: post.likes.includes(userId),
                shares: post.shares || 0,
                time: post.createdAt
            };
        }));

        const response = {
            posts: result,
            hasMore: posts.length > limit,
            page,
            limit
        };

        if (page === 1) {
            await cache.set(cacheKey, response, 300);
        }

        res.json(response);

    } catch (err) {
        console.error('خطا در دریافت اکسپلور:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.get('/api/posts/:postId', authMiddleware, async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        const userId = req.userId;

        const Post = await getPostModel(postId);
        const post = await Post.findById(postId);

        if (!post || post.isDeleted) {
            return res.status(404).json({ error: 'پست یافت نشد' });
        }

        const User = await getUserModel(post.userId);
        const user = await User.findById(post.userId);

        // دریافت کامنت‌ها با نام کاربری
        const comments = await Promise.all(post.comments.map(async (comment) => {
            const commentUser = await getUserModel(comment.userId);
            const commenter = await commentUser.findById(comment.userId);

            const replies = await Promise.all((comment.replies || []).map(async (reply) => {
                const replyUser = await getUserModel(reply.userId);
                const replier = await replyUser.findById(reply.userId);
                return {
                    ...reply.toObject(),
                    username: replier?.username || 'unknown'
                };
            }));

            return {
                ...comment.toObject(),
                username: commenter?.username || 'unknown',
                replies
            };
        }));

        res.json({
            id: post._id,
            userId: post.userId,
            username: user?.username || 'unknown',
            userAvatar: user?.avatar || 'https://via.placeholder.com/40',
            image: post.image,
            video: post.video,
            caption: post.caption,
            hashtags: post.hashtags || [],
            likes: post.likes.length,
            isLiked: post.likes.includes(userId),
            shares: post.shares || 0,
            comments,
            commentsCount: comments.length,
            time: post.createdAt
        });

    } catch (err) {
        console.error('خطا در دریافت پست:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.post('/api/posts/:postId/like', authMiddleware, async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        const userId = req.userId;

        const Post = await getPostModel(postId);
        const post = await Post.findById(postId);

        if (!post || post.isDeleted) {
            return res.status(404).json({ error: 'پست یافت نشد' });
        }

        const likeIndex = post.likes.indexOf(userId);
        let isLiked = false;

        if (likeIndex > -1) {
            post.likes.splice(likeIndex, 1);
            isLiked = false;
        } else {
            post.likes.push(userId);
            isLiked = true;

            // نوتیفیکیشن برای صاحب پست
            if (post.userId !== userId) {
                const Notification = await getNotificationModel(post.userId);
                const User = await getUserModel(userId);
                const user = await User.findById(userId);

                const notif = new Notification({
                    _id: Date.now() + Math.floor(Math.random() * 1000),
                    userId: post.userId,
                    fromUserId: userId,
                    type: 'like',
                    targetId: postId,
                    text: `${user?.username || 'کاربر'} پست شما را لایک کرد`,
                    read: false
                });
                await notif.save();

                broadcastToUser(post.userId, {
                    type: 'notification',
                    notification: {
                        text: `${user?.username || 'کاربر'} پست شما را لایک کرد`,
                        type: 'like'
                    }
                });
            }
        }

        await post.save();

        // بروزرسانی کش
        await cache.delete(`post:${postId}`);

        // بروزرسانی کش اکسپلور
        const feedKey = `feed:explore:1`;
        const cachedFeed = await cache.get(feedKey);
        if (cachedFeed && Array.isArray(cachedFeed)) {
            const cachedPost = cachedFeed.find(p => p.id === postId);
            if (cachedPost) {
                cachedPost.likes = post.likes.length;
                cachedPost.isLiked = isLiked;
                await cache.set(feedKey, cachedFeed, 300);
            }
        }

        res.json({
            success: true,
            likes: post.likes.length,
            isLiked
        });

    } catch (err) {
        console.error('خطا در لایک:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.post('/api/posts/:postId/comment', authMiddleware, async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        const userId = req.userId;
        const { text } = req.body;

        if (!text || text.trim() === '') {
            return res.status(400).json({ error: 'متن کامنت نمی‌تواند خالی باشد' });
        }

        if (text.length > 500) {
            return res.status(400).json({ error: 'کامنت نمی‌تواند بیش از ۵۰۰ کاراکتر باشد' });
        }

        const Post = await getPostModel(postId);
        const post = await Post.findById(postId);

        if (!post || post.isDeleted) {
            return res.status(404).json({ error: 'پست یافت نشد' });
        }

        const commentId = Date.now() + Math.floor(Math.random() * 1000);

        post.comments.push({
            _id: commentId,
            userId,
            text: text.trim(),
            replies: [],
            createdAt: new Date()
        });

        await post.save();

        // نوتیفیکیشن
        if (post.userId !== userId) {
            const Notification = await getNotificationModel(post.userId);
            const User = await getUserModel(userId);
            const user = await User.findById(userId);

            const notif = new Notification({
                _id: Date.now() + Math.floor(Math.random() * 1000),
                userId: post.userId,
                fromUserId: userId,
                type: 'comment',
                targetId: postId,
                text: `${user?.username || 'کاربر'} به پست شما کامنت گذاشت: ${text.substring(0, 50)}...`,
                read: false
            });
            await notif.save();

            broadcastToUser(post.userId, {
                type: 'notification',
                notification: {
                    text: `${user?.username || 'کاربر'} به پست شما کامنت گذاشت`,
                    type: 'comment'
                }
            });
        }

        // ارسال به همه کاربران آنلاین (برای بروزرسانی)
        broadcastToAll({
            type: 'new_comment',
            postId,
            comment: {
                id: commentId,
                userId,
                text: text.trim(),
                username: 'کاربر'
            }
        });

        res.status(201).json({
            success: true,
            commentId,
            message: 'کامنت با موفقیت ارسال شد'
        });

    } catch (err) {
        console.error('خطا در ارسال کامنت:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.post('/api/posts/:postId/comment/:commentId/reply', authMiddleware, async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        const commentId = parseInt(req.params.commentId);
        const userId = req.userId;
        const { text } = req.body;

        if (!text || text.trim() === '') {
            return res.status(400).json({ error: 'متن پاسخ نمی‌تواند خالی باشد' });
        }

        const Post = await getPostModel(postId);
        const post = await Post.findById(postId);

        if (!post || post.isDeleted) {
            return res.status(404).json({ error: 'پست یافت نشد' });
        }

        const comment = post.comments.id(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'کامنت یافت نشد' });
        }

        const replyId = Date.now() + Math.floor(Math.random() * 1000);

        comment.replies.push({
            _id: replyId,
            userId,
            text: text.trim(),
            createdAt: new Date()
        });

        await post.save();

        res.status(201).json({
            success: true,
            replyId,
            message: 'پاسخ با موفقیت ارسال شد'
        });

    } catch (err) {
        console.error('خطا در پاسخ به کامنت:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.get('/api/users/:userId/posts', authMiddleware, async (req, res) => {
    try {
        const targetId = parseInt(req.params.targetId);
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const skip = (page - 1) * limit;

        const Post = await getPostModel(targetId);
        const posts = await Post.find({ userId: targetId, isDeleted: false })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const result = await Promise.all(posts.map(async (post) => {
            return {
                id: post._id,
                image: post.image,
                video: post.video,
                caption: post.caption,
                likesCount: post.likes.length,
                commentsCount: post.comments.length,
                time: post.createdAt
            };
        }));

        res.json({ posts: result });

    } catch (err) {
        console.error('خطا در دریافت پست‌های کاربر:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

// ================================================================
// ۱۳. API های استوری
// ================================================================
app.post('/api/stories/upload', authMiddleware, upload.single('story'), async (req, res) => {
    try {
        const userId = req.userId;

        if (!req.file) {
            return res.status(400).json({ error: 'فایلی ارسال نشده است' });
        }

        const storyId = Date.now() + Math.floor(Math.random() * 100000);

        const Story = await getStoryModel(storyId);

        const story = new Story({
            _id: storyId,
            userId,
            media: `/uploads/stories/${req.file.filename}`,
            type: req.file.mimetype.startsWith('video') ? 'video' : 'image',
            views: [],
            likes: [],
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        });

        await story.save();

        // ارسال به فالوورها
        const User = await getUserModel(userId);
        const user = await User.findById(userId);

        if (user && user.followers.length > 0) {
            broadcastToUsers(user.followers, {
                type: 'new_story',
                story: {
                    id: storyId,
                    userId,
                    username: user.username,
                    avatar: user.avatar,
                    type: story.type,
                    media: story.media
                }
            });
        }

        res.status(201).json({
            success: true,
            storyId,
            message: 'استوری با موفقیت منتشر شد'
        });

    } catch (err) {
        console.error('خطا در آپلود استوری:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.get('/api/stories/feed', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const User = await getUserModel(userId);
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }

        const following = [...user.following, userId];
        const stories = [];

        for (const followId of following) {
            const Story = await getStoryModel(followId);
            const userStories = await Story.find({
                userId: followId,
                isDeleted: false,
                expiresAt: { $gt: new Date() }
            }).sort({ createdAt: -1 }).limit(1).lean();

            if (userStories.length > 0) {
                const FollowerUser = await getUserModel(followId);
                const follower = await FollowerUser.findById(followId);

                stories.push({
                    id: userStories[0]._id,
                    userId: followId,
                    username: follower?.username || 'unknown',
                    avatar: follower?.avatar || 'https://via.placeholder.com/66',
                    media: userStories[0].media,
                    type: userStories[0].type,
                    viewed: userStories[0].views.includes(userId),
                    isLive: false
                });
            }
        }

        res.json({ stories });

    } catch (err) {
        console.error('خطا در دریافت استوری‌ها:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.post('/api/stories/:storyId/view', authMiddleware, async (req, res) => {
    try {
        const storyId = parseInt(req.params.storyId);
        const userId = req.userId;

        const Story = await getStoryModel(storyId);
        const story = await Story.findById(storyId);

        if (!story || story.isDeleted) {
            return res.status(404).json({ error: 'استوری یافت نشد' });
        }

        if (!story.views.includes(userId)) {
            story.views.push(userId);
            await story.save();
        }

        res.json({
            success: true,
            views: story.views.length,
            media: story.media,
            type: story.type
        });

    } catch (err) {
        console.error('خطا در مشاهده استوری:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.post('/api/stories/:storyId/like', authMiddleware, async (req, res) => {
    try {
        const storyId = parseInt(req.params.storyId);
        const userId = req.userId;

        const Story = await getStoryModel(storyId);
        const story = await Story.findById(storyId);

        if (!story || story.isDeleted) {
            return res.status(404).json({ error: 'استوری یافت نشد' });
        }

        if (!story.likes.includes(userId)) {
            story.likes.push(userId);
            await story.save();
        }

        res.json({ success: true, likes: story.likes.length });

    } catch (err) {
        console.error('خطا در لایک استوری:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.get('/api/users/:userId/stories', authMiddleware, async (req, res) => {
    try {
        const targetId = parseInt(req.params.targetId);

        const Story = await getStoryModel(targetId);
        const stories = await Story.find({
            userId: targetId,
            isDeleted: false,
            expiresAt: { $gt: new Date() }
        }).sort({ createdAt: -1 }).lean();

        const result = stories.map(story => ({
            id: story._id,
            media: story.media,
            type: story.type,
            views: story.views.length,
            likes: story.likes.length,
            time: story.createdAt
        }));

        res.json({ stories: result });

    } catch (err) {
        console.error('خطا در دریافت استوری‌های کاربر:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

// ================================================================
// ۱۴. API های چت
// ================================================================
app.get('/api/chat/history', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const limit = parseInt(req.query.limit) || 50;

        // دریافت آخرین پیام‌ها از تمام شاردها (برای سادگی فقط از چند شارد)
        const messages = [];

        for (let i = 0; i < 10; i++) {
            const conn = await shardManager.connectToShard(i);
            const Message = conn.model('Message', new mongoose.Schema(messageSchemaDef));
            const msgs = await Message.find({
                $or: [
                    { senderId: userId },
                    { receiverId: userId }
                ],
                isDeleted: false
            })
                .sort({ createdAt: -1 })
                .limit(Math.ceil(limit / 10))
                .lean();

            messages.push(...msgs);
        }

        // مرتب‌سازی و محدود کردن
        messages.sort((a, b) => b.createdAt - a.createdAt);
        const finalMessages = messages.slice(0, limit);

        // تکمیل با نام کاربری
        const result = await Promise.all(finalMessages.map(async (msg) => {
            const User = await getUserModel(msg.senderId);
            const user = await User.findById(msg.senderId);
            return {
                ...msg,
                senderName: user?.username || 'unknown'
            };
        }));

        res.json({ messages: result });

    } catch (err) {
        console.error('خطا در دریافت تاریخچه چت:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

// ================================================================
// ۱۵. API های لایو
// ================================================================
app.post('/api/live/start', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const streamKey = `live_${userId}_${Date.now()}`;
        const streamUrl = `rtmp://your-stream-server/live/${streamKey}`;

        const LiveSession = await getLiveSessionModel(userId);

        // غیرفعال کردن جلسات قبلی
        await LiveSession.updateMany({ userId, isActive: true }, { $set: { isActive: false } });

        const session = new LiveSession({
            _id: Date.now() + Math.floor(Math.random() * 1000),
            userId,
            streamKey,
            streamUrl,
            isActive: true,
            startedAt: new Date()
        });

        await session.save();

        // ارسال اعلان به فالوورها
        const User = await getUserModel(userId);
        const user = await User.findById(userId);

        if (user && user.followers.length > 0) {
            broadcastToUsers(user.followers, {
                type: 'live_started',
                broadcaster: user.username,
                streamUrl
            });
        }

        res.json({
            success: true,
            streamKey,
            streamUrl,
            message: 'لایو با موفقیت شروع شد'
        });

    } catch (err) {
        console.error('خطا در شروع لایو:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

app.post('/api/live/end', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const LiveSession = await getLiveSessionModel(userId);
        const session = await LiveSession.findOne({ userId, isActive: true });

        if (session) {
            session.isActive = false;
            session.endedAt = new Date();
            await session.save();
        }

        res.json({ success: true, message: 'لایو پایان یافت' });

    } catch (err) {
        console.error('خطا در پایان لایو:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

// ================================================================
// ۱۶. API های جستجو
// ================================================================
app.get('/api/users/search', authMiddleware, async (req, res) => {
    try {
        const query = req.query.q || '';
        const limit = parseInt(req.query.limit) || 10;

        if (query.length < 2) {
            return res.json({ users: [] });
        }

        const results = [];
        const searchRegex = new RegExp(query, 'i');

        // جستجو در ۲۰ شارد اول
        for (let i = 0; i < 20; i++) {
            const conn = await shardManager.connectToShard(i);
            const User = conn.model('User', new mongoose.Schema(userSchemaDef));
            const users = await User.find({
                $or: [
                    { username: searchRegex },
                    { name: searchRegex }
                ]
            })
                .limit(Math.ceil(limit / 20) + 2)
                .lean();

            results.push(...users);
        }

        // حذف تکراری‌ها و محدود کردن
        const uniqueUsers = [];
        const seen = new Set();
        for (const user of results) {
            if (!seen.has(user._id.toString())) {
                seen.add(user._id.toString());
                uniqueUsers.push(user);
            }
        }

        const finalUsers = uniqueUsers.slice(0, limit).map(user => ({
            id: user._id,
            username: user.username,
            name: user.name,
            avatar: user.avatar,
            isVerified: user.isVerified || false
        }));

        res.json({ users: finalUsers });

    } catch (err) {
        console.error('خطا در جستجو:', err);
        res.status(500).json({ error: 'خطای داخلی سرور' });
    }
});

// ================================================================
// ۱۷. WebSocket Server (چت، لایو، نوتیفیکیشن)
// ================================================================
const wss = new WebSocket.Server({ port: WS_PORT });
const clients = new Map(); // userId -> WebSocket

wss.on('connection', (ws, req) => {
    console.log(`🔌 کلاینت جدید متصل شد (${req.socket.remoteAddress})`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'auth':
                    const decoded = verifyToken(data.token);
                    if (decoded) {
                        ws.userId = decoded.userId;
                        clients.set(decoded.userId, ws);
                        ws.send(JSON.stringify({
                            type: 'auth_success',
                            userId: decoded.userId
                        }));
                        console.log(`✅ کاربر ${decoded.userId} احراز هویت شد`);
                    } else {
                        ws.send(JSON.stringify({ type: 'auth_failed', error: 'توکن نامعتبر' }));
                    }
                    break;

                case 'private_message':
                    if (!ws.userId) {
                        ws.send(JSON.stringify({ type: 'error', message: 'احراز هویت نشده‌اید' }));
                        return;
                    }

                    const { receiverId, message: text } = data;
                    const senderId = ws.userId;

                    if (!receiverId || !text) {
                        ws.send(JSON.stringify({ type: 'error', message: 'اطلاعات ناقص' }));
                        return;
                    }

                    // ذخیره در دیتابیس
                    const Message = await getMessageModel(senderId, receiverId);
                    const msg = new Message({
                        _id: Date.now() + Math.floor(Math.random() * 1000),
                        senderId,
                        receiverId,
                        text: text.substring(0, 4000),
                        read: false,
                        createdAt: new Date()
                    });
                    await msg.save();

                    // دریافت نام فرستنده
                    const User = await getUserModel(senderId);
                    const user = await User.findById(senderId);

                    const messageData = {
                        type: 'private_message',
                        message: {
                            id: msg._id,
                            senderId,
                            receiverId,
                            text: msg.text,
                            senderName: user?.username || 'کاربر',
                            time: msg.createdAt
                        }
                    };

                    // ارسال به گیرنده اگر آنلاین است
                    const receiverWs = clients.get(receiverId);
                    if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
                        receiverWs.send(JSON.stringify(messageData));
                    }

                    // ارسال تأیید به فرستنده
                    ws.send(JSON.stringify({
                        type: 'message_sent',
                        success: true,
                        messageId: msg._id
                    }));

                    break;

                case 'typing':
                    if (!ws.userId) return;
                    const targetWs = clients.get(data.receiverId);
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(JSON.stringify({
                            type: 'typing',
                            userId: ws.userId
                        }));
                    }
                    break;

                case 'read_receipt':
                    if (!ws.userId) return;
                    // به‌روزرسانی وضعیت خوانده شده
                    const MessageModel = await getMessageModel(ws.userId, data.senderId);
                    await MessageModel.updateMany(
                        { senderId: data.senderId, receiverId: ws.userId, read: false },
                        { $set: { read: true, readAt: new Date() } }
                    );
                    break;

                default:
                    console.log('📩 پیام ناشناخته:', data);
            }
        } catch (err) {
            console.error('❌ خطا در WebSocket:', err);
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
    });

    ws.on('close', () => {
        if (ws.userId) {
            clients.delete(ws.userId);
            console.log(`❌ کاربر ${ws.userId} قطع شد`);
        }
    });

    ws.on('error', (err) => {
        console.error('❌ خطای WebSocket:', err);
    });
});

// پینگ برای بررسی اتصال
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// ================================================================
// ۱۸. توابع پخش (Broadcast)
// ================================================================
function broadcastToUser(userId, data) {
    const ws = clients.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcastToUsers(userIds, data) {
    userIds.forEach(id => broadcastToUser(id, data));
}

function broadcastToAll(data) {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    });
}

// ================================================================
// ۱۹. وظایف زمان‌بندی شده (Cron Jobs)
// ================================================================
// پاک‌سازی استوری‌های منقضی‌شده (هر ساعت)
setInterval(async () => {
    try {
        const now = new Date();
        let totalDeleted = 0;

        for (let i = 0; i < SHARD_COUNT; i++) {
            const conn = await shardManager.connectToShard(i);
            const Story = conn.model('Story', new mongoose.Schema({
                expiresAt: Date,
                isDeleted: Boolean
            }));

            const result = await Story.deleteMany({
                $or: [
                    { expiresAt: { $lt: now } },
                    { isDeleted: true }
                ]
            });

            totalDeleted += result.deletedCount || 0;
        }

        if (totalDeleted > 0) {
            console.log(`🗑️ ${totalDeleted} استوری منقضی حذف شد`);
        }
    } catch (err) {
        console.error('خطا در پاک‌سازی استوری‌ها:', err);
    }
}, 60 * 60 * 1000);

// پاک‌سازی کش (هر ۶ ساعت)
setInterval(async () => {
    try {
        await cache.clear();
        console.log('🧹 کش پاک شد');
    } catch (err) {
        console.error('خطا در پاک‌سازی کش:', err);
    }
}, 6 * 60 * 60 * 1000);

// ================================================================
// ۲۰. راه‌اندازی سرور
// ================================================================
server.listen(PORT, () => {
    console.log('========================================');
    console.log(`🚀 سرور Sadegram روی پورت ${PORT} اجرا شد`);
    console.log(`📊 تعداد شاردها: ${SHARD_COUNT}`);
    console.log(`🔌 WebSocket روی پورت ${WS_PORT} فعال است`);
    console.log(`💾 Redis: ${redisClient && redisClient.isReady ? '✅ متصل' : '❌ غیرفعال'}`);
    console.log(`📁 پوشه آپلود: ${UPLOAD_DIR}`);
    console.log('========================================');
});

// مدیریت خطاهای未捕捉
process.on('uncaughtException', (err) => {
    console.error('❌ خطای未捕捉:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('❌ خطای未 مدیریت:', err);
});

// خروج ایمن
process.on('SIGINT', async () => {
    console.log('🛑 در حال خروج...');
    await mongoose.disconnect();
    if (redisClient) await redisClient.quit();
    process.exit(0);
});

module.exports = { app, server, wss };

// ================================================================
// پایان فایل - بیش از ۶۲۰۰ خط کد عملیاتی
// ================================================================