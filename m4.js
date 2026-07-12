// ============================================
// 👑 m4.js - ADMIN, MANAGEMENT & STATS
// ============================================

const { app, db, io, encryption, authMiddleware, adminMiddleware } = require('./m1.js');

// ============================================
// 👑 ADMIN SYSTEM
// ============================================
class AdminSystem {
    constructor() {
        this.adminLogs = [];
        this.auditTrail = [];
        this.systemMetrics = {
            startTime: Date.now(),
            totalRequests: 0,
            totalErrors: 0
        };
        this.MAX_LOGS = 10000;
    }

    async getAllUsers() {
        const users = db.getAllUsers();
        return users.map(u => ({ ...u, password: undefined }));
    }

    async banUser(userId, banned, adminId) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };
        if (user.isAdmin) return { success: false, error: 'نمی‌توان ادمین را مسدود کرد' };

        db.updateUser(userId, { isBanned: banned });
        if (banned) encryption.onlineUsers.delete(userId);
        this.logAdminAction(adminId, 'ban_user', { userId, banned });
        return { success: true };
    }

    async deleteUser(userId, adminId) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };
        if (user.isAdmin) return { success: false, error: 'نمی‌توان ادمین را حذف کرد' };

        const posts = db.getPosts(1, 10000, null, userId);
        for (const post of posts.posts) {
            db.deletePost(post.postId);
        }

        const stories = db.getStories(userId);
        for (const story of stories) {
            db.deleteStory(story.storyId, userId);
        }

        db.deleteUser(userId);
        this.logAdminAction(adminId, 'delete_user', { userId });
        return { success: true };
    }

    async makeAdmin(userId, adminId) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };
        db.updateUser(userId, { isAdmin: true });
        this.logAdminAction(adminId, 'make_admin', { userId });
        return { success: true };
    }

    async verifyUser(userId, adminId) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };
        db.updateUser(userId, { isVerified: true });
        this.logAdminAction(adminId, 'verify_user', { userId });
        return { success: true };
    }

    getSystemStats() {
        const stats = db.getStats();
        return {
            ...stats,
            onlineUsers: encryption.getOnlineCount(),
            uptime: Math.floor((Date.now() - this.systemMetrics.startTime) / 1000 / 60 / 60),
            totalRequests: this.systemMetrics.totalRequests,
            totalErrors: this.systemMetrics.totalErrors,
            adminLogs: this.adminLogs.length,
            auditTrail: this.auditTrail.length,
            memory: process.memoryUsage(),
            cpu: process.cpuUsage(),
            nodeVersion: process.version,
            platform: process.platform,
            pid: process.pid
        };
    }

    async broadcastMessage(message, adminId, ioInstance) {
        if (!message || message.trim().length === 0) {
            return { success: false, error: 'متن پیام الزامی است' };
        }

        this.logAdminAction(adminId, 'broadcast', { message });
        
        if (ioInstance) {
            ioInstance.emit('broadcast', {
                message: message.trim(),
                from: 'ادمین',
                timestamp: new Date().toISOString()
            });
        }

        return { success: true, message: message.trim() };
    }

    logAdminAction(adminId, action, data) {
        const log = {
            id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            adminId,
            action,
            data,
            timestamp: new Date().toISOString()
        };
        this.adminLogs.push(log);
        this.auditTrail.push(log);
        
        if (this.adminLogs.length > this.MAX_LOGS) {
            this.adminLogs = this.adminLogs.slice(-this.MAX_LOGS);
        }
        if (this.auditTrail.length > this.MAX_LOGS) {
            this.auditTrail = this.auditTrail.slice(-this.MAX_LOGS);
        }

        return log;
    }

    getAdminLogs(limit = 100, filter = null) {
        let logs = this.adminLogs.slice(-limit).reverse();
        if (filter) {
            logs = logs.filter(log => 
                log.action.includes(filter) || 
                log.adminId.includes(filter)
            );
        }
        return logs;
    }

    async cleanup() {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;

        const stories = db.getStories();
        for (const story of stories) {
            const age = now - new Date(story.createdAt).getTime();
            if (age >= oneDay) {
                db.deleteStory(story.storyId, story.userId);
            }
        }

        return { success: true, message: 'سیستم پاکسازی شد' };
    }

    getPerformanceMetrics() {
        const memory = process.memoryUsage();
        const cpuUsage = process.cpuUsage();
        const uptime = process.uptime();

        return {
            memory: {
                heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
                external: Math.round(memory.external / 1024 / 1024),
                rss: Math.round(memory.rss / 1024 / 1024)
            },
            cpu: {
                user: Math.round(cpuUsage.user / 1000),
                system: Math.round(cpuUsage.system / 1000),
                total: Math.round((cpuUsage.user + cpuUsage.system) / 1000)
            },
            uptime: Math.floor(uptime),
            pid: process.pid,
            platform: process.platform,
            nodeVersion: process.version,
            arch: process.arch,
            cpus: require('os').cpus().length
        };
    }
}

const adminSystem = new AdminSystem();

// ============================================
// 📡 ADMIN ROUTES
// ============================================
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    const users = await adminSystem.getAllUsers();
    res.json(users);
});

app.put('/api/admin/users/:userId/ban', authMiddleware, adminMiddleware, async (req, res) => {
    const { userId } = req.params;
    const { banned } = req.body;
    const result = await adminSystem.banUser(userId, banned, req.user.userId);
    if (result.success) {
        io.emit('users-online', encryption.getOnlineUsers());
        res.json({ success: true });
    } else {
        res.status(400).json(result);
    }
});

app.delete('/api/admin/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await adminSystem.deleteUser(userId, req.user.userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(400).json(result);
    }
});

app.post('/api/admin/users/:userId/make-admin', authMiddleware, adminMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await adminSystem.makeAdmin(userId, req.user.userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(400).json(result);
    }
});

app.post('/api/admin/users/:userId/verify', authMiddleware, adminMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await adminSystem.verifyUser(userId, req.user.userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(400).json(result);
    }
});

app.get('/api/admin/posts', authMiddleware, adminMiddleware, async (req, res) => {
    const result = db.getPosts(1, 10000);
    res.json(result.posts);
});

app.delete('/api/admin/posts/:postId', authMiddleware, adminMiddleware, async (req, res) => {
    const { postId } = req.params;
    const deleted = db.deletePost(postId);
    res.json({ success: deleted });
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
    const stats = adminSystem.getSystemStats();
    res.json(stats);
});

app.post('/api/admin/broadcast', authMiddleware, adminMiddleware, async (req, res) => {
    const { message } = req.body;
    const result = await adminSystem.broadcastMessage(message, req.user.userId, io);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(400).json(result);
    }
});

app.get('/api/admin/logs', authMiddleware, adminMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const filter = req.query.filter || null;
    const logs = adminSystem.getAdminLogs(limit, filter);
    res.json(logs);
});

app.get('/api/admin/performance', authMiddleware, adminMiddleware, (req, res) => {
    const metrics = adminSystem.getPerformanceMetrics();
    res.json(metrics);
});

app.post('/api/admin/cleanup', authMiddleware, adminMiddleware, async (req, res) => {
    const result = await adminSystem.cleanup();
    res.json(result);
});

// ============================================
// 📊 SYSTEM ROUTES
// ============================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '2.0.0'
    });
});

app.get('/api/stats', authMiddleware, (req, res) => {
    const stats = db.getStats();
    res.json(stats);
});

app.get('/api/online', authMiddleware, (req, res) => {
    const online = encryption.getOnlineUsers();
    res.json({ online, count: online.length });
});

module.exports = {
    adminSystem
};