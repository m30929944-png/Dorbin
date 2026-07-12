// ============================================
// 🔐 AUTHENTICATION & USERS MANAGEMENT
// ============================================

const { db, encryption, onlineUsers } = require('./m1.js');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

class AuthService {
    constructor() {
        this.sessions = new Map();
        this.tokenBlacklist = new Set();
        this.loginAttempts = new Map();
        this.MAX_LOGIN_ATTEMPTS = 5;
        this.LOCK_TIME = 15 * 60 * 1000;
        this.ADMIN_EMAIL = 'milad.yari1377m@gmail.com';
        this.ADMIN_PASSWORD = 'M09145978426M';
    }

    // ===== RATE LIMITERS =====
    getRateLimiters() {
        return {
            register: rateLimit({
                windowMs: 15 * 60 * 1000,
                max: 10,
                message: { error: 'تعداد درخواست ثبت نام بیش از حد مجاز است' }
            }),
            login: rateLimit({
                windowMs: 5 * 60 * 1000,
                max: 20,
                message: { error: 'تعداد درخواست ورود بیش از حد مجاز است' }
            }),
            passwordReset: rateLimit({
                windowMs: 60 * 60 * 1000,
                max: 3,
                message: { error: 'تعداد درخواست بازنشانی رمز بیش از حد مجاز است' }
            })
        };
    }

    // ===== VALIDATION =====
    validateUserData(data) {
        const errors = [];

        if (!data.username || data.username.length < 3 || data.username.length > 30) {
            errors.push('نام کاربری باید بین 3 تا 30 کاراکتر باشد');
        }

        if (!/^[a-zA-Z0-9_\u0600-\u06FF]+$/.test(data.username)) {
            errors.push('نام کاربری فقط می‌تواند شامل حروف، اعداد و زیرخط باشد');
        }

        if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
            errors.push('ایمیل معتبر نیست');
        }

        if (!data.password || data.password.length < 8) {
            errors.push('رمز عبور باید حداقل 8 کاراکتر باشد');
        }

        if (data.password && !/[A-Z]/.test(data.password)) {
            errors.push('رمز عبور باید حداقل یک حرف بزرگ داشته باشد');
        }

        if (data.password && !/[a-z]/.test(data.password)) {
            errors.push('رمز عبور باید حداقل یک حرف کوچک داشته باشد');
        }

        if (data.password && !/[0-9]/.test(data.password)) {
            errors.push('رمز عبور باید حداقل یک عدد داشته باشد');
        }

        return errors;
    }

    // ===== REGISTER =====
    async register(data) {
        const errors = this.validateUserData(data);
        if (errors.length > 0) {
            return { success: false, errors };
        }

        if (db.getUserByEmail(data.email)) {
            return { success: false, error: 'این ایمیل قبلاً ثبت شده است' };
        }

        if (db.getUserByUsername(data.username)) {
            return { success: false, error: 'این نام کاربری قبلاً ثبت شده است' };
        }

        const userId = encryption.generateId('user');
        const isAdmin = data.email === this.ADMIN_EMAIL;

        const user = {
            userId,
            username: data.username,
            email: data.email,
            fullName: data.fullName || data.username,
            password: encryption.hashPassword(data.password),
            bio: '',
            avatar: '',
            followers: 0,
            following: 0,
            postsCount: 0,
            language: 'fa',
            theme: 'light',
            isOnline: false,
            isAdmin: isAdmin,
            isBanned: false,
            isVerified: false,
            emailVerified: false,
            phoneVerified: false,
            twoFactorEnabled: false,
            twoFactorSecret: null,
            createdAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            deviceInfo: data.deviceInfo || null,
            ipAddress: data.ipAddress || null
        };

        db.saveUser(user);

        const token = encryption.generateToken();
        this.sessions.set(token, userId);
        onlineUsers.set(userId, { socketId: null, username: user.username });

        return {
            success: true,
            token: token,
            user: this.sanitizeUser(user)
        };
    }

    // ===== LOGIN =====
    async login(email, password, ipAddress = null) {
        if (!email || !password) {
            return { success: false, error: 'ایمیل و رمز عبور الزامی است' };
        }

        // Check login attempts
        const attempts = this.loginAttempts.get(email) || { count: 0, lockedUntil: 0 };
        if (attempts.lockedUntil > Date.now()) {
            return { success: false, error: 'حساب کاربری موقتاً قفل شده است' };
        }

        const user = db.getUserByEmail(email);
        if (!user) {
            this.recordFailedAttempt(email);
            return { success: false, error: 'ایمیل یا رمز عبور اشتباه است' };
        }

        const isValid = encryption.verifyPassword(password, user.password);
        if (!isValid) {
            this.recordFailedAttempt(email);
            return { success: false, error: 'ایمیل یا رمز عبور اشتباه است' };
        }

        if (user.isBanned) {
            return { success: false, error: 'این کاربر مسدود شده است' };
        }

        // Clear login attempts
        this.loginAttempts.delete(email);

        // Generate token
        const token = encryption.generateToken();
        this.sessions.set(token, user.userId);
        onlineUsers.set(user.userId, { socketId: null, username: user.username });
        db.updateUser(user.userId, { 
            isOnline: true, 
            lastSeen: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            ipAddress: ipAddress || user.ipAddress
        });

        return {
            success: true,
            token: token,
            user: this.sanitizeUser(user)
        };
    }

    // ===== LOGOUT =====
    async logout(token) {
        if (token) {
            const userId = this.sessions.get(token);
            if (userId) {
                db.updateUser(userId, { isOnline: false, lastSeen: new Date().toISOString() });
                onlineUsers.delete(userId);
                this.tokenBlacklist.add(token);
            }
            this.sessions.delete(token);
        }
        return { success: true };
    }

    // ===== REFRESH TOKEN =====
    async refreshToken(oldToken) {
        if (!oldToken || this.tokenBlacklist.has(oldToken)) {
            return { success: false, error: 'توکن نامعتبر است' };
        }

        const userId = this.sessions.get(oldToken);
        if (!userId) {
            return { success: false, error: 'جلسه منقضی شده است' };
        }

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر نامعتبر است' };
        }

        const newToken = encryption.generateToken();
        this.sessions.delete(oldToken);
        this.sessions.set(newToken, userId);

        return {
            success: true,
            token: newToken,
            user: this.sanitizeUser(user)
        };
    }

    // ===== GET CURRENT USER =====
    async getCurrentUser(token) {
        if (!token || this.tokenBlacklist.has(token)) {
            return { success: false, error: 'توکن نامعتبر است' };
        }

        const userId = this.sessions.get(token);
        if (!userId) {
            return { success: false, error: 'جلسه منقضی شده است' };
        }

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر نامعتبر است' };
        }

        // Update last activity
        db.updateUser(userId, { lastActivity: new Date().toISOString() });

        return {
            success: true,
            user: this.sanitizeUser(user)
        };
    }

    // ===== VERIFY ADMIN =====
    async verifyAdmin(token) {
        const result = await this.getCurrentUser(token);
        if (!result.success) return { success: false, error: 'دسترسی غیرمجاز' };
        
        if (!result.user.isAdmin) {
            return { success: false, error: 'دسترسی ادمین مورد نیاز است' };
        }

        return { success: true, isAdmin: true };
    }

    // ===== SANITIZE USER =====
    sanitizeUser(user) {
        const { password, twoFactorSecret, ...sanitized } = user;
        return sanitized;
    }

    // ===== RECORD FAILED ATTEMPT =====
    recordFailedAttempt(email) {
        const attempts = this.loginAttempts.get(email) || { count: 0, lockedUntil: 0 };
        attempts.count++;
        if (attempts.count >= this.MAX_LOGIN_ATTEMPTS) {
            attempts.lockedUntil = Date.now() + this.LOCK_TIME;
        }
        this.loginAttempts.set(email, attempts);
    }

    // ===== SEARCH USERS =====
    async searchUsers(query, limit = 20) {
        if (!query || query.length < 2) return [];
        const results = db.searchUsers(query, limit);
        return results.map(u => this.sanitizeUser(u));
    }

    // ===== GET ALL USERS =====
    async getAllUsers() {
        const users = db.getAllUsers();
        return users.map(u => this.sanitizeUser(u));
    }

    // ===== BAN USER =====
    async banUser(userId, banned) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };
        if (user.isAdmin) return { success: false, error: 'نمی‌توان ادمین را مسدود کرد' };

        db.updateUser(userId, { isBanned: banned });
        if (banned) {
            onlineUsers.delete(userId);
            for (const [token, id] of this.sessions) {
                if (id === userId) {
                    this.tokenBlacklist.add(token);
                    this.sessions.delete(token);
                }
            }
        }

        return { success: true };
    }

    // ===== UPDATE PROFILE =====
    async updateProfile(userId, data) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };

        const updates = {};

        if (data.bio !== undefined) updates.bio = data.bio;
        if (data.avatar !== undefined) updates.avatar = data.avatar;
        if (data.fullName !== undefined) updates.fullName = data.fullName;
        if (data.theme !== undefined) updates.theme = data.theme;
        if (data.language !== undefined) updates.language = data.language;

        if (data.username !== undefined) {
            const existing = db.getUserByUsername(data.username);
            if (existing && existing.userId !== userId) {
                return { success: false, error: 'این نام کاربری قبلاً ثبت شده است' };
            }
            updates.username = data.username;
        }

        db.updateUser(userId, updates);
        const updated = db.getUser(userId);

        return {
            success: true,
            user: this.sanitizeUser(updated)
        };
    }

    // ===== CHANGE PASSWORD =====
    async changePassword(userId, oldPassword, newPassword) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };

        if (!encryption.verifyPassword(oldPassword, user.password)) {
            return { success: false, error: 'رمز عبور فعلی اشتباه است' };
        }

        if (newPassword.length < 8) {
            return { success: false, error: 'رمز عبور باید حداقل 8 کاراکتر باشد' };
        }

        db.updateUser(userId, { password: encryption.hashPassword(newPassword) });

        return { success: true };
    }

    // ===== GET USER STATS =====
    getUserStats(userId) {
        const user = db.getUser(userId);
        if (!user) return null;

        return {
            followers: user.followers || 0,
            following: user.following || 0,
            postsCount: user.postsCount || 0,
            isOnline: user.isOnline || false,
            isVerified: user.isVerified || false,
            isBanned: user.isBanned || false,
            isAdmin: user.isAdmin || false,
            createdAt: user.createdAt,
            lastSeen: user.lastSeen
        };
    }

    // ===== GET FOLLOWERS/FOLLOWING =====
    getFollowers(userId) {
        return db.getFollowers(userId).map(u => this.sanitizeUser(u));
    }

    getFollowing(userId) {
        return db.getFollowing(userId).map(u => this.sanitizeUser(u));
    }

    // ===== FOLLOW/UNFOLLOW =====
    async follow(userId, targetId) {
        if (userId === targetId) {
            return { success: false, error: 'نمی‌توانید خودتان را دنبال کنید' };
        }

        const result = db.followUser(userId, targetId);
        if (!result) {
            return { success: false, error: 'از قبل دنبال می‌کنید یا کاربر یافت نشد' };
        }

        return { success: true };
    }

    async unfollow(userId, targetId) {
        const result = db.unfollowUser(userId, targetId);
        if (!result) {
            return { success: false, error: 'دنبال نمی‌کنید یا کاربر یافت نشد' };
        }

        return { success: true };
    }

    // ===== ONLINE USERS =====
    getOnlineUsers() {
        return Array.from(onlineUsers.keys());
    }

    getOnlineCount() {
        return onlineUsers.size;
    }

    // ===== CLEANUP =====
    cleanup() {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;

        // Clean expired sessions
        for (const [token, userId] of this.sessions) {
            const user = db.getUser(userId);
            if (!user || user.isBanned) {
                this.sessions.delete(token);
                this.tokenBlacklist.add(token);
            }
        }

        // Clean login attempts
        for (const [email, data] of this.loginAttempts) {
            if (data.lockedUntil && data.lockedUntil < now) {
                this.loginAttempts.delete(email);
            }
        }

        // Clean blacklist (keep last 7 days)
        const sevenDaysAgo = Date.now() - 7 * oneDay;
        for (const token of this.tokenBlacklist) {
            // In production, store with timestamp
        }
    }
}

module.exports = new AuthService();
