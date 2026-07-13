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
        
        this.dbPath = path.join(__dirname, 'data.sqlite');
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('cache_size = 10000');
        this.db.pragma('synchronous = NORMAL');
        
        // رمزنگاری کلید برای چت
        this.encryptionKey = crypto.randomBytes(32);
        this.encryptionIV = crypto.randomBytes(16);
        
        this.initTables();
    }

    // رمزنگاری پیام
    encrypt(text) {
        const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, this.encryptionIV);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return `${encrypted}:${authTag}`;
    }

    // رمزگشایی پیام
    decrypt(encryptedText) {
        try {
            const [encrypted, authTag] = encryptedText.split(':');
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, this.encryptionIV);
            decipher.setAuthTag(Buffer.from(authTag, 'hex'));
            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch {
            return encryptedText;
        }
    }

    // اجرای کوئری با کش
    async query(key, text, params = []) {
        const cacheKey = `${text}_${JSON.stringify(params)}`;
        
        // بررسی کش برای SELECT
        if (text.trim().slice(0, 6).toUpperCase() === 'SELECT') {
            const cached = this.cache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
                return cached.data;
            }
        }

        const sql = text.replace(/\$(\d+)/g, '?');
        const cmd = text.trim().slice(0, 6).toUpperCase();
        
        try {
            const stmt = this.db.prepare(sql);
            let result;
            
            if (cmd === 'SELECT') {
                result = { rows: stmt.all(...params) };
                // ذخیره در کش
                this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
            } else {
                const info = stmt.run(...params);
                result = { rows: [], rowCount: info.changes, lastID: info.lastInsertRowid };
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

    // ایجاد جدول‌های پیشرفته
    async initTables() {
        this.db.exec(`
            -- جدول کاربران
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

            -- جدول کانال‌ها
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

            -- جدول پست‌ها با پشتیبانی از ویدیو
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

            -- جدول آموزش دستیار
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

            -- جدول پیام‌های رمزنگاری شده
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                from_user TEXT REFERENCES users(id) ON DELETE CASCADE,
                to_user TEXT REFERENCES users(id) ON DELETE CASCADE,
                message TEXT NOT NULL,
                is_read INTEGER DEFAULT 0,
                encrypted INTEGER DEFAULT 1,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            -- جدول فالو
            CREATE TABLE IF NOT EXISTS follows (
                follower_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                following_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (follower_id, following_id)
            );

            -- جدول لایک‌ها
            CREATE TABLE IF NOT EXISTS post_likes (
                post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (post_id, user_id)
            );

            -- جدول کامنت‌ها
            CREATE TABLE IF NOT EXISTS post_comments (
                id TEXT PRIMARY KEY,
                post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                text TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            -- جدول اعلان‌های سیستمی
            CREATE TABLE IF NOT EXISTS system_notifications (
                id TEXT PRIMARY KEY,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                type TEXT DEFAULT 'general',
                is_read INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            -- جدول گزارش‌ها
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

            -- ایندکس‌ها
            CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id);
            CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(is_published, scheduled_time);
            CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user, to_user);
            CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
            CREATE INDEX IF NOT EXISTS idx_assistant_user ON assistant_training(user_id);
            CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id);
            CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
            CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
            CREATE INDEX IF NOT EXISTS idx_notifications_user ON system_notifications(user_id, is_read);
            CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
        `);

        // ایجاد کاربر ادمین
        const adminCheck = this.db.prepare(`SELECT id FROM users WHERE id = $1`).get(['admin_milad']);
        if (!adminCheck) {
            this.db.exec(`
                INSERT INTO users (id, name, avatar, role, is_verified, score) 
                VALUES ('admin_milad', 'مدیر سیستم', '/admin-avatar.png', 'admin', 1, 999999);
                INSERT INTO channels (id, user_id, name, boost_level) 
                VALUES ('channel_admin', 'admin_milad', 'کانال مدیریت', 'superstar');
            `);
            console.log('✅ Admin user created');
        }

        console.log('✅ All tables created/verified');
    }

    // متدهای کمکی
    getDb() {
        return this.db;
    }

    clearCache() {
        this.cache.clear();
    }
}

module.exports = DatabaseManager;