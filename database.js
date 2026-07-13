// ============================================
// database.js - مدیریت دیتابیس با شاردینگ
// ============================================

const { Pool } = require('pg');
const crypto = require('crypto');

class ShardedDatabase {
    constructor(config) {
        // تنظیمات شاردها
        this.shards = config.shards.map(shardConfig => new Pool(shardConfig));
        this.shardCount = this.shards.length;
        
        // کش برای مسیریابی
        this.shardCache = new Map();
    }
    
    // تابع هش برای تعیین شارد
    getShardId(key) {
        if (this.shardCache.has(key)) {
            return this.shardCache.get(key);
        }
        
        const hash = crypto.createHash('sha256').update(key.toString()).digest('hex');
        const intHash = parseInt(hash.substring(0, 8), 16);
        const shardId = intHash % this.shardCount;
        
        this.shardCache.set(key, shardId);
        return shardId;
    }
    
    // دریافت شارد بر اساس کلید
    getShard(key) {
        const shardId = this.getShardId(key);
        return this.shards[shardId];
    }
    
    // اجرای کوئری
    async query(key, text, params) {
        const shard = this.getShard(key);
        try {
            const result = await shard.query(text, params);
            return result;
        } catch (error) {
            console.error(`Shard query error (key: ${key}):`, error);
            throw error;
        }
    }
    
    // اجرای کوئری روی همه‌ی شاردها (برای گزارش‌گیری)
    async queryAllShards(text, params) {
        const results = [];
        for (const shard of this.shards) {
            try {
                const result = await shard.query(text, params);
                results.push(...result.rows);
            } catch (error) {
                console.error('Query all shards error:', error);
            }
        }
        return results;
    }
    
    // بستن همه‌ی اتصالات
    async close() {
        for (const shard of this.shards) {
            await shard.end();
        }
    }
    
    // ایجاد جدول‌ها در همه‌ی شاردها
    async initTables(schemaSQL) {
        for (const shard of this.shards) {
            try {
                await shard.query(schemaSQL);
                console.log('✅ Tables created in shard');
            } catch (error) {
                console.error('Error creating tables in shard:', error);
            }
        }
    }
}

// ============================================
// نمونه‌سازی برای استفاده
// ============================================
const db = new ShardedDatabase({
    shards: [
        {
            host: 'localhost',
            port: 5432,
            database: 'chat_app_shard_0',
            user: 'postgres',
            password: 'your_password',
            max: 20
        },
        {
            host: 'localhost',
            port: 5432,
            database: 'chat_app_shard_1',
            user: 'postgres',
            password: 'your_password',
            max: 20
        },
        {
            host: 'localhost',
            port: 5432,
            database: 'chat_app_shard_2',
            user: 'postgres',
            password: 'your_password',
            max: 20
        }
    ]
});

module.exports = db;