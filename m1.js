// ============================================
// 🚀 ULTIMATE SOCIAL MEDIA ENGINE - m1.js
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
const multer = require('multer');

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
// 📁 CONSTANTS
// ============================================
const PORT = process.env.PORT || 3000;
const SHARD_COUNT = 100;
const CACHE_TTL = 5 * 60 * 1000;
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
        this.createSampleData();
    }

    getShardIndex(key) {
        const hash = crypto.createHash('md5').update(key.toString()).digest('hex');
        return parseInt(hash.substring(0, 4), 16) % this.SHARD_COUNT;
    }

    generateId(prefix) {
        return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
    }

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
    // 📊 CREATE SAMPLE DATA
    // ============================================
    createSampleData() {
        const sampleUsers = [
            { username: 'milad_admin', fullName: 'مدیر سیستم', email: ADMIN_EMAIL, password: ADMIN_PASSWORD, isAdmin: true, isVerified: true },
            { username: 'ali_reza', fullName: 'علی رضایی', email: 'ali@test.com', password: 'Test123456' },
            { username: 'sara_kh', fullName: 'سارا خانی', email: 'sara@test.com', password: 'Test123456' },
            { username: 'mohammad_n', fullName: 'محمد نوری', email: 'mohammad@test.com', password: 'Test123456' }
        ];

        for (const data of sampleUsers) {
            const existing = this.getUserByEmail(data.email);
            if (!existing) {
                const userId = encryption.generateId('user');
                const user = {
                    userId,
                    username: data.username,
                    email: data.email,
                    fullName: data.fullName,
                    password: encryption.hashPassword(data.password),
                    bio: 'عاشق تکنولوژی و هنر 🎨',
                    avatar: `https://i.pravatar.cc/150?img=${Math.floor(Math.random() * 70)}`,
                    followers: Math.floor(Math.random() * 1000),
                    following: Math.floor(Math.random() * 500),
                    postsCount: 0,
                    language: 'fa',
                    theme: 'dark',
                    isOnline: false,
                    isAdmin: data.isAdmin || false,
                    isBanned: false,
                    isVerified: data.isVerified || false,
                    createdAt: new Date().toISOString(),
                    lastSeen: new Date().toISOString()
                };
                this.saveUser(user);
            }
        }

        const users = this.getAllUsers();
        if (users.length > 0 && this.getPosts(1, 1).total === 0) {
            const samplePosts = [
                { caption: 'سلام به دنیای جدید! 🚀', hashtags: ['خوش_آمدید'], image: 'https://picsum.photos/seed/1/600/600' },
                { caption: 'منظره زیبای غروب 🌅', hashtags: ['طبیعت'], image: 'https://picsum.photos/seed/2/600/600' },
                { caption: 'لحظات خوش با دوستان 🎉', hashtags: ['دوستی'], image: 'https://picsum.photos/seed/3/600/600' },
                { caption: 'قهوه صبحگاهی ☕', hashtags: ['قهوه'], image: 'https://picsum.photos/seed/4/600/600' }
            ];

            for (let i = 0; i < samplePosts.length; i++) {
                const user = users[i % users.length];
                const post = {
                    postId: this.generateId('post'),
                    userId: user.userId,
                    username: user.username,
                    fullName: user.fullName,
                    image: samplePosts[i].image,
                    caption: samplePosts[i].caption,
                    hashtags: samplePosts[i].hashtags,
                    likes: Math.floor(Math.random() * 50) + 5,
                    comments: [],
                    shares: Math.floor(Math.random() * 10),
                    views: Math.floor(Math.random() * 100) + 20,
                    isVideo: false,
                    createdAt: new Date(Date.now() - Math.random() * 7 * 86400000).toISOString()
                };
                this.savePost(post);
            }
            console.log(`📸 Sample posts created!`);
        }

        console.log('═'.repeat(50));
        console.log('📊 DATABASE READY');
        console.log('═'.repeat(50));
        console.log(`👥 Users: ${this.getAllUsers().length}`);
        console.log(`📸 Posts: ${this.getPosts(1, 1000).total}`);
        console.log('═'.repeat(50));
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

    // ============================================
    // 👥 FOLLOW SYSTEM
    // ============================================
    followUser(userId, targetId) {
        const userIdx = this.getShardIndex(userId);
        const targetIdx = this.getShardIndex(targetId);
        
        if (!this.shards[userIdx].users.has(userId) || !this.shards[targetIdx].users.has(targetId)) {
            return false;
        }

        if (!this.shards[userIdx].following.has(userId)) {
            this.shards[userIdx].following.set(userId, new Set());
        }
        if (!this.shards[targetIdx].followers.has(targetId)) {
            this.shards[targetIdx].followers.set(targetId, new Set());
        }

        const following = this.shards[userIdx].following.get(userId);
        const followers = this.shards[targetIdx].followers.get(targetId);

        if (following.has(targetId)) return false;

        following.add(targetId);
        followers.add(userId);

        const user = this.shards[userIdx].users.get(userId);
        const target = this.shards[targetIdx].users.get(targetId);
        user.following = (user.following || 0) + 1;
        target.followers = (target.followers || 0) + 1;

        this.setCache(`user:${userId}`, user);
        this.setCache(`user:${targetId}`, target);
        this.logTransaction('followUser', { userId, targetId });

        return true;
    }

    unfollowUser(userId, targetId) {
        const userIdx = this.getShardIndex(userId);
        const targetIdx = this.getShardIndex(targetId);
        
        if (!this.shards[userIdx].following.has(userId)) return false;
        
        const following = this.shards[userIdx].following.get(userId);
        if (!following.has(targetId)) return false;

        following.delete(targetId);
        
        if (this.shards[targetIdx].followers.has(targetId)) {
            this.shards[targetIdx].followers.get(targetId).delete(userId);
        }

        const user = this.shards[userIdx].users.get(userId);
        const target = this.shards[targetIdx].users.get(targetId);
        user.following = Math.max((user.following || 0) - 1, 0);
        target.followers = Math.max((target.followers || 0) - 1, 0);

        this.setCache(`user:${userId}`, user);
        this.setCache(`user:${targetId}`, target);
        this.logTransaction('unfollowUser', { userId, targetId });

        return true;
    }

    getFollowers(userId) {
        const idx = this.getShardIndex(userId);
        if (!this.shards[idx].followers.has(userId)) return [];
        const followers = this.shards[idx].followers.get(userId);
        const result = [];
        for (const id of followers) {
            const user = this.getUser(id);
            if (user) result.push(user);
        }
        return result;
    }

    getFollowing(userId) {
        const idx = this.getShardIndex(userId);
        if (!this.shards[idx].following.has(userId)) return [];
        const following = this.shards[idx].following.get(userId);
        const result = [];
        for (const id of following) {
            const user = this.getUser(id);
            if (user) result.push(user);
        }
        return result;
    }

    // ============================================
    // 📸 POSTS
    // ============================================
    savePost(post) {
        const idx = this.getShardIndex(post.postId);
        this.shards[idx].posts.unshift(post);
        this.setCache(`post:${post.postId}`, post);

        if (post.hashtags && post.hashtags.length > 0) {
            for (const tag of post.hashtags) {
                const tagKey = tag.toLowerCase();
                if (!this.shards[idx].hashtags.has(tagKey)) {
                    this.shards[idx].hashtags.set(tagKey, new Set());
                }
                this.shards[idx].hashtags.get(tagKey).add(post.postId);
            }
        }
        this.logTransaction('savePost', { postId: post.postId });
        return post;
    }

    getPosts(page = 1, limit = 20, hashtag = null, userId = null) {
        const cacheKey = `posts:${page}:${limit}:${hashtag || 'all'}:${userId || 'all'}`;
        const cached = this.getCache(cacheKey);
        if (cached) return cached;

        let allPosts = [];
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            allPosts = allPosts.concat(this.shards[i].posts);
        }

        if (hashtag) {
            const tag = hashtag.toLowerCase();
            allPosts = allPosts.filter(p => 
                p.hashtags && p.hashtags.some(h => h.toLowerCase() === tag)
            );
        }

        if (userId) {
            allPosts = allPosts.filter(p => p.userId === userId);
        }

        allPosts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const start = (page - 1) * limit;
        const result = {
            posts: allPosts.slice(start, start + limit),
            total: allPosts.length,
            page: page,
            totalPages: Math.ceil(allPosts.length / limit)
        };
        
        this.setCache(cacheKey, result);
        return result;
    }

    getPost(postId) {
        const cached = this.getCache(`post:${postId}`);
        if (cached) return cached;
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (post) this.setCache(`post:${postId}`, post);
        return post || null;
    }

    deletePost(postId) {
        const idx = this.getShardIndex(postId);
        const index = this.shards[idx].posts.findIndex(p => p.postId === postId);
        if (index !== -1) {
            const post = this.shards[idx].posts[index];
            if (post.hashtags) {
                for (const tag of post.hashtags) {
                    const tagKey = tag.toLowerCase();
                    if (this.shards[idx].hashtags.has(tagKey)) {
                        this.shards[idx].hashtags.get(tagKey).delete(postId);
                    }
                }
            }
            this.shards[idx].posts.splice(index, 1);
            this.cache.delete(`post:${postId}`);
            this.logTransaction('deletePost', { postId });
            return true;
        }
        return false;
    }

    likePost(postId, userId) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post) return { liked: false, likes: 0 };
        
        const likeKey = `${postId}_${userId}`;
        if (this.shards[idx].likes.has(likeKey)) {
            this.shards[idx].likes.delete(likeKey);
            post.likes = Math.max((post.likes || 0) - 1, 0);
            this.setCache(`post:${postId}`, post);
            return { liked: false, likes: post.likes };
        } else {
            this.shards[idx].likes.add(likeKey);
            post.likes = (post.likes || 0) + 1;
            this.setCache(`post:${postId}`, post);
            return { liked: true, likes: post.likes };
        }
    }

    viewPost(postId, userId) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post) return false;
        
        const viewKey = `${postId}_${userId}`;
        if (!this.shards[idx].views.has(viewKey)) {
            this.shards[idx].views.set(viewKey, true);
            post.views = (post.views || 0) + 1;
            this.setCache(`post:${postId}`, post);
            return true;
        }
        return false;
    }

    sharePost(postId, userId) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post) return false;
        
        const shareKey = `${postId}_${userId}`;
        if (!this.shards[idx].shares.has(shareKey)) {
            this.shards[idx].shares.set(shareKey, true);
            post.shares = (post.shares || 0) + 1;
            this.setCache(`post:${postId}`, post);
            return true;
        }
        return false;
    }

    // ============================================
    // 💬 COMMENTS
    // ============================================
    addComment(postId, comment) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post) return false;
        if (!post.comments) post.comments = [];
        post.comments.push(comment);
        this.setCache(`post:${postId}`, post);
        this.logTransaction('addComment', { postId, commentId: comment.commentId });
        return true;
    }

    deleteComment(postId, commentId, userId) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post || !post.comments) return false;
        const index = post.comments.findIndex(c => c.commentId === commentId && c.userId === userId);
        if (index === -1) return false;
        post.comments.splice(index, 1);
        this.setCache(`post:${postId}`, post);
        this.logTransaction('deleteComment', { postId, commentId });
        return true;
    }

    editComment(postId, commentId, userId, newText) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post || !post.comments) return false;
        const comment = post.comments.find(c => c.commentId === commentId && c.userId === userId);
        if (!comment) return false;
        comment.text = newText;
        comment.editedAt = new Date().toISOString();
        this.setCache(`post:${postId}`, post);
        return true;
    }

    getComments(postId) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post) return [];
        return post.comments || [];
    }

    // ============================================
    // 📸 STORIES
    // ============================================
    saveStory(story) {
        const idx = this.getShardIndex(story.storyId);
        this.shards[idx].stories.push(story);
        this.setCache(`story:${story.storyId}`, story);
        this.logTransaction('saveStory', { storyId: story.storyId });
        return story;
    }

    getStories(userId = null) {
        let allStories = [];
        const now = Date.now();
        for (let i = 0; i < this.SHARD_COUNT; i++) {
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
        const idx = this.getShardIndex(storyId);
        const index = this.shards[idx].stories.findIndex(s => s.storyId === storyId && s.userId === userId);
        if (index !== -1) {
            this.shards[idx].stories.splice(index, 1);
            this.cache.delete(`story:${storyId}`);
            this.logTransaction('deleteStory', { storyId });
            return true;
        }
        return false;
    }

    viewStory(storyId, userId) {
        const idx = this.getShardIndex(storyId);
        const story = this.shards[idx].stories.find(s => s.storyId === storyId);
        if (story && !story.viewers) {
            story.viewers = [];
        }
        if (story && !story.viewers.includes(userId)) {
            story.views = (story.views || 0) + 1;
            story.viewers.push(userId);
            this.setCache(`story:${storyId}`, story);
            return true;
        }
        return false;
    }

    // ============================================
    // 💬 MESSAGES
    // ============================================
    saveMessage(roomId, message) {
        const idx = this.getShardIndex(roomId);
        if (!this.shards[idx].messages.has(roomId)) {
            this.shards[idx].messages.set(roomId, []);
        }
        this.shards[idx].messages.get(roomId).push(message);
        this.logTransaction('saveMessage', { roomId, messageId: message.messageId });
        return message;
    }

    getMessages(roomId, limit = 50) {
        const idx = this.getShardIndex(roomId);
        if (!this.shards[idx].messages.has(roomId)) return [];
        return this.shards[idx].messages.get(roomId).slice(-limit);
    }

    // ============================================
    // 📑 BOOKMARKS
    // ============================================
    bookmarkPost(postId, userId) {
        const idx = this.getShardIndex(userId);
        if (!this.shards[idx].bookmarks.has(userId)) {
            this.shards[idx].bookmarks.set(userId, new Set());
        }
        const bookmarks = this.shards[idx].bookmarks.get(userId);
        if (bookmarks.has(postId)) {
            bookmarks.delete(postId);
            return { bookmarked: false };
        } else {
            bookmarks.add(postId);
            return { bookmarked: true };
        }
    }

    getBookmarks(userId) {
        const idx = this.getShardIndex(userId);
        if (!this.shards[idx].bookmarks.has(userId)) return [];
        const bookmarks = this.shards[idx].bookmarks.get(userId);
        const result = [];
        for (const id of bookmarks) {
            const post = this.getPost(id);
            if (post) result.push(post);
        }
        return result;
    }

    // ============================================
    // #️⃣ HASHTAGS
    // ============================================
    getTrendingHashtags(limit = 10) {
        const allHashtags = new Map();
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            for (const [tag, posts] of this.shards[i].hashtags) {
                if (!allHashtags.has(tag)) {
                    allHashtags.set(tag, 0);
                }
                allHashtags.set(tag, allHashtags.get(tag) + posts.size);
            }
        }
        const sorted = Array.from(allHashtags.entries()).sort((a, b) => b[1] - a[1]);
        return sorted.slice(0, limit).map(([tag, count]) => ({ tag, count }));
    }

    // ============================================
    // 🔔 NOTIFICATIONS
    // ============================================
    addNotification(notification) {
        const idx = this.getShardIndex(notification.userId);
        this.shards[idx].notifications.push(notification);
        return notification;
    }

    getNotifications(userId, limit = 50) {
        const idx = this.getShardIndex(userId);
        const notifs = this.shards[idx].notifications || [];
        return notifs.slice(-limit).reverse();
    }

    markNotificationRead(notificationId, userId) {
        const idx = this.getShardIndex(userId);
        const notif = this.shards[idx].notifications.find(n => n.notificationId === notificationId);
        if (notif) {
            notif.isRead = true;
            return true;
        }
        return false;
    }

    // ============================================
    // 🔴 LIVE STREAMS
    // ============================================
    startLiveStream(userId, title) {
        const idx = this.getShardIndex(userId);
        const streamId = `live_${crypto.randomBytes(16).toString('hex')}`;
        const stream = {
            streamId,
            userId,
            title,
            viewers: new Set(),
            isLive: true,
            startedAt: new Date().toISOString(),
            endedAt: null,
            maxViewers: 0,
            totalViewers: 0
        };
        this.shards[idx].liveStreams.set(streamId, stream);
        this.logTransaction('startLiveStream', { streamId, userId });
        return streamId;
    }

    endLiveStream(streamId) {
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            if (this.shards[i].liveStreams.has(streamId)) {
                const stream = this.shards[i].liveStreams.get(streamId);
                stream.isLive = false;
                stream.endedAt = new Date().toISOString();
                return true;
            }
        }
        return false;
    }

    getLiveStreams() {
        const allStreams = [];
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            for (const [key, stream] of this.shards[i].liveStreams) {
                if (stream.isLive) {
                    allStreams.push({
                        ...stream,
                        viewers: Array.from(stream.viewers)
                    });
                }
            }
        }
        return allStreams;
    }

    joinLiveStream(streamId, userId) {
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            if (this.shards[i].liveStreams.has(streamId)) {
                const stream = this.shards[i].liveStreams.get(streamId);
                if (stream.isLive && !stream.viewers.has(userId)) {
                    stream.viewers.add(userId);
                    stream.totalViewers++;
                    if (stream.viewers.size > stream.maxViewers) {
                        stream.maxViewers = stream.viewers.size;
                    }
                    return true;
                }
            }
        }
        return false;
    }

    leaveLiveStream(streamId, userId) {
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            if (this.shards[i].liveStreams.has(streamId)) {
                const stream = this.shards[i].liveStreams.get(streamId);
                stream.viewers.delete(userId);
                return true;
            }
        }
        return false;
    }

    // ============================================
    // 📊 STATS
    // ============================================
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
            bio: 'مدیر ارشد پلتفرم سوشال مدیا 🚀',
            avatar: 'https://i.pravatar.cc/150?img=12',
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
// 📤 MULTER CONFIG
// ============================================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir = './uploads/posts';
        if (file.fieldname === 'avatar') dir = './uploads/avatars';
        else if (file.fieldname === 'story') dir = './uploads/stories';
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
        cb(null, allowed.includes(file.mimetype));
    }
});

const storyUpload = multer({
    storage: multer.diskStorage({
        destination: './uploads/stories',
        filename: (req, file, cb) => {
            cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`);
        }
    }),
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'];
        cb(null, allowed.includes(file.mimetype));
    }
});

const avatarUpload = multer({
    storage: multer.diskStorage({
        destination: './uploads/avatars',
        filename: (req, file, cb) => {
            cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`);
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        cb(null, allowed.includes(file.mimetype));
    }
});

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
        theme: 'dark',
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

    const { bio, avatar, fullName, username } = req.body;
    const updates = {};
    if (bio !== undefined) updates.bio = bio;
    if (avatar !== undefined) updates.avatar = avatar;
    if (fullName !== undefined) updates.fullName = fullName;
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

app.post('/api/users/avatar', authMiddleware, avatarUpload.single('avatar'), async (req, res) => {
    const file = req.file;
    if (!file) {
        return res.status(400).json({ error: 'فایل الزامی است' });
    }

    const avatarPath = '/uploads/avatars/' + file.filename;
    db.updateUser(req.user.userId, { avatar: avatarPath });

    res.json({ success: true, avatar: avatarPath });
});

app.post('/api/users/:userId/follow', authMiddleware, (req, res) => {
    const { userId } = req.params;
    const result = db.followUser(req.user.userId, userId);
    if (!result) return res.status(400).json({ error: 'از قبل دنبال می‌کنید' });
    const target = db.getUser(userId);
    io.emit('follow-update', { userId: target.userId, followers: target.followers });
    res.json({ success: true, followers: target.followers });
});

app.post('/api/users/:userId/unfollow', authMiddleware, (req, res) => {
    const { userId } = req.params;
    const result = db.unfollowUser(req.user.userId, userId);
    if (!result) return res.status(400).json({ error: 'دنبال نمی‌کنید' });
    const target = db.getUser(userId);
    res.json({ success: true, followers: target.followers });
});

app.get('/api/users/search', authMiddleware, (req, res) => {
    const { q } = req.query;
    if (!q) return res.json([]);
    const results = db.searchUsers(q);
    res.json(results.map(u => ({ ...u, password: undefined })));
});

// ============================================
// 📡 API ROUTES - POSTS
// ============================================
app.get('/api/posts', authMiddleware, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const hashtag = req.query.hashtag || null;
    const userId = req.query.userId || null;
    const result = db.getPosts(page, limit, hashtag, userId);
    res.json(result);
});

app.post('/api/posts', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        const { caption, hashtags } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'فایل الزامی است' });
        }

        const result = {
            postId: db.generateId('post'),
            userId: req.user.userId,
            username: req.user.username,
            fullName: req.user.fullName || req.user.username,
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

        db.savePost(result);
        db.updateUser(req.user.userId, { postsCount: (req.user.postsCount || 0) + 1 });

        const followers = db.getFollowers(req.user.userId);
        for (const follower of followers) {
            io.to(`user_${follower.userId}`).emit('new-post', {
                userId: req.user.userId,
                postId: result.postId
            });
        }

        res.status(201).json(result);
    } catch (error) {
        console.error('Post creation error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/posts/:postId', authMiddleware, (req, res) => {
    const post = db.getPost(req.params.postId);
    if (!post) return res.status(404).json({ error: 'پست یافت نشد' });
    res.json(post);
});

app.delete('/api/posts/:postId', authMiddleware, (req, res) => {
    const post = db.getPost(req.params.postId);
    if (!post) return res.status(404).json({ error: 'پست یافت نشد' });
    if (post.userId !== req.user.userId) {
        return res.status(403).json({ error: 'این پست متعلق به شما نیست' });
    }
    db.deletePost(req.params.postId);
    res.json({ success: true });
});

app.post('/api/posts/:postId/view', authMiddleware, (req, res) => {
    const { postId } = req.params;
    const viewed = db.viewPost(postId, req.user.userId);
    res.json({ success: viewed });
});

app.put('/api/posts/:postId/like', authMiddleware, (req, res) => {
    const { postId } = req.params;
    const result = db.likePost(postId, req.user.userId);
    if (result.liked) {
        const post = db.getPost(postId);
        if (post && post.userId !== req.user.userId) {
            db.addNotification({
                notificationId: db.generateId('notif'),
                userId: post.userId,
                fromUserId: req.user.userId,
                type: 'like',
                postId: postId,
                isRead: false,
                createdAt: new Date().toISOString()
            });
            io.to(`user_${post.userId}`).emit('notification', { type: 'like', fromUserId: req.user.userId, postId: postId });
        }
    }
    res.json(result);
});

app.post('/api/posts/:postId/comment', authMiddleware, (req, res) => {
    const { postId } = req.params;
    const { text } = req.body;

    if (!text) return res.status(400).json({ error: 'متن کامنت الزامی است' });

    const comment = {
        commentId: db.generateId('cmt'),
        userId: req.user.userId,
        username: req.user.username,
        fullName: req.user.fullName || req.user.username,
        text: text,
        createdAt: new Date().toISOString(),
        likes: 0
    };

    const added = db.addComment(postId, comment);
    if (!added) return res.status(404).json({ error: 'پست یافت نشد' });

    const post = db.getPost(postId);
    if (post && post.userId !== req.user.userId) {
        db.addNotification({
            notificationId: db.generateId('notif'),
            userId: post.userId,
            fromUserId: req.user.userId,
            type: 'comment',
            postId: postId,
            isRead: false,
            createdAt: new Date().toISOString()
        });
        io.to(`user_${post.userId}`).emit('notification', { type: 'comment', fromUserId: req.user.userId, postId: postId });
    }

    res.status(201).json(comment);
});

app.delete('/api/posts/:postId/comments/:commentId', authMiddleware, (req, res) => {
    const { postId, commentId } = req.params;
    const deleted = db.deleteComment(postId, commentId, req.user.userId);
    if (!deleted) return res.status(404).json({ error: 'کامنت یافت نشد' });
    res.json({ success: true });
});

app.get('/api/posts/:postId/comments', authMiddleware, (req, res) => {
    const comments = db.getComments(req.params.postId);
    res.json(comments);
});

app.post('/api/posts/:postId/share', authMiddleware, (req, res) => {
    const { postId } = req.params;
    const shared = db.sharePost(postId, req.user.userId);
    res.json({ success: shared });
});

app.post('/api/posts/:postId/bookmark', authMiddleware, (req, res) => {
    const { postId } = req.params;
    const result = db.bookmarkPost(postId, req.user.userId);
    res.json(result);
});

app.get('/api/bookmarks', authMiddleware, (req, res) => {
    const bookmarks = db.getBookmarks(req.user.userId);
    res.json(bookmarks);
});

app.get('/api/trends', authMiddleware, (req, res) => {
    const trends = db.getTrendingHashtags(10);
    res.json(trends);
});

// ============================================
// 📡 API ROUTES - STORIES
// ============================================
app.get('/api/stories', authMiddleware, (req, res) => {
    const stories = db.getStories();
    res.json(stories);
});

app.get('/api/stories/:userId', authMiddleware, (req, res) => {
    const stories = db.getStories(req.params.userId);
    res.json(stories);
});

app.post('/api/stories', authMiddleware, storyUpload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) {
        return res.status(400).json({ error: 'فایل الزامی است' });
    }

    const story = {
        storyId: db.generateId('story'),
        userId: req.user.userId,
        username: req.user.username,
        fullName: req.user.fullName || req.user.username,
        image: '/uploads/stories/' + file.filename,
        isVideo: file.mimetype.startsWith('video/'),
        views: 0,
        viewers: [],
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };

    db.saveStory(story);

    const followers = db.getFollowers(req.user.userId);
    for (const follower of followers) {
        io.to(`user_${follower.userId}`).emit('new-story', {
            userId: req.user.userId,
            storyId: story.storyId
        });
    }

    res.status(201).json(story);
});

app.delete('/api/stories/:storyId', authMiddleware, (req, res) => {
    const { storyId } = req.params;
    const deleted = db.deleteStory(storyId, req.user.userId);
    if (!deleted) return res.status(404).json({ error: 'استوری یافت نشد' });
    res.json({ success: true });
});

app.post('/api/stories/:storyId/view', authMiddleware, (req, res) => {
    const { storyId } = req.params;
    const viewed = db.viewStory(storyId, req.user.userId);
    res.json({ success: viewed });
});

// ============================================
// 📡 API ROUTES - NOTIFICATIONS
// ============================================
app.get('/api/notifications', authMiddleware, (req, res) => {
    const notifications = db.getNotifications(req.user.userId);
    res.json(notifications);
});

app.post('/api/notifications/:notificationId/read', authMiddleware, (req, res) => {
    const { notificationId } = req.params;
    const marked = db.markNotificationRead(notificationId, req.user.userId);
    res.json({ success: marked });
});

app.post('/api/notifications/read-all', authMiddleware, (req, res) => {
    const notifications = db.getNotifications(req.user.userId);
    for (const notif of notifications) {
        if (!notif.isRead) {
            db.markNotificationRead(notif.notificationId, req.user.userId);
        }
    }
    res.json({ success: true });
});

// ============================================
// 📡 API ROUTES - MESSAGES
// ============================================
app.get('/api/messages', authMiddleware, (req, res) => {
    const { roomId, limit = 50 } = req.query;
    if (!roomId) {
        return res.status(400).json({ error: 'roomId الزامی است' });
    }
    const messages = db.getMessages(roomId, parseInt(limit));
    res.json(messages);
});

app.post('/api/messages', authMiddleware, (req, res) => {
    const { roomId, userId, message } = req.body;
    if (!roomId || !userId || !message) {
        return res.status(400).json({ error: 'همه فیلدها الزامی هستند' });
    }
    const msgData = {
        messageId: db.generateId('msg'),
        userId: userId,
        username: req.user.username,
        message: message,
        timestamp: new Date().toISOString()
    };
    db.saveMessage(roomId, msgData);
    io.to(roomId).emit('receive-message', msgData);
    res.json({ success: true, message: msgData });
});

// ============================================
// 📡 API ROUTES - LIVE
// ============================================
app.post('/api/live/start', authMiddleware, (req, res) => {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'عنوان لایو الزامی است' });
    const streamId = db.startLiveStream(req.user.userId, title);
    io.emit('live-started', { streamId, userId: req.user.userId, title });
    res.json({ success: true, streamId });
});

app.post('/api/live/end', authMiddleware, (req, res) => {
    const { streamId } = req.body;
    const ended = db.endLiveStream(streamId);
    if (!ended) return res.status(404).json({ error: 'لایو یافت نشد' });
    io.emit('live-ended', { streamId });
    res.json({ success: true });
});

app.get('/api/live/streams', authMiddleware, (req, res) => {
    const streams = db.getLiveStreams();
    res.json(streams);
});

app.post('/api/live/join', authMiddleware, (req, res) => {
    const { streamId } = req.body;
    const joined = db.joinLiveStream(streamId, req.user.userId);
    if (!joined) return res.status(404).json({ error: 'لایو یافت نشد' });
    io.to(`live_${streamId}`).emit('viewer-joined', { userId: req.user.userId });
    res.json({ success: true });
});

app.post('/api/live/leave', authMiddleware, (req, res) => {
    const { streamId } = req.body;
    const left = db.leaveLiveStream(streamId, req.user.userId);
    if (!left) return res.status(404).json({ error: 'لایو یافت نشد' });
    io.to(`live_${streamId}`).emit('viewer-left', { userId: req.user.userId });
    res.json({ success: true });
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

app.delete('/api/admin/users/:userId', authMiddleware, adminMiddleware, (req, res) => {
    const { userId } = req.params;
    const user = db.getUser(userId);
    if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
    if (user.isAdmin) return res.status(403).json({ error: 'نمی‌توان ادمین را حذف کرد' });
    
    const posts = db.getPosts(1, 10000, null, userId);
    for (const post of posts.posts) {
        db.deletePost(post.postId);
    }
    const stories = db.getStories(userId);
    for (const story of stories) {
        db.deleteStory(story.storyId, userId);
    }
    db.deleteUser(userId);
    res.json({ success: true });
});

app.get('/api/admin/posts', authMiddleware, adminMiddleware, (req, res) => {
    const result = db.getPosts(1, 10000);
    res.json(result.posts);
});

app.delete('/api/admin/posts/:postId', authMiddleware, adminMiddleware, (req, res) => {
    const { postId } = req.params;
    const deleted = db.deletePost(postId);
    res.json({ success: deleted });
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
    const stats = db.getStats();
    res.json(stats);
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

    socket.on('join-room', (data) => {
        const { roomId } = data;
        socket.join(roomId);
        socket.roomId = roomId;
        const messages = db.getMessages(roomId, 50);
        socket.emit('history', messages);
    });

    socket.on('send-message', (data) => {
        const { roomId, userId, username, message } = data;
        const user = db.getUser(userId);
        if (user && user.isBanned) {
            socket.emit('error', { message: 'شما مسدود شده‌اید' });
            return;
        }
        const msgData = {
            messageId: db.generateId('msg'),
            userId: userId,
            username: username,
            message: message,
            timestamp: new Date().toISOString()
        };
        db.saveMessage(roomId, msgData);
        io.to(roomId).emit('receive-message', msgData);
    });

    socket.on('typing', (data) => {
        const { roomId, userId, isTyping } = data;
        socket.to(roomId).emit('user-typing', { userId, isTyping });
    });

    socket.on('join-live', (data) => {
        const { streamId } = data;
        socket.join(`live_${streamId}`);
        console.log('🔴 User joined live:', streamId);
    });

    socket.on('live-comment', (data) => {
        const { streamId, userId, username, text } = data;
        io.to(`live_${streamId}`).emit('live-comment', {
            userId,
            username,
            text,
            timestamp: new Date().toISOString()
        });
    });

    socket.on('leave-room', (data) => {
        const { roomId } = data;
        socket.leave(roomId);
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

module.exports = {
    app,
    server,
    io,
    db,
    encryption,
    authMiddleware,
    adminMiddleware,
    upload,
    storyUpload,
    avatarUpload,
    SHARD_COUNT,
    PORT,
    ADMIN_EMAIL,
    ADMIN_PASSWORD
};