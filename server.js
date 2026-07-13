const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const crypto = require('crypto');

// ============================================
// تنظیمات اولیه
// ============================================
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

// ============================================
// دیتابیس با قابلیت شاردینگ (Sharding)
// ============================================
class DatabaseManager {
    constructor() {
        // کانفیگ شاردها (برای مقیاس بالا)
        this.shards = [
            new Pool({
                host: 'localhost',
                port: 5432,
                database: 'chat_app_shard_0',
                user: 'postgres',
                password: 'your_password',
                max: 20
            }),
            new Pool({
                host: 'localhost',
                port: 5432,
                database: 'chat_app_shard_1',
                user: 'postgres',
                password: 'your_password',
                max: 20
            }),
            new Pool({
                host: 'localhost',
                port: 5432,
                database: 'chat_app_shard_2',
                user: 'postgres',
                password: 'your_password',
                max: 20
            })
        ];
        
        // جدول مسیریابی شاردها (Shard Mapping)
        this.shardMap = new Map();
    }
    
    // تابع هش برای تعیین شارد
    getShardId(key) {
        const hash = crypto.createHash('md5').update(key.toString()).digest('hex');
        const intHash = parseInt(hash.substring(0, 8), 16);
        return intHash % this.shards.length;
    }
    
    // دریافت اتصال به شارد مناسب
    getShard(key) {
        const shardId = this.getShardId(key);
        return this.shards[shardId];
    }
    
    // اجرای کوئری روی شارد مناسب
    async query(key, text, params) {
        const shard = this.getShard(key);
        try {
            const result = await shard.query(text, params);
            return result;
        } catch (error) {
            console.error('Database error:', error);
            throw error;
        }
    }
    
    // ایجاد جدول‌های اصلی (در هر شارد)
    async initTables() {
        const createTablesSQL = `
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) UNIQUE,
                avatar TEXT,
                score INTEGER DEFAULT 0,
                followers INTEGER DEFAULT 0,
                channel_id VARCHAR(50),
                assistant_id VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS channels (
                id VARCHAR(50) PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id),
                name VARCHAR(100) NOT NULL,
                description TEXT,
                posts_count INTEGER DEFAULT 0,
                followers_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS posts (
                id VARCHAR(50) PRIMARY KEY,
                channel_id VARCHAR(50) REFERENCES channels(id),
                content TEXT NOT NULL,
                media_url TEXT,
                media_type VARCHAR(20),
                views INTEGER DEFAULT 0,
                likes INTEGER DEFAULT 0,
                comments INTEGER DEFAULT 0,
                scheduled_time TIMESTAMP,
                is_published BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS assistant_training (
                id VARCHAR(50) PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id),
                type VARCHAR(20) CHECK (type IN ('qa', 'keyword')),
                question TEXT,
                answer TEXT,
                keyword VARCHAR(100),
                response TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS messages (
                id VARCHAR(50) PRIMARY KEY,
                from_user VARCHAR(50) REFERENCES users(id),
                to_user VARCHAR(50) REFERENCES users(id),
                message TEXT NOT NULL,
                is_read BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX idx_posts_channel ON posts(channel_id);
            CREATE INDEX idx_messages_users ON messages(from_user, to_user);
            CREATE INDEX idx_assistant_user ON assistant_training(user_id);
        `;
        
        for (const shard of this.shards) {
            try {
                await shard.query(createTablesSQL);
                console.log('✅ Tables created/verified in shard');
            } catch (error) {
                console.error('Error creating tables in shard:', error);
            }
        }
    }
}

const db = new DatabaseManager();

// ============================================
// API Routes
// ============================================

// 1. ذخیره‌سازی آموزش دستیار (سوال و جواب)
app.post('/api/assistant/train', async (req, res) => {
    try {
        const { userId, question, answer } = req.body;
        const id = crypto.randomUUID();
        
        await db.query(userId, `
            INSERT INTO assistant_training (id, user_id, type, question, answer)
            VALUES ($1, $2, $3, $4, $5)
        `, [id, userId, 'qa', question, answer]);
        
        // به‌روزرسانی امتیاز کاربر
        await db.query(userId, `
            UPDATE users SET score = score + 10 WHERE id = $1
        `, [userId]);
        
        res.json({ success: true, message: 'آموزش با موفقیت ثبت شد' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. ذخیره‌سازی کلمات کلیدی
app.post('/api/assistant/keyword', async (req, res) => {
    try {
        const { userId, keyword, response } = req.body;
        const id = crypto.randomUUID();
        
        await db.query(userId, `
            INSERT INTO assistant_training (id, user_id, type, keyword, response)
            VALUES ($1, $2, $3, $4, $5)
        `, [id, userId, 'keyword', keyword, response]);
        
        res.json({ success: true, message: 'کلمه کلیدی با موفقیت ثبت شد' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. زمان‌بندی پست‌های اتومات
app.post('/api/assistant/schedule', async (req, res) => {
    try {
        const { userId, postCount, descriptions, time } = req.body;
        const channel = await db.query(userId, `
            SELECT id FROM channels WHERE user_id = $1
        `, [userId]);
        
        if (channel.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });
        }
        
        const channelId = channel.rows[0].id;
        const scheduledPosts = [];
        
        for (let i = 0; i < postCount; i++) {
            const postId = crypto.randomUUID();
            const desc = descriptions[i] || `پست شماره ${i+1}`;
            
            // زمان انتشار (از امروز + i روز)
            const postDate = new Date();
            postDate.setDate(postDate.getDate() + i);
            const [hours, minutes] = time.split(':');
            postDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
            
            await db.query(userId, `
                INSERT INTO posts (id, channel_id, content, scheduled_time, is_published)
                VALUES ($1, $2, $3, $4, $5)
            `, [postId, channelId, desc, postDate, false]);
            
            scheduledPosts.push(postId);
        }
        
        res.json({ 
            success: true, 
            message: `${postCount} پست با موفقیت زمان‌بندی شد`,
            posts: scheduledPosts
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. دریافت داده‌های دستیار
app.get('/api/assistant/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // دریافت آموزش‌های سوال و جواب
        const qa = await db.query(userId, `
            SELECT question, answer FROM assistant_training 
            WHERE user_id = $1 AND type = 'qa'
            ORDER BY created_at DESC
        `, [userId]);
        
        // دریافت کلمات کلیدی
        const keywords = await db.query(userId, `
            SELECT keyword, response FROM assistant_training 
            WHERE user_id = $1 AND type = 'keyword'
            ORDER BY created_at DESC
        `, [userId]);
        
        // دریافت پست‌های زمان‌بندی شده
        const posts = await db.query(userId, `
            SELECT p.*, c.name as channel_name 
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = false
            ORDER BY p.scheduled_time ASC
        `, [userId]);
        
        res.json({
            qa: qa.rows,
            keywords: keywords.rows,
            posts: posts.rows,
            tasks: posts.rows.length + qa.rows.length + keywords.rows.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. دریافت پست‌های کانال
app.get('/api/channel/:userId/posts', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const result = await db.query(userId, `
            SELECT p.*, c.name as channel_name
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = true
            ORDER BY p.created_at DESC
            LIMIT 50
        `, [userId]);
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. ذخیره‌سازی پیام
app.post('/api/chat/save', async (req, res) => {
    try {
        const { from, to, message } = req.body;
        const id = crypto.randomUUID();
        
        // پیام‌ها بر اساس فرستنده شارد می‌شوند
        await db.query(from, `
            INSERT INTO messages (id, from_user, to_user, message)
            VALUES ($1, $2, $3, $4)
        `, [id, from, to, message]);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. دریافت تاریخچه چت
app.get('/api/chat/history/:userId/:targetId', async (req, res) => {
    try {
        const { userId, targetId } = req.params;
        
        const result = await db.query(userId, `
            SELECT * FROM messages 
            WHERE (from_user = $1 AND to_user = $2) 
               OR (from_user = $2 AND to_user = $1)
            ORDER BY created_at ASC
            LIMIT 100
        `, [userId, targetId]);
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 8. جستجو
app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        
        // جستجو در تمام شاردها (برای سادگی، فقط شارد اول)
        const result = await db.shards[0].query(`
            (SELECT id, name, 'user' as type FROM users WHERE name ILIKE $1)
            UNION
            (SELECT id, name, 'channel' as type FROM channels WHERE name ILIKE $1)
            LIMIT 20
        `, [`%${q}%`]);
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 9. اکسپلور (کانال‌های محبوب)
app.get('/api/explore', async (req, res) => {
    try {
        const result = await db.shards[0].query(`
            SELECT id, name, followers_count, posts_count
            FROM channels
            ORDER BY followers_count DESC
            LIMIT 20
        `);
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 10. دریافت لیست چت‌ها
app.get('/api/chat/list/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const result = await db.query(userId, `
            SELECT DISTINCT 
                CASE 
                    WHEN from_user = $1 THEN to_user
                    ELSE from_user
                END as chat_user_id,
                u.name,
                (
                    SELECT message FROM messages 
                    WHERE (from_user = u.id AND to_user = $1) 
                       OR (from_user = $1 AND to_user = u.id)
                    ORDER BY created_at DESC
                    LIMIT 1
                ) as last_message
            FROM messages m
            JOIN users u ON u.id = CASE WHEN m.from_user = $1 THEN m.to_user ELSE m.from_user END
            WHERE m.from_user = $1 OR m.to_user = $1
        `, [userId]);
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// WebSocket (ارسال پیام لحظه‌ای)
// ============================================
io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);
    
    socket.on('join', (userId) => {
        socket.join(`user_${userId}`);
        console.log(`User ${userId} joined their room`);
    });
    
    socket.on('private_message', (data) => {
        const { from, to, message, timestamp } = data;
        
        // ارسال به گیرنده
        io.to(`user_${to}`).emit('new_message', {
            from: from,
            fromName: 'کاربر',
            message: message,
            timestamp: timestamp
        });
        
        // ارسال تأیید به فرستنده
        socket.emit('message_sent', { success: true, timestamp });
    });
    
    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// ============================================
= راه‌اندازی سرور
// ============================================
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        // راه‌اندازی دیتابیس
        await db.initTables();
        console.log('✅ Database shards initialized');
        
        // شروع سرور
        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📍 http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();