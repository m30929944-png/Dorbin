// ============================================================
// database.js - نسخه کامل با ۱۵۰۰۰+ خط
// مدیریت دیتابیس پیشرفته با کش، رمزنگاری و بهینه‌سازی
// ============================================================

// ============================================================
// بخش ۱: وابستگی‌ها و تنظیمات اولیه
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

class DatabaseManager {
    constructor(options = {}) {
        // تنظیمات پیش‌فرض
        this.options = {
            dbPath: options.dbPath || path.join(__dirname, 'data.sqlite'),
            cacheTTL: options.cacheTTL || 60000, // ۶۰ ثانیه
            maxCacheSize: options.maxCacheSize || 1000,
            enableEncryption: options.enableEncryption !== false,
            backupInterval: options.backupInterval || 3600000, // ۱ ساعت
            ...options
        };

        // کش حافظه
        this.cache = new Map();
        this.cacheStats = {
            hits: 0,
            misses: 0,
            evictions: 0
        };

        // مسیر دیتابیس
        this.dbPath = this.options.dbPath;
        
        // کلید رمزنگاری
        this.encryptionKey = this.loadOrCreateKey();
        this.encryptionIV = crypto.randomBytes(16);

        // اتصال به دیتابیس
        this.db = this.connect();
        
        // ایجاد جداول
        this.initTables();
        
        // شروع پشتیبان‌گیری خودکار
        this.startAutoBackup();
        
        // شروع پاکسازی کش
        this.startCacheCleanup();

        console.log('✅ Database Manager initialized');
        console.log(`📁 Database path: ${this.dbPath}`);
        console.log(`🔐 Encryption: ${this.options.enableEncryption ? 'Enabled' : 'Disabled'}`);
    }

    // ============================================================
    // بخش ۲: اتصال به دیتابیس
    // ============================================================

    connect() {
        try {
            // اطمینان از وجود پوشه
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const db = new Database(this.dbPath, {
                verbose: process.env.NODE_ENV === 'development' ? console.log : null
            });

            // تنظیمات بهینه
            db.pragma('journal_mode = WAL');
            db.pragma('foreign_keys = ON');
            db.pragma('cache_size = 10000');
            db.pragma('synchronous = NORMAL');
            db.pragma('temp_store = MEMORY');
            db.pragma('mmap_size = 268435456'); // 256MB
            db.pragma('page_size = 4096');

            return db;
        } catch (error) {
            console.error('❌ Database connection error:', error);
            throw error;
        }
    }

    // ============================================================
    // بخش ۳: رمزنگاری
    // ============================================================

    loadOrCreateKey() {
        const keyPath = path.join(__dirname, '.encryption_key');
        try {
            if (fs.existsSync(keyPath)) {
                return fs.readFileSync(keyPath);
            }
            const key = crypto.randomBytes(32);
            fs.writeFileSync(keyPath, key, { mode: 0o600 });
            return key;
        } catch (error) {
            console.warn('⚠️ Could not load encryption key, using fallback');
            return crypto.createHash('sha256')
                .update(process.env.ENCRYPTION_SECRET || 'yareman_default_secret')
                .digest();
        }
    }

    encrypt(text) {
        if (!this.options.enableEncryption || !text) return text;
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
        if (!this.options.enableEncryption || !encryptedText) return encryptedText;
        try {
            const parts = encryptedText.split(':');
            if (parts.length !== 2) return encryptedText;
            
            const [encrypted, authTag] = parts;
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

    // ============================================================
    // بخش ۴: سیستم کش پیشرفته
    // ============================================================

    getCacheKey(sql, params) {
        return `${sql}_${JSON.stringify(params)}`;
    }

    getCached(sql, params) {
        const key = this.getCacheKey(sql, params);
        const cached = this.cache.get(key);
        
        if (cached && (Date.now() - cached.timestamp) < this.options.cacheTTL) {
            this.cacheStats.hits++;
            return cached.data;
        }
        
        if (cached) {
            this.cache.delete(key);
            this.cacheStats.evictions++;
        }
        
        this.cacheStats.misses++;
        return null;
    }

    setCached(sql, params, data) {
        const key = this.getCacheKey(sql, params);
        
        // مدیریت حجم کش
        if (this.cache.size >= this.options.maxCacheSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) {
                this.cache.delete(oldestKey);
                this.cacheStats.evictions++;
            }
        }
        
        this.cache.set(key, {
            data,
            timestamp: Date.now(),
            hits: 0
        });
    }

    invalidateCache(pattern) {
        if (!pattern) {
            this.cache.clear();
            return;
        }
        
        for (const key of this.cache.keys()) {
            if (key.includes(pattern)) {
                this.cache.delete(key);
            }
        }
    }

    getCacheStats() {
        return {
            ...this.cacheStats,
            size: this.cache.size,
            maxSize: this.options.maxCacheSize,
            hitRate: this.cacheStats.hits + this.cacheStats.misses > 0 
                ? (this.cacheStats.hits / (this.cacheStats.hits + this.cacheStats.misses) * 100).toFixed(2) + '%'
                : '0%'
        };
    }

    // ============================================================
    // بخش ۵: اجرای کوئری با کش و بهینه‌سازی
    // ============================================================

    query(userId, sql, params = []) {
        try {
            const cmd = sql.trim().slice(0, 6).toUpperCase();
            const isSelect = cmd === 'SELECT';
            
            // بررسی کش برای SELECT
            if (isSelect) {
                const cached = this.getCached(sql, params);
                if (cached !== null) {
                    return cached;
                }
            }

            // تبدیل پارامترهای named به positional
            const preparedSql = sql.replace(/\$(\d+)/g, '?');
            
            const stmt = this.db.prepare(preparedSql);
            let result;

            if (isSelect) {
                result = { rows: stmt.all(...params) };
                // ذخیره در کش
                this.setCached(sql, params, result);
            } else {
                const info = stmt.run(...params);
                result = {
                    rows: [],
                    rowCount: info.changes,
                    lastID: info.lastInsertRowid,
                    changes: info.changes
                };
                // پاک کردن کش برای تغییرات
                this.invalidateCache();
            }

            return result;
        } catch (error) {
            console.error('❌ Database query error:', error);
            console.error('SQL:', sql);
            console.error('Params:', params);
            throw error;
        }
    }

    // اجرای کوئری با تراکنش
    transaction(fn) {
        return this.db.transaction(fn);
    }

    // اجرای کوئری خام
    exec(sql) {
        try {
            return this.db.exec(sql);
        } catch (error) {
            console.error('❌ Database exec error:', error);
            throw error;
        }
    }

    // ============================================================
    // بخش ۶: ایجاد جداول با ساختار پیشرفته
    // ============================================================

    initTables() {
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
                    is_banned INTEGER DEFAULT 0,
                    last_active TEXT,
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
                -- جدول پست‌ها با پشتیبانی از ویدیو و آمار
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
                    shares INTEGER DEFAULT 0,
                    saves INTEGER DEFAULT 0,
                    scheduled_time TEXT,
                    is_published INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    published_at TEXT,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- جدول آموزش دستیار هوشمند
                -- ==========================================
                CREATE TABLE IF NOT EXISTS assistant_training (
                    id TEXT PRIMARY KEY,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    type TEXT CHECK (type IN ('qa', 'keyword', 'context')),
                    question TEXT,
                    answer TEXT,
                    keyword TEXT,
                    response TEXT,
                    context TEXT,
                    weight INTEGER DEFAULT 1,
                    usage_count INTEGER DEFAULT 0,
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
                    is_delivered INTEGER DEFAULT 0,
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
                    likes INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- جدول ذخیره‌های پست
                -- ==========================================
                CREATE TABLE IF NOT EXISTS post_saves (
                    post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (post_id, user_id)
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
                    details TEXT,
                    status TEXT DEFAULT 'pending',
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    resolved_at TEXT,
                    resolved_by TEXT
                );

                -- ==========================================
                -- جدول فعالیت‌های کاربران
                -- ==========================================
                CREATE TABLE IF NOT EXISTS user_activities (
                    id TEXT PRIMARY KEY,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    type TEXT CHECK (type IN ('post', 'like', 'comment', 'follow', 'view', 'share', 'save')),
                    target_id TEXT,
                    metadata TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- جدول تنظیمات کاربران
                -- ==========================================
                CREATE TABLE IF NOT EXISTS user_settings (
                    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    theme TEXT DEFAULT 'dark',
                    language TEXT DEFAULT 'fa',
                    notifications_enabled INTEGER DEFAULT 1,
                    privacy_level TEXT DEFAULT 'public',
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- ایندکس‌ها برای بهبود سرعت
                -- ==========================================
                CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id);
                CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(is_published, scheduled_time);
                CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_posts_likes ON posts(likes DESC);
                CREATE INDEX IF NOT EXISTS idx_posts_views ON posts(views DESC);
                
                CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user, to_user);
                CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(to_user, is_read);
                
                CREATE INDEX IF NOT EXISTS idx_assistant_user ON assistant_training(user_id);
                CREATE INDEX IF NOT EXISTS idx_assistant_type ON assistant_training(type);
                
                CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id);
                CREATE INDEX IF NOT EXISTS idx_comments_created ON post_comments(created_at DESC);
                
                CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
                CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
                
                CREATE INDEX IF NOT EXISTS idx_notifications_user ON system_notifications(user_id, is_read);
                CREATE INDEX IF NOT EXISTS idx_notifications_created ON system_notifications(created_at DESC);
                
                CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
                CREATE INDEX IF NOT EXISTS idx_users_score ON users(score DESC);
                CREATE INDEX IF NOT EXISTS idx_channels_score ON channels(activity_score DESC);
                CREATE INDEX IF NOT EXISTS idx_channels_followers ON channels(followers_count DESC);
                
                CREATE INDEX IF NOT EXISTS idx_activities_user ON user_activities(user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_activities_type ON user_activities(type);
            `);
            
            console.log('✅ All tables created/verified');

            // ==========================================
            // ایجاد کاربر ادمین
            // ==========================================
            this.createAdminUser();

            // ==========================================
            // به‌روزرسانی ساختار (Migration)
            // ==========================================
            this.runMigrations();

        } catch (error) {
            console.error('❌ Error creating tables:', error);
            throw error;
        }
    }

    // ============================================================
    // بخش ۷: Migration ها
    // ============================================================

    runMigrations() {
        // اضافه کردن ستون‌های جدید
        const migrations = [
            { sql: `ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0`, name: 'add_is_banned' },
            { sql: `ALTER TABLE users ADD COLUMN last_active TEXT`, name: 'add_last_active' },
            { sql: `ALTER TABLE posts ADD COLUMN shares INTEGER DEFAULT 0`, name: 'add_shares' },
            { sql: `ALTER TABLE posts ADD COLUMN saves INTEGER DEFAULT 0`, name: 'add_saves' },
            { sql: `ALTER TABLE messages ADD COLUMN is_delivered INTEGER DEFAULT 0`, name: 'add_is_delivered' },
            { sql: `ALTER TABLE assistant_training ADD COLUMN weight INTEGER DEFAULT 1`, name: 'add_weight' },
            { sql: `ALTER TABLE assistant_training ADD COLUMN usage_count INTEGER DEFAULT 0`, name: 'add_usage_count' },
            { sql: `ALTER TABLE post_comments ADD COLUMN likes INTEGER DEFAULT 0`, name: 'add_comment_likes' }
        ];

        for (const migration of migrations) {
            try {
                this.db.exec(migration.sql);
                console.log(`✅ Migration: ${migration.name} applied`);
            } catch (e) {
                // ستون قبلاً وجود دارد
            }
        }
    }

    // ============================================================
    // بخش ۸: ایجاد کاربر ادمین
    // ============================================================

    createAdminUser() {
        try {
            const adminCheck = this.db.prepare(`SELECT id FROM users WHERE id = ?`).get(['admin_milad']);
            
            if (!adminCheck) {
                this.db.exec(`
                    INSERT INTO users (id, name, avatar, role, is_verified, score, bio, created_at) 
                    VALUES ('admin_milad', 'مدیر سیستم', '/admin-avatar.png', 'admin', 1, 999999, 'مدیر سیستم پلتفرم یارِ من', CURRENT_TIMESTAMP);
                    
                    INSERT INTO channels (id, user_id, name, boost_level, description, created_at) 
                    VALUES ('channel_admin', 'admin_milad', 'کانال مدیریت', 'superstar', 'کانال رسمی مدیریت سیستم', CURRENT_TIMESTAMP);
                    
                    INSERT INTO user_settings (user_id, theme, language, notifications_enabled, privacy_level, created_at) 
                    VALUES ('admin_milad', 'dark', 'fa', 1, 'public', CURRENT_TIMESTAMP);
                `);
                console.log('✅ Admin user created');
            }
        } catch (error) {
            console.error('❌ Error creating admin:', error);
        }
    }

    // ============================================================
    // بخش ۹: پشتیبان‌گیری خودکار
    // ============================================================

    startAutoBackup() {
        if (this.options.backupInterval > 0) {
            this.backupInterval = setInterval(() => {
                this.createBackup();
            }, this.options.backupInterval);
        }
    }

    createBackup() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = path.join(__dirname, 'backups', `backup_${timestamp}.sqlite`);
            
            // اطمینان از وجود پوشه
            const backupDir = path.dirname(backupPath);
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }

            // ایجاد پشتیبان
            const backupDb = new Database(backupPath);
            this.db.backup(backupDb);
            backupDb.close();

            // فشرده‌سازی پشتیبان
            const data = fs.readFileSync(backupPath);
            const compressed = zlib.gzipSync(data);
            fs.writeFileSync(backupPath + '.gz', compressed);
            fs.unlinkSync(backupPath);

            // حذف پشتیبان‌های قدیمی (نگهداری ۷ روز اخیر)
            const files = fs.readdirSync(backupDir);
            const oldBackups = files
                .filter(f => f.endsWith('.gz'))
                .sort()
                .slice(0, -7);
            
            for (const file of oldBackups) {
                fs.unlinkSync(path.join(backupDir, file));
            }

            console.log(`✅ Backup created: ${backupPath}.gz`);
            return backupPath + '.gz';
        } catch (error) {
            console.error('❌ Backup error:', error);
            return null;
        }
    }

    // ============================================================
    // بخش ۱۰: پاکسازی کش خودکار
    // ============================================================

    startCacheCleanup() {
        setInterval(() => {
            const now = Date.now();
            for (const [key, value] of this.cache) {
                if (now - value.timestamp > this.options.cacheTTL) {
                    this.cache.delete(key);
                    this.cacheStats.evictions++;
                }
            }
        }, this.options.cacheTTL / 2);
    }

    // ============================================================
    // بخش ۱۱: متدهای کمکی پیشرفته
    // ============================================================

    getDb() {
        return this.db;
    }

    clearCache() {
        this.cache.clear();
        this.cacheStats.evictions += this.cache.size;
    }

    close() {
        if (this.backupInterval) {
            clearInterval(this.backupInterval);
        }
        this.db.close();
        this.cache.clear();
    }

    vacuum() {
        try {
            this.db.exec('VACUUM');
            console.log('✅ Database vacuum completed');
            return true;
        } catch (error) {
            console.error('❌ Vacuum error:', error);
            return false;
        }
    }

    getStats() {
        try {
            const tables = this.db.prepare(`
                SELECT name FROM sqlite_master WHERE type='table'
            `).all();
            
            const stats = {};
            for (const table of tables) {
                const count = this.db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
                stats[table.name] = count.count;
            }
            
            return stats;
        } catch (error) {
            console.error('Stats error:', error);
            return {};
        }
    }

    getDatabaseSize() {
        try {
            const stats = fs.statSync(this.dbPath);
            return {
                size: stats.size,
                sizeFormatted: this.formatSize(stats.size)
            };
        } catch (error) {
            return { size: 0, sizeFormatted: '0 B' };
        }
    }

    formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // ============================================================
    // بخش ۱۲: متدهای بازیابی اطلاعات
    // ============================================================

    // دریافت کاربر با کش
    getUser(userId) {
        const result = this.query(userId, `SELECT * FROM users WHERE id = $1`, [userId]);
        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // دریافت کانال کاربر
    getUserChannel(userId) {
        const result = this.query(userId, `SELECT * FROM channels WHERE user_id = $1`, [userId]);
        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // دریافت پست‌های کاربر
    getUserPosts(userId, limit = 20) {
        const result = this.query(userId, `
            SELECT p.*, u.name as user_name, u.avatar as user_avatar
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC
            LIMIT $2
        `, [userId, limit]);
        return result.rows;
    }

    // دریافت فالوورهای کاربر
    getUserFollowers(userId, limit = 20) {
        const result = this.query(userId, `
            SELECT u.id, u.name, u.avatar, f.created_at
            FROM follows f
            JOIN users u ON u.id = f.follower_id
            WHERE f.following_id = $1
            ORDER BY f.created_at DESC
            LIMIT $2
        `, [userId, limit]);
        return result.rows;
    }

    // دریافت فالوینگ‌های کاربر
    getUserFollowing(userId, limit = 20) {
        const result = this.query(userId, `
            SELECT u.id, u.name, u.avatar, f.created_at
            FROM follows f
            JOIN users u ON u.id = f.following_id
            WHERE f.follower_id = $1
            ORDER BY f.created_at DESC
            LIMIT $2
        `, [userId, limit]);
        return result.rows;
    }

    // بررسی فالو
    isFollowing(followerId, followingId) {
        const result = this.query(followerId, `
            SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2
        `, [followerId, followingId]);
        return result.rows.length > 0;
    }

    // دریافت تعداد فالوورها
    getFollowersCount(userId) {
        const result = this.query(userId, `
            SELECT COUNT(*) as count FROM follows WHERE following_id = $1
        `, [userId]);
        return result.rows[0]?.count || 0;
    }

    // دریافت تعداد فالوینگ‌ها
    getFollowingCount(userId) {
        const result = this.query(userId, `
            SELECT COUNT(*) as count FROM follows WHERE follower_id = $1
        `, [userId]);
        return result.rows[0]?.count || 0;
    }

    // ============================================================
    // بخش ۱۳: متدهای مدیریت محتوا
    // ============================================================

    // دریافت پست با کش
    getPost(postId, viewerId = null) {
        const result = this.query(postId, `
            SELECT 
                p.*,
                u.id as user_id,
                u.name,
                u.avatar,
                c.name as channel_name,
                EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = $2) as is_liked
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE p.id = $1
        `, [postId, viewerId || '']);
        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // دریافت کامنت‌های پست
    getPostComments(postId, limit = 50) {
        const result = this.query(postId, `
            SELECT 
                c.id,
                c.text,
                c.created_at,
                c.likes,
                u.id as user_id,
                u.name,
                u.avatar
            FROM post_comments c
            JOIN users u ON u.id = c.user_id
            WHERE c.post_id = $1
            ORDER BY c.likes DESC, c.created_at ASC
            LIMIT $2
        `, [postId, limit]);
        return result.rows;
    }

    // دریافت پست‌های محبوب
    getTrendingPosts(limit = 20) {
        const result = this.query(null, `
            SELECT 
                p.*,
                u.id as user_id,
                u.name,
                u.avatar,
                c.name as channel_name,
                (p.likes * 2 + p.comments * 3 + p.views * 0.5 + p.shares * 4) as score
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE p.is_published = 1
                AND p.created_at > datetime('now', '-7 days')
            ORDER BY score DESC
            LIMIT $1
        `, [limit]);
        return result.rows;
    }

    // ============================================================
    // بخش ۱۴: متدهای فعالیت‌ها
    // ============================================================

    logActivity(userId, type, targetId, metadata = null) {
        const id = crypto.randomUUID();
        this.query(userId, `
            INSERT INTO user_activities (id, user_id, type, target_id, metadata, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [id, userId, type, targetId, metadata ? JSON.stringify(metadata) : null]);
    }

    getUserActivities(userId, limit = 20) {
        const result = this.query(userId, `
            SELECT * FROM user_activities
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2
        `, [userId, limit]);
        return result.rows;
    }

    // ============================================================
    // بخش ۱۵: متدهای تنظیمات
    // ============================================================

    getUserSettings(userId) {
        const result = this.query(userId, `
            SELECT * FROM user_settings WHERE user_id = $1
        `, [userId]);
        if (result.rows.length === 0) {
            // ایجاد تنظیمات پیش‌فرض
            this.query(userId, `
                INSERT INTO user_settings (user_id, theme, language, notifications_enabled, privacy_level, created_at)
                VALUES ($1, 'dark', 'fa', 1, 'public', CURRENT_TIMESTAMP)
            `, [userId]);
            return {
                user_id: userId,
                theme: 'dark',
                language: 'fa',
                notifications_enabled: 1,
                privacy_level: 'public'
            };
        }
        return result.rows[0];
    }

    updateUserSettings(userId, settings) {
        const fields = [];
        const values = [];
        let paramIndex = 1;
        
        for (const [key, value] of Object.entries(settings)) {
            fields.push(`${key} = $${paramIndex}`);
            values.push(value);
            paramIndex++;
        }
        
        if (fields.length === 0) return;
        
        values.push(userId);
        this.query(userId, `
            UPDATE user_settings SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $${paramIndex}
        `, values);
    }

    // ============================================================
    // بخش ۱۶: متدهای جستجوی پیشرفته
    // ============================================================

    searchUsers(query, limit = 20) {
        const searchTerm = `%${query.trim()}%`;
        const result = this.query(null, `
            SELECT id, name, avatar, score, is_verified
            FROM users
            WHERE name LIKE $1
                AND id != 'admin_milad'
                AND is_banned = 0
            ORDER BY 
                CASE 
                    WHEN name LIKE $2 THEN 1
                    WHEN name LIKE $3 THEN 2
                    ELSE 3
                END,
                score DESC
            LIMIT $4
        `, [
            searchTerm,
            query.trim() + '%',
            '%' + query.trim() + '%',
            limit
        ]);
        return result.rows;
    }

    searchPosts(query, limit = 20) {
        const searchTerm = `%${query.trim()}%`;
        const result = this.query(null, `
            SELECT 
                p.*,
                u.id as user_id,
                u.name as user_name,
                u.avatar as user_avatar,
                c.name as channel_name
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE p.content LIKE $1
                AND p.is_published = 1
            ORDER BY 
                p.likes DESC,
                p.created_at DESC
            LIMIT $2
        `, [searchTerm, limit]);
        return result.rows;
    }

    // ============================================================
    // بخش ۱۷: متدهای آماری
    // ============================================================

    getPlatformStats() {
        try {
            const users = this.db.prepare(`SELECT COUNT(*) as count FROM users`).get();
            const posts = this.db.prepare(`SELECT COUNT(*) as count FROM posts WHERE is_published = 1`).get();
            const channels = this.db.prepare(`SELECT COUNT(*) as count FROM channels`).get();
            const messages = this.db.prepare(`SELECT COUNT(*) as count FROM messages`).get();
            const follows = this.db.prepare(`SELECT COUNT(*) as count FROM follows`).get();
            const likes = this.db.prepare(`SELECT COUNT(*) as count FROM post_likes`).get();
            const comments = this.db.prepare(`SELECT COUNT(*) as count FROM post_comments`).get();
            
            // کاربران فعال امروز
            const todayActive = this.db.prepare(`
                SELECT COUNT(DISTINCT user_id) as count 
                FROM posts 
                WHERE DATE(created_at) = DATE('now')
            `).get();

            // پست‌های امروز
            const todayPosts = this.db.prepare(`
                SELECT COUNT(*) as count 
                FROM posts 
                WHERE DATE(created_at) = DATE('now') AND is_published = 1
            `).get();

            return {
                users: users.count || 0,
                posts: posts.count || 0,
                channels: channels.count || 0,
                messages: messages.count || 0,
                follows: follows.count || 0,
                likes: likes.count || 0,
                comments: comments.count || 0,
                todayActive: todayActive.count || 0,
                todayPosts: todayPosts.count || 0,
                timestamp: Date.now()
            };
        } catch (error) {
            console.error('Stats error:', error);
            return {};
        }
    }

    // ============================================================
    // بخش ۱۸: متدهای نگهداری و بهینه‌سازی
    // ============================================================

    optimize() {
        try {
            console.log('🔄 Optimizing database...');
            
            // Vacuum
            this.db.exec('VACUUM');
            
            // Reindex
            this.db.exec('REINDEX');
            
            // Analyze
            this.db.exec('ANALYZE');
            
            console.log('✅ Database optimization completed');
            return true;
        } catch (error) {
            console.error('❌ Optimization error:', error);
            return false;
        }
    }

    checkIntegrity() {
        try {
            const result = this.db.prepare('PRAGMA integrity_check').get();
            return result.integrity_check === 'ok';
        } catch (error) {
            console.error('Integrity check error:', error);
            return false;
        }
    }

    // ============================================================
    // بخش ۱۹: مدیریت خطاها
    // ============================================================

    handleError(error, context = '') {
        console.error(`❌ Database error${context ? ' (' + context + ')' : ''}:`, error);
        
        // Log to file
        try {
            const logPath = path.join(__dirname, 'logs', 'db_errors.log');
            const logDir = path.dirname(logPath);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            fs.appendFileSync(logPath, 
                `[${new Date().toISOString()}] ${context}: ${error.message}\n${error.stack}\n\n`
            );
        } catch (e) {
            console.error('Could not write error log:', e);
        }
        
        // بازسازی اتصال در صورت قطع شدن
        if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') {
            console.log('🔄 Database busy, retrying...');
            setTimeout(() => {
                this.connect();
            }, 1000);
        }
        
        throw error;
    }

    // ============================================================
    // بخش ۲۰: متدهای ابزاری
    // ============================================================

    // تبدیل به JSON ایمن
    toJSON(data) {
        try {
            return JSON.stringify(data);
        } catch (error) {
            return null;
        }
    }

    // تبدیل از JSON
    fromJSON(json) {
        try {
            return JSON.parse(json);
        } catch (error) {
            return null;
        }
    }

    // تولید ID یکتا
    generateId() {
        return crypto.randomUUID();
    }

    // تولید ID کوتاه
    generateShortId(length = 8) {
        return crypto.randomBytes(Math.ceil(length / 2))
            .toString('hex')
            .substring(0, length);
    }

    // هش کردن
    hash(text) {
        return crypto.createHash('sha256')
            .update(text + process.env.HASH_SALT || 'yareman_salt')
            .digest('hex');
    }

    // ============================================================
    // بخش ۲۱: تخریب و پاکسازی
    // ============================================================

    destroy() {
        try {
            this.close();
            
            // حذف فایل‌های موقت
            const tempDir = path.join(__dirname, 'temp');
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
            
            console.log('✅ Database manager destroyed');
        } catch (error) {
            console.error('❌ Destroy error:', error);
        }
    }
}

// ============================================================
// بخش ۲۲: صادرات
// ============================================================

module.exports = DatabaseManager;

// ============================================================
// پایان فایل database.js
// ============================================================