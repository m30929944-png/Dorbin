// ================================================================
// database.js - دیتابیس با SQLite (ساده و قدرتمند)
// ================================================================

const Database = require('better-sqlite3');
const path = require('path');

class DatabaseManager {
  constructor() {
    this.db = new Database(path.join(__dirname, 'data.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    this.db.pragma('foreign_keys = ON');
  }

  async query(text, params = []) {
    const sql = text.replace(/\$(\d+)/g, '?');
    const cmd = text.trim().slice(0, 6).toUpperCase();
    try {
      const stmt = this.db.prepare(sql);
      if (cmd === 'SELECT') return { rows: stmt.all(...params) };
      const info = stmt.run(...params);
      return { rows: [], rowCount: info.changes, lastID: info.lastInsertRowid };
    } catch (e) { console.error('DB Error:', e.message); throw e; }
  }

  async initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, bio TEXT,
        score INTEGER DEFAULT 0, password_hash TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, user_id TEXT UNIQUE REFERENCES users(id),
        name TEXT NOT NULL, posts_count INTEGER DEFAULT 0,
        followers_count INTEGER DEFAULT 0, boost_level TEXT DEFAULT 'normal',
        activity_score INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY, channel_id TEXT REFERENCES channels(id),
        content TEXT NOT NULL, media_url TEXT, media_type TEXT,
        views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, comments INTEGER DEFAULT 0,
        scheduled_time TEXT, is_published INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, published_at TEXT
      );
      CREATE TABLE IF NOT EXISTS post_likes (
        post_id TEXT REFERENCES posts(id), user_id TEXT REFERENCES users(id),
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (post_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS post_comments (
        id TEXT PRIMARY KEY, post_id TEXT REFERENCES posts(id),
        user_id TEXT REFERENCES users(id), text TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS follows (
        follower_id TEXT REFERENCES users(id), following_id TEXT REFERENCES users(id),
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (follower_id, following_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, from_user TEXT REFERENCES users(id),
        to_user TEXT REFERENCES users(id), message_encrypted TEXT NOT NULL,
        iv TEXT NOT NULL, timestamp BIGINT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS assistant_training (
        id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id),
        type TEXT CHECK (type IN ('qa','keyword')),
        question TEXT, answer TEXT, keyword TEXT, response TEXT,
        usage_count INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id, is_published, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user, to_user);
    `);
    console.log('✅ Database ready');
  }
}

module.exports = new DatabaseManager();