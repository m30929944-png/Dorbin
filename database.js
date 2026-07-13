// ============================================
// database.js - مدیریت دیتابیس پیشرفته با کش و رمزنگاری
// ============================================
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

class DatabaseManager {
    constructor() {
        // کش حافظه برای کوئری‌های پرتکرار
        this.cache = new Map();
        this.cacheTTL = 60000; // 60 ثانیه
        
        // مسیر دیتابیس
        this.dbPath = path.join(__dirname, 'data.sqlite');
        
        // اتصال به دیتابیس با تنظیمات بهینه
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('cache_size = 10000');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('temp_store = MEMORY');
        
        // رمزنگاری کلید برای چت
        this.encryptionKey = crypto.randomBytes(32);
        this.encryptionIV = crypto.randomBytes(16);
        
        // ایجاد جداول
        this.initTables();
    }

    // ============================================
    // رمزنگاری و رمزگشایی
    // ============================================
    encrypt(text) {
        try {
            const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, this.encryptionIV);
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag().toString('hex');
            return `${encrypted}:${authTag}`;
        } catch (error) {
            console.error('Encryption error:', error);
            return text;
        }
    }

    decrypt(encryptedText) {
        try {
            const [encrypted, authTag] = encryptedText.split(':');
            if (!authTag) return encryptedText;
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, this.encryptionIV);
            decipher.setAuthTag(Buffer.from(authTag, 'hex'));
            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) {
            console.error('Decryption error:', error);
            return encryptedText;
        }
    }

    // ============================================
    // اجرای کوئری با کش
    // ============================================
    async query(key, text, params = []) {
        const cacheKey = `${text}_${JSON.stringify(params)}`;
        const cmd = text.trim().slice(0, 6).toUpperCase();
        
        // بررسی کش برای SELECT
        if (cmd === 'SELECT') {
            const cached = this.cache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
                return cached.data;
            }
        }

        const sql = text.replace(/\$(\d+)/g, '?');
        
        try {
            const stmt = this.db.prepare(sql);
            let result;
            
            if (cmd === 'SELECT') {
                result = { rows: stmt.all(...params) };
                // ذخیره در کش
                this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
            } else {
                const info = stmt.run(...params);
                result = { 
                    rows: [], 
                    rowCount: info.changes, 
                    lastID: info.lastInsertRowid 
                };
                // پاک کردن کش برای تغییرات
                this.invalidateCache();
            }
            return result;
        } catch (error) {
            console.error('Database error:', error.message, '\nSQL:', sql);
            throw error;
        }
    }

    invalidateCache() {
        this.cache.clear();
    }

    // ============================================
    // ایجاد جداول
    // ============================================
    async initTables() {
        try {
            this.db.exec(`
                -- ==========================================
                -- جدول کاربران
                -- ==========================================
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    avatar TEXT,
                    bio TEXT,
                    score INTEGER DEFAULT 0,
                    role TEXT DEFAULT 'user',
                    is_verified INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- جدول کانال‌ها
                -- ==========================================
                CREATE TABLE IF NOT EXISTS channels (
                    id TEXT PRIMARY KEY,
                    user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    description TEXT,
                    posts_count INTEGER DEFAULT 0,
                    followers_count INTEGER DEFAULT 0,
                    boost_level TEXT DEFAULT 'normal',
                    activity_score INTEGER DEFAULT 0,
                    last_boost_calc TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- جدول پست‌ها با پشتیبانی از ویدیو
                -- ==========================================
                CREATE TABLE IF NOT EXISTS posts (
                    id TEXT PRIMARY KEY,
                    channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
                    content TEXT NOT NULL,
                    media_url TEXT,
                    media_type TEXT CHECK (media_type IN ('image', 'video', 'audio', 'none')),
                    views INTEGER DEFAULT 0,
                    likes INTEGER DEFAULT 0,
                    comments INTEGER DEFAULT 0,
                    scheduled_time TEXT,
                    is_published INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    published_at TEXT,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- جدول آموزش دستیار
                -- ==========================================
                CREATE TABLE IF NOT EXISTS assistant_training (
                    id TEXT PRIMARY KEY,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    type TEXT CHECK (type IN ('qa', 'keyword')),
                    question TEXT,
                    answer TEXT,
                    keyword TEXT,
                    response TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- جدول پیام‌های رمزنگاری شده
                -- ==========================================
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    from_user TEXT REFERENCES users(id) ON DELETE CASCADE,
                    to_user TEXT REFERENCES users(id) ON DELETE CASCADE,
                    message TEXT NOT NULL,
                    is_read INTEGER DEFAULT 0,
                    encrypted INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- جدول فالو
                -- ==========================================
                CREATE TABLE IF NOT EXISTS follows (
                    follower_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    following_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (follower_id, following_id)
                );

                -- ==========================================
                -- جدول لایک‌ها
                -- ==========================================
                CREATE TABLE IF NOT EXISTS post_likes (
                    post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (post_id, user_id)
                );

                -- ==========================================
                -- جدول کامنت‌ها
                -- ==========================================
                CREATE TABLE IF NOT EXISTS post_comments (
                    id TEXT PRIMARY KEY,
                    post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    text TEXT NOT NULL,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- جدول اعلان‌های سیستمی
                -- ==========================================
                CREATE TABLE IF NOT EXISTS system_notifications (
                    id TEXT PRIMARY KEY,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    type TEXT DEFAULT 'general',
                    is_read INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- جدول گزارش‌ها
                -- ==========================================
                CREATE TABLE IF NOT EXISTS reports (
                    id TEXT PRIMARY KEY,
                    reporter_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    target_id TEXT,
                    target_type TEXT CHECK (target_type IN ('user', 'post', 'comment')),
                    reason TEXT NOT NULL,
                    status TEXT DEFAULT 'pending',
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    resolved_at TEXT
                );

                -- ==========================================
                -- ایندکس‌ها برای بهبود سرعت
                -- ==========================================
                CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id);
                CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(is_published, scheduled_time);
                CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user, to_user);
                CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(to_user, is_read);
                CREATE INDEX IF NOT EXISTS idx_assistant_user ON assistant_training(user_id);
                CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id);
                CREATE INDEX IF NOT EXISTS idx_comments_created ON post_comments(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
                CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
                CREATE INDEX IF NOT EXISTS idx_notifications_user ON system_notifications(user_id, is_read);
                CREATE INDEX IF NOT EXISTS idx_notifications_created ON system_notifications(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
                CREATE INDEX IF NOT EXISTS idx_users_score ON users(score DESC);
                CREATE INDEX IF NOT EXISTS idx_channels_score ON channels(activity_score DESC);
            `);
            
            console.log('✅ All tables created/verified');

            // ==========================================
            // ایجاد کاربر ادمین
            // ==========================================
            const adminCheck = this.db.prepare(`SELECT id FROM users WHERE id = ?`).get(['admin_milad']);
            
            if (!adminCheck) {
                this.db.exec(`
                    INSERT INTO users (id, name, avatar, role, is_verified, score, created_at) 
                    VALUES ('admin_milad', 'مدیر سیستم', '/admin-avatar.png', 'admin', 1, 999999, CURRENT_TIMESTAMP);
                    
                    INSERT INTO channels (id, user_id, name, boost_level, created_at) 
                    VALUES ('channel_admin', 'admin_milad', 'کانال مدیریت', 'superstar', CURRENT_TIMESTAMP);
                `);
                console.log('✅ Admin user created');
            }

            // ==========================================
            // به‌روزرسانی ساختار دیتابیس
            // ==========================================
            // اضافه کردن ستون encrypted اگر وجود ندارد
            try {
                this.db.exec(`ALTER TABLE messages ADD COLUMN encrypted INTEGER DEFAULT 0`);
                console.log('✅ Added encrypted column to messages');
            } catch (e) {
                // ستون قبلاً وجود دارد
            }

            // اضافه کردن ستون bio اگر وجود ندارد
            try {
                this.db.exec(`ALTER TABLE users ADD COLUMN bio TEXT`);
                console.log('✅ Added bio column to users');
            } catch (e) {
                // ستون قبلاً وجود دارد
            }

        } catch (error) {
            console.error('Error creating tables:', error);
            throw error;
        }
    }

    // ============================================
    // متدهای کمکی
    // ============================================
    getDb() {
        return this.db;
    }

    clearCache() {
        this.cache.clear();
    }

    close() {
        this.db.close();
    }

    // ============================================
    // متدهای Transaction
    // ============================================
    transaction(fn) {
        return this.db.transaction(fn);
    }

    // ============================================
    // متدهای پشتیبان‌گیری
    // ============================================
    backup() {
        try {
            const backupPath = path.join(__dirname, `backup_${Date.now()}.sqlite`);
            const backup = new Database(backupPath);
            this.db.backup(backup);
            backup.close();
            return backupPath;
        } catch (error) {
            console.error('Backup error:', error);
            return null;
        }
    }

    // ============================================
    // متدهای پاکسازی
    // ============================================
    vacuum() {
        this.db.exec('VACUUM');
    }

    // ============================================
    // متدهای آماری
    // ============================================
    getStats() {
        const stats = {};
        
        try {
            const tables = this.db.prepare(`
                SELECT name FROM sqlite_master WHERE type='table'
            `).all();
            
            for (const table of tables) {
                const count = this.db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
                stats[table.name] = count.count;
            }
        } catch (error) {
            console.error('Stats error:', error);
        }
        
        return stats;
    }
}

module.exports = DatabaseManager;