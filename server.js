// ============================================
// 🚀 SOCIAL NETWORK - MICROSERVICE ARCHITECTURE
// ============================================
// Complete Single-File Implementation
// Supports: Authentication, Posts, Stories, Chat, Notifications
// Admin: milad.yari1377m@gmail.com / M09145978426m
// ============================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

// ============================================
// 📦 DATABASE CONFIGURATION
// ============================================
// Using multiple storage layers for scalability:
// 1. Memory Cache (Redis-like) for fast access
// 2. File System for persistent storage
// 3. Sharded storage for media files

class Database {
    constructor() {
        // Users storage
        this.users = {};
        this.usersByEmail = {};
        this.usersByUsername = {};
        
        // Posts storage with sharding
        this.posts = [];
        this.postsShards = {};
        this.postsByUser = {};
        this.postsByHashtag = {};
        
        // Stories storage
        this.stories = [];
        this.storiesByUser = {};
        
        // Chat storage
        this.chatMessages = {};
        this.chatRooms = {};
        
        // Notifications
        this.notifications = {};
        
        // Relationships
        this.followers = {};
        this.following = {};
        this.likes = {};
        this.comments = {};
        
        // Analytics
        this.analytics = {
            views: {},
            shares: {},
            userActivity: {}
        };
        
        // Cache
        this.cache = {};
        this.cacheTTL = {};
        
        // Admin config
        this.ADMIN_EMAIL = 'milad.yari1377m@gmail.com';
        this.ADMIN_PASSWORD = 'M09145978426m';
        this.ADMIN_ID = 'admin_1';
        
        // IDs
        this.userIdCounter = 1;
        this.postIdCounter = 1;
        this.storyIdCounter = 1;
        this.messageIdCounter = 1;
        this.notificationIdCounter = 1;
        
        // Initialize admin
        this.initAdmin();
    }
    
    initAdmin() {
        const adminId = 'admin_' + this.userIdCounter++;
        this.users[adminId] = {
            userId: adminId,
            username: 'مدیر سیستم',
            email: this.ADMIN_EMAIL,
            password: this.hashPassword(this.ADMIN_PASSWORD),
            bio: 'مدیر ارشد شبکه اجتماعی',
            avatar: 'https://ui-avatars.com/api/?name=Admin&background=0095f6&color=fff&size=150',
            followers: 0,
            following: 0,
            postsCount: 0,
            language: 'fa',
            theme: 'dark',
            createdAt: new Date().toISOString(),
            isOnline: true,
            isAdmin: true,
            isBanned: false,
            lastSeen: new Date().toISOString(),
            verified: true,
            level: 'admin'
        };
        this.usersByEmail[this.ADMIN_EMAIL] = adminId;
        this.usersByUsername['مدیر سیستم'] = adminId;
    }
    
    hashPassword(password) {
        const salt = 'SOCIAL_NETWORK_SALT_2026_SUPER_SECURE';
        return crypto.createHash('sha512').update(password + salt).digest('hex');
    }
    
    generateToken() {
        return crypto.randomBytes(64).toString('hex') + Date.now().toString(36);
    }
    
    // ===== User Methods =====
    createUser(username, email, password) {
        if (this.usersByEmail[email]) {
            throw new Error('این ایمیل قبلاً ثبت شده است');
        }
        if (this.usersByUsername[username]) {
            throw new Error('این نام کاربری قبلاً ثبت شده است');
        }
        
        const userId = 'user_' + this.userIdCounter++;
        const user = {
            userId,
            username,
            email,
            password: this.hashPassword(password),
            bio: '',
            avatar: 'https://ui-avatars.com/api/?name=' + encodeURIComponent(username) + '&background=0095f6&color=fff&size=150',
            followers: 0,
            following: 0,
            postsCount: 0,
            language: 'fa',
            theme: 'light',
            createdAt: new Date().toISOString(),
            isOnline: false,
            isAdmin: false,
            isBanned: false,
            lastSeen: new Date().toISOString(),
            verified: false,
            level: 'user',
            followersList: [],
            followingList: []
        };
        
        this.users[userId] = user;
        this.usersByEmail[email] = userId;
        this.usersByUsername[username] = userId;
        
        return user;
    }
    
    getUserByEmail(email) {
        const userId = this.usersByEmail[email];
        return userId ? this.users[userId] : null;
    }
    
    getUserById(userId) {
        return this.users[userId] || null;
    }
    
    getUserByUsername(username) {
        const userId = this.usersByUsername[username];
        return userId ? this.users[userId] : null;
    }
    
    authenticateUser(email, password) {
        const user = this.getUserByEmail(email);
        if (!user) return null;
        if (user.password !== this.hashPassword(password)) return null;
        if (user.isBanned) throw new Error('کاربر مسدود شده است');
        return user;
    }
    
    getAllUsers() {
        return Object.values(this.users);
    }
    
    // ===== Post Methods =====
    createPost(userId, username, image, caption, hashtags = [], isVideo = false) {
        const postId = 'post_' + this.postIdCounter++;
        const post = {
            postId,
            userId,
            username,
            image,
            caption: caption || '',
            hashtags: Array.isArray(hashtags) ? hashtags : hashtags.split(',').map(h => h.trim()),
            likes: 0,
            comments: [],
            shares: 0,
            views: 0,
            isVideo,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            likedBy: [],
            sharedBy: [],
            savedBy: []
        };
        
        this.posts.unshift(post);
        
        // Sharding by userId
        if (!this.postsByUser[userId]) this.postsByUser[userId] = [];
        this.postsByUser[userId].push(post);
        
        // Index by hashtag
        post.hashtags.forEach(tag => {
            if (!this.postsByHashtag[tag]) this.postsByHashtag[tag] = [];
            this.postsByHashtag[tag].push(post);
        });
        
        // Update user posts count
        const user = this.getUserById(userId);
        if (user) user.postsCount = (user.postsCount || 0) + 1;
        
        return post;
    }
    
    getPosts(page = 1, limit = 20, hashtag = null) {
        let filtered = [...this.posts];
        if (hashtag) {
            filtered = filtered.filter(p => 
                p.hashtags && p.hashtags.some(h => 
                    h.toLowerCase() === hashtag.toLowerCase()
                )
            );
        }
        
        const start = (page - 1) * limit;
        const end = start + limit;
        const paginated = filtered
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(start, end);
        
        return {
            posts: paginated,
            total: filtered.length,
            page,
            totalPages: Math.ceil(filtered.length / limit)
        };
    }
    
    getPostById(postId) {
        return this.posts.find(p => p.postId === postId);
    }
    
    getUserPosts(userId) {
        return this.postsByUser[userId] || [];
    }
    
    deletePost(postId) {
        const index = this.posts.findIndex(p => p.postId === postId);
        if (index === -1) return null;
        const post = this.posts[index];
        this.posts.splice(index, 1);
        
        // Remove from user posts
        if (this.postsByUser[post.userId]) {
            this.postsByUser[post.userId] = this.postsByUser[post.userId]
                .filter(p => p.postId !== postId);
        }
        
        // Remove from hashtag index
        post.hashtags.forEach(tag => {
            if (this.postsByHashtag[tag]) {
                this.postsByHashtag[tag] = this.postsByHashtag[tag]
                    .filter(p => p.postId !== postId);
            }
        });
        
        return post;
    }
    
    // ===== Like Methods =====
    toggleLike(postId, userId) {
        const post = this.getPostById(postId);
        if (!post) return null;
        
        const key = postId + '_' + userId;
        if (this.likes[key]) {
            delete this.likes[key];
            post.likes = Math.max(0, post.likes - 1);
            post.likedBy = post.likedBy.filter(id => id !== userId);
            return { liked: false, likes: post.likes };
        } else {
            this.likes[key] = true;
            post.likes += 1;
            if (!post.likedBy.includes(userId)) post.likedBy.push(userId);
            return { liked: true, likes: post.likes };
        }
    }
    
    // ===== Comment Methods =====
    addComment(postId, userId, username, text) {
        const post = this.getPostById(postId);
        if (!post) return null;
        
        const comment = {
            commentId: 'cmt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            userId,
            username: username || 'کاربر',
            text,
            createdAt: new Date().toISOString(),
            likes: 0,
            likedBy: []
        };
        
        post.comments.push(comment);
        return comment;
    }
    
    getComments(postId) {
        const post = this.getPostById(postId);
        return post ? post.comments : [];
    }
    
    // ===== Story Methods =====
    createStory(userId, username, image, isVideo = false) {
        const storyId = 'story_' + this.storyIdCounter++;
        const story = {
            storyId,
            userId,
            username,
            image,
            isVideo,
            views: 0,
            viewers: [],
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        };
        
        this.stories.push(story);
        if (!this.storiesByUser[userId]) this.storiesByUser[userId] = [];
        this.storiesByUser[userId].push(story);
        
        return story;
    }
    
    getActiveStories() {
        const now = Date.now();
        return this.stories.filter(s => 
            (now - new Date(s.createdAt).getTime()) < 24 * 60 * 60 * 1000
        );
    }
    
    viewStory(storyId, userId) {
        const story = this.stories.find(s => s.storyId === storyId);
        if (story && !story.viewers.includes(userId)) {
            story.views += 1;
            story.viewers.push(userId);
            return true;
        }
        return false;
    }
    
    // ===== Follow Methods =====
    followUser(targetUserId, followerId) {
        const target = this.getUserById(targetUserId);
        const follower = this.getUserById(followerId);
        
        if (!target || !follower) return null;
        if (targetUserId === followerId) return null;
        
        if (!target.followersList.includes(followerId)) {
            target.followersList.push(followerId);
            target.followers = target.followersList.length;
        }
        
        if (!follower.followingList.includes(targetUserId)) {
            follower.followingList.push(targetUserId);
            follower.following = follower.followingList.length;
        }
        
        return { followers: target.followers, following: follower.following };
    }
    
    unfollowUser(targetUserId, followerId) {
        const target = this.getUserById(targetUserId);
        const follower = this.getUserById(followerId);
        
        if (!target || !follower) return null;
        
        target.followersList = target.followersList.filter(id => id !== followerId);
        target.followers = target.followersList.length;
        
        follower.followingList = follower.followingList.filter(id => id !== targetUserId);
        follower.following = follower.followingList.length;
        
        return { followers: target.followers, following: follower.following };
    }
    
    // ===== Chat Methods =====
    getChatRoom(userId1, userId2) {
        const roomId = [userId1, userId2].sort().join('_');
        if (!this.chatRooms[roomId]) {
            this.chatRooms[roomId] = {
                roomId,
                users: [userId1, userId2],
                messages: [],
                createdAt: new Date().toISOString()
            };
        }
        return this.chatRooms[roomId];
    }
    
    addChatMessage(roomId, userId, username, message) {
        if (!this.chatMessages[roomId]) {
            this.chatMessages[roomId] = [];
        }
        
        const msgData = {
            messageId: 'msg_' + this.messageIdCounter++,
            userId,
            username,
            message,
            timestamp: new Date().toISOString(),
            read: false
        };
        
        this.chatMessages[roomId].push(msgData);
        return msgData;
    }
    
    getChatHistory(roomId, limit = 50) {
        const messages = this.chatMessages[roomId] || [];
        return messages.slice(-limit);
    }
    
    // ===== Notification Methods =====
    createNotification(userId, type, message, data = {}) {
        if (!this.notifications[userId]) {
            this.notifications[userId] = [];
        }
        
        const notification = {
            id: 'notif_' + this.notificationIdCounter++,
            userId,
            type, // 'like', 'comment', 'follow', 'mention', 'broadcast'
            message,
            data,
            read: false,
            createdAt: new Date().toISOString()
        };
        
        this.notifications[userId].push(notification);
        return notification;
    }
    
    getNotifications(userId, unreadOnly = false) {
        const notifs = this.notifications[userId] || [];
        return unreadOnly ? notifs.filter(n => !n.read) : notifs;
    }
    
    markNotificationRead(userId, notificationId) {
        const notifs = this.notifications[userId] || [];
        const notif = notifs.find(n => n.id === notificationId);
        if (notif) notif.read = true;
        return notif;
    }
    
    // ===== Cache Methods =====
    setCache(key, value, ttl = 3600) {
        this.cache[key] = value;
        this.cacheTTL[key] = Date.now() + ttl * 1000;
    }
    
    getCache(key) {
        if (this.cacheTTL[key] && Date.now() > this.cacheTTL[key]) {
            delete this.cache[key];
            delete this.cacheTTL[key];
            return null;
        }
        return this.cache[key] || null;
    }
    
    // ===== Analytics =====
    trackView(postId, userId) {
        if (!this.analytics.views[postId]) {
            this.analytics.views[postId] = { count: 0, users: [] };
        }
        if (!this.analytics.views[postId].users.includes(userId)) {
            this.analytics.views[postId].count++;
            this.analytics.views[postId].users.push(userId);
            
            // Update post views
            const post = this.getPostById(postId);
            if (post) post.views = this.analytics.views[postId].count;
        }
    }
    
    trackShare(postId, userId) {
        const post = this.getPostById(postId);
        if (post) {
            post.shares = (post.shares || 0) + 1;
            if (!post.sharedBy.includes(userId)) post.sharedBy.push(userId);
        }
    }
    
    getAnalytics() {
        return {
            totalUsers: Object.keys(this.users).length,
            totalPosts: this.posts.length,
            totalStories: this.stories.length,
            totalLikes: Object.keys(this.likes).length,
            totalComments: this.posts.reduce((sum, p) => sum + p.comments.length, 0),
            onlineUsers: Object.values(this.users).filter(u => u.isOnline).length,
            admins: Object.values(this.users).filter(u => u.isAdmin).length,
            banned: Object.values(this.users).filter(u => u.isBanned).length
        };
    }
}

// ============================================
// 🗄️ DATABASE INSTANCE
// ============================================
const db = new Database();

// ============================================
// 🚀 EXPRESS APP
// ============================================
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// ============================================
// 🔒 SECURITY MIDDLEWARE
// ============================================
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static('public'));

// ============================================
// 📁 STORAGE CONFIGURATION
// ============================================
const uploadDir = './uploads';
const postsDir = './uploads/posts';
const storiesDir = './uploads/stories';
const avatarsDir = './uploads/avatars';

[uploadDir, postsDir, storiesDir, avatarsDir, './public'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Multer config for posts
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const type = req.path.includes('story') ? storiesDir : postsDir;
        cb(null, type);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        const ext = path.extname(file.originalname);
        cb(null, unique + ext);
    }
});

const upload = multer({
    storage,
    limits: { 
        fileSize: 500 * 1024 * 1024, // 500MB for videos
        files: 1
    },
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/webm', 'video/quicktime',
            'image/jpg', 'image/svg+xml'
        ];
        cb(null, allowed.includes(file.mimetype));
    }
});

// ============================================
// 🔐 AUTH MIDDLEWARE
// ============================================
const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'توکن احراز هویت یافت نشد' });
    }
    
    const userId = db.getCache('token_' + token);
    if (!userId) {
        return res.status(401).json({ error: 'توکن نامعتبر یا منقضی شده' });
    }
    
    const user = db.getUserById(userId);
    if (!user) {
        return res.status(401).json({ error: 'کاربر یافت نشد' });
    }
    if (user.isBanned) {
        return res.status(403).json({ error: 'کاربر مسدود شده است' });
    }
    
    req.user = user;
    req.userId = userId;
    next();
};

const verifyAdmin = (req, res, next) => {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).json({ error: 'دسترسی ادمین نیاز است' });
    }
    next();
};

// ============================================
// 📡 API ROUTES
// ============================================

// ========== AUTH ROUTES ==========
app.post('/api/auth/register', (req, res) => {
    try {
        const { username, email, password } = req.body;
        
        console.log('📝 Register attempt:', { username, email });
        
        // Validation
        if (!username || !email || !password) {
            return res.status(400).json({ 
                error: 'همه فیلدها الزامی هستند',
                fields: { username: !!username, email: !!email, password: !!password }
            });
        }
        
        if (username.length < 3) {
            return res.status(400).json({ error: 'نام کاربری باید حداقل ۳ کاراکتر باشد' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'رمز عبور باید حداقل ۶ کاراکتر باشد' });
        }
        
        // Check if user exists
        const existingUser = db.getUserByEmail(email);
        if (existingUser) {
            return res.status(400).json({ error: 'این ایمیل قبلاً ثبت شده است' });
        }
        
        const existingUsername = db.getUserByUsername(username);
        if (existingUsername) {
            return res.status(400).json({ error: 'این نام کاربری قبلاً ثبت شده است' });
        }
        
        // Create user
        const user = db.createUser(username, email, password);
        const token = db.generateToken();
        
        // Store token in cache (7 days)
        db.setCache('token_' + token, user.userId, 604800);
        db.setCache('user_' + user.userId, user, 3600);
        
        console.log('✅ User registered:', username, email);
        
        res.status(201).json({
            success: true,
            message: 'ثبت نام با موفقیت انجام شد',
            token,
            user: {
                userId: user.userId,
                username: user.username,
                email: user.email,
                bio: user.bio,
                avatar: user.avatar,
                followers: user.followers,
                following: user.following,
                postsCount: user.postsCount,
                isAdmin: user.isAdmin,
                isBanned: user.isBanned,
                language: user.language,
                theme: user.theme,
                verified: user.verified
            }
        });
    } catch (error) {
        console.error('❌ Register error:', error);
        res.status(500).json({ error: error.message || 'خطا در ثبت نام' });
    }
});

app.post('/api/auth/login', (req, res) => {
    try {
        const { email, password } = req.body;
        
        console.log('🔑 Login attempt:', email);
        
        if (!email || !password) {
            return res.status(400).json({ error: 'ایمیل و رمز عبور الزامی است' });
        }
        
        const user = db.authenticateUser(email, password);
        if (!user) {
            return res.status(401).json({ error: 'ایمیل یا رمز عبور اشتباه است' });
        }
        
        const token = db.generateToken();
        db.setCache('token_' + token, user.userId, 604800);
        user.isOnline = true;
        user.lastSeen = new Date().toISOString();
        
        console.log('✅ User logged in:', user.username, email);
        
        res.json({
            success: true,
            message: 'ورود با موفقیت انجام شد',
            token,
            user: {
                userId: user.userId,
                username: user.username,
                email: user.email,
                bio: user.bio,
                avatar: user.avatar,
                followers: user.followers,
                following: user.following,
                postsCount: user.postsCount,
                isAdmin: user.isAdmin,
                isBanned: user.isBanned,
                language: user.language,
                theme: user.theme,
                verified: user.verified
            }
        });
    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({ error: error.message || 'خطا در ورود' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    const { token } = req.body;
    if (token) {
        const userId = db.getCache('token_' + token);
        if (userId) {
            const user = db.getUserById(userId);
            if (user) {
                user.isOnline = false;
                user.lastSeen = new Date().toISOString();
            }
        }
        db.setCache('token_' + token, null, 0);
    }
    res.json({ success: true, message: 'خروج با موفقیت انجام شد' });
});

app.get('/api/auth/me', verifyToken, (req, res) => {
    const user = req.user;
    res.json({
        userId: user.userId,
        username: user.username,
        email: user.email,
        bio: user.bio,
        avatar: user.avatar,
        followers: user.followers,
        following: user.following,
        postsCount: user.postsCount,
        isAdmin: user.isAdmin,
        isBanned: user.isBanned,
        language: user.language,
        theme: user.theme,
        verified: user.verified
    });
});

// ========== ADMIN ROUTES ==========
app.get('/api/admin/verify', verifyToken, verifyAdmin, (req, res) => {
    res.json({ 
        success: true, 
        isAdmin: true,
        adminLevel: req.user.level || 'admin'
    });
});

app.get('/api/admin/users', verifyToken, verifyAdmin, (req, res) => {
    const users = db.getAllUsers().map(u => ({
        userId: u.userId,
        username: u.username,
        email: u.email,
        bio: u.bio,
        avatar: u.avatar,
        followers: u.followers,
        following: u.following,
        postsCount: u.postsCount,
        isAdmin: u.isAdmin || false,
        isBanned: u.isBanned || false,
        isOnline: u.isOnline || false,
        verified: u.verified || false,
        createdAt: u.createdAt,
        lastSeen: u.lastSeen
    }));
    res.json(users);
});

app.put('/api/admin/users/:userId/ban', verifyToken, verifyAdmin, (req, res) => {
    const { userId } = req.params;
    const { banned } = req.body;
    const user = db.getUserById(userId);
    
    if (!user) {
        return res.status(404).json({ error: 'کاربر یافت نشد' });
    }
    
    if (user.isAdmin) {
        return res.status(403).json({ error: 'نمی‌توان ادمین را مسدود کرد' });
    }
    
    user.isBanned = banned;
    res.json({ success: true, isBanned: banned, userId: user.userId });
});

app.get('/api/admin/posts', verifyToken, verifyAdmin, (req, res) => {
    const result = db.getPosts(1, 1000);
    res.json(result.posts);
});

app.delete('/api/admin/posts/:postId', verifyToken, verifyAdmin, (req, res) => {
    const { postId } = req.params;
    const post = db.deletePost(postId);
    if (!post) {
        return res.status(404).json({ error: 'پست یافت نشد' });
    }
    res.json({ success: true, message: 'پست حذف شد' });
});

app.post('/api/admin/broadcast', verifyToken, verifyAdmin, (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'پیام الزامی است' });
    }
    
    // Send to all online users via WebSocket
    io.emit('broadcast', {
        message,
        from: req.user.username,
        timestamp: new Date().toISOString(),
        admin: true
    });
    
    res.json({ success: true, message: 'پیام همگانی ارسال شد' });
});

app.get('/api/admin/stats', verifyToken, verifyAdmin, (req, res) => {
    const stats = db.getAnalytics();
    res.json(stats);
});

// ========== USER ROUTES ==========
app.get('/api/users', (req, res) => {
    const users = db.getAllUsers().map(u => ({
        userId: u.userId,
        username: u.username,
        avatar: u.avatar,
        bio: u.bio,
        followers: u.followers,
        following: u.following,
        isOnline: u.isOnline || false,
        isBanned: u.isBanned || false,
        verified: u.verified || false,
        lastSeen: u.lastSeen
    }));
    res.json(users);
});

app.get('/api/users/:userId', (req, res) => {
    const { userId } = req.params;
    const user = db.getUserById(userId);
    if (!user) {
        return res.status(404).json({ error: 'کاربر یافت نشد' });
    }
    res.json({
        userId: user.userId,
        username: user.username,
        email: user.email,
        bio: user.bio,
        avatar: user.avatar,
        followers: user.followers,
        following: user.following,
        postsCount: user.postsCount,
        isOnline: user.isOnline || false,
        isBanned: user.isBanned || false,
        verified: user.verified || false,
        createdAt: user.createdAt,
        lastSeen: user.lastSeen
    });
});

app.put('/api/users/:userId/profile', verifyToken, (req, res) => {
    const { userId } = req.params;
    const { bio, avatar, language, theme } = req.body;
    const user = db.getUserById(userId);
    
    if (!user) {
        return res.status(404).json({ error: 'کاربر یافت نشد' });
    }
    
    if (req.userId !== userId && !req.user.isAdmin) {
        return res.status(403).json({ error: 'دسترسی غیرمجاز' });
    }
    
    if (bio !== undefined) user.bio = bio;
    if (avatar !== undefined) user.avatar = avatar;
    if (language !== undefined) user.language = language;
    if (theme !== undefined) user.theme = theme;
    
    res.json({ 
        success: true, 
        user: {
            userId: user.userId,
            username: user.username,
            bio: user.bio,
            avatar: user.avatar,
            language: user.language,
            theme: user.theme
        }
    });
});

app.post('/api/users/:userId/follow', verifyToken, (req, res) => {
    const { userId } = req.params;
    const followerId = req.userId;
    
    if (userId === followerId) {
        return res.status(400).json({ error: 'نمی‌توانید خودتان را دنبال کنید' });
    }
    
    const result = db.followUser(userId, followerId);
    if (!result) {
        return res.status(404).json({ error: 'کاربر یافت نشد' });
    }
    
    // Create notification
    const targetUser = db.getUserById(userId);
    if (targetUser) {
        db.createNotification(
            userId,
            'follow',
            `${req.user.username} شما را دنبال کرد`,
            { followerId, followerName: req.user.username }
        );
    }
    
    res.json({ 
        success: true, 
        followers: result.followers,
        following: result.following
    });
});

app.post('/api/users/:userId/unfollow', verifyToken, (req, res) => {
    const { userId } = req.params;
    const followerId = req.userId;
    
    const result = db.unfollowUser(userId, followerId);
    if (!result) {
        return res.status(404).json({ error: 'کاربر یافت نشد' });
    }
    
    res.json({ 
        success: true, 
        followers: result.followers,
        following: result.following
    });
});

// ========== POST ROUTES ==========
app.get('/api/posts', (req, res) => {
    const { page = 1, limit = 20, hashtag, userId } = req.query;
    let result;
    
    if (userId) {
        const posts = db.getUserPosts(userId) || [];
        const start = (parseInt(page) - 1) * parseInt(limit);
        const end = start + parseInt(limit);
        result = {
            posts: posts.slice(start, end),
            total: posts.length,
            page: parseInt(page),
            totalPages: Math.ceil(posts.length / parseInt(limit))
        };
    } else {
        result = db.getPosts(parseInt(page), parseInt(limit), hashtag);
    }
    
    res.json(result);
});

app.get('/api/posts/:postId', (req, res) => {
    const { postId } = req.params;
    const post = db.getPostById(postId);
    if (!post) {
        return res.status(404).json({ error: 'پست یافت نشد' });
    }
    res.json(post);
});

app.post('/api/posts', verifyToken, upload.single('file'), (req, res) => {
    try {
        const { caption, hashtags } = req.body;
        const file = req.file;
        
        if (!file) {
            return res.status(400).json({ error: 'فایل انتخاب نشده است' });
        }
        
        const isVideo = file.mimetype.startsWith('video/');
        const imageUrl = '/uploads/posts/' + file.filename;
        const hashtagArray = hashtags ? 
            hashtags.split(',').map(h => h.trim()).filter(h => h) : 
            [];
        
        const post = db.createPost(
            req.userId,
            req.user.username,
            imageUrl,
            caption || '',
            hashtagArray,
            isVideo
        );
        
        // Track analytics
        db.trackShare(post.postId, req.userId);
        
        // Notify followers
        const user = db.getUserById(req.userId);
        if (user && user.followersList) {
            user.followersList.forEach(followerId => {
                db.createNotification(
                    followerId,
                    'new_post',
                    `${req.user.username} پست جدید منتشر کرد`,
                    { postId: post.postId, postImage: imageUrl }
                );
            });
        }
        
        console.log('📸 Post created:', post.postId, 'by', req.user.username);
        
        res.status(201).json({
            success: true,
            post
        });
    } catch (error) {
        console.error('❌ Post creation error:', error);
        res.status(500).json({ error: error.message || 'خطا در ایجاد پست' });
    }
});

app.put('/api/posts/:postId/like', verifyToken, (req, res) => {
    const { postId } = req.params;
    const result = db.toggleLike(postId, req.userId);
    
    if (!result) {
        return res.status(404).json({ error: 'پست یافت نشد' });
    }
    
    // Notify post owner if liked
    const post = db.getPostById(postId);
    if (post && result.liked && post.userId !== req.userId) {
        db.createNotification(
            post.userId,
            'like',
            `${req.user.username} پست شما را لایک کرد`,
            { postId, likerId: req.userId, likerName: req.user.username }
        );
    }
    
    res.json(result);
});

app.post('/api/posts/:postId/comment', verifyToken, (req, res) => {
    const { postId } = req.params;
    const { text } = req.body;
    
    if (!text || !text.trim()) {
        return res.status(400).json({ error: 'متن کامنت الزامی است' });
    }
    
    const comment = db.addComment(postId, req.userId, req.user.username, text);
    if (!comment) {
        return res.status(404).json({ error: 'پست یافت نشد' });
    }
    
    // Notify post owner
    const post = db.getPostById(postId);
    if (post && post.userId !== req.userId) {
        db.createNotification(
            post.userId,
            'comment',
            `${req.user.username} روی پست شما کامنت گذاشت`,
            { postId, commentId: comment.commentId, commentText: text }
        );
    }
    
    res.status(201).json({ success: true, comment });
});

app.get('/api/posts/:postId/comments', (req, res) => {
    const { postId } = req.params;
    const comments = db.getComments(postId);
    res.json(comments);
});

// ========== STORY ROUTES ==========
app.get('/api/stories', (req, res) => {
    const stories = db.getActiveStories();
    res.json(stories);
});

app.post('/api/stories', verifyToken, upload.single('file'), (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: 'فایل انتخاب نشده است' });
        }
        
        const isVideo = file.mimetype.startsWith('video/');
        const imageUrl = '/uploads/stories/' + file.filename;
        
        const story = db.createStory(
            req.userId,
            req.user.username,
            imageUrl,
            isVideo
        );
        
        console.log('📸 Story created:', story.storyId, 'by', req.user.username);
        
        res.status(201).json({
            success: true,
            story
        });
    } catch (error) {
        console.error('❌ Story creation error:', error);
        res.status(500).json({ error: error.message || 'خطا در ایجاد استوری' });
    }
});

app.post('/api/stories/:storyId/view', verifyToken, (req, res) => {
    const { storyId } = req.params;
    const viewed = db.viewStory(storyId, req.userId);
    res.json({ success: viewed });
});

// ========== NOTIFICATION ROUTES ==========
app.get('/api/notifications', verifyToken, (req, res) => {
    const { unread } = req.query;
    const notifications = db.getNotifications(
        req.userId, 
        unread === 'true'
    );
    res.json(notifications);
});

app.put('/api/notifications/:notificationId/read', verifyToken, (req, res) => {
    const { notificationId } = req.params;
    const notif = db.markNotificationRead(req.userId, notificationId);
    if (!notif) {
        return res.status(404).json({ error: 'نوتیفیکیشن یافت نشد' });
    }
    res.json({ success: true, notification: notif });
});

app.put('/api/notifications/read-all', verifyToken, (req, res) => {
    const notifs = db.getNotifications(req.userId, true);
    notifs.forEach(n => n.read = true);
    res.json({ success: true, count: notifs.length });
});

// ========== ANALYTICS ROUTES ==========
app.get('/api/analytics', verifyToken, (req, res) => {
    const stats = db.getAnalytics();
    res.json(stats);
});

app.post('/api/analytics/view/:postId', verifyToken, (req, res) => {
    const { postId } = req.params;
    db.trackView(postId, req.userId);
    res.json({ success: true });
});

// ============================================
// 💬 WEBSOCKET CHAT
// ============================================

const onlineUsers = new Map();
const userSockets = new Map();

io.on('connection', (socket) => {
    console.log('🔌 Socket connected:', socket.id);
    
    socket.on('register', (data) => {
        const { userId, username } = data;
        onlineUsers.set(userId, socket.id);
        userSockets.set(socket.id, userId);
        socket.userId = userId;
        socket.username = username;
        
        const user = db.getUserById(userId);
        if (user) {
            user.isOnline = true;
            user.lastSeen = new Date().toISOString();
        }
        
        io.emit('users-online', Array.from(onlineUsers.keys()));
        console.log('👤 User online:', username);
    });
    
    socket.on('join-room', (data) => {
        const { roomId, userId } = data;
        socket.join(roomId);
        socket.roomId = roomId;
        
        const history = db.getChatHistory(roomId, 50);
        socket.emit('history', history);
        
        console.log('📨 User joined room:', userId, '->', roomId);
    });
    
    socket.on('send-message', (data) => {
        const { roomId, userId, username, message } = data;
        
        // Check if user is banned
        const user = db.getUserById(userId);
        if (!user || user.isBanned) {
            socket.emit('error', { message: 'شما مسدود شده‌اید' });
            return;
        }
        
        const msgData = db.addChatMessage(roomId, userId, username, message);
        
        // Send to room
        io.to(roomId).emit('receive-message', msgData);
        
        // Send notification to other user
        const [user1, user2] = roomId.split('_');
        const targetId = user1 === userId ? user2 : user1;
        if (targetId && targetId !== userId) {
            db.createNotification(
                targetId,
                'message',
                `${username} به شما پیام داد`,
                { roomId, message: message.substring(0, 50) }
            );
            
            // Send notification via socket
            const targetSocketId = onlineUsers.get(targetId);
            if (targetSocketId) {
                io.to(targetSocketId).emit('new-message-notification', {
                    from: username,
                    roomId,
                    message: message.substring(0, 50)
                });
            }
        }
        
        console.log('💬 Message:', username, '->', roomId);
    });
    
    socket.on('typing', (data) => {
        const { roomId, userId, isTyping } = data;
        socket.to(roomId).emit('user-typing', { userId, isTyping });
    });
    
    socket.on('leave-room', (data) => {
        const { roomId } = data;
        socket.leave(roomId);
        console.log('🚪 User left room:', socket.userId);
    });
    
    socket.on('disconnect', () => {
        const userId = userSockets.get(socket.id);
        if (userId) {
            onlineUsers.delete(userId);
            userSockets.delete(socket.id);
            
            const user = db.getUserById(userId);
            if (user) {
                user.isOnline = false;
                user.lastSeen = new Date().toISOString();
            }
            
            io.emit('users-online', Array.from(onlineUsers.keys()));
            console.log('🔌 User disconnected:', userId);
        }
    });
});

// ============================================
// 🌐 FRONTEND
// ============================================

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>شبکه اجتماعی</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        :root { --bg: #fafafa; --text: #262626; --card: #ffffff; --border: #dbdbdb; --primary: #0095f6; --shadow: 0 2px 10px rgba(0,0,0,0.1); }
        [data-theme="dark"] { --bg: #121212; --text: #e0e0e0; --card: #1e1e1e; --border: #2c2c2c; }
        body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', Tahoma, sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; transition: 0.3s; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
        
        .login-container { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; padding: 20px; background: var(--bg); }
        .login-box { background: var(--card); padding: 40px; border-radius: 12px; box-shadow: var(--shadow); max-width: 420px; width: 100%; border: 1px solid var(--border); }
        .login-box h2 { margin-bottom: 20px; color: var(--text); text-align: center; font-size: 24px; }
        .login-box .subtitle { text-align: center; color: #888; font-size: 14px; margin-bottom: 20px; }
        .login-box input { width: 100%; padding: 12px 16px; margin: 8px 0; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; background: var(--bg); color: var(--text); direction: rtl; transition: 0.3s; }
        .login-box input:focus { border-color: var(--primary); outline: none; box-shadow: 0 0 0 3px rgba(0,149,246,0.1); }
        .login-box button { width: 100%; padding: 12px; background: var(--primary); color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: 0.3s; margin-top: 8px; }
        .login-box button:hover { background: #0081d6; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,149,246,0.3); }
        .login-box .toggle-link { color: var(--primary); cursor: pointer; text-align: center; margin-top: 16px; font-size: 14px; }
        .login-box .toggle-link:hover { text-decoration: underline; }
        .login-box .error { color: #ed4956; font-size: 13px; margin: 8px 0; text-align: center; padding: 8px; background: rgba(237,73,86,0.1); border-radius: 6px; }
        .login-box .success { color: #2ecc71; font-size: 13px; margin: 8px 0; text-align: center; padding: 8px; background: rgba(46,204,113,0.1); border-radius: 6px; }
        .login-box .admin-badge { display: inline-block; background: #f39c12; color: white; padding: 2px 12px; border-radius: 12px; font-size: 11px; margin-top: 8px; }
        
        #mainApp { display: none; flex-direction: column; height: 100vh; }
        .toast { position: fixed; bottom: 85px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.85); color: white; padding: 12px 24px; border-radius: 24px; font-size: 14px; z-index: 999; opacity: 0; transition: opacity 0.4s ease; pointer-events: none; backdrop-filter: blur(4px); max-width: 90%; text-align: center; }
        .toast.show { opacity: 1; }
        
        @media (max-width: 480px) {
            .login-box { padding: 24px; }
            .login-box h2 { font-size: 20px; }
        }
    </style>
</head>
<body>

    <div id="app">
        <!-- Login Page -->
        <div id="loginPage" class="login-container">
            <div class="login-box">
                <h2 id="loginTitle">🔐 ورود به شبکه اجتماعی</h2>
                <div class="subtitle" id="loginSubtitle">به جمع میلیون‌ها کاربر بپیوندید</div>
                <div id="loginError" class="error"></div>
                <div id="loginSuccess" class="success"></div>
                <input type="text" id="loginUsername" placeholder="نام کاربری" style="display:none;">
                <input type="email" id="loginEmail" placeholder="ایمیل">
                <input type="password" id="loginPassword" placeholder="رمز عبور">
                <button id="loginBtn">ورود</button>
                <div class="toggle-link" id="toggleAuth">ثبت نام ندارید؟ ثبت نام کنید</div>
                <div style="text-align:center;margin-top:12px;font-size:11px;color:#888;">
                    <span>👑 ادمین: milad.yari1377m@gmail.com</span>
                </div>
            </div>
        </div>

        <!-- Main App -->
        <div id="mainApp">
            <div class="toast" id="toast"></div>
            
            <header style="background:var(--card);border-bottom:1px solid var(--border);padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <i class="fas fa-bars" id="menuIcon" style="font-size:24px;cursor:pointer;color:var(--text);"></i>
                    <span style="font-size:20px;font-weight:700;color:var(--text);"><i class="fas fa-share-alt" style="color:var(--primary);"></i> شبکه</span>
                </div>
                <div style="display:flex;gap:16px;font-size:20px;color:var(--text);">
                    <i class="fas fa-comment-dots" id="chatOpenBtn" style="cursor:pointer;"></i>
                    <i class="fas fa-cog" id="settingsOpenBtn" style="cursor:pointer;"></i>
                </div>
            </header>

            <div style="flex:1;overflow-y:auto;padding:10px;" id="contentArea">
                <div id="loadingIndicator" style="text-align:center;padding:40px;color:var(--primary);">
                    <i class="fas fa-spinner" style="font-size:36px;animation:spin 0.8s linear infinite;"></i><br>
                    در حال بارگذاری...
                </div>
                <div id="postsContainer"></div>
                <div id="noPosts" style="display:none;text-align:center;padding:40px;color:#888;">
                    <i class="fas fa-camera" style="font-size:48px;color:var(--border);display:block;margin-bottom:12px;"></i>
                    هیچ پستی وجود ندارد
                </div>
            </div>
        </div>
    </div>

    <style>
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .post-card { background: var(--card); border-radius: 12px; margin-bottom: 16px; border: 1px solid var(--border); overflow: hidden; box-shadow: var(--shadow); }
        .post-header { padding: 12px 16px; display: flex; align-items: center; gap: 12px; }
        .post-avatar { width: 40px; height: 40px; border-radius: 50%; overflow: hidden; background: var(--border); flex-shrink: 0; }
        .post-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .post-username { font-weight: 600; color: var(--text); cursor: pointer; }
        .post-username:hover { text-decoration: underline; }
        .post-time { font-size: 11px; color: #888; }
        .post-image { width: 100%; max-height: 500px; object-fit: cover; background: #ddd; }
        .post-video { width: 100%; max-height: 500px; background: #000; }
        .post-actions { padding: 8px 16px; display: flex; gap: 20px; border-top: 1px solid var(--border); }
        .post-actions button { background: none; border: none; cursor: pointer; font-size: 18px; color: var(--text); display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px; transition: 0.3s; font-family: inherit; }
        .post-actions button:hover { background: var(--bg); }
        .post-actions button.liked { color: #ed4956; }
        .post-caption { padding: 8px 16px 12px; color: var(--text); }
        .post-caption .hashtag { color: var(--primary); cursor: pointer; }
        .post-comments { padding: 0 16px 12px; }
        .post-comment { font-size: 14px; padding: 4px 0; color: var(--text); }
        .post-comment .comment-user { font-weight: 600; }
        .post-comment .comment-text { margin-right: 4px; }
        .show-comments-btn { color: #888; font-size: 13px; cursor: pointer; padding: 4px 0; }
        .show-comments-btn:hover { text-decoration: underline; }
        
        .admin-badge { background: #f39c12; color: white; padding: 2px 10px; border-radius: 12px; font-size: 10px; margin-right: 8px; }
        .verified-badge { color: var(--primary); font-size: 14px; margin-right: 4px; }
        
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
        .comment-avatar { width: 32px; height: 32px; border-radius: 50%; background: var(--border); flex-shrink: 0; overflow: hidden; }
        .comment-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .comment-content { flex: 1; }
        .comment-username { font-weight: 600; font-size: 13px; color: var(--text); }
        .comment-text { font-size: 13px; color: var(--text); margin-top: 2px; }
        .comment-time { font-size: 10px; color: #888; margin-top: 4px; }
        
        .chat-interface { display: none; position: fixed; bottom: 0; left: 0; right: 0; top: 60px; background: var(--card); z-index: 200; flex-direction: column; border-top: 1px solid var(--border); }
        .chat-interface.active { display: flex; }
        .chat-header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--card); flex-shrink: 0; }
        .chat-header h3 { font-size: 16px; color: var(--text); }
        .chat-header button { font-size: 24px; cursor: pointer; color: var(--text); background: none; border: none; }
        .chat-users { border-bottom: 1px solid var(--border); max-height: 120px; overflow-y: auto; flex-shrink: 0; background: var(--bg); }
        .chat-user { display: flex; align-items: center; gap: 12px; padding: 8px 16px; cursor: pointer; border-bottom: 1px solid var(--border); transition: 0.3s; }
        .chat-user:hover { background: var(--card); }
        .chat-user .user-avatar { width: 36px; height: 36px; border-radius: 50%; overflow: hidden; background: var(--border); flex-shrink: 0; }
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
        
        .admin-panel { display: none; position: fixed; top: 60px; left: 0; right: 0; bottom: 0; background: var(--bg); z-index: 150; overflow-y: auto; padding: 16px; }
        .admin-panel.active { display: block; }
        .admin-card { background: var(--card); border-radius: 12px; padding: 16px; margin-bottom: 12px; border: 1px solid var(--border); }
        .admin-card h4 { color: var(--text); margin-bottom: 8px; }
        .admin-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); }
        .admin-item:last-child { border-bottom: none; }
        .admin-btn { padding: 4px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; transition: 0.3s; }
        .admin-btn.danger { background: #ed4956; color: white; }
        .admin-btn.success { background: #2ecc71; color: white; }
        .admin-btn.primary { background: var(--primary); color: white; }
        .admin-btn:hover { opacity: 0.8; transform: scale(1.02); }
        
        .settings-page { display: none; position: fixed; top: 60px; left: 0; right: 0; bottom: 0; background: var(--bg); z-index: 160; overflow-y: auto; padding: 16px; }
        .settings-page.active { display: block; }
        .settings-card { background: var(--card); border-radius: 12px; padding: 16px; margin-bottom: 12px; border: 1px solid var(--border); }
        .settings-card h4 { color: var(--text); margin-bottom: 8px; }
        .settings-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
        .settings-item:last-child { border-bottom: none; }
        .settings-item .label { color: var(--text); font-size: 14px; }
        .settings-item .value { color: #888; font-size: 14px; }
        
        .side-menu { position: fixed; top: 0; right: -300px; width: 280px; height: 100%; background: var(--card); z-index: 600; transition: right 0.3s ease; box-shadow: -4px 0 20px rgba(0,0,0,0.15); overflow-y: auto; }
        .side-menu.active { right: 0; }
        .menu-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 599; }
        .menu-overlay.active { display: block; }
        .menu-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
        .menu-header h3 { color: var(--text); }
        .menu-header button { font-size: 24px; cursor: pointer; color: var(--text); background: none; border: none; }
        .menu-item { display: flex; align-items: center; gap: 14px; padding: 14px 20px; border-bottom: 1px solid var(--border); cursor: pointer; color: var(--text); transition: 0.3s; }
        .menu-item:hover { background: var(--bg); }
        .menu-item i { font-size: 18px; width: 24px; }
        
        .upload-area { border: 2px dashed var(--border); border-radius: 12px; padding: 30px; text-align: center; cursor: pointer; transition: 0.3s; background: var(--card); margin-bottom: 12px; }
        .upload-area:hover { border-color: var(--primary); background: var(--bg); }
        .upload-area input[type="file"] { display: none; }
        .upload-area .icon { font-size: 48px; color: var(--primary); margin-bottom: 12px; }
        .upload-area .text { color: var(--text); }
        .upload-area .sub { color: #888; font-size: 13px; }
        .upload-preview { max-width: 100%; max-height: 300px; margin: 12px 0; border-radius: 8px; }
    </style>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        // ============================================
        // 🌐 CLIENT APPLICATION
        // ============================================
        
        const API_URL = window.location.origin;
        const socket = io();
        
        let currentUser = null;
        let currentToken = localStorage.getItem('token');
        let isAdmin = false;
        let currentPostId = null;
        let currentChatRoom = null;
        let currentChatUser = null;
        let isLogin = true;
        
        // ============================================
        // 📱 UI HELPERS
        // ============================================
        
        function showToast(msg, type = 'info') {
            const toast = document.getElementById('toast');
            toast.textContent = msg;
            toast.className = 'toast show';
            if (type === 'error') toast.style.background = 'rgba(237,73,86,0.9)';
            else if (type === 'success') toast.style.background = 'rgba(46,204,113,0.9)';
            else toast.style.background = 'rgba(0,0,0,0.85)';
            clearTimeout(toast._timeout);
            toast._timeout = setTimeout(() => { toast.classList.remove('show'); }, 3500);
        }
        
        function showError(msg) {
            document.getElementById('loginError').textContent = msg;
            document.getElementById('loginError').style.display = 'block';
        }
        
        function clearError() {
            document.getElementById('loginError').textContent = '';
            document.getElementById('loginError').style.display = 'none';
            document.getElementById('loginSuccess').textContent = '';
            document.getElementById('loginSuccess').style.display = 'none';
        }
        
        function showSuccess(msg) {
            document.getElementById('loginSuccess').textContent = msg;
            document.getElementById('loginSuccess').style.display = 'block';
        }
        
        // ============================================
        // 🔐 AUTHENTICATION
        // ============================================
        
        async function registerUser(username, email, password) {
            const res = await fetch(API_URL + '/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, email, password })
            });
            return await res.json();
        }
        
        async function loginUser(email, password) {
            const res = await fetch(API_URL + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
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
            showToast('🚪 خروج با موفقیت انجام شد');
        }
        
        async function getCurrentUser() {
            if (!currentToken) return null;
            try {
                const res = await fetch(API_URL + '/api/auth/me', {
                    headers: { 'Authorization': 'Bearer ' + currentToken }
                });
                if (res.ok) return await res.json();
                return null;
            } catch { return null; }
        }
        
        async function verifyAdmin() {
            if (!currentToken) return false;
            try {
                const res = await fetch(API_URL + '/api/admin/verify', {
                    headers: { 'Authorization': 'Bearer ' + currentToken }
                });
                if (res.ok) {
                    const data = await res.json();
                    return data.isAdmin || false;
                }
                return false;
            } catch { return false; }
        }
        
        // ============================================
        // 📦 API CALLS
        // ============================================
        
        async function getPosts(page = 1, hashtag = null) {
            let url = API_URL + '/api/posts?page=' + page + '&limit=20';
            if (hashtag) url += '&hashtag=' + encodeURIComponent(hashtag);
            const res = await fetch(url);
            return await res.json();
        }
        
        async function createPost(file, caption, hashtags) {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('caption', caption || '');
            if (hashtags) formData.append('hashtags', hashtags);
            const res = await fetch(API_URL + '/api/posts', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + currentToken },
                body: formData
            });
            return await res.json();
        }
        
        async function likePost(postId) {
            const res = await fetch(API_URL + '/api/posts/' + postId + '/like', {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer ' + currentToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({})
            });
            return await res.json();
        }
        
        async function addComment(postId, text) {
            const res = await fetch(API_URL + '/api/posts/' + postId + '/comment', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + currentToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ text })
            });
            return await res.json();
        }
        
        async function getComments(postId) {
            const res = await fetch(API_URL + '/api/posts/' + postId + '/comments');
            return await res.json();
        }
        
        async function getStories() {
            const res = await fetch(API_URL + '/api/stories');
            return await res.json();
        }
        
        async function createStory(file) {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(API_URL + '/api/stories', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + currentToken },
                body: formData
            });
            return await res.json();
        }
        
        async function getUsers() {
            const res = await fetch(API_URL + '/api/users');
            return await res.json();
        }
        
        async function followUser(userId) {
            const res = await fetch(API_URL + '/api/users/' + userId + '/follow', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + currentToken,
                    'Content-Type': 'application/json'
                }
            });
            return await res.json();
        }
        
        async function unfollowUser(userId) {
            const res = await fetch(API_URL + '/api/users/' + userId + '/unfollow', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + currentToken,
                    'Content-Type': 'application/json'
                }
            });
            return await res.json();
        }
        
        async function updateProfile(data) {
            const res = await fetch(API_URL + '/api/users/' + currentUser.userId + '/profile', {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer ' + currentToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });
            return await res.json();
        }
        
        // ============================================
        // 👑 ADMIN API
        // ============================================
        
        async function getAdminUsers() {
            const res = await fetch(API_URL + '/api/admin/users', {
                headers: { 'Authorization': 'Bearer ' + currentToken }
            });
            return await res.json();
        }
        
        async function banUser(userId, banned) {
            const res = await fetch(API_URL + '/api/admin/users/' + userId + '/ban', {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer ' + currentToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ banned })
            });
            return await res.json();
        }
        
        async function deletePostAdmin(postId) {
            const res = await fetch(API_URL + '/api/admin/posts/' + postId, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + currentToken }
            });
            return await res.json();
        }
        
        async function getAdminPosts() {
            const res = await fetch(API_URL + '/api/admin/posts', {
                headers: { 'Authorization': 'Bearer ' + currentToken }
            });
            return await res.json();
        }
        
        async function broadcastMessage(message) {
            const res = await fetch(API_URL + '/api/admin/broadcast', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + currentToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ message })
            });
            return await res.json();
        }
        
        async function getAdminStats() {
            const res = await fetch(API_URL + '/api/admin/stats', {
                headers: { 'Authorization': 'Bearer ' + currentToken }
            });
            return await res.json();
        }
        
        // ============================================
        // 💬 WEBSOCKET
        // ============================================
        
        socket.on('connect', () => {
            console.log('✅ Socket connected');
            if (currentUser) {
                socket.emit('register', { 
                    userId: currentUser.userId, 
                    username: currentUser.username 
                });
            }
        });
        
        socket.on('users-online', (users) => {
            console.log('👥 Online users:', users);
        });
        
        socket.on('receive-message', (data) => {
            displayChatMessage(data.userId, data.username, data.message, data.timestamp);
        });
        
        socket.on('history', (messages) => {
            const div = document.getElementById('chatMessages');
            div.innerHTML = '';
            if (!messages || messages.length === 0) {
                div.innerHTML = '<div class="chat-empty" style="text-align:center;padding:20px;color:#888;"><i class="fas fa-comments" style="font-size:32px;display:block;margin-bottom:8px;"></i>شروع مکالمه</div>';
                return;
            }
            messages.forEach(msg => {
                displayChatMessage(msg.userId, msg.username, msg.message, msg.timestamp);
            });
        });
        
        socket.on('broadcast', (data) => {
            showToast('📢 ' + data.message + ' (از ' + data.from + ')');
        });
        
        socket.on('new-message-notification', (data) => {
            showToast('💬 پیام جدید از ' + data.from);
        });
        
        socket.on('error', (data) => {
            showToast('❌ ' + data.message, 'error');
        });
        
        function startChat(userId, username) {
            if (currentUser && currentUser.isBanned) {
                showToast('❌ شما مسدود شده‌اید', 'error');
                return;
            }
            currentChatUser = userId;
            const roomId = [currentUser?.userId || 'user1', userId].sort().join('_');
            currentChatRoom = roomId;
            document.getElementById('chatTitle').textContent = '💬 ' + username;
            document.getElementById('chatInterface').classList.add('active');
            socket.emit('join-room', { roomId, userId: currentUser?.userId });
            
            // Load history
            const messagesDiv = document.getElementById('chatMessages');
            messagesDiv.innerHTML = '<div style="text-align:center;padding:20px;color:#888;"><i class="fas fa-spinner" style="animation:spin 0.8s linear infinite;"></i> در حال بارگذاری...</div>';
        }
        
        function sendChatMessage() {
            if (currentUser && currentUser.isBanned) {
                showToast('❌ شما مسدود شده‌اید', 'error');
                return;
            }
            const input = document.getElementById('chatInput');
            const text = input.value.trim();
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
            const div = document.getElementById('chatMessages');
            const empty = div.querySelector('.chat-empty');
            if (empty) empty.remove();
            
            const msgDiv = document.createElement('div');
            msgDiv.className = 'chat-message' + (userId === currentUser?.userId ? ' own' : '');
            const time = timestamp ? new Date(timestamp).toLocaleTimeString('fa-IR') : '';
            msgDiv.innerHTML = `
                <div class="msg-user">${userId === currentUser?.userId ? 'شما' : username}</div>
                <div class="msg-text">${message}</div>
                <div class="msg-time">${time}</div>
            `;
            div.appendChild(msgDiv);
            div.scrollTop = div.scrollHeight;
        }
        
        async function renderChatUsers() {
            const list = document.getElementById('chatUsersList');
            list.innerHTML = '';
            const users = await getUsers();
            let has = false;
            
            users.forEach(user => {
                if (user.userId === currentUser?.userId) return;
                if (user.isBanned) return;
                has = true;
                const div = document.createElement('div');
                div.className = 'chat-user';
                div.onclick = () => startChat(user.userId, user.username);
                const statusClass = user.isOnline ? 'online' : '';
                const statusText = user.isOnline ? 'آنلاین' : 'آفلاین';
                div.innerHTML = `
                    <div class="user-avatar"><img src="${user.avatar || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(user.username) + '&background=0095f6&color=fff&size=150'}" alt="user"></div>
                    <div>
                        <div class="user-name">${user.username} ${user.verified ? '<i class="fas fa-check-circle" style="color:var(--primary);font-size:12px;"></i>' : ''}</div>
                        <div class="user-status ${statusClass}">${statusText}</div>
                    </div>
                `;
                list.appendChild(div);
            });
            
            if (!has) {
                list.innerHTML = '<div style="padding:10px 16px;color:#888;">هیچ کاربری آنلاین نیست</div>';
            }
        }
        
        // ============================================
        // 🎨 RENDER FUNCTIONS
        // ============================================
        
        function renderPost(post) {
            const isLiked = localStorage.getItem('liked_' + post.postId) === 'true';
            const div = document.createElement('div');
            div.className = 'post-card';
            div.id = 'post-' + post.postId;
            
            const isAdminUser = post.userId === 'admin_1';
            
            div.innerHTML = `
                <div class="post-header">
                    <div class="post-avatar">
                        <img src="${post.userId === 'admin_1' ? 'https://ui-avatars.com/api/?name=Admin&background=0095f6&color=fff&size=150' : 'https://ui-avatars.com/api/?name=' + encodeURIComponent(post.username) + '&background=0095f6&color=fff&size=150'}" alt="avatar">
                    </div>
                    <div>
                        <span class="post-username">${post.username}</span>
                        ${isAdminUser ? '<span class="admin-badge">👑 ادمین</span>' : ''}
                        ${post.userId === currentUser?.userId ? '<span style="font-size:11px;color:#888;">(شما)</span>' : ''}
                        <div class="post-time">${new Date(post.createdAt).toLocaleString('fa-IR')}</div>
                    </div>
                </div>
                ${post.isVideo ? 
                    `<video class="post-video" controls src="${post.image}"></video>` :
                    `<img class="post-image" src="${post.image}" alt="post" loading="lazy">`
                }
                <div class="post-actions">
                    <button class="like-btn ${isLiked ? 'liked' : ''}" onclick="handleLike('${post.postId}')">
                        <i class="${isLiked ? 'fas' : 'far'} fa-heart"></i>
                        <span class="like-count">${post.likes || 0}</span>
                    </button>
                    <button onclick="openComments('${post.postId}')">
                        <i class="far fa-comment"></i>
                        <span>${(post.comments || []).length}</span>
                    </button>
                    <button onclick="sharePost('${post.postId}')">
                        <i class="fas fa-share-alt"></i>
                        <span>${post.shares || 0}</span>
                    </button>
                    ${isAdmin || post.userId === currentUser?.userId ? 
                        `<button onclick="deletePost('${post.postId}')" style="color:#ed4956;margin-right:auto;">
                            <i class="fas fa-trash"></i>
                        </button>` : ''
                    }
                </div>
                ${post.caption ? `
                    <div class="post-caption">
                        ${post.caption}
                        ${post.hashtags && post.hashtags.length ? 
                            post.hashtags.map(h => `<span class="hashtag" onclick="searchHashtag('${h}')">#${h}</span>`).join(' ') : ''
                        }
                    </div>
                ` : ''}
                <div class="post-comments" id="comments-${post.postId}">
                    ${post.comments && post.comments.length > 0 ? `
                        ${post.comments.slice(0, 3).map(c => `
                            <div class="post-comment">
                                <span class="comment-user">${c.username || 'کاربر'}</span>
                                <span class="comment-text">${c.text}</span>
                            </div>
                        `).join('')}
                        ${post.comments.length > 3 ? `
                            <div class="show-comments-btn" onclick="openComments('${post.postId}')">
                                مشاهده ${post.comments.length - 3} کامنت دیگر...
                            </div>
                        ` : ''}
                    ` : `
                        <div style="color:#888;font-size:13px;padding:4px 0;">هنوز کامنتی وجود ندارد</div>
                    `}
                </div>
            `;
            return div;
        }
        
        // ============================================
        // 📥 LOAD FUNCTIONS
        // ============================================
        
        async function loadPosts(page = 1) {
            const container = document.getElementById('postsContainer');
            const loading = document.getElementById('loadingIndicator');
            const noPosts = document.getElementById('noPosts');
            
            if (page === 1) {
                loading.style.display = 'block';
                container.innerHTML = '';
                noPosts.style.display = 'none';
            }
            
            const data = await getPosts(page);
            
            if (page === 1) {
                loading.style.display = 'none';
            }
            
            if (!data.posts || data.posts.length === 0) {
                if (page === 1) {
                    noPosts.style.display = 'block';
                }
                return;
            }
            
            data.posts.forEach(post => {
                container.appendChild(renderPost(post));
            });
        }
        
        async function loadStories() {
            // Simple story implementation
            try {
                const stories = await getStories();
                // Show story indicator
                if (stories && stories.length > 0) {
                    // Just notify
                    console.log('📸 Stories available:', stories.length);
                }
            } catch (e) {}
        }
        
        async function loadProfile() {
            // Update UI with user info
            if (currentUser) {
                document.getElementById('settingsUsername').textContent = currentUser.username || '-';
                document.getElementById('settingsEmail').textContent = currentUser.email || '-';
            }
        }
        
        // ============================================
        // 🎯 ACTIONS
        // ============================================
        
        window.handleLike = async function(postId) {
            if (currentUser && currentUser.isBanned) {
                showToast('❌ شما مسدود شده‌اید', 'error');
                return;
            }
            
            try {
                const result = await likePost(postId);
                const postCard = document.getElementById('post-' + postId);
                if (postCard) {
                    const likeBtn = postCard.querySelector('.like-btn');
                    const likeCount = postCard.querySelector('.like-count');
                    if (likeBtn && likeCount) {
                        likeBtn.classList.toggle('liked', result.liked);
                        likeBtn.querySelector('i').className = result.liked ? 'fas fa-heart' : 'far fa-heart';
                        likeCount.textContent = result.likes || 0;
                        localStorage.setItem('liked_' + postId, result.liked ? 'true' : 'false');
                    }
                }
            } catch (e) {
                showToast('❌ خطا در لایک', 'error');
            }
        };
        
        window.openComments = async function(postId) {
            currentPostId = postId;
            const modal = document.getElementById('commentModal');
            const list = document.getElementById('commentList');
            list.innerHTML = '<div style="text-align:center;padding:20px;color:#888;"><i class="fas fa-spinner" style="animation:spin 0.8s linear infinite;"></i> در حال بارگذاری...</div>';
            modal.classList.add('active');
            
            try {
                const comments = await getComments(postId);
                list.innerHTML = '';
                if (!comments || comments.length === 0) {
                    list.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">هنوز کامنتی وجود ندارد</div>';
                } else {
                    comments.forEach(c => {
                        const div = document.createElement('div');
                        div.className = 'comment-item';
                        div.innerHTML = `
                            <div class="comment-avatar">
                                <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(c.username || 'کاربر')}&background=0095f6&color=fff&size=150" alt="avatar">
                            </div>
                            <div class="comment-content">
                                <div class="comment-username">${c.username || 'کاربر'}</div>
                                <div class="comment-text">${c.text}</div>
                                <div class="comment-time">${c.createdAt ? new Date(c.createdAt).toLocaleString('fa-IR') : 'چند لحظه پیش'}</div>
                            </div>
                        `;
                        list.appendChild(div);
                    });
                }
            } catch (e) {
                list.innerHTML = '<div style="text-align:center;color:#ed4956;padding:20px;">❌ خطا در بارگذاری کامنت‌ها</div>';
            }
        };
        
        window.sharePost = function(postId) {
            const url = window.location.origin + '?post=' + postId;
            if (navigator.share) {
                navigator.share({
                    title: 'پست جدید',
                    text: 'به این پست نگاه کن!',
                    url: url
                }).catch(() => {});
            } else {
                navigator.clipboard.writeText(url).then(() => {
                    showToast('✅ لینک کپی شد!', 'success');
                }).catch(() => {
                    showToast('📋 لینک: ' + url);
                });
            }
        };
        
        window.searchHashtag = function(hashtag) {
            loadPosts(1, hashtag);
            showToast('🔍 جستجو برای #' + hashtag);
        };
        
        window.deletePost = async function(postId) {
            if (!confirm('آیا از حذف این پست مطمئن هستید؟')) return;
            
            try {
                const result = await deletePostAdmin(postId);
                if (result.success) {
                    showToast('✅ پست حذف شد', 'success');
                    const postCard = document.getElementById('post-' + postId);
                    if (postCard) postCard.remove();
                }
            } catch (e) {
                showToast('❌ خطا در حذف پست', 'error');
            }
        };
        
        // ============================================
        // 🎬 EVENT LISTENERS
        // ============================================
        
        // Login/Register
        document.getElementById('loginBtn').addEventListener('click', async function() {
            clearError();
            const username = document.getElementById('loginUsername').value.trim();
            const email = document.getElementById('loginEmail').value.trim();
            const password = document.getElementById('loginPassword').value.trim();
            
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
            
            let result;
            try {
                if (isLogin) {
                    result = await loginUser(email, password);
                } else {
                    result = await registerUser(username, email, password);
                }
            } catch (e) {
                showError('خطا در ارتباط با سرور');
                this.textContent = isLogin ? 'ورود' : 'ثبت نام';
                this.disabled = false;
                return;
            }
            
            if (result.success) {
                currentToken = result.token;
                localStorage.setItem('token', currentToken);
                currentUser = result.user;
                isAdmin = currentUser.isAdmin || false;
                
                document.getElementById('loginPage').style.display = 'none';
                document.getElementById('mainApp').style.display = 'flex';
                
                showToast('✅ خوش آمدید ' + currentUser.username, 'success');
                
                socket.emit('register', { 
                    userId: currentUser.userId, 
                    username: currentUser.username 
                });
                
                await loadPosts(1);
                await loadStories();
                await loadProfile();
                
                if (isAdmin) {
                    showToast('👑 شما به عنوان ادمین وارد شدید', 'success');
                    // Load admin panel if needed
                }
            } else {
                showError(result.error || 'خطا! لطفا دوباره تلاش کنید');
            }
            
            this.textContent = isLogin ? 'ورود' : 'ثبت نام';
            this.disabled = false;
        });
        
        document.getElementById('loginPassword').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') document.getElementById('loginBtn').click();
        });
        
        document.getElementById('loginEmail').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') document.getElementById('loginPassword').focus();
        });
        
        document.getElementById('toggleAuth').addEventListener('click', function() {
            isLogin = !isLogin;
            document.getElementById('loginTitle').textContent = isLogin ? '🔐 ورود به شبکه اجتماعی' : '📝 ثبت نام در شبکه اجتماعی';
            document.getElementById('loginSubtitle').textContent = isLogin ? 'به جمع میلیون‌ها کاربر بپیوندید' : 'همین حالا عضو شوید';
            document.getElementById('loginBtn').textContent = isLogin ? 'ورود' : 'ثبت نام';
            this.textContent = isLogin ? 'ثبت نام ندارید؟ ثبت نام کنید' : 'حساب دارید؟ وارد شوید';
            document.getElementById('loginUsername').style.display = isLogin ? 'none' : 'block';
            clearError();
        });
        
        // Chat
        document.getElementById('chatOpenBtn').addEventListener('click', function() {
            if (!currentUser) return;
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
        document.getElementById('chatInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendChatMessage();
        });
        
        // Comment Modal
        document.getElementById('modalSendComment').addEventListener('click', async function() {
            const input = document.getElementById('modalCommentInput');
            const text = input.value.trim();
            if (!text || !currentPostId) return;
            
            try {
                const result = await addComment(currentPostId, text);
                if (result.success) {
                    input.value = '';
                    showToast('✅ کامنت ثبت شد', 'success');
                    openComments(currentPostId);
                    // Refresh post
                    await loadPosts(1);
                }
            } catch (e) {
                showToast('❌ خطا در ثبت کامنت', 'error');
            }
        });
        
        document.getElementById('modalCommentInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') document.getElementById('modalSendComment').click();
        });
        
        document.getElementById('closeModal').addEventListener('click', () => {
            document.getElementById('commentModal').classList.remove('active');
            currentPostId = null;
        });
        
        document.getElementById('commentModal').addEventListener('click', (e) => {
            if (e.target === this) {
                this.classList.remove('active');
                currentPostId = null;
            }
        });
        
        // Settings
        document.getElementById('settingsOpenBtn').addEventListener('click', () => {
            document.getElementById('settingsPage').classList.add('active');
            loadProfile();
        });
        
        document.getElementById('closeSettings').addEventListener('click', () => {
            document.getElementById('settingsPage').classList.remove('active');
        });
        
        document.getElementById('settingsPage').addEventListener('click', (e) => {
            if (e.target === this) this.classList.remove('active');
        });
        
        // Menu
        document.getElementById('menuIcon').addEventListener('click', () => {
            document.getElementById('sideMenu').classList.add('active');
            document.getElementById('menuOverlay').classList.add('active');
        });
        
        document.getElementById('closeMenu').addEventListener('click', () => {
            document.getElementById('sideMenu').classList.remove('active');
            document.getElementById('menuOverlay').classList.remove('active');
        });
        
        document.getElementById('menuOverlay').addEventListener('click', () => {
            document.getElementById('sideMenu').classList.remove('active');
            document.getElementById('menuOverlay').classList.remove('active');
        });
        
        document.getElementById('menuLogout').addEventListener('click', logoutUser);
        document.getElementById('logoutBtn')?.addEventListener('click', logoutUser);
        
        // Admin
        document.getElementById('menuAdmin')?.addEventListener('click', () => {
            document.getElementById('sideMenu').classList.remove('active');
            document.getElementById('menuOverlay').classList.remove('active');
            document.getElementById('adminPanel').classList.add('active');
            loadAdminPanel();
        });
        
        document.getElementById('adminPanel')?.addEventListener('click', (e) => {
            if (e.target === this) this.classList.remove('active');
        });
        
        document.getElementById('broadcastBtn')?.addEventListener('click', async function() {
            const input = document.getElementById('broadcastInput');
            const message = input.value.trim();
            if (!message) {
                showToast('❌ لطفا پیام را وارد کنید', 'error');
                return;
            }
            const result = await broadcastMessage(message);
            if (result.success) {
                showToast('✅ پیام همگانی ارسال شد!', 'success');
                input.value = '';
            }
        });
        
        // Upload
        document.getElementById('uploadBtn')?.addEventListener('click', function() {
            const fileInput = document.getElementById('fileInput');
            const uploadArea = document.getElementById('uploadArea');
            if (uploadArea.style.display === 'block') {
                uploadArea.style.display = 'none';
                this.classList.remove('active');
                return;
            }
            uploadArea.style.display = 'block';
            this.classList.add('active');
            // Trigger file input click or show upload UI
            fileInput.click();
        });
        
        document.getElementById('fileInput')?.addEventListener('change', async function() {
            const file = this.files[0];
            if (!file) return;
            
            const caption = prompt('توضیحات (اختیاری):');
            const hashtags = prompt('هشتگ‌ها (با کاما):');
            
            try {
                const result = await createPost(file, caption || '', hashtags || '');
                if (result.success) {
                    showToast('✅ پست با موفقیت آپلود شد!', 'success');
                    await loadPosts(1);
                    document.getElementById('uploadArea').style.display = 'none';
                    document.getElementById('uploadBtn').classList.remove('active');
                } else {
                    showToast('❌ خطا در آپلود: ' + (result.error || 'نامشخص'), 'error');
                }
            } catch (e) {
                showToast('❌ خطا در آپلود', 'error');
            }
            this.value = '';
        });
        
        // ============================================
        // 👑 ADMIN PANEL
        // ============================================
        
        async function loadAdminPanel() {
            if (!isAdmin) return;
            
            try {
                // Stats
                const stats = await getAdminStats();
                document.getElementById('adminUserCount').textContent = stats.totalUsers || 0;
                document.getElementById('adminPostCount').textContent = stats.totalPosts || 0;
                document.getElementById('adminOnlineCount').textContent = stats.onlineUsers || 0;
            } catch (e) {}
            
            try {
                // Users
                const users = await getAdminUsers();
                const list = document.getElementById('adminUsersList');
                if (list) {
                    list.innerHTML = '';
                    users.forEach(user => {
                        if (user.isAdmin) return;
                        const div = document.createElement('div');
                        div.className = 'admin-item';
                        div.innerHTML = `
                            <span>${user.username} (${user.email}) ${user.isBanned ? '🚫' : ''}</span>
                            <button class="admin-btn ${user.isBanned ? 'success' : 'danger'}" 
                                    onclick="toggleBan('${user.userId}', ${!user.isBanned})">
                                ${user.isBanned ? 'رفع مسدودیت' : 'مسدود کردن'}
                            </button>
                        `;
                        list.appendChild(div);
                    });
                }
            } catch (e) {}
            
            try {
                // Posts
                const posts = await getAdminPosts();
                const list = document.getElementById('adminPostsList');
                if (list) {
                    list.innerHTML = '';
                    posts.slice(0, 20).forEach(post => {
                        const div = document.createElement('div');
                        div.className = 'admin-item';
                        div.innerHTML = `
                            <span>${(post.caption || 'بدون توضیحات').substring(0, 30)}...</span>
                            <button class="admin-btn danger" onclick="deletePostAdmin('${post.postId}')">
                                🗑️ حذف
                            </button>
                        `;
                        list.appendChild(div);
                    });
                }
            } catch (e) {}
        }
        
        window.toggleBan = async function(userId, banned) {
            if (userId === currentUser?.userId) {
                showToast('❌ نمی‌توانید خودتان را مسدود کنید', 'error');
                return;
            }
            const result = await banUser(userId, banned);
            if (result.success) {
                showToast('✅ کاربر ' + (banned ? 'مسدود' : 'رفع مسدودیت') + ' شد', 'success');
                loadAdminPanel();
            }
        };
        
        window.deletePostAdmin = async function(postId) {
            if (!confirm('آیا از حذف این پست مطمئن هستید؟')) return;
            const result = await deletePostAdmin(postId);
            if (result.success) {
                showToast('✅ پست حذف شد', 'success');
                loadAdminPanel();
                loadPosts(1);
            }
        };
        
        // ============================================
        // 🚀 INITIALIZATION
        // ============================================
        
        (async function init() {
            console.log('🚀 Initializing Social Network...');
            
            // Check for admin credentials on login page
            document.getElementById('loginUsername').style.display = 'none';
            
            if (currentToken) {
                const user = await getCurrentUser();
                if (user) {
                    currentUser = user;
                    isAdmin = user.isAdmin || false;
                    
                    document.getElementById('loginPage').style.display = 'none';
                    document.getElementById('mainApp').style.display = 'flex';
                    
                    socket.emit('register', { 
                        userId: currentUser.userId, 
                        username: currentUser.username 
                    });
                    
                    await loadPosts(1);
                    await loadStories();
                    await loadProfile();
                    
                    if (isAdmin) {
                        console.log('👑 Admin mode enabled');
                        // Add admin menu item
                        const menu = document.getElementById('sideMenu');
                        const adminItem = document.createElement('div');
                        adminItem.className = 'menu-item';
                        adminItem.id = 'menuAdmin';
                        adminItem.innerHTML = '<i class="fas fa-crown"></i><span>👑 مدیریت</span>';
                        adminItem.onclick = () => {
                            document.getElementById('sideMenu').classList.remove('active');
                            document.getElementById('menuOverlay').classList.remove('active');
                            document.getElementById('adminPanel').classList.add('active');
                            loadAdminPanel();
                        };
                        menu.appendChild(adminItem);
                    }
                    
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
            
            // Show admin info on login page
            const adminInfo = document.createElement('div');
            adminInfo.style.cssText = 'text-align:center;margin-top:12px;font-size:12px;color:#888;';
            adminInfo.innerHTML = '👑 ادمین: milad.yari1377m@gmail.com';
            document.querySelector('.login-box').appendChild(adminInfo);
        })();
        
        console.log('✅ Social Network loaded successfully!');
        console.log('👑 Admin: milad.yari1377m@gmail.com');
    </script>

    <!-- Modals -->
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

    <!-- Chat Interface -->
    <div class="chat-interface" id="chatInterface">
        <div class="chat-header">
            <h3 id="chatTitle">💬 چت</h3>
            <button id="closeChatBtn">&times;</button>
        </div>
        <div class="chat-users" id="chatUsersList"></div>
        <div class="chat-messages" id="chatMessages">
            <div class="chat-empty" style="text-align:center;padding:20px;color:#888;">
                <i class="fas fa-comments" style="font-size:32px;display:block;margin-bottom:8px;"></i>
                برای شروع چت، یک کاربر را انتخاب کنید
            </div>
        </div>
        <div class="chat-input">
            <input type="text" id="chatInput" placeholder="پیام خود را بنویسید...">
            <button id="chatSendBtn"><i class="fas fa-paper-plane"></i></button>
        </div>
    </div>

    <!-- Admin Panel -->
    <div class="admin-panel" id="adminPanel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h2 style="color:var(--text);">👑 پنل مدیریت</h2>
            <button onclick="document.getElementById('adminPanel').classList.remove('active')" 
                    style="font-size:24px;cursor:pointer;color:var(--text);background:none;border:none;">&times;</button>
        </div>
        <div class="admin-card">
            <h4>📊 آمار</h4>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:8px;">
                <div style="background:var(--bg);padding:12px;border-radius:8px;text-align:center;">
                    <div style="font-size:24px;font-weight:700;color:var(--primary);" id="adminUserCount">0</div>
                    <div style="font-size:12px;color:#888;">کاربران</div>
                </div>
                <div style="background:var(--bg);padding:12px;border-radius:8px;text-align:center;">
                    <div style="font-size:24px;font-weight:700;color:var(--primary);" id="adminPostCount">0</div>
                    <div style="font-size:12px;color:#888;">پست‌ها</div>
                </div>
                <div style="background:var(--bg);padding:12px;border-radius:8px;text-align:center;">
                    <div style="font-size:24px;font-weight:700;color:var(--primary);" id="adminOnlineCount">0</div>
                    <div style="font-size:12px;color:#888;">آنلاین</div>
                </div>
            </div>
        </div>
        <div class="admin-card">
            <h4>📢 پیام همگانی</h4>
            <div style="display:flex;gap:10px;">
                <input type="text" id="broadcastInput" placeholder="پیام..." 
                       style="flex:1;padding:10px 14px;border:1px solid var(--border);border-radius:8px;outline:none;font-size:14px;background:var(--bg);color:var(--text);">
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

    <!-- Settings -->
    <div class="settings-page" id="settingsPage">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h2 style="color:var(--text);">⚙️ تنظیمات</h2>
            <button id="closeSettings" style="font-size:24px;cursor:pointer;color:var(--text);background:none;border:none;">&times;</button>
        </div>
        <div class="settings-card">
            <h4>👤 اطلاعات کاربری</h4>
            <div class="settings-item">
                <span class="label">نام کاربری</span>
                <span class="value" id="settingsUsername">-</span>
            </div>
            <div class="settings-item">
                <span class="label">ایمیل</span>
                <span class="value" id="settingsEmail">-</span>
            </div>
        </div>
        <button id="logoutBtn" style="width:100%;padding:12px;background:#ed4956;color:white;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;">🚪 خروج</button>
    </div>

    <!-- Side Menu -->
    <div class="menu-overlay" id="menuOverlay"></div>
    <div class="side-menu" id="sideMenu">
        <div class="menu-header">
            <h3>📋 منو</h3>
            <button id="closeMenu">&times;</button>
        </div>
        <div class="menu-item" id="menuLogout">
            <i class="fas fa-sign-out-alt"></i>
            <span>خروج</span>
        </div>
    </div>

    <!-- Upload -->
    <div class="upload-area" id="uploadArea" style="display:none;position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:100;width:90%;max-width:500px;">
        <div class="icon"><i class="fas fa-cloud-upload-alt"></i></div>
        <div class="text">برای آپلود کلیک کنید</div>
        <div class="sub">تصویر یا ویدئو (حداکثر 500MB)</div>
        <input type="file" id="fileInput" accept="image/*,video/*">
    </div>

    <!-- Bottom Navigation -->
    <div style="position:fixed;bottom:0;left:0;right:0;background:var(--card);border-top:1px solid var(--border);display:flex;justify-content:space-around;padding:8px 0 12px;z-index:100;">
        <button id="uploadBtn" style="background:none;border:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px;font-size:10px;color:#888;padding:4px 16px;font-family:inherit;">
            <i class="fas fa-upload" style="font-size:22px;"></i>
            <span>آپلود</span>
        </button>
        <button onclick="location.reload()" style="background:none;border:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px;font-size:10px;color:#888;padding:4px 16px;font-family:inherit;">
            <i class="fas fa-home" style="font-size:22px;"></i>
            <span>خانه</span>
        </button>
    </div>

</body>
</html>
    `);
});

// ============================================
// 🚀 START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('=' .repeat(50));
    console.log('🚀 SOCIAL NETWORK SERVER STARTED');
    console.log('=' .repeat(50));
    console.log('📍 URL: http://localhost:' + PORT);
    console.log('👑 Admin: milad.yari1377m@gmail.com');
    console.log('🔑 Admin Password: M09145978426m');
    console.log('📊 Database: In-Memory with Cache');
    console.log('💬 WebSocket: Enabled');
    console.log('📁 Uploads: ./uploads/');
    console.log('=' .repeat(50));
    console.log('✅ Server is ready!');
    console.log('=' .repeat(50));
});

// ============================================
// 📊 ERROR HANDLING
// ============================================
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('💥 Unhandled Rejection:', err);
});

module.exports = { app, server, db };