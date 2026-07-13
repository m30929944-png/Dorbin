// ============================================
// database.js - مدیریت دیتابیس پیشرفته با کش و رمزنگاری
// ============================================
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

class DatabaseManager {
    constructor() {
        // ============================================
        // تنظیمات کش حافظه
        // ============================================
        this.cache = new Map();
        this.cacheTTL = 60000; // 60 ثانیه
        this.maxCacheSize = 1000; // حداکثر تعداد آیتم‌های کش
        
        // ============================================
        // مسیر دیتابیس
        // ============================================
        this.dbPath = path.join(__dirname, 'data.sqlite');
        
        // ============================================
        // اتصال به دیتابیس با تنظیمات بهینه
        // ============================================
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('cache_size = 10000');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('temp_store = MEMORY');
        this.db.pragma('mmap_size = 268435456'); // 256MB برای بهبود عملکرد
        
        // ============================================
        // رمزنگاری با کلید ثابت (ذخیره در فایل)
        // ============================================
        this.encryptionKey = this.getOrCreateEncryptionKey();
        this.encryptionIV = this.getOrCreateEncryptionIV();
        
        // ============================================
        // ایجاد جداول
        // ============================================
        this.initTables();
        
        // ============================================
        // پاکسازی خودکار کش هر ۵ دقیقه
        // ============================================
        setInterval(() => this.cleanupCache(), 300000);
    }

    // ============================================
    // مدیریت کلید رمزنگاری (ذخیره در فایل)
    // ============================================
    getOrCreateEncryptionKey() {
        const keyPath = path.join(__dirname, '.encryption_key');
        try {
            if (fs.existsSync(keyPath)) {
                const keyHex = fs.readFileSync(keyPath, 'utf8').trim();
                if (keyHex.length === 64) { // 32 bytes = 64 hex characters
                    return Buffer.from(keyHex, 'hex');
                }
                // اگر کلید نامعتبر بود، دوباره تولید کن
                console.warn('⚠️ Invalid encryption key found, regenerating...');
                return this.createAndSaveKey(keyPath);
            } else {
                return this.createAndSaveKey(keyPath);
            }
        } catch (error) {
            console.error('Error loading encryption key:', error);
            // Fallback: استفاده از کلید موقت
            return crypto.randomBytes(32);
        }
    }

    createAndSaveKey(keyPath) {
        const key = crypto.randomBytes(32);
        try {
            fs.writeFileSync(keyPath, key.toString('hex'), 'utf8');
            fs.chmodSync(keyPath, 0o600);
            console.log('✅ New encryption key created');
        } catch (error) {
            console.error('Error saving encryption key:', error);
        }
        return key;
    }

    getOrCreateEncryptionIV() {
        const ivPath = path.join(__dirname, '.encryption_iv');
        try {
            if (fs.existsSync(ivPath)) {
                const ivHex = fs.readFileSync(ivPath, 'utf8').trim();
                if (ivHex.length === 32) { // 16 bytes = 32 hex characters
                    return Buffer.from(ivHex, 'hex');
                }
                console.warn('⚠️ Invalid encryption IV found, regenerating...');
                return this.createAndSaveIV(ivPath);
            } else {
                return this.createAndSaveIV(ivPath);
            }
        } catch (error) {
            console.error('Error loading encryption IV:', error);
            return crypto.randomBytes(16);
        }
    }

    createAndSaveIV(ivPath) {
        const iv = crypto.randomBytes(16);
        try {
            fs.writeFileSync(ivPath, iv.toString('hex'), 'utf8');
            fs.chmodSync(ivPath, 0o600);
            console.log('✅ New encryption IV created');
        } catch (error) {
            console.error('Error saving encryption IV:', error);
        }
        return iv;
    }

    // ============================================
    // رمزنگاری و رمزگشایی با مدیریت خطا
    // ============================================
    encrypt(text) {
        if (!text || typeof text !== 'string') return text;
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
        if (!encryptedText || typeof encryptedText !== 'string') return encryptedText;
        try {
            const parts = encryptedText.split(':');
            if (parts.length !== 2) return encryptedText;
            
            const [encrypted, authTag] = parts;
            if (!authTag || !encrypted) return encryptedText;
            
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
    // تشخیص نوع کوئری با دقت بالا
    // ============================================
    getQueryType(sql) {
        if (!sql || typeof sql !== 'string') return '';
        
        // حذف کامنت‌ها و فضای خالی
        let clean = sql.replace(/\/\*.*?\*\//g, ''); // حذف کامنت‌های /* */
        clean = clean.replace(/--.*$/gm, ''); // حذف کامنت‌های --
        clean = clean.trim();
        
        // پیدا کردن اولین کلمه
        const match = clean.match(/^\s*(\w+)/i);
        return match ? match[1].toUpperCase() : '';
    }

    // ============================================
    // اجرای کوئری با کش پیشرفته
    // ============================================
    async query(text, params = []) {
        if (!text || typeof text !== 'string') {
            throw new Error('Invalid SQL query');
        }
        
        // اطمینان از آرایه بودن params
        if (!Array.isArray(params)) {
            params = [params];
        }
        
        const cacheKey = `${text}_${JSON.stringify(params)}`;
        const queryType = this.getQueryType(text);
        
        // بررسی کش برای SELECT
        if (queryType === 'SELECT') {
            const cached = this.cache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
                cached.hits = (cached.hits || 0) + 1;
                return cached.data;
            }
        }

        // تبدیل $1, $2 به ? (با پشتیبانی از هر دو فرمت)
        let sql = text;
        // پشتیبانی از $1, $2, ...
        sql = sql.replace(/\$(\d+)/g, (match, num) => {
            const index = parseInt(num) - 1;
            return index < params.length ? '?' : match;
        });
        
        // پشتیبانی از ? (مستقیم)
        // اگر تعداد ? با params همخوانی نداشت، خطا نده
        
        try {
            const stmt = this.db.prepare(sql);
            let result;
            
            if (queryType === 'SELECT') {
                result = stmt.all(...params);
                // ذخیره در کش با مدیریت حجم
                if (this.cache.size >= this.maxCacheSize) {
                    // حذف قدیمی‌ترین آیتم‌ها
                    const entries = Array.from(this.cache.entries());
                    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
                    const toDelete = Math.floor(this.maxCacheSize * 0.2);
                    for (let i = 0; i < toDelete && i < entries.length; i++) {
                        this.cache.delete(entries[i][0]);
                    }
                }
                
                this.cache.set(cacheKey, { 
                    data: result, 
                    timestamp: Date.now(),
                    hits: 0
                });
            } else {
                const info = stmt.run(...params);
                result = {
                    changes: info.changes,
                    lastInsertRowid: info.lastInsertRowid
                };
                // پاک کردن کش برای تغییرات
                this.invalidateCache();
            }
            return result;
        } catch (error) {
            console.error('❌ Database error:', error.message);
            console.error('📝 SQL:', sql);
            console.error('📦 Params:', params);
            throw error;
        }
    }

    // ============================================
    // پاکسازی کش با مدیریت حافظه
    // ============================================
    invalidateCache() {
        this.cache.clear();
        console.log('🗑️ Cache invalidated');
    }

    cleanupCache() {
        const now = Date.now();
        let deleted = 0;
        for (const [key, value] of this.cache.entries()) {
            if ((now - value.timestamp) > this.cacheTTL) {
                this.cache.delete(key);
                deleted++;
            }
        }
        if (deleted > 0) {
            console.log(`🧹 Cache cleaned: ${deleted} entries removed (${this.cache.size} remaining)`);
        }
    }

    // ============================================
    // ایجاد جداول با مدیریت خطا
    // ============================================
    async initTables() {
        try {
            // ==========================================
            // ایجاد جداول اصلی
            // ==========================================
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
                -- جدول سشن‌ها (برای مدیریت توکن‌ها)
                -- ==========================================
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    token TEXT UNIQUE NOT NULL,
                    expires_at TEXT NOT NULL,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- ==========================================
                -- جدول تنظیمات سیستمی
                -- ==========================================
                CREATE TABLE IF NOT EXISTS system_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
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
                CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
                CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
                CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
            `);
            
            console.log('✅ All tables created/verified');

            // ==========================================
            // ایجاد کاربر ادمین
            // ==========================================
            const adminCheck = this.db.prepare(`SELECT id FROM users WHERE id = ?`).get('admin_milad');
            
            if (!adminCheck) {
                this.db.exec(`
                    INSERT INTO users (id, name, avatar, role, is_verified, score, last_active, created_at) 
                    VALUES ('admin_milad', 'مدیر سیستم', '/admin-avatar.png', 'admin', 1, 999999, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
                    
                    INSERT INTO channels (id, user_id, name, boost_level, created_at) 
                    VALUES ('channel_admin', 'admin_milad', 'کانال مدیریت', 'superstar', CURRENT_TIMESTAMP);
                `);
                console.log('✅ Admin user created');
            }

            // ==========================================
            // به‌روزرسانی ساختار دیتابیس (Migration)
            // ==========================================
            await this.runMigrations();

        } catch (error) {
            console.error('❌ Error creating tables:', error);
            throw error;
        }
    }

    // ============================================
    // سیستم Migration خودکار
    // ============================================
    async runMigrations() {
        const migrations = [
            {
                version: 1,
                up: () => {
                    try {
                        this.db.exec(`ALTER TABLE messages ADD COLUMN encrypted INTEGER DEFAULT 0`);
                        console.log('✅ Migration v1: Added encrypted column to messages');
                    } catch (e) {
                        // ستون قبلاً وجود دارد
                    }
                }
            },
            {
                version: 2,
                up: () => {
                    try {
                        this.db.exec(`ALTER TABLE users ADD COLUMN bio TEXT`);
                        console.log('✅ Migration v2: Added bio column to users');
                    } catch (e) {
                        // ستون قبلاً وجود دارد
                    }
                }
            },
            {
                version: 3,
                up: () => {
                    try {
                        this.db.exec(`ALTER TABLE users ADD COLUMN last_active TEXT`);
                        console.log('✅ Migration v3: Added last_active column to users');
                    } catch (e) {
                        // ستون قبلاً وجود دارد
                    }
                }
            },
            {
                version: 4,
                up: () => {
                    try {
                        this.db.exec(`
                            CREATE TABLE IF NOT EXISTS sessions (
                                id TEXT PRIMARY KEY,
                                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                                token TEXT UNIQUE NOT NULL,
                                expires_at TEXT NOT NULL,
                                created_at TEXT DEFAULT CURRENT_TIMESTAMP
                            )
                        `);
                        console.log('✅ Migration v4: Created sessions table');
                    } catch (e) {
                        // جدول قبلاً وجود دارد
                    }
                }
            },
            {
                version: 5,
                up: () => {
                    try {
                        this.db.exec(`
                            CREATE TABLE IF NOT EXISTS system_settings (
                                key TEXT PRIMARY KEY,
                                value TEXT NOT NULL,
                                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                            )
                        `);
                        console.log('✅ Migration v5: Created system_settings table');
                    } catch (e) {
                        // جدول قبلاً وجود دارد
                    }
                }
            }
        ];

        // ایجاد جدول migrations اگر وجود ندارد
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // اجرای migration‌های جدید
        for (const migration of migrations) {
            const applied = this.db.prepare(
                `SELECT version FROM migrations WHERE version = ?`
            ).get(migration.version);

            if (!applied) {
                try {
                    migration.up();
                    this.db.prepare(
                        `INSERT INTO migrations (version) VALUES (?)`
                    ).run(migration.version);
                    console.log(`✅ Migration v${migration.version} applied successfully`);
                } catch (error) {
                    console.error(`❌ Migration v${migration.version} failed:`, error);
                }
            }
        }
    }

    // ============================================
    // متدهای کمکی با مدیریت بهتر
    // ============================================
    getDb() {
        return this.db;
    }

    clearCache() {
        this.cache.clear();
        console.log('🗑️ Cache cleared');
    }

    getCacheStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxCacheSize,
            ttl: this.cacheTTL,
            entries: Array.from(this.cache.entries()).map(([key, value]) => ({
                key: key.substring(0, 50) + '...',
                hits: value.hits || 0,
                age: Math.round((Date.now() - value.timestamp) / 1000) + 's'
            }))
        };
    }

    close() {
        this.db.close();
        console.log('🔒 Database connection closed');
    }

    // ============================================
    // Transaction با مدیریت خطا
    // ============================================
    transaction(fn) {
        return this.db.transaction((...args) => {
            try {
                const result = fn(...args);
                this.invalidateCache();
                return result;
            } catch (error) {
                console.error('❌ Transaction error:', error);
                throw error;
            }
        });
    }

    // ============================================
    // پشتیبان‌گیری خودکار
    // ============================================
    backup() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            
            // اطمینان از وجود دایرکتوری backup
            const backupDir = path.join(__dirname, 'backups');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }
            
            const backupPath = path.join(backupDir, `backup_${timestamp}.sqlite`);
            const backup = new Database(backupPath);
            this.db.backup(backup);
            backup.close();
            
            // فشرده‌سازی backup (اختیاری)
            console.log(`✅ Backup created: ${backupPath}`);
            
            // حذف بکاپ‌های قدیمی (فقط ۱۰ تا آخرین بکاپ نگه دار)
            this.cleanupOldBackups(backupDir, 10);
            
            return backupPath;
        } catch (error) {
            console.error('❌ Backup error:', error);
            return null;
        }
    }

    cleanupOldBackups(backupDir, keepCount) {
        try {
            const files = fs.readdirSync(backupDir)
                .filter(f => f.startsWith('backup_') && f.endsWith('.sqlite'))
                .map(f => ({
                    name: f,
                    path: path.join(backupDir, f),
                    mtime: fs.statSync(path.join(backupDir, f)).mtime
                }))
                .sort((a, b) => b.mtime - a.mtime);
            
            if (files.length > keepCount) {
                const toDelete = files.slice(keepCount);
                for (const file of toDelete) {
                    fs.unlinkSync(file.path);
                    console.log(`🗑️ Old backup deleted: ${file.name}`);
                }
            }
        } catch (error) {
            console.error('Error cleaning old backups:', error);
        }
    }

    // ============================================
    // متدهای پاکسازی
    // ============================================
    vacuum() {
        try {
            this.db.exec('VACUUM');
            console.log('✅ Database vacuum completed');
        } catch (error) {
            console.error('❌ Vacuum error:', error);
        }
    }

    // ============================================
    // متدهای آماری پیشرفته
    // ============================================
    getStats() {
        const stats = {
            tables: {},
            totalRows: 0,
            cache: this.getCacheStats(),
            database: {
                path: this.dbPath,
                size: fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0
            }
        };
        
        try {
            const tables = this.db.prepare(`
                SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
            `).all();
            
            for (const table of tables) {
                const count = this.db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
                stats.tables[table.name] = count.count;
                stats.totalRows += count.count;
            }
            
            // اطلاعات بیشتر در مورد دیتابیس
            const pageCount = this.db.prepare('PRAGMA page_count').get();
            const pageSize = this.db.prepare('PRAGMA page_size').get();
            stats.database.pages = pageCount.page_count;
            stats.database.pageSize = pageSize.page_size;
            stats.database.sizeMB = (stats.database.size / (1024 * 1024)).toFixed(2);
            
        } catch (error) {
            console.error('Stats error:', error);
        }
        
        return stats;
    }

    // ============================================
    // متدهای کاربردی برای کوئری‌های رایج
    // ============================================
    
    // پیدا کردن کاربر
    findUser(id) {
        return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }

    // پیدا کردن کاربر با ایمیل یا نام کاربری
    findUserByEmail(email) {
        return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    }

    // ایجاد کاربر جدید
    createUser(userData) {
        const stmt = this.db.prepare(`
            INSERT INTO users (id, name, email, password_hash, avatar, bio, role)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        return stmt.run(userData.id, userData.name, userData.email, userData.password_hash, 
                        userData.avatar, userData.bio, userData.role || 'user');
    }

    // به‌روزرسانی کاربر
    updateUser(id, data) {
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(data)) {
            if (value !== undefined) {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        
        if (fields.length === 0) return null;
        
        values.push(id);
        const sql = `UPDATE users SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
        const stmt = this.db.prepare(sql);
        return stmt.run(...values);
    }

    // حذف کاربر
    deleteUser(id) {
        const stmt = this.db.prepare('DELETE FROM users WHERE id = ?');
        return stmt.run(id);
    }

    // پیدا کردن پست‌های یک کانال
    getChannelPosts(channelId, limit = 20, offset = 0) {
        const stmt = this.db.prepare(`
            SELECT * FROM posts 
            WHERE channel_id = ? AND is_published = 1 
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `);
        return stmt.all(channelId, limit, offset);
    }

    // پیدا کردن پیام‌های بین دو کاربر
    getMessages(user1, user2, limit = 50, offset = 0) {
        const stmt = this.db.prepare(`
            SELECT * FROM messages 
            WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `);
        return stmt.all(user1, user2, user2, user1, limit, offset);
    }

    // علامت‌گذاری پیام به عنوان خوانده شده
    markMessageRead(messageId) {
        const stmt = this.db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?');
        return stmt.run(messageId);
    }

    // آمار فعالیت کاربر
    getUserActivity(userId) {
        const stats = {
            posts: 0,
            comments: 0,
            likes: 0,
            followers: 0,
            following: 0
        };
        
        stats.posts = this.db.prepare(
            'SELECT COUNT(*) as count FROM posts WHERE channel_id IN (SELECT id FROM channels WHERE user_id = ?)'
        ).get(userId).count;
        
        stats.comments = this.db.prepare(
            'SELECT COUNT(*) as count FROM post_comments WHERE user_id = ?'
        ).get(userId).count;
        
        stats.likes = this.db.prepare(
            'SELECT COUNT(*) as count FROM post_likes WHERE user_id = ?'
        ).get(userId).count;
        
        stats.followers = this.db.prepare(
            'SELECT COUNT(*) as count FROM follows WHERE following_id = ?'
        ).get(userId).count;
        
        stats.following = this.db.prepare(
            'SELECT COUNT(*) as count FROM follows WHERE follower_id = ?'
        ).get(userId).count;
        
        return stats;
    }
}

module.exports = DatabaseManager;