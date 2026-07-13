// ============================================
// database.js - با بهینه‌سازی کوئری و ایندکس‌ها
// ============================================
const Database = require('better-sqlite3');
const path = require('path');

class DatabaseManager {
  constructor() {
    this.db = new Database(path.join(__dirname, 'data.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('cache_size = 10000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
  }

  async query(key, text, params = []) {
    const sql = text.replace(/\$(\d+)/g, '?');
    const cmd = text.trim().slice(0, 6).toUpperCase();

    try {
      const stmt = this.db.prepare(sql);
      if (cmd === 'SELECT') {
        const start = Date.now();
        const result = { rows: stmt.all(...params) };
        if (Date.now() - start > 100) {
          console.log(`⚠️ Slow query (${Date.now() - start}ms): ${sql.slice(0, 60)}...`);
        }
        return result;
      }
      const info = stmt.run(...params);
      return { rows: [], rowCount: info.changes, lastID: info.lastInsertRowid };
    } catch (error) {
      console.error('Database error:', error.message, '\nSQL:', sql);
      throw error;
    }
  }

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
        media_type TEXT CHECK (media_type IN ('image', 'video', NULL)),
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
      CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(is_published);
      CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user, to_user);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assistant_user ON assistant_training(user_id);
      CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id);
      CREATE INDEX IF NOT EXISTS idx_comments_created ON post_comments(created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
      CREATE INDEX IF NOT EXISTS idx_likes_post ON post_likes(post_id);
    `);

    // به‌روزرسانی خودکار activity_score برای کانال‌های قدیمی
    this.db.exec(`
      UPDATE channels 
      SET activity_score = (
        SELECT COALESCE(SUM(
          (SELECT COUNT(*) FROM posts WHERE channel_id = channels.id) * 2 +
          (SELECT COUNT(*) FROM post_likes pl JOIN posts p ON p.id = pl.post_id WHERE p.channel_id = channels.id) * 0.5 +
          (SELECT COUNT(*) FROM assistant_training WHERE user_id = channels.user_id) * 3
        ), 0)
        FROM channels c2 WHERE c2.id = channels.id
      )
      WHERE activity_score = 0 AND posts_count > 0;
    `);

    console.log('✅ Tables created and optimized');
  }
}

module.exports = DatabaseManager;