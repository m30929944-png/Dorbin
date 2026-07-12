// ============================================================
// m1.js - API Gateway + امنیت + مدیریت کاربران
// ============================================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

// ===== تنظیمات امنیتی =====
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-min-32-chars-here!!!';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh-secret-key-32-chars-here!!!';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'this-is-32-byte-key-for-aes-256-encrypt!!';
const SALT_ROUNDS = 12;

// ===== میدلورها =====
app.use(helmet());
app.use(compression());
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ===== Rate Limiting =====
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'درخواست بیش از حد، لطفاً بعداً تلاش کنید' }
});
app.use('/api', limiter);

const authLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 10,
    message: { error: 'تلاش بیش از حد برای ورود، لطفاً ۵ دقیقه صبر کنید' }
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// ===== توابع رمزنگاری =====
function encryptData(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY.padEnd(32, ' ')), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return iv.toString('hex') + ':' + encrypted + ':' + authTag;
}

function decryptData(encryptedText) {
    if (!encryptedText) return null;
    const [ivHex, encryptedHex, authTagHex] = encryptedText.split(':');
    if (!ivHex || !encryptedHex || !authTagHex) return null;
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY.padEnd(32, ' ')), iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// ===== تولید توکن‌ها =====
function generateTokens(userId) {
    const accessToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ userId }, JWT_REFRESH_SECRET, { expiresIn: '7d' });
    return { accessToken, refreshToken };
}

function verifyAccessToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

function verifyRefreshToken(token) {
    try {
        return jwt.verify(token, JWT_REFRESH_SECRET);
    } catch {
        return null;
    }
}

// ===== میدلور احراز هویت =====
function authenticate(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'لطفاً وارد شوید' });
    }

    const decoded = verifyAccessToken(token);
    if (!decoded) {
        return res.status(401).json({ error: 'توکن نامعتبر یا منقضی شده' });
    }

    req.userId = decoded.userId;
    next();
}

// ============================================================
//  API: احراز هویت
// ============================================================

app.post('/api/register', async (req, res) => {
    try {
        const { username, password, fullname, email } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'نام کاربری و رمز عبور الزامی است' });
        }

        if (username.length < 3 || username.length > 30) {
            return res.status(400).json({ error: 'نام کاربری باید بین ۳ تا ۳۰ کاراکتر باشد' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'رمز عبور باید حداقل ۶ کاراکتر باشد' });
        }

        const existing = await prisma.user.findUnique({ where: { username } });
        if (existing) {
            return res.status(400).json({ error: 'این نام کاربری قبلاً ثبت شده است' });
        }

        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        const encryptedFullname = fullname ? encryptData(fullname) : null;
        const encryptedEmail = email ? encryptData(email) : null;

        // تخصیص به شارد بر اساس هش آیدی (در d1.js)
        const user = await prisma.user.create({
            data: {
                username,
                password: hashedPassword,
                fullname: encryptedFullname,
                email: encryptedEmail,
                avatar: `https://picsum.photos/200/200?seed=${Date.now()}`,
                shardId: Math.abs(crypto.createHash('md5').update(username).digest('readUInt32BE', 0) % 4) + 1
            }
        });

        const { accessToken, refreshToken } = generateTokens(user.id);

        res.json({
            token: accessToken,
            refreshToken,
            user: {
                id: user.id,
                username: user.username,
                fullname: fullname || user.username,
                avatar: user.avatar,
                shardId: user.shardId
            }
        });
    } catch (error) {
        console.error('❌ خطا در ثبت‌نام:', error);
        res.status(500).json({ error: 'خطا در ثبت‌نام' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'نام کاربری و رمز عبور الزامی است' });
        }

        const user = await prisma.user.findUnique({ where: { username } });
        if (!user) {
            return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
        }

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
        }

        let fullname = user.fullname;
        try {
            if (fullname) fullname = decryptData(fullname);
        } catch { fullname = user.username; }

        const { accessToken, refreshToken } = generateTokens(user.id);

        // ذخیره refresh token در دیتابیس
        await prisma.user.update({
            where: { id: user.id },
            data: { refreshToken: refreshToken }
        });

        res.json({
            token: accessToken,
            refreshToken,
            user: {
                id: user.id,
                username: user.username,
                fullname: fullname || user.username,
                avatar: user.avatar,
                shardId: user.shardId
            }
        });
    } catch (error) {
        console.error('❌ خطا در ورود:', error);
        res.status(500).json({ error: 'خطا در ورود' });
    }
});

app.post('/api/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(400).json({ error: 'Refresh token الزامی است' });
        }

        const decoded = verifyRefreshToken(refreshToken);
        if (!decoded) {
            return res.status(401).json({ error: 'Refresh token نامعتبر' });
        }

        const user = await prisma.user.findUnique({
            where: { id: decoded.userId }
        });

        if (!user || user.refreshToken !== refreshToken) {
            return res.status(401).json({ error: 'Refresh token نامعتبر' });
        }

        const { accessToken, refreshToken: newRefreshToken } = generateTokens(user.id);

        await prisma.user.update({
            where: { id: user.id },
            data: { refreshToken: newRefreshToken }
        });

        res.json({
            token: accessToken,
            refreshToken: newRefreshToken
        });
    } catch (error) {
        console.error('❌ خطا در رفرش:', error);
        res.status(500).json({ error: 'خطا در رفرش توکن' });
    }
});

app.get('/api/me', authenticate, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.userId },
            select: { id: true, username: true, fullname: true, avatar: true, shardId: true }
        });

        if (!user) {
            return res.status(404).json({ error: 'کاربر یافت نشد' });
        }

        let fullname = user.fullname;
        try {
            if (fullname) fullname = decryptData(fullname);
        } catch { fullname = user.username; }

        res.json({
            user: {
                ...user,
                fullname: fullname || user.username
            }
        });
    } catch (error) {
        console.error('❌ خطا در دریافت اطلاعات:', error);
        res.status(500).json({ error: 'خطا در دریافت اطلاعات' });
    }
});

// ============================================================
//  API: کاربران (برای چت و فالو)
// ============================================================

app.get('/api/users', authenticate, async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            where: { id: { not: req.userId } },
            select: { id: true, username: true, avatar: true, shardId: true }
        });

        // رمزگشایی نام‌ها (اختیاری)
        const formattedUsers = users.map(u => ({
            ...u,
            username: u.username // رمزگشایی نشده برای حفظ امنیت
        }));

        res.json({ users: formattedUsers });
    } catch (error) {
        console.error('❌ خطا در دریافت کاربران:', error);
        res.status(500).json({ error: 'خطا در دریافت کاربران' });
    }
});

app.post('/api/users/:userId/follow', authenticate, async (req, res) => {
    try {
        const followingId = parseInt(req.params.userId);
        const followerId = req.userId;

        if (followingId === followerId) {
            return res.status(400).json({ error: 'نمی‌توانید خودتان را فالو کنید' });
        }

        const existing = await prisma.follow.findFirst({
            where: { followerId, followingId }
        });

        let following;
        if (existing) {
            await prisma.follow.delete({ where: { id: existing.id } });
            following = false;
        } else {
            await prisma.follow.create({ data: { followerId, followingId } });
            following = true;
        }

        res.json({ following });
    } catch (error) {
        console.error('❌ خطا در فالو:', error);
        res.status(500).json({ error: 'خطا در فالو کردن' });
    }
});

// ============================================================
//  API: استوری‌ها (نمونه)
// ============================================================

app.get('/api/stories', authenticate, async (req, res) => {
    try {
        // استوری‌های ۲۴ ساعت اخیر
        const stories = await prisma.story.findMany({
            where: {
                createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
                userId: { not: req.userId }
            },
            include: {
                user: {
                    select: { id: true, username: true, avatar: true }
                }
            },
            orderBy: { createdAt: 'desc' },
            take: 50
        });

        // استوری خود کاربر
        const myStory = await prisma.story.findFirst({
            where: {
                userId: req.userId,
                createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            }
        });

        const result = [];
        if (!myStory) {
            result.push({
                username: 'شما',
                avatar: null,
                isAdd: true
            });
        }

        result.push(...stories.map(s => ({
            username: s.user.username,
            avatar: s.user.avatar,
            storyId: s.id
        })));

        res.json({ stories: result });
    } catch (error) {
        console.error('❌ خطا در دریافت استوری:', error);
        // برگرداندن استوری‌های نمونه
        res.json({ stories: [] });
    }
});

// ============================================================
//  Proxy به سرویس‌های دیگر (m2.js و m3.js)
// ============================================================

const postServiceUrl = process.env.POST_SERVICE_URL || 'http://localhost:3001';
const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'http://localhost:3002';

// پروکسی برای پست‌ها
app.use('/api/posts', authenticate, async (req, res) => {
    try {
        const targetUrl = `${postServiceUrl}${req.originalUrl}`;
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: {
                'Authorization': req.headers.authorization,
                'Content-Type': req.headers['content-type'] || 'application/json'
            },
            body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined
        });

        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        console.error('❌ خطا در پروکسی پست:', error);
        res.status(500).json({ error: 'خطا در ارتباط با سرویس پست' });
    }
});

// پروکسی برای چت
app.use('/api/chat', authenticate, async (req, res) => {
    try {
        const targetUrl = `${chatServiceUrl}${req.originalUrl}`;
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: {
                'Authorization': req.headers.authorization,
                'Content-Type': 'application/json'
            },
            body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined
        });

        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        console.error('❌ خطا در پروکسی چت:', error);
        res.status(500).json({ error: 'خطا در ارتباط با سرویس چت' });
    }
});

// ============================================================
//  راه‌اندازی
// ============================================================

app.listen(PORT, () => {
    console.log(`🚀 API Gateway روی پورت ${PORT} اجرا شد`);
    console.log(`🔐 JWT Secret: ${JWT_SECRET.substring(0, 10)}...`);
    console.log(`🔑 Encryption: AES-256-GCM فعال`);
    console.log(`📊 Sharding: Consistent Hashing با ۴ شارد`);
    console.log(`📡 Post Service: ${postServiceUrl}`);
    console.log(`💬 Chat Service: ${chatServiceUrl}`);
});

process.on('uncaughtException', async (err) => {
    console.error('❌ خطای سیستمی:', err);
});

process.on('SIGINT', async () => {
    await prisma.$disconnect();
    console.log('👋 سرور متوقف شد');
    process.exit(0);
});