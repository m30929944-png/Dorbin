// ============================================
// database.js - مدیریت دیتابیس پیشرفته با کش، رمزنگاری و بهینه‌سازی
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
        this.db.pragma('mmap_size = 268435456'); // 256MB برای سرعت بیشتر
        
        // رمزنگاری کلید برای چت
        this.encryptionKey = crypto.randomBytes(32);
        this.encryptionIV = crypto.randomBytes(16);
        
        // ایجاد جداول
        this.initTables();
        
        // پاکسازی دوره‌ای
        setInterval(() => this.cleanup(), 86400000); // هر روز
        setInterval(() => this.vacuum(), 604800000); // هر هفته
    }

    // ============================================
    // رمزنگاری و رمزگشایی پیشرفته
    // ============================================
    encrypt(text) {
        try {
            if (!text) return text;
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag().toString('hex');
            return `${iv.toString('hex')}:${encrypted}:${authTag}`;
        } catch (error) {
            console.error('Encryption error:', error);
            return text;
        }
    }

    decrypt(encryptedText) {
        try {
            if (!encryptedText) return encryptedText;
            const parts = encryptedText.split(':');
            if (parts.length < 3) return encryptedText;
            
            const iv = Buffer.from(parts[0], 'hex');
            const encrypted = parts[1];
            const authTag = parts[2];
            
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
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
    // هش کردن رمز عبور
    // ============================================
    hashPassword(password) {
        return crypto.createHash('sha256').update(password).digest('hex');
    }

    // ============================================
    // اجرای کوئری با کش
    // ============================================
    async query(userId, text, params = []) {
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
                    email TEXT UNIQUE,
                    password TEXT,
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
                -- جدول کاربران مسدود شده موقت
                -- ==========================================
                CREATE TABLE IF NOT EXISTS blocked_users (
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    blocked_by TEXT REFERENCES users(id) ON DELETE CASCADE,
                    reason TEXT,
                    expires_at TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, blocked_by)
                );

                -- ==========================================
                -- جدول فعالیت‌ها (برای آنالیز)
                -- ==========================================
                CREATE TABLE IF NOT EXISTS user_activities (
                    id TEXT PRIMARY KEY,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    type TEXT CHECK (type IN ('post', 'like', 'comment', 'follow', 'view', 'share')),
                    target_id TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- جدول تنظیمات سیستم
                -- ==========================================
                CREATE TABLE IF NOT EXISTS system_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
                CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
                CREATE INDEX IF NOT EXISTS idx_activities_user ON user_activities(user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_blocked_expires ON blocked_users(expires_at);
            `);
            
            console.log('✅ All tables created/verified');

            // ==========================================
            // ایجاد کاربر ادمین
            // ==========================================
            const adminCheck = this.db.prepare(`SELECT id FROM users WHERE id = ?`).get(['admin_milad']);
            
            if (!adminCheck) {
                const hashedPass = this.hashPassword('(mortza)#1377[@nik]=admin<');
                this.db.exec(`
                    INSERT INTO users (id, name, email, password, avatar, role, is_verified, score, created_at) 
                    VALUES ('admin_milad', 'مدیر سیستم', 'milad.yari1377m@gmail.com', '${hashedPass}', '/admin-avatar.png', 'admin', 1, 999999, CURRENT_TIMESTAMP);
                    
                    INSERT INTO channels (id, user_id, name, boost_level, created_at) 
                    VALUES ('channel_admin', 'admin_milad', 'کانال مدیریت', 'superstar', CURRENT_TIMESTAMP);
                `);
                console.log('✅ Admin user created');
            }

            // ==========================================
            // به‌روزرسانی ساختار دیتابیس (Migration)
            // ==========================================
            this.runMigrations();

        } catch (error) {
            console.error('Error creating tables:', error);
            throw error;
        }
    }

    // ============================================
    // مهاجرت‌های دیتابیس
    // ============================================
    runMigrations() {
        const migrations = [
            { column: 'email', table: 'users', type: 'TEXT UNIQUE' },
            { column: 'password', table: 'users', type: 'TEXT' },
            { column: 'bio', table: 'users', type: 'TEXT' },
            { column: 'encrypted', table: 'messages', type: 'INTEGER DEFAULT 0' },
        ];

        for (const mig of migrations) {
            try {
                this.db.exec(`ALTER TABLE ${mig.table} ADD COLUMN ${mig.column} ${mig.type}`);
                console.log(`✅ Added ${mig.column} to ${mig.table}`);
            } catch (e) {
                // ستون قبلاً وجود دارد
            }
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
            
            // حذف پشتیبان‌های قدیمی (فقط ۵ عدد آخر)
            const backups = fs.readdirSync(__dirname)
                .filter(f => f.startsWith('backup_') && f.endsWith('.sqlite'))
                .sort()
                .reverse();
            
            for (const file of backups.slice(5)) {
                fs.unlinkSync(path.join(__dirname, file));
            }
            
            return backupPath;
        } catch (error) {
            console.error('Backup error:', error);
            return null;
        }
    }

    // ============================================
    // پاکسازی دیتابیس
    // ============================================
    cleanup() {
        try {
            // حذف پیام‌های قدیمی (بیش از ۳ ماه)
            this.db.prepare(`
                DELETE FROM messages WHERE created_at < datetime('now', '-3 months')
            `).run();
            
            // حذف نوتیفیکیشن‌های قدیمی (بیش از ۱ ماه)
            this.db.prepare(`
                DELETE FROM system_notifications WHERE created_at < datetime('now', '-1 months')
            `).run();
            
            // حذف گزارش‌های حل شده قدیمی (بیش از ۱ ماه)
            this.db.prepare(`
                DELETE FROM reports WHERE status = 'resolved' AND created_at < datetime('now', '-1 months')
            `).run();
            
            // حذف مسدودیت‌های منقضی شده
            this.db.prepare(`
                DELETE FROM blocked_users WHERE expires_at < datetime('now')
            `).run();
            
            // حذف فعالیت‌های قدیمی (بیش از ۶ ماه)
            this.db.prepare(`
                DELETE FROM user_activities WHERE created_at < datetime('now', '-6 months')
            `).run();
            
            console.log('🧹 Database cleanup completed');
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }

    // ============================================
    // Vacuum دیتابیس
    // ============================================
    vacuum() {
        try {
            this.db.exec('VACUUM');
            console.log('✅ Database vacuum completed');
        } catch (error) {
            console.error('Vacuum error:', error);
        }
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
            
            // افزودن اطلاعات حجم
            const size = fs.statSync(this.dbPath).size;
            stats.totalSize = size;
            stats.totalSizeMB = (size / 1024 / 1024).toFixed(2);
            
        } catch (error) {
            console.error('Stats error:', error);
        }
        
        return stats;
    }

    // ============================================
    // ثبت فعالیت کاربر
    // ============================================
    logActivity(userId, type, targetId = null) {
        try {
            const id = crypto.randomUUID();
            this.db.prepare(`
                INSERT INTO user_activities (id, user_id, type, target_id, created_at) 
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(id, userId, type, targetId);
        } catch (error) {
            console.error('Log activity error:', error);
        }
    }

    // ============================================
    // دریافت فعالیت‌های کاربر
    // ============================================
    getUserActivities(userId, limit = 50) {
        try {
            return this.db.prepare(`
                SELECT * FROM user_activities 
                WHERE user_id = ? 
                ORDER BY created_at DESC LIMIT ?
            `).all(userId, limit);
        } catch (error) {
            console.error('Get activities error:', error);
            return [];
        }
    }

    // ============================================
    // دریافت تنظیمات سیستم
    // ============================================
    getSetting(key, defaultValue = null) {
        try {
            const result = this.db.prepare(`
                SELECT value FROM system_settings WHERE key = ?
            `).get(key);
            return result ? result.value : defaultValue;
        } catch (error) {
            console.error('Get setting error:', error);
            return defaultValue;
        }
    }

    // ============================================
    // تنظیم تنظیمات سیستم
    // ============================================
    setSetting(key, value) {
        try {
            this.db.prepare(`
                INSERT OR REPLACE INTO system_settings (key, value, updated_at) 
                VALUES (?, ?, CURRENT_TIMESTAMP)
            `).run(key, value);
            return true;
        } catch (error) {
            console.error('Set setting error:', error);
            return false;
        }
    }

    // ============================================
    // بررسی وضعیت کاربر (مسدود/تایید شده)
    // ============================================
    getUserStatus(userId) {
        try {
            const user = this.db.prepare(`
                SELECT id, role, is_verified FROM users WHERE id = ?
            `).get(userId);
            
            if (!user) return null;
            
            const blocked = this.db.prepare(`
                SELECT 1 FROM blocked_users 
                WHERE user_id = ? AND expires_at > datetime('now')
            `).get(userId);
            
            return {
                ...user,
                isBlocked: !!blocked,
                isAdmin: user.role === 'admin',
                isBanned: user.role === 'banned'
            };
        } catch (error) {
            console.error('Get user status error:', error);
            return null;
        }
    }

    // ============================================
    // دریافت آمار کانال
    // ============================================
    getChannelStats(userId) {
        try {
            return this.db.prepare(`
                SELECT 
                    c.*,
                    (SELECT COUNT(*) FROM posts WHERE channel_id = c.id AND is_published = 1) as total_posts,
                    (SELECT COUNT(*) FROM post_likes WHERE post_id IN (SELECT id FROM posts WHERE channel_id = c.id)) as total_likes,
                    (SELECT COUNT(*) FROM post_comments WHERE post_id IN (SELECT id FROM posts WHERE channel_id = c.id)) as total_comments,
                    (SELECT COUNT(*) FROM follows WHERE following_id = c.user_id) as total_followers
                FROM channels c
                WHERE c.user_id = ?
            `).get(userId);
        } catch (error) {
            console.error('Get channel stats error:', error);
            return null;
        }
    }

    // ============================================
    // جستجوی پیشرفته
    // ============================================
    advancedSearch(query, type = 'all', limit = 20) {
        try {
            const searchQuery = `%${query}%`;
            let results = [];
            
            if (type === 'all' || type === 'users') {
                const users = this.db.prepare(`
                    SELECT id, name, avatar, 'user' as type, is_verified, score
                    FROM users 
                    WHERE name LIKE ? AND role != 'admin' AND role != 'banned'
                    ORDER BY score DESC
                    LIMIT ?
                `).all(searchQuery, limit);
                results = results.concat(users);
            }
            
            if (type === 'all' || type === 'posts') {
                const posts = this.db.prepare(`
                    SELECT p.id, p.content, p.created_at, 'post' as type,
                           u.name as user_name, u.avatar as user_avatar,
                           c.name as channel_name
                    FROM posts p
                    JOIN channels c ON p.channel_id = c.id
                    JOIN users u ON c.user_id = u.id
                    WHERE p.content LIKE ? AND p.is_published = 1
                    ORDER BY p.created_at DESC
                    LIMIT ?
                `).all(searchQuery, limit);
                results = results.concat(posts);
            }
            
            if (type === 'all' || type === 'channels') {
                const channels = this.db.prepare(`
                    SELECT c.id, c.name, 'channel' as type, c.followers_count, c.boost_level,
                           u.name as user_name, u.avatar as user_avatar
                    FROM channels c
                    JOIN users u ON c.user_id = u.id
                    WHERE c.name LIKE ?
                    ORDER BY c.followers_count DESC
                    LIMIT ?
                `).all(searchQuery, limit);
                results = results.concat(channels);
            }
            
            return results;
        } catch (error) {
            console.error('Advanced search error:', error);
            return [];
        }
    }

    // ============================================
    // دریافت پست‌های پرطرفدار
    // ============================================
    getTrendingPosts(limit = 20) {
        try {
            return this.db.prepare(`
                SELECT 
                    p.*,
                    u.name as user_name,
                    u.avatar as user_avatar,
                    (p.likes + p.comments * 2 + p.views * 0.1) as engagement_score
                FROM posts p
                JOIN channels c ON p.channel_id = c.id
                JOIN users u ON c.user_id = u.id
                WHERE p.is_published = 1
                AND p.created_at > datetime('now', '-7 days')
                ORDER BY engagement_score DESC, p.created_at DESC
                LIMIT ?
            `).all(limit);
        } catch (error) {
            console.error('Get trending posts error:', error);
            return [];
        }
    }

    // ============================================
    // دریافت کاربران برتر
    // ============================================
    getTopUsers(limit = 20) {
        try {
            return this.db.prepare(`
                SELECT 
                    u.id, u.name, u.avatar, u.score, u.is_verified,
                    c.followers_count, c.posts_count, c.boost_level,
                    (u.score + c.followers_count * 2 + c.posts_count * 3) as total_score
                FROM users u
                JOIN channels c ON u.id = c.user_id
                WHERE u.role != 'admin' AND u.role != 'banned'
                ORDER BY total_score DESC
                LIMIT ?
            `).all(limit);
        } catch (error) {
            console.error('Get top users error:', error);
            return [];
        }
    }

    // ============================================
    // دریافت نوتیفیکیشن‌های کاربر
    // ============================================
    getUserNotifications(userId, limit = 50) {
        try {
            return this.db.prepare(`
                SELECT * FROM system_notifications 
                WHERE user_id = ? 
                ORDER BY created_at DESC 
                LIMIT ?
            `).all(userId, limit);
        } catch (error) {
            console.error('Get notifications error:', error);
            return [];
        }
    }

    // ============================================
    // علامت‌گذاری نوتیفیکیشن به عنوان خوانده شده
    // ============================================
    markNotificationRead(notificationId) {
        try {
            this.db.prepare(`
                UPDATE system_notifications SET is_read = 1 
                WHERE id = ?
            `).run(notificationId);
            return true;
        } catch (error) {
            console.error('Mark notification read error:', error);
            return false;
        }
    }

    // ============================================
    // دریافت آمار تعاملات
    // ============================================
    getEngagementStats(userId) {
        try {
            const stats = this.db.prepare(`
                SELECT 
                    (SELECT COUNT(*) FROM posts WHERE channel_id IN (SELECT id FROM channels WHERE user_id = ?) AND is_published = 1) as total_posts,
                    (SELECT COUNT(*) FROM post_likes WHERE post_id IN (SELECT id FROM posts WHERE channel_id IN (SELECT id FROM channels WHERE user_id = ?))) as total_likes,
                    (SELECT COUNT(*) FROM post_comments WHERE post_id IN (SELECT id FROM posts WHERE channel_id IN (SELECT id FROM channels WHERE user_id = ?))) as total_comments,
                    (SELECT COUNT(*) FROM follows WHERE following_id = ?) as total_followers
            `).get(userId, userId, userId, userId);
            
            const totalEngagement = (stats.total_likes || 0) + (stats.total_comments || 0) * 2;
            const engagementRate = stats.total_posts > 0 ? 
                (totalEngagement / stats.total_posts).toFixed(2) : 0;
            
            return {
                ...stats,
                totalEngagement,
                engagementRate: parseFloat(engagementRate)
            };
        } catch (error) {
            console.error('Get engagement stats error:', error);
            return null;
        }
    }

    // ============================================
    // پشتیبانی از Full-Text Search
    // ============================================
    enableFullTextSearch() {
        try {
            // ایجاد جدول FTS برای جستجوی سریع
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
                    content,
                    content=posts,
                    content_rowid=rowid
                );
                
                INSERT OR REPLACE INTO posts_fts(rowid, content)
                SELECT rowid, content FROM posts WHERE is_published = 1;
            `);
            
            // تریگر برای به‌روزرسانی خودکار
            this.db.exec(`
                CREATE TRIGGER IF NOT EXISTS posts_fts_insert AFTER INSERT ON posts
                BEGIN
                    INSERT INTO posts_fts(rowid, content) VALUES (new.rowid, new.content);
                END;
                
                CREATE TRIGGER IF NOT EXISTS posts_fts_update AFTER UPDATE ON posts
                BEGIN
                    UPDATE posts_fts SET content = new.content WHERE rowid = new.rowid;
                END;
                
                CREATE TRIGGER IF NOT EXISTS posts_fts_delete AFTER DELETE ON posts
                BEGIN
                    DELETE FROM posts_fts WHERE rowid = old.rowid;
                END;
            `);
            
            console.log('✅ Full-Text Search enabled');
        } catch (error) {
            console.error('FTS error:', error);
        }
    }
}

module.exports = DatabaseManager;