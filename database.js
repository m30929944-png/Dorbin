// database.js - نسخه نهایی با ۱۵۰ شارد و ۵۰ کارگر
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// ============================================
// تنظیمات شاردینگ - ۱۵۰ شارد برای بار متوازن
// ============================================
const SHARD_COUNT = Math.max(1, parseInt(process.env.DB_SHARD_COUNT || '150', 10));
const DIRECTORY_SHARD = 0;

class DatabaseManager {
    constructor() {
        this.shardCount = SHARD_COUNT;
        this.shardsDir = path.join(__dirname, 'shards');
        if (!fs.existsSync(this.shardsDir)) fs.mkdirSync(this.shardsDir, { recursive: true });

        this.cache = new Map();
        this.cacheTTL = 60000;
        this.cacheMaxEntries = 5000;
        this.directory = new Map();
        this.encryptionKey = crypto.randomBytes(32);

        this.shards = [];
        for (let i = 0; i < this.shardCount; i++) {
            const dbPath = path.join(this.shardsDir, `shard_${i}.sqlite`);
            const conn = new Database(dbPath);
            conn.pragma('journal_mode = WAL');
            conn.pragma('foreign_keys = ON');
            conn.pragma('cache_size = 20000');
            conn.pragma('synchronous = NORMAL');
            conn.pragma('temp_store = MEMORY');
            this.shards.push(conn);
        }

        this._warnedNoKey = false;
        this.initTables();
        this._loadDirectoryFromDisk();
    }

    encrypt(text) {
        try {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag().toString('hex');
            return `${iv.toString('hex')}:${encrypted}:${authTag}`;
        } catch (error) { return text; }
    }

    decrypt(encryptedText) {
        try {
            const parts = encryptedText.split(':');
            if (parts.length !== 3) return encryptedText;
            const [ivHex, encrypted, authTag] = parts;
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(ivHex, 'hex'));
            decipher.setAuthTag(Buffer.from(authTag, 'hex'));
            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) { return encryptedText; }
    }

    hashKey(key) {
        const hash = crypto.createHash('md5').update(String(key)).digest();
        return hash.readUInt32BE(0) % this.shardCount;
    }

    pairShardIndex(userA, userB) {
        const pairKey = [String(userA), String(userB)].sort().join('::');
        return this.hashKey(pairKey);
    }

    resolveShardIndex(key) {
        if (key === null || key === undefined) return null;
        const hit = this.directory.get(String(key));
        if (hit !== undefined) return hit;
        return this.hashKey(key);
    }

    registerDirectory(entityId, shardIndex) {
        if (entityId === undefined || entityId === null) return;
        const id = String(entityId);
        if (this.directory.get(id) === shardIndex) return;
        this.directory.set(id, shardIndex);
        try {
            this.shards[DIRECTORY_SHARD].prepare(`
                INSERT INTO _shard_directory (entity_id, shard_index, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(entity_id) DO UPDATE SET shard_index = excluded.shard_index, updated_at = CURRENT_TIMESTAMP
            `).run(id, shardIndex);
        } catch (e) { console.error('Directory persist error:', e.message); }
    }

    _loadDirectoryFromDisk() {
        try {
            const rows = this.shards[DIRECTORY_SHARD].prepare(`SELECT entity_id, shard_index FROM _shard_directory`).all();
            for (const r of rows) this.directory.set(r.entity_id, r.shard_index);
            console.log(`✅ Directory loaded: ${rows.length} entity mappings`);
        } catch (e) { console.error('Directory load error:', e.message); }
    }

    _maybeRegisterFromInsert(sql, params, shardIndex) {
        const m = sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
        if (!m) return;
        const cols = m[2].split(',').map(c => c.trim());
        if (cols[0] === 'id' && params && params[0] !== undefined) {
            this.registerDirectory(params[0], shardIndex);
        }
    }

    getAllShards() { return this.shards; }

    getDb(key) {
        if (key === undefined) {
            if (!this._warnedNoKey) {
                console.warn('⚠️ db.getDb() بدون کلید صدا زده شد - شارد ۰ استفاده می‌شه.');
                this._warnedNoKey = true;
            }
            return this.shards[0];
        }
        const idx = this.resolveShardIndex(key);
        return this.shards[idx === null ? 0 : idx];
    }

    async query(key, text, params = []) {
        const cmd = text.trim().slice(0, 6).toUpperCase();
        const messagesRoute = this._routeMessagesQuery(text, params);

        if (messagesRoute) {
            if (messagesRoute.mode === 'single') {
                return this._runOnShard(messagesRoute.shard, text, params, cmd, `msg:${messagesRoute.shard}`);
            }
            return this._runScatterGather(text, params, cmd);
        }

        if (key === null) {
            return this._runScatterGather(text, params, cmd);
        }

        const shardIndex = this.resolveShardIndex(key);
        return this._runOnShard(shardIndex, text, params, cmd, `s:${shardIndex}`);
    }

    _routeMessagesQuery(sql, params) {
        if (!/\bmessages\b/i.test(sql)) return null;
        if (/INSERT\s+INTO\s+messages/i.test(sql)) {
            const from = params[1], to = params[2];
            if (from !== undefined && to !== undefined) {
                return { mode: 'single', shard: this.pairShardIndex(from, to) };
            }
            return null;
        }
        if (/from_user\s*=\s*\$1[\s\S]*to_user\s*=\s*\$2[\s\S]*from_user\s*=\s*\$2/i.test(sql)) {
            const a = params[0], b = params[1];
            if (a !== undefined && b !== undefined) {
                return { mode: 'single', shard: this.pairShardIndex(a, b) };
            }
        }
        if (/from_user\s*=\s*\$1\s*OR\s*to_user\s*=\s*\$1/i.test(sql) || /WHERE\s+from_user\s*=\s*\$1\s+OR\s+to_user\s*=\s*\$1/i.test(sql)) {
            return { mode: 'scatter' };
        }
        if (/UPDATE\s+messages/i.test(sql) && params.length >= 2) {
            return { mode: 'single', shard: this.pairShardIndex(params[0], params[1]) };
        }
        return { mode: 'scatter' };
    }

    _runOnShard(shardIndex, text, params, cmd, cacheTag) {
        const cacheKey = `${cacheTag}_${text}_${JSON.stringify(params)}`;
        if (cmd === 'SELECT') {
            const cached = this.cache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
                return cached.data;
            }
        }

        const sql = text.replace(/\$(\d+)/g, '?');
        const conn = this.shards[shardIndex];

        try {
            const stmt = conn.prepare(sql);
            let result;
            if (cmd === 'SELECT') {
                result = { rows: stmt.all(...params) };
                this._cacheSet(cacheKey, result, this._tablesInSql(text));
            } else {
                const info = stmt.run(...params);
                result = { rows: [], rowCount: info.changes, lastID: info.lastInsertRowid };
                if (cmd === 'INSERT') this._maybeRegisterFromInsert(text, params, shardIndex);
                this._invalidateByTables(this._tablesInSql(text));
            }
            return result;
        } catch (error) {
            console.error('Database error:', error.message, '\nSQL:', sql, '\nShard:', shardIndex);
            throw error;
        }
    }

    _runScatterGather(text, params, cmd) {
        const cacheKey = `scatter_${text}_${JSON.stringify(params)}`;
        if (cmd === 'SELECT') {
            const cached = this.cache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
                return cached.data;
            }
        }

        const sql = text.replace(/\$(\d+)/g, '?');
        let combinedRows = [];
        let combinedChanges = 0;

        for (const conn of this.shards) {
            try {
                const stmt = conn.prepare(sql);
                if (cmd === 'SELECT') {
                    combinedRows = combinedRows.concat(stmt.all(...params));
                } else {
                    const info = stmt.run(...params);
                    combinedChanges += info.changes;
                }
            } catch (error) {
                console.error('Database scatter error:', error.message, '\nSQL:', sql);
                throw error;
            }
        }

        if (cmd !== 'SELECT') {
            this._invalidateByTables(this._tablesInSql(text));
            return { rows: [], rowCount: combinedChanges };
        }

        const merged = this._mergeRows(text, combinedRows);
        const result = { rows: merged };
        this._cacheSet(cacheKey, result, this._tablesInSql(text));
        return result;
    }

    _mergeRows(sql, rows) {
        const countMatch = sql.match(/^\s*SELECT\s+COUNT\(\*\)\s+as\s+(\w+)\s+FROM/i);
        if (countMatch && rows.length) {
            const alias = countMatch[1];
            const total = rows.reduce((sum, r) => sum + (r[alias] || 0), 0);
            return [{ [alias]: total }];
        }
        const orderMatch = sql.match(/ORDER BY\s+([\s\S]+?)(?:\s+LIMIT\s+(\d+))?\s*$/i);
        if (!orderMatch) return rows;
        const orderClause = orderMatch[1];
        const limit = orderMatch[2] ? parseInt(orderMatch[2], 10) : null;
        const sortKeys = orderClause.split(',').map(part => {
            const [, col, dir] = part.trim().match(/([\w.]+)\s*(ASC|DESC)?/i) || [];
            const cleanCol = col ? col.split('.').pop() : null;
            return { col: cleanCol, desc: (dir || '').toUpperCase() === 'DESC' };
        }).filter(k => k.col);
        if (sortKeys.length) {
            rows.sort((a, b) => {
                for (const { col, desc } of sortKeys) {
                    const av = a[col], bv = b[col];
                    if (av === bv) continue;
                    const cmp = av > bv ? 1 : -1;
                    return desc ? -cmp : cmp;
                }
                return 0;
            });
        }
        return limit !== null ? rows.slice(0, limit) : rows;
    }

    _tablesInSql(sql) {
        const tables = new Set();
        const patterns = [/FROM\s+(\w+)/gi, /JOIN\s+(\w+)/gi, /INTO\s+(\w+)/gi, /UPDATE\s+(\w+)/gi];
        for (const re of patterns) {
            let m;
            while ((m = re.exec(sql)) !== null) tables.add(m[1].toLowerCase());
        }
        return [...tables];
    }

    _cacheSet(key, data, tables) {
        this.cache.set(key, { data, timestamp: Date.now(), tables });
        if (this.cache.size > this.cacheMaxEntries) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
    }

    _invalidateByTables(tables) {
        if (!tables.length) return;
        for (const [key, entry] of this.cache) {
            if (entry.tables && entry.tables.some(t => tables.includes(t))) {
                this.cache.delete(key);
            }
        }
    }

    invalidateCache() { this.cache.clear(); }
    clearCache() { this.cache.clear(); }

    followUser(followerId, followingId) {
        if (followerId === followingId) return { success: false, error: 'نمی‌توانید خودتان را فالو کنید' };
        const shardsInvolved = new Set([this.hashKey(followerId), this.hashKey(followingId)]);
        let alreadyFollowing = false;
        for (const idx of shardsInvolved) {
            const conn = this.shards[idx];
            const existing = conn.prepare(`SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?`).get(followerId, followingId);
            if (existing) alreadyFollowing = true;
        }
        if (alreadyFollowing) return { success: true, alreadyFollowing: true };
        for (const idx of shardsInvolved) {
            const conn = this.shards[idx];
            conn.prepare(`INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`).run(followerId, followingId);
        }
        const targetShard = this.shards[this.hashKey(followingId)];
        targetShard.prepare(`UPDATE channels SET followers_count = followers_count + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).run(followingId);
        this._invalidateByTables(['follows', 'channels']);
        return { success: true };
    }

    unfollowUser(followerId, followingId) {
        const shardsInvolved = new Set([this.hashKey(followerId), this.hashKey(followingId)]);
        let removed = false;
        for (const idx of shardsInvolved) {
            const conn = this.shards[idx];
            const info = conn.prepare(`DELETE FROM follows WHERE follower_id = ? AND following_id = ?`).run(followerId, followingId);
            if (info.changes > 0) removed = true;
        }
        if (removed) {
            const targetShard = this.shards[this.hashKey(followingId)];
            targetShard.prepare(`UPDATE channels SET followers_count = MAX(followers_count - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).run(followingId);
        }
        this._invalidateByTables(['follows', 'channels']);
        return { success: true };
    }

    blockUser(blockerId, blockedId) {
        const shardsInvolved = new Set([this.hashKey(blockerId), this.hashKey(blockedId)]);
        for (const idx of shardsInvolved) {
            this.shards[idx].prepare(`INSERT OR IGNORE INTO blocked_users (blocker_id, blocked_id, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`).run(blockerId, blockedId);
        }
        this._invalidateByTables(['blocked_users']);
        return { success: true };
    }

    unblockUser(blockerId, blockedId) {
        const shardsInvolved = new Set([this.hashKey(blockerId), this.hashKey(blockedId)]);
        for (const idx of shardsInvolved) {
            this.shards[idx].prepare(`DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?`).run(blockerId, blockedId);
        }
        this._invalidateByTables(['blocked_users']);
        return { success: true };
    }

    isBlocked(userA, userB) {
        const conn = this.shards[this.hashKey(userA)];
        const row = conn.prepare(`
            SELECT 1 FROM blocked_users 
            WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
            LIMIT 1
        `).get(userA, userB, userB, userA);
        return !!row;
    }

    toggleLike(postId, userId) {
        const shardIndex = this.resolveShardIndex(postId);
        const conn = this.shards[shardIndex];
        let liked, likes;
        const run = conn.transaction(() => {
            const existing = conn.prepare(`SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?`).get(postId, userId);
            if (existing) {
                conn.prepare(`DELETE FROM post_likes WHERE post_id = ? AND user_id = ?`).run(postId, userId);
                conn.prepare(`UPDATE posts SET likes = MAX(likes - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(postId);
                liked = false;
            } else {
                conn.prepare(`INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`).run(postId, userId);
                conn.prepare(`UPDATE posts SET likes = likes + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(postId);
                liked = true;
            }
            const p = conn.prepare(`SELECT likes FROM posts WHERE id = ?`).get(postId);
            likes = p?.likes || 0;
        });
        run();
        this._invalidateByTables(['posts', 'post_likes']);
        return { success: true, liked, likes };
    }

    async initTables() {
        const schema = `
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, bio TEXT,
                email TEXT, password_hash TEXT,
                score INTEGER DEFAULT 0, role TEXT DEFAULT 'user',
                is_verified INTEGER DEFAULT 0, restricted INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS channels (
                id TEXT PRIMARY KEY, user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL, description TEXT,
                posts_count INTEGER DEFAULT 0, followers_count INTEGER DEFAULT 0,
                boost_level TEXT DEFAULT 'normal', activity_score INTEGER DEFAULT 0,
                last_boost_calc TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS posts (
                id TEXT PRIMARY KEY, channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
                content TEXT NOT NULL, media_url TEXT, media_type TEXT CHECK (media_type IN ('image','video','audio','none')),
                views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, comments INTEGER DEFAULT 0,
                scheduled_time TEXT, is_published INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, published_at TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS assistant_training (
                id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                type TEXT CHECK (type IN ('qa','keyword')), question TEXT, answer TEXT, keyword TEXT, response TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY, from_user TEXT NOT NULL, to_user TEXT NOT NULL,
                message TEXT NOT NULL, is_read INTEGER DEFAULT 0, encrypted INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS follows (
                follower_id TEXT NOT NULL, following_id TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (follower_id, following_id)
            );
            CREATE TABLE IF NOT EXISTS post_likes (
                post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (post_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS post_comments (
                id TEXT PRIMARY KEY, post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL, text TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS system_notifications (
                id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL, message TEXT NOT NULL, type TEXT DEFAULT 'general',
                is_read INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL,
                target_id TEXT, target_type TEXT CHECK (target_type IN ('user','post','comment')),
                reason TEXT NOT NULL, status TEXT DEFAULT 'pending',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT
            );
            CREATE TABLE IF NOT EXISTS blocked_users (
                blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (blocker_id, blocked_id)
            );
            CREATE TABLE IF NOT EXISTS ads (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT,
                media_url TEXT, media_type TEXT DEFAULT 'none', link_url TEXT,
                is_active INTEGER DEFAULT 1, views INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS stories (
                id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                media_url TEXT NOT NULL, media_type TEXT CHECK (media_type IN ('image','video')),
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS payments (
                id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                receipt_url TEXT, status TEXT DEFAULT 'pending',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id);
            CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(is_published, scheduled_time);
            CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user, to_user);
            CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(to_user, is_read);
            CREATE INDEX IF NOT EXISTS idx_assistant_user ON assistant_training(user_id);
            CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id);
            CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
            CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
            CREATE INDEX IF NOT EXISTS idx_notifications_user ON system_notifications(user_id, is_read);
            CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
            CREATE INDEX IF NOT EXISTS idx_blocked_blocker ON blocked_users(blocker_id);
            CREATE INDEX IF NOT EXISTS idx_blocked_blocked ON blocked_users(blocked_id);
            CREATE INDEX IF NOT EXISTS idx_ads_active ON ads(is_active);
            CREATE INDEX IF NOT EXISTS idx_users_score ON users(score DESC);
            CREATE INDEX IF NOT EXISTS idx_channels_score ON channels(activity_score DESC);
            CREATE INDEX IF NOT EXISTS idx_stories_user ON stories(user_id);
            CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
            CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
        `;

        try {
            for (let i = 0; i < this.shards.length; i++) {
                const conn = this.shards[i];
                conn.exec(schema);
                if (i === DIRECTORY_SHARD) {
                    conn.exec(`CREATE TABLE IF NOT EXISTS _shard_directory (entity_id TEXT PRIMARY KEY, shard_index INTEGER NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
                }
                if (this.hashKey('admin_milad') === i) {
                    const adminCheck = conn.prepare(`SELECT id FROM users WHERE id = ?`).get('admin_milad');
                    if (!adminCheck) {
                        conn.exec(`
                            INSERT INTO users (id, name, avatar, email, password_hash, role, is_verified, score, created_at) 
                            VALUES ('admin_milad', 'مدیر سیستم', '/admin-avatar.png', 'milad.yari1377m@gmail.com', 'M09145978426mbn', 'admin', 1, 999999, CURRENT_TIMESTAMP);
                            INSERT INTO channels (id, user_id, name, boost_level, created_at) 
                            VALUES ('channel_admin', 'admin_milad', 'کانال مدیریت', 'superstar', CURRENT_TIMESTAMP);
                        `);
                        console.log(`✅ Admin user created on shard ${i}`);
                    }
                }
                try { conn.exec(`ALTER TABLE users ADD COLUMN email TEXT`); } catch (e) {}
                try { conn.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`); } catch (e) {}
                try { conn.exec(`ALTER TABLE users ADD COLUMN restricted INTEGER DEFAULT 0`); } catch (e) {}
            }
            console.log(`✅ ${this.shardCount} shard(s) ready, tables created/verified`);
        } catch (error) {
            console.error('Error creating tables:', error);
            throw error;
        }
    }

    transaction(key, fn) { const conn = this.getDb(key); return conn.transaction(fn); }
    backup() { const paths = []; for (let i = 0; i < this.shards.length; i++) { try { const backupPath = path.join(this.shardsDir, `backup_shard${i}_${Date.now()}.sqlite`); const backup = new Database(backupPath); this.shards[i].backup(backup); backup.close(); paths.push(backupPath); } catch (error) { console.error(`Backup error (shard ${i}):`, error); } } return paths; }
    vacuum() { for (const conn of this.shards) conn.exec('VACUUM'); }
    getStats() { const stats = { shardCount: this.shardCount, perShard: [] }; for (let i = 0; i < this.shards.length; i++) { const conn = this.shards[i]; const shardStats = {}; try { const tables = conn.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_shard%'`).all(); for (const table of tables) { const count = conn.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get(); shardStats[table.name] = count.count; } } catch (error) { console.error(`Stats error (shard ${i}):`, error); } stats.perShard.push(shardStats); } return stats; }
    close() { for (const conn of this.shards) conn.close(); }
}

module.exports = DatabaseManager;