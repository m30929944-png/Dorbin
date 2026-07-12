// ============================================
// ❤️ LIKES, VIEWS, FOLLOWS & NOTIFICATIONS - m4.js
// ============================================
// این فایل شامل: لایک، بازدید، فالو، آنفالو،
// اعلان‌ها، تعاملات، آمار
// ============================================

const { app, db, io, encryption, authMiddleware, adminMiddleware } = require('./m1.js');

// ============================================
// ❤️ LIKES SYSTEM
// ============================================
class LikeSystem {
    constructor() {
        this.likeCache = new Map();
        this.interactionAnalytics = new Map();
        this.CACHE_TTL = 5 * 60 * 1000;
        this.likeCounts = new Map();
        this.likeTimestamps = new Map();
    }

    async toggleLike(postId, userId) {
        const result = db.likePost(postId, userId);
        
        this.likeCache.set(`like_${postId}_${userId}`, result.liked);
        this.trackInteraction('like', userId, postId);

        // Update like count cache
        const post = db.getPost(postId);
        if (post) {
            this.likeCounts.set(postId, post.likes || 0);
            this.likeTimestamps.set(postId, Date.now());
        }

        return result;
    }

    getLikeStatus(postId, userId) {
        const cacheKey = `like_${postId}_${userId}`;
        if (this.likeCache.has(cacheKey)) {
            return this.likeCache.get(cacheKey);
        }

        const post = db.getPost(postId);
        if (!post) return false;

        const likeKey = `${postId}_${userId}`;
        const idx = db.getShardIndex(postId);
        const liked = db.shards[idx].likes.has(likeKey);
        
        this.likeCache.set(cacheKey, liked);
        return liked;
    }

    getPostLikesCount(postId) {
        // Check cache first
        if (this.likeCounts.has(postId)) {
            const timestamp = this.likeTimestamps.get(postId);
            if (Date.now() - timestamp < 5000) {
                return this.likeCounts.get(postId);
            }
        }

        const post = db.getPost(postId);
        const count = post ? post.likes || 0 : 0;
        this.likeCounts.set(postId, count);
        this.likeTimestamps.set(postId, Date.now());
        return count;
    }

    getLikedPosts(userId, limit = 50) {
        const allPosts = [];
        for (let i = 0; i < db.SHARD_COUNT; i++) {
            allPosts.push(...db.shards[i].posts);
        }

        const likedPosts = allPosts.filter(post => {
            const likeKey = `${post.postId}_${userId}`;
            const idx = db.getShardIndex(post.postId);
            return db.shards[idx].likes.has(likeKey);
        });

        return likedPosts.slice(0, limit);
    }

    trackInteraction(type, userId, targetId) {
        const now = Date.now();

        if (!this.interactionAnalytics.has(userId)) {
            this.interactionAnalytics.set(userId, {
                likes: 0,
                comments: 0,
                shares: 0,
                totalInteractions: 0,
                lastActive: now,
                dailyCount: 0,
                lastReset: now,
                weeklyCount: 0,
                lastWeeklyReset: now
            });
        }

        const stats = this.interactionAnalytics.get(userId);
        
        // Reset daily count if new day
        if (now - stats.lastReset > 24 * 60 * 60 * 1000) {
            stats.dailyCount = 0;
            stats.lastReset = now;
        }

        // Reset weekly count if new week
        if (now - stats.lastWeeklyReset > 7 * 24 * 60 * 60 * 1000) {
            stats.weeklyCount = 0;
            stats.lastWeeklyReset = now;
        }

        if (type === 'like') stats.likes = (stats.likes || 0) + 1;
        if (type === 'comment') stats.comments = (stats.comments || 0) + 1;
        if (type === 'share') stats.shares = (stats.shares || 0) + 1;
        
        stats.totalInteractions = (stats.likes || 0) + (stats.comments || 0) + (stats.shares || 0);
        stats.dailyCount++;
        stats.weeklyCount++;
        stats.lastActive = now;
    }

    getUserInteractionStats(userId) {
        return this.interactionAnalytics.get(userId) || {
            likes: 0,
            comments: 0,
            shares: 0,
            totalInteractions: 0,
            lastActive: Date.now(),
            dailyCount: 0,
            weeklyCount: 0
        };
    }

    getTopInteractingUsers(limit = 10) {
        const users = Array.from(this.interactionAnalytics.entries());
        return users
            .sort((a, b) => b[1].totalInteractions - a[1].totalInteractions)
            .slice(0, limit)
            .map(([userId, stats]) => ({ userId, ...stats }));
    }
}

const likeSystem = new LikeSystem();

// ============================================
// 👁️ VIEWS SYSTEM
// ============================================
class ViewSystem {
    constructor() {
        this.viewCache = new Map();
        this.viewCounts = new Map();
        this.popularPosts = [];
        this.popularPostsTime = 0;
    }

    async viewPost(postId, userId) {
        const result = db.viewPost(postId, userId);
        if (result) {
            this.viewCache.set(`view_${postId}_${userId}`, true);
            const post = db.getPost(postId);
            if (post) {
                this.viewCounts.set(postId, post.views || 0);
            }
            this.updatePopularPosts();
        }
        return { success: result };
    }

    getPostViews(postId) {
        if (this.viewCounts.has(postId)) {
            return this.viewCounts.get(postId);
        }
        const post = db.getPost(postId);
        const count = post ? post.views || 0 : 0;
        this.viewCounts.set(postId, count);
        return count;
    }

    updatePopularPosts() {
        const allPosts = [];
        for (let i = 0; i < db.SHARD_COUNT; i++) {
            allPosts.push(...db.shards[i].posts);
        }

        this.popularPosts = allPosts
            .filter(p => !p.isDeleted)
            .sort((a, b) => (b.views || 0) - (a.views || 0))
            .slice(0, 20);
        this.popularPostsTime = Date.now();
    }

    getPopularPosts(limit = 10) {
        if (Date.now() - this.popularPostsTime > 60000) {
            this.updatePopularPosts();
        }
        return this.popularPosts.slice(0, limit);
    }
}

const viewSystem = new ViewSystem();

// ============================================
# 📡 LIKE ROUTES
// ============================================
app.put('/api/posts/:postId/like', authMiddleware, async (req, res) => {
    const { postId } = req.params;
    const result = await likeSystem.toggleLike(postId, req.user.userId);
    
    if (result.liked) {
        const post = db.getPost(postId);
        if (post && post.userId !== req.user.userId) {
            const notification = {
                notificationId: encryption.generateId('notif'),
                userId: post.userId,
                fromUserId: req.user.userId,
                type: 'like',
                postId: postId,
                isRead: false,
                createdAt: new Date().toISOString()
            };
            db.addNotification(notification);
            io.to(`user_${post.userId}`).emit('notification', {
                type: 'like',
                fromUserId: req.user.userId,
                postId: postId
            });
        }
    }
    
    res.json(result);
});

app.get('/api/posts/:postId/likes', authMiddleware, (req, res) => {
    const count = likeSystem.getPostLikesCount(req.params.postId);
    res.json({ count });
});

app.get('/api/user/likes', authMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const likedPosts = likeSystem.getLikedPosts(req.user.userId, limit);
    res.json(likedPosts);
});

app.get('/api/user/interactions', authMiddleware, (req, res) => {
    const stats = likeSystem.getUserInteractionStats(req.user.userId);
    res.json(stats);
});

// ============================================
// 📡 VIEW ROUTES
// ============================================
app.post('/api/posts/:postId/view', authMiddleware, async (req, res) => {
    const { postId } = req.params;
    const result = await viewSystem.viewPost(postId, req.user.userId);
    res.json(result);
});

app.get('/api/posts/:postId/views', authMiddleware, (req, res) => {
    const count = viewSystem.getPostViews(req.params.postId);
    res.json({ count });
});

app.get('/api/popular', authMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    const posts = viewSystem.getPopularPosts(limit);
    res.json(posts);
});

// ============================================
# 🔔 NOTIFICATIONS SYSTEM
// ============================================
class NotificationSystem {
    constructor() {
        this.notificationQueue = [];
        this.realtimeNotifications = new Map();
        this.notificationPreferences = new Map();
        this.MAX_QUEUE = 10000;
        this.MAX_NOTIFICATIONS_PER_USER = 500;
        this.emailQueue = [];
        this.smsQueue = [];
    }

    async createNotification(data) {
        const { userId, fromUserId, type, postId, commentId, message, metadata = {} } = data;

        // Check preferences
        const prefs = this.getPreferences(userId);
        if (prefs[type] === false) {
            return null;
        }

        const notification = {
            notificationId: encryption.generateId('notif'),
            userId,
            fromUserId: fromUserId || null,
            type, // 'like', 'comment', 'follow', 'mention', 'post', 'story', 'live', 'message', 'system'
            postId: postId || null,
            commentId: commentId || null,
            message: message || this.getDefaultMessage(type, fromUserId),
            metadata,
            isRead: false,
            isDelivered: false,
            createdAt: new Date().toISOString(),
            readAt: null,
            deliveredAt: null
        };

        db.addNotification(notification);

        this.notificationQueue.push(notification);
        if (this.notificationQueue.length > this.MAX_QUEUE) {
            this.notificationQueue = this.notificationQueue.slice(-this.MAX_QUEUE);
        }

        if (!this.realtimeNotifications.has(userId)) {
            this.realtimeNotifications.set(userId, []);
        }
        const userNotifs = this.realtimeNotifications.get(userId);
        userNotifs.push(notification);
        if (userNotifs.length > this.MAX_NOTIFICATIONS_PER_USER) {
            userNotifs.splice(0, userNotifs.length - this.MAX_NOTIFICATIONS_PER_USER);
        }

        return notification;
    }

    getDefaultMessage(type, fromUserId) {
        const fromUser = fromUserId ? db.getUser(fromUserId) : null;
        const fromName = fromUser?.fullName || fromUser?.username || 'کاربر';
        
        const messages = {
            like: `${fromName} پست شما را لایک کرد`,
            comment: `${fromName} روی پست شما کامنت گذاشت`,
            follow: `${fromName} شما را دنبال کرد`,
            mention: `${fromName} شما را منشن کرد`,
            post: `${fromName} پست جدیدی منتشر کرد`,
            story: `${fromName} استوری جدیدی منتشر کرد`,
            live: `${fromName} لایو را شروع کرد`,
            message: `${fromName} به شما پیام داد`,
            system: 'پیام سیستم'
        };
        return messages[type] || 'اعلان جدید';
    }

    async getNotifications(userId, limit = 50, offset = 0) {
        const all = db.getNotifications(userId);
        return all.slice(offset, offset + limit);
    }

    async markRead(notificationId, userId) {
        const marked = db.markNotificationRead(notificationId, userId);
        if (marked) {
            const notifs = db.getNotifications(userId);
            const notif = notifs.find(n => n.notificationId === notificationId);
            if (notif) {
                notif.isRead = true;
                notif.readAt = new Date().toISOString();
            }
        }
        return { success: marked };
    }

    async markAllRead(userId) {
        const notifs = db.getNotifications(userId);
        for (const notif of notifs) {
            if (!notif.isRead) {
                db.markNotificationRead(notif.notificationId, userId);
                notif.isRead = true;
                notif.readAt = new Date().toISOString();
            }
        }
        return { success: true };
    }

    getUnreadCount(userId) {
        const notifs = db.getNotifications(userId);
        return notifs.filter(n => !n.isRead).length;
    }

    setPreferences(userId, preferences) {
        if (!this.notificationPreferences.has(userId)) {
            this.notificationPreferences.set(userId, {});
        }
        const current = this.notificationPreferences.get(userId);
        this.notificationPreferences.set(userId, { ...current, ...preferences });
        return { success: true };
    }

    getPreferences(userId) {
        const defaults = {
            like: true,
            comment: true,
            follow: true,
            mention: true,
            post: true,
            story: true,
            live: true,
            message: true,
            system: true
        };
        
        const userPrefs = this.notificationPreferences.get(userId) || {};
        return { ...defaults, ...userPrefs };
    }

    // ===== NOTIFICATION TYPES =====
    async notifyLike(userId, fromUserId, postId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'like',
            postId
        });
    }

    async notifyComment(userId, fromUserId, postId, commentId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'comment',
            postId,
            commentId
        });
    }

    async notifyFollow(userId, fromUserId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'follow'
        });
    }

    async notifyMention(userId, fromUserId, postId, commentId = null) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'mention',
            postId,
            commentId
        });
    }

    async notifyPost(userId, fromUserId, postId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'post',
            postId
        });
    }

    async notifyStory(userId, fromUserId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'story'
        });
    }

    async notifyLive(userId, fromUserId, streamId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'live',
            metadata: { streamId }
        });
    }

    async notifyMessage(userId, fromUserId) {
        return this.createNotification({
            userId,
            fromUserId,
            type: 'message'
        });
    }

    // ===== CLEANUP =====
    cleanup() {
        const now = Date.now();
        const oneMonth = 30 * 24 * 60 * 60 * 1000;

        for (const [userId, notifs] of this.realtimeNotifications) {
            this.realtimeNotifications.set(
                userId,
                notifs.filter(n => now - new Date(n.createdAt).getTime() < oneMonth)
            );
        }

        if (this.notificationQueue.length > this.MAX_QUEUE) {
            this.notificationQueue = this.notificationQueue.slice(-this.MAX_QUEUE);
        }
    }

    // ===== STATS =====
    getStats() {
        return {
            totalNotifications: this.notificationQueue.length,
            realtimeNotifications: this.realtimeNotifications.size,
            totalPreferences: this.notificationPreferences.size
        };
    }
}

const notificationSystem = new NotificationSystem();

// ============================================
// 📡 NOTIFICATION ROUTES
// ============================================
app.get('/api/notifications', authMiddleware, async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const notifications = await notificationSystem.getNotifications(req.user.userId, limit, offset);
    const unread = notificationSystem.getUnreadCount(req.user.userId);
    res.json({ notifications, unread, total: notifications.length });
});

app.post('/api/notifications/:notificationId/read', authMiddleware, async (req, res) => {
    const { notificationId } = req.params;
    const result = await notificationSystem.markRead(notificationId, req.user.userId);
    res.json(result);
});

app.post('/api/notifications/read-all', authMiddleware, async (req, res) => {
    const result = await notificationSystem.markAllRead(req.user.userId);
    res.json(result);
});

app.post('/api/notifications/preferences', authMiddleware, (req, res) => {
    const { preferences } = req.body;
    const result = notificationSystem.setPreferences(req.user.userId, preferences);
    res.json(result);
});

app.get('/api/notifications/preferences', authMiddleware, (req, res) => {
    const preferences = notificationSystem.getPreferences(req.user.userId);
    res.json(preferences);
});

// ============================================
# 📡 FOLLOW SYSTEM
// ============================================
class FollowSystem {
    constructor() {
        this.followCache = new Map();
        this.followerCounts = new Map();
        this.followingCounts = new Map();
    }

    async follow(userId, targetId) {
        if (userId === targetId) {
            return { success: false, error: 'نمی‌توانید خودتان را دنبال کنید' };
        }

        const result = db.followUser(userId, targetId);
        if (!result) {
            return { success: false, error: 'از قبل دنبال می‌کنید یا کاربر یافت نشد' };
        }

        // Update caches
        const target = db.getUser(targetId);
        if (target) {
            this.followerCounts.set(targetId, target.followers || 0);
        }
        const user = db.getUser(userId);
        if (user) {
            this.followingCounts.set(userId, user.following || 0);
        }

        // Send notification
        await notificationSystem.notifyFollow(targetId, userId);

        return { success: true };
    }

    async unfollow(userId, targetId) {
        const result = db.unfollowUser(userId, targetId);
        if (!result) {
            return { success: false, error: 'دنبال نمی‌کنید یا کاربر یافت نشد' };
        }

        // Update caches
        const target = db.getUser(targetId);
        if (target) {
            this.followerCounts.set(targetId, target.followers || 0);
        }
        const user = db.getUser(userId);
        if (user) {
            this.followingCounts.set(userId, user.following || 0);
        }

        return { success: true };
    }

    getFollowerCount(userId) {
        if (this.followerCounts.has(userId)) {
            return this.followerCounts.get(userId);
        }
        const user = db.getUser(userId);
        const count = user ? user.followers || 0 : 0;
        this.followerCounts.set(userId, count);
        return count;
    }

    getFollowingCount(userId) {
        if (this.followingCounts.has(userId)) {
            return this.followingCounts.get(userId);
        }
        const user = db.getUser(userId);
        const count = user ? user.following || 0 : 0;
        this.followingCounts.set(userId, count);
        return count;
    }

    getFollowers(userId) {
        return db.getFollowers(userId);
    }

    getFollowing(userId) {
        return db.getFollowing(userId);
    }

    isFollowing(userId, targetId) {
        const userIdx = db.getShardIndex(userId);
        if (!db.shards[userIdx].following.has(userId)) return false;
        return db.shards[userIdx].following.get(userId).has(targetId);
    }

    getFollowSuggestions(userId, limit = 10) {
        const allUsers = db.getAllUsers();
        const following = new Set(db.getFollowing(userId).map(u => u.userId));
        
        const suggestions = allUsers
            .filter(u => u.userId !== userId && !following.has(u.userId) && !u.isBanned)
            .sort((a, b) => (b.followers || 0) - (a.followers || 0))
            .slice(0, limit);

        return suggestions;
    }
}

const followSystem = new FollowSystem();

// ============================================
// 📡 FOLLOW ROUTES
// ============================================
app.post('/api/users/:userId/follow', authMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await followSystem.follow(req.user.userId, userId);
    if (result.success) {
        const target = db.getUser(userId);
        io.emit('follow-update', { 
            userId: target.userId, 
            followers: target.followers 
        });
        res.json({ success: true, followers: target.followers });
    } else {
        res.status(400).json(result);
    }
});

app.post('/api/users/:userId/unfollow', authMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await followSystem.unfollow(req.user.userId, userId);
    if (result.success) {
        const target = db.getUser(userId);
        res.json({ success: true, followers: target.followers });
    } else {
        res.status(400).json(result);
    }
});

app.get('/api/users/:userId/followers', authMiddleware, (req, res) => {
    const followers = followSystem.getFollowers(req.params.userId);
    res.json(followers.map(u => ({ ...u, password: undefined })));
});

app.get('/api/users/:userId/following', authMiddleware, (req, res) => {
    const following = followSystem.getFollowing(req.params.userId);
    res.json(following.map(u => ({ ...u, password: undefined })));
});

app.get('/api/users/:userId/follow-status', authMiddleware, (req, res) => {
    const { userId } = req.params;
    const isFollowing = followSystem.isFollowing(req.user.userId, userId);
    res.json({ isFollowing });
});

app.get('/api/users/suggestions', authMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    const suggestions = followSystem.getFollowSuggestions(req.user.userId, limit);
    res.json(suggestions.map(u => ({ ...u, password: undefined })));
});

// ============================================
// 📊 ANALYTICS ROUTES
// ============================================
app.get('/api/analytics/user', authMiddleware, (req, res) => {
    const userId = req.user.userId;
    const user = db.getUser(userId);
    const followers = followSystem.getFollowerCount(userId);
    const following = followSystem.getFollowingCount(userId);
    const posts = db.getPosts(1, 1, null, userId);
    const interactions = likeSystem.getUserInteractionStats(userId);

    res.json({
        userId,
        username: user.username,
        fullName: user.fullName,
        followers,
        following,
        postsCount: posts.total,
        interactions: interactions,
        isVerified: user.isVerified || false,
        isAdmin: user.isAdmin || false,
        createdAt: user.createdAt
    });
});

app.get('/api/analytics/top-users', authMiddleware, adminMiddleware, (req, res) => {
    const topUsers = likeSystem.getTopInteractingUsers(10);
    res.json(topUsers);
});

app.get('/api/analytics/notifications', authMiddleware, (req, res) => {
    const stats = notificationSystem.getStats();
    res.json(stats);
});

// ============================================
// 📡 WEBSOCKET NOTIFICATION EVENTS
// ============================================
io.on('connection', (socket) => {
    // Send unread notifications on connect
    socket.on('register', (data) => {
        const { userId } = data;
        const unread = notificationSystem.getUnreadCount(userId);
        if (unread > 0) {
            socket.emit('unread-notifications', { count: unread });
        }
    });

    // Mark notification read
    socket.on('mark-notification-read', async (data) => {
        const { notificationId, userId } = data;
        await notificationSystem.markRead(notificationId, userId);
        socket.emit('notification-read', { notificationId });
    });

    // Get notifications
    socket.on('get-notifications', async (data) => {
        const { userId, limit = 50 } = data;
        const notifications = await notificationSystem.getNotifications(userId, limit);
        socket.emit('notifications', notifications);
    });
});

module.exports = {
    likeSystem,
    viewSystem,
    notificationSystem,
    followSystem
};