// ============================================
// database.js - مدیریت دیتابیس با شاردینگ، کش هوشمند و رمزنگاری
// ============================================
//
// معماری شاردینگ:
//   - دیتابیس به N فایل SQLite مستقل (شارد) تقسیم می‌شه (پیش‌فرض ۱۵۰، با متغیر محیطی DB_SHARD_COUNT قابل تغییره).
//   - هر شارد کل اسکیمای جداول رو داره (نه تقسیم جدول‌ها، بلکه تقسیم ردیف‌ها بین فایل‌ها).
//   - هر ردیف بر اساس "صاحبِ" اون ردیف مسیریابی می‌شه: کاربر با هش(id) روی یه شارد ثابت قرار می‌گیره
//     و پست‌ها/کانال/کامنت‌ها/لایک‌های همون کاربر هم روی همون شارد ذخیره می‌شن (چون db.query با کلید userId صدا زده میشه).
//   - برای موجودیت‌هایی که بعداً با شناسه‌ی خودشون (نه شناسه‌ی صاحبشون) جستجو می‌شن (مثلاً پست با postId)
//     یه "دایرکتوری" کوچیک (entity_id -> shard_index) نگه می‌داریم که موقع INSERT خودکار پر می‌شه.
//   - برای رابطه‌هایی که ذاتاً بین دو کاربر مختلفن (پیام‌های چت) از هش زوجی (هش مشترک دو کاربر) استفاده می‌شه
//     تا کل مکالمه‌ی بین دو نفر همیشه روی یه شارد بمونه.
//   - فالو/آنفالو چون بین دو کاربر مختلفه و هم از سمت فالوور و هم از سمت فالووینگ خونده می‌شه،
//     با "نوشتن دوگانه" (dual-write) روی شارد هر دو کاربر ذخیره می‌شه.
//
// نکته مهم برای توسعه‌دهنده: سه نقطه در server.js مستقیماً db.getDb() رو بدون کلید صدا می‌زنن
// (فالو/آنفالو، لایک پست، ارسال همگانی ادمین). این‌ها فعلاً روی شارد ۰ اجرا می‌شن (fallback امن، کرش نمی‌کنن)
// ولی برای مقیاس واقعی باید به متدهای جدید db.followUser/db.unfollowUser/db.toggleLike سوییچ کنن
// و broadcast باید روی db.getAllShards() لوپ بزنه. جزئیات پایین فایل.
// ============================================
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const SHARD_COUNT = Math.max(1, parseInt(process.env.DB_SHARD_COUNT || '150', 10));
const DIRECTORY_SHARD = 0; // شاردی که جدول دایرکتوری روش نگه داشته می‌شه

class DatabaseManager {
    constructor() {
        this.shardCount = SHARD_COUNT;
        this.shardsDir = path.join(__dirname, 'shards');
        if (!fs.existsSync(this.shardsDir)) fs.mkdirSync(this.shardsDir, { recursive: true });

        // ==========================================
        // کش حافظه با سقف اندازه (LRU تقریبی) و ابطال آگاه از جدول
        // ==========================================
        this.cache = new Map(); // cacheKey -> { data, timestamp, tables: [] }
        this.cacheTTL = 60000; // ۶۰ ثانیه
        this.cacheMaxEntries = 3000;

        // دایرکتوری entity_id -> shard_index (در حافظه، پشتیبان‌گیری‌شده روی shard 0)
        this.directory = new Map();

        // کلید رمزنگاری - هر بار اجرای encrypt() یک IV تصادفی جدید تولید می‌کنه (رفع باگ استفاده مجدد از IV)
        this.encryptionKey = crypto.randomBytes(32);

        // ==========================================
        // اتصال به همه شاردها
        // ==========================================
        this.shards = [];
        for (let i = 0; i < this.shardCount; i++) {
            const dbPath = path.join(this.shardsDir, `shard_${i}.sqlite`);
            const conn = new Database(dbPath);
            conn.pragma('journal_mode = WAL');
            conn.pragma('foreign_keys = ON');
            conn.pragma('cache_size = 10000');
            conn.pragma('synchronous = NORMAL');
            conn.pragma('temp_store = MEMORY');
            this.shards.push(conn);
        }

        this._warnedNoKey = false;
        this.initTables();
        this._loadDirectoryFromDisk();
    }

    // ============================================
    // رمزنگاری و رمزگشایی (AES-256-GCM با IV تصادفی به‌ازای هر پیام)
    // ============================================
    encrypt(text) {
        try {
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
            const parts = encryptedText.split(':');
            if (parts.length !== 3) return encryptedText; // متن قدیمی/رمزنگاری‌نشده
            const [ivHex, encrypted, authTag] = parts;
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(ivHex, 'hex'));
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
    // هش رمز عبور (scrypt - بدون نیاز به وابستگی خارجی مثل bcrypt)
    // فرمت ذخیره‌سازی: salt(hex):hash(hex)
    // ============================================
    hashPassword(password) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
        return `${salt}:${hash}`;
    }

    verifyPassword(password, stored) {
        try {
            if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
            const [salt, hash] = stored.split(':');
            const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
            const a = Buffer.from(hash, 'hex');
            const b = Buffer.from(check, 'hex');
            if (a.length !== b.length) return false;
            return crypto.timingSafeEqual(a, b);
        } catch (e) {
            return false;
        }
    }

    // جستجوی کاربر با یوزرنیم یا ایمیل روی همه‌ی شاردها (چون شاردبندی بر اساس id کاربره، نه یوزرنیم/ایمیل)
    findUserByUsernameOrEmail(usernameOrEmail) {
        const val = String(usernameOrEmail || '').trim().toLowerCase();
        if (!val) return null;
        for (const conn of this.shards) {
            const row = conn.prepare(`SELECT * FROM users WHERE lower(username) = ? OR lower(email) = ?`).get(val, val);
            if (row) return row;
        }
        return null;
    }

    // ============================================
    // شاردینگ - هش سازگار (consistent hashing ساده با mod)
    // ============================================
    hashKey(key) {
        const hash = crypto.createHash('md5').update(String(key)).digest();
        return hash.readUInt32BE(0) % this.shardCount;
    }

    // زوج دو کاربر رو مستقل از ترتیب (from/to) به یه شارد ثابت می‌فرسته
    // تا کل مکالمه‌ی بین این دو نفر همیشه روی یه فایل بمونه
    pairShardIndex(userA, userB) {
        const pairKey = [String(userA), String(userB)].sort().join('::');
        return this.hashKey(pairKey);
    }

    // شناسه‌ی یک موجودیت (مثل postId) رو به شاردی که واقعاً توش ساخته شده resolve می‌کنه.
    // اگه در دایرکتوری ثبت نشده باشه (یعنی خودش یه شناسه‌ی سطح‌بالا مثل userId هست) از هش مستقیم استفاده می‌کنه.
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
        } catch (e) {
            console.error('Directory persist error:', e.message);
        }
    }

    _loadDirectoryFromDisk() {
        try {
            const rows = this.shards[DIRECTORY_SHARD].prepare(`SELECT entity_id, shard_index FROM _shard_directory`).all();
            for (const r of rows) this.directory.set(r.entity_id, r.shard_index);
            console.log(`✅ Directory loaded: ${rows.length} entity mappings`);
        } catch (e) {
            console.error('Directory load error:', e.message);
        }
    }

    // اگه INSERT روی ستون اول id باشه (الگوی رایج این پروژه: INSERT INTO table (id, ...))
    // اون id رو خودکار در دایرکتوری به شارد فعلی وصل می‌کنه تا کوئری‌های بعدی با همون id درست مسیریابی بشن.
    _maybeRegisterFromInsert(sql, params, shardIndex) {
        const m = sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
        if (!m) return;
        const cols = m[2].split(',').map(c => c.trim());
        if (cols[0] === 'id' && params && params[0] !== undefined) {
            this.registerDirectory(params[0], shardIndex);
        }
    }

    getAllShards() {
        return this.shards;
    }

    // دسترسی مستقیم به یک اتصال شارد برای تراکنش‌های دستی (like قدیمی server.js از این استفاده می‌کنه)
    getDb(key) {
        if (key === undefined) {
            if (!this._warnedNoKey) {
                console.warn('⚠️  db.getDb() بدون کلید صدا زده شد - شارد ۰ استفاده می‌شه. برای مقیاس واقعی از db.getDb(key) یا متدهای اختصاصی (followUser/toggleLike) استفاده کن.');
                this._warnedNoKey = true;
            }
            return this.shards[0];
        }
        const idx = this.resolveShardIndex(key);
        return this.shards[idx === null ? 0 : idx];
    }

    // ============================================
    // اجرای کوئری با مسیریابی شارد + کش
    // ============================================
    async query(key, text, params = []) {
        const cmd = text.trim().slice(0, 6).toUpperCase();
        const messagesRoute = this._routeMessagesQuery(text, params);

        // مسیریابی ویژه جدول messages (زوج کاربر یا پخش بین همه‌ی شاردها)
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

        // INSERT INTO messages (id, from_user, to_user, message, ...)
        if (/INSERT\s+INTO\s+messages/i.test(sql)) {
            // ترتیب پارامترها در این پروژه همیشه [id, from, to, message] هست
            const from = params[1], to = params[2];
            if (from !== undefined && to !== undefined) {
                return { mode: 'single', shard: this.pairShardIndex(from, to) };
            }
            return null;
        }

        // تاریخچه‌ی بین دو کاربر مشخص: (from_user=$1 AND to_user=$2) OR (from_user=$2 AND to_user=$1)
        if (/from_user\s*=\s*\$1[\s\S]*to_user\s*=\s*\$2[\s\S]*from_user\s*=\s*\$2/i.test(sql)) {
            const a = params[0], b = params[1];
            if (a !== undefined && b !== undefined) {
                return { mode: 'single', shard: this.pairShardIndex(a, b) };
            }
        }

        // لیست مکالمات یک کاربر (from_user=$1 OR to_user=$1) - چون مکالمات مختلف رو شاردهای مختلف پخشن، باید همه رو گشت
        if (/from_user\s*=\s*\$1\s*OR\s*to_user\s*=\s*\$1/i.test(sql) || /WHERE\s+from_user\s*=\s*\$1\s+OR\s+to_user\s*=\s*\$1/i.test(sql)) {
            return { mode: 'scatter' };
        }
        // UPDATE messages SET is_read ... WHERE from_user=$1 AND to_user=$2 (خوانده‌شدن) - زوج مشخص
        if (/UPDATE\s+messages/i.test(sql) && params.length >= 2) {
            return { mode: 'single', shard: this.pairShardIndex(params[0], params[1]) };
        }
        // هر حالت دیگه‌ای که مطمئن نیستیم (مثلاً COUNT کلی) رو پخش می‌کنیم تا داده گم نشه
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

    // پخش کوئری بین همه‌ی شاردها و ادغام نتایج (برای کلید null یا وقتی صاحب مشخصی نداریم)
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

    // ادغام هوشمند نتایج چند شارد: جمع COUNT(*)، یا اعمال دوباره‌ی ORDER BY/LIMIT روی نتایج ترکیب‌شده
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

    // به‌جای پاک کردن کل کش در هر نوشتن، فقط رکوردهایی که به جدول(های) تغییریافته وابسته‌ن پاک می‌شن
    _invalidateByTables(tables) {
        if (!tables.length) return;
        for (const [key, entry] of this.cache) {
            if (entry.tables && entry.tables.some(t => tables.includes(t))) {
                this.cache.delete(key);
            }
        }
    }

    invalidateCache() {
        this.cache.clear();
    }
    clearCache() {
        this.cache.clear();
    }

    // ============================================
    // متدهای اختصاصی و شارد-ایمن برای رابطه‌های چندکاربره
    // (این‌ها جایگزین امنِ تراکنش‌های دستی db.getDb() در server.js هستن)
    // ============================================

    // فالو کردن با نوشتن دوگانه: هم روی شارد فالوور، هم روی شارد فالووینگ
    // تا هم «کیا رو فالو کردم» و هم «کیا فالوم کردن» بدون جست‌وجوی بین‌شاردی جواب داده بشه
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
            conn.prepare(`INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`)
                .run(followerId, followingId);
        }
        // followers_count روی شارد صاحب کانال (followingId) نگه داشته می‌شه
        const targetShard = this.shards[this.hashKey(followingId)];
        targetShard.prepare(`UPDATE channels SET followers_count = followers_count + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`)
            .run(followingId);

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
            targetShard.prepare(`UPDATE channels SET followers_count = MAX(followers_count - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`)
                .run(followingId);
        }
        this._invalidateByTables(['follows', 'channels']);
        return { success: true };
    }

    // مسدود کردن کاربر در چت خصوصی - نوشتن دوگانه مثل فالو، چون بین دو کاربر مختلفه
    blockUser(blockerId, blockedId) {
        const shardsInvolved = new Set([this.hashKey(blockerId), this.hashKey(blockedId)]);
        for (const idx of shardsInvolved) {
            this.shards[idx].prepare(`INSERT OR IGNORE INTO blocked_users (blocker_id, blocked_id, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`)
                .run(blockerId, blockedId);
        }
        this._invalidateByTables(['blocked_users']);
        return { success: true };
    }

    unblockUser(blockerId, blockedId) {
        const shardsInvolved = new Set([this.hashKey(blockerId), this.hashKey(blockedId)]);
        for (const idx of shardsInvolved) {
            this.shards[idx].prepare(`DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?`)
                .run(blockerId, blockedId);
        }
        this._invalidateByTables(['blocked_users']);
        return { success: true };
    }

    // آیا هر یک از این دو کاربر دیگری رو مسدود کرده؟ (برای جلوگیری از ارسال پیام)
    isBlocked(userA, userB) {
        const conn = this.shards[this.hashKey(userA)];
        const row = conn.prepare(`
            SELECT 1 FROM blocked_users 
            WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
            LIMIT 1
        `).get(userA, userB, userB, userA);
        return !!row;
    }

    // لایک/آنلایک یک پست - شارد از روی دایرکتوری postId پیدا می‌شه (همون شاردی که پست موقع ساخت روش ثبت شد)
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

    // ============================================
    // ایجاد جداول (روی همه‌ی شاردها)
    // ============================================
    async initTables() {
        const schema = `
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                username TEXT,
                email TEXT,
                password_hash TEXT,
                avatar TEXT,
                bio TEXT,
                score INTEGER DEFAULT 0,
                role TEXT DEFAULT 'user',
                is_verified INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

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

            -- توجه: follower_id/following_id و from_user/to_user عمداً بدون REFERENCES هستن،
            -- چون ممکنه صاحب هر طرف روی شارد دیگه‌ای باشه و SQLite نمی‌تونه FK بین فایل‌ها رو چک کنه.
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                from_user TEXT NOT NULL,
                to_user TEXT NOT NULL,
                message TEXT NOT NULL,
                media_url TEXT,
                media_type TEXT,
                is_read INTEGER DEFAULT 0,
                encrypted INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS follows (
                follower_id TEXT NOT NULL,
                following_id TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (follower_id, following_id)
            );

            -- استوری: مثل استوری اینستاگرام - عکس/ویدیو/متن، ۲۴ ساعته منقضی می‌شه، قابلیت هایلایت دائمی داره
            CREATE TABLE IF NOT EXISTS stories (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                media_url TEXT,
                media_type TEXT DEFAULT 'image' CHECK (media_type IN ('image', 'video', 'text')),
                caption TEXT,
                bg_color TEXT DEFAULT '#6c5ce7',
                text_color TEXT DEFAULT '#ffffff',
                views_count INTEGER DEFAULT 0,
                is_highlight INTEGER DEFAULT 0,
                highlight_title TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                expires_at TEXT NOT NULL
            );

            -- کی استوری رو دیده - برای «بازدیدکنندگان استوری» حرفه‌ای
            CREATE TABLE IF NOT EXISTS story_views (
                id TEXT PRIMARY KEY,
                story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
                viewer_id TEXT NOT NULL,
                viewed_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS post_likes (
                post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (post_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS post_comments (
                id TEXT PRIMARY KEY,
                post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                user_name TEXT,
                user_avatar TEXT,
                text TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS system_notifications (
                id TEXT PRIMARY KEY,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                type TEXT DEFAULT 'general',
                broadcast_id TEXT,
                is_read INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                reporter_id TEXT NOT NULL,
                target_id TEXT,
                target_type TEXT CHECK (target_type IN ('user', 'post', 'comment')),
                reason TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                resolved_at TEXT
            );

            -- مثل follows، بین دو کاربر ممکنه روی شاردهای متفاوت باشن، بدون REFERENCES بین‌فایلی
            CREATE TABLE IF NOT EXISTS blocked_users (
                blocker_id TEXT NOT NULL,
                blocked_id TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (blocker_id, blocked_id)
            );

            CREATE TABLE IF NOT EXISTS ads (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT,
                media_url TEXT,
                media_type TEXT DEFAULT 'none',
                link_url TEXT,
                is_active INTEGER DEFAULT 1,
                views INTEGER DEFAULT 0,
                clicks INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

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
            CREATE INDEX IF NOT EXISTS idx_blocked_blocker ON blocked_users(blocker_id);
            CREATE INDEX IF NOT EXISTS idx_blocked_blocked ON blocked_users(blocked_id);
            CREATE INDEX IF NOT EXISTS idx_ads_active ON ads(is_active);
            CREATE INDEX IF NOT EXISTS idx_users_score ON users(score DESC);
            CREATE INDEX IF NOT EXISTS idx_channels_score ON channels(activity_score DESC);
        `;

        try {
            for (let i = 0; i < this.shards.length; i++) {
                const conn = this.shards[i];
                conn.exec(schema);

                if (i === DIRECTORY_SHARD) {
                    conn.exec(`
                        CREATE TABLE IF NOT EXISTS _shard_directory (
                            entity_id TEXT PRIMARY KEY,
                            shard_index INTEGER NOT NULL,
                            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                        );
                    `);
                }

                // کاربر ادمین باید روی شارد مشخصی باشه که همیشه یکسان resolve بشه: hash('admin_milad')
                if (this.hashKey('admin_milad') === i) {
                    const ADMIN_USERNAME = 'milad13777';
                    const ADMIN_EMAIL = 'milad.yari1377m@gmail.com';
                    const ADMIN_PASSWORD = 'M09145978426mbn';

                    const adminCheck = conn.prepare(`SELECT id, password_hash FROM users WHERE id = ?`).get('admin_milad');
                    if (!adminCheck) {
                        const pwHash = this.hashPassword(ADMIN_PASSWORD);
                        conn.prepare(`
                            INSERT INTO users (id, name, username, email, password_hash, avatar, role, is_verified, score, created_at)
                            VALUES ('admin_milad', 'مدیر سیستم', ?, ?, ?, '/admin-avatar.png', 'admin', 1, 999999, CURRENT_TIMESTAMP)
                        `).run(ADMIN_USERNAME, ADMIN_EMAIL, pwHash);

                        conn.exec(`
                            INSERT INTO channels (id, user_id, name, boost_level, created_at) 
                            VALUES ('channel_admin', 'admin_milad', 'کانال مدیریت', 'superstar', CURRENT_TIMESTAMP);
                        `);
                        console.log(`✅ Admin user created on shard ${i}`);
                    } else if (!adminCheck.password_hash) {
                        // پایگاه‌داده‌ی قدیمی: ادمین از قبل ساخته شده ولی هنوز یوزرنیم/رمز نداره - تکمیلش می‌کنیم
                        const pwHash = this.hashPassword(ADMIN_PASSWORD);
                        conn.prepare(`UPDATE users SET username = ?, email = ?, password_hash = ? WHERE id = 'admin_milad'`)
                            .run(ADMIN_USERNAME, ADMIN_EMAIL, pwHash);
                        console.log(`✅ Admin credentials backfilled on shard ${i}`);
                    }
                }

                // ستون‌های جدیدی که ممکنه روی دیتابیس‌های قدیمی‌تر نبوده باشن
                try { conn.exec(`ALTER TABLE messages ADD COLUMN encrypted INTEGER DEFAULT 0`); } catch (e) {}
                try { conn.exec(`ALTER TABLE messages ADD COLUMN media_url TEXT`); } catch (e) {}
                try { conn.exec(`ALTER TABLE messages ADD COLUMN media_type TEXT`); } catch (e) {}
                try { conn.exec(`ALTER TABLE users ADD COLUMN bio TEXT`); } catch (e) {}
                try { conn.exec(`ALTER TABLE users ADD COLUMN restricted INTEGER DEFAULT 0`); } catch (e) {}
                try { conn.exec(`ALTER TABLE users ADD COLUMN username TEXT`); } catch (e) {}
                try { conn.exec(`ALTER TABLE users ADD COLUMN email TEXT`); } catch (e) {}
                try { conn.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`); } catch (e) {}
                try { conn.exec(`ALTER TABLE post_comments ADD COLUMN user_name TEXT`); } catch (e) {}
                try { conn.exec(`ALTER TABLE post_comments ADD COLUMN user_avatar TEXT`); } catch (e) {}
                try { conn.exec(`ALTER TABLE system_notifications ADD COLUMN broadcast_id TEXT`); } catch (e) {}
                try { conn.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL`); } catch (e) {}
                try { conn.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL`); } catch (e) {}

                // جدول رسیدهای پرداخت (ارتقاء حساب) - هر کاربر فیش واریزی آپلود می‌کنه، ادمین تایید/رد می‌کنه
                conn.exec(`
                    CREATE TABLE IF NOT EXISTS payment_receipts (
                        id TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL,
                        post_id TEXT,
                        receipt_image TEXT NOT NULL,
                        amount TEXT,
                        status TEXT DEFAULT 'pending',
                        admin_note TEXT,
                        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                        reviewed_at TEXT
                    );
                `);
                try { conn.exec(`CREATE INDEX IF NOT EXISTS idx_receipts_status ON payment_receipts(status)`); } catch (e) {}
                try { conn.exec(`CREATE INDEX IF NOT EXISTS idx_receipts_user ON payment_receipts(user_id)`); } catch (e) {}
                try { conn.exec(`CREATE INDEX IF NOT EXISTS idx_stories_user_expiry ON stories(user_id, expires_at)`); } catch (e) {}
                try { conn.exec(`CREATE INDEX IF NOT EXISTS idx_stories_highlight ON stories(user_id, is_highlight)`); } catch (e) {}
                try { conn.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_story_view_unique ON story_views(story_id, viewer_id)`); } catch (e) {}
                try { conn.exec(`CREATE INDEX IF NOT EXISTS idx_story_views_story ON story_views(story_id)`); } catch (e) {}
            }

            console.log(`✅ ${this.shardCount} shard(s) ready, tables created/verified`);
        } catch (error) {
            console.error('Error creating tables:', error);
            throw error;
        }
    }

    // ============================================
    // متدهای کمکی
    // ============================================
    transaction(key, fn) {
        const conn = this.getDb(key);
        return conn.transaction(fn);
    }

    backup() {
        const paths = [];
        for (let i = 0; i < this.shards.length; i++) {
            try {
                const backupPath = path.join(this.shardsDir, `backup_shard${i}_${Date.now()}.sqlite`);
                const backup = new Database(backupPath);
                this.shards[i].backup(backup);
                backup.close();
                paths.push(backupPath);
            } catch (error) {
                console.error(`Backup error (shard ${i}):`, error);
            }
        }
        return paths;
    }

    vacuum() {
        for (const conn of this.shards) conn.exec('VACUUM');
    }

    getStats() {
        const stats = { shardCount: this.shardCount, perShard: [] };
        for (let i = 0; i < this.shards.length; i++) {
            const conn = this.shards[i];
            const shardStats = {};
            try {
                const tables = conn.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_shard%'`).all();
                for (const table of tables) {
                    const count = conn.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
                    shardStats[table.name] = count.count;
                }
            } catch (error) {
                console.error(`Stats error (shard ${i}):`, error);
            }
            stats.perShard.push(shardStats);
        }
        return stats;
    }

    close() {
        for (const conn of this.shards) conn.close();
    }
}

module.exports = DatabaseManager;
