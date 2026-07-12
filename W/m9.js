// ============================================
// 🌐 WEBSOCKET MANAGER - REAL-TIME ENGINE
// ============================================

const { io, onlineUsers, db } = require('../A/m1.js');
const authService = require('../A/m2.js');
const chatService = require('../B/m6.js');
const liveService = require('../B/m7.js');
const notificationService = require('../B/m8.js');

class WebSocketManager {
    constructor() {
        this.connections = new Map();
        this.socketUsers = new Map();
        this.roomSubscriptions = new Map();
        this.messageQueue = [];
        this.broadcastQueue = [];
        this.isProcessing = false;
        this.MAX_CONNECTIONS = 100000;
        this.PING_INTERVAL = 25000;
    }

    // ===== INITIALIZE =====
    init() {
        io.on('connection', (socket) => {
            if (this.connections.size >= this.MAX_CONNECTIONS) {
                socket.emit('error', { message: 'سرور شلوغ است، لطفاً بعداً تلاش کنید' });
                socket.disconnect();
                return;
            }

            this.handleConnection(socket);

            socket.on('register', (data) => this.handleRegister(socket, data));
            socket.on('join-room', (data) => this.handleJoinRoom(socket, data));
            socket.on('leave-room', (data) => this.handleLeaveRoom(socket, data));
            socket.on('send-message', (data) => this.handleSendMessage(socket, data));
            socket.on('typing', (data) => this.handleTyping(socket, data));
            socket.on('mark-read', (data) => this.handleMarkRead(socket, data));
            
            // Live events
            socket.on('join-live', (data) => this.handleJoinLive(socket, data));
            socket.on('leave-live', (data) => this.handleLeaveLive(socket, data));
            socket.on('live-comment', (data) => this.handleLiveComment(socket, data));
            socket.on('live-reaction', (data) => this.handleLiveReaction(socket, data));

            // Notification events
            socket.on('mark-notification-read', (data) => this.handleMarkNotificationRead(socket, data));
            socket.on('get-notifications', (data) => this.handleGetNotifications(socket, data));

            // Disconnect
            socket.on('disconnect', () => this.handleDisconnect(socket));
            
            // Ping for keep-alive
            socket.on('pong', () => {
                const conn = this.connections.get(socket.id);
                if (conn) {
                    conn.lastPong = Date.now();
                }
            });
        });

        // Start ping interval
        setInterval(() => this.pingClients(), this.PING_INTERVAL);

        // Broadcast queue processor
        setInterval(() => this.processBroadcastQueue(), 1000);

        // Cleanup
        setInterval(() => this.cleanup(), 60000);
    }

    // ===== CONNECTION HANDLING =====
    handleConnection(socket) {
        this.connections.set(socket.id, {
            socket,
            userId: null,
            username: null,
            rooms: new Set(),
            connectedAt: new Date().toISOString(),
            lastActivity: Date.now(),
            lastPong: Date.now(),
            ip: socket.handshake.address
        });
    }

    handleRegister(socket, data) {
        const { userId, username, token } = data;

        // Verify token
        if (token) {
            const sessionUserId = authService.sessions.get(token);
            if (sessionUserId !== userId) {
                socket.emit('error', { message: 'توکن نامعتبر است' });
                return;
            }
        }

        const connection = this.connections.get(socket.id);
        if (connection) {
            connection.userId = userId;
            connection.username = username;
        }

        this.socketUsers.set(userId, socket.id);
        this.connections.get(socket.id).userId = userId;

        // Update online status
        onlineUsers.set(userId, { socketId: socket.id, username });
        db.updateUser(userId, { isOnline: true, lastSeen: new Date().toISOString() });

        // Broadcast online users
        this.broadcastOnlineUsers();

        // Send unread notifications
        const unread = notificationService.getUnreadCount(userId);
        if (unread > 0) {
            socket.emit('unread-notifications', { count: unread });
        }

        // Send unread messages
        const totalUnread = chatService.getTotalUnread(userId);
        if (totalUnread > 0) {
            socket.emit('unread-messages', { count: totalUnread });
        }

        console.log(`👤 User ${username} (${userId}) online`);
    }

    // ===== CHAT HANDLING =====
    handleJoinRoom(socket, data) {
        const { roomId, userId } = data;

        socket.join(roomId);
        this.connections.get(socket.id)?.rooms.add(roomId);

        if (!this.roomSubscriptions.has(roomId)) {
            this.roomSubscriptions.set(roomId, new Set());
        }
        this.roomSubscriptions.get(roomId).add(socket.id);

        // Send history
        const messages = chatService.getMessages(roomId, 50);
        socket.emit('history', messages);

        // Mark messages as read
        if (messages.length > 0) {
            const messageIds = messages.map(m => m.messageId);
            chatService.markRead(roomId, userId, messageIds);
        }
    }

    handleLeaveRoom(socket, data) {
        const { roomId } = data;

        socket.leave(roomId);
        this.connections.get(socket.id)?.rooms.delete(roomId);
        this.roomSubscriptions.get(roomId)?.delete(socket.id);
    }

    async handleSendMessage(socket, data) {
        const { roomId, userId, username, message, messageType = 'text' } = data;

        // Validate user
        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            socket.emit('error', { message: 'شما مسدود شده‌اید' });
            return;
        }

        // Process message
        const result = await chatService.sendMessage({
            roomId,
            userId,
            username,
            message,
            messageType
        });

        if (result.success) {
            // Broadcast to room
            io.to(roomId).emit('receive-message', {
                ...result.message,
                message: message // Decrypted
            });

            // Send delivery confirmation
            socket.emit('message-delivered', {
                messageId: result.message.messageId,
                roomId
            });

            // Notify other participants
            const room = chatService.getRoom(roomId);
            if (room) {
                for (const participant of room.participants) {
                    if (participant !== userId) {
                        const notif = await notificationService.notifyMessage(
                            participant,
                            userId,
                            `پیام جدید از ${username}`
                        );
                        if (notif) {
                            io.to(`user_${participant}`).emit('notification', notif);
                        }
                    }
                }
            }
        } else {
            socket.emit('error', { message: result.error });
        }
    }

    handleTyping(socket, data) {
        const { roomId, userId, isTyping } = data;

        chatService.setTyping(roomId, userId, isTyping);
        socket.to(roomId).emit('user-typing', {
            userId,
            isTyping
        });
    }

    handleMarkRead(socket, data) {
        const { roomId, userId, messageIds } = data;
        chatService.markRead(roomId, userId, messageIds);
        socket.to(roomId).emit('messages-read', {
            userId,
            messageIds
        });
    }

    // ===== LIVE HANDLING =====
    handleJoinLive(socket, data) {
        const { streamId, userId } = data;

        socket.join(`live_${streamId}`);
        this.connections.get(socket.id)?.rooms.add(`live_${streamId}`);

        // Join stream
        liveService.joinStream(streamId, userId).then(result => {
            if (result.success) {
                socket.to(`live_${streamId}`).emit('viewer-joined', {
                    userId,
                    viewers: result.viewers
                });
                socket.emit('live-joined', result);
            }
        });
    }

    handleLeaveLive(socket, data) {
        const { streamId, userId } = data;

        socket.leave(`live_${streamId}`);
        this.connections.get(socket.id)?.rooms.delete(`live_${streamId}`);

        liveService.leaveStream(streamId, userId).then(result => {
            if (result.success) {
                socket.to(`live_${streamId}`).emit('viewer-left', {
                    userId,
                    viewers: result.viewers
                });
            }
        });
    }

    async handleLiveComment(socket, data) {
        const { streamId, userId, username, text } = data;

        const result = await liveService.sendStreamMessage(streamId, {
            userId,
            username,
            message: text
        });

        if (result.success) {
            io.to(`live_${streamId}`).emit('live-comment', {
                ...result.message,
                streamId
            });
        }
    }

    handleLiveReaction(socket, data) {
        const { streamId, userId, reaction } = data;

        liveService.addReaction(streamId, userId, reaction);
        io.to(`live_${streamId}`).emit('live-reaction', {
            userId,
            reaction,
            streamId
        });
    }

    // ===== NOTIFICATION HANDLING =====
    async handleMarkNotificationRead(socket, data) {
        const { notificationId, userId } = data;
        await notificationService.markRead(notificationId, userId);
        socket.emit('notification-read', { notificationId });
    }

    async handleGetNotifications(socket, data) {
        const { userId, limit = 50 } = data;
        const notifications = await notificationService.getNotifications(userId, limit);
        socket.emit('notifications', notifications);
    }

    // ===== BROADCAST =====
    broadcastMessage(message, from, type = 'system') {
        this.broadcastQueue.push({
            message,
            from,
            type,
            timestamp: new Date().toISOString()
        });
    }

    broadcastOnlineUsers() {
        const online = Array.from(onlineUsers.keys());
        io.emit('users-online', online);
    }

    processBroadcastQueue() {
        if (this.broadcastQueue.length === 0) return;

        const messages = this.broadcastQueue.splice(0, 10);
        for (const msg of messages) {
            io.emit('broadcast', msg);
        }
    }

    // ===== PING =====
    pingClients() {
        const now = Date.now();
        for (const [id, conn] of this.connections) {
            if (now - conn.lastPong > this.PING_INTERVAL * 3) {
                conn.socket.disconnect();
                this.connections.delete(id);
            } else {
                conn.socket.emit('ping');
            }
        }
    }

    // ===== DISCONNECT =====
    handleDisconnect(socket) {
        const connection = this.connections.get(socket.id);
        if (connection) {
            const { userId, username } = connection;

            if (userId) {
                onlineUsers.delete(userId);
                this.socketUsers.delete(userId);
                db.updateUser(userId, { isOnline: false, lastSeen: new Date().toISOString() });

                // Remove from rooms
                for (const room of connection.rooms) {
                    this.roomSubscriptions.get(room)?.delete(socket.id);
                }

                console.log(`👋 User ${username} (${userId}) disconnected`);
            }

            this.connections.delete(socket.id);
            this.broadcastOnlineUsers();
        }
    }

    // ===== CLEANUP =====
    cleanup() {
        const now = Date.now();
        const timeout = 5 * 60 * 1000;

        // Clean inactive connections
        for (const [id, conn] of this.connections) {
            if (!conn.userId && now - conn.lastActivity > timeout) {
                conn.socket.disconnect();
                this.connections.delete(id);
            }
        }

        // Clean room subscriptions
        for (const [roomId, subscribers] of this.roomSubscriptions) {
            if (subscribers.size === 0) {
                this.roomSubscriptions.delete(roomId);
            }
        }
    }

    // ===== STATS =====
    getStats() {
        return {
            connections: this.connections.size,
            socketUsers: this.socketUsers.size,
            roomSubscriptions: this.roomSubscriptions.size,
            broadcastQueue: this.broadcastQueue.length,
            messageQueue: this.messageQueue.length,
            maxConnections: this.MAX_CONNECTIONS
        };
    }

    // ===== SEND TO USER =====
    sendToUser(userId, event, data) {
        const socketId = this.socketUsers.get(userId);
        if (socketId) {
            const conn = this.connections.get(socketId);
            if (conn) {
                conn.socket.emit(event, data);
                return true;
            }
        }
        return false;
    }

    sendToRoom(roomId, event, data) {
        io.to(roomId).emit(event, data);
    }

    sendToLive(streamId, event, data) {
        io.to(`live_${streamId}`).emit(event, data);
    }
}

module.exports = new WebSocketManager();
