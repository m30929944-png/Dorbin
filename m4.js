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
            totalErrors: 0,
            totalApiCalls: 0
        };
        this.MAX_LOGS = 10000;
        this.bannedIPs = new Set();
        this.systemSettings = {
            maintenanceMode: false,
            registrationEnabled: true,
            maxUploadSize: 500,
            maxUsers: 1000000,
            allowComments: true,
            allowLikes: true,
            allowShares: true,
            allowStories: true,
            allowLive: true,
            allowChat: true
        };
        this.broadcastHistory = [];
        this.adminNotifications = [];
        this.pendingReports = [];
        this.systemBackups = [];
        this.performanceLogs = [];
        this.errorLogs = [];
        this.requestLogs = [];
        this.userActivityLogs = [];
    }

    // ============================================
    // 👤 USER MANAGEMENT
    // ============================================
    getAllUsers() {
        try {
            const users = db.getAllUsers();
            return users.map(u => ({ ...u, password: undefined }));
        } catch (error) {
            console.error('Get all users error:', error);
            return [];
        }
    }

    getUserById(userId) {
        try {
            const user = db.getUser(userId);
            if (!user) return null;
            return { ...user, password: undefined };
        } catch (error) {
            console.error('Get user by id error:', error);
            return null;
        }
    }

    async banUser(userId, banned, adminId) {
        try {
            const user = db.getUser(userId);
            if (!user) return { success: false, error: 'کاربر یافت نشد' };
            if (user.isAdmin) return { success: false, error: 'نمی‌توان ادمین را مسدود کرد' };

            db.updateUser(userId, { isBanned: banned });
            if (banned) {
                encryption.onlineUsers.delete(userId);
                for (const [token, id] of encryption.sessions) {
                    if (id === userId) {
                        encryption.destroySession(token);
                    }
                }
            }
            this.logAdminAction(adminId, 'ban_user', { userId, banned });
            return { success: true };
        } catch (error) {
            console.error('Ban user error:', error);
            return { success: false, error: 'خطای سرور' };
        }
    }

    async deleteUser(userId, adminId) {
        try {
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
        } catch (error) {
            console.error('Delete user error:', error);
            return { success: false, error: 'خطای سرور' };
        }
    }

    async makeAdmin(userId, adminId) {
        try {
            const user = db.getUser(userId);
            if (!user) return { success: false, error: 'کاربر یافت نشد' };
            db.updateUser(userId, { isAdmin: true });
            this.logAdminAction(adminId, 'make_admin', { userId });
            return { success: true };
        } catch (error) {
            console.error('Make admin error:', error);
            return { success: false, error: 'خطای سرور' };
        }
    }

    async removeAdmin(userId, adminId) {
        try {
            const user = db.getUser(userId);
            if (!user) return { success: false, error: 'کاربر یافت نشد' };
            if (user.userId === adminId) return { success: false, error: 'نمی‌توانید خودتان را حذف کنید' };
            db.updateUser(userId, { isAdmin: false });
            this.logAdminAction(adminId, 'remove_admin', { userId });
            return { success: true };
        } catch (error) {
            console.error('Remove admin error:', error);
            return { success: false, error: 'خطای سرور' };
        }
    }

    async verifyUser(userId, adminId) {
        try {
            const user = db.getUser(userId);
            if (!user) return { success: false, error: 'کاربر یافت نشد' };
            db.updateUser(userId, { isVerified: true });
            this.logAdminAction(adminId, 'verify_user', { userId });
            return { success: true };
        } catch (error) {
            console.error('Verify user error:', error);
            return { success: false, error: 'خطای سرور' };
        }
    }

    async unverifyUser(userId, adminId) {
        try {
            const user = db.getUser(userId);
            if (!user) return { success: false, error: 'کاربر یافت نشد' };
            db.updateUser(userId, { isVerified: false });
            this.logAdminAction(adminId, 'unverify_user', { userId });
            return { success: true };
        } catch (error) {
            console.error('Unverify user error:', error);
            return { success: false, error: 'خطای سرور' };
        }
    }

    // ============================================
    // 📸 POST MANAGEMENT
    // ============================================
    getAllPosts(limit = 1000) {
        try {
            const result = db.getPosts(1, limit);
            return result.posts;
        } catch (error) {
            console.error('Get all posts error:', error);
            return [];
        }
    }

    async deletePost(postId, adminId) {
        try {
            const post = db.getPost(postId);
            if (!post) return { success: false, error: 'پست یافت نشد' };
            db.deletePost(postId);
            this.logAdminAction(adminId, 'delete_post', { postId });
            return { success: true };
        } catch (error) {
            console.error('Delete post error:', error);
            return { success: false, error: 'خطای سرور' };
        }
    }

    async deleteAllUserPosts(userId, adminId) {
        try {
            const posts = db.getPosts(1, 10000, null, userId);
            for (const post of posts.posts) {
                db.deletePost(post.postId);
            }
            this.logAdminAction(adminId, 'delete_all_user_posts', { userId });
            return { success: true };
        } catch (error) {
            console.error('Delete all user posts error:', error);
            return { success: false, error: 'خطای سرور' };
        }
    }

    // ============================================
    // 📊 SYSTEM STATISTICS
    // ============================================
    getSystemStats() {
        try {
            const stats = db.getStats();
            const uptime = Math.floor((Date.now() - this.systemMetrics.startTime) / 1000 / 60 / 60);
            
            return {
                ...stats,
                onlineUsers: encryption.getOnlineCount(),
                uptime: uptime,
                totalRequests: this.systemMetrics.totalRequests,
                totalErrors: this.systemMetrics.totalErrors,
                totalApiCalls: this.systemMetrics.totalApiCalls,
                adminLogs: this.adminLogs.length,
                auditTrail: this.auditTrail.length,
                memory: process.memoryUsage(),
                cpu: process.cpuUsage(),
                nodeVersion: process.version,
                platform: process.platform,
                pid: process.pid,
                systemSettings: this.systemSettings,
                bannedIPs: this.bannedIPs.size,
                broadcastHistory: this.broadcastHistory.length,
                pendingReports: this.pendingReports.length,
                systemBackups: this.systemBackups.length
            };
        } catch (error) {
            console.error('Get system stats error:', error);
            return null;
        }
    }

    // ============================================
    // 📢 BROADCAST
    // ============================================
    async broadcastMessage(message, adminId) {
        try {
            if (!message || message.trim().length === 0) {
                return { success: false, error: 'متن پیام الزامی است' };
            }

            const broadcastData = {
                id: `broadcast_${Date.now()}`,
                message: message.trim(),
                from: 'ادمین',
                timestamp: new Date().toISOString(),
                adminId: adminId
            };

            this.logAdminAction(adminId, 'broadcast', { message });
            this.broadcastHistory.push(broadcastData);
            
            // Keep only last 100 broadcasts
            if (this.broadcastHistory.length > 100) {
                this.broadcastHistory = this.broadcastHistory.slice(-100);
            }

            // Send to all connected users
            io.emit('broadcast', broadcastData);

            return { success: true, data: broadcastData };
        } catch (error) {
            console.error('Broadcast error:', error);
            return { success: false, error: 'خطای سرور' };
        }
    }

    getBroadcastHistory(limit = 20) {
        return this.broadcastHistory.slice(-limit).reverse();
    }

    // ============================================
    // 📝 ADMIN LOGS
    // ============================================
    logAdminAction(adminId, action, data) {
        const log = {
            id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            adminId,
            action,
            data,
            timestamp: new Date().toISOString(),
            ip: null // In production, get from request
        };
        this.adminLogs.push(log);
        this.auditTrail.push(log);
        this.userActivityLogs.push({
            ...log,
            type: 'admin_action'
        });
        
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

    // ============================================
    // 📋 REPORTS
    // ============================================
    addReport(report) {
        this.pendingReports.push({
            ...report,
            id: `report_${Date.now()}`,
            status: 'pending',
            createdAt: new Date().toISOString()
        });
        return this.pendingReports[this.pendingReports.length - 1];
    }

    getPendingReports(limit = 50) {
        return this.pendingReports.filter(r => r.status === 'pending').slice(0, limit);
    }

    resolveReport(reportId, adminId, action) {
        const report = this.pendingReports.find(r => r.id === reportId);
        if (report) {
            report.status = 'resolved';
            report.resolvedAt = new Date().toISOString();
            report.resolvedBy = adminId;
            report.resolution = action;
            this.logAdminAction(adminId, 'resolve_report', { reportId, action });
            return true;
        }
        return false;
    }

    // ============================================
    // 🧹 SYSTEM MAINTENANCE
    // ============================================
    async cleanup() {
        try {
            db.cleanup();
            
            // Clean old logs
            const now = Date.now();
            const thirtyDays = 30 * 24 * 60 * 60 * 1000;
            
            this.adminLogs = this.adminLogs.filter(log => {
                return now - new Date(log.timestamp).getTime() < thirtyDays;
            });
            
            this.auditTrail = this.auditTrail.filter(log => {
                return now - new Date(log.timestamp).getTime() < thirtyDays;
            });

            // Clean old broadcasts
            this.broadcastHistory = this.broadcastHistory.slice(-100);

            return { success: true, message: 'سیستم پاکسازی شد' };
        } catch (error) {
            console.error('Cleanup error:', error);
            return { success: false, error: 'خطا در پاکسازی' };
        }
    }

    // ============================================
    // 💾 BACKUP
    // ============================================
    createBackup() {
        try {
            const backup = {
                id: `backup_${Date.now()}`,
                timestamp: new Date().toISOString(),
                stats: db.getStats(),
                settings: this.systemSettings,
                adminLogs: this.adminLogs.slice(-1000),
                broadcastHistory: this.broadcastHistory.slice(-50)
            };
            this.systemBackups.push(backup);
            
            // Keep only last 10 backups
            if (this.systemBackups.length > 10) {
                this.systemBackups = this.systemBackups.slice(-10);
            }
            
            return { success: true, backup };
        } catch (error) {
            console.error('Backup error:', error);
            return { success: false, error: 'خطا در ایجاد پشتیبان' };
        }
    }

    getBackups(limit = 10) {
        return this.systemBackups.slice(-limit).reverse();
    }

    // ============================================
    // 📊 PERFORMANCE
    // ============================================
    getPerformanceMetrics() {
        try {
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
                cpus: require('os').cpus().length,
                totalMemory: require('os').totalmem(),
                freeMemory: require('os').freemem()
            };
        } catch (error) {
            console.error('Performance metrics error:', error);
            return null;
        }
    }

    // ============================================
    // ⚙️ SYSTEM SETTINGS
    // ============================================
    updateSettings(settings) {
        try {
            this.systemSettings = { ...this.systemSettings, ...settings };
            return this.systemSettings;
        } catch (error) {
            console.error('Update settings error:', error);
            return null;
        }
    }

    // ============================================
    // 🚫 IP BANNING
    // ============================================
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

    getBannedIPs() {
        return Array.from(this.bannedIPs);
    }

    // ============================================
    // 📊 REQUEST LOGGING
    // ============================================
    logRequest(req, res, duration) {
        this.requestLogs.push({
            method: req.method,
            url: req.url,
            ip: req.ip,
            userId: req.user?.userId || null,
            status: res.statusCode,
            duration: duration,
            timestamp: new Date().toISOString()
        });
        
        if (this.requestLogs.length > 10000) {
            this.requestLogs = this.requestLogs.slice(-5000);
        }
    }

    getRequestLogs(limit = 100) {
        return this.requestLogs.slice(-limit).reverse();
    }

    logError(error, req) {
        this.errorLogs.push({
            message: error.message,
            stack: error.stack,
            url: req?.url,
            method: req?.method,
            userId: req?.user?.userId || null,
            timestamp: new Date().toISOString()
        });
        
        if (this.errorLogs.length > 10000) {
            this.errorLogs = this.errorLogs.slice(-5000);
        }
    }

    getErrorLogs(limit = 100) {
        return this.errorLogs.slice(-limit).reverse();
    }

    // ============================================
    // 👥 USER ACTIVITY
    // ============================================
    logUserActivity(userId, action, data) {
        this.userActivityLogs.push({
            userId,
            action,
            data,
            timestamp: new Date().toISOString()
        });
        
        if (this.userActivityLogs.length > 10000) {
            this.userActivityLogs = this.userActivityLogs.slice(-5000);
        }
    }

    getUserActivity(userId, limit = 50) {
        return this.userActivityLogs
            .filter(log => log.userId === userId)
            .slice(-limit)
            .reverse();
    }

    // ============================================
    // 📊 STATS
    // ============================================
    getStats() {
        return {
            totalUsers: db.getAllUsers().length,
            totalPosts: db.getPosts(1, 10000).total,
            totalStories: db.getStories().length,
            totalMessages: Object.values(db.shards).reduce((acc, shard) => {
                let count = 0;
                for (const [key, messages] of shard.messages) {
                    count += messages.length;
                }
                return acc + count;
            }, 0),
            totalLikes: Object.values(db.shards).reduce((acc, shard) => acc + shard.likes.size, 0),
            totalComments: Object.values(db.shards).reduce((acc, shard) => {
                let count = 0;
                for (const post of shard.posts) {
                    count += (post.comments || []).length;
                }
                return acc + count;
            }, 0),
            onlineUsers: encryption.getOnlineCount(),
            adminLogs: this.adminLogs.length,
            broadcastHistory: this.broadcastHistory.length,
            pendingReports: this.pendingReports.length,
            systemBackups: this.systemBackups.length
        };
    }
}

const adminService = new AdminService();

// ============================================
// 📡 ADMIN ROUTES
// ============================================

// ===== USER MANAGEMENT =====
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const users = adminService.getAllUsers();
        res.json(users);
    } catch (error) {
        console.error('Admin get users error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/admin/users/:userId', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const user = adminService.getUserById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
        res.json(user);
    } catch (error) {
        console.error('Admin get user error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.put('/api/admin/users/:userId/ban', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const { banned } = req.body;
        const result = await adminService.banUser(userId, banned, req.user.userId);
        if (result.success) {
            io.emit('users-online', encryption.getOnlineUsers());
            res.json({ success: true });
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Admin ban user error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.delete('/api/admin/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await adminService.deleteUser(userId, req.user.userId);
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Admin delete user error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.post('/api/admin/users/:userId/make-admin', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await adminService.makeAdmin(userId, req.user.userId);
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Admin make admin error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.post('/api/admin/users/:userId/verify', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await adminService.verifyUser(userId, req.user.userId);
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Admin verify user error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== POST MANAGEMENT =====
app.get('/api/admin/posts', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 1000;
        const posts = adminService.getAllPosts(limit);
        res.json(posts);
    } catch (error) {
        console.error('Admin get posts error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.delete('/api/admin/posts/:postId', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { postId } = req.params;
        const result = await adminService.deletePost(postId, req.user.userId);
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(404).json(result);
        }
    } catch (error) {
        console.error('Admin delete post error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== STATS =====
app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const stats = adminService.getSystemStats();
        if (!stats) return res.status(500).json({ error: 'خطا در دریافت آمار' });
        res.json(stats);
    } catch (error) {
        console.error('Admin get stats error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== BROADCAST =====
app.post('/api/admin/broadcast', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { message } = req.body;
        const result = await adminService.broadcastMessage(message, req.user.userId);
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Admin broadcast error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/admin/broadcast/history', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const history = adminService.getBroadcastHistory(limit);
        res.json(history);
    } catch (error) {
        console.error('Admin get broadcast history error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== LOGS =====
app.get('/api/admin/logs', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const filter = req.query.filter || null;
        const logs = adminService.getAdminLogs(limit, filter);
        res.json(logs);
    } catch (error) {
        console.error('Admin get logs error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/admin/audit', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const logs = adminService.getAuditTrail(limit);
        res.json(logs);
    } catch (error) {
        console.error('Admin get audit error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== PERFORMANCE =====
app.get('/api/admin/performance', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const metrics = adminService.getPerformanceMetrics();
        if (!metrics) return res.status(500).json({ error: 'خطا در دریافت اطلاعات عملکرد' });
        res.json(metrics);
    } catch (error) {
        console.error('Admin get performance error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== CLEANUP =====
app.post('/api/admin/cleanup', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const result = await adminService.cleanup();
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        console.error('Admin cleanup error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== BACKUP =====
app.post('/api/admin/backup', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const result = adminService.createBackup();
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        console.error('Admin backup error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/admin/backups', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const backups = adminService.getBackups(limit);
        res.json(backups);
    } catch (error) {
        console.error('Admin get backups error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== SETTINGS =====
app.get('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
    try {
        res.json(adminService.systemSettings);
    } catch (error) {
        console.error('Admin get settings error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.put('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const settings = adminService.updateSettings(req.body);
        if (settings) {
            res.json(settings);
        } else {
            res.status(500).json({ error: 'خطا در بروزرسانی تنظیمات' });
        }
    } catch (error) {
        console.error('Admin update settings error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== REPORTS =====
app.get('/api/admin/reports', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const reports = adminService.getPendingReports();
        res.json(reports);
    } catch (error) {
        console.error('Admin get reports error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.post('/api/admin/reports/:reportId/resolve', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const { reportId } = req.params;
        const { action } = req.body;
        const result = adminService.resolveReport(reportId, req.user.userId, action);
        if (result) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'گزارش یافت نشد' });
        }
    } catch (error) {
        console.error('Admin resolve report error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== IP BANNING =====
app.post('/api/admin/ban-ip', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const { ip } = req.body;
        if (!ip) return res.status(400).json({ error: 'IP الزامی است' });
        const result = adminService.banIP(ip);
        res.json(result);
    } catch (error) {
        console.error('Admin ban IP error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.post('/api/admin/unban-ip', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const { ip } = req.body;
        if (!ip) return res.status(400).json({ error: 'IP الزامی است' });
        const result = adminService.unbanIP(ip);
        res.json(result);
    } catch (error) {
        console.error('Admin unban IP error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/admin/banned-ips', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const ips = adminService.getBannedIPs();
        res.json(ips);
    } catch (error) {
        console.error('Admin get banned IPs error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== REQUEST LOGS =====
app.get('/api/admin/requests', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const logs = adminService.getRequestLogs(limit);
        res.json(logs);
    } catch (error) {
        console.error('Admin get request logs error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/admin/errors', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const logs = adminService.getErrorLogs(limit);
        res.json(logs);
    } catch (error) {
        console.error('Admin get error logs error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== USER ACTIVITY =====
app.get('/api/admin/user-activity/:userId', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const { userId } = req.params;
        const limit = parseInt(req.query.limit) || 50;
        const logs = adminService.getUserActivity(userId, limit);
        res.json(logs);
    } catch (error) {
        console.error('Admin get user activity error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/admin/stats/summary', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const stats = adminService.getStats();
        res.json(stats);
    } catch (error) {
        console.error('Admin get stats summary error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ============================================
// 📊 MIDDLEWARE FOR LOGGING
// ============================================
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        adminService.logRequest(req, res, duration);
        adminService.systemMetrics.totalRequests++;
        if (res.statusCode >= 400) {
            adminService.systemMetrics.totalErrors++;
        }
        adminService.systemMetrics.totalApiCalls++;
    });
    next();
});

// ============================================
// 🚀 ERROR HANDLING
// ============================================
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    adminService.logError(err, req);
    adminService.systemMetrics.totalErrors++;
    res.status(500).json({ 
        error: 'خطای داخلی سرور',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

module.exports = {
    adminService
};