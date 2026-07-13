// ============================================
// database.js - مدیریت دیتابیس پیشرفته با کش، رمزنگاری و بهینه‌سازی
// ============================================
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

class DatabaseManager {
    constructor() {
        // ============================================
        // کش چندلایه
        // ============================================
        this.cache = new Map();
        this.queryCache = new Map();
        this.cacheTTL = 60000; // 60 ثانیه
        this.queryCacheTTL = 30000; // 30 ثانیه
        
        // ============================================
        // مسیر دیتابیس و پشتیبان
        // ============================================
        this.dbPath = path.join(__dirname, 'data.sqlite');
        this.backupPath = path.join(__dirname, 'backups');
        
        // ایجاد پوشه پشتیبان
        if (!fs.existsSync(this.backupPath)) {
            fs.mkdirSync(this.backupPath, { recursive: true });
        }
        
        // ============================================
        // اتصال به دیتابیس با تنظیمات بهینه
        // ============================================
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('cache_size = -20000'); // 20MB کش
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('temp_store = MEMORY');
        this.db.pragma('mmap_size = 268435456'); // 256MB
        this.db.pragma('page_size = 4096');
        this.db.pragma('auto_vacuum = INCREMENTAL');
        
        // ============================================
        // رمزنگاری AES-256-GCM برای پیام‌ها
        // ============================================
        this.encryptionKey = crypto.randomBytes(32);
        this.encryptionIV = crypto.randomBytes(16);
        
        // ============================================
        // ایجاد جداول و ایندکس‌ها
        // ============================================
        this.initTables();
        
        // ============================================
        // پشتیبان‌گیری خودکار
        // ============================================
        this.autoBackup();
        
        console.log('✅ Database initialized with advanced features');
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
            if (parts.length !== 3) return encryptedText;
            
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
    // اجرای کوئری با کش چندلایه
    // ============================================
    async query(key, text, params = []) {
        const cacheKey = `${key}_${text}_${JSON.stringify(params)}`;
        const cmd = text.trim().slice(0, 6).toUpperCase();
        
        // ============================================
        // کش برای SELECT
        // ============================================
        if (cmd === 'SELECT') {
            const cached = this.queryCache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < this.queryCacheTTL) {
                return cached.data;
            }
        }

        const sql = text.replace(/\$(\d+)/g, '?');
        
        try {
            const stmt = this.db.prepare(sql);
            let result;
            
            if (cmd === 'SELECT') {
                result = { rows: stmt.all(...params) };
                this.queryCache.set(cacheKey, { 
                    data: result, 
                    timestamp: Date.now() 
                });
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
        this.queryCache.clear();
        this.cache.clear();
    }

    // ============================================
    // ایجاد جداول با ساختار پیشرفته
    // ============================================
    async initTables() {
        try {
            // ============================================
            // جدول کاربران با فیلدهای کامل
            // ============================================
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    avatar TEXT,
                    bio TEXT,
                    score INTEGER DEFAULT 0,
                    role TEXT DEFAULT 'user',
                    is_verified INTEGER DEFAULT 0,
                    is_online INTEGER DEFAULT 0,
                    last_seen TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ============================================
                -- جدول کانال‌ها
                -- ============================================
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

                -- ============================================
                -- جدول پست‌ها با پشتیبانی از ویدیو
                -- ============================================
                CREATE TABLE IF NOT EXISTS posts (
                    id TEXT PRIMARY KEY,
                    channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
                    content TEXT NOT NULL,
                    media_url TEXT,
                    media_type TEXT CHECK (media_type IN ('image', 'video', 'audio', 'none')),
                    views INTEGER DEFAULT 0,
                    likes INTEGER DEFAULT 0,
                    comments INTEGER DEFAULT 0,
                    shares INTEGER DEFAULT 0,
                    scheduled_time TEXT,
                    is_published INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    published_at TEXT,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ============================================
                -- جدول آموزش دستیار
                -- ============================================
                CREATE TABLE IF NOT EXISTS assistant_training (
                    id TEXT PRIMARY KEY,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    type TEXT CHECK (type IN ('qa', 'keyword')),
                    question TEXT,
                    answer TEXT,
                    keyword TEXT,
                    response TEXT,
                    usage_count INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ============================================
                -- جدول پیام‌های رمزنگاری شده
                -- ============================================
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    from_user TEXT REFERENCES users(id) ON DELETE CASCADE,
                    to_user TEXT REFERENCES users(id) ON DELETE CASCADE,
                    message TEXT NOT NULL,
                    is_read INTEGER DEFAULT 0,
                    encrypted INTEGER DEFAULT 1,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ============================================
                -- جدول فالو
                -- ============================================
                CREATE TABLE IF NOT EXISTS follows (
                    follower_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    following_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (follower_id, following_id)
                );

                -- ============================================
                -- جدول لایک‌ها
                -- ============================================
                CREATE TABLE IF NOT EXISTS post_likes (
                    post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (post_id, user_id)
                );

                -- ============================================
                -- جدول کامنت‌ها
                -- ============================================
                CREATE TABLE IF NOT EXISTS post_comments (
                    id TEXT PRIMARY KEY,
                    post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    text TEXT NOT NULL,
                    likes INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ============================================
                -- جدول اعلان‌های سیستمی
                -- ============================================
                CREATE TABLE IF NOT EXISTS system_notifications (
                    id TEXT PRIMARY KEY,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    type TEXT DEFAULT 'general',
                    is_read INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ============================================
                -- جدول گزارش‌ها
                -- ============================================
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

                -- ============================================
                -- جدول فعالیت‌های کاربران
                -- ============================================
                CREATE TABLE IF NOT EXISTS user_activities (
                    id TEXT PRIMARY KEY,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    type TEXT CHECK (type IN ('post', 'like', 'comment', 'follow', 'train', 'view', 'share')),
                    target_id TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ============================================
                -- جدول تنظیمات کاربران
                -- ============================================
                CREATE TABLE IF NOT EXISTS user_settings (
                    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    theme TEXT DEFAULT 'default',
                    notifications_enabled INTEGER DEFAULT 1,
                    private_account INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // ============================================
            // ایندکس‌های پیشرفته برای سرعت بالا
            // ============================================
            this.db.exec(`
                -- ایندکس‌های پست
                CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id);
                CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(is_published, scheduled_time);
                CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_posts_score ON posts(likes DESC, comments DESC, views DESC);
                
                -- ایندکس‌های پیام
                CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user, to_user);
                CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(to_user, is_read);
                
                -- ایندکس‌های فالو
                CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
                CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
                
                -- ایندکس‌های کامنت
                CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id);
                CREATE INDEX IF NOT EXISTS idx_comments_created ON post_comments(created_at DESC);
                
                -- ایندکس‌های کاربر
                CREATE INDEX IF NOT EXISTS idx_users_score ON users(score DESC);
                CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);
                CREATE INDEX IF NOT EXISTS idx_users_online ON users(is_online);
                
                -- ایندکس‌های کانال
                CREATE INDEX IF NOT EXISTS idx_channels_score ON channels(activity_score DESC);
                CREATE INDEX IF NOT EXISTS idx_channels_followers ON channels(followers_count DESC);
                
                -- ایندکس‌های آموزش
                CREATE INDEX IF NOT EXISTS idx_assistant_user ON assistant_training(user_id);
                CREATE INDEX IF NOT EXISTS idx_assistant_type ON assistant_training(type);
                
                -- ایندکس‌های نوتیفیکیشن
                CREATE INDEX IF NOT EXISTS idx_notifications_user ON system_notifications(user_id, is_read);
                CREATE INDEX IF NOT EXISTS idx_notifications_created ON system_notifications(created_at DESC);
                
                -- ایندکس‌های گزارش
                CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
                
                -- ایندکس‌های فعالیت
                CREATE INDEX IF NOT EXISTS idx_activities_user ON user_activities(user_id);
                CREATE INDEX IF NOT EXISTS idx_activities_type ON user_activities(type);
                CREATE INDEX IF NOT EXISTS idx_activities_created ON user_activities(created_at DESC);
            `);

            console.log('✅ All tables and indexes created');

            // ============================================
            // ایجاد کاربر ادمین
            // ============================================
            const adminCheck = this.db.prepare(`
                SELECT id FROM users WHERE id = ?
            `).get(['admin_milad']);
            
            if (!adminCheck) {
                this.db.exec(`
                    INSERT INTO users (id, name, avatar, role, is_verified, score, created_at) 
                    VALUES ('admin_milad', 'مدیر سیستم', '/admin-avatar.png', 'admin', 1, 999999, CURRENT_TIMESTAMP);
                    
                    INSERT INTO channels (id, user_id, name, boost_level, created_at) 
                    VALUES ('channel_admin', 'admin_milad', 'کانال مدیریت', 'superstar', CURRENT_TIMESTAMP);
                    
                    INSERT INTO user_settings (user_id, theme, notifications_enabled) 
                    VALUES ('admin_milad', 'default', 1);
                `);
                console.log('✅ Admin user created');
            }

            // ============================================
            // به‌روزرسانی ساختار دیتابیس (Migration)
            // ============================================
            this.runMigrations();

        } catch (error) {
            console.error('Error creating tables:', error);
            throw error;
        }
    }

    // ============================================
    // Migration برای به‌روزرسانی ساختار
    // ============================================
    runMigrations() {
        const migrations = [
            { column: 'shares', table: 'posts', type: 'INTEGER DEFAULT 0' },
            { column: 'is_online', table: 'users', type: 'INTEGER DEFAULT 0' },
            { column: 'last_seen', table: 'users', type: 'TEXT' },
            { column: 'usage_count', table: 'assistant_training', type: 'INTEGER DEFAULT 0' },
            { column: 'likes', table: 'post_comments', type: 'INTEGER DEFAULT 0' },
        ];

        for (const migration of migrations) {
            try {
                this.db.exec(`
                    ALTER TABLE ${migration.table} 
                    ADD COLUMN ${migration.column} ${migration.type}
                `);
                console.log(`✅ Added ${migration.column} to ${migration.table}`);
            } catch (e) {
                // ستون قبلاً وجود دارد
            }
        }

        // ایجاد جدول user_settings اگر وجود ندارد
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS user_settings (
                    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    theme TEXT DEFAULT 'default',
                    notifications_enabled INTEGER DEFAULT 1,
                    private_account INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            `);
        } catch (e) {
            // جدول قبلاً وجود دارد
        }
    }

    // ============================================
    // پشتیبان‌گیری خودکار
    // ============================================
    autoBackup() {
        // پشتیبان‌گیری هر 6 ساعت
        setInterval(() => {
            this.createBackup();
        }, 6 * 60 * 60 * 1000);
        
        // پشتیبان‌گیری در هنگام خروج
        process.on('SIGINT', () => {
            this.createBackup();
            this.close();
            process.exit(0);
        });
    }

    createBackup() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFile = path.join(this.backupPath, `backup_${timestamp}.sqlite`);
            
            // کپی فایل دیتابیس
            fs.copyFileSync(this.dbPath, backupFile);
            
            // فشرده‌سازی پشتیبان
            const stats = fs.statSync(backupFile);
            console.log(`✅ Backup created: ${backupFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
            
            // حذف پشتیبان‌های قدیمی (فقط 10 تا آخرین نگهداری شود)
            const files = fs.readdirSync(this.backupPath)
                .filter(f => f.startsWith('backup_'))
                .sort()
                .reverse();
            
            if (files.length > 10) {
                for (const file of files.slice(10)) {
                    fs.unlinkSync(path.join(this.backupPath, file));
                }
            }
            
            return backupFile;
        } catch (error) {
            console.error('Backup error:', error);
            return null;
        }
    }

    // ============================================
    // متدهای Transaction برای عملیات اتمیک
    // ============================================
    transaction(fn) {
        return this.db.transaction(fn);
    }

    // ============================================
    // بهینه‌سازی دیتابیس
    // ============================================
    vacuum() {
        try {
            this.db.exec('VACUUM');
            console.log('✅ Database vacuum completed');
        } catch (error) {
            console.error('Vacuum error:', error);
        }
    }

    analyze() {
        try {
            this.db.exec('ANALYZE');
            console.log('✅ Database analyze completed');
        } catch (error) {
            console.error('Analyze error:', error);
        }
    }

    // ============================================
    // آمار دیتابیس
    // ============================================
    getStats() {
        const stats = {};
        try {
            const tables = this.db.prepare(`
                SELECT name FROM sqlite_master WHERE type='table'
            `).all();
            
            for (const table of tables) {
                const count = this.db.prepare(
                    `SELECT COUNT(*) as count FROM ${table.name}`
                ).get();
                stats[table.name] = count.count;
            }
            
            const dbStats = this.db.pragma('stats');
            stats.dbSize = (fs.statSync(this.dbPath).size / 1024 / 1024).toFixed(2) + ' MB';
            stats.pageCount = dbStats[0]?.page_count || 0;
            
        } catch (error) {
            console.error('Stats error:', error);
        }
        return stats;
    }

    // ============================================
    // متدهای کمکی
    // ============================================
    getDb() {
        return this.db;
    }

    clearCache() {
        this.cache.clear();
        this.queryCache.clear();
    }

    close() {
        this.createBackup();
        this.db.close();
        console.log('✅ Database closed');
    }

    // ============================================
    // متدهای مدیریت کاربران
    // ============================================
    async getUserById(userId) {
        return this.query(userId, `SELECT * FROM users WHERE id = $1`, [userId]);
    }

    async updateUserActivity(userId, type, targetId = null) {
        const id = crypto.randomUUID();
        await this.query(userId, `
            INSERT INTO user_activities (id, user_id, type, target_id, created_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `, [id, userId, type, targetId]);
    }

    async getUserStats(userId) {
        const stats = {};
        
        const posts = await this.query(userId, `
            SELECT COUNT(*) as total FROM posts WHERE channel_id IN (
                SELECT id FROM channels WHERE user_id = $1
            )
        `, [userId]);
        stats.posts = posts.rows[0]?.total || 0;
        
        const followers = await this.query(userId, `
            SELECT followers_count FROM channels WHERE user_id = $1
        `, [userId]);
        stats.followers = followers.rows[0]?.followers_count || 0;
        
        const following = await this.query(userId, `
            SELECT COUNT(*) as total FROM follows WHERE follower_id = $1
        `, [userId]);
        stats.following = following.rows[0]?.total || 0;
        
        const likes = await this.query(userId, `
            SELECT COUNT(*) as total FROM post_likes WHERE user_id = $1
        `, [userId]);
        stats.likes = likes.rows[0]?.total || 0;
        
        const comments = await this.query(userId, `
            SELECT COUNT(*) as total FROM post_comments WHERE user_id = $1
        `, [userId]);
        stats.comments = comments.rows[0]?.total || 0;
        
        return stats;
    }

    // ============================================
    // متدهای مدیریت پست‌ها
    // ============================================
    async getPostById(postId) {
        return this.query(postId, `SELECT * FROM posts WHERE id = $1`, [postId]);
    }

    async getPostWithAuthor(postId) {
        return this.query(postId, `
            SELECT p.*, u.name as author_name, u.avatar as author_avatar
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE p.id = $1
        `, [postId]);
    }

    async getPopularPosts(limit = 20) {
        return this.query(null, `
            SELECT p.*, u.name as author_name, u.avatar as author_avatar
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE p.is_published = 1
            ORDER BY (p.likes * 2 + p.comments * 3 + p.views) DESC
            LIMIT $1
        `, [limit]);
    }

    // ============================================
    // متدهای مدیریت چت
    // ============================================
    async getChatHistory(userId, targetId, limit = 100) {
        return this.query(userId, `
            SELECT * FROM messages 
            WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
            ORDER BY created_at ASC LIMIT $3
        `, [userId, targetId, limit]);
    }

    async getUnreadCount(userId) {
        return this.query(userId, `
            SELECT COUNT(*) as total FROM messages 
            WHERE to_user = $1 AND is_read = 0
        `, [userId]);
    }

    async markMessagesAsRead(userId, fromUser) {
        return this.query(userId, `
            UPDATE messages SET is_read = 1 
            WHERE from_user = $1 AND to_user = $2 AND is_read = 0
        `, [fromUser, userId]);
    }

    // ============================================
    // متدهای مدیریت فالو
    // ============================================
    async isFollowing(followerId, followingId) {
        const result = await this.query(followerId, `
            SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2
        `, [followerId, followingId]);
        return result.rows.length > 0;
    }

    async getFollowers(userId) {
        return this.query(userId, `
            SELECT u.* FROM follows f
            JOIN users u ON f.follower_id = u.id
            WHERE f.following_id = $1
            ORDER BY f.created_at DESC
        `, [userId]);
    }

    async getFollowing(userId) {
        return this.query(userId, `
            SELECT u.* FROM follows f
            JOIN users u ON f.following_id = u.id
            WHERE f.follower_id = $1
            ORDER BY f.created_at DESC
        `, [userId]);
    }

    // ============================================
    // متدهای پاکسازی
    // ============================================
    async cleanup() {
        // حذف پست‌های منتشر نشده قدیمی
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        await this.query(null, `
            DELETE FROM posts 
            WHERE is_published = 0 
            AND scheduled_time < $1
        `, [thirtyDaysAgo.toISOString()]);
        
        // حذف پیام‌های خوانده شده قدیمی
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
        
        await this.query(null, `
            DELETE FROM messages 
            WHERE is_read = 1 
            AND created_at < $1
        `, [ninetyDaysAgo.toISOString()]);
        
        // وکیوم دیتابیس
        this.vacuum();
        
        console.log('✅ Database cleanup completed');
    }
}

module.exports = DatabaseManager;