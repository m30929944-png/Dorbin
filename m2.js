// ============================================
// 💬 m2.js - COMMENTS, LIKES, FOLLOWS & CHAT
// ============================================

const { app, db, io, encryption, authMiddleware, adminMiddleware } = require('./m1.js');

// ============================================
// 💬 CHAT SYSTEM
// ============================================
class ChatSystem {
    constructor() {
        this.rooms = new Map();
        this.userRooms = new Map();
        this.typingUsers = new Map();
        this.readReceipts = new Map();
        this.deliveryReceipts = new Map();
        this.unreadCounts = new Map();
        this.MAX_MESSAGES = 1000;
        this.MAX_ROOMS = 10000;
        this.messageQueue = [];
        this.reactions = new Map();
        this.pinnedMessages = new Map();
        this.chatHistory = new Map();
    }

    getRoomId(user1, user2) {
        return [user1, user2].sort().join('_');
    }

    async createRoom(user1, user2) {
        const roomId = this.getRoomId(user1, user2);
        
        if (this.rooms.size >= this.MAX_ROOMS) {
            this.cleanup();
        }

        if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, {
                roomId,
                participants: [user1, user2],
                messages: [],
                createdAt: new Date().toISOString(),
                lastMessage: null,
                unreadCount: new Map(),
                isActive: true,
                isGroup: false,
                groupName: null,
                groupAvatar: null,
                admins: [],
                pinnedMessages: []
            });
        }

        for (const userId of [user1, user2]) {
            if (!this.userRooms.has(userId)) {
                this.userRooms.set(userId, new Set());
            }
            this.userRooms.get(userId).add(roomId);
        }

        return this.rooms.get(roomId);
    }

    getRoom(roomId) {
        return this.rooms.get(roomId) || null;
    }

    getUserRooms(userId) {
        if (!this.userRooms.has(userId)) {
            this.userRooms.set(userId, new Set());
        }
        return Array.from(this.userRooms.get(userId));
    }

    async sendMessage(data) {
        const { roomId, userId, username, message, messageType = 'text', replyTo = null, attachments = [] } = data;

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر یافت نشد یا مسدود شده است' };
        }

        const room = this.rooms.get(roomId);
        if (!room) {
            return { success: false, error: 'اتاق چت یافت نشد' };
        }

        if (!room.isGroup && !room.participants.includes(userId)) {
            return { success: false, error: 'شما عضو این چت نیستید' };
        }

        const messageData = {
            messageId: encryption.generateId('msg'),
            userId: userId,
            username: username || user.username,
            fullName: user.fullName || user.username,
            message: message,
            messageType: messageType,
            replyTo: replyTo,
            attachments: attachments,
            timestamp: new Date().toISOString(),
            delivered: false,
            read: false,
            edited: false,
            deleted: false,
            reactions: [],
            isPinned: false,
            isForwarded: false,
            forwardedFrom: null
        };

        db.saveMessage(roomId, messageData);

        room.messages.push(messageData);
        room.lastMessage = messageData;
        
        for (const participant of room.participants) {
            if (participant !== userId) {
                if (!room.unreadCount.has(participant)) {
                    room.unreadCount.set(participant, 0);
                }
                room.unreadCount.set(participant, room.unreadCount.get(participant) + 1);
                this.unreadCounts.set(`${participant}_${roomId}`, room.unreadCount.get(participant));
            }
        }

        if (room.messages.length > this.MAX_MESSAGES) {
            room.messages = room.messages.slice(-this.MAX_MESSAGES);
        }

        if (!this.chatHistory.has(roomId)) {
            this.chatHistory.set(roomId, []);
        }
        this.chatHistory.get(roomId).push(messageData);

        return {
            success: true,
            message: messageData
        };
    }

    getMessages(roomId, limit = 50, before = null) {
        const room = this.rooms.get(roomId);
        if (!room) return [];

        let messages = room.messages;

        if (before) {
            const index = messages.findIndex(m => m.messageId === before);
            if (index !== -1) {
                messages = messages.slice(0, index);
            }
        }

        return messages.slice(-limit);
    }

    async markRead(roomId, userId, messageIds) {
        const room = this.rooms.get(roomId);
        if (!room) return false;

        for (const messageId of messageIds) {
            const msg = room.messages.find(m => m.messageId === messageId);
            if (msg && msg.userId !== userId) {
                msg.read = true;
                this.readReceipts.set(messageId, {
                    readAt: new Date().toISOString(),
                    readBy: userId
                });
            }
        }

        if (room.unreadCount.has(userId)) {
            room.unreadCount.set(userId, 0);
            this.unreadCounts.delete(`${userId}_${roomId}`);
        }

        return true;
    }

    async markAllRead(roomId, userId) {
        const room = this.rooms.get(roomId);
        if (!room) return false;

        const unreadMessages = room.messages.filter(m => 
            m.userId !== userId && !m.read
        );

        const messageIds = unreadMessages.map(m => m.messageId);
        return this.markRead(roomId, userId, messageIds);
    }

    getUnreadCount(roomId, userId) {
        const key = `${userId}_${roomId}`;
        if (this.unreadCounts.has(key)) {
            return this.unreadCounts.get(key);
        }
        return 0;
    }

    getTotalUnread(userId) {
        let total = 0;
        for (const [key, count] of this.unreadCounts) {
            if (key.startsWith(`${userId}_`)) {
                total += count;
            }
        }
        return total;
    }

    setTyping(roomId, userId, isTyping) {
        const key = `${roomId}_${userId}`;
        if (isTyping) {
            this.typingUsers.set(key, {
                userId,
                roomId,
                startedAt: new Date().toISOString()
            });
        } else {
            this.typingUsers.delete(key);
        }
        return true;
    }

    getTypingUsers(roomId) {
        const result = [];
        for (const [key, data] of this.typingUsers) {
            if (data.roomId === roomId) {
                result.push(data.userId);
            }
        }
        return result;
    }

    cleanup() {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const oneMinute = 60 * 1000;

        for (const [key, data] of this.typingUsers) {
            if (now - new Date(data.startedAt).getTime() > oneMinute) {
                this.typingUsers.delete(key);
            }
        }

        for (const [roomId, room] of this.rooms) {
            if (!room.isActive) {
                const age = now - new Date(room.createdAt).getTime();
                if (age > 7 * oneDay) {
                    this.rooms.delete(roomId);
                }
            }
        }

        for (const [key, count] of this.unreadCounts) {
            if (count === 0) {
                this.unreadCounts.delete(key);
            }
        }
    }

    getStats() {
        return {
            totalRooms: this.rooms.size,
            totalMessages: Array.from(this.rooms.values())
                .reduce((acc, room) => acc + room.messages.length, 0),
            totalUnread: this.unreadCounts.size,
            totalTyping: this.typingUsers.size,
            totalReadReceipts: this.readReceipts.size,
            totalDeliveryReceipts: this.deliveryReceipts.size,
            totalPinned: Array.from(this.rooms.values())
                .reduce((acc, room) => acc + room.pinnedMessages.length, 0)
        };
    }
}

const chatSystem = new ChatSystem();

// ============================================
// 💬 CHAT ROUTES
// ============================================
app.get('/api/chat/rooms', authMiddleware, (req, res) => {
    const rooms = chatSystem.getUserRooms(req.user.userId);
    const roomDetails = rooms.map(roomId => {
        const room = chatSystem.getRoom(roomId);
        if (!room) return null;
        return {
            roomId: room.roomId,
            isGroup: room.isGroup,
            groupName: room.groupName,
            participants: room.participants,
            lastMessage: room.lastMessage,
            unreadCount: chatSystem.getUnreadCount(roomId, req.user.userId)
        };
    }).filter(r => r !== null);
    res.json(roomDetails);
});

app.get('/api/chat/messages', authMiddleware, (req, res) => {
    const { roomId, limit = 50, before } = req.query;
    if (!roomId) {
        return res.status(400).json({ error: 'roomId الزامی است' });
    }
    const messages = chatSystem.getMessages(roomId, parseInt(limit), before);
    res.json(messages);
});

app.get('/api/chat/unread', authMiddleware, (req, res) => {
    const unread = chatSystem.getTotalUnread(req.user.userId);
    res.json({ unread });
});

app.post('/api/chat/messages/read', authMiddleware, (req, res) => {
    const { roomId, messageIds } = req.body;
    if (!roomId || !messageIds) {
        return res.status(400).json({ error: 'roomId و messageIds الزامی هستند' });
    }
    chatSystem.markRead(roomId, req.user.userId, messageIds);
    res.json({ success: true });
});

app.post('/api/chat/messages/read-all', authMiddleware, (req, res) => {
    const { roomId } = req.body;
    if (!roomId) {
        return res.status(400).json({ error: 'roomId الزامی است' });
    }
    chatSystem.markAllRead(roomId, req.user.userId);
    res.json({ success: true });
});

// ============================================
// 💬 WEBSOCKET CHAT EVENTS
// ============================================
io.on('connection', (socket) => {
    socket.on('join-room', (data) => {
        const { roomId, userId } = data;
        socket.join(roomId);
        socket.roomId = roomId;
        const messages = chatSystem.getMessages(roomId, 50);
        socket.emit('history', messages);
        chatSystem.markAllRead(roomId, userId);
    });

    socket.on('send-message', async (data) => {
        const { roomId, userId, username, message, messageType, replyTo, attachments } = data;
        const result = await chatSystem.sendMessage({
            roomId,
            userId,
            username,
            message,
            messageType,
            replyTo,
            attachments
        });

        if (result.success) {
            io.to(roomId).emit('receive-message', result.message);
            socket.emit('message-delivered', {
                messageId: result.message.messageId,
                roomId
            });

            const room = chatSystem.getRoom(roomId);
            if (room) {
                for (const participant of room.participants) {
                    if (participant !== userId) {
                        io.to(`user_${participant}`).emit('new-message', {
                            roomId,
                            fromUserId: userId,
                            messageId: result.message.messageId
                        });
                    }
                }
            }
        } else {
            socket.emit('error', { message: result.error });
        }
    });

    socket.on('typing', (data) => {
        const { roomId, userId, isTyping } = data;
        chatSystem.setTyping(roomId, userId, isTyping);
        socket.to(roomId).emit('user-typing', {
            userId,
            isTyping
        });
    });

    socket.on('mark-read', (data) => {
        const { roomId, userId, messageIds } = data;
        chatSystem.markRead(roomId, userId, messageIds);
        socket.to(roomId).emit('messages-read', {
            userId,
            messageIds
        });
    });

    socket.on('leave-room', (data) => {
        const { roomId } = data;
        socket.leave(roomId);
    });
});

module.exports = {
    chatSystem
};