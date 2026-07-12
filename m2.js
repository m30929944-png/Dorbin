// ============================================
// 👥 m2.js - USER MANAGEMENT, FOLLOW, PROFILE, CHAT
// ============================================

const { app, db, io, encryption, authMiddleware, adminMiddleware } = require('./m1.js');
const path = require('path');
const crypto = require('crypto');

// ============================================
// 👤 USER SERVICE
// ============================================
class UserService {
    constructor() {
        this.userCache = new Map();
        this.CACHE_TTL = 5 * 60 * 1000;
        this.followRequests = new Map();
        this.blockedUsers = new Map();
        this.userReports = new Map();
        this.chatRooms = new Map();
        this.userChats = new Map();
        this.lastSeen = new Map();
        this.typingUsers = new Map();
    }

    // ===== GET USER PROFILE =====
    getUserProfile(userId, viewerId = null) {
        const user = db.getUser(userId);
        if (!user) return null;

        const isFollowing = viewerId ? this.isFollowing(viewerId, userId) : false;
        const isBlocked = viewerId ? this.isBlocked(viewerId, userId) : false;
        const isOnline = encryption.isOnline(userId);

        return {
            userId: user.userId,
            username: user.username,
            fullName: user.fullName,
            bio: user.bio,
            avatar: user.avatar,
            followers: user.followers || 0,
            following: user.following || 0,
            postsCount: user.postsCount || 0,
            isOnline: isOnline,
            isVerified: user.isVerified || false,
            isAdmin: user.isAdmin || false,
            isFollowing: isFollowing,
            isBlocked: isBlocked,
            createdAt: user.createdAt,
            lastSeen: user.lastSeen
        };
    }

    // ===== FOLLOW SYSTEM =====
    isFollowing(userId, targetId) {
        const idx = db.getShardIndex(userId);
        if (!db.shards[idx].following.has(userId)) return false;
        return db.shards[idx].following.get(userId).has(targetId);
    }

    async followUser(userId, targetId) {
        if (userId === targetId) {
            return { success: false, error: 'نمی‌توانید خودتان را دنبال کنید' };
        }

        if (this.isBlocked(targetId, userId)) {
            return { success: false, error: 'این کاربر شما را مسدود کرده است' };
        }

        const result = db.followUser(userId, targetId);
        if (!result) {
            return { success: false, error: 'از قبل دنبال می‌کنید' };
        }

        // Send notification
        const notification = {
            notificationId: db.generateId('notif'),
            userId: targetId,
            fromUserId: userId,
            type: 'follow',
            isRead: false,
            createdAt: new Date().toISOString()
        };
        db.addNotification(notification);
        const socketId = encryption.getUserSocket(targetId);
        if (socketId) {
            io.to(socketId).emit('notification', {
                type: 'follow',
                fromUserId: userId,
                fromUsername: db.getUser(userId)?.username || 'کاربر'
            });
        }

        return { success: true };
    }

    async unfollowUser(userId, targetId) {
        const result = db.unfollowUser(userId, targetId);
        if (!result) {
            return { success: false, error: 'دنبال نمی‌کنید' };
        }
        return { success: true };
    }

    getFollowers(userId) {
        return db.getFollowers(userId);
    }

    getFollowing(userId) {
        return db.getFollowing(userId);
    }

    getFollowerCount(userId) {
        const user = db.getUser(userId);
        return user ? user.followers || 0 : 0;
    }

    getFollowingCount(userId) {
        const user = db.getUser(userId);
        return user ? user.following || 0 : 0;
    }

    // ===== BLOCK SYSTEM =====
    isBlocked(userId, targetId) {
        if (!this.blockedUsers.has(userId)) return false;
        return this.blockedUsers.get(userId).has(targetId);
    }

    async blockUser(userId, targetId) {
        if (userId === targetId) {
            return { success: false, error: 'نمی‌توانید خودتان را مسدود کنید' };
        }

        if (!this.blockedUsers.has(userId)) {
            this.blockedUsers.set(userId, new Set());
        }
        this.blockedUsers.get(userId).add(targetId);

        if (this.isFollowing(userId, targetId)) {
            db.unfollowUser(userId, targetId);
        }
        if (this.isFollowing(targetId, userId)) {
            db.unfollowUser(targetId, userId);
        }

        return { success: true };
    }

    async unblockUser(userId, targetId) {
        if (this.blockedUsers.has(userId)) {
            this.blockedUsers.get(userId).delete(targetId);
        }
        return { success: true };
    }

    // ===== SUGGESTIONS =====
    getFollowSuggestions(userId, limit = 10) {
        const allUsers = db.getAllUsers();
        const following = new Set(db.getFollowing(userId).map(u => u.userId));
        const blocked = this.blockedUsers.get(userId) || new Set();
        
        const suggestions = allUsers
            .filter(u => 
                u.userId !== userId && 
                !following.has(u.userId) && 
                !blocked.has(u.userId) &&
                !u.isBanned
            )
            .sort((a, b) => (b.followers || 0) - (a.followers || 0))
            .slice(0, limit);

        return suggestions.map(u => ({
            userId: u.userId,
            username: u.username,
            fullName: u.fullName,
            avatar: u.avatar,
            followers: u.followers || 0,
            isVerified: u.isVerified || false,
            isOnline: encryption.isOnline(u.userId)
        }));
    }

    // ===== USER SEARCH =====
    searchUsers(query, limit = 20) {
        if (!query || query.length < 2) return [];
        const results = db.searchUsers(query, limit);
        return results.map(u => ({
            userId: u.userId,
            username: u.username,
            fullName: u.fullName,
            avatar: u.avatar,
            bio: u.bio,
            followers: u.followers || 0,
            isVerified: u.isVerified || false,
            isOnline: encryption.isOnline(u.userId)
        }));
    }

    // ===== UPDATE PROFILE =====
    async updateProfile(userId, data) {
        const user = db.getUser(userId);
        if (!user) return { success: false, error: 'کاربر یافت نشد' };

        const updates = {};
        if (data.bio !== undefined) updates.bio = data.bio;
        if (data.fullName !== undefined) updates.fullName = data.fullName;
        if (data.username !== undefined) {
            const existing = db.getUserByUsername(data.username);
            if (existing && existing.userId !== userId) {
                return { success: false, error: 'این نام کاربری قبلاً ثبت شده است' };
            }
            updates.username = data.username;
        }

        const updated = db.updateUser(userId, updates);
        return { success: true, user: { ...updated, password: undefined } };
    }

    // ===== USER STATS =====
    getUserStats(userId) {
        const user = db.getUser(userId);
        if (!user) return null;

        return {
            userId: user.userId,
            username: user.username,
            followers: user.followers || 0,
            following: user.following || 0,
            postsCount: user.postsCount || 0,
            isOnline: encryption.isOnline(userId),
            isVerified: user.isVerified || false,
            isAdmin: user.isAdmin || false,
            createdAt: user.createdAt,
            lastSeen: user.lastSeen
        };
    }

    // ============================================
    // 💬 CHAT SYSTEM
    // ============================================
    getChatRooms(userId) {
        if (!this.userChats.has(userId)) {
            this.userChats.set(userId, new Set());
        }
        return Array.from(this.userChats.get(userId));
    }

    async getChatUsers(userId) {
        const rooms = this.getChatRooms(userId);
        const users = [];
        
        for (const roomId of rooms) {
            const room = this.chatRooms.get(roomId);
            if (room) {
                const otherId = room.participants.find(id => id !== userId);
                if (otherId) {
                    const user = db.getUser(otherId);
                    if (user && !user.isBanned) {
                        const lastMessage = room.messages && room.messages.length > 0 ? room.messages[room.messages.length - 1] : null;
                        users.push({
                            userId: user.userId,
                            username: user.username,
                            fullName: user.fullName || user.username,
                            avatar: user.avatar || '',
                            isOnline: encryption.isOnline(user.userId),
                            lastMessage: lastMessage,
                            unreadCount: room.unreadCount?.get(userId) || 0
                        });
                    }
                }
            }
        }
        
        // Sort by last message time
        users.sort((a, b) => {
            const timeA = a.lastMessage ? new Date(a.lastMessage.timestamp).getTime() : 0;
            const timeB = b.lastMessage ? new Date(b.lastMessage.timestamp).getTime() : 0;
            return timeB - timeA;
        });
        
        return users;
    }

    async createChatRoom(user1, user2) {
        const roomId = encryption.generateRoomId(user1, user2);
        
        if (!this.chatRooms.has(roomId)) {
            this.chatRooms.set(roomId, {
                roomId,
                participants: [user1, user2],
                messages: [],
                createdAt: new Date().toISOString(),
                lastMessage: null,
                unreadCount: new Map()
            });
            
            // Add to user chats
            for (const userId of [user1, user2]) {
                if (!this.userChats.has(userId)) {
                    this.userChats.set(userId, new Set());
                }
                this.userChats.get(userId).add(roomId);
            }
        }
        
        return this.chatRooms.get(roomId);
    }

    async sendChatMessage(roomId, userId, username, message) {
        const room = this.chatRooms.get(roomId);
        if (!room) {
            return { success: false, error: 'اتاق چت یافت نشد' };
        }

        const msgData = {
            messageId: db.generateId('msg'),
            userId: userId,
            username: username,
            message: message,
            timestamp: new Date().toISOString(),
            read: false
        };

        room.messages.push(msgData);
        room.lastMessage = msgData;

        // Update unread count for other participants
        for (const participant of room.participants) {
            if (participant !== userId) {
                if (!room.unreadCount.has(participant)) {
                    room.unreadCount.set(participant, 0);
                }
                room.unreadCount.set(participant, room.unreadCount.get(participant) + 1);
            }
        }

        // Save to database
        db.saveMessage(roomId, msgData);

        return { success: true, message: msgData };
    }

    getChatMessages(roomId, limit = 50) {
        const room = this.chatRooms.get(roomId);
        if (!room) return [];
        return room.messages.slice(-limit);
    }

    markMessagesRead(roomId, userId) {
        const room = this.chatRooms.get(roomId);
        if (!room) return false;
        if (room.unreadCount.has(userId)) {
            room.unreadCount.set(userId, 0);
        }
        return true;
    }

    getUnreadCount(userId) {
        let total = 0;
        for (const [roomId, room] of this.chatRooms) {
            if (room.participants.includes(userId)) {
                total += room.unreadCount.get(userId) || 0;
            }
        }
        return total;
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

    // ============================================
    // 🧹 CLEANUP
    // ============================================
    cleanup() {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const oneMinute = 60 * 1000;

        // Clean typing indicators
        for (const [key, data] of this.typingUsers) {
            if (now - new Date(data.startedAt).getTime() > oneMinute) {
                this.typingUsers.delete(key);
            }
        }

        // Clean old chat rooms (inactive for 7 days)
        for (const [roomId, room] of this.chatRooms) {
            const lastMessage = room.messages.length > 0 ? room.messages[room.messages.length - 1] : null;
            if (lastMessage) {
                const age = now - new Date(lastMessage.timestamp).getTime();
                if (age > 7 * oneDay) {
                    this.chatRooms.delete(roomId);
                }
            }
        }
    }
}

const userService = new UserService();

// ============================================
// 📡 USER ROUTES
// ============================================

// ===== GET USER PROFILE =====
app.get('/api/users/profile/:userId', authMiddleware, (req, res) => {
    const profile = userService.getUserProfile(req.params.userId, req.user.userId);
    if (!profile) return res.status(404).json({ error: 'کاربر یافت نشد' });
    res.json(profile);
});

app.get('/api/users/me', authMiddleware, (req, res) => {
    const profile = userService.getUserProfile(req.user.userId);
    res.json(profile);
});

// ===== FOLLOW =====
app.post('/api/users/:userId/follow', authMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await userService.followUser(req.user.userId, userId);
    if (result.success) {
        const target = db.getUser(userId);
        io.emit('follow-update', { 
            userId: target.userId, 
            followers: target.followers 
        });
        res.json({ success: true, followers: target.followers });
    } else {
        res.status(400).json(result);
    }
});

app.post('/api/users/:userId/unfollow', authMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await userService.unfollowUser(req.user.userId, userId);
    if (result.success) {
        const target = db.getUser(userId);
        res.json({ success: true, followers: target.followers });
    } else {
        res.status(400).json(result);
    }
});

app.get('/api/users/:userId/followers', authMiddleware, (req, res) => {
    const followers = userService.getFollowers(req.params.userId);
    res.json(followers.map(u => ({ ...u, password: undefined })));
});

app.get('/api/users/:userId/following', authMiddleware, (req, res) => {
    const following = userService.getFollowing(req.params.userId);
    res.json(following.map(u => ({ ...u, password: undefined })));
});

app.get('/api/users/:userId/follow-status', authMiddleware, (req, res) => {
    const { userId } = req.params;
    const isFollowing = userService.isFollowing(req.user.userId, userId);
    const isBlocked = userService.isBlocked(userId, req.user.userId);
    res.json({ isFollowing, isBlocked });
});

// ===== BLOCK =====
app.post('/api/users/:userId/block', authMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await userService.blockUser(req.user.userId, userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(400).json(result);
    }
});

app.post('/api/users/:userId/unblock', authMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await userService.unblockUser(req.user.userId, userId);
    res.json({ success: true });
});

// ===== SUGGESTIONS =====
app.get('/api/users/suggestions', authMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    const suggestions = userService.getFollowSuggestions(req.user.userId, limit);
    res.json(suggestions);
});

// ===== SEARCH =====
app.get('/api/users/search', authMiddleware, (req, res) => {
    const { q, limit = 20 } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const results = userService.searchUsers(q, parseInt(limit));
    res.json(results);
});

// ===== PROFILE UPDATE =====
app.put('/api/users/profile', authMiddleware, async (req, res) => {
    const { bio, fullName, username } = req.body;
    const result = await userService.updateProfile(req.user.userId, { bio, fullName, username });
    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

// ===== STATS =====
app.get('/api/users/:userId/stats', authMiddleware, (req, res) => {
    const stats = userService.getUserStats(req.params.userId);
    if (!stats) return res.status(404).json({ error: 'کاربر یافت نشد' });
    res.json(stats);
});

// ============================================
// 📡 CHAT ROUTES
// ============================================

// ===== GET CHAT USERS =====
app.get('/api/chat/users', authMiddleware, async (req, res) => {
    try {
        const users = await userService.getChatUsers(req.user.userId);
        res.json(users);
    } catch (error) {
        console.error('Get chat users error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== GET CHAT ROOMS =====
app.get('/api/chat/rooms', authMiddleware, (req, res) => {
    const rooms = userService.getChatRooms(req.user.userId);
    res.json(rooms);
});

// ===== GET ROOM MESSAGES =====
app.get('/api/chat/messages/room', authMiddleware, (req, res) => {
    try {
        const { roomId, limit = 50 } = req.query;
        if (!roomId) {
            return res.status(400).json({ error: 'roomId الزامی است' });
        }
        const messages = userService.getChatMessages(roomId, parseInt(limit));
        res.json(messages);
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== CREATE CHAT ROOM =====
app.post('/api/chat/room', authMiddleware, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'userId الزامی است' });
        }
        const room = await userService.createChatRoom(req.user.userId, userId);
        res.json(room);
    } catch (error) {
        console.error('Create room error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== SEND MESSAGE =====
app.post('/api/chat/message', authMiddleware, async (req, res) => {
    try {
        const { targetUserId, message } = req.body;
        if (!targetUserId || !message) {
            return res.status(400).json({ error: 'targetUserId و message الزامی هستند' });
        }
        
        const roomId = encryption.generateRoomId(req.user.userId, targetUserId);
        const room = await userService.createChatRoom(req.user.userId, targetUserId);
        
        const result = await userService.sendChatMessage(
            roomId,
            req.user.userId,
            req.user.fullName || req.user.username,
            message
        );
        
        if (result.success) {
            // Send to receiver via socket
            const socketId = encryption.getUserSocket(targetUserId);
            if (socketId) {
                io.to(socketId).emit('receive-chat-message', {
                    ...result.message,
                    roomId: roomId
                });
            }
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== MARK MESSAGES AS READ =====
app.post('/api/chat/messages/read', authMiddleware, (req, res) => {
    try {
        const { roomId } = req.body;
        if (!roomId) {
            return res.status(400).json({ error: 'roomId الزامی است' });
        }
        const result = userService.markMessagesRead(roomId, req.user.userId);
        res.json({ success: result });
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ===== GET UNREAD COUNT =====
app.get('/api/chat/unread', authMiddleware, (req, res) => {
    try {
        const unread = userService.getUnreadCount(req.user.userId);
        res.json({ unread });
    } catch (error) {
        console.error('Get unread error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ============================================
// 💬 WEBSOCKET CHAT EVENTS
// ============================================
io.on('connection', (socket) => {
    // ===== JOIN CHAT ROOM =====
    socket.on('join-chat', async (data) => {
        try {
            const { userId, targetUserId } = data;
            const room = await userService.createChatRoom(userId, targetUserId);
            socket.join(room.roomId);
            socket.roomId = room.roomId;
            const messages = userService.getChatMessages(room.roomId, 50);
            socket.emit('chat-history', messages);
            userService.markMessagesRead(room.roomId, userId);
        } catch (error) {
            console.error('Join chat error:', error);
        }
    });

    // ===== SEND CHAT MESSAGE =====
    socket.on('send-chat-message', async (data) => {
        try {
            const { roomId, userId, username, message } = data;
            const result = await userService.sendChatMessage(roomId, userId, username, message);
            if (result.success) {
                io.to(roomId).emit('receive-chat-message', result.message);
                
                // Notify other participants
                const room = userService.chatRooms.get(roomId);
                if (room) {
                    for (const participant of room.participants) {
                        if (participant !== userId) {
                            const socketId = encryption.getUserSocket(participant);
                            if (socketId) {
                                io.to(socketId).emit('new-chat-message', {
                                    roomId,
                                    fromUserId: userId,
                                    message: result.message
                                });
                            }
                        }
                    }
                }
            } else {
                socket.emit('error', { message: result.error });
            }
        } catch (error) {
            console.error('Send chat message error:', error);
            socket.emit('error', { message: 'خطا در ارسال پیام' });
        }
    });

    // ===== TYPING INDICATOR =====
    socket.on('chat-typing', (data) => {
        const { roomId, userId, isTyping } = data;
        userService.setTyping(roomId, userId, isTyping);
        socket.to(roomId).emit('chat-typing', { userId, isTyping });
    });

    // ===== LEAVE CHAT =====
    socket.on('leave-chat', (data) => {
        const { roomId } = data;
        socket.leave(roomId);
    });
});

module.exports = {
    userService
};