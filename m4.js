// ============================================
// 👑 m4.js - ADMIN PANEL, STATS, BROADCAST
// ============================================

const { app, db, io, encryption, authMiddleware, adminMiddleware } = require('./m1.js');

// ============================================
// 👑 ADMIN SERVICE
// ============================================
class AdminService {
    constructor() {
        this.adminLogs = [];
        this.auditTrail = [];
        this.systemMetrics = {
            startTime: Date.now(),
            totalRequests: 0,
            totalErrors: 0
        };
        this.MAX_LOGS = 10000;
        this.bannedIPs = new Set();
        this.systemSettings = {
            maintenanceMode: false,
            registrationEnabled: true,
            maxUploadSize: 500,
            maxUsers: 1000000
        };
    }

    // ===== USER MANAGEMENT =====
    getAllUsers() {
        const users = db.getAllUsers();
        return users.map(u => ({ ...u, password: undefined }));
    }

    getUserById(userId) {
        const user = db.getUser(userId);
        if (!user) return null;
        return { ...user, password: undefined };
    }

    async banUser(userId, banned, adminId) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };
        if (user.isAdmin) return { success: false, error: 'نمی‌توان ادمین را مسدود کرد' };

        db.updateUser(userId, { isBanned: banned });
        if (banned) {
            encryption.onlineUsers.delete(userId);
            // Remove all sessions
            for (const [token, id] of encryption.sessions) {
                if (id === userId) {
                    encryption.destroySession(token);
                }
            }
        }
        this.logAdminAction(adminId, 'ban_user', { userId, banned });
        return { success: true };
    }

    async deleteUser(userId, adminId) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };
        if (user.isAdmin) return { success: false, error: 'نمی‌توان ادمین را حذف کرد' };

        // Delete all user posts
        const posts = db.getPosts(1, 10000, null, userId);
        for (const post of posts.posts) {
            db.deletePost(post.postId);
        }

        // Delete all user stories
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

    async removeAdmin(userId, adminId) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };
        if (user.userId === adminId) return { success: false, error: 'نمی‌توانید خودتان را حذف کنید' };
        db.updateUser(userId, { isAdmin: false });
        this.logAdminAction(adminId, 'remove_admin', { userId });
        return { success: true };
    }

    async verifyUser(userId, adminId) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };
        db.updateUser(userId, { isVerified: true });
        this.logAdminAction(adminId, 'verify_user', { userId });
        return { success: true };
    }

    async unverifyUser(userId, adminId) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };
        db.updateUser(userId, { isVerified: false });
        this.logAdminAction(adminId, 'unverify_user', { userId });
        return { success: true };
    }

    // ===== POST MANAGEMENT =====
    getAllPosts(limit = 1000) {
        const result = db.getPosts(1, limit);
        return result.posts;
    }

    async deletePost(postId, adminId) {
        const post = db.getPost(postId);
        if (!post) return { success: false, error: 'پست یافت نشد' };
        db.deletePost(postId);
        this.logAdminAction(adminId, 'delete_post', { postId });
        return { success: true };
    }

    async deleteAllUserPosts(userId, adminId) {
        const posts = db.getPosts(1, 10000, null, userId);
        for (const post of posts.posts) {
            db.deletePost(post.postId);
        }
        this.logAdminAction(adminId, 'delete_all_user_posts', { userId });
        return { success: true };
    }

    // ===== SYSTEM STATISTICS =====
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
            pid: process.pid,
            systemSettings: this.systemSettings,
            bannedIPs: this.bannedIPs.size
        };
    }

    // ===== BROADCAST =====
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

    // ===== ADMIN LOGS =====
    logAdminAction(adminId, action, data) {
        const log = {
            id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            adminId,
            action,
            data,
            timestamp: new Date().toISOString(),
            ip: null
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
                log.adminId.includes(filter) ||
                JSON.stringify(log.data).includes(filter)
            );
        }
        return logs;
    }

    getAuditTrail(limit = 100) {
        return this.auditTrail.slice(-limit).reverse();
    }

    // ===== SYSTEM MAINTENANCE =====
    async cleanup() {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;

        // Clean expired stories
        const stories = db.getStories();
        for (const story of stories) {
            const age = now - new Date(story.createdAt).getTime();
            if (age >= oneDay) {
                db.deleteStory(story.storyId, story.userId);
            }
        }

        // Clean old sessions
        for (const [token, userId] of encryption.sessions) {
            const user = db.getUser(userId);
            if (!user || user.isBanned) {
                encryption.destroySession(token);
            }
        }

        return { success: true, message: 'سیستم پاکسازی شد' };
    }

    // ===== PERFORMANCE =====
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

    // ===== SYSTEM SETTINGS =====
    updateSettings(settings) {
        this.systemSettings = { ...this.systemSettings, ...settings };
        return this.systemSettings;
    }

    // ===== IP BANNING =====
    banIP(ip) {
        this.bannedIPs.add(ip);
        return { success: true };
    }

    unbanIP(ip) {
        this.bannedIPs.delete(ip);
        return { success: true };
    }

    isIPBanned(ip) {
        return this.bannedIPs.has(ip);
    }
}

const adminService = new AdminService();

// ============================================
// 📡 ADMIN ROUTES
// ============================================

// ===== USER MANAGEMENT =====
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
    const users = adminService.getAllUsers();
    res.json(users);
});

app.get('/api/admin/users/:userId', authMiddleware, adminMiddleware, (req, res) => {
    const user = adminService.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
    res.json(user);
});

app.put('/api/admin/users/:userId/ban', authMiddleware, adminMiddleware, async (req, res) => {
    const { userId } = req.params;
    const { banned } = req.body;
    const result = await adminService.banUser(userId, banned, req.user.userId);
    if (result.success) {
        io.emit('users-online', encryption.getOnlineUsers());
        res.json({ success: true });
    } else {
        res.status(400).json(result);
    }
});

app.delete('/api/admin/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await adminService.deleteUser(userId, req.user.userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(400).json(result);
    }
});

app.post('/api/admin/users/:userId/make-admin', authMiddleware, adminMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await adminService.makeAdmin(userId, req.user.userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(400).json(result);
    }
});

app.post('/api/admin/users/:userId/verify', authMiddleware, adminMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await adminService.verifyUser(userId, req.user.userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(400).json(result);
    }
});

// ===== POST MANAGEMENT =====
app.get('/api/admin/posts', authMiddleware, adminMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit) || 1000;
    const posts = adminService.getAllPosts(limit);
    res.json(posts);
});

app.delete('/api/admin/posts/:postId', authMiddleware, adminMiddleware, async (req, res) => {
    const { postId } = req.params;
    const result = await adminService.deletePost(postId, req.user.userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(404).json(result);
    }
});

// ===== STATS =====
app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
    const stats = adminService.getSystemStats();
    res.json(stats);
});

// ===== BROADCAST =====
app.post('/api/admin/broadcast', authMiddleware, adminMiddleware, async (req, res) => {
    const { message } = req.body;
    const result = await adminService.broadcastMessage(message, req.user.userId, io);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(400).json(result);
    }
});

// ===== LOGS =====
app.get('/api/admin/logs', authMiddleware, adminMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const filter = req.query.filter || null;
    const logs = adminService.getAdminLogs(limit, filter);
    res.json(logs);
});

app.get('/api/admin/audit', authMiddleware, adminMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const logs = adminService.getAuditTrail(limit);
    res.json(logs);
});

// ===== PERFORMANCE =====
app.get('/api/admin/performance', authMiddleware, adminMiddleware, (req, res) => {
    const metrics = adminService.getPerformanceMetrics();
    res.json(metrics);
});

// ===== CLEANUP =====
app.post('/api/admin/cleanup', authMiddleware, adminMiddleware, async (req, res) => {
    const result = await adminService.cleanup();
    res.json(result);
});

// ===== SETTINGS =====
app.get('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
    res.json(adminService.systemSettings);
});

app.put('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
    const settings = adminService.updateSettings(req.body);
    res.json(settings);
});

// ===== IP BANNING =====
app.post('/api/admin/ban-ip', authMiddleware, adminMiddleware, (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP الزامی است' });
    const result = adminService.banIP(ip);
    res.json(result);
});

app.post('/api/admin/unban-ip', authMiddleware, adminMiddleware, (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP الزامی است' });
    const result = adminService.unbanIP(ip);
    res.json(result);
});

module.exports = {
    adminService
};