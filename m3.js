// ============================================================
// m3.js - سرویس چت با WebSocket و دیتابیس
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

const PORT = process.env.CHAT_SERVICE_PORT || 3002;

// ===== تنظیمات =====
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-min-32-chars-here!!!';
const prisma = new PrismaClient();

// ===== Redis برای ذخیره وضعیت آنلاین =====
const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || '',
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

redis.on('connect', () => console.log('✅ Redis (چت) متصل شد'));

// ===== میدلورها =====
app.use(cors());
app.use(express.json());

// ===== احراز هویت Socket =====
io.use((socket, next) => {
    const token = socket.handshake.query.token;
    if (!token) {
        return next(new Error('لطفاً وارد شوید'));
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.userId = decoded.userId;
        next();
    } catch {
        return next(new Error('توکن نامعتبر'));
    }
});

// ===== مدیریت اتصالات =====
const connectedUsers = new Map(); // userId -> socketId
const userSockets = new Map(); // socketId -> userId

io.on('connection', (socket) => {
    const userId = socket.userId;
    console.log(`👤 کاربر ${userId} متصل شد`);

    // ثبت کاربر
    connectedUsers.set(userId, socket.id);
    userSockets.set(socket.id, userId);
    redis.setex(`online:${userId}`, 300, 'true');

    // ارسال لیست کاربران آنلاین
    broadcastOnlineUsers();

    // ===== دریافت لیست کاربران =====
    socket.on('get_users', async () => {
        try {
            const users = await prisma.user.findMany({
                where: { id: { not: userId } },
                select: { id: true, username: true, avatar: true }
            });

            // اضافه کردن وضعیت آنلاین
            const usersWithStatus = await Promise.all(users.map(async (user) => {
                const isOnline = await redis.get(`online:${user.id}`);
                return {
                    ...user,
                    isOnline: !!isOnline
                };
            }));

            socket.emit('users_list', usersWithStatus);
        } catch (error) {
            console.error('❌ خطا در دریافت کاربران:', error);
            socket.emit('error', { message: 'خطا در دریافت کاربران' });
        }
    });

    // ===== دریافت تاریخچه پیام‌ها =====
    socket.on('get_messages', async ({ userId: targetUserId }) => {
        try {
            const messages = await prisma.message.findMany({
                where: {
                    OR: [
                        { senderId: userId, receiverId: targetUserId },
                        { senderId: targetUserId, receiverId: userId }
                    ]
                },
                orderBy: { createdAt: 'asc' },
                take: 100
            });

            // علامت‌گذاری به عنوان خوانده شده
            await prisma.message.updateMany({
                where: {
                    senderId: targetUserId,
                    receiverId: userId,
                    read: false
                },
                data: { read: true }
            });

            const formattedMessages = messages.map(m => ({
                id: m.id,
                senderId: m.senderId,
                text: m.text,
                read: m.read,
                createdAt: m.createdAt
            }));

            socket.emit('messages', {
                userId: targetUserId,
                messages: formattedMessages
            });
        } catch (error) {
            console.error('❌ خطا در دریافت پیام‌ها:', error);
            socket.emit('error', { message: 'خطا در دریافت پیام‌ها' });
        }
    });

    // ===== ارسال پیام =====
    socket.on('send_message', async ({ userId: targetUserId, text }) => {
        try {
            if (!text || text.trim().length === 0) {
                socket.emit('error', { message: 'متن پیام نمی‌تواند خالی باشد' });
                return;
            }

            // ذخیره در دیتابیس
            const message = await prisma.message.create({
                data: {
                    text: text.trim(),
                    senderId: userId,
                    receiverId: targetUserId
                }
            });

            const messageData = {
                id: message.id,
                senderId: userId,
                text: message.text,
                read: false,
                createdAt: message.createdAt
            };

            // ارسال به فرستنده
            socket.emit('message_sent', {
                userId: targetUserId,
                message: messageData
            });

            // ارسال به گیرنده (اگر آنلاین باشد)
            const targetSocketId = connectedUsers.get(targetUserId);
            if (targetSocketId) {
                io.to(targetSocketId).emit('new_message', {
                    userId: userId,
                    message: {
                        ...messageData,
                        senderId: userId
                    }
                });
            }

            // ذخیره در Redis برای پیام‌های آفلاین (اختیاری)
            await redis.lpush(`offline_messages:${targetUserId}`, JSON.stringify(messageData));
            await redis.expire(`offline_messages:${targetUserId}`, 86400); // 24 ساعت

        } catch (error) {
            console.error('❌ خطا در ارسال پیام:', error);
            socket.emit('error', { message: 'خطا در ارسال پیام' });
        }
    });

    // ===== تایپینگ =====
    socket.on('typing', ({ userId: targetUserId }) => {
        const targetSocketId = connectedUsers.get(targetUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('typing', {
                userId: userId
            });
        }
    });

    // ===== پیام‌های خوانده شده =====
    socket.on('mark_read', async ({ userId: targetUserId }) => {
        try {
            await prisma.message.updateMany({
                where: {
                    senderId: targetUserId,
                    receiverId: userId,
                    read: false
                },
                data: { read: true }
            });

            const targetSocketId = connectedUsers.get(targetUserId);
            if (targetSocketId) {
                io.to(targetSocketId).emit('messages_read', {
                    userId: userId
                });
            }
        } catch (error) {
            console.error('❌ خطا در علامت‌گذاری خوانده شده:', error);
        }
    });

    // ===== دریافت پیام‌های آفلاین =====
    socket.on('get_offline_messages', async () => {
        try {
            const key = `offline_messages:${userId}`;
            const messages = await redis.lrange(key, 0, -1);
            if (messages.length > 0) {
                const parsedMessages = messages.map(m => JSON.parse(m));
                // ارسال پیام‌های آفلاین
                parsedMessages.forEach(msg => {
                    socket.emit('new_message', {
                        userId: msg.senderId,
                        message: msg
                    });
                });
                await redis.del(key);
            }
        } catch (error) {
            console.error('❌ خطا در دریافت پیام‌های آفلاین:', error);
        }
    });

    // ===== قطع ارتباط =====
    socket.on('disconnect', () => {
        console.log(`👤 کاربر ${userId} قطع شد`);
        connectedUsers.delete(userId);
        userSockets.delete(socket.id);
        redis.del(`online:${userId}`);
        broadcastOnlineUsers();
    });
});

// ===== پخش لیست کاربران آنلاین =====
async function broadcastOnlineUsers() {
    try {
        const onlineUserIds = await redis.keys('online:*');
        const onlineIds = onlineUserIds.map(key => parseInt(key.split(':')[1]));

        const users = await prisma.user.findMany({
            where: { id: { in: onlineIds } },
            select: { id: true, username: true, avatar: true }
        });

        io.emit('online_users', users);
    } catch (error) {
        console.error('❌ خطا در پخش کاربران آنلاین:', error);
    }
}

// ============================================================
//  API: پیام‌ها (REST)
// ============================================================

app.get('/api/chat/messages/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        // در اینجا باید توکن را بررسی کنیم
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'لطفاً وارد شوید' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const currentUserId = decoded.userId;

        const messages = await prisma.message.findMany({
            where: {
                OR: [
                    { senderId: currentUserId, receiverId: userId },
                    { senderId: userId, receiverId: currentUserId }
                ]
            },
            orderBy: { createdAt: 'asc' },
            take: 100
        });

        res.json({ messages });
    } catch (error) {
        console.error('❌ خطا در دریافت پیام‌ها (REST):', error);
        res.status(500).json({ error: 'خطا در دریافت پیام‌ها' });
    }
});

// ============================================================
//  راه‌اندازی
// ============================================================

server.listen(PORT, () => {
    console.log(`💬 سرویس چت روی پورت ${PORT} اجرا شد`);
    console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
    console.log(`👥 مدیریت آنلاین: Redis`);
    console.log(`💾 ذخیره‌سازی: PostgreSQL + Redis`);
});

process.on('uncaughtException', async (err) => {
    console.error('❌ خطا در سرویس چت:', err);
});

process.on('SIGINT', async () => {
    await prisma.$disconnect();
    await redis.quit();
    console.log('👋 سرویس چت متوقف شد');
    process.exit(0);
});