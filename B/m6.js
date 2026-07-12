// ============================================
// 💬 REAL-TIME CHAT SYSTEM
// ============================================

const { db, encryption, onlineUsers } = require('../A/m1.js');

class ChatService {
    constructor() {
        this.rooms = new Map();
        this.userRooms = new Map();
        this.messageQueue = [];
        this.typingUsers = new Map();
        this.readReceipts = new Map();
        this.deliveryReceipts = new Map();
        this.unreadCounts = new Map();
        this.MAX_MESSAGES = 1000;
        this.MAX_ROOMS = 10000;
    }

    // ===== ROOM MANAGEMENT =====
    getRoomId(user1, user2) {
        return [user1, user2].sort().join('_');
    }

    async createRoom(user1, user2) {
        const roomId = this.getRoomId(user1, user2);
        
        if (this.rooms.size >= this.MAX_ROOMS) {
            // Clean old rooms
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
                isActive: true
            });
        }

        // Add to user rooms
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

    async deleteRoom(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return false;

        for (const userId of room.participants) {
            if (this.userRooms.has(userId)) {
                this.userRooms.get(userId).delete(roomId);
            }
        }

        this.rooms.delete(roomId);
        return true;
    }

    // ===== MESSAGE MANAGEMENT =====
    async sendMessage(data) {
        const { roomId, userId, username, message, messageType = 'text', replyTo = null } = data;

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر یافت نشد یا مسدود شده است' };
        }

        const room = this.rooms.get(roomId);
        if (!room) {
            return { success: false, error: 'اتاق چت یافت نشد' };
        }

        // Encrypt message
        const userKey = encryption.getUserKey(userId);
        const encrypted = encryption.encrypt(message, userKey);

        const messageData = {
            messageId: encryption.generateId('msg'),
            userId: userId,
            username: username || user.username,
            message: encrypted,
            messageType: messageType,
            replyTo: replyTo,
            timestamp: new Date().toISOString(),
            delivered: false,
            read: false,
            edited: false,
            deleted: false,
            reactions: []
        };

        // Save to database
        db.saveMessage(roomId, messageData);

        // Update room
        room.messages.push(messageData);
        room.lastMessage = messageData;
        
        // Update unread counts
        for (const participant of room.participants) {
            if (participant !== userId) {
                if (!room.unreadCount.has(participant)) {
                    room.unreadCount.set(participant, 0);
                }
                room.unreadCount.set(participant, room.unreadCount.get(participant) + 1);
                this.unreadCounts.set(`${participant}_${roomId}`, room.unreadCount.get(participant));
            }
        }

        // Clean old messages
        if (room.messages.length > this.MAX_MESSAGES) {
            room.messages = room.messages.slice(-this.MAX_MESSAGES);
        }

        return {
            success: true,
            message: {
                ...messageData,
                message: message // Return decrypted for sender
            }
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

        // Decrypt messages for display
        return messages.slice(-limit).map(msg => {
            const userKey = encryption.getUserKey(msg.userId);
            return {
                ...msg,
                message: encryption.decrypt(msg.message, userKey)
            };
        });
    }

    // ===== MESSAGE STATUS =====
    async markDelivered(roomId, userId, messageIds) {
        const room = this.rooms.get(roomId);
        if (!room) return false;

        for (const messageId of messageIds) {
            const msg = room.messages.find(m => m.messageId === messageId);
            if (msg && msg.userId !== userId) {
                msg.delivered = true;
                this.deliveryReceipts.set(messageId, {
                    deliveredAt: new Date().toISOString(),
                    deliveredTo: userId
                });
            }
        }

        return true;
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

        // Reset unread count
        if (room.unreadCount.has(userId)) {
            room.unreadCount.set(userId, 0);
            this.unreadCounts.delete(`${userId}_${roomId}`);
        }

        return true;
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

    // ===== MESSAGE ACTIONS =====
    async editMessage(roomId, messageId, userId, newText) {
        const room = this.rooms.get(roomId);
        if (!room) return { success: false, error: 'اتاق چت یافت نشد' };

        const msg = room.messages.find(m => m.messageId === messageId);
        if (!msg) return { success: false, error: 'پیام یافت نشد' };
        if (msg.userId !== userId) return { success: false, error: 'این پیام متعلق به شما نیست' };

        const userKey = encryption.getUserKey(userId);
        const encrypted = encryption.encrypt(newText, userKey);
        msg.message = encrypted;
        msg.edited = true;
        msg.editedAt = new Date().toISOString();

        return { success: true, message: { ...msg, message: newText } };
    }

    async deleteMessage(roomId, messageId, userId) {
        const room = this.rooms.get(roomId);
        if (!room) return { success: false, error: 'اتاق چت یافت نشد' };

        const msg = room.messages.find(m => m.messageId === messageId);
        if (!msg) return { success: false, error: 'پیام یافت نشد' };
        if (msg.userId !== userId) return { success: false, error: 'این پیام متعلق به شما نیست' };

        msg.deleted = true;
        msg.deletedAt = new Date().toISOString();
        msg.message = '[پیام حذف شد]';

        return { success: true };
    }

    async reactToMessage(roomId, messageId, userId, reaction) {
        const room = this.rooms.get(roomId);
        if (!room) return { success: false, error: 'اتاق چت یافت نشد' };

        const msg = room.messages.find(m => m.messageId === messageId);
        if (!msg) return { success: false, error: 'پیام یافت نشد' };

        if (!msg.reactions) msg.reactions = [];
        
        const existingIndex = msg.reactions.findIndex(r => r.userId === userId);
        if (existingIndex !== -1) {
            if (msg.reactions[existingIndex].reaction === reaction) {
                msg.reactions.splice(existingIndex, 1);
            } else {
                msg.reactions[existingIndex].reaction = reaction;
            }
        } else {
            msg.reactions.push({ userId, reaction, timestamp: new Date().toISOString() });
        }

        return { success: true, reactions: msg.reactions };
    }

    // ===== TYPING INDICATOR =====
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

    // ===== MESSAGE HISTORY =====
    async getMessageHistory(roomId, userId, limit = 50) {
        const messages = this.getMessages(roomId, limit);
        
        // Mark as read
        const messageIds = messages.map(m => m.messageId);
        await this.markRead(roomId, userId, messageIds);

        return messages;
    }

    // ===== CLEANUP =====
    cleanup() {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const oneMinute = 60 * 1000;

        // Clean typing indicators older than 1 minute
        for (const [key, data] of this.typingUsers) {
            if (now - new Date(data.startedAt).getTime() > oneMinute) {
                this.typingUsers.delete(key);
            }
        }

        // Clean old rooms (inactive for 7 days)
        for (const [roomId, room] of this.rooms) {
            if (!room.isActive) {
                const age = now - new Date(room.createdAt).getTime();
                if (age > 7 * oneDay) {
                    this.rooms.delete(roomId);
                }
            }
        }

        // Clean unread counts
        for (const [key, count] of this.unreadCounts) {
            if (count === 0) {
                this.unreadCounts.delete(key);
            }
        }
    }

    // ===== STATS =====
    getStats() {
        return {
            totalRooms: this.rooms.size,
            totalMessages: Array.from(this.rooms.values())
                .reduce((acc, room) => acc + room.messages.length, 0),
            totalUnread: this.unreadCounts.size,
            totalTyping: this.typingUsers.size,
            totalReadReceipts: this.readReceipts.size,
            totalDeliveryReceipts: this.deliveryReceipts.size
        };
    }
}

module.exports = new ChatService();
