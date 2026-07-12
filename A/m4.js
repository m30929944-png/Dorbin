// ============================================
// 👑 ADMIN PANEL - SYSTEM CONTROL
// ============================================

const { db, onlineUsers } = require('./m1.js');
const authService = require('./m2.js');
const postService = require('./m3.js');

class AdminService {
    constructor() {
        this.adminLogs = [];
        this.auditTrail = [];
        this.systemMetrics = {
            startTime: Date.now(),
            totalRequests: 0,
            totalErrors: 0,
            activeUsers: 0
        };
        this.MAX_LOGS = 10000;
    }

    // ===== USER MANAGEMENT =====
    async getAllUsers() {
        return await authService.getAllUsers();
    }

    async getUserById(userId) {
        const user = db.getUser(userId);
        if (!user) return null;
        return authService.sanitizeUser(user);
    }

    async banUser(userId, banned, adminId) {
        const result = await authService.banUser(userId, banned);
        if (result.success) {
            this.logAdminAction(adminId, 'ban_user', { userId, banned });
        }
        return result;
    }

    async deleteUser(userId, adminId) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };
        if (user.isAdmin) return { success: false, error: 'نمی‌توان ادمین را حذف کرد' };

        // Delete all user posts
        const posts = db.getPosts(1, 100000, null, userId);
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

    async verifyUser(userId, adminId) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };

        db.updateUser(userId, { isVerified: true });
        this.logAdminAction(adminId, 'verify_user', { userId });

        return { success: true };
    }

    // ===== POST MANAGEMENT =====
    async getAllPosts() {
        return await postService.getAllPosts();
    }

    async deletePost(postId, adminId) {
        const post = db.getPost(postId);
        if (!post) return { success: false, error: 'پست یافت نشد' };

        const deleted = await postService.deletePostAdmin(postId);
        if (deleted) {
            this.logAdminAction(adminId, 'delete_post', { postId });
        }
        return { success: deleted };
    }

    async deleteAllPosts(userId, adminId) {
        const posts = db.getPosts(1, 100000, null, userId);
        for (const post of posts.posts) {
            db.deletePost(post.postId);
        }
        this.logAdminAction(adminId, 'delete_all_posts', { userId });

        return { success: true };
    }

    // ===== SYSTEM STATISTICS =====
    getSystemStats() {
        const stats = db.getStats();
        return {
            ...stats,
            onlineUsers: onlineUsers.size,
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

    // ===== BROADCAST =====
    async broadcastMessage(message, adminId, io) {
        if (!message || message.trim().length === 0) {
            return { success: false, error: 'متن پیام الزامی است' };
        }

        this.logAdminAction(adminId, 'broadcast', { message });
        
        if (io) {
            io.emit('broadcast', {
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

    getAuditTrail(limit = 100) {
        return this.auditTrail.slice(-limit).reverse();
    }

    // ===== SYSTEM MAINTENANCE =====
    async cleanup() {
        // Clean expired stories
        const stories = db.getStories();
        const now = Date.now();
        
        for (const story of stories) {
            const age = now - new Date(story.createdAt).getTime();
            if (age >= 24 * 60 * 60 * 1000) {
                db.deleteStory(story.storyId, story.userId);
            }
        }

        // Clean old sessions
        const sessions = authService.sessions;
        for (const [token, userId] of sessions) {
            const user = db.getUser(userId);
            if (!user || user.isBanned) {
                sessions.delete(token);
                authService.tokenBlacklist.add(token);
            }
        }

        // Clean login attempts
        authService.loginAttempts.clear();

        return { success: true, message: 'سیستم پاکسازی شد' };
    }

    // ===== PERFORMANCE METRICS =====
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

    // ===== REPORT MANAGEMENT =====
    async reportContent(data, adminId) {
        const report = {
            id: `report_${Date.now()}`,
            ...data,
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        // In production, save to database
        this.logAdminAction(adminId, 'report_content', { reportId: report.id, data });
        
        return { success: true, report };
    }

    async resolveReport(reportId, action, adminId) {
        // In production, update report status
        this.logAdminAction(adminId, 'resolve_report', { reportId, action });
        
        return { success: true };
    }
}

module.exports = new AdminService();
