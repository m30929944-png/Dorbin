// ============================================================
// m2.js - سرویس پست‌ها با شاردینگ و کش
// ============================================================

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.POST_SERVICE_PORT || 3001;

// ===== تنظیمات =====
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-min-32-chars-here!!!';
const UPLOAD_DIR = './uploads';
const CACHE_TTL = 300; // 5 دقیقه

// ===== Redis برای کش =====
const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || '',
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

redis.on('connect', () => console.log('✅ Redis متصل شد'));
redis.on('error', (err) => console.error('❌ Redis error:', err));

// ===== Prisma =====
const prisma = new PrismaClient();

// ===== میدلورها =====
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

// ===== میدلور احراز هویت =====
function authenticate(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'لطفاً وارد شوید' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch {
        return res.status(401).json({ error: 'توکن نامعتبر' });
    }
}

// ===== تنظیمات آپلود =====
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
        cb(null, unique + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4'];
        cb(null, allowed.includes(file.mimetype));
    }
});

// ===== توابع شاردینگ =====
function getShardId(userId) {
    // Consistent Hashing با ۴ شارد
    const hash = crypto.createHash('md5').update(userId.toString()).digest('readUInt32BE', 0);
    return (hash % 4) + 1;
}

async function getShardConnection(shardId) {
    // در محیط واقعی، به دیتابیس شارد مربوطه متصل می‌شویم
    // اینجا از Prisma با connection string متفاوت استفاده می‌کنیم
    // برای سادگی، از همان Prisma استفاده می‌کنیم و شارد را در فیلد ذخیره می‌کنیم
    return prisma;
}

// ===== کش کردن =====
async function cachePost(postId, data) {
    await redis.setex(`post:${postId}`, CACHE_TTL, JSON.stringify(data));
}

async function getCachedPost(postId) {
    const cached = await redis.get(`post:${postId}`);
    return cached ? JSON.parse(cached) : null;
}

async function invalidateCache(postId) {
    await redis.del(`post:${postId}`);
    await redis.del('feed:popular');
}

// ============================================================
//  API: پست‌ها
// ============================================================

// دریافت پست‌ها با شاردینگ
app.get('/api/posts', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const shardId = getShardId(userId);
        const db = await getShardConnection(shardId);

        // ابتدا از کش
        const cacheKey = `feed:user:${userId}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        // دریافت پست‌ها از دیتابیس شارد
        const posts = await db.post.findMany({
            where: {
                // در اینجا می‌توانیم فیلتر بر اساس فالوها داشته باشیم
            },
            include: {
                user: {
                    select: { id: true, username: true, avatar: true }
                },
                likes: true,
                comments: {
                    include: {
                        user: {
                            select: { username: true }
                        }
                    },
                    orderBy: { createdAt: 'desc' },
                    take: 10
                }
            },
            orderBy: { createdAt: 'desc' },
            take: 50
        });

        // بررسی لایک و فالو
        const formattedPosts = await Promise.all(posts.map(async (post) => {
            const liked = await db.like.findFirst({
                where: { postId: post.id, userId }
            });

            const isFollowing = await db.follow.findFirst({
                where: { followerId: userId, followingId: post.userId }
            });

            return {
                id: post.id,
                image: post.image,
                caption: post.caption,
                username: post.user.username,
                userAvatar: post.user.avatar,
                userId: post.user.id,
                likes: post.likes.length,
                liked: !!liked,
                isFollowing: !!isFollowing,
                comments: post.comments.map(c => ({
                    id: c.id,
                    user: c.user.username,
                    text: c.text,
                    createdAt: c.createdAt
                })),
                createdAt: post.createdAt,
                shardId: post.shardId || shardId
            };
        }));

        const result = { posts: formattedPosts };

        // کش کردن برای ۵ دقیقه
        await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(result));

        res.json(result);
    } catch (error) {
        console.error('❌ خطا در دریافت پست‌ها:', error);
        res.status(500).json({ error: 'خطا در دریافت پست‌ها' });
    }
});

// آپلود پست جدید (با شاردینگ)
app.post('/api/posts', authenticate, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'تصویر الزامی است' });
        }

        const { caption } = req.body;
        const userId = req.userId;
        const shardId = getShardId(userId);
        const db = await getShardConnection(shardId);

        const imageUrl = `/uploads/${req.file.filename}`;

        const post = await db.post.create({
            data: {
                image: imageUrl,
                caption: caption || '',
                userId,
                shardId
            },
            include: {
                user: {
                    select: { id: true, username: true, avatar: true }
                }
            }
        });

        // Invalid کردن کش
        await invalidateCache(post.id);
        await redis.del(`feed:user:${userId}`);
        await redis.del('feed:popular');

        res.json({
            post: {
                id: post.id,
                image: post.image,
                caption: post.caption,
                username: post.user.username,
                userAvatar: post.user.avatar,
                userId: post.user.id,
                likes: 0,
                liked: false,
                isFollowing: false,
                comments: [],
                createdAt: post.createdAt,
                shardId: post.shardId
            }
        });
    } catch (error) {
        console.error('❌ خطا در آپلود:', error);
        res.status(500).json({ error: 'خطا در آپلود پست' });
    }
});

// دریافت یک پست (با کش)
app.get('/api/posts/:postId', authenticate, async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        const userId = req.userId;

        // بررسی کش
        const cached = await getCachedPost(postId);
        if (cached) {
            return res.json(cached);
        }

        // پیدا کردن شارد پست
        const post = await prisma.post.findUnique({
            where: { id: postId },
            include: {
                user: {
                    select: { id: true, username: true, avatar: true }
                },
                likes: true,
                comments: {
                    include: {
                        user: {
                            select: { username: true }
                        }
                    },
                    orderBy: { createdAt: 'desc' },
                    take: 20
                }
            }
        });

        if (!post) {
            return res.status(404).json({ error: 'پست یافت نشد' });
        }

        const liked = await prisma.like.findFirst({
            where: { postId, userId }
        });

        const isFollowing = await prisma.follow.findFirst({
            where: { followerId: userId, followingId: post.userId }
        });

        const result = {
            id: post.id,
            image: post.image,
            caption: post.caption,
            username: post.user.username,
            userAvatar: post.user.avatar,
            userId: post.user.id,
            likes: post.likes.length,
            liked: !!liked,
            isFollowing: !!isFollowing,
            comments: post.comments.map(c => ({
                id: c.id,
                user: c.user.username,
                text: c.text,
                createdAt: c.createdAt
            })),
            createdAt: post.createdAt,
            shardId: post.shardId
        };

        await cachePost(postId, result);
        res.json(result);
    } catch (error) {
        console.error('❌ خطا در دریافت پست:', error);
        res.status(500).json({ error: 'خطا در دریافت پست' });
    }
});

// لایک کردن (با شاردینگ)
app.post('/api/posts/:postId/like', authenticate, async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        const userId = req.userId;
        const shardId = getShardId(userId);
        const db = await getShardConnection(shardId);

        const existing = await db.like.findFirst({
            where: { postId, userId }
        });

        let liked;
        if (existing) {
            await db.like.delete({ where: { id: existing.id } });
            liked = false;
        } else {
            await db.like.create({ data: { postId, userId } });
            liked = true;
        }

        const likeCount = await db.like.count({ where: { postId } });

        // Invalid کردن کش
        await invalidateCache(postId);
        await redis.del(`feed:user:${userId}`);

        res.json({ liked, likes: likeCount });
    } catch (error) {
        console.error('❌ خطا در لایک:', error);
        res.status(500).json({ error: 'خطا در لایک' });
    }
});

// کامنت گذاشتن
app.post('/api/posts/:postId/comment', authenticate, async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        const userId = req.userId;
        const { text } = req.body;

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: 'متن کامنت الزامی است' });
        }

        const shardId = getShardId(userId);
        const db = await getShardConnection(shardId);

        const comment = await db.comment.create({
            data: {
                text: text.trim(),
                postId,
                userId
            },
            include: {
                user: {
                    select: { username: true }
                }
            }
        });

        await invalidateCache(postId);

        res.json({
            comment: {
                id: comment.id,
                user: comment.user.username,
                text: comment.text,
                createdAt: comment.createdAt
            }
        });
    } catch (error) {
        console.error('❌ خطا در کامنت:', error);
        res.status(500).json({ error: 'خطا در ارسال کامنت' });
    }
});

// ===== محبوب‌ترین پست‌ها (برای اکسپلور) =====
app.get('/api/posts/popular', authenticate, async (req, res) => {
    try {
        const cacheKey = 'feed:popular';
        const cached = await redis.get(cacheKey);
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        // دریافت از همه شاردها (در محیط واقعی باید از همه شاردها جمع‌آوری شود)
        const posts = await prisma.post.findMany({
            include: {
                user: {
                    select: { id: true, username: true, avatar: true }
                },
                likes: true,
                comments: {
                    include: {
                        user: {
                            select: { username: true }
                        }
                    },
                    take: 3
                }
            },
            orderBy: {
                likes: { _count: 'desc' }
            },
            take: 30
        });

        const result = {
            posts: posts.map(p => ({
                id: p.id,
                image: p.image,
                caption: p.caption,
                username: p.user.username,
                userAvatar: p.user.avatar,
                userId: p.user.id,
                likes: p.likes.length,
                comments: p.comments.map(c => ({
                    id: c.id,
                    user: c.user.username,
                    text: c.text
                })),
                createdAt: p.createdAt
            }))
        };

        await redis.setex(cacheKey, 600, JSON.stringify(result)); // 10 دقیقه
        res.json(result);
    } catch (error) {
        console.error('❌ خطا در دریافت پست‌های محبوب:', error);
        res.status(500).json({ error: 'خطا در دریافت پست‌های محبوب' });
    }
});

// ============================================================
//  راه‌اندازی
// ============================================================

app.listen(PORT, () => {
    console.log(`📸 سرویس پست‌ها روی پورت ${PORT} اجرا شد`);
    console.log(`📊 شاردینگ: ۴ شارد با Consistent Hashing`);
    console.log(`💾 کش: Redis با TTL ${CACHE_TTL} ثانیه`);
    console.log(`📁 آپلود: ${UPLOAD_DIR}`);
});

process.on('uncaughtException', async (err) => {
    console.error('❌ خطا در سرویس پست:', err);
});

process.on('SIGINT', async () => {
    await prisma.$disconnect();
    await redis.quit();
    console.log('👋 سرویس پست متوقف شد');
    process.exit(0);
});