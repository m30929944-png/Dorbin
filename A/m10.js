// ============================================
// 🚪 API GATEWAY - ROUTE MANAGEMENT
// ============================================

const { app, db, io } = require('../A/m1.js');
const authService = require('../A/m2.js');
const postService = require('../A/m3.js');
const adminService = require('../A/m4.js');
const interactionService = require('../B/m5.js');
const chatService = require('../B/m6.js');
const liveService = require('../B/m7.js');
const notificationService = require('../B/m8.js');
const wsManager = require('./m9.js');
const uploadService = require('./m11.js');

class APIGateway {
    constructor() {
        this.routes = new Map();
        this.middleware = [];
        this.apiVersion = 'v2';
        this.metrics = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            averageResponseTime: 0
        };
    }

    // ===== AUTH MIDDLEWARE =====
    authMiddleware = async (req, res, next) => {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'دسترسی غیرمجاز' });
        }

        const result = await authService.getCurrentUser(token);
        if (!result.success) {
            return res.status(401).json({ error: result.error });
        }

        req.user = result.user;
        req.token = token;
        next();
    };

    adminMiddleware = async (req, res, next) => {
        const result = await authService.verifyAdmin(req.token);
        if (!result.success) {
            return res.status(403).json({ error: 'دسترسی ادمین مورد نیاز است' });
        }
        req.isAdmin = true;
        next();
    };

    // ===== ROUTE REGISTRATION =====
    registerRoutes() {
        // ===== AUTH ROUTES =====
        app.post('/api/auth/register', async (req, res) => {
            const result = await authService.register(req.body);
            if (result.success) {
                res.json(result);
            } else {
                res.status(400).json(result);
            }
        });

        app.post('/api/auth/login', async (req, res) => {
            const { email, password } = req.body;
            const result = await authService.login(email, password, req.ip);
            if (result.success) {
                res.json(result);
            } else {
                res.status(401).json(result);
            }
        });

        app.post('/api/auth/logout', async (req, res) => {
            const { token } = req.body;
            await authService.logout(token);
            res.json({ success: true });
        });

        app.post('/api/auth/refresh', async (req, res) => {
            const { token } = req.body;
            const result = await authService.refreshToken(token);
            if (result.success) {
                res.json(result);
            } else {
                res.status(401).json(result);
            }
        });

        app.get('/api/auth/me', this.authMiddleware, (req, res) => {
            res.json(req.user);
        });

        // ===== USER ROUTES =====
        app.get('/api/users', this.authMiddleware, async (req, res) => {
            const users = await authService.getAllUsers();
            res.json(users);
        });

        app.get('/api/users/:userId', this.authMiddleware, async (req, res) => {
            const user = db.getUser(req.params.userId);
            if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
            res.json(authService.sanitizeUser(user));
        });

        app.put('/api/users/:userId/profile', this.authMiddleware, async (req, res) => {
            const { userId } = req.params;
            if (userId !== req.user.userId) {
                return res.status(403).json({ error: 'این پروفایل متعلق به شما نیست' });
            }
            const result = await authService.updateProfile(userId, req.body);
            if (result.success) {
                res.json(result);
            } else {
                res.status(400).json(result);
            }
        });

        app.post('/api/users/:userId/follow', this.authMiddleware, async (req, res) => {
            const { userId } = req.params;
            const { followerId } = req.body;
            const result = await authService.follow(followerId, userId);
            if (result.success) {
                const target = db.getUser(userId);
                await notificationService.notifyFollow(userId, followerId);
                wsManager.broadcastOnlineUsers();
                res.json({ success: true, followers: target.followers });
            } else {
                res.status(400).json(result);
            }
        });

        app.post('/api/users/:userId/unfollow', this.authMiddleware, async (req, res) => {
            const { userId } = req.params;
            const { followerId } = req.body;
            const result = await authService.unfollow(followerId, userId);
            if (result.success) {
                const target = db.getUser(userId);
                wsManager.broadcastOnlineUsers();
                res.json({ success: true, followers: target.followers });
            } else {
                res.status(400).json(result);
            }
        });

        app.get('/api/users/search', this.authMiddleware, async (req, res) => {
            const { q } = req.query;
            if (!q) return res.json([]);
            const results = await authService.searchUsers(q);
            res.json(results);
        });

        // ===== POST ROUTES =====
        app.get('/api/posts', this.authMiddleware, (req, res) => {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const hashtag = req.query.hashtag || null;
            const userId = req.query.userId || null;

            const result = postService.getPosts(page, limit, hashtag, userId);
            res.json(result);
        });

        app.post('/api/posts', this.authMiddleware, uploadService.upload.single('file'), async (req, res) => {
            const { caption, userId, username, hashtags, location, mentions } = req.body;
            const file = req.file;

            if (!file) {
                return res.status(400).json({ error: 'فایل الزامی است' });
            }

            const result = await postService.createPost({
                userId: userId || req.user.userId,
                username: username || req.user.username,
                fullName: req.user.fullName,
                caption,
                hashtags,
                location,
                mentions: mentions ? mentions.split(',') : [],
                file: '/uploads/posts/' + file.filename,
                isVideo: file.mimetype.startsWith('video/')
            });

            if (result.success) {
                // Notify followers
                const followers = db.getFollowers(result.post.userId);
                for (const follower of followers) {
                    await notificationService.notifyPost(follower.userId, result.post.userId, result.post.postId);
                    wsManager.sendToUser(follower.userId, 'new-post', {
                        userId: result.post.userId,
                        postId: result.post.postId
                    });
                }
                res.status(201).json(result.post);
            } else {
                res.status(400).json(result);
            }
        });

        app.get('/api/posts/:postId', this.authMiddleware, (req, res) => {
            const post = postService.getPost(req.params.postId);
            if (!post) return res.status(404).json({ error: 'پست یافت نشد' });
            res.json(post);
        });

        app.delete('/api/posts/:postId', this.authMiddleware, async (req, res) => {
            const { postId } = req.params;
            const result = await postService.deletePost(postId, req.user.userId);
            if (result.success) {
                res.json({ success: true });
            } else {
                res.status(404).json(result);
            }
        });

        app.post('/api/posts/:postId/view', this.authMiddleware, async (req, res) => {
            const { postId } = req.params;
            const result = await postService.viewPost(postId, req.user.userId);
            res.json(result);
        });

        app.put('/api/posts/:postId/like', this.authMiddleware, async (req, res) => {
            const { postId } = req.params;
            const result = await interactionService.toggleLike(postId, req.user.userId);
            
            if (result.liked) {
                const post = db.getPost(postId);
                if (post && post.userId !== req.user.userId) {
                    await notificationService.notifyLike(post.userId, req.user.userId, postId);
                    wsManager.sendToUser(post.userId, 'notification', {
                        type: 'like',
                        fromUserId: req.user.userId,
                        postId
                    });
                }
            }
            
            res.json(result);
        });

        app.post('/api/posts/:postId/comment', this.authMiddleware, async (req, res) => {
            const { postId } = req.params;
            const { text, parentId } = req.body;

            const result = await interactionService.addComment(postId, {
                userId: req.user.userId,
                username: req.user.username,
                fullName: req.user.fullName,
                text,
                parentId
            });

            if (result.success) {
                const post = db.getPost(postId);
                if (post && post.userId !== req.user.userId) {
                    await notificationService.notifyComment(post.userId, req.user.userId, postId, result.comment.commentId);
                    wsManager.sendToUser(post.userId, 'notification', {
                        type: 'comment',
                        fromUserId: req.user.userId,
                        postId
                    });
                }
                res.status(201).json(result.comment);
            } else {
                res.status(400).json(result);
            }
        });

        app.delete('/api/posts/:postId/comments/:commentId', this.authMiddleware, async (req, res) => {
            const { postId, commentId } = req.params;
            const result = await interactionService.deleteComment(postId, commentId, req.user.userId);
            if (result.success) {
                res.json({ success: true });
            } else {
                res.status(404).json(result);
            }
        });

        app.put('/api/posts/:postId/comments/:commentId', this.authMiddleware, async (req, res) => {
            const { postId, commentId } = req.params;
            const { text } = req.body;
            const result = await interactionService.editComment(postId, commentId, req.user.userId, text);
            if (result.success) {
                res.json({ success: true });
            } else {
                res.status(404).json(result);
            }
        });

        app.get('/api/posts/:postId/comments', this.authMiddleware, (req, res) => {
            const comments = interactionService.getComments(req.params.postId);
            res.json(comments);
        });

        app.post('/api/posts/:postId/bookmark', this.authMiddleware, async (req, res) => {
            const { postId } = req.params;
            const result = await interactionService.toggleBookmark(postId, req.user.userId);
            res.json(result);
        });

        app.get('/api/bookmarks', this.authMiddleware, (req, res) => {
            const bookmarks = postService.getBookmarks(req.user.userId);
            res.json(bookmarks);
        });

        app.get('/api/trends', this.authMiddleware, (req, res) => {
            const trends = postService.getTrendingHashtags(10);
            res.json(trends);
        });

        // ===== STORY ROUTES =====
        app.get('/api/stories', this.authMiddleware, (req, res) => {
            const stories = postService.getStories();
            res.json(stories);
        });

        app.get('/api/stories/:userId', this.authMiddleware, (req, res) => {
            const stories = postService.getStories(req.params.userId);
            res.json(stories);
        });

        app.post('/api/stories', this.authMiddleware, uploadService.storyUpload.single('file'), async (req, res) => {
            const { userId, username } = req.body;
            const file = req.file;

            if (!file) {
                return res.status(400).json({ error: 'فایل الزامی است' });
            }

            const result = await postService.createStory({
                userId: userId || req.user.userId,
                username: username || req.user.username,
                fullName: req.user.fullName,
                file: '/uploads/stories/' + file.filename,
                isVideo: file.mimetype.startsWith('video/')
            });

            if (result.success) {
                const followers = db.getFollowers(result.story.userId);
                for (const follower of followers) {
                    await notificationService.notifyStory(follower.userId, result.story.userId);
                    wsManager.sendToUser(follower.userId, 'new-story', {
                        userId: result.story.userId,
                        storyId: result.story.storyId
                    });
                }
                res.status(201).json(result.story);
            } else {
                res.status(400).json(result);
            }
        });

        app.delete('/api/stories/:storyId', this.authMiddleware, async (req, res) => {
            const { storyId } = req.params;
            const result = await postService.deleteStory(storyId, req.user.userId);
            if (result.success) {
                res.json({ success: true });
            } else {
                res.status(404).json(result);
            }
        });

        app.post('/api/stories/:storyId/view', this.authMiddleware, async (req, res) => {
            const { storyId } = req.params;
            const result = await postService.viewStory(storyId, req.user.userId);
            res.json(result);
        });

        // ===== CHAT ROUTES =====
        app.get('/api/messages', this.authMiddleware, (req, res) => {
            const { roomId, limit = 50 } = req.query;
            if (!roomId) {
                return res.status(400).json({ error: 'roomId الزامی است' });
            }
            const messages = chatService.getMessages(roomId, parseInt(limit));
            res.json(messages);
        });

        app.get('/api/chat/rooms', this.authMiddleware, (req, res) => {
            const rooms = chatService.getUserRooms(req.user.userId);
            res.json(rooms);
        });

        app.get('/api/chat/unread', this.authMiddleware, (req, res) => {
            const unread = chatService.getTotalUnread(req.user.userId);
            res.json({ unread });
        });

        // ===== LIVE ROUTES =====
        app.post('/api/live/start', this.authMiddleware, async (req, res) => {
            const { title, description, privacy } = req.body;
            const result = await liveService.startStream({
                userId: req.user.userId,
                title,
                description,
                privacy
            });

            if (result.success) {
                const followers = db.getFollowers(req.user.userId);
                for (const follower of followers) {
                    await notificationService.notifyLive(follower.userId, req.user.userId, result.stream.streamId);
                    wsManager.sendToUser(follower.userId, 'live-started', {
                        userId: req.user.userId,
                        streamId: result.stream.streamId
                    });
                }
                wsManager.broadcastMessage(`${req.user.username} لایو را شروع کرد`, 'system', 'live');
                res.json(result);
            } else {
                res.status(400).json(result);
            }
        });

        app.post('/api/live/end', this.authMiddleware, async (req, res) => {
            const { streamId } = req.body;
            const result = await liveService.endStream(streamId, req.user.userId);
            if (result.success) {
                wsManager.broadcastMessage(`لایو به پایان رسید`, 'system', 'live');
                res.json(result);
            } else {
                res.status(404).json(result);
            }
        });

        app.get('/api/live/streams', this.authMiddleware, (req, res) => {
            const streams = liveService.getLiveStreams();
            res.json(streams);
        });

        app.post('/api/live/join', this.authMiddleware, async (req, res) => {
            const { streamId } = req.body;
            const result = await liveService.joinStream(streamId, req.user.userId);
            if (result.success) {
                res.json(result);
            } else {
                res.status(404).json(result);
            }
        });

        app.post('/api/live/leave', this.authMiddleware, async (req, res) => {
            const { streamId } = req.body;
            const result = await liveService.leaveStream(streamId, req.user.userId);
            if (result.success) {
                res.json(result);
            } else {
                res.status(404).json(result);
            }
        });

        // ===== NOTIFICATION ROUTES =====
        app.get('/api/notifications', this.authMiddleware, async (req, res) => {
            const limit = parseInt(req.query.limit) || 50;
            const offset = parseInt(req.query.offset) || 0;
            const notifications = await notificationService.getNotifications(req.user.userId, limit, offset);
            const unread = notificationService.getUnreadCount(req.user.userId);
            res.json({ notifications, unread, total: notifications.length });
        });

        app.post('/api/notifications/:notificationId/read', this.authMiddleware, async (req, res) => {
            const { notificationId } = req.params;
            const result = await notificationService.markRead(notificationId, req.user.userId);
            res.json(result);
        });

        app.post('/api/notifications/read-all', this.authMiddleware, async (req, res) => {
            const result = await notificationService.markAllRead(req.user.userId);
            res.json(result);
        });

        // ===== ADMIN ROUTES =====
        app.get('/api/admin/users', this.authMiddleware, this.adminMiddleware, async (req, res) => {
            const users = await adminService.getAllUsers();
            res.json(users);
        });

        app.put('/api/admin/users/:userId/ban', this.authMiddleware, this.adminMiddleware, async (req, res) => {
            const { userId } = req.params;
            const { banned } = req.body;
            const result = await adminService.banUser(userId, banned, req.user.userId);
            if (result.success) {
                wsManager.broadcastOnlineUsers();
                res.json({ success: true });
            } else {
                res.status(400).json(result);
            }
        });

        app.delete('/api/admin/users/:userId', this.authMiddleware, this.adminMiddleware, async (req, res) => {
            const { userId } = req.params;
            const result = await adminService.deleteUser(userId, req.user.userId);
            if (result.success) {
                res.json({ success: true });
            } else {
                res.status(400).json(result);
            }
        });

        app.post('/api/admin/users/:userId/make-admin', this.authMiddleware, this.adminMiddleware, async (req, res) => {
            const { userId } = req.params;
            const result = await adminService.makeAdmin(userId, req.user.userId);
            if (result.success) {
                res.json({ success: true });
            } else {
                res.status(400).json(result);
            }
        });

        app.get('/api/admin/posts', this.authMiddleware, this.adminMiddleware, async (req, res) => {
            const posts = await adminService.getAllPosts();
            res.json(posts);
        });

        app.delete('/api/admin/posts/:postId', this.authMiddleware, this.adminMiddleware, async (req, res) => {
            const { postId } = req.params;
            const result = await adminService.deletePost(postId, req.user.userId);
            if (result.success) {
                res.json({ success: true });
            } else {
                res.status(404).json(result);
            }
        });

        app.get('/api/admin/stats', this.authMiddleware, this.adminMiddleware, (req, res) => {
            const stats = adminService.getSystemStats();
            res.json(stats);
        });

        app.post('/api/admin/broadcast', this.authMiddleware, this.adminMiddleware, async (req, res) => {
            const { message } = req.body;
            const result = await adminService.broadcastMessage(message, req.user.userId, io);
            if (result.success) {
                wsManager.broadcastMessage(message, req.user.username, 'admin');
                res.json({ success: true });
            } else {
                res.status(400).json(result);
            }
        });

        app.get('/api/admin/logs', this.authMiddleware, this.adminMiddleware, (req, res) => {
            const limit = parseInt(req.query.limit) || 100;
            const filter = req.query.filter || null;
            const logs = adminService.getAdminLogs(limit, filter);
            res.json(logs);
        });

        app.get('/api/admin/performance', this.authMiddleware, this.adminMiddleware, (req, res) => {
            const metrics = adminService.getPerformanceMetrics();
            res.json(metrics);
        });

        app.post('/api/admin/cleanup', this.authMiddleware, this.adminMiddleware, async (req, res) => {
            const result = await adminService.cleanup();
            res.json(result);
        });

        // ===== SYSTEM ROUTES =====
        app.get('/api/health', (req, res) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                version: this.apiVersion
            });
        });

        app.get('/api/stats', this.authMiddleware, (req, res) => {
            const stats = db.getStats();
            res.json(stats);
        });

        app.get('/api/online', this.authMiddleware, (req, res) => {
            const online = authService.getOnlineUsers();
            res.json({ online, count: online.length });
        });

        // ===== ERROR HANDLING =====
        app.use((err, req, res, next) => {
            console.error('API Error:', err);
            res.status(500).json({ 
                error: 'خطای داخلی سرور',
                message: process.env.NODE_ENV === 'development' ? err.message : undefined
            });
        });

        app.use((req, res) => {
            res.status(404).json({ error: 'مسیر یافت نشد' });
        });
    }

    // ===== INITIALIZE =====
    init() {
        this.registerRoutes();
        wsManager.init();
        notificationService.startProcessors();

        console.log('═'.repeat(50));
        console.log('🌐 API GATEWAY');
        console.log('═'.repeat(50));
        console.log(`📡 Version: ${this.apiVersion}`);
        console.log(`🔢 Routes: ${Object.keys(app._router?.stack || {}).length}`);
        console.log('═'.repeat(50));
    }

    // ===== METRICS =====
    trackRequest(req, res, duration) {
        this.metrics.totalRequests++;
        if (res.statusCode < 400) {
            this.metrics.successfulRequests++;
        } else {
            this.metrics.failedRequests++;
        }
        this.metrics.averageResponseTime = 
            (this.metrics.averageResponseTime * (this.metrics.totalRequests - 1) + duration) / 
            this.metrics.totalRequests;
    }

    getMetrics() {
        return {
            ...this.metrics,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            routes: this.routes.size
        };
    }
}

module.exports = new APIGateway();
