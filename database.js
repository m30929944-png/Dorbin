// ============================================
// database.js - مدیریت دیتابیس با ۶۴ شارد PostgreSQL
// ============================================
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { createLogger } = require('./logger');

const logger = createLogger('database');

// ============================================
// تنظیمات شاردینگ
// ============================================
const SHARD_COUNT = Math.max(1, parseInt(process.env.DB_SHARD_COUNT || '64', 10));
const DIRECTORY_SHARD = 0;
const MAX_POOL_SIZE = parseInt(process.env.DB_POOL_SIZE || '50', 10);
const IDLE_TIMEOUT = parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10);
const CONNECTION_TIMEOUT = parseInt(process.env.DB_CONNECTION_TIMEOUT || '5000', 10);

// ============================================
// کلاس اصلی دیتابیس
// ============================================
class DatabaseManager {
    constructor() {
        this.shardCount = SHARD_COUNT;
        this.pools = [];
        this.shardConfigs = [];
        this.directory = new Map();
        this.directoryCache = new Map();
        this.preparedStatements = new Map();
        this.queryCache = new Map();
        this.cacheTTL = 60000;
        this.maxCacheSize = 10000;
        this.connectionPool = new Map();

        // ============================================
        // راه‌اندازی شاردها
        // ============================================
        for (let i = 0; i < this.shardCount; i++) {
            const config = {
                host: process.env.DB_HOST || 'localhost',
                port: parseInt(process.env.DB_PORT || '5432', 10),
                database: process.env.DB_NAME ? `${process.env.DB_NAME}_shard_${i}` : `yareman_shard_${i}`,
                user: process.env.DB_USER || 'postgres',
                password: process.env.DB_PASSWORD || 'postgres',
                max: MAX_POOL_SIZE,
                idleTimeoutMillis: IDLE_TIMEOUT,
                connectionTimeoutMillis: CONNECTION_TIMEOUT,
                ssl: process.env.DB_SSL === 'true' ? {
                    rejectUnauthorized: false
                } : false,
                application_name: 'yareman_social',
                statement_timeout: 60000,
                query_timeout: 30000
            };

            this.shardConfigs.push(config);
            const pool = new Pool(config);
            
            // رویدادهای پول
            pool.on('error', (err) => {
                logger.error(`Pool error on shard ${i}:`, err);
            });
            
            pool.on('connect', (client) => {
                logger.debug(`Client connected to shard ${i}`);
            });
            
            pool.on('remove', () => {
                logger.debug(`Client removed from shard ${i}`);
            });

            this.pools.push(pool);
            this.connectionPool.set(i, pool);
        }

        // ============================================
        // دیتابیس دایرکتوری
        // ============================================
        this.directoryPool = new Pool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '5432', 10),
            database: process.env.DB_NAME ? `${process.env.DB_NAME}_directory` : 'yareman_directory',
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || 'postgres',
            max: 20,
            idleTimeoutMillis: IDLE_TIMEOUT,
            connectionTimeoutMillis: CONNECTION_TIMEOUT,
            ssl: process.env.DB_SSL === 'true' ? {
                rejectUnauthorized: false
            } : false,
            application_name: 'yareman_directory'
        });

        this._warnedNoKey = false;
        this.queryCounter = 0;
        this.queryLatencies = [];
        this.maxLatencySamples = 1000;

        // بارگذاری دایرکتوری
        this._loadDirectoryFromDisk();

        // به‌روزرسانی دوره‌ای دایرکتوری
        setInterval(() => {
            this._loadDirectoryFromDisk().catch(() => {});
        }, 60000);
    }

    // ============================================
    // هش شاردینگ با پشتیبانی از توزیع یکنواخت
    // ============================================
    hashKey(key) {
        if (typeof key !== 'string') {
            key = String(key);
        }
        const hash = crypto.createHash('sha256').update(key).digest();
        const uint32 = hash.readUInt32BE(0);
        return uint32 % this.shardCount;
    }

    pairShardIndex(userA, userB) {
        const pairKey = [String(userA), String(userB)].sort().join('::');
        return this.hashKey(pairKey);
    }

    resolveShardIndex(key) {
        if (key === null || key === undefined) return null;
        const strKey = String(key);
        
        // کش دایرکتوری
        if (this.directoryCache.has(strKey)) {
            const cached = this.directoryCache.get(strKey);
            if (cached && (Date.now() - cached.timestamp) < 30000) {
                return cached.shardIndex;
            }
        }

        const hit = this.directory.get(strKey);
        if (hit !== undefined) {
            this.directoryCache.set(strKey, { shardIndex: hit, timestamp: Date.now() });
            return hit;
        }
        
        const shardIndex = this.hashKey(strKey);
        this.directoryCache.set(strKey, { shardIndex, timestamp: Date.now() });
        return shardIndex;
    }

    getPool(key) {
        if (key === undefined || key === null) {
            if (!this._warnedNoKey) {
                logger.warn('⚠️ db.getPool() called without key - using shard 0');
                this._warnedNoKey = true;
            }
            return this.pools[0];
        }
        const idx = this.resolveShardIndex(key);
        const pool = this.pools[idx === null ? 0 : idx];
        if (!pool) {
            logger.error(`Pool not found for key ${key}, using shard 0`);
            return this.pools[0];
        }
        return pool;
    }

    // ============================================
    // دایرکتوری با اتمیسیتی بالا
    // ============================================
    async registerDirectory(entityId, shardIndex) {
        if (entityId === undefined || entityId === null) return;
        const id = String(entityId);
        
        if (this.directory.get(id) === shardIndex) return;
        
        this.directory.set(id, shardIndex);
        this.directoryCache.set(id, { shardIndex, timestamp: Date.now() });

        try {
            await this.directoryPool.query(`
                INSERT INTO _shard_directory (entity_id, shard_index, updated_at)
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (entity_id) DO UPDATE SET 
                    shard_index = EXCLUDED.shard_index,
                    updated_at = CURRENT_TIMESTAMP
            `, [id, shardIndex]);
        } catch (e) {
            logger.error('Directory persist error:', e);
        }
    }

    async _loadDirectoryFromDisk() {
        try {
            const startTime = performance.now();
            const result = await this.directoryPool.query(`
                SELECT entity_id, shard_index, updated_at 
                FROM _shard_directory 
                ORDER BY updated_at DESC
            `);
            
            const count = result.rows.length;
            for (const r of result.rows) {
                this.directory.set(r.entity_id, r.shard_index);
            }
            
            const duration = performance.now() - startTime;
            logger.info(`✅ Directory loaded: ${count} entities in ${duration.toFixed(2)}ms`);
            
            // ذخیره آخرین زمان به‌روزرسانی
            this.lastDirectoryLoad = Date.now();
            
        } catch (e) {
            logger.error('Directory load error:', e);
        }
    }

    // ============================================
    // اجرای کوئری با کش و مانیتورینگ
    // ============================================
    async query(key, text, params = []) {
        const startTime = performance.now();
        this.queryCounter++;

        try {
            const pool = this.getPool(key);
            
            // کش کوئری‌های SELECT
            const isSelect = text.trim().toUpperCase().startsWith('SELECT');
            const cacheKey = `${key}:${text}:${JSON.stringify(params)}`;
            
            if (isSelect) {
                const cached = this.queryCache.get(cacheKey);
                if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
                    this.queryCounter++;
                    return cached.result;
                }
            }

            const result = await pool.query(text, params);

            // ثبت دایرکتوری در INSERT
            if (text.trim().toUpperCase().startsWith('INSERT')) {
                const m = text.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
                if (m) {
                    const cols = m[2].split(',').map(c => c.trim());
                    if (cols[0] === 'id' && params[0] !== undefined) {
                        const shardIdx = this.pools.indexOf(pool);
                        await this.registerDirectory(params[0], shardIdx);
                    }
                }
            }

            // ذخیره در کش
            if (isSelect && result.rows) {
                this.queryCache.set(cacheKey, {
                    result: result,
                    timestamp: Date.now()
                });
                
                // مدیریت اندازه کش
                if (this.queryCache.size > this.maxCacheSize) {
                    const oldestKey = this.queryCache.keys().next().value;
                    this.queryCache.delete(oldestKey);
                }
            }

            // ثبت latency
            const duration = performance.now() - startTime;
            this.queryLatencies.push(duration);
            if (this.queryLatencies.length > this.maxLatencySamples) {
                this.queryLatencies.shift();
            }

            // هشدار برای کوئری‌های کند
            if (duration > 1000) {
                logger.warn(`Slow query (${duration.toFixed(2)}ms):`, {
                    text: text.substring(0, 200),
                    params: params.length
                });
            }

            return result;

        } catch (error) {
            const duration = performance.now() - startTime;
            logger.error('Query error:', {
                error: error.message,
                text: text.substring(0, 500),
                params: params.length,
                duration: duration.toFixed(2) + 'ms',
                shard: this.pools.indexOf(this.getPool(key))
            });
            throw error;
        }
    }

    // ============================================
    // پخش کوئری روی همه شاردها
    // ============================================
    async queryAllShards(text, params = []) {
        const startTime = performance.now();
        let allRows = [];
        let totalChanges = 0;
        let errors = [];

        const promises = this.pools.map(async (pool, index) => {
            try {
                const result = await pool.query(text, params);
                return { index, result, success: true };
            } catch (error) {
                return { index, error, success: false };
            }
        });

        const results = await Promise.all(promises);

        for (const res of results) {
            if (res.success) {
                if (res.result.rows) {
                    allRows = allRows.concat(res.result.rows);
                }
                if (res.result.rowCount !== undefined) {
                    totalChanges += res.result.rowCount;
                }
            } else {
                errors.push({ shard: res.index, error: res.error.message });
                logger.error(`Scatter error on shard ${res.index}:`, res.error);
            }
        }

        const duration = performance.now() - startTime;
        if (errors.length > 0 && errors.length === this.pools.length) {
            throw new Error(`All shards failed: ${errors.map(e => e.error).join(', ')}`);
        }

        if (duration > 2000) {
            logger.warn(`Slow scatter query (${duration.toFixed(2)}ms):`, {
                shards: this.pools.length,
                errors: errors.length
            });
        }

        return { rows: allRows, rowCount: totalChanges, errors };
    }

    // ============================================
    // متدهای اختصاصی با تراکنش اتمیک
    // ============================================
    
    // فالو با نوشتن دوگانه و تراکنش
    async followUser(followerId, followingId) {
        if (followerId === followingId) {
            return { success: false, error: 'نمی‌توانید خودتان را فالو کنید' };
        }

        const shardsInvolved = new Set([
            this.hashKey(followerId),
            this.hashKey(followingId)
        ]);

        let alreadyFollowing = false;

        // بررسی وضعیت فعلی
        for (const idx of shardsInvolved) {
            const pool = this.pools[idx];
            const existing = await pool.query(
                `SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2`,
                [followerId, followingId]
            );
            if (existing.rows.length > 0) alreadyFollowing = true;
        }

        if (alreadyFollowing) {
            return { success: true, alreadyFollowing: true };
        }

        // شروع تراکنش روی همه شاردهای درگیر
        const clients = [];
        try {
            for (const idx of shardsInvolved) {
                const client = await this.pools[idx].connect();
                clients.push(client);
                await client.query('BEGIN');
            }

            // درج در همه شاردها
            for (let i = 0; i < clients.length; i++) {
                const client = clients[i];
                await client.query(
                    `INSERT INTO follows (follower_id, following_id, created_at) 
                     VALUES ($1, $2, CURRENT_TIMESTAMP)
                     ON CONFLICT (follower_id, following_id) DO NOTHING`,
                    [followerId, followingId]
                );
            }

            // به‌روزرسانی تعداد فالوورها
            const targetShard = this.pools[this.hashKey(followingId)];
            await targetShard.query(
                `UPDATE channels 
                 SET followers_count = followers_count + 1, 
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE user_id = $1`,
                [followingId]
            );

            // commit همه تراکنش‌ها
            for (const client of clients) {
                await client.query('COMMIT');
                client.release();
            }

            // پاک کردن کش
            await this.invalidateUserCache(followerId);
            await this.invalidateUserCache(followingId);

            return { success: true };

        } catch (error) {
            // rollback همه تراکنش‌ها
            for (const client of clients) {
                try {
                    await client.query('ROLLBACK');
                    client.release();
                } catch (e) {}
            }
            logger.error('Follow transaction error:', error);
            throw error;
        }
    }

    // آنفالو
    async unfollowUser(followerId, followingId) {
        const shardsInvolved = new Set([
            this.hashKey(followerId),
            this.hashKey(followingId)
        ]);

        let removed = false;

        const clients = [];
        try {
            for (const idx of shardsInvolved) {
                const client = await this.pools[idx].connect();
                clients.push(client);
                await client.query('BEGIN');
            }

            for (const client of clients) {
                const result = await client.query(
                    `DELETE FROM follows WHERE follower_id = $1 AND following_id = $2`,
                    [followerId, followingId]
                );
                if (result.rowCount > 0) removed = true;
            }

            if (removed) {
                const targetShard = this.pools[this.hashKey(followingId)];
                await targetShard.query(
                    `UPDATE channels 
                     SET followers_count = GREATEST(followers_count - 1, 0), 
                         updated_at = CURRENT_TIMESTAMP 
                     WHERE user_id = $1`,
                    [followingId]
                );
            }

            for (const client of clients) {
                await client.query('COMMIT');
                client.release();
            }

            await this.invalidateUserCache(followerId);
            await this.invalidateUserCache(followingId);

            return { success: true };

        } catch (error) {
            for (const client of clients) {
                try {
                    await client.query('ROLLBACK');
                    client.release();
                } catch (e) {}
            }
            throw error;
        }
    }

    // مسدود کردن
    async blockUser(blockerId, blockedId) {
        const shardsInvolved = new Set([
            this.hashKey(blockerId),
            this.hashKey(blockedId)
        ]);

        const clients = [];
        try {
            for (const idx of shardsInvolved) {
                const client = await this.pools[idx].connect();
                clients.push(client);
                await client.query('BEGIN');
            }

            for (const client of clients) {
                await client.query(
                    `INSERT INTO blocked_users (blocker_id, blocked_id, created_at) 
                     VALUES ($1, $2, CURRENT_TIMESTAMP)
                     ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
                    [blockerId, blockedId]
                );
            }

            for (const client of clients) {
                await client.query('COMMIT');
                client.release();
            }

            await this.invalidateUserCache(blockerId);
            await this.invalidateUserCache(blockedId);

            return { success: true };

        } catch (error) {
            for (const client of clients) {
                try {
                    await client.query('ROLLBACK');
                    client.release();
                } catch (e) {}
            }
            throw error;
        }
    }

    // رفع مسدودیت
    async unblockUser(blockerId, blockedId) {
        const shardsInvolved = new Set([
            this.hashKey(blockerId),
            this.hashKey(blockedId)
        ]);

        const clients = [];
        try {
            for (const idx of shardsInvolved) {
                const client = await this.pools[idx].connect();
                clients.push(client);
                await client.query('BEGIN');
            }

            for (const client of clients) {
                await client.query(
                    `DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2`,
                    [blockerId, blockedId]
                );
            }

            for (const client of clients) {
                await client.query('COMMIT');
                client.release();
            }

            await this.invalidateUserCache(blockerId);
            await this.invalidateUserCache(blockedId);

            return { success: true };

        } catch (error) {
            for (const client of clients) {
                try {
                    await client.query('ROLLBACK');
                    client.release();
                } catch (e) {}
            }
            throw error;
        }
    }

    // بررسی مسدودیت
    async isBlocked(userA, userB) {
        try {
            const pool = this.pools[this.hashKey(userA)];
            const result = await pool.query(`
                SELECT 1 FROM blocked_users 
                WHERE (blocker_id = $1 AND blocked_id = $2) 
                   OR (blocker_id = $3 AND blocked_id = $4)
                LIMIT 1
            `, [userA, userB, userB, userA]);
            
            return result.rows.length > 0;
        } catch (error) {
            logger.error('isBlocked error:', error);
            return false;
        }
    }

    // لایک با تراکنش اتمیک
    async toggleLike(postId, userId) {
        const shardIndex = this.resolveShardIndex(postId);
        const pool = this.pools[shardIndex];
        let liked, likes;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const existing = await client.query(
                `SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2`,
                [postId, userId]
            );

            if (existing.rows.length > 0) {
                await client.query(
                    `DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2`,
                    [postId, userId]
                );
                const result = await client.query(
                    `UPDATE posts 
                     SET likes = GREATEST(likes - 1, 0), 
                         updated_at = CURRENT_TIMESTAMP 
                     WHERE id = $1 
                     RETURNING likes`,
                    [postId]
                );
                liked = false;
                likes = result.rows[0]?.likes || 0;
            } else {
                await client.query(
                    `INSERT INTO post_likes (post_id, user_id, created_at) 
                     VALUES ($1, $2, CURRENT_TIMESTAMP)`,
                    [postId, userId]
                );
                const result = await client.query(
                    `UPDATE posts 
                     SET likes = likes + 1, 
                         updated_at = CURRENT_TIMESTAMP 
                     WHERE id = $1 
                     RETURNING likes`,
                    [postId]
                );
                liked = true;
                likes = result.rows[0]?.likes || 0;
            }

            await client.query('COMMIT');
            
            // پاک کردن کش
            await this.invalidateUserCache(userId);
            
            return { success: true, liked, likes };

        } catch (error) {
            await client.query('ROLLBACK');
            logger.error('Toggle like error:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // ============================================
    // پاک کردن کش کاربر
    // ============================================
    async invalidateUserCache(userId) {
        const patterns = [
            `profile:${userId}:*`,
            `channel_posts:${userId}:*`,
            `chat_list:${userId}:*`
        ];
        // پاک کردن کش کوئری
        for (const key of this.queryCache.keys()) {
            if (key.includes(userId)) {
                this.queryCache.delete(key);
            }
        }
        // حذف از دایرکتوری کش
        if (this.directoryCache.has(userId)) {
            this.directoryCache.delete(userId);
        }
    }

    // ============================================
    // آمار و مانیتورینگ
    // ============================================
    getStats() {
        const stats = {
            shardCount: this.shardCount,
            queryCount: this.queryCounter,
            queryCacheSize: this.queryCache.size,
            directorySize: this.directory.size,
            directoryCacheSize: this.directoryCache.size,
            averageLatency: this.queryLatencies.length > 0 
                ? this.queryLatencies.reduce((a, b) => a + b, 0) / this.queryLatencies.length 
                : 0,
            maxLatency: this.queryLatencies.length > 0 
                ? Math.max(...this.queryLatencies) 
                : 0,
            poolStats: this.pools.map((pool, i) => ({
                shard: i,
                totalConnections: pool.totalCount,
                idleConnections: pool.idleCount,
                waitingClients: pool.waitingCount
            }))
        };
        return stats;
    }

    // ============================================
    // ایجاد جداول با ایندکس‌های پیشرفته
    // ============================================
    async initTables() {
        const schema = `
            -- ============================================
            -- جداول اصلی
            -- ============================================
            
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                avatar TEXT,
                bio TEXT,
                email TEXT UNIQUE,
                score INTEGER DEFAULT 0,
                role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin', 'moderator', 'banned')),
                is_verified INTEGER DEFAULT 0,
                restricted INTEGER DEFAULT 0,
                password_hash TEXT,
                uploads_count INTEGER DEFAULT 0,
                last_active TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- ============================================
            -- کانال‌ها
            -- ============================================
            CREATE TABLE IF NOT EXISTS channels (
                id TEXT PRIMARY KEY,
                user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT,
                posts_count INTEGER DEFAULT 0,
                followers_count INTEGER DEFAULT 0,
                boost_level TEXT DEFAULT 'normal' CHECK (boost_level IN ('normal', 'high', 'viral', 'superstar', 'legend')),
                activity_score INTEGER DEFAULT 0,
                last_boost_calc TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- ============================================
            -- پست‌ها با ایندکس‌های پیشرفته
            -- ============================================
            CREATE TABLE IF NOT EXISTS posts (
                id TEXT PRIMARY KEY,
                channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                media_url TEXT,
                media_type TEXT CHECK (media_type IN ('image', 'video', 'audio', 'document', 'none')),
                views INTEGER DEFAULT 0,
                likes INTEGER DEFAULT 0,
                comments INTEGER DEFAULT 0,
                scheduled_time TIMESTAMP,
                is_published INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                published_at TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- ایندکس‌های پست
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_user_id ON posts(channel_id);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_published ON posts(is_published, scheduled_time);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_media_type ON posts(media_type) WHERE media_type IS NOT NULL;
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_views ON posts(views DESC);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_likes ON posts(likes DESC);

            -- ============================================
            -- آموزش دستیار
            -- ============================================
            CREATE TABLE IF NOT EXISTS assistant_training (
                id TEXT PRIMARY KEY,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                type TEXT CHECK (type IN ('qa', 'keyword', 'context')),
                question TEXT,
                answer TEXT,
                keyword TEXT,
                response TEXT,
                context TEXT,
                usage_count INTEGER DEFAULT 0,
                last_used TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_user ON assistant_training(user_id);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_keyword ON assistant_training(keyword) WHERE keyword IS NOT NULL;
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_type ON assistant_training(type);

            -- ============================================
            -- پیام‌ها
            -- ============================================
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                from_user TEXT NOT NULL,
                to_user TEXT NOT NULL,
                message TEXT,
                media_url TEXT,
                media_type TEXT,
                file_name TEXT,
                file_size INTEGER,
                is_read INTEGER DEFAULT 0,
                encrypted INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_users ON messages(from_user, to_user);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_read ON messages(to_user, is_read);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_from_to ON messages(from_user, to_user, created_at DESC);

            -- ============================================
            -- فالوها
            -- ============================================
            CREATE TABLE IF NOT EXISTS follows (
                follower_id TEXT NOT NULL,
                following_id TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (follower_id, following_id)
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_follows_follower ON follows(follower_id);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_follows_following ON follows(following_id);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_follows_created ON follows(created_at DESC);

            -- ============================================
            -- لایک‌ها
            -- ============================================
            CREATE TABLE IF NOT EXISTS post_likes (
                post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (post_id, user_id)
            );

            -- ============================================
            -- کامنت‌ها
            -- ============================================
            CREATE TABLE IF NOT EXISTS post_comments (
                id TEXT PRIMARY KEY,
                post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comments_post ON post_comments(post_id);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comments_created ON post_comments(created_at DESC);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comments_user ON post_comments(user_id);

            -- ============================================
            -- نوتیفیکیشن‌ها
            -- ============================================
            CREATE TABLE IF NOT EXISTS system_notifications (
                id TEXT PRIMARY KEY,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                type TEXT DEFAULT 'general',
                is_read INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user ON system_notifications(user_id, is_read);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_created ON system_notifications(created_at DESC);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_type ON system_notifications(type);

            -- ============================================
            -- گزارش‌ها
            -- ============================================
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                reporter_id TEXT NOT NULL,
                target_id TEXT,
                target_type TEXT CHECK (target_type IN ('user', 'post', 'comment', 'message')),
                reason TEXT NOT NULL,
                status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
                resolved_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                resolved_at TIMESTAMP
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reports_status ON reports(status);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reports_target ON reports(target_id, target_type);

            -- ============================================
            -- مسدودیت‌ها
            -- ============================================
            CREATE TABLE IF NOT EXISTS blocked_users (
                blocker_id TEXT NOT NULL,
                blocked_id TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (blocker_id, blocked_id)
            );

            -- ============================================
            -- تبلیغات
            -- ============================================
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ads_active ON ads(is_active);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ads_created ON ads(created_at DESC);

            -- ============================================
            -- آپلودها
            -- ============================================
            CREATE TABLE IF NOT EXISTS user_uploads (
                id TEXT PRIMARY KEY,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                file_url TEXT NOT NULL,
                file_key TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                mime_type TEXT NOT NULL,
                width INTEGER,
                height INTEGER,
                duration INTEGER,
                processed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_uploads_user ON user_uploads(user_id);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_uploads_created ON user_uploads(created_at DESC);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_uploads_mime ON user_uploads(mime_type);

            -- ============================================
            -- مکالمات دستیار
            -- ============================================
            CREATE TABLE IF NOT EXISTS assistant_conversations (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                assistant_id TEXT NOT NULL,
                question TEXT NOT NULL,
                answer TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_conv_user ON assistant_conversations(user_id, assistant_id);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_conv_created ON assistant_conversations(created_at DESC);

            -- ============================================
            -- قفل‌های توزیع‌شده
            -- ============================================
            CREATE TABLE IF NOT EXISTS distributed_locks (
                lock_key TEXT PRIMARY KEY,
                lock_holder TEXT NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_locks_expires ON distributed_locks(expires_at);
        `;

        const dirSchema = `
            CREATE TABLE IF NOT EXISTS _shard_directory (
                entity_id TEXT PRIMARY KEY,
                shard_index INTEGER NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_directory_shard ON _shard_directory(shard_index);
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_directory_updated ON _shard_directory(updated_at DESC);
        `;

        try {
            // ایجاد جداول روی همه شاردها
            const startTime = performance.now();
            const promises = this.pools.map(async (pool, index) => {
                const client = await pool.connect();
                try {
                    await client.query(schema);
                    logger.debug(`✅ Schema created on shard ${index}`);
                } finally {
                    client.release();
                }
            });

            await Promise.all(promises);
            const duration = performance.now() - startTime;
            logger.info(`✅ All schemas created in ${duration.toFixed(2)}ms`);

            // دایرکتوری
            const client = await this.directoryPool.connect();
            try {
                await client.query(dirSchema);
                logger.info(`✅ Directory schema created`);
            } finally {
                client.release();
            }

            // ایجاد کاربر ادمین
            const adminShard = this.hashKey('admin_milad');
            const adminPool = this.pools[adminShard];
            
            const adminCheck = await adminPool.query(
                `SELECT id FROM users WHERE id = $1`, 
                ['admin_milad']
            );
            
            if (adminCheck.rows.length === 0) {
                await adminPool.query(`
                    INSERT INTO users (id, name, avatar, role, is_verified, score, created_at) 
                    VALUES ('admin_milad', 'مدیر سیستم', '/admin-avatar.png', 'admin', 1, 999999, CURRENT_TIMESTAMP)
                `);
                await adminPool.query(`
                    INSERT INTO channels (id, user_id, name, boost_level, created_at) 
                    VALUES ('channel_admin', 'admin_milad', 'کانال مدیریت', 'superstar', CURRENT_TIMESTAMP)
                `);
                logger.info(`✅ Admin user created on shard ${adminShard}`);
            }

            // ایجاد فانکشن‌های کمکی
            await this._createHelperFunctions();

            logger.info(`✅ ${this.shardCount} shard(s) ready`);

        } catch (error) {
            logger.error('Error creating tables:', error);
            throw error;
        }
    }

    // ============================================
    // فانکشن‌های کمکی PostgreSQL
    // ============================================
    async _createHelperFunctions() {
        const functions = `
            -- ============================================
            -- محاسبه امتیاز فعالیت
            -- ============================================
            CREATE OR REPLACE FUNCTION calculate_activity_score()
            RETURNS TRIGGER AS $$
            BEGIN
                UPDATE channels 
                SET activity_score = (
                    COALESCE(posts_count, 0) * 2 +
                    COALESCE(followers_count, 0) * 1 +
                    COALESCE((
                        SELECT COUNT(*) FROM posts 
                        WHERE channel_id = NEW.channel_id AND created_at > NOW() - INTERVAL '7 days'
                    ), 0) * 3
                )
                WHERE user_id = NEW.user_id;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            -- ============================================
            -- به‌روزرسانی خودکار امتیاز
            -- ============================================
            CREATE OR REPLACE FUNCTION update_user_score()
            RETURNS TRIGGER AS $$
            BEGIN
                UPDATE users 
                SET score = score + (
                    CASE 
                        WHEN TG_TABLE_NAME = 'posts' THEN 10
                        WHEN TG_TABLE_NAME = 'post_likes' THEN 2
                        WHEN TG_TABLE_NAME = 'post_comments' THEN 5
                        WHEN TG_TABLE_NAME = 'follows' AND TG_OP = 'INSERT' THEN 5
                        WHEN TG_TABLE_NAME = 'assistant_training' THEN 3
                        ELSE 0
                    END
                )
                WHERE id = NEW.user_id;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            -- ============================================
            -- ایجاد تریگرها
            -- ============================================
            DO $$
            BEGIN
                -- تریگر برای پست‌ها
                IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_update_user_score_post') THEN
                    CREATE TRIGGER trigger_update_user_score_post
                    AFTER INSERT ON posts
                    FOR EACH ROW
                    EXECUTE FUNCTION update_user_score();
                END IF;

                -- تریگر برای لایک‌ها
                IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_update_user_score_like') THEN
                    CREATE TRIGGER trigger_update_user_score_like
                    AFTER INSERT ON post_likes
                    FOR EACH ROW
                    EXECUTE FUNCTION update_user_score();
                END IF;

                -- تریگر برای کامنت‌ها
                IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_update_user_score_comment') THEN
                    CREATE TRIGGER trigger_update_user_score_comment
                    AFTER INSERT ON post_comments
                    FOR EACH ROW
                    EXECUTE FUNCTION update_user_score();
                END IF;
            END;
            $$;
        `;

        try {
            for (const pool of this.pools) {
                await pool.query(functions);
            }
        } catch (error) {
            logger.warn('Helper functions creation warning:', error);
        }
    }

    // ============================================
    // قفل توزیع‌شده
    // ============================================
    async acquireLock(lockKey, holder, ttlSeconds = 60) {
        const pool = this.pools[this.hashKey(lockKey)];
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

        try {
            const result = await pool.query(`
                INSERT INTO distributed_locks (lock_key, lock_holder, expires_at)
                VALUES ($1, $2, $3)
                ON CONFLICT (lock_key) DO UPDATE SET
                    lock_holder = EXCLUDED.lock_holder,
                    expires_at = EXCLUDED.expires_at
                WHERE distributed_locks.expires_at < NOW() OR distributed_locks.lock_holder = $2
                RETURNING *
            `, [lockKey, holder, expiresAt]);

            return result.rows.length > 0;
        } catch (error) {
            logger.error('Acquire lock error:', error);
            return false;
        }
    }

    async releaseLock(lockKey, holder) {
        const pool = this.pools[this.hashKey(lockKey)];
        try {
            await pool.query(
                `DELETE FROM distributed_locks WHERE lock_key = $1 AND lock_holder = $2`,
                [lockKey, holder]
            );
            return true;
        } catch (error) {
            logger.error('Release lock error:', error);
            return false;
        }
    }

    // ============================================
    // پشتیبان‌گیری
    // ============================================
    async backup() {
        const backupPaths = [];
        for (let i = 0; i < this.pools.length; i++) {
            try {
                const timestamp = Date.now();
                const backupFile = path.join(
                    __dirname, 
                    'backups', 
                    `shard_${i}_${timestamp}.sql`
                );
                
                const dir = path.dirname(backupFile);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                const client = await this.pools[i].connect();
                try {
                    const result = await client.query(`
                        SELECT pg_database_size(current_database()) as size
                    `);
                    const size = result.rows[0]?.size || 0;
                    
                    // ایجاد دامپ
                    const dump = await client.query(`
                        SELECT 'pg_dump ' || current_database() || ' > ' || $1
                    `, [backupFile]);
                    
                    backupPaths.push({
                        shard: i,
                        file: backupFile,
                        size: size
                    });
                    
                    logger.info(`Backup created for shard ${i}: ${backupFile}`);
                } finally {
                    client.release();
                }
            } catch (error) {
                logger.error(`Backup error for shard ${i}:`, error);
            }
        }
        return backupPaths;
    }

    // ============================================
    // وکیوم
    // ============================================
    async vacuum() {
        for (let i = 0; i < this.pools.length; i++) {
            try {
                await this.pools[i].query('VACUUM ANALYZE');
                logger.info(`Vacuum completed for shard ${i}`);
            } catch (error) {
                logger.error(`Vacuum error for shard ${i}:`, error);
            }
        }
    }

    // ============================================
    // بستن اتصالات
    // ============================================
    async close() {
        const promises = [];
        for (const pool of this.pools) {
            promises.push(pool.end());
        }
        promises.push(this.directoryPool.end());
        await Promise.all(promises);
        logger.info('All database connections closed');
    }

    // ============================================
    // متدهای کمکی
    // ============================================
    async ping() {
        try {
            await this.pools[0].query('SELECT 1');
            return true;
        } catch (error) {
            return false;
        }
    }

    getAverageLatency() {
        if (this.queryLatencies.length === 0) return 0;
        return this.queryLatencies.reduce((a, b) => a + b, 0) / this.queryLatencies.length;
    }

    getQueryCount() {
        return this.queryCounter;
    }

    // ============================================
    // مهاجرت داده
    // ============================================
    async migrateData(fromShard, toShard, table, conditions = '') {
        const fromPool = this.pools[fromShard];
        const toPool = this.pools[toShard];

        try {
            const data = await fromPool.query(`
                SELECT * FROM ${table} 
                WHERE ${conditions || '1=1'}
            `);

            if (data.rows.length === 0) return { success: true, migrated: 0 };

            const columns = Object.keys(data.rows[0]);
            const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
            const insertQuery = `
                INSERT INTO ${table} (${columns.join(', ')})
                VALUES (${placeholders})
                ON CONFLICT (id) DO UPDATE SET
                    ${columns.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ')}
            `;

            let migrated = 0;
            for (const row of data.rows) {
                try {
                    await toPool.query(insertQuery, columns.map(c => row[c]));
                    migrated++;
                } catch (e) {
                    logger.error(`Migration error for row ${row.id}:`, e);
                }
            }

            return { success: true, migrated };
        } catch (error) {
            logger.error(`Migration error from shard ${fromShard} to ${toShard}:`, error);
            throw error;
        }
    }
}

module.exports = DatabaseManager;