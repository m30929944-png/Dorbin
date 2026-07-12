// ============================================
// 👥 m2.js - USER MANAGEMENT, FOLLOW, PROFILE
// ============================================

const { app, db, io, encryption, authMiddleware, adminMiddleware, avatarUpload } = require('./m1.js');

// ============================================
// 👤 USER SERVICE
// ============================================
class UserService {
    constructor() {
        this.userCache = new Map();
        this.CACHE_TTL = 5 * 60 * 1000;
        this.followRequests = new Map();
        this.blockedUsers = new Map();
        this.userReports = new Map();
    }

    // ===== GET USER PROFILE =====
    getUserProfile(userId, viewerId = null) {
        const user = db.getUser(userId);
        if (!user) return null;

        const isFollowing = viewerId ? this.isFollowing(viewerId, userId) : false;
        const isBlocked = viewerId ? this.isBlocked(viewerId, userId) : false;

        return {
            userId: user.userId,
            username: user.username,
            fullName: user.fullName,
            bio: user.bio,
            avatar: user.avatar,
            followers: user.followers || 0,
            following: user.following || 0,
            postsCount: user.postsCount || 0,
            isOnline: user.isOnline || false,
            isVerified: user.isVerified || false,
            isAdmin: user.isAdmin || false,
            isFollowing: isFollowing,
            isBlocked: isBlocked,
            createdAt: user.createdAt,
            lastSeen: user.lastSeen
        };
    }

    // ===== FOLLOW SYSTEM =====
    isFollowing(userId, targetId) {
        const idx = db.getShardIndex(userId);
        if (!db.shards[idx].following.has(userId)) return false;
        return db.shards[idx].following.get(userId).has(targetId);
    }

    async followUser(userId, targetId) {
        if (userId === targetId) {
            return { success: false, error: 'نمی‌توانید خودتان را دنبال کنید' };
        }

        if (this.isBlocked(targetId, userId)) {
            return { success: false, error: 'این کاربر شما را مسدود کرده است' };
        }

        const result = db.followUser(userId, targetId);
        if (!result) {
            return { success: false, error: 'از قبل دنبال می‌کنید' };
        }

        // Send notification
        const notification = {
            notificationId: db.generateId('notif'),
            userId: targetId,
            fromUserId: userId,
            type: 'follow',
            isRead: false,
            createdAt: new Date().toISOString()
        };
        db.addNotification(notification);
        io.to(`user_${targetId}`).emit('notification', {
            type: 'follow',
            fromUserId: userId
        });

        return { success: true };
    }

    async unfollowUser(userId, targetId) {
        const result = db.unfollowUser(userId, targetId);
        if (!result) {
            return { success: false, error: 'دنبال نمی‌کنید' };
        }
        return { success: true };
    }

    getFollowers(userId) {
        return db.getFollowers(userId);
    }

    getFollowing(userId) {
        return db.getFollowing(userId);
    }

    getFollowerCount(userId) {
        const user = db.getUser(userId);
        return user ? user.followers || 0 : 0;
    }

    getFollowingCount(userId) {
        const user = db.getUser(userId);
        return user ? user.following || 0 : 0;
    }

    // ===== BLOCK SYSTEM =====
    isBlocked(userId, targetId) {
        if (!this.blockedUsers.has(userId)) return false;
        return this.blockedUsers.get(userId).has(targetId);
    }

    async blockUser(userId, targetId) {
        if (userId === targetId) {
            return { success: false, error: 'نمی‌توانید خودتان را مسدود کنید' };
        }

        if (!this.blockedUsers.has(userId)) {
            this.blockedUsers.set(userId, new Set());
        }
        this.blockedUsers.get(userId).add(targetId);

        // Unfollow if following
        if (this.isFollowing(userId, targetId)) {
            db.unfollowUser(userId, targetId);
        }
        if (this.isFollowing(targetId, userId)) {
            db.unfollowUser(targetId, userId);
        }

        return { success: true };
    }

    async unblockUser(userId, targetId) {
        if (this.blockedUsers.has(userId)) {
            this.blockedUsers.get(userId).delete(targetId);
        }
        return { success: true };
    }

    // ===== FOLLOW REQUESTS (Private Accounts) =====
    async sendFollowRequest(userId, targetId) {
        const key = `${targetId}_${userId}`;
        if (!this.followRequests.has(targetId)) {
            this.followRequests.set(targetId, new Map());
        }
        this.followRequests.get(targetId).set(userId, {
            userId,
            targetId,
            status: 'pending',
            createdAt: new Date().toISOString()
        });
        return { success: true };
    }

    async acceptFollowRequest(targetId, userId) {
        if (!this.followRequests.has(targetId)) return false;
        const requests = this.followRequests.get(targetId);
        if (!requests.has(userId)) return false;
        requests.delete(userId);
        return db.followUser(userId, targetId);
    }

    async rejectFollowRequest(targetId, userId) {
        if (!this.followRequests.has(targetId)) return false;
        const requests = this.followRequests.get(targetId);
        if (!requests.has(userId)) return false;
        requests.delete(userId);
        return true;
    }

    // ===== SUGGESTIONS =====
    getFollowSuggestions(userId, limit = 10) {
        const allUsers = db.getAllUsers();
        const following = new Set(db.getFollowing(userId).map(u => u.userId));
        const blocked = this.blockedUsers.get(userId) || new Set();
        
        const suggestions = allUsers
            .filter(u => 
                u.userId !== userId && 
                !following.has(u.userId) && 
                !blocked.has(u.userId) &&
                !u.isBanned
            )
            .sort((a, b) => (b.followers || 0) - (a.followers || 0))
            .slice(0, limit);

        return suggestions.map(u => ({
            userId: u.userId,
            username: u.username,
            fullName: u.fullName,
            avatar: u.avatar,
            followers: u.followers || 0,
            isVerified: u.isVerified || false
        }));
    }

    // ===== USER SEARCH =====
    searchUsers(query, limit = 20) {
        if (!query || query.length < 2) return [];
        const results = db.searchUsers(query, limit);
        return results.map(u => ({
            userId: u.userId,
            username: u.username,
            fullName: u.fullName,
            avatar: u.avatar,
            bio: u.bio,
            followers: u.followers || 0,
            isVerified: u.isVerified || false,
            isOnline: u.isOnline || false
        }));
    }

    // ===== UPDATE PROFILE =====
    async updateProfile(userId, data) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };

        const updates = {};
        if (data.bio !== undefined) updates.bio = data.bio;
        if (data.fullName !== undefined) updates.fullName = data.fullName;
        if (data.username !== undefined) {
            const existing = db.getUserByUsername(data.username);
            if (existing && existing.userId !== userId) {
                return { success: false, error: 'این نام کاربری قبلاً ثبت شده است' };
            }
            updates.username = data.username;
        }

        const updated = db.updateUser(userId, updates);
        return { success: true, user: { ...updated, password: undefined } };
    }

    // ===== USER REPORT =====
    async reportUser(userId, reporterId, reason) {
        if (!this.userReports.has(userId)) {
            this.userReports.set(userId, []);
        }
        this.userReports.get(userId).push({
            reporterId,
            reason,
            createdAt: new Date().toISOString()
        });
        return { success: true };
    }

    getUserReports(userId) {
        return this.userReports.get(userId) || [];
    }

    // ===== CLEANUP =====
    cleanup() {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;

        // Clean follow requests
        for (const [targetId, requests] of this.followRequests) {
            for (const [userId, data] of requests) {
                if (now - new Date(data.createdAt).getTime() > 7 * oneDay) {
                    requests.delete(userId);
                }
            }
        }
    }

    // ===== GET USER STATS =====
    getUserStats(userId) {
        const user = db.getUser(userId);
        if (!user) return null;

        return {
            userId: user.userId,
            username: user.username,
            followers: user.followers || 0,
            following: user.following || 0,
            postsCount: user.postsCount || 0,
            isOnline: user.isOnline || false,
            isVerified: user.isVerified || false,
            isAdmin: user.isAdmin || false,
            createdAt: user.createdAt,
            lastSeen: user.lastSeen
        };
    }
}

const userService = new UserService();

// ============================================
// 📡 USER ROUTES
// ============================================

// ===== GET USER PROFILE =====
app.get('/api/users/profile/:userId', authMiddleware, (req, res) => {
    const profile = userService.getUserProfile(req.params.userId, req.user.userId);
    if (!profile) return res.status(404).json({ error: 'کاربر یافت نشد' });
    res.json(profile);
});

app.get('/api/users/me', authMiddleware, (req, res) => {
    const profile = userService.getUserProfile(req.user.userId);
    res.json(profile);
});

// ===== FOLLOW =====
app.post('/api/users/:userId/follow', authMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await userService.followUser(req.user.userId, userId);
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
    const result = await userService.unfollowUser(req.user.userId, userId);
    if (result.success) {
        const target = db.getUser(userId);
        res.json({ success: true, followers: target.followers });
    } else {
        res.status(400).json(result);
    }
});

app.get('/api/users/:userId/followers', authMiddleware, (req, res) => {
    const followers = userService.getFollowers(req.params.userId);
    res.json(followers.map(u => ({ ...u, password: undefined })));
});

app.get('/api/users/:userId/following', authMiddleware, (req, res) => {
    const following = userService.getFollowing(req.params.userId);
    res.json(following.map(u => ({ ...u, password: undefined })));
});

app.get('/api/users/:userId/follow-status', authMiddleware, (req, res) => {
    const { userId } = req.params;
    const isFollowing = userService.isFollowing(req.user.userId, userId);
    const isBlocked = userService.isBlocked(userId, req.user.userId);
    res.json({ isFollowing, isBlocked });
});

// ===== BLOCK =====
app.post('/api/users/:userId/block', authMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await userService.blockUser(req.user.userId, userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(400).json(result);
    }
});

app.post('/api/users/:userId/unblock', authMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await userService.unblockUser(req.user.userId, userId);
    res.json({ success: true });
});

// ===== SUGGESTIONS =====
app.get('/api/users/suggestions', authMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    const suggestions = userService.getFollowSuggestions(req.user.userId, limit);
    res.json(suggestions);
});

// ===== SEARCH =====
app.get('/api/users/search', authMiddleware, (req, res) => {
    const { q, limit = 20 } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const results = userService.searchUsers(q, parseInt(limit));
    res.json(results);
});

// ===== PROFILE UPDATE =====
app.put('/api/users/profile', authMiddleware, async (req, res) => {
    const { bio, fullName, username } = req.body;
    const result = await userService.updateProfile(req.user.userId, { bio, fullName, username });
    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

// ===== AVATAR UPDATE =====
app.post('/api/users/avatar', authMiddleware, avatarUpload.single('avatar'), async (req, res) => {
    const file = req.file;
    if (!file) {
        return res.status(400).json({ error: 'فایل الزامی است' });
    }

    const avatarPath = '/uploads/avatars/' + file.filename;
    db.updateUser(req.user.userId, { avatar: avatarPath });

    res.json({ success: true, avatar: avatarPath });
});

// ===== STATS =====
app.get('/api/users/:userId/stats', authMiddleware, (req, res) => {
    const stats = userService.getUserStats(req.params.userId);
    if (!stats) return res.status(404).json({ error: 'کاربر یافت نشد' });
    res.json(stats);
});

module.exports = {
    userService
};