/**
 * ============================================================
 * 🏢 سوشال مدیا سازمانی - نسخه Enterprise
 * ============================================================
 * نسخه: 2.0.0
 * تاریخ: 2026-07-12
 * معماری: Microservices Ready
 * پایگاه داده: 256 شارد
 * ============================================================
 */

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

// ============================================================
// 📊 پیکربندی اولیه
// ============================================================

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 2e9,
    allowEIO3: true
});

// ============================================================
// 🛡️ Middleware های امنیتی
// ============================================================

app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ 
    limit: '10gb',
    verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.use(express.urlencoded({ 
    extended: true, 
    limit: '10gb' 
}));

app.use(express.static('public', {
    maxAge: '1d',
    etag: true
}));

app.use('/uploads', express.static('uploads', {
    maxAge: '7d',
    etag: true
}));

// ============================================================
// 📁 سیستم مدیریت پوشه‌ها
// ============================================================

const DIRECTORY_STRUCTURE = {
    root: [
        './uploads', './public', './logs', './backup',
        './temp', './cache', './sessions', './reports'
    ],
    uploads: [
        './uploads/posts', './uploads/stories', './uploads/avatars',
        './uploads/videos', './uploads/thumbnails', './uploads/audios',
        './uploads/documents', './uploads/live', './uploads/temp'
    ],
    logs: [
        './logs/access', './logs/error', './logs/debug',
        './logs/audit', './logs/performance', './logs/security'
    ]
};

function createDirectories() {
    try {
        const allDirs = [
            ...DIRECTORY_STRUCTURE.root,
            ...DIRECTORY_STRUCTURE.uploads,
            ...DIRECTORY_STRUCTURE.logs
        ];
        allDirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
            }
        });
        log('📁 تمام پوشه‌ها با موفقیت ایجاد شدند', 'SYSTEM');
    } catch (error) {
        console.error('❌ خطا در ایجاد پوشه‌ها:', error.message);
        process.exit(1);
    }
}

createDirectories();

// ============================================================
// 📊 سیستم لاگینگ پیشرفته
// ============================================================

const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
    TRACE: 4
};

const CURRENT_LOG_LEVEL = LOG_LEVELS.DEBUG;

function log(message, type = 'INFO', data = null) {
    try {
        const timestamp = new Date().toISOString();
        const pid = process.pid;
        const hostname = os.hostname();
        
        let logEntry = `[${timestamp}] [${pid}] [${hostname}] [${type}] ${message}`;
        if (data) {
            logEntry += `\n${JSON.stringify(data, null, 2)}`;
        }
        logEntry += '\n';

        const logFile = type === 'ERROR' ? './logs/error/app.log' : './logs/app.log';
        const logDir = path.dirname(logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        fs.appendFileSync(logFile, logEntry);
        
        if (type === 'ERROR' || type === 'WARN') {
            console.error(logEntry.trim());
        } else {
            console.log(logEntry.trim());
        }
    } catch (error) {
        console.error('❌ خطا در سیستم لاگینگ:', error.message);
    }
}

// ============================================================
// 🔐 سیستم رمزنگاری پیشرفته
// ============================================================

class EncryptionSystem {
    constructor() {
        this.secretKey = crypto.randomBytes(64).toString('hex');
        this.masterKey = crypto.createHash('sha512')
            .update(this.secretKey + process.env.SALT || 'ENTERPRISE_SOCIAL_MEDIA_2026')
            .digest();
        
        this.algorithms = {
            hash: 'sha512',
            cipher: 'aes-256-gcm',
            keyDerivation: 'pbkdf2'
        };
        
        log('🔐 سیستم رمزنگاری مقداردهی شد', 'SYSTEM');
    }

    hashPassword(password) {
        try {
            const salt = crypto.randomBytes(32).toString('hex');
            const hash = crypto.createHash('sha512')
                .update(password + salt + this.masterKey.toString('hex'))
                .digest('hex');
            return `${salt}:${hash}`;
        } catch (error) {
            log(`❌ خطا در هش کردن رمز: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    verifyPassword(password, hashedPassword) {
        try {
            const [salt, hash] = hashedPassword.split(':');
            const computedHash = crypto.createHash('sha512')
                .update(password + salt + this.masterKey.toString('hex'))
                .digest('hex');
            return hash === computedHash;
        } catch (error) {
            log(`❌ خطا در تایید رمز: ${error.message}`, 'ERROR');
            return false;
        }
    }

    generateToken() {
        try {
            return crypto.randomBytes(128).toString('hex');
        } catch (error) {
            log(`❌ خطا در تولید توکن: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    generateUserKey(userId) {
        try {
            return crypto.createHash('sha512')
                .update(this.masterKey + userId + this.secretKey)
                .digest();
        } catch (error) {
            log(`❌ خطا در تولید کلید کاربر: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    encryptMessage(message, userId) {
        try {
            const key = this.generateUserKey(userId);
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
            let encrypted = cipher.update(message, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag().toString('hex');
            return `v1:${iv.toString('hex')}:${authTag}:${encrypted}`;
        } catch (error) {
            log(`❌ خطا در رمزنگاری: ${error.message}`, 'ERROR');
            return message;
        }
    }

    decryptMessage(encrypted, userId) {
        try {
            const parts = encrypted.split(':');
            if (parts.length !== 4 || parts[0] !== 'v1') {
                return '[پیام رمزنگاری شده]';
            }
            const key = this.generateUserKey(userId);
            const iv = Buffer.from(parts[1], 'hex');
            const authTag = Buffer.from(parts[2], 'hex');
            const encryptedText = parts[3];
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) {
            log(`❌ خطا در رمزگشایی: ${error.message}`, 'ERROR');
            return '[پیام رمزنگاری شده]';
        }
    }
}

const encryption = new EncryptionSystem();

// ============================================================
// 👑 سیستم احراز هویت ادمین
// ============================================================

const ADMIN_CONFIG = {
    email: 'milad.yari1377m@gmail.com',
    password: 'M09145978426M@@$$##',
    name: 'مدیر سیستم'
};

const ADMIN_PASSWORD_HASH = encryption.hashPassword(ADMIN_CONFIG.password);

function isAdminUser(user) {
    if (!user) return false;
    return user.isAdmin === true;
}

function isAdminToken(token) {
    try {
        const userId = userSessions.get(token);
        if (!userId) return false;
        const user = db.getUser(userId);
        return isAdminUser(user);
    } catch (error) {
        log(`❌ خطا در بررسی ادمین: ${error.message}`, 'ERROR');
        return false;
    }
}

// ============================================================
// 🗄️ سیستم پایگاه داده عظیم با 256 شارد
// ============================================================

class EnterpriseDatabase {
    constructor() {
        this.SHARD_COUNT = 256;
        this.shards = new Map();
        this.indexes = new Map();
        this.metadata = new Map();
        
        // شاخص‌های اصلی
        this.indexes.set('users_by_email', new Map());
        this.indexes.set('users_by_username', new Map());
        this.indexes.set('posts_by_hashtag', new Map());
        this.indexes.set('posts_by_user', new Map());
        this.indexes.set('posts_by_date', new Map());
        this.indexes.set('stories_by_user', new Map());
        this.indexes.set('messages_by_user', new Map());
        this.indexes.set('followers_by_user', new Map());
        this.indexes.set('following_by_user', new Map());
        
        // ایجاد شاردها
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            this.shards.set(i, {
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
                reports: [],
                liveStreams: new Map(),
                groups: [],
                chats: new Map(),
                reactions: new Map(),
                shares: new Map(),
                saves: new Map(),
                views: new Map()
            });
        }
        
        log(`🗄️ پایگاه داده با ${this.SHARD_COUNT} شارد راه‌اندازی شد`, 'SYSTEM');
    }

    getShard(key) {
        try {
            const hash = crypto.createHash('sha256').update(key).digest('hex');
            const shardIndex = parseInt(hash.substring(0, 8), 16) % this.SHARD_COUNT;
            return shardIndex;
        } catch (error) {
            log(`❌ خطا در محاسبه شارد: ${error.message}`, 'ERROR');
            return 0;
        }
    }

    getShardById(id) {
        if (!id) return 0;
        return this.getShard(id);
    }

    // ===== مدیریت کاربران =====
    saveUser(user) {
        try {
            const shardIndex = this.getShard(user.userId);
            const shard = this.shards.get(shardIndex);
            shard.users.set(user.userId, user);
            
            this.indexes.get('users_by_email').set(user.email, user.userId);
            this.indexes.get('users_by_username').set(user.username, user.userId);
            
            log(`👤 کاربر ${user.username} ذخیره شد (شارد ${shardIndex})`, 'INFO');
            return user;
        } catch (error) {
            log(`❌ خطا در ذخیره کاربر: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    getUser(userId) {
        try {
            const shardIndex = this.getShardById(userId);
            const shard = this.shards.get(shardIndex);
            return shard.users.get(userId) || null;
        } catch (error) {
            log(`❌ خطا در دریافت کاربر: ${error.message}`, 'ERROR');
            return null;
        }
    }

    getUserByEmail(email) {
        try {
            const userId = this.indexes.get('users_by_email').get(email);
            return userId ? this.getUser(userId) : null;
        } catch (error) {
            log(`❌ خطا در جستجوی ایمیل: ${error.message}`, 'ERROR');
            return null;
        }
    }

    getUserByUsername(username) {
        try {
            const userId = this.indexes.get('users_by_username').get(username);
            return userId ? this.getUser(userId) : null;
        } catch (error) {
            log(`❌ خطا در جستجوی نام کاربری: ${error.message}`, 'ERROR');
            return null;
        }
    }

    getAllUsers() {
        try {
            const allUsers = [];
            for (const shard of this.shards.values()) {
                allUsers.push(...Array.from(shard.users.values()));
            }
            return allUsers;
        } catch (error) {
            log(`❌ خطا در دریافت همه کاربران: ${error.message}`, 'ERROR');
            return [];
        }
    }

    updateUser(userId, data) {
        try {
            const user = this.getUser(userId);
            if (!user) return null;
            
            const updated = { ...user, ...data };
            const shardIndex = this.getShardById(userId);
            const shard = this.shards.get(shardIndex);
            shard.users.set(userId, updated);
            
            // به‌روزرسانی ایندکس‌ها
            if (data.username) {
                this.indexes.get('users_by_username').delete(user.username);
                this.indexes.get('users_by_username').set(data.username, userId);
            }
            if (data.email) {
                this.indexes.get('users_by_email').delete(user.email);
                this.indexes.get('users_by_email').set(data.email, userId);
            }
            
            return updated;
        } catch (error) {
            log(`❌ خطا در به‌روزرسانی کاربر: ${error.message}`, 'ERROR');
            return null;
        }
    }

    deleteUser(userId) {
        try {
            const user = this.getUser(userId);
            if (!user) return false;
            
            const shardIndex = this.getShardById(userId);
            const shard = this.shards.get(shardIndex);
            shard.users.delete(userId);
            
            this.indexes.get('users_by_email').delete(user.email);
            this.indexes.get('users_by_username').delete(user.username);
            
            return true;
        } catch (error) {
            log(`❌ خطا در حذف کاربر: ${error.message}`, 'ERROR');
            return false;
        }
    }

    searchUsers(query, limit = 20) {
        try {
            const results = [];
            const q = query.toLowerCase();
            const allUsers = this.getAllUsers();
            
            for (const user of allUsers) {
                if (results.length >= limit) break;
                if (user.username.toLowerCase().includes(q) ||
                    user.email.toLowerCase().includes(q) ||
                    (user.fullName && user.fullName.toLowerCase().includes(q))) {
                    results.push(user);
                }
            }
            
            return results;
        } catch (error) {
            log(`❌ خطا در جستجوی کاربران: ${error.message}`, 'ERROR');
            return [];
        }
    }

    // ===== سیستم فالو =====
    followUser(userId, targetId) {
        try {
            if (userId === targetId) return false;
            
            const userShardIndex = this.getShardById(userId);
            const targetShardIndex = this.getShardById(targetId);
            const userShard = this.shards.get(userShardIndex);
            const targetShard = this.shards.get(targetShardIndex);
            
            if (!userShard.users.has(userId) || !targetShard.users.has(targetId)) {
                return false;
            }
            
            if (!userShard.following.has(userId)) {
                userShard.following.set(userId, new Set());
            }
            if (!targetShard.followers.has(targetId)) {
                targetShard.followers.set(targetId, new Set());
            }
            
            const following = userShard.following.get(userId);
            if (following.has(targetId)) return false;
            
            following.add(targetId);
            targetShard.followers.get(targetId).add(userId);
            
            const user = userShard.users.get(userId);
            const target = targetShard.users.get(targetId);
            user.following = (user.following || 0) + 1;
            target.followers = (target.followers || 0) + 1;
            
            return true;
        } catch (error) {
            log(`❌ خطا در فالو: ${error.message}`, 'ERROR');
            return false;
        }
    }

    unfollowUser(userId, targetId) {
        try {
            const userShardIndex = this.getShardById(userId);
            const targetShardIndex = this.getShardById(targetId);
            const userShard = this.shards.get(userShardIndex);
            const targetShard = this.shards.get(targetShardIndex);
            
            if (!userShard.following.has(userId)) return false;
            
            const following = userShard.following.get(userId);
            if (!following.has(targetId)) return false;
            
            following.delete(targetId);
            targetShard.followers.get(targetId).delete(userId);
            
            const user = userShard.users.get(userId);
            const target = targetShard.users.get(targetId);
            user.following = (user.following || 0) - 1;
            target.followers = (target.followers || 0) - 1;
            
            return true;
        } catch (error) {
            log(`❌ خطا در آنفالو: ${error.message}`, 'ERROR');
            return false;
        }
    }

    getFollowers(userId) {
        try {
            const shardIndex = this.getShardById(userId);
            const shard = this.shards.get(shardIndex);
            if (!shard.followers.has(userId)) return [];
            
            const followers = shard.followers.get(userId);
            const result = [];
            for (const id of followers) {
                const user = this.getUser(id);
                if (user) result.push(user);
            }
            return result;
        } catch (error) {
            log(`❌ خطا در دریافت فالوورها: ${error.message}`, 'ERROR');
            return [];
        }
    }

    getFollowing(userId) {
        try {
            const shardIndex = this.getShardById(userId);
            const shard = this.shards.get(shardIndex);
            if (!shard.following.has(userId)) return [];
            
            const following = shard.following.get(userId);
            const result = [];
            for (const id of following) {
                const user = this.getUser(id);
                if (user) result.push(user);
            }
            return result;
        } catch (error) {
            log(`❌ خطا در دریافت دنبال‌شونده‌ها: ${error.message}`, 'ERROR');
            return [];
        }
    }

    // ===== مدیریت پست‌ها =====
    savePost(post) {
        try {
            const shardIndex = this.getShard(post.postId);
            const shard = this.shards.get(shardIndex);
            shard.posts.unshift(post);
            
            if (post.hashtags && post.hashtags.length > 0) {
                for (const tag of post.hashtags) {
                    const tagKey = tag.toLowerCase();
                    if (!shard.hashtags.has(tagKey)) {
                        shard.hashtags.set(tagKey, new Set());
                    }
                    shard.hashtags.get(tagKey).add(post.postId);
                    
                    const hashtagIndex = this.indexes.get('posts_by_hashtag');
                    if (!hashtagIndex.has(tagKey)) {
                        hashtagIndex.set(tagKey, new Set());
                    }
                    hashtagIndex.get(tagKey).add(post.postId);
                }
            }
            
            const userPostsIndex = this.indexes.get('posts_by_user');
            if (!userPostsIndex.has(post.userId)) {
                userPostsIndex.set(post.userId, []);
            }
            userPostsIndex.get(post.userId).push(post.postId);
            
            const dateIndex = this.indexes.get('posts_by_date');
            const dateKey = post.createdAt.substring(0, 10);
            if (!dateIndex.has(dateKey)) {
                dateIndex.set(dateKey, new Set());
            }
            dateIndex.get(dateKey).add(post.postId);
            
            return post;
        } catch (error) {
            log(`❌ خطا در ذخیره پست: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    getPosts(page = 1, limit = 20, hashtag = null, userId = null) {
        try {
            let allPosts = [];
            for (const shard of this.shards.values()) {
                allPosts = allPosts.concat(shard.posts);
            }
            
            if (hashtag) {
                const tagKey = hashtag.toLowerCase();
                const postIds = this.indexes.get('posts_by_hashtag').get(tagKey) || new Set();
                allPosts = allPosts.filter(p => postIds.has(p.postId));
            }
            
            if (userId) {
                const postIds = this.indexes.get('posts_by_user').get(userId) || [];
                allPosts = allPosts.filter(p => postIds.includes(p.postId));
            }
            
            allPosts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            const start = (page - 1) * limit;
            
            return {
                posts: allPosts.slice(start, start + limit),
                total: allPosts.length,
                page: page,
                totalPages: Math.ceil(allPosts.length / limit),
                hasMore: start + limit < allPosts.length
            };
        } catch (error) {
            log(`❌ خطا در دریافت پست‌ها: ${error.message}`, 'ERROR');
            return { posts: [], total: 0, page: 1, totalPages: 0, hasMore: false };
        }
    }

    getPost(postId) {
        try {
            const shardIndex = this.getShardById(postId);
            const shard = this.shards.get(shardIndex);
            return shard.posts.find(p => p.postId === postId) || null;
        } catch (error) {
            log(`❌ خطا در دریافت پست: ${error.message}`, 'ERROR');
            return null;
        }
    }

    deletePost(postId, userId = null) {
        try {
            const shardIndex = this.getShardById(postId);
            const shard = this.shards.get(shardIndex);
            const index = shard.posts.findIndex(p => p.postId === postId);
            
            if (index === -1) return false;
            
            const post = shard.posts[index];
            if (userId && post.userId !== userId) return false;
            
            if (post.hashtags) {
                for (const tag of post.hashtags) {
                    const tagKey = tag.toLowerCase();
                    if (shard.hashtags.has(tagKey)) {
                        shard.hashtags.get(tagKey).delete(postId);
                    }
                    const hashtagIndex = this.indexes.get('posts_by_hashtag');
                    if (hashtagIndex.has(tagKey)) {
                        hashtagIndex.get(tagKey).delete(postId);
                    }
                }
            }
            
            const userPostsIndex = this.indexes.get('posts_by_user');
            if (userPostsIndex.has(post.userId)) {
                const idx = userPostsIndex.get(post.userId).indexOf(postId);
                if (idx !== -1) userPostsIndex.get(post.userId).splice(idx, 1);
            }
            
            shard.posts.splice(index, 1);
            return true;
        } catch (error) {
            log(`❌ خطا در حذف پست: ${error.message}`, 'ERROR');
            return false;
        }
    }

    likePost(postId, userId) {
        try {
            const shardIndex = this.getShardById(postId);
            const shard = this.shards.get(shardIndex);
            const post = shard.posts.find(p => p.postId === postId);
            
            if (!post) return { liked: false, likes: 0 };
            
            const likeKey = `${postId}_${userId}`;
            if (shard.likes.has(likeKey)) {
                shard.likes.delete(likeKey);
                post.likes = (post.likes || 0) - 1;
                return { liked: false, likes: post.likes };
            } else {
                shard.likes.set(likeKey, true);
                post.likes = (post.likes || 0) + 1;
                return { liked: true, likes: post.likes };
            }
        } catch (error) {
            log(`❌ خطا در لایک: ${error.message}`, 'ERROR');
            return { liked: false, likes: 0 };
        }
    }

    addComment(postId, comment) {
        try {
            const shardIndex = this.getShardById(postId);
            const shard = this.shards.get(shardIndex);
            const post = shard.posts.find(p => p.postId === postId);
            
            if (!post) return false;
            if (!post.comments) post.comments = [];
            post.comments.push(comment);
            return true;
        } catch (error) {
            log(`❌ خطا در افزودن کامنت: ${error.message}`, 'ERROR');
            return false;
        }
    }

    getComments(postId) {
        try {
            const shardIndex = this.getShardById(postId);
            const shard = this.shards.get(shardIndex);
            const post = shard.posts.find(p => p.postId === postId);
            if (!post) return [];
            return post.comments || [];
        } catch (error) {
            log(`❌ خطا در دریافت کامنت‌ها: ${error.message}`, 'ERROR');
            return [];
        }
    }

    bookmarkPost(postId, userId) {
        try {
            const shardIndex = this.getShardById(userId);
            const shard = this.shards.get(shardIndex);
            
            if (!shard.bookmarks.has(userId)) {
                shard.bookmarks.set(userId, new Set());
            }
            
            const bookmarks = shard.bookmarks.get(userId);
            if (bookmarks.has(postId)) {
                bookmarks.delete(postId);
                return { bookmarked: false };
            } else {
                bookmarks.add(postId);
                return { bookmarked: true };
            }
        } catch (error) {
            log(`❌ خطا در بوکمارک: ${error.message}`, 'ERROR');
            return { bookmarked: false };
        }
    }

    getBookmarks(userId) {
        try {
            const shardIndex = this.getShardById(userId);
            const shard = this.shards.get(shardIndex);
            
            if (!shard.bookmarks.has(userId)) return [];
            
            const bookmarks = shard.bookmarks.get(userId);
            const result = [];
            for (const id of bookmarks) {
                const post = this.getPost(id);
                if (post) result.push(post);
            }
            return result;
        } catch (error) {
            log(`❌ خطا در دریافت بوکمارک‌ها: ${error.message}`, 'ERROR');
            return [];
        }
    }

    incrementView(postId) {
        try {
            const shardIndex = this.getShardById(postId);
            const shard = this.shards.get(shardIndex);
            const post = shard.posts.find(p => p.postId === postId);
            if (post) {
                post.views = (post.views || 0) + 1;
                return true;
            }
            return false;
        } catch (error) {
            log(`❌ خطا در افزایش بازدید: ${error.message}`, 'ERROR');
            return false;
        }
    }

    // ===== مدیریت استوری‌ها =====
    saveStory(story) {
        try {
            const shardIndex = this.getShard(story.storyId);
            const shard = this.shards.get(shardIndex);
            shard.stories.push(story);
            
            const storyIndex = this.indexes.get('stories_by_user');
            if (!storyIndex.has(story.userId)) {
                storyIndex.set(story.userId, new Set());
            }
            storyIndex.get(story.userId).add(story.storyId);
            
            return story;
        } catch (error) {
            log(`❌ خطا در ذخیره استوری: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    getStories(userId = null) {
        try {
            let allStories = [];
            const now = Date.now();
            
            for (const shard of this.shards.values()) {
                const stories = shard.stories.filter(s => {
                    const age = now - new Date(s.createdAt).getTime();
                    return age < 24 * 60 * 60 * 1000;
                });
                allStories = allStories.concat(stories);
            }
            
            if (userId) {
                const storyIds = this.indexes.get('stories_by_user').get(userId) || new Set();
                allStories = allStories.filter(s => storyIds.has(s.storyId));
            }
            
            return allStories.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        } catch (error) {
            log(`❌ خطا در دریافت استوری‌ها: ${error.message}`, 'ERROR');
            return [];
        }
    }

    viewStory(storyId, userId) {
        try {
            const shardIndex = this.getShardById(storyId);
            const shard = this.shards.get(shardIndex);
            const story = shard.stories.find(s => s.storyId === storyId);
            
            if (!story) return false;
            if (!story.viewers) story.viewers = [];
            if (story.viewers.includes(userId)) return false;
            
            story.views = (story.views || 0) + 1;
            story.viewers.push(userId);
            return true;
        } catch (error) {
            log(`❌ خطا در بازدید استوری: ${error.message}`, 'ERROR');
            return false;
        }
    }

    // ===== مدیریت پیام‌ها =====
    saveMessage(roomId, message) {
        try {
            const shardIndex = this.getShard(roomId);
            const shard = this.shards.get(shardIndex);
            
            if (!shard.messages.has(roomId)) {
                shard.messages.set(roomId, []);
            }
            
            shard.messages.get(roomId).push(message);
            return message;
        } catch (error) {
            log(`❌ خطا در ذخیره پیام: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    getMessages(roomId, limit = 50) {
        try {
            const shardIndex = this.getShard(roomId);
            const shard = this.shards.get(shardIndex);
            
            if (!shard.messages.has(roomId)) return [];
            const messages = shard.messages.get(roomId);
            return messages.slice(-limit);
        } catch (error) {
            log(`❌ خطا در دریافت پیام‌ها: ${error.message}`, 'ERROR');
            return [];
        }
    }

    // ===== آمار سیستم =====
    getStats() {
        try {
            let totalUsers = 0;
            let totalPosts = 0;
            let totalStories = 0;
            let totalMessages = 0;
            let totalLikes = 0;
            let totalComments = 0;
            let totalGroups = 0;
            
            for (const shard of this.shards.values()) {
                totalUsers += shard.users.size;
                totalPosts += shard.posts.length;
                totalStories += shard.stories.length;
                totalLikes += shard.likes.size;
                totalGroups += shard.groups.length;
                
                for (const post of shard.posts) {
                    totalComments += (post.comments || []).length;
                }
                
                for (const room of shard.messages.values()) {
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
                totalGroups,
                shardCount: this.SHARD_COUNT,
                onlineUsers: Object.keys(onlineUsers).length || 0,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            log(`❌ خطا در دریافت آمار: ${error.message}`, 'ERROR');
            return null;
        }
    }

    // ===== پشتیبان‌گیری =====
    backup() {
        try {
            const backupData = {
                timestamp: new Date().toISOString(),
                shardCount: this.SHARD_COUNT,
                shards: Array.from(this.shards.entries()).map(([index, shard]) => ({
                    index,
                    userCount: shard.users.size,
                    postCount: shard.posts.length,
                    storyCount: shard.stories.length,
                    messageCount: Array.from(shard.messages.values()).reduce((a, b) => a + b.length, 0)
                })),
                indexes: Array.from(this.indexes.entries()).map(([name, index]) => ({
                    name,
                    size: index.size
                }))
            };
            
            const backupPath = `./backup/db_backup_${Date.now()}.json`;
            fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
            
            log(`📦 پشتیبان‌گیری انجام شد: ${backupPath}`, 'SYSTEM');
            return backupPath;
        } catch (error) {
            log(`❌ خطا در پشتیبان‌گیری: ${error.message}`, 'ERROR');
            return null;
        }
    }
}

const db = new EnterpriseDatabase();

// ============================================================
// 💾 سیستم کش پیشرفته
// ============================================================

class CacheSystem {
    constructor() {
        this.cache = new Map();
        this.ttl = new Map();
        this.hits = 0;
        this.misses = 0;
        this.evictions = 0;
        
        // پاکسازی خودکار هر 5 دقیقه
        setInterval(() => this.cleanup(), 300000);
        
        log('💾 سیستم کش راه‌اندازی شد', 'SYSTEM');
    }

    set(key, value, ttl = 3600) {
        try {
            this.cache.set(key, value);
            this.ttl.set(key, Date.now() + ttl * 1000);
        } catch (error) {
            log(`❌ خطا در ذخیره کش: ${error.message}`, 'ERROR');
        }
    }

    get(key) {
        try {
            if (!this.cache.has(key)) {
                this.misses++;
                return null;
            }
            
            const expiry = this.ttl.get(key);
            if (Date.now() > expiry) {
                this.cache.delete(key);
                this.ttl.delete(key);
                this.evictions++;
                this.misses++;
                return null;
            }
            
            this.hits++;
            return this.cache.get(key);
        } catch (error) {
            log(`❌ خطا در دریافت کش: ${error.message}`, 'ERROR');
            return null;
        }
    }

    delete(key) {
        try {
            this.cache.delete(key);
            this.ttl.delete(key);
        } catch (error) {
            log(`❌ خطا در حذف کش: ${error.message}`, 'ERROR');
        }
    }

    clear() {
        try {
            this.cache.clear();
            this.ttl.clear();
            log('🧹 کش پاک شد', 'SYSTEM');
        } catch (error) {
            log(`❌ خطا در پاکسازی کش: ${error.message}`, 'ERROR');
        }
    }

    cleanup() {
        try {
            const now = Date.now();
            let count = 0;
            
            for (const [key, expiry] of this.ttl) {
                if (now > expiry) {
                    this.cache.delete(key);
                    this.ttl.delete(key);
                    this.evictions++;
                    count++;
                }
            }
            
            if (count > 0) {
                log(`🧹 ${count} آیتم از کش حذف شد`, 'DEBUG');
            }
        } catch (error) {
            log(`❌ خطا در پاکسازی کش: ${error.message}`, 'ERROR');
        }
    }

    getStats() {
        return {
            size: this.cache.size,
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
            hitRate: this.hits + this.misses > 0 ? 
                (this.hits / (this.hits + this.misses) * 100).toFixed(2) + '%' : '0%'
        };
    }
}

const cache = new CacheSystem();

// ============================================================
// ⚡ سیستم صف‌بندی پردازش
// ============================================================

class QueueSystem {
    constructor() {
        this.queues = new Map();
        this.processing = new Map();
        this.stats = new Map();
        
        // پردازنده‌ها
        this.handlers = new Map();
        this.handlers.set('post_processing', this.handlePostProcessing.bind(this));
        this.handlers.set('notification', this.handleNotification.bind(this));
        this.handlers.set('analytics', this.handleAnalytics.bind(this));
        this.handlers.set('email', this.handleEmail.bind(this));
        this.handlers.set('image_optimization', this.handleImageOptimization.bind(this));
        this.handlers.set('video_processing', this.handleVideoProcessing.bind(this));
        this.handlers.set('backup', this.handleBackup.bind(this));
        
        log('⚡ سیستم صف‌بندی راه‌اندازی شد', 'SYSTEM');
    }

    add(queueName, data, priority = 0) {
        try {
            if (!this.queues.has(queueName)) {
                this.queues.set(queueName, []);
                this.stats.set(queueName, { processed: 0, failed: 0, total: 0 });
            }
            
            const queue = this.queues.get(queueName);
            const item = { data, priority, timestamp: Date.now() };
            queue.push(item);
            queue.sort((a, b) => b.priority - a.priority);
            
            this.stats.get(queueName).total++;
            
            if (!this.processing.get(queueName)) {
                this.process(queueName);
            }
            
            return true;
        } catch (error) {
            log(`❌ خطا در افزودن به صف: ${error.message}`, 'ERROR');
            return false;
        }
    }

    async process(queueName) {
        if (this.processing.get(queueName)) return;
        this.processing.set(queueName, true);
        
        const queue = this.queues.get(queueName);
        if (!queue || queue.length === 0) {
            this.processing.set(queueName, false);
            return;
        }
        
        try {
            const item = queue.shift();
            const handler = this.handlers.get(queueName);
            
            if (handler) {
                await handler(item.data);
                this.stats.get(queueName).processed++;
            } else {
                log(`⚠️ هندلر برای صف ${queueName} یافت نشد`, 'WARN');
            }
        } catch (error) {
            log(`❌ خطا در پردازش صف ${queueName}: ${error.message}`, 'ERROR');
            this.stats.get(queueName).failed++;
        }
        
        this.processing.set(queueName, false);
        
        if (queue.length > 0) {
            setImmediate(() => this.process(queueName));
        }
    }

    async handlePostProcessing(data) {
        log(`📝 پردازش پست: ${data.postId}`, 'DEBUG');
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    async handleNotification(data) {
        log(`🔔 نوتیفیکیشن برای ${data.userId}: ${data.type}`, 'DEBUG');
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    async handleAnalytics(data) {
        log(`📊 آنالیتیکس: ${data.event}`, 'DEBUG');
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    async handleEmail(data) {
        log(`📧 ایمیل به ${data.email}: ${data.subject}`, 'DEBUG');
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    async handleImageOptimization(data) {
        log(`🖼️ بهینه‌سازی تصویر: ${data.imageId}`, 'DEBUG');
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    async handleVideoProcessing(data) {
        log(`🎬 پردازش ویدئو: ${data.videoId}`, 'DEBUG');
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    async handleBackup(data) {
        log(`💾 پشتیبان‌گیری: ${data.type}`, 'DEBUG');
        const result = db.backup();
        if (result) {
            log(`✅ پشتیبان‌گیری موفق: ${result}`, 'INFO');
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    getStats() {
        const stats = {};
        for (const [name, data] of this.stats) {
            stats[name] = {
                queueLength: this.queues.get(name)?.length || 0,
                ...data
            };
        }
        return stats;
    }
}

const queue = new QueueSystem();

// ============================================================
// 🌐 متغیرهای جهانی
// ============================================================

const onlineUsers = {};
const userSessions = new Map();
const activeConnections = new Map();

// ============================================================
// 📡 API ROUTES
// ============================================================

// ===== احراز هویت =====
app.post('/api/auth/register', (req, res) => {
    try {
        const { username, email, password, fullName } = req.body;
        
        if (!username || !email || !password) {
            return res.status(400).json({ 
                success: false,
                error: 'همه فیلدها الزامی هستند' 
            });
        }

        if (db.getUserByEmail(email)) {
            return res.status(400).json({ 
                success: false,
                error: 'این ایمیل قبلاً ثبت شده است' 
            });
        }

        if (db.getUserByUsername(username)) {
            return res.status(400).json({ 
                success: false,
                error: 'این نام کاربری قبلاً ثبت شده است' 
            });
        }

        if (username.length < 3 || username.length > 30) {
            return res.status(400).json({ 
                success: false,
                error: 'نام کاربری باید بین 3 تا 30 کاراکتر باشد' 
            });
        }

        if (password.length < 8) {
            return res.status(400).json({ 
                success: false,
                error: 'رمز عبور باید حداقل 8 کاراکتر باشد' 
            });
        }

        const userId = 'user_' + uuidv4();
        const isAdmin = email === ADMIN_CONFIG.email && 
                       encryption.verifyPassword(password, ADMIN_PASSWORD_HASH);

        const user = {
            userId,
            username,
            email,
            fullName: fullName || username,
            password: encryption.hashPassword(password),
            bio: '',
            avatar: '',
            followers: 0,
            following: 0,
            postsCount: 0,
            isAdmin,
            isBanned: false,
            isVerified: isAdmin,
            isOnline: false,
            lastSeen: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            preferences: {
                language: 'fa',
                theme: 'dark',
                notifications: true,
                privacy: {
                    showEmail: false,
                    showOnline: true,
                    showLastSeen: true
                }
            }
        };

        db.saveUser(user);
        const token = encryption.generateToken();
        userSessions.set(token, userId);
        onlineUsers[userId] = { socketId: null, username };

        if (isAdmin) {
            log(`👑 ادمین جدید ثبت نام کرد: ${username} (${email})`, 'SECURITY');
        }

        queue.add('analytics', {
            event: 'user_registered',
            userId: userId,
            data: { email, username }
        });

        queue.add('email', {
            email: email,
            subject: 'به سوشال مدیا خوش آمدید',
            template: 'welcome',
            username: username
        });

        res.json({
            success: true,
            token,
            user: {
                userId,
                username,
                email,
                fullName: user.fullName,
                bio: user.bio,
                avatar: user.avatar,
                followers: user.followers,
                following: user.following,
                postsCount: user.postsCount,
                isAdmin,
                isBanned: false,
                isVerified: isAdmin
            }
        });
    } catch (error) {
        log(`❌ خطا در ثبت نام: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در ثبت نام. لطفاً دوباره تلاش کنید' 
        });
    }
});

app.post('/api/auth/login', (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ 
                success: false,
                error: 'ایمیل و رمز عبور الزامی است' 
            });
        }

        const user = db.getUserByEmail(email);
        if (!user || !encryption.verifyPassword(password, user.password)) {
            return res.status(401).json({ 
                success: false,
                error: 'ایمیل یا رمز عبور اشتباه است' 
            });
        }

        if (user.isBanned) {
            return res.status(403).json({ 
                success: false,
                error: 'این کاربر مسدود شده است' 
            });
        }

        const token = encryption.generateToken();
        userSessions.set(token, user.userId);
        onlineUsers[user.userId] = { socketId: null, username: user.username };
        
        db.updateUser(user.userId, { 
            isOnline: true, 
            lastSeen: new Date().toISOString() 
        });

        queue.add('analytics', {
            event: 'user_login',
            userId: user.userId,
            data: { email }
        });

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
        log(`❌ خطا در ورود: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در ورود. لطفاً دوباره تلاش کنید' 
        });
    }
});

app.get('/api/auth/me', (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        const userId = userSessions.get(token);
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Invalid token' });
        }

        const user = db.getUser(userId);
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        if (user.isBanned) {
            return res.status(403).json({ success: false, error: 'User is banned' });
        }

        res.json({
            success: true,
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
                isVerified: user.isVerified || false,
                preferences: user.preferences || {}
            }
        });
    } catch (error) {
        log(`❌ خطا در دریافت اطلاعات کاربر: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در دریافت اطلاعات' 
        });
    }
});

app.post('/api/auth/logout', (req, res) => {
    try {
        const { token } = req.body;
        if (token) {
            const userId = userSessions.get(token);
            if (userId) {
                db.updateUser(userId, { 
                    isOnline: false, 
                    lastSeen: new Date().toISOString() 
                });
                delete onlineUsers[userId];
            }
            userSessions.delete(token);
        }
        res.json({ success: true });
    } catch (error) {
        log(`❌ خطا در خروج: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در خروج از سیستم' 
        });
    }
});

// ===== Admin Middleware =====
function adminAuthMiddleware(req, res, next) {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        if (!isAdminToken(token)) {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        
        next();
    } catch (error) {
        log(`❌ خطا در بررسی ادمین: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در بررسی دسترسی' 
        });
    }
}

// ===== Admin Routes =====
app.post('/api/admin/verify', adminAuthMiddleware, (req, res) => {
    res.json({ success: true, isAdmin: true });
});

app.get('/api/admin/users', adminAuthMiddleware, (req, res) => {
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
        res.json({ success: true, users });
    } catch (error) {
        log(`❌ خطا در دریافت کاربران: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در دریافت لیست کاربران' 
        });
    }
});

app.put('/api/admin/users/:userId/ban', adminAuthMiddleware, (req, res) => {
    try {
        const { userId } = req.params;
        const { banned, reason } = req.body;
        
        const user = db.getUser(userId);
        if (!user) {
            return res.status(404).json({ 
                success: false,
                error: 'User not found' 
            });
        }
        
        if (user.isAdmin) {
            return res.status(403).json({ 
                success: false,
                error: 'Cannot ban admin' 
            });
        }

        db.updateUser(userId, { 
            isBanned: banned,
            banReason: reason || '',
            banDate: banned ? new Date().toISOString() : null
        });
        
        if (banned) {
            delete onlineUsers[userId];
        }

        log(`👮 ${banned ? 'مسدود' : 'رفع مسدودیت'} کاربر: ${user.username}`, 'SECURITY');
        res.json({ success: true, isBanned: banned });
    } catch (error) {
        log(`❌ خطا در مسدودیت کاربر: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در عملیات مسدودیت' 
        });
    }
});

app.get('/api/admin/posts', adminAuthMiddleware, (req, res) => {
    try {
        const result = db.getPosts(1, 1000);
        res.json({ success: true, posts: result.posts });
    } catch (error) {
        log(`❌ خطا در دریافت پست‌ها: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در دریافت پست‌ها' 
        });
    }
});

app.delete('/api/admin/posts/:postId', adminAuthMiddleware, (req, res) => {
    try {
        const { postId } = req.params;
        const deleted = db.deletePost(postId);
        res.json({ success: deleted });
    } catch (error) {
        log(`❌ خطا در حذف پست: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در حذف پست' 
        });
    }
});

app.post('/api/admin/broadcast', adminAuthMiddleware, (req, res) => {
    try {
        const { message, type = 'info' } = req.body;
        if (!message) {
            return res.status(400).json({ 
                success: false,
                error: 'Message required' 
            });
        }

        const token = req.headers.authorization?.split(' ')[1];
        const adminId = userSessions.get(token);
        const admin = db.getUser(adminId);

        io.emit('broadcast', {
            message,
            from: admin?.username || 'Admin',
            type,
            timestamp: new Date().toISOString()
        });

        log(`📢 پیام همگانی از ${admin?.username}: ${message.substring(0, 50)}...`, 'INFO');
        res.json({ success: true });
    } catch (error) {
        log(`❌ خطا در ارسال پیام همگانی: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در ارسال پیام' 
        });
    }
});

app.get('/api/admin/stats', adminAuthMiddleware, (req, res) => {
    try {
        const dbStats = db.getStats();
        const cacheStats = cache.getStats();
        const queueStats = queue.getStats();
        
        res.json({
            success: true,
            stats: {
                database: dbStats,
                cache: cacheStats,
                queue: queueStats,
                system: {
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    nodeVersion: process.version,
                    platform: process.platform,
                    cpuCount: os.cpus().length,
                    totalMemory: os.totalmem(),
                    freeMemory: os.freemem()
                }
            }
        });
    } catch (error) {
        log(`❌ خطا در دریافت آمار: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در دریافت آمار' 
        });
    }
});

app.get('/api/admin/shard-stats', adminAuthMiddleware, (req, res) => {
    try {
        const stats = [];
        for (const [index, shard] of db.shards) {
            stats.push({
                shard: index,
                users: shard.users.size,
                posts: shard.posts.length,
                stories: shard.stories.length,
                likes: shard.likes.size,
                messages: Array.from(shard.messages.values())
                    .reduce((a, b) => a + b.length, 0)
            });
        }
        res.json({ success: true, shards: stats });
    } catch (error) {
        log(`❌ خطا در دریافت آمار شاردها: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در دریافت آمار شاردها' 
        });
    }
});

app.post('/api/admin/add-shard', adminAuthMiddleware, (req, res) => {
    try {
        const newShardIndex = db.SHARD_COUNT;
        db.shards.set(newShardIndex, {
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
            reports: [],
            liveStreams: new Map(),
            groups: [],
            chats: new Map(),
            reactions: new Map(),
            shares: new Map(),
            saves: new Map(),
            views: new Map()
        });
        db.SHARD_COUNT++;
        
        log(`📊 شارد جدید ${newShardIndex} اضافه شد`, 'SYSTEM');
        res.json({ 
            success: true, 
            shardCount: db.SHARD_COUNT,
            newShard: newShardIndex
        });
    } catch (error) {
        log(`❌ خطا در افزودن شارد: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در افزودن شارد' 
        });
    }
});

app.post('/api/admin/backup', adminAuthMiddleware, (req, res) => {
    try {
        const result = db.backup();
        if (result) {
            res.json({ 
                success: true, 
                backupPath: result,
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(500).json({ 
                success: false,
                error: 'خطا در پشتیبان‌گیری' 
            });
        }
    } catch (error) {
        log(`❌ خطا در پشتیبان‌گیری: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در پشتیبان‌گیری' 
        });
    }
});

// ===== User Routes =====
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
        res.json({ success: true, users });
    } catch (error) {
        log(`❌ خطا در دریافت کاربران: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در دریافت کاربران' 
        });
    }
});

app.get('/api/users/search', (req, res) => {
    try {
        const { q, limit = 20 } = req.query;
        if (!q) {
            return res.json({ success: true, users: [] });
        }
        const results = db.searchUsers(q, parseInt(limit));
        res.json({
            success: true,
            users: results.map(u => ({
                userId: u.userId,
                username: u.username,
                fullName: u.fullName || u.username,
                avatar: u.avatar || '',
                bio: u.bio || '',
                followers: u.followers || 0,
                isOnline: u.isOnline || false,
                isVerified: u.isVerified || false
            }))
        });
    } catch (error) {
        log(`❌ خطا در جستجو: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در جستجو' 
        });
    }
});

app.get('/api/users/:userId', (req, res) => {
    try {
        const user = db.getUser(req.params.userId);
        if (!user) {
            return res.status(404).json({ 
                success: false,
                error: 'User not found' 
            });
        }
        res.json({
            success: true,
            user: {
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
            }
        });
    } catch (error) {
        log(`❌ خطا در دریافت کاربر: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در دریافت کاربر' 
        });
    }
});

app.put('/api/users/:userId/profile', (req, res) => {
    try {
        const { userId } = req.params;
        const { bio, avatar, fullName, username, preferences } = req.body;

        const user = db.getUser(userId);
        if (!user) {
            return res.status(404).json({ 
                success: false,
                error: 'User not found' 
            });
        }

        if (username) {
            const existing = db.getUserByUsername(username);
            if (existing && existing.userId !== userId) {
                return res.status(400).json({ 
                    success: false,
                    error: 'Username already taken' 
                });
            }
        }

        const updates = {};
        if (bio !== undefined) updates.bio = bio;
        if (avatar !== undefined) updates.avatar = avatar;
        if (fullName !== undefined) updates.fullName = fullName;
        if (username !== undefined) updates.username = username;
        if (preferences !== undefined) updates.preferences = preferences;
        updates.updatedAt = new Date().toISOString();

        const updated = db.updateUser(userId, updates);
        
        // Clear user from cache
        cache.delete(`user_${userId}`);
        
        res.json({ success: true, user: updated });
    } catch (error) {
        log(`❌ خطا در به‌روزرسانی پروفایل: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در به‌روزرسانی پروفایل' 
        });
    }
});

app.post('/api/users/:userId/follow', (req, res) => {
    try {
        const { userId } = req.params;
        const { followerId } = req.body;

        const result = db.followUser(followerId, userId);
        if (!result) {
            return res.status(400).json({ 
                success: false,
                error: 'Already following or invalid' 
            });
        }

        const target = db.getUser(userId);
        io.emit('follow-update', { 
            userId: target.userId, 
            followers: target.followers,
            followerId: followerId
        });

        queue.add('notification', {
            userId: userId,
            type: 'follow',
            fromUserId: followerId,
            data: { 
                username: db.getUser(followerId)?.username || 'کاربر'
            }
        });

        res.json({ 
            success: true, 
            followers: target.followers 
        });
    } catch (error) {
        log(`❌ خطا در فالو: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در فالو کردن' 
        });
    }
});

app.post('/api/users/:userId/unfollow', (req, res) => {
    try {
        const { userId } = req.params;
        const { followerId } = req.body;

        const result = db.unfollowUser(followerId, userId);
        if (!result) {
            return res.status(400).json({ 
                success: false,
                error: 'Not following' 
            });
        }

        const target = db.getUser(userId);
        res.json({ 
            success: true, 
            followers: target.followers 
        });
    } catch (error) {
        log(`❌ خطا در آنفالو: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در آنفالو کردن' 
        });
    }
});

// ===== Posts =====
const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const type = file.mimetype.startsWith('video/') ? 'videos' : 'posts';
        cb(null, `./uploads/${type}`);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}-${uuidv4()}${ext}`);
    }
});

const upload = multer({
    storage: uploadStorage,
    limits: {
        fileSize: 500 * 1024 * 1024, // 500MB
        files: 1
    },
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/webm', 'video/quicktime',
            'audio/mpeg', 'audio/wav'
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('فرمت فایل پشتیبانی نمی‌شود'));
        }
    }
});

app.get('/api/posts', (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const hashtag = req.query.hashtag || null;
        const userId = req.query.userId || null;

        const cacheKey = `posts_${page}_${limit}_${hashtag || 'all'}_${userId || 'all'}`;
        const cached = cache.get(cacheKey);
        
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }

        const result = db.getPosts(page, limit, hashtag, userId);
        cache.set(cacheKey, result, 60); // 1 minute cache
        
        res.json({ success: true, ...result });
    } catch (error) {
        log(`❌ خطا در دریافت پست‌ها: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در دریافت پست‌ها' 
        });
    }
});

app.get('/api/posts/:postId', (req, res) => {
    try {
        const post = db.getPost(req.params.postId);
        if (!post) {
            return res.status(404).json({ 
                success: false,
                error: 'Post not found' 
            });
        }
        
        db.incrementView(req.params.postId);
        post.views = (post.views || 0) + 1;
        
        res.json({ success: true, post });
    } catch (error) {
        log(`❌ خطا در دریافت پست: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در دریافت پست' 
        });
    }
});

app.post('/api/posts', upload.single('file'), (req, res) => {
    try {
        const { caption, userId, username, hashtags } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ 
                success: false,
                error: 'فایل انتخاب نشده است' 
            });
        }

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return res.status(403).json({ 
                success: false,
                error: 'User is banned or not found' 
            });
        }

        const postId = 'post_' + uuidv4();
        const isVideo = file.mimetype.startsWith('video/');
        const isAudio = file.mimetype.startsWith('audio/');
        
        const filePath = `/${file.destination.split('/').pop()}/${file.filename}`;

        const newPost = {
            postId,
            userId,
            username: username || user.username,
            fullName: user.fullName || user.username,
            image: filePath,
            caption: caption || '',
            hashtags: hashtags ? hashtags.split(',').map(h => h.trim()) : [],
            likes: 0,
            comments: [],
            shares: 0,
            views: 0,
            isVideo,
            isAudio,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        db.savePost(newPost);
        db.updateUser(userId, { 
            postsCount: (user.postsCount || 0) + 1 
        });

        cache.delete('posts_*');
        
        queue.add('post_processing', {
            postId: postId,
            userId: userId,
            filePath: filePath
        });

        queue.add('analytics', {
            event: 'post_created',
            userId: userId,
            data: { postId, type: isVideo ? 'video' : 'image' }
        });

        res.status(201).json({
            success: true,
            post: newPost
        });
    } catch (error) {
        log(`❌ خطا در ایجاد پست: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در ایجاد پست' 
        });
    }
});

app.put('/api/posts/:postId/like', (req, res) => {
    try {
        const { postId } = req.params;
        const { userId } = req.body;

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return res.status(403).json({ 
                success: false,
                error: 'User is banned or not found' 
            });
        }

        const result = db.likePost(postId, userId);
        
        if (result.liked) {
            const post = db.getPost(postId);
            if (post && post.userId !== userId) {
                queue.add('notification', {
                    userId: post.userId,
                    type: 'like',
                    fromUserId: userId,
                    data: { postId }
                });
            }
        }

        cache.delete('posts_*');
        
        res.json({ success: true, ...result });
    } catch (error) {
        log(`❌ خطا در لایک: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در لایک کردن' 
        });
    }
});

app.post('/api/posts/:postId/comment', (req, res) => {
    try {
        const { postId } = req.params;
        const { userId, username, text } = req.body;

        if (!text || text.length < 1) {
            return res.status(400).json({ 
                success: false,
                error: 'متن کامنت الزامی است' 
            });
        }

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return res.status(403).json({ 
                success: false,
                error: 'User is banned or not found' 
            });
        }

        const comment = {
            commentId: 'cmt_' + uuidv4(),
            userId,
            username: username || user.username,
            fullName: user.fullName || user.username,
            text: text.trim(),
            createdAt: new Date().toISOString(),
            likes: 0
        };

        const added = db.addComment(postId, comment);
        if (!added) {
            return res.status(404).json({ 
                success: false,
                error: 'Post not found' 
            });
        }

        const post = db.getPost(postId);
        if (post && post.userId !== userId) {
            queue.add('notification', {
                userId: post.userId,
                type: 'comment',
                fromUserId: userId,
                data: { 
                    postId,
                    comment: text.substring(0, 50)
                }
            });
        }

        cache.delete(`posts_*`);
        
        res.status(201).json({
            success: true,
            comment
        });
    } catch (error) {
        log(`❌ خطا در افزودن کامنت: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در افزودن کامنت' 
        });
    }
});

app.get('/api/posts/:postId/comments', (req, res) => {
    try {
        const comments = db.getComments(req.params.postId);
        res.json({ 
            success: true, 
            comments,
            count: comments.length 
        });
    } catch (error) {
        log(`❌ خطا در دریافت کامنت‌ها: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در دریافت کامنت‌ها' 
        });
    }
});

// ===== Stories =====
const storyStorage = multer.diskStorage({
    destination: './uploads/stories/',
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`);
    }
});

const storyUpload = multer({
    storage: storyStorage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB
    },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('فرمت فایل پشتیبانی نمی‌شود'));
        }
    }
});

app.get('/api/stories', (req, res) => {
    try {
        const userId = req.query.userId || null;
        const stories = db.getStories(userId);
        res.json({ success: true, stories });
    } catch (error) {
        log(`❌ خطا در دریافت استوری‌ها: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در دریافت استوری‌ها' 
        });
    }
});

app.post('/api/stories', storyUpload.single('file'), (req, res) => {
    try {
        const { userId, username } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ 
                success: false,
                error: 'فایل انتخاب نشده است' 
            });
        }

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return res.status(403).json({ 
                success: false,
                error: 'User is banned or not found' 
            });
        }

        const storyId = 'story_' + uuidv4();
        const isVideo = file.mimetype.startsWith('video/');

        const story = {
            storyId,
            userId,
            username: username || user.username,
            fullName: user.fullName || user.username,
            image: '/uploads/stories/' + file.filename,
            isVideo,
            views: 0,
            viewers: [],
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        };

        db.saveStory(story);

        queue.add('analytics', {
            event: 'story_created',
            userId: userId,
            data: { storyId }
        });

        res.status(201).json({
            success: true,
            story
        });
    } catch (error) {
        log(`❌ خطا در ایجاد استوری: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در ایجاد استوری' 
        });
    }
});

app.post('/api/stories/:storyId/view', (req, res) => {
    try {
        const { storyId } = req.params;
        const { userId } = req.body;

        const viewed = db.viewStory(storyId, userId);
        res.json({ success: viewed });
    } catch (error) {
        log(`❌ خطا در بازدید استوری: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false,
            error: 'خطا در بازدید استوری' 
        });
    }
});

// ============================================================
// 💬 WebSocket
// ============================================================

io.on('connection', (socket) => {
    const connectionId = uuidv4();
    activeConnections.set(socket.id, { connectionId, socket });
    
    log(`🔌 Socket connected: ${socket.id} (${connectionId})`, 'DEBUG');

    socket.on('register', (data) => {
        try {
            const { userId, username, token } = data;
            
            // Verify token
            if (token && userSessions.get(token) !== userId) {
                socket.emit('error', { message: 'Invalid session' });
                return;
            }

            onlineUsers[userId] = { socketId: socket.id, username };
            socket.userId = userId;
            socket.username = username;

            db.updateUser(userId, { 
                isOnline: true, 
                lastSeen: new Date().toISOString() 
            });
            
            io.emit('users-online', Object.keys(onlineUsers));
            
            log(`👤 User online: ${username} (${userId})`, 'INFO');
        } catch (error) {
            log(`❌ خطا در ثبت کاربر: ${error.message}`, 'ERROR');
            socket.emit('error', { message: 'Registration failed' });
        }
    });

    socket.on('join-room', (data) => {
        try {
            const { roomId, userId } = data;
            socket.join(roomId);
            socket.roomId = roomId;

            const messages = db.getMessages(roomId, 50);
            const decrypted = messages.map(msg => ({
                ...msg,
                message: encryption.decryptMessage(msg.message, msg.userId)
            }));
            
            socket.emit('history', decrypted);
            
            log(`📨 User ${userId} joined room ${roomId}`, 'DEBUG');
        } catch (error) {
            log(`❌ خطا در ورود به اتاق: ${error.message}`, 'ERROR');
            socket.emit('error', { message: 'Failed to join room' });
        }
    });

    socket.on('send-message', (data) => {
        try {
            const { roomId, userId, username, message } = data;

            const user = db.getUser(userId);
            if (!user || user.isBanned) {
                socket.emit('error', { message: 'You are banned' });
                return;
            }

            const encrypted = encryption.encryptMessage(message, userId);
            const msgData = {
                messageId: 'msg_' + uuidv4(),
                userId,
                username: username || user.username,
                message: encrypted,
                timestamp: new Date().toISOString()
            };

            db.saveMessage(roomId, msgData);
            
            io.to(roomId).emit('receive-message', {
                ...msgData,
                message: message // Send decrypted for display
            });

            queue.add('analytics', {
                event: 'message_sent',
                userId: userId,
                data: { roomId }
            });

            log(`💬 Message from ${username} in ${roomId}`, 'DEBUG');
        } catch (error) {
            log(`❌ خطا در ارسال پیام: ${error.message}`, 'ERROR');
            socket.emit('error', { message: 'Failed to send message' });
        }
    });

    socket.on('leave-room', (data) => {
        try {
            const { roomId, userId } = data;
            socket.leave(roomId);
            log(`🚪 User ${userId} left room ${roomId}`, 'DEBUG');
        } catch (error) {
            log(`❌ خطا در خروج از اتاق: ${error.message}`, 'ERROR');
        }
    });

    socket.on('typing', (data) => {
        try {
            const { roomId, userId, isTyping } = data;
            socket.to(roomId).emit('user-typing', { userId, isTyping });
        } catch (error) {
            log(`❌ خطا در تایپ: ${error.message}`, 'ERROR');
        }
    });

    socket.on('disconnect', () => {
        try {
            if (socket.userId) {
                delete onlineUsers[socket.userId];
                db.updateUser(socket.userId, { 
                    isOnline: false, 
                    lastSeen: new Date().toISOString() 
                });
                io.emit('users-online', Object.keys(onlineUsers));
                log(`👤 User disconnected: ${socket.userId}`, 'INFO');
            }
            
            activeConnections.delete(socket.id);
        } catch (error) {
            log(`❌ خطا در قطع ارتباط: ${error.message}`, 'ERROR');
        }
    });
});

// ============================================================
// 🌐 HTML PAGE - Full UI
// ============================================================

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>سوشال مدیا سازمانی</title>
    <script src="/socket.io/socket.io.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        /* ===== Reset & Variables ===== */
        * { margin: 0; padding: 0; box-sizing: border-box; }
        :root {
            --primary: #6C63FF;
            --primary-dark: #5A52D5;
            --primary-light: #8B83FF;
            --secondary: #FF6B6B;
            --success: #2ECC71;
            --danger: #E74C3C;
            --warning: #F1C40F;
            --bg: #0A0A0F;
            --bg-secondary: #14141E;
            --bg-card: #1A1A2E;
            --bg-hover: #2A2A4A;
            --text: #FFFFFF;
            --text-secondary: #A0A0B8;
            --text-muted: #6A6A8A;
            --border: #2A2A4A;
            --shadow: 0 8px 32px rgba(108,99,255,0.15);
            --shadow-hover: 0 12px 48px rgba(108,99,255,0.25);
            --radius: 16px;
            --radius-sm: 10px;
            --radius-lg: 24px;
            --transition: all 0.3s cubic-bezier(0.4,0,0.2,1);
            --header-height: 70px;
            --bottom-nav-height: 75px;
            --font: 'Inter','Segoe UI',Tahoma,sans-serif;
            --glass-bg: rgba(26,26,46,0.85);
            --glass-border: rgba(108,99,255,0.2);
        }
        body { background: var(--bg); color: var(--text); font-family: var(--font); height: 100vh; overflow: hidden; display: flex; flex-direction: column; transition: var(--transition); }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: var(--bg); }
        ::-webkit-scrollbar-thumb { background: var(--primary); border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--primary-dark); }
        
        /* ===== Login ===== */
        .login-container { display: flex; justify-content: center; align-items: center; height: 100vh; background: var(--bg); padding: 20px; position: relative; overflow: hidden; }
        .login-container::before { content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; background: radial-gradient(ellipse at center, rgba(108,99,255,0.05) 0%, transparent 70%); animation: rotateGlow 20s linear infinite; }
        @keyframes rotateGlow { 0% { transform: rotate(0deg) scale(1); } 50% { transform: rotate(180deg) scale(1.1); } 100% { transform: rotate(360deg) scale(1); } }
        .login-box { background: var(--glass-bg); backdrop-filter: blur(20px); padding: 45px 35px; border-radius: var(--radius-lg); border: 1px solid var(--glass-border); box-shadow: var(--shadow); max-width: 420px; width: 100%; position: relative; z-index: 1; animation: slideUp 0.6s ease; }
        @keyframes slideUp { from { opacity: 0; transform: translateY(30px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .login-box .logo { text-align: center; font-size: 32px; font-weight: 900; color: var(--text); margin-bottom: 5px; }
        .login-box .logo span { background: linear-gradient(135deg, var(--primary), var(--secondary)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .login-box .subtitle { text-align: center; color: var(--text-secondary); font-size: 14px; margin-bottom: 25px; }
        .login-box input { width: 100%; padding: 14px 18px; margin: 8px 0; border: 2px solid var(--border); border-radius: var(--radius-sm); font-size: 15px; background: var(--bg); color: var(--text); direction: rtl; transition: var(--transition); font-family: var(--font); }
        .login-box input:focus { border-color: var(--primary); outline: none; box-shadow: 0 0 0 4px rgba(108,99,255,0.15); }
        .login-box input::placeholder { color: var(--text-muted); }
        .login-box .btn-primary { width: 100%; padding: 14px; background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: white; border: none; border-radius: var(--radius-sm); font-size: 16px; font-weight: 700; cursor: pointer; transition: var(--transition); margin-top: 12px; font-family: var(--font); position: relative; overflow: hidden; }
        .login-box .btn-primary::after { content: ''; position: absolute; top: 50%; left: 50%; width: 0; height: 0; background: rgba(255,255,255,0.2); border-radius: 50%; transition: width 0.6s, height 0.6s, top 0.6s, left 0.6s; }
        .login-box .btn-primary:hover::after { width: 300px; height: 300px; top: -100px; left: -100px; }
        .login-box .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(108,99,255,0.4); }
        .login-box .btn-primary:active { transform: scale(0.98); }
        .login-box .toggle-link { color: var(--primary); cursor: pointer; text-align: center; margin-top: 16px; font-size: 14px; font-weight: 500; transition: var(--transition); }
        .login-box .toggle-link:hover { color: var(--primary-light); text-decoration: underline; }
        .login-box .error { color: var(--danger); font-size: 13px; margin: 8px 0; text-align: center; }
        
        /* ===== Main App ===== */
        #mainApp { display: none; flex-direction: column; height: 100vh; background: var(--bg); }
        .header { background: var(--glass-bg); backdrop-filter: blur(20px); border-bottom: 1px solid var(--glass-border); padding: 0 20px; height: var(--header-height); display: flex; align-items: center; gap: 16px; flex-shrink: 0; position: sticky; top: 0; z-index: 100; }
        .header .logo { font-size: 22px; font-weight: 900; color: var(--text); display: flex; align-items: center; gap: 8px; }
        .header .logo i { background: linear-gradient(135deg, var(--primary), var(--secondary)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .search-box { flex: 1; max-width: 420px; background: var(--bg); padding: 10px 18px; border-radius: 30px; display: flex; align-items: center; gap: 12px; border: 2px solid var(--border); transition: var(--transition); }
        .search-box:focus-within { border-color: var(--primary); box-shadow: 0 0 0 4px rgba(108,99,255,0.1); }
        .search-box input { border: none; background: transparent; outline: none; width: 100%; font-size: 14px; color: var(--text); font-family: var(--font); }
        .search-box input::placeholder { color: var(--text-muted); }
        .search-box i { color: var(--text-muted); font-size: 16px; }
        .header-right { display: flex; gap: 18px; font-size: 22px; color: var(--text); }
        .header-right i { cursor: pointer; transition: var(--transition); padding: 8px; border-radius: 50%; }
        .header-right i:hover { background: var(--bg-hover); color: var(--primary); transform: scale(1.05); }
        
        /* ===== Stories ===== */
        .stories-section { background: var(--bg-secondary); padding: 14px 20px; border-bottom: 1px solid var(--border); overflow-x: auto; flex-shrink: 0; }
        .stories-container { display: flex; gap: 18px; padding: 2px 0; }
        .story-item { display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; flex-shrink: 0; transition: var(--transition); }
        .story-item:hover { transform: scale(1.05); }
        .story-avatar { width: 68px; height: 68px; border-radius: 50%; padding: 3px; background: linear-gradient(135deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888); transition: var(--transition); position: relative; }
        .story-avatar img { width: 100%; height: 100%; border-radius: 50%; border: 3px solid var(--bg-secondary); object-fit: cover; }
        .story-avatar.add-story { background: var(--bg); border: 2px dashed var(--border); padding: 0; display: flex; align-items: center; justify-content: center; }
        .story-avatar.add-story i { font-size: 28px; color: var(--primary); }
        .story-name { font-size: 11px; color: var(--text-secondary); max-width: 68px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
        
        /* ===== Gallery ===== */
        .gallery-wrapper { flex: 1; overflow-y: auto; padding-bottom: calc(var(--bottom-nav-height) + 20px); }
        .gallery { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 4px; max-width: 935px; margin: 0 auto; }
        .post-item { background: var(--bg-card); border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border); cursor: pointer; transition: var(--transition); position: relative; }
        .post-item:hover { transform: scale(1.02); box-shadow: var(--shadow-hover); z-index: 2; }
        .post-item .post-media { width: 100%; aspect-ratio: 1; overflow: hidden; background: var(--bg); position: relative; }
        .post-item .post-media img, .post-item .post-media video { width: 100%; height: 100%; object-fit: cover; transition: var(--transition); }
        .post-item:hover .post-media img { transform: scale(1.03); }
        .post-item .post-media .video-icon { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: white; font-size: 48px; text-shadow: 0 4px 20px rgba(0,0,0,0.5); opacity: 0.8; }
        .post-item .post-overlay { position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,0.8)); padding: 16px 12px 12px; display: flex; justify-content: space-around; align-items: center; opacity: 0; transition: var(--transition); }
        .post-item:hover .post-overlay { opacity: 1; }
        .post-overlay .action-btn { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border: none; color: white; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 30px; transition: var(--transition); font-family: var(--font); font-weight: 600; }
        .post-overlay .action-btn:hover { background: rgba(255,255,255,0.25); transform: scale(1.05); }
        .post-overlay .action-btn.liked { background: rgba(231,76,60,0.4); }
        .post-overlay .action-btn.liked i { color: var(--danger); }
        
        /* ===== Bottom Nav ===== */
        .bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; background: var(--glass-bg); backdrop-filter: blur(20px); border-top: 1px solid var(--glass-border); display: flex; justify-content: space-around; padding: 8px 0 12px; z-index: 100; height: var(--bottom-nav-height); }
        .bottom-nav button { background: transparent; border: none; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 10px; color: var(--text-muted); padding: 6px 20px; border-radius: 30px; transition: var(--transition); font-family: var(--font); font-weight: 600; position: relative; }
        .bottom-nav button i { font-size: 24px; color: var(--text-muted); transition: var(--transition); }
        .bottom-nav button:hover { background: var(--bg-hover); }
        .bottom-nav button.active i { color: var(--primary); }
        .bottom-nav button.active { color: var(--primary); }
        .bottom-nav button .badge { position: absolute; top: 0; right: 8px; background: var(--danger); color: white; font-size: 10px; padding: 1px 7px; border-radius: 20px; font-weight: 700; }
        
        /* ===== Modals ===== */
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); backdrop-filter: blur(10px); z-index: 300; justify-content: center; align-items: center; padding: 20px; }
        .modal-overlay.active { display: flex; }
        .modal-content { background: var(--bg-card); border-radius: var(--radius-lg); max-width: 560px; width: 100%; max-height: 85vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: var(--shadow-hover); border: 1px solid var(--glass-border); animation: modalIn 0.3s ease; }
        @keyframes modalIn { from { opacity: 0; transform: scale(0.9) translateY(30px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        .modal-header { padding: 18px 24px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
        .modal-header h3 { font-size: 18px; font-weight: 700; color: var(--text); }
        .modal-header .close-modal { font-size: 28px; cursor: pointer; color: var(--text-muted); background: none; border: none; transition: var(--transition); width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        .modal-header .close-modal:hover { background: var(--bg-hover); color: var(--text); transform: rotate(90deg); }
        .modal-body { flex: 1; overflow-y: auto; padding: 20px 24px; }
        .modal-footer { padding: 14px 24px; border-top: 1px solid var(--border); display: flex; gap: 12px; flex-shrink: 0; }
        .modal-footer input { flex: 1; padding: 12px 18px; border: 2px solid var(--border); border-radius: 30px; outline: none; font-size: 14px; background: var(--bg); color: var(--text); direction: rtl; transition: var(--transition); font-family: var(--font); }
        .modal-footer input:focus { border-color: var(--primary); box-shadow: 0 0 0 4px rgba(108,99,255,0.1); }
        .modal-footer button { background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: white; border: none; padding: 12px 28px; border-radius: 30px; font-weight: 700; cursor: pointer; transition: var(--transition); font-family: var(--font); }
        .modal-footer button:hover { transform: scale(1.02); box-shadow: 0 4px 16px rgba(108,99,255,0.3); }
        
        /* ===== Comments ===== */
        .comment-item { display: flex; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--border); animation: fadeIn 0.3s ease; }
        .comment-item:last-child { border-bottom: none; }
        .comment-avatar { width: 40px; height: 40px; border-radius: 50%; overflow: hidden; flex-shrink: 0; background: var(--border); }
        .comment-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .comment-content { flex: 1; }
        .comment-username { font-weight: 700; font-size: 14px; color: var(--text); }
        .comment-text { font-size: 14px; color: var(--text-secondary); margin-top: 4px; line-height: 1.6; }
        .comment-time { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
        
        /* ===== Profile ===== */
        .profile-page { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: var(--bg); z-index: 150; overflow-y: auto; padding-top: var(--header-height); }
        .profile-page.active { display: block; }
        .profile-header-bar { position: fixed; top: 0; left: 0; right: 0; background: var(--glass-bg); backdrop-filter: blur(20px); padding: 0 20px; height: var(--header-height); border-bottom: 1px solid var(--glass-border); z-index: 151; display: flex; justify-content: space-between; align-items: center; }
        .profile-header-bar h2 { font-size: 18px; font-weight: 700; color: var(--text); }
        .profile-header-bar .close-profile { font-size: 28px; cursor: pointer; color: var(--text-muted); background: none; border: none; transition: var(--transition); width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        .profile-header-bar .close-profile:hover { background: var(--bg-hover); color: var(--text); transform: rotate(90deg); }
        .profile-info { background: var(--bg-card); padding: 24px 20px; display: flex; flex-direction: column; align-items: center; border-bottom: 1px solid var(--border); }
        .profile-avatar-large { width: 110px; height: 110px; border-radius: 50%; overflow: hidden; border: 4px solid var(--primary); margin-bottom: 12px; transition: var(--transition); }
        .profile-avatar-large img { width: 100%; height: 100%; object-fit: cover; }
        .profile-username { font-size: 22px; font-weight: 800; color: var(--text); }
        .profile-fullname { font-size: 15px; color: var(--text-secondary); margin-top: 2px; }
        .profile-bio { font-size: 14px; color: var(--text-secondary); margin: 8px 0; text-align: center; padding: 0 20px; line-height: 1.6; }
        .profile-stats { display: flex; justify-content: space-around; padding: 18px 0; background: var(--bg-card); border-bottom: 1px solid var(--border); width: 100%; }
        .profile-stats .stat { display: flex; flex-direction: column; align-items: center; cursor: pointer; transition: var(--transition); padding: 4px 16px; border-radius: var(--radius-sm); }
        .profile-stats .stat:hover { background: var(--bg-hover); transform: scale(1.05); }
        .profile-stats .stat .number { font-size: 20px; font-weight: 800; color: var(--text); }
        .profile-stats .stat .label { font-size: 13px; color: var(--text-muted); }
        .profile-follow-btn { padding: 10px 40px; background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: white; border: none; border-radius: 30px; cursor: pointer; font-weight: 700; font-size: 15px; margin: 8px 0; transition: var(--transition); font-family: var(--font); }
        .profile-follow-btn:hover { transform: scale(1.03); box-shadow: 0 4px 20px rgba(108,99,255,0.3); }
        .profile-follow-btn.following { background: var(--bg); color: var(--text); border: 2px solid var(--border); }
        .profile-gallery { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; }
        .profile-post { aspect-ratio: 1; overflow: hidden; background: var(--border); position: relative; cursor: pointer; border-radius: 4px; transition: var(--transition); }
        .profile-post:hover { transform: scale(1.02); }
        .profile-post img { width: 100%; height: 100%; object-fit: cover; }
        .profile-post .overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; gap: 20px; color: white; opacity: 0; transition: var(--transition); }
        .profile-post:hover .overlay { opacity: 1; }
        .profile-post .overlay span { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 700; }
        
        /* ===== Upload ===== */
        .upload-page { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: var(--bg); z-index: 150; overflow-y: auto; padding-top: var(--header-height); }
        .upload-page.active { display: block; }
        .upload-header { position: fixed; top: 0; left: 0; right: 0; background: var(--glass-bg); backdrop-filter: blur(20px); padding: 0 20px; height: var(--header-height); border-bottom: 1px solid var(--glass-border); z-index: 151; display: flex; justify-content: space-between; align-items: center; }
        .upload-header h2 { font-size: 18px; font-weight: 700; color: var(--text); }
        .upload-header .close-upload { font-size: 28px; cursor: pointer; color: var(--text-muted); background: none; border: none; transition: var(--transition); width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        .upload-header .close-upload:hover { background: var(--bg-hover); color: var(--text); transform: rotate(90deg); }
        .upload-container { background: var(--bg-card); margin: 16px 20px; border-radius: var(--radius-lg); padding: 40px 24px; border: 2px dashed var(--border); text-align: center; min-height: 300px; display: flex; flex-direction: column; align-items: center; justify-content: center; transition: var(--transition); }
        .upload-container:hover { border-color: var(--primary); box-shadow: 0 0 0 4px rgba(108,99,255,0.05); }
        .upload-container i { font-size: 64px; color: var(--primary); margin-bottom: 16px; }
        .upload-container h3 { font-size: 20px; font-weight: 700; color: var(--text); margin-bottom: 8px; }
        .upload-container p { font-size: 14px; color: var(--text-secondary); margin-bottom: 20px; }
        .upload-container input[type="file"] { display: none; }
        .upload-container .upload-btn { padding: 12px 36px; background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: white; border: none; border-radius: 30px; cursor: pointer; font-weight: 700; font-size: 16px; transition: var(--transition); font-family: var(--font); }
        .upload-container .upload-btn:hover { transform: scale(1.03); box-shadow: 0 4px 20px rgba(108,99,255,0.3); }
        .upload-preview { display: none; margin-top: 20px; width: 100%; max-width: 400px; }
        .upload-preview.active { display: block; }
        .upload-preview img, .upload-preview video { width: 100%; border-radius: var(--radius-sm); max-height: 400px; object-fit: cover; }
        .upload-caption { display: none; margin-top: 16px; width: 100%; max-width: 400px; }
        .upload-caption.active { display: block; }
        .upload-caption textarea { width: 100%; padding: 12px 16px; border: 2px solid var(--border); border-radius: var(--radius-sm); outline: none; font-size: 14px; font-family: var(--font); resize: vertical; min-height: 80px; background: var(--bg); color: var(--text); direction: rtl; transition: var(--transition); }
        .upload-caption textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 4px rgba(108,99,255,0.05); }
        .upload-hashtags { display: none; margin-top: 12px; width: 100%; max-width: 400px; }
        .upload-hashtags.active { display: block; }
        .upload-hashtags input { width: 100%; padding: 12px 16px; border: 2px solid var(--border); border-radius: var(--radius-sm); outline: none; font-size: 14px; background: var(--bg); color: var(--text); direction: rtl; transition: var(--transition); font-family: var(--font); }
        .upload-hashtags input:focus { border-color: var(--primary); box-shadow: 0 0 0 4px rgba(108,99,255,0.05); }
        .upload-submit { display: none; margin-top: 16px; padding: 14px 44px; background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: white; border: none; border-radius: 30px; cursor: pointer; font-weight: 700; font-size: 16px; transition: var(--transition); font-family: var(--font); }
        .upload-submit.active { display: inline-block; }
        .upload-submit:hover { transform: scale(1.03); box-shadow: 0 4px 20px rgba(108,99,255,0.3); }
        
        /* ===== Chat ===== */
        .chat-interface { display: none; position: fixed; bottom: var(--bottom-nav-height); left: 0; right: 0; top: var(--header-height); background: var(--bg-card); z-index: 200; flex-direction: column; border-top: 1px solid var(--border); }
        .chat-interface.active { display: flex; }
        .chat-header-bar { padding: 14px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
        .chat-header-bar h3 { font-size: 16px; font-weight: 700; color: var(--text); }
        .chat-header-bar .close-chat { font-size: 28px; cursor: pointer; color: var(--text-muted); background: none; border: none; transition: var(--transition); width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        .chat-header-bar .close-chat:hover { background: var(--bg-hover); color: var(--text); transform: rotate(90deg); }
        .chat-users-list { border-bottom: 1px solid var(--border); max-height: 150px; overflow-y: auto; flex-shrink: 0; background: var(--bg); }
        .chat-user { display: flex; align-items: center; gap: 14px; padding: 12px 20px; cursor: pointer; border-bottom: 1px solid var(--border); transition: var(--transition); }
        .chat-user:hover { background: var(--bg-hover); }
        .chat-user .user-avatar { width: 44px; height: 44px; border-radius: 50%; overflow: hidden; background: var(--border); flex-shrink: 0; }
        .chat-user .user-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .chat-user .user-name { font-size: 14px; color: var(--text); font-weight: 600; }
        .chat-user .user-status { font-size: 12px; color: var(--text-muted); }
        .chat-user .user-status.online { color: var(--success); }
        .chat-messages { flex: 1; overflow-y: auto; padding: 20px; background: var(--bg); display: flex; flex-direction: column; gap: 8px; }
        .chat-message { max-width: 75%; padding: 12px 18px; border-radius: 20px; background: var(--bg-card); border: 1px solid var(--border); align-self: flex-start; word-wrap: break-word; animation: messageIn 0.2s ease; }
        @keyframes messageIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .chat-message.own { align-self: flex-end; background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: white; border: none; }
        .chat-message .msg-user { font-size: 11px; font-weight: 700; color: var(--primary); margin-bottom: 4px; }
        .chat-message.own .msg-user { color: rgba(255,255,255,0.8); }
        .chat-message .msg-text { font-size: 14px; line-height: 1.5; }
        .chat-message .msg-time { font-size: 10px; color: var(--text-muted); margin-top: 4px; text-align: left; }
        .chat-message.own .msg-time { color: rgba(255,255,255,0.6); }
        .chat-input { display: flex; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--border); background: var(--bg-card); flex-shrink: 0; }
        .chat-input input { flex: 1; padding: 12px 18px; border: 2px solid var(--border); border-radius: 30px; outline: none; font-size: 14px; background: var(--bg); color: var(--text); direction: rtl; transition: var(--transition); font-family: var(--font); }
        .chat-input input:focus { border-color: var(--primary); box-shadow: 0 0 0 4px rgba(108,99,255,0.05); }
        .chat-input button { padding: 12px 24px; background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: white; border: none; border-radius: 30px; cursor: pointer; font-size: 16px; transition: var(--transition); }
        .chat-input button:hover { transform: scale(1.03); box-shadow: 0 4px 16px rgba(108,99,255,0.3); }
        .chat-empty { text-align: center; padding: 50px 20px; color: var(--text-muted); }
        .chat-empty i { font-size: 48px; display: block; margin-bottom: 12px; color: var(--border); }
        
        /* ===== Admin Panel ===== */
        .admin-panel { display: none; position: fixed; top: var(--header-height); left: 0; right: 0; bottom: var(--bottom-nav-height); background: var(--bg); z-index: 145; overflow-y: auto; padding: 20px; }
        .admin-panel.active { display: block; }
        .admin-panel .admin-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .admin-panel .admin-header h2 { font-size: 24px; font-weight: 800; color: var(--text); }
        .admin-panel .admin-header h2 i { color: var(--primary); }
        .admin-panel .close-admin { font-size: 28px; cursor: pointer; color: var(--text-muted); background: none; border: none; transition: var(--transition); width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        .admin-panel .close-admin:hover { background: var(--bg-hover); color: var(--text); transform: rotate(90deg); }
        .admin-card { background: var(--bg-card); border-radius: var(--radius-lg); padding: 20px 24px; margin-bottom: 16px; border: 1px solid var(--border); transition: var(--transition); }
        .admin-card:hover { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(108,99,255,0.05); }
        .admin-card h4 { font-size: 16px; font-weight: 700; color: var(--text); margin-bottom: 12px; }
        .admin-card h4 i { color: var(--primary); margin-left: 8px; }
        .admin-card .admin-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
        .admin-card .admin-item:last-child { border-bottom: none; }
        .admin-btn { padding: 6px 16px; border: none; border-radius: 20px; cursor: pointer; font-size: 12px; font-weight: 700; transition: var(--transition); font-family: var(--font); }
        .admin-btn.danger { background: var(--danger); color: white; }
        .admin-btn.success { background: var(--success); color: white; }
        .admin-btn.primary { background: var(--primary); color: white; }
        .admin-btn:hover { transform: scale(1.05); }
        .admin-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
        .admin-stat-box { background: var(--bg); padding: 16px; border-radius: var(--radius-sm); text-align: center; border: 1px solid var(--border); }
        .admin-stat-box .num { font-size: 28px; font-weight: 800; color: var(--primary); }
        .admin-stat-box .lbl { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
        
        /* ===== Side Menu ===== */
        .side-menu { position: fixed; top: 0; right: -320px; width: 300px; height: 100%; background: var(--glass-bg); backdrop-filter: blur(30px); z-index: 601; transition: right 0.4s cubic-bezier(0.4,0,0.2,1); padding-top: 20px; border-left: 1px solid var(--glass-border); overflow-y: auto; }
        .side-menu.active { right: 0; }
        .side-menu .menu-header { padding: 20px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
        .side-menu .menu-header h3 { font-size: 20px; font-weight: 800; color: var(--text); }
        .side-menu .menu-header .close-menu { font-size: 28px; cursor: pointer; color: var(--text-muted); background: none; border: none; transition: var(--transition); width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        .side-menu .menu-header .close-menu:hover { background: var(--bg-hover); color: var(--text); transform: rotate(90deg); }
        .side-menu .menu-item { display: flex; align-items: center; gap: 16px; padding: 16px 24px; border-bottom: 1px solid var(--border); cursor: pointer; color: var(--text); transition: var(--transition); }
        .side-menu .menu-item:hover { background: var(--bg-hover); }
        .side-menu .menu-item i { font-size: 20px; width: 28px; color: var(--text-muted); }
        .side-menu .menu-item .menu-text { font-size: 15px; font-weight: 600; }
        .side-menu .menu-item .menu-badge { margin-right: auto; background: linear-gradient(135deg, var(--primary), var(--secondary)); color: white; font-size: 11px; padding: 2px 12px; border-radius: 20px; font-weight: 700; }
        .side-menu .menu-item.admin-item { background: rgba(108,99,255,0.05); border-right: 3px solid var(--primary); }
        .menu-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); z-index: 600; }
        .menu-overlay.active { display: block; }
        
        /* ===== Toast ===== */
        .toast { position: fixed; bottom: calc(var(--bottom-nav-height) + 20px); left: 50%; transform: translateX(-50%); background: var(--glass-bg); backdrop-filter: blur(20px); color: var(--text); padding: 14px 28px; border-radius: 30px; font-size: 14px; z-index: 999; opacity: 0; transition: opacity 0.4s ease; pointer-events: none; max-width: 90%; text-align: center; font-weight: 500; border: 1px solid var(--glass-border); box-shadow: var(--shadow); }
        .toast.show { opacity: 1; }
        .broadcast { background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: white; padding: 12px 20px; text-align: center; font-size: 14px; flex-shrink: 0; display: none; font-weight: 600; animation: slideDown 0.5s ease; }
        .broadcast.show { display: block; }
        @keyframes slideDown { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
        .no-posts { text-align: center; padding: 60px 20px; color: var(--text-muted); grid-column: 1 / -1; }
        .no-posts i { font-size: 56px; color: var(--border); display: block; margin-bottom: 16px; }
        .no-posts h3 { font-size: 18px; font-weight: 700; color: var(--text); margin-bottom: 8px; }
        .loading-spinner { display: flex; justify-content: center; align-items: center; padding: 40px; gap: 12px; }
        .loading-spinner .spinner { width: 40px; height: 40px; border: 4px solid var(--border); border-top: 4px solid var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .loading-spinner .text { color: var(--text-secondary); font-size: 14px; font-weight: 500; }
        
        /* ===== Responsive ===== */
        @media (max-width: 768px) {
            .gallery { gap: 3px; padding: 3px; }
            .search-box { max-width: 180px; padding: 8px 14px; }
            .modal-content { max-width: 95%; max-height: 90vh; }
            .login-box { padding: 30px 20px; }
            .header { padding: 0 12px; gap: 10px; }
            .header .logo { font-size: 18px; }
            .header-right { gap: 10px; font-size: 18px; }
            .story-avatar { width: 58px; height: 58px; }
            .post-overlay .action-btn { font-size: 11px; padding: 6px 10px; }
            .admin-stats-grid { grid-template-columns: repeat(2, 1fr); }
            .chat-message { max-width: 85%; }
        }
        @media (max-width: 480px) {
            .gallery { gap: 2px; padding: 2px; }
            .search-box { max-width: 120px; padding: 6px 10px; }
            .header { padding: 0 8px; gap: 6px; }
            .header .logo { font-size: 15px; }
            .header-right { gap: 6px; font-size: 16px; }
            .story-avatar { width: 50px; height: 50px; }
            .bottom-nav button { padding: 4px 12px; font-size: 9px; }
            .bottom-nav button i { font-size: 20px; }
            .login-box { padding: 24px 16px; }
            .profile-avatar-large { width: 80px; height: 80px; }
            .chat-message { max-width: 90%; padding: 10px 14px; }
            .side-menu { width: 280px; right: -290px; }
            .modal-footer { flex-wrap: wrap; }
        }
    </style>
</head>
<body>

<div id="toast" class="toast"></div>
<div id="broadcast" class="broadcast"></div>

<!-- Login -->
<div id="loginPage" class="login-container">
    <div class="login-box">
        <div class="logo">✨ <span>سوشال</span></div>
        <div class="subtitle">شبکه اجتماعی سازمانی</div>
        <div id="loginError" class="error"></div>
        <input type="text" id="loginUsername" placeholder="نام کاربری" style="display:none;">
        <input type="text" id="loginFullName" placeholder="نام کامل" style="display:none;">
        <input type="email" id="loginEmail" placeholder="ایمیل" autocomplete="email">
        <input type="password" id="loginPassword" placeholder="رمز عبور" autocomplete="current-password">
        <button class="btn-primary" id="loginBtn">ورود</button>
        <div class="toggle-link" id="toggleAuth">ثبت نام ندارید؟ ثبت نام کنید</div>
    </div>
</div>

<!-- Main App -->
<div id="mainApp" style="display:none;flex-direction:column;height:100vh;">
    <header class="header">
        <div class="logo"><i class="fas fa-bolt"></i> سوشال</div>
        <div class="search-box"><i class="fas fa-search"></i><input id="searchInput" placeholder="جستجو..."></div>
        <div class="header-right">
            <i class="fas fa-comment-dots" id="chatOpenBtn"></i>
            <i class="fas fa-bars" id="menuIcon"></i>
        </div>
    </header>

    <div class="stories-section"><div class="stories-container" id="storiesContainer"></div></div>

    <div class="gallery-wrapper">
        <div id="loadingIndicator" class="loading-spinner"><div class="spinner"></div><span class="text">در حال بارگذاری...</span></div>
        <div class="gallery" id="gallery"></div>
        <div id="noPostsMessage" class="no-posts" style="display:none;"><i class="fas fa-camera"></i><h3>هیچ پستی وجود ندارد</h3><p>اولین پست خود را منتشر کنید!</p></div>
    </div>

    <!-- Chat -->
    <div class="chat-interface" id="chatInterface">
        <div class="chat-header-bar"><h3 id="chatTitle">💬 چت</h3><button class="close-chat" id="closeChatBtn">&times;</button></div>
        <div class="chat-users-list" id="chatUsersList"></div>
        <div class="chat-messages" id="chatMessages"><div class="chat-empty"><i class="fas fa-comments"></i>برای شروع چت، یک کاربر را انتخاب کنید</div></div>
        <div class="chat-input"><input type="text" id="chatInput" placeholder="پیام خود را بنویسید..."><button id="chatSendBtn"><i class="fas fa-paper-plane"></i></button></div>
    </div>

    <!-- Comment Modal -->
    <div class="modal-overlay" id="commentModal">
        <div class="modal-content">
            <div class="modal-header"><h3>💬 کامنت‌ها</h3><button class="close-modal" id="closeModal">&times;</button></div>
            <div class="modal-body" id="commentList"></div>
            <div class="modal-footer"><input type="text" id="modalCommentInput" placeholder="کامنت خود را بنویسید..."><button id="modalSendComment">ارسال</button></div>
        </div>
    </div>

    <!-- Profile -->
    <div class="profile-page" id="profilePage">
        <div class="profile-header-bar"><h2>👤 پروفایل</h2><button class="close-profile" id="closeProfile">&times;</button></div>
        <div style="margin-top:var(--header-height);">
            <div class="profile-info">
                <div class="profile-avatar-large"><img id="profileAvatar" src="https://i.pravatar.cc/150?img=10" alt="profile"></div>
                <div class="profile-username" id="profileUsername">کاربر</div>
                <div class="profile-fullname" id="profileFullName">نام کامل</div>
                <div class="profile-bio" id="profileBio">بیوگرافی خود را بنویسید</div>
                <button class="profile-follow-btn" id="profileFollowBtn">دنبال کردن</button>
                <div style="display:flex;gap:10px;margin:12px 0;width:100%;max-width:320px;flex-wrap:wrap;">
                    <input type="text" id="bioInput" placeholder="بیوگرافی جدید..." style="flex:1;padding:10px 14px;border:2px solid var(--border);border-radius:30px;outline:none;font-size:14px;background:var(--bg);color:var(--text);direction:rtl;font-family:var(--font);">
                    <button id="saveBioBtn" style="padding:10px 24px;background:linear-gradient(135deg,var(--primary),var(--primary-dark));color:white;border:none;border-radius:30px;cursor:pointer;font-weight:700;font-size:14px;transition:var(--transition);font-family:var(--font);">ذخیره</button>
                </div>
                <div style="display:flex;gap:10px;width:100%;max-width:320px;flex-wrap:wrap;">
                    <input type="text" id="usernameInput" placeholder="نام کاربری جدید..." style="flex:1;padding:10px 14px;border:2px solid var(--border);border-radius:30px;outline:none;font-size:14px;background:var(--bg);color:var(--text);direction:rtl;font-family:var(--font);">
                    <button id="saveUsernameBtn" style="padding:10px 24px;background:linear-gradient(135deg,var(--primary),var(--primary-dark));color:white;border:none;border-radius:30px;cursor:pointer;font-weight:700;font-size:14px;transition:var(--transition);font-family:var(--font);">تغیر</button>
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

    <!-- Upload -->
    <div class="upload-page" id="uploadPage">
        <div class="upload-header"><h2>📤 آپلود</h2><button class="close-upload" id="closeUpload">&times;</button></div>
        <div style="margin-top:var(--header-height);padding:10px;">
            <div class="upload-container">
                <i class="fas fa-cloud-upload-alt"></i><h3>انتخاب فایل</h3><p>برای آپلود عکس یا ویدئو کلیک کنید</p>
                <button class="upload-btn" id="uploadSelectBtn">انتخاب فایل</button>
                <input type="file" id="fileInput" accept="image/*,video/*">
                <div class="upload-preview" id="uploadPreview"><img id="previewImage" style="display:none;"><video id="previewVideo" controls style="display:none;"></video></div>
                <div class="upload-caption" id="uploadCaption"><textarea id="captionInput" placeholder="توضیحات پست..."></textarea></div>
                <div class="upload-hashtags" id="uploadHashtags"><input type="text" id="hashtagInput" placeholder="هشتگ‌ها (با کاما جدا کنید)"></div>
                <button class="upload-submit" id="uploadSubmit">📤 ارسال پست</button>
            </div>
        </div>
    </div>

    <!-- Admin Panel -->
    <div class="admin-panel" id="adminPanel">
        <div class="admin-header"><h2><i class="fas fa-crown"></i> پنل مدیریت</h2><button class="close-admin" id="closeAdmin">&times;</button></div>
        <div class="admin-card">
            <h4>📊 آمار کلی</h4>
            <div class="admin-stats-grid">
                <div class="admin-stat-box"><div class="num" id="adminUserCount">0</div><div class="lbl">کاربران</div></div>
                <div class="admin-stat-box"><div class="num" id="adminPostCount">0</div><div class="lbl">پست‌ها</div></div>
                <div class="admin-stat-box"><div class="num" id="adminOnlineCount">0</div><div class="lbl">آنلاین</div></div>
                <div class="admin-stat-box"><div class="num" id="adminShardCount">0</div><div class="lbl">شاردها</div></div>
            </div>
        </div>
        <div class="admin-card">
            <h4>📢 پیام همگانی</h4>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <input type="text" id="broadcastInput" placeholder="پیام به همه کاربران..." style="flex:1;padding:12px 16px;border:2px solid var(--border);border-radius:30px;outline:none;font-size:14px;background:var(--bg);color:var(--text);font-family:var(--font);min-width:180px;">
                <button id="broadcastBtn" class="admin-btn primary" style="padding:12px 28px;">ارسال</button>
            </div>
        </div>
        <div class="admin-card"><h4>👥 مدیریت کاربران</h4><div id="adminUsersList"></div></div>
        <div class="admin-card"><h4>📸 مدیریت پست‌ها</h4><div id="adminPostsList"></div></div>
        <div class="admin-card">
            <h4>⚡ مدیریت شاردها</h4>
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                <span style="color:var(--text-secondary);">تعداد شاردها: <strong id="adminShardCountDisplay" style="color:var(--primary);">0</strong></span>
                <button id="addShardBtn" class="admin-btn success" style="padding:10px 24px;">➕ اضافه کردن شارد</button>
            </div>
        </div>
        <div class="admin-card">
            <h4>💾 پشتیبان‌گیری</h4>
            <button id="backupBtn" class="admin-btn primary" style="padding:10px 24px;">📦 پشتیبان‌گیری بگیر</button>
        </div>
    </div>

    <!-- Side Menu -->
    <div class="menu-overlay" id="menuOverlay"></div>
    <div class="side-menu" id="sideMenu">
        <div class="menu-header"><h3>📋 منو</h3><button class="close-menu" id="closeMenu">&times;</button></div>
        <div class="menu-item" id="menuProfile"><i class="fas fa-user"></i><span class="menu-text">پروفایل</span></div>
        <div class="menu-item" id="menuUpload"><i class="fas fa-upload"></i><span class="menu-text">آپلود</span></div>
        <div class="menu-item" id="menuTheme"><i class="fas fa-palette"></i><span class="menu-text">تغیر تم</span></div>
        <div class="menu-item admin-item" id="menuAdmin" style="display:none;"><i class="fas fa-crown"></i><span class="menu-text">پنل مدیریت</span><span class="menu-badge">ادمین</span></div>
        <div class="menu-item" id="menuLogout"><i class="fas fa-sign-out-alt"></i><span class="menu-text">خروج</span></div>
    </div>

    <!-- Bottom Nav -->
    <nav class="bottom-nav">
        <button id="profileNavBtn"><i class="fas fa-user"></i><span>پروفایل</span></button>
        <button id="uploadNavBtn"><i class="fas fa-upload"></i><span>آپلود</span></button>
        <button id="exploreNavBtn" class="active"><i class="fas fa-compass"></i><span>اکسپلور</span></button>
        <button id="adminNavBtn" style="display:none;"><i class="fas fa-crown"></i><span>مدیریت</span><span class="badge">●</span></button>
    </nav>
</div>

<script>
// ============================================================
// 🌐 STATE MANAGEMENT
// ============================================================

const STATE = {
    token: localStorage.getItem('token') || null,
    user: null,
    socket: null,
    isAdmin: false,
    isLogin: true,
    currentPostId: null,
    currentChatRoom: null,
    currentChatUser: null,
    isDarkTheme: localStorage.getItem('theme') === 'dark'
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ============================================================
// 🛠 UTILITY FUNCTIONS
// ============================================================

function showToast(msg, duration = 3500) {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.remove('show'), duration);
}

function showError(msg) { $('#loginError').textContent = msg; }
function clearError() { $('#loginError').textContent = ''; }

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

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num;
}

// ============================================================
// 🔐 AUTHENTICATION
// ============================================================

async function registerUser(username, fullName, email, password) {
    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, fullName, email, password })
        });
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در ارتباط با سرور');
        return { success: false, error: 'خطا در ارتباط با سرور' };
    }
}

async function loginUser(email, password) {
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در ارتباط با سرور');
        return { success: false, error: 'خطا در ارتباط با سرور' };
    }
}

async function logoutUser() {
    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: STATE.token })
        });
    } catch (error) {}
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

// ============================================================
// 📡 API CALLS
// ============================================================

async function getPosts(page = 1, hashtag = null) {
    try {
        let url = '/api/posts?page=' + page + '&limit=20';
        if (hashtag) url += '&hashtag=' + encodeURIComponent(hashtag);
        const res = await fetch(url);
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در دریافت پست‌ها');
        return { success: false, posts: [], total: 0 };
    }
}

async function getPost(postId) {
    try {
        const res = await fetch('/api/posts/' + postId);
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در دریافت پست');
        return null;
    }
}

async function createPost(file, caption, hashtags) {
    try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('caption', caption || '');
        formData.append('userId', STATE.user?.userId || 'user1');
        formData.append('username', STATE.user?.username || 'کاربر');
        if (hashtags) formData.append('hashtags', hashtags);
        const res = await fetch('/api/posts', { method: 'POST', body: formData });
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در ارسال پست');
        return null;
    }
}

async function likePost(postId) {
    try {
        const res = await fetch('/api/posts/' + postId + '/like', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: STATE.user?.userId || 'user1' })
        });
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در لایک');
        return { liked: false, likes: 0 };
    }
}

async function addComment(postId, text) {
    try {
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
    } catch (error) {
        showToast('❌ خطا در ارسال کامنت');
        return null;
    }
}

async function getStories() {
    try {
        const res = await fetch('/api/stories');
        return await res.json();
    } catch (error) {
        return { success: false, stories: [] };
    }
}

async function createStory(file) {
    try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('userId', STATE.user?.userId || 'user1');
        formData.append('username', STATE.user?.username || 'کاربر');
        const res = await fetch('/api/stories', { method: 'POST', body: formData });
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در ارسال استوری');
        return null;
    }
}

async function getUsers() {
    try {
        const res = await fetch('/api/users');
        return await res.json();
    } catch (error) {
        return { success: false, users: [] };
    }
}

async function updateProfile(data) {
    try {
        const res = await fetch('/api/users/' + STATE.user?.userId + '/profile', {
            method: 'PUT',
            headers: {
                'Authorization': 'Bearer ' + STATE.token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در به‌روزرسانی');
        return null;
    }
}

async function followUser(userId) {
    try {
        const res = await fetch('/api/users/' + userId + '/follow', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + STATE.token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ followerId: STATE.user?.userId })
        });
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در دنبال کردن');
        return null;
    }
}

// ===== Admin API =====
async function getAdminUsers() {
    try {
        const res = await fetch('/api/admin/users', {
            headers: { 'Authorization': 'Bearer ' + STATE.token }
        });
        return await res.json();
    } catch (error) {
        return { success: false, users: [] };
    }
}

async function banUser(userId, banned) {
    try {
        const res = await fetch('/api/admin/users/' + userId + '/ban', {
            method: 'PUT',
            headers: {
                'Authorization': 'Bearer ' + STATE.token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ banned })
        });
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در مسدودیت');
        return null;
    }
}

async function deletePostAdmin(postId) {
    try {
        const res = await fetch('/api/admin/posts/' + postId, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + STATE.token }
        });
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در حذف پست');
        return null;
    }
}

async function getAdminPosts() {
    try {
        const res = await fetch('/api/admin/posts', {
            headers: { 'Authorization': 'Bearer ' + STATE.token }
        });
        return await res.json();
    } catch (error) {
        return { success: false, posts: [] };
    }
}

async function broadcastMessage(message) {
    try {
        const res = await fetch('/api/admin/broadcast', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + STATE.token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ message })
        });
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در ارسال پیام');
        return null;
    }
}

async function getAdminStats() {
    try {
        const res = await fetch('/api/admin/stats', {
            headers: { 'Authorization': 'Bearer ' + STATE.token }
        });
        return await res.json();
    } catch (error) {
        return { success: false, stats: null };
    }
}

async function addShard() {
    try {
        const res = await fetch('/api/admin/add-shard', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + STATE.token }
        });
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در افزودن شارد');
        return null;
    }
}

async function backupSystem() {
    try {
        const res = await fetch('/api/admin/backup', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + STATE.token }
        });
        return await res.json();
    } catch (error) {
        showToast('❌ خطا در پشتیبان‌گیری');
        return null;
    }
}

// ============================================================
// 💬 SOCKET
// ============================================================

function connectSocket() {
    if (STATE.socket) return;
    STATE.socket = io();

    STATE.socket.on('connect', () => {
        if (STATE.user) {
            STATE.socket.emit('register', {
                userId: STATE.user.userId,
                username: STATE.user.username,
                token: STATE.token
            });
        }
    });

    STATE.socket.on('users-online', (users) => { renderChatUsers(); });

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
        const b = $('#broadcast');
        b.textContent = '📢 ' + data.message + ' (از ' + data.from + ')';
        b.classList.add('show');
        showToast('📢 پیام همگانی: ' + data.message);
        setTimeout(() => b.classList.remove('show'), 10000);
    });

    STATE.socket.on('follow-update', (data) => { loadProfile(); });
    STATE.socket.on('user-typing', (data) => {
        // Can be used for typing indicator
    });
    STATE.socket.on('error', (data) => { showToast('❌ ' + data.message); });
}

// ============================================================
// 📋 RENDER FUNCTIONS
// ============================================================

function createPostElement(post) {
    const div = document.createElement('div');
    div.className = 'post-item';
    div.dataset.id = post.postId;
    const isLiked = localStorage.getItem('liked_' + post.postId) === 'true';
    const isVideo = post.isVideo || false;

    let mediaHtml = isVideo ? 
        `<video muted loop><source src="${post.image}" type="video/mp4"></video><div class="video-icon"><i class="fas fa-play-circle"></i></div>` :
        `<img src="${post.image}" loading="lazy" alt="post">`;

    div.innerHTML = `
        <div class="post-media">${mediaHtml}</div>
        <div class="post-overlay">
            <button class="action-btn like-btn ${isLiked ? 'liked' : ''}" data-id="${post.postId}">
                <i class="${isLiked ? 'fas' : 'far'} fa-heart"></i><span class="count">${formatNumber(post.likes || 0)}</span>
            </button>
            <button class="action-btn comment-btn" data-id="${post.postId}">
                <i class="far fa-comment"></i><span class="count">${formatNumber((post.comments || []).length)}</span>
            </button>
            <button class="action-btn share-btn" data-id="${post.postId}">
                <i class="fas fa-share-alt"></i><span class="count">${formatNumber(post.shares || 0)}</span>
            </button>
            <button class="action-btn view-btn" data-id="${post.postId}">
                <i class="fas fa-eye"></i><span class="count">${formatNumber(post.views || 0)}</span>
            </button>
        </div>
    `;

    div.querySelector('.like-btn').addEventListener('click', (e) => { e.stopPropagation(); handleLike(post.postId); });
    div.querySelector('.comment-btn').addEventListener('click', (e) => { e.stopPropagation(); openComments(post.postId); });
    div.querySelector('.share-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(window.location.href + '?post=' + post.postId).then(() => showToast('✅ لینک کپی شد!'));
    });
    div.querySelector('.view-btn').addEventListener('click', (e) => { e.stopPropagation(); openPostDetail(post.postId); });
    div.addEventListener('click', () => { openPostDetail(post.postId); });

    const video = div.querySelector('video');
    if (video) {
        div.addEventListener('mouseenter', () => video.play());
        div.addEventListener('mouseleave', () => { video.pause(); video.currentTime = 0; });
    }
    return div;
}

function createStoryElement(story) {
    const div = document.createElement('div');
    div.className = 'story-item';
    div.innerHTML = `<div class="story-avatar"><img src="${story.image}" alt="story"></div><span class="story-name">${story.username}</span>`;
    div.addEventListener('click', () => { showToast('📸 استوری از ' + story.username); viewStory(story.storyId); });
    return div;
}

function createProfilePostElement(post) {
    const div = document.createElement('div');
    div.className = 'profile-post';
    div.innerHTML = `<img src="${post.image}" loading="lazy"><div class="overlay"><span><i class="fas fa-heart"></i> ${formatNumber(post.likes || 0)}</span><span><i class="fas fa-comment"></i> ${formatNumber((post.comments || []).length)}</span></div>`;
    div.addEventListener('click', () => openPostDetail(post.postId));
    return div;
}

function createCommentElement(comment) {
    const div = document.createElement('div');
    div.className = 'comment-item';
    div.innerHTML = `
        <div class="comment-avatar"><img src="https://i.pravatar.cc/150?img=${Math.floor(Math.random() * 70)}" alt="avatar"></div>
        <div class="comment-content">
            <div class="comment-username">${comment.fullName || comment.username || 'کاربر'}</div>
            <div class="comment-text">${comment.text}</div>
            <div class="comment-time">${timeAgo(comment.createdAt)}</div>
        </div>
    `;
    return div;
}

function createChatUserElement(user) {
    if (user.userId === STATE.user?.userId) return null;
    const div = document.createElement('div');
    div.className = 'chat-user';
    const statusClass = user.isOnline ? 'online' : '';
    const statusText = user.isOnline ? 'آنلاین' : 'آفلاین';
    div.innerHTML = `
        <div class="user-avatar"><img src="${user.avatar || 'https://i.pravatar.cc/150?img=' + Math.floor(Math.random() * 70)}" alt="user"></div>
        <div>
            <div class="user-name">${user.fullName || user.username}</div>
            <div class="user-status ${statusClass}">${statusText}</div>
        </div>
    `;
    div.addEventListener('click', () => startChat(user.userId, user.fullName || user.username));
    return div;
}

// ============================================================
// 📥 LOAD FUNCTIONS
// ============================================================

async function loadPosts(page = 1, hashtag = null) {
    const gallery = $('#gallery');
    const loading = $('#loadingIndicator');
    const noPosts = $('#noPostsMessage');
    
    if (page === 1) { 
        loading.style.display = 'flex'; 
        gallery.innerHTML = ''; 
        noPosts.style.display = 'none'; 
    }
    
    const data = await getPosts(page, hashtag);
    
    if (page === 1) loading.style.display = 'none';
    
    if (!data.posts || data.posts.length === 0) {
        if (page === 1) noPosts.style.display = 'block';
        return;
    }
    
    data.posts.forEach(post => gallery.appendChild(createPostElement(post)));
}

async function loadStories() {
    const container = $('#storiesContainer');
    container.innerHTML = '';
    
    const addDiv = document.createElement('div');
    addDiv.className = 'story-item';
    addDiv.innerHTML = `<div class="story-avatar add-story"><i class="fas fa-plus"></i></div><span class="story-name">افزودن</span>`;
    addDiv.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*,video/*';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (file) {
                const result = await createStory(file);
                if (result && result.success) { 
                    showToast('✅ استوری آپلود شد!'); 
                    loadStories(); 
                }
            }
        };
        input.click();
    });
    container.appendChild(addDiv);
    
    const data = await getStories();
    if (data.stories) {
        data.stories.forEach(story => container.appendChild(createStoryElement(story)));
    }
}

async function loadProfile() {
    if (!STATE.user) return;
    
    const user = STATE.user;
    $('#profileUsername').textContent = user.username || 'کاربر';
    $('#profileFullName').textContent = user.fullName || user.username || '';
    $('#profileBio').textContent = user.bio || 'بیوگرافی خود را بنویسید';
    $('#profileFollowerCount').textContent = formatNumber(user.followers || 0);
    $('#profileFollowingCount').textContent = formatNumber(user.following || 0);

    const data = await getPosts(1);
    const userPosts = data.posts ? data.posts.filter(p => p.userId === user.userId) : [];
    $('#profilePostCount').textContent = userPosts.length;

    const gallery = $('#profileGallery');
    gallery.innerHTML = '';
    if (userPosts.length === 0) {
        gallery.innerHTML = '<p style="grid-column:span 3;text-align:center;color:var(--text-muted);padding:30px;">هیچ پستی ندارید</p>';
    } else {
        userPosts.forEach(post => gallery.appendChild(createProfilePostElement(post)));
    }
}

async function loadAdminPanel() {
    if (!STATE.isAdmin) return;
    
    try {
        const statsData = await getAdminStats();
        if (statsData && statsData.success && statsData.stats) {
            const stats = statsData.stats;
            $('#adminUserCount').textContent = formatNumber(stats.database?.totalUsers || 0);
            $('#adminPostCount').textContent = formatNumber(stats.database?.totalPosts || 0);
            $('#adminOnlineCount').textContent = formatNumber(stats.database?.onlineUsers || 0);
            $('#adminShardCount').textContent = stats.database?.shardCount || 0;
            $('#adminShardCountDisplay').textContent = stats.database?.shardCount || 0;
        }
    } catch (e) {}

    try {
        const usersData = await getAdminUsers();
        if (usersData && usersData.success) {
            const list = $('#adminUsersList');
            list.innerHTML = '';
            usersData.users.forEach(user => {
                if (user.isAdmin) return;
                const div = document.createElement('div');
                div.className = 'admin-item';
                div.innerHTML = `<span>${user.fullName || user.username} (${user.email})</span><button class="admin-btn ${user.isBanned ? 'success' : 'danger'}" onclick="window.toggleBanUser('${user.userId}', ${!user.isBanned})">${user.isBanned ? 'رفع مسدودیت' : 'مسدود کردن'}</button>`;
                list.appendChild(div);
            });
            if (list.children.length === 0) {
                list.innerHTML = '<div style="color:var(--text-muted);padding:8px;">هیچ کاربر معمولی وجود ندارد</div>';
            }
        }
    } catch (e) {}

    try {
        const postsData = await getAdminPosts();
        if (postsData && postsData.success) {
            const list = $('#adminPostsList');
            list.innerHTML = '';
            postsData.posts.slice(0, 20).forEach(post => {
                const div = document.createElement('div');
                div.className = 'admin-item';
                div.innerHTML = `<span>${(post.caption || 'بدون توضیحات').substring(0, 35)}...</span><div style="display:flex;gap:8px;"><span style="color:var(--text-muted);font-size:12px;">❤️ ${post.likes || 0}</span><button class="admin-btn danger" onclick="window.deletePostAdmin('${post.postId}')">🗑️ حذف</button></div>`;
                list.appendChild(div);
            });
            if (list.children.length === 0) {
                list.innerHTML = '<div style="color:var(--text-muted);padding:8px;">هیچ پستی وجود ندارد</div>';
            }
        }
    } catch (e) {}
}

async function renderChatUsers() {
    const list = $('#chatUsersList');
    list.innerHTML = '';
    const data = await getUsers();
    if (!data.users) return;
    
    let hasUsers = false;
    data.users.forEach(user => {
        if (user.userId === STATE.user?.userId) return;
        if (user.isBanned) return;
        hasUsers = true;
        list.appendChild(createChatUserElement(user));
    });
    if (!hasUsers) {
        list.innerHTML = '<div style="padding:12px 20px;color:var(--text-muted);">هیچ کاربر دیگری وجود ندارد</div>';
    }
}

// ============================================================
// 🎯 ACTION FUNCTIONS
// ============================================================

async function handleLike(postId) {
    if (STATE.user?.isBanned) { showToast('❌ شما مسدود شده‌اید'); return; }
    const result = await likePost(postId);
    document.querySelectorAll('.like-btn[data-id="' + postId + '"]').forEach(btn => {
        const icon = btn.querySelector('i');
        const count = btn.querySelector('.count');
        if (result.liked) { 
            icon.className = 'fas fa-heart'; 
            btn.classList.add('liked'); 
        } else { 
            icon.className = 'far fa-heart'; 
            btn.classList.remove('liked'); 
        }
        count.textContent = formatNumber(result.likes || 0);
        localStorage.setItem('liked_' + postId, result.liked ? 'true' : 'false');
    });
}

async function openComments(postId) {
    if (STATE.user?.isBanned) { showToast('❌ شما مسدود شده‌اید'); return; }
    STATE.currentPostId = postId;
    const post = await getPost(postId);
    const list = $('#commentList');
    list.innerHTML = '';
    
    if (!post || !post.comments || post.comments.length === 0) {
        list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:30px;">هنوز کامنتی وجود ندارد</div>';
    } else {
        post.comments.forEach(comment => list.appendChild(createCommentElement(comment)));
    }
    $('#commentModal').classList.add('active');
    $('#modalCommentInput').focus();
}

async function openPostDetail(postId) {
    const post = await getPost(postId);
    if (!post || !post.post) { showToast('❌ پست پیدا نشد!'); return; }
    const data = post.post;
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.style.zIndex = '250';
    modal.innerHTML = `
        <div class="modal-content" style="max-width:600px;">
            <div class="modal-header"><h3>📸 ${data.fullName || data.username}</h3><button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button></div>
            <div class="modal-body" style="padding:0;">
                ${data.isVideo ? `<video src="${data.image}" controls style="width:100%;max-height:60vh;background:#000;"></video>` : `<img src="${data.image}" style="width:100%;max-height:60vh;object-fit:contain;background:#000;">`}
                <div style="padding:16px 20px;">
                    <div style="display:flex;gap:20px;margin-bottom:12px;flex-wrap:wrap;">
                        <span>❤️ <strong>${formatNumber(data.likes || 0)}</strong> لایک</span>
                        <span>💬 <strong>${formatNumber((data.comments || []).length)}</strong> کامنت</span>
                        <span>👁️ <strong>${formatNumber(data.views || 0)}</strong> بازدید</span>
                        <span>↗️ <strong>${formatNumber(data.shares || 0)}</strong> اشتراک</span>
                    </div>
                    ${data.caption ? `<p style="color:var(--text-secondary);font-size:14px;line-height:1.7;">${data.caption}</p>` : ''}
                    ${data.hashtags && data.hashtags.length > 0 ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">${data.hashtags.map(h => `<span style="color:var(--primary);font-size:13px;cursor:pointer;" onclick="searchHashtag('${h}')">#${h}</span>`).join('')}</div>` : ''}
                    <div style="margin-top:12px;font-size:12px;color:var(--text-muted);">${new Date(data.createdAt).toLocaleString('fa-IR')}</div>
                </div>
            </div>
            <div class="modal-footer">
                <input type="text" id="detailCommentInput" placeholder="کامنت خود را بنویسید...">
                <button id="detailSendComment">ارسال</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    const commentInput = modal.querySelector('#detailCommentInput');
    const sendBtn = modal.querySelector('#detailSendComment');
    const sendComment = async () => {
        const text = commentInput.value.trim();
        if (text) {
            await addComment(postId, text);
            commentInput.value = '';
            showToast('✅ کامنت ثبت شد!');
            openComments(postId);
            modal.remove();
        }
    };
    sendBtn.addEventListener('click', sendComment);
    commentInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendComment(); });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

window.searchHashtag = function(hashtag) {
    $('#searchInput').value = '#' + hashtag;
    loadPosts(1, hashtag);
    showToast('🔍 جستجو برای #' + hashtag);
};

window.viewStory = async function(storyId) {
    await fetch('/api/stories/' + storyId + '/view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: STATE.user?.userId || 'user1' })
    });
};

window.toggleBanUser = async function(userId, banned) {
    if (userId === STATE.user?.userId) { showToast('❌ نمی‌توانید خودتان را مسدود کنید'); return; }
    const result = await banUser(userId, banned);
    if (result && result.success) { 
        showToast('✅ کاربر ' + (banned ? 'مسدود' : 'رفع مسدودیت') + ' شد'); 
        loadAdminPanel(); 
    }
};

window.deletePostAdmin = async function(postId) {
    if (!confirm('آیا از حذف این پست مطمئن هستید؟')) return;
    const result = await deletePostAdmin(postId);
    if (result && result.success) { 
        showToast('✅ پست حذف شد'); 
        loadAdminPanel(); 
        loadPosts(1); 
    }
};

// ============================================================
// 💬 CHAT
// ============================================================

function startChat(userId, username) {
    if (STATE.user?.isBanned) { showToast('❌ شما مسدود شده‌اید'); return; }
    STATE.currentChatUser = userId;
    const roomId = [STATE.user?.userId, userId].sort().join('_');
    STATE.currentChatRoom = roomId;
    $('#chatTitle').textContent = '💬 ' + username;
    $('#chatInterface').classList.add('active');
    STATE.socket.emit('join-room', { roomId, userId: STATE.user?.userId });
}

function sendChatMessage() {
    if (STATE.user?.isBanned) { showToast('❌ شما مسدود شده‌اید'); return; }
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text || !STATE.currentChatRoom || !STATE.user) return;
    STATE.socket.emit('send-message', {
        roomId: STATE.currentChatRoom,
        userId: STATE.user.userId,
        username: STATE.user.fullName || STATE.user.username,
        message: text
    });
    displayChatMessage(STATE.user.userId, STATE.user.fullName || STATE.user.username, text, new Date().toISOString());
    input.value = '';
}

function displayChatMessage(userId, username, message, timestamp) {
    const messagesDiv = $('#chatMessages');
    const empty = messagesDiv.querySelector('.chat-empty');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'chat-message' + (userId === STATE.user?.userId ? ' own' : '');
    const time = timestamp ? new Date(timestamp).toLocaleTimeString('fa-IR') : '';
    div.innerHTML = `<div class="msg-user">${userId === STATE.user?.userId ? 'شما' : username}</div><div class="msg-text">${message}</div><div class="msg-time">${time}</div>`;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// ============================================================
// 🎬 EVENT LISTENERS
// ============================================================

// Login
$('#loginBtn').addEventListener('click', async () => {
    clearError();
    const username = $('#loginUsername').value.trim();
    const fullName = $('#loginFullName').value.trim();
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value.trim();

    if (!email || !password) { showError('لطفا ایمیل و رمز عبور را وارد کنید'); return; }
    if (!STATE.isLogin && !username) { showError('لطفا نام کاربری را وارد کنید'); return; }
    if (!STATE.isLogin && !fullName) { showError('لطفا نام کامل را وارد کنید'); return; }

    $('#loginBtn').textContent = '⏳';
    $('#loginBtn').disabled = true;

    let result;
    if (STATE.isLogin) {
        result = await loginUser(email, password);
    } else {
        result = await registerUser(username, fullName, email, password);
    }

    if (result && result.success) {
        STATE.token = result.token;
        localStorage.setItem('token', result.token);
        STATE.user = result.user;
        STATE.isAdmin = result.user.isAdmin || false;
        $('#loginPage').style.display = 'none';
        $('#mainApp').style.display = 'flex';
        if (STATE.isAdmin) { 
            $('#adminNavBtn').style.display = 'flex'; 
            $('#menuAdmin').style.display = 'flex'; 
        }
        connectSocket();
        loadPosts(1);
        loadStories();
        loadProfile();
        showToast('✅ خوش آمدید ' + (result.user.fullName || result.user.username));
    } else {
        showError(result?.error || 'خطا!');
    }
    $('#loginBtn').textContent = STATE.isLogin ? 'ورود' : 'ثبت نام';
    $('#loginBtn').disabled = false;
});

$('#toggleAuth').addEventListener('click', () => {
    STATE.isLogin = !STATE.isLogin;
    const title = document.querySelector('.login-box .logo');
    if (title) {
        title.innerHTML = STATE.isLogin ? '🔐 <span>ورود</span>' : '📝 <span>ثبت نام</span>';
    }
    $('#loginBtn').textContent = STATE.isLogin ? 'ورود' : 'ثبت نام';
    $('#toggleAuth').textContent = STATE.isLogin ? 'ثبت نام ندارید؟ ثبت نام کنید' : 'حساب دارید؟ وارد شوید';
    $('#loginUsername').style.display = STATE.isLogin ? 'none' : 'block';
    $('#loginFullName').style.display = STATE.isLogin ? 'none' : 'block';
    clearError();
});

$('#loginPassword').addEventListener('keypress', (e) => { if (e.key === 'Enter') $('#loginBtn').click(); });
$('#menuLogout').addEventListener('click', logoutUser);

// Profile
$('#profileNavBtn').addEventListener('click', () => { $('#profilePage').classList.add('active'); loadProfile(); });
$('#closeProfile').addEventListener('click', () => { $('#profilePage').classList.remove('active'); });
$('#profilePage').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#profilePage').classList.remove('active'); });

$('#saveBioBtn').addEventListener('click', async () => {
    const bio = $('#bioInput').value.trim();
    if (bio) {
        const result = await updateProfile({ bio });
        if (result && result.success) { 
            $('#profileBio').textContent = bio; 
            $('#bioInput').value = ''; 
            STATE.user.bio = bio; 
            showToast('✅ بیوگرافی ذخیره شد!'); 
        }
    }
});

$('#saveUsernameBtn').addEventListener('click', async () => {
    const username = $('#usernameInput').value.trim();
    if (!username) { showToast('❌ لطفا نام کاربری را وارد کنید'); return; }
    if (username.length < 3 || username.length > 30) { showToast('❌ نام کاربری باید بین 3 تا 30 کاراکتر باشد'); return; }
    const result = await updateProfile({ username });
    if (result && result.success) { 
        $('#profileUsername').textContent = username; 
        $('#usernameInput').value = ''; 
        STATE.user.username = username; 
        showToast('✅ نام کاربری تغییر کرد!'); 
    }
});

// Upload
$('#uploadNavBtn').addEventListener('click', () => {
    if (STATE.user?.isBanned) { showToast('❌ شما مسدود شده‌اید'); return; }
    $('#uploadPage').classList.add('active');
});
$('#closeUpload').addEventListener('click', () => { $('#uploadPage').classList.remove('active'); resetUpload(); });
$('#uploadPage').addEventListener('click', (e) => { if (e.target === e.currentTarget) { $('#uploadPage').classList.remove('active'); resetUpload(); } });
$('#uploadSelectBtn').addEventListener('click', () => { $('#fileInput').click(); });

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
    if (!file) { showToast('❌ لطفا یک فایل انتخاب کنید'); return; }
    const btn = $('#uploadSubmit');
    btn.textContent = '⏳';
    btn.disabled = true;
    const result = await createPost(file, caption, hashtags);
    if (result && result.success) { 
        showToast('✅ پست با موفقیت آپلود شد!'); 
        resetUpload(); 
        $('#uploadPage').classList.remove('active'); 
        loadPosts(1); 
    } else { 
        showToast('❌ خطا در آپلود'); 
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
$('#modalSendComment').addEventListener('click', async () => {
    const input = $('#modalCommentInput');
    const text = input.value.trim();
    if (text && STATE.currentPostId) {
        await addComment(STATE.currentPostId, text);
        input.value = '';
        showToast('✅ کامنت ثبت شد!');
        openComments(STATE.currentPostId);
        loadPosts(1);
    }
});
$('#modalCommentInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') $('#modalSendComment').click(); });
$('#closeModal').addEventListener('click', () => { $('#commentModal').classList.remove('active'); STATE.currentPostId = null; });
$('#commentModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) { $('#commentModal').classList.remove('active'); STATE.currentPostId = null; } });

// Chat
$('#chatOpenBtn').addEventListener('click', () => { $('#chatInterface').classList.add('active'); renderChatUsers(); });
$('#closeChatBtn').addEventListener('click', () => {
    $('#chatInterface').classList.remove('active');
    if (STATE.currentChatRoom) { STATE.socket.emit('leave-room', { roomId: STATE.currentChatRoom }); STATE.currentChatRoom = null; STATE.currentChatUser = null; }
});
$('#chatSendBtn').addEventListener('click', sendChatMessage);
$('#chatInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChatMessage(); });

// Side Menu
$('#menuIcon').addEventListener('click', () => { $('#sideMenu').classList.add('active'); $('#menuOverlay').classList.add('active'); });
$('#closeMenu').addEventListener('click', () => { $('#sideMenu').classList.remove('active'); $('#menuOverlay').classList.remove('active'); });
$('#menuOverlay').addEventListener('click', () => { $('#sideMenu').classList.remove('active'); $('#menuOverlay').classList.remove('active'); });
$('#menuProfile').addEventListener('click', () => { $('#sideMenu').classList.remove('active'); $('#menuOverlay').classList.remove('active'); $('#profilePage').classList.add('active'); loadProfile(); });
$('#menuUpload').addEventListener('click', () => { $('#sideMenu').classList.remove('active'); $('#menuOverlay').classList.remove('active'); if (STATE.user?.isBanned) { showToast('❌ شما مسدود شده‌اید'); return; } $('#uploadPage').classList.add('active'); });
$('#menuTheme').addEventListener('click', () => { toggleTheme(); $('#sideMenu').classList.remove('active'); $('#menuOverlay').classList.remove('active'); });
$('#menuAdmin').addEventListener('click', () => { $('#sideMenu').classList.remove('active'); $('#menuOverlay').classList.remove('active'); $('#adminPanel').classList.add('active'); loadAdminPanel(); });
$('#menuLogout').addEventListener('click', logoutUser);

// Admin
$('#adminNavBtn').addEventListener('click', () => { $('#adminPanel').classList.toggle('active'); if ($('#adminPanel').classList.contains('active')) loadAdminPanel(); });
$('#closeAdmin').addEventListener('click', () => { $('#adminPanel').classList.remove('active'); });
$('#adminPanel').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#adminPanel').classList.remove('active'); });
$('#broadcastBtn').addEventListener('click', async () => {
    const input = $('#broadcastInput');
    const message = input.value.trim();
    if (!message) { showToast('❌ لطفا پیام را وارد کنید'); return; }
    const result = await broadcastMessage(message);
    if (result && result.success) { showToast('✅ پیام همگانی ارسال شد!'); input.value = ''; }
});
$('#addShardBtn').addEventListener('click', async () => {
    const result = await addShard();
    if (result && result.success) { showToast('✅ شارد جدید اضافه شد! تعداد: ' + result.shardCount); loadAdminPanel(); }
});
$('#backupBtn').addEventListener('click', async () => {
    const result = await backupSystem();
    if (result && result.success) { showToast('✅ پشتیبان‌گیری انجام شد: ' + result.backupPath); } else { showToast('❌ خطا در پشتیبان‌گیری'); }
});

// Explore
$('#exploreNavBtn').addEventListener('click', () => { $('#exploreNavBtn').classList.toggle('active'); loadPosts(1); });

// Search
$('#searchInput').addEventListener('input', () => {
    const query = $('#searchInput').value.trim();
    if (query.startsWith('#')) { loadPosts(1, query.substring(1)); } 
    else if (query.length > 2) {
        const gallery = $('#gallery');
        const items = gallery.querySelectorAll('.post-item');
        items.forEach(item => { item.style.display = item.textContent.toLowerCase().includes(query.toLowerCase()) ? '' : 'none'; });
    } else {
        loadPosts(1);
        const gallery = $('#gallery');
        const items = gallery.querySelectorAll('.post-item');
        items.forEach(item => { item.style.display = ''; });
    }
});

// Theme
function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') !== 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    showToast(isDark ? '🌙 تم تاریک' : '☀️ تم روشن');
}

// ============================================================
// 🚀 INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    if (STATE.isDarkTheme) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
    
    $('#loginUsername').style.display = 'none';
    $('#loginFullName').style.display = 'none';

    if (STATE.token) {
        const userData = await getCurrentUser();
        if (userData && userData.user) {
            STATE.user = userData.user;
            STATE.isAdmin = userData.user.isAdmin || false;
            $('#loginPage').style.display = 'none';
            $('#mainApp').style.display = 'flex';
            if (STATE.isAdmin) { 
                $('#adminNavBtn').style.display = 'flex'; 
                $('#menuAdmin').style.display = 'flex'; 
            }
            connectSocket();
            loadPosts(1);
            loadStories();
            loadProfile();
            return;
        } else {
            localStorage.removeItem('token');
            STATE.token = null;
        }
    }
    $('#loginPage').style.display = 'flex';
    $('#mainApp').style.display = 'none';
});

console.log('🚀 سوشال مدیا سازمانی');
console.log('📊 256 شارد برای میلیاردها کاربر');
console.log('🔐 رمزنگاری AES-256-GCM');
console.log('👑 ادمین: (مخفی)');
console.log('💻 نسخه: 2.0.0 Enterprise');
</script>
</body>
</html>
    `);
});

// ============================================================
// 🚀 START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('═'.repeat(70));
    console.log('🏢 سوشال مدیا سازمانی - Enterprise Edition');
    console.log('═'.repeat(70));
    console.log('📡 Server: http://localhost:' + PORT);
    console.log('🗄️  Shards: ' + db.SHARD_COUNT);
    console.log('🔐 Encryption: AES-256-GCM');
    console.log('💾 Cache: Active');
    console.log('⚡ Queue: Active');
    console.log('👑 Admin: (مخفی)');
    console.log('═'.repeat(70));
    console.log('✅ سیستم با موفقیت راه‌اندازی شد!');
});

// ============================================================
// 🛡️ Graceful Shutdown
// ============================================================

process.on('SIGINT', () => {
    console.log('\n🛑 دریافت سیگنال توقف...');
    io.close(() => {
        server.close(() => {
            console.log('✅ سرور متوقف شد');
            process.exit(0);
        });
    });
});

process.on('uncaughtException', (error) => {
    log(`❌ Uncaught Exception: ${error.message}`, 'ERROR');
    console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    log(`❌ Unhandled Rejection: ${reason}`, 'ERROR');
    console.error(reason);
});