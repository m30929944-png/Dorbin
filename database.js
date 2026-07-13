// ============================================
// database.js - مدیریت دیتابیس (SQLite ساده و بدون نیاز به سرور جدا)
// ============================================
// توضیح: قبلاً این پروژه از ۳ دیتابیس PostgreSQL جدا (شاردینگ) استفاده می‌کرد.
// چون فیچرهای اجتماعی (فالو، لایک، کامنت، اکسپلور) ذاتاً بین همه‌ی کاربرها مشترک‌اند
// و چون Postgres روی محیط توسعه در دسترس نبود، دیتابیس با یک فایل SQLite واحد
// جایگزین شد. همان متد query(key, text, params) قبلی حفظ شده تا بقیه‌ی کد دست نخورد.

const Database = require('better-sqlite3');
const path = require('path');

class DatabaseManager {
    constructor() {
        this.db = new Database(path.join(__dirname, 'data.sqlite'));
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
    }

    // اجرای کوئری با نحو $1, $2 (سازگار با کد قبلی) روی SQLite
    async query(key, text, params = []) {
        const sql = text.replace(/\$(\d+)/g, '?');
        const cmd = text.trim().slice(0, 6).toUpperCase();
        try {
            const stmt = this.db.prepare(sql);
            if (cmd === 'SELECT') {
                return { rows: stmt.all(...params) };
            }
            const info = stmt.run(...params);
            return { rows: [], rowCount: info.changes, lastID: info.lastInsertRowid };
        } catch (error) {
            console.error('Database error:', error.message, '\nSQL:', sql);
            throw error;
        }
    }

    // ایجاد جدول‌ها
    async initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                avatar TEXT,
                bio TEXT,
                score INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS channels (
                id TEXT PRIMARY KEY,
                user_id TEXT UNIQUE REFERENCES users(id),
                name TEXT NOT NULL,
                description TEXT,
                posts_count INTEGER DEFAULT 0,
                followers_count INTEGER DEFAULT 0,
                boost_level TEXT DEFAULT 'normal',
                activity_score INTEGER DEFAULT 0,
                last_boost_calc TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS posts (
                id TEXT PRIMARY KEY,
                channel_id TEXT REFERENCES channels(id),
                content TEXT NOT NULL,
                media_url TEXT,
                media_type TEXT,
                views INTEGER DEFAULT 0,
                likes INTEGER DEFAULT 0,
                comments INTEGER DEFAULT 0,
                scheduled_time TEXT,
                is_published INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                published_at TEXT
            );

            CREATE TABLE IF NOT EXISTS assistant_training (
                id TEXT PRIMARY KEY,
                user_id TEXT REFERENCES users(id),
                type TEXT CHECK (type IN ('qa', 'keyword')),
                question TEXT,
                answer TEXT,
                keyword TEXT,
                response TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                from_user TEXT REFERENCES users(id),
                to_user TEXT REFERENCES users(id),
                message TEXT NOT NULL,
                is_read INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS follows (
                follower_id TEXT REFERENCES users(id),
                following_id TEXT REFERENCES users(id),
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (follower_id, following_id)
            );

            CREATE TABLE IF NOT EXISTS post_likes (
                post_id TEXT REFERENCES posts(id),
                user_id TEXT REFERENCES users(id),
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (post_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS post_comments (
                id TEXT PRIMARY KEY,
                post_id TEXT REFERENCES posts(id),
                user_id TEXT REFERENCES users(id),
                text TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id);
            CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user, to_user);
            CREATE INDEX IF NOT EXISTS idx_assistant_user ON assistant_training(user_id);
            CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id);
        `);
        console.log('✅ Tables created/verified');
    }
}

module.exports = DatabaseManager;
