// ============================================
// 🔴 LIVE STREAMING ENGINE
// ============================================

const { db, encryption } = require('../A/m1.js');

class LiveStreamService {
    constructor() {
        this.streams = new Map();
        this.viewers = new Map();
        this.streamMetrics = new Map();
        this.streamAnalytics = new Map();
        this.MAX_VIEWERS_PER_STREAM = 100000;
        this.MAX_STREAMS = 100;
    }

    // ===== STREAM MANAGEMENT =====
    async startStream(data) {
        const { userId, title, description, privacy = 'public', thumbnail = null } = data;

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر یافت نشد یا مسدود شده است' };
        }

        // Check if user already has an active stream
        for (const [streamId, stream] of this.streams) {
            if (stream.userId === userId && stream.isLive) {
                return { success: false, error: 'شما در حال حاضر یک لایو فعال دارید' };
            }
        }

        if (this.streams.size >= this.MAX_STREAMS) {
            this.cleanup();
        }

        const streamId = encryption.generateId('live');
        const stream = {
            streamId,
            userId,
            title: title || 'لایو',
            description: description || '',
            privacy,
            thumbnail,
            isLive: true,
            startedAt: new Date().toISOString(),
            endedAt: null,
            viewers: new Set(),
            chatMessages: [],
            currentViewers: 0,
            maxViewers: 0,
            totalViewers: 0,
            duration: 0,
            isRecording: false,
            recordingUrl: null,
            reactions: 0,
            messages: 0
        };

        this.streams.set(streamId, stream);
        this.viewers.set(streamId, new Set());
        this.streamMetrics.set(streamId, {
            startTime: Date.now(),
            messages: 0,
            reactions: 0,
            peakViewers: 0,
            totalViewers: 0
        });

        // Save to database
        db.startLiveStream(userId, title);

        return {
            success: true,
            stream: {
                ...stream,
                viewers: Array.from(stream.viewers)
            }
        };
    }

    async endStream(streamId, userId) {
        const stream = this.streams.get(streamId);
        if (!stream) {
            return { success: false, error: 'لایو یافت نشد' };
        }

        if (stream.userId !== userId) {
            return { success: false, error: 'این لایو متعلق به شما نیست' };
        }

        stream.isLive = false;
        stream.endedAt = new Date().toISOString();
        stream.duration = Math.floor((Date.now() - new Date(stream.startedAt).getTime()) / 1000);

        // Save analytics
        const metrics = this.streamMetrics.get(streamId);
        if (metrics) {
            this.streamAnalytics.set(streamId, {
                ...metrics,
                endedAt: new Date().toISOString(),
                duration: stream.duration,
                maxViewers: stream.maxViewers,
                totalViewers: stream.totalViewers
            });
        }

        // End in database
        db.endLiveStream(streamId);

        // Clean up
        this.viewers.delete(streamId);
        this.streamMetrics.delete(streamId);

        return { success: true, stream };
    }

    // ===== VIEWER MANAGEMENT =====
    async joinStream(streamId, userId) {
        const stream = this.streams.get(streamId);
        if (!stream || !stream.isLive) {
            return { success: false, error: 'لایو در دسترس نیست' };
        }

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر یافت نشد یا مسدود شده است' };
        }

        if (stream.privacy === 'private' && stream.userId !== userId) {
            return { success: false, error: 'این لایو خصوصی است' };
        }

        if (stream.viewers.size >= this.MAX_VIEWERS_PER_STREAM) {
            return { success: false, error: 'ظرفیت لایو تکمیل شده است' };
        }

        if (!stream.viewers.has(userId)) {
            stream.viewers.add(userId);
            stream.currentViewers = stream.viewers.size;
            stream.totalViewers += 1;

            if (stream.currentViewers > stream.maxViewers) {
                stream.maxViewers = stream.currentViewers;
            }

            const metrics = this.streamMetrics.get(streamId);
            if (metrics) {
                metrics.peakViewers = Math.max(metrics.peakViewers, stream.currentViewers);
                metrics.totalViewers = stream.totalViewers;
            }
        }

        // Join in database
        db.joinLiveStream(streamId, userId);

        return {
            success: true,
            viewers: stream.currentViewers,
            totalViewers: stream.totalViewers
        };
    }

    async leaveStream(streamId, userId) {
        const stream = this.streams.get(streamId);
        if (!stream) {
            return { success: false, error: 'لایو یافت نشد' };
        }

        stream.viewers.delete(userId);
        stream.currentViewers = stream.viewers.size;

        // Leave in database
        db.leaveLiveStream(streamId, userId);

        return {
            success: true,
            viewers: stream.currentViewers
        };
    }

    // ===== STREAM CHAT =====
    async sendStreamMessage(streamId, data) {
        const { userId, username, message, messageType = 'text' } = data;

        const stream = this.streams.get(streamId);
        if (!stream || !stream.isLive) {
            return { success: false, error: 'لایو در دسترس نیست' };
        }

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر یافت نشد یا مسدود شده است' };
        }

        const msg = {
            messageId: encryption.generateId('live_msg'),
            userId,
            username: username || user.username,
            message: message,
            messageType,
            timestamp: new Date().toISOString(),
            isHost: userId === stream.userId
        };

        stream.chatMessages.push(msg);
        stream.messages += 1;

        // Update metrics
        const metrics = this.streamMetrics.get(streamId);
        if (metrics) {
            metrics.messages += 1;
        }

        return { success: true, message: msg };
    }

    getStreamMessages(streamId, limit = 50) {
        const stream = this.streams.get(streamId);
        if (!stream) return [];
        return stream.chatMessages.slice(-limit);
    }

    // ===== STREAM REACTIONS =====
    async addReaction(streamId, userId, reaction) {
        const stream = this.streams.get(streamId);
        if (!stream || !stream.isLive) {
            return { success: false, error: 'لایو در دسترس نیست' };
        }

        stream.reactions += 1;

        const metrics = this.streamMetrics.get(streamId);
        if (metrics) {
            metrics.reactions += 1;
        }

        return { success: true, reaction };
    }

    // ===== STREAM ANALYTICS =====
    getStreamAnalytics(streamId) {
        const stream = this.streams.get(streamId);
        if (!stream) return null;

        const metrics = this.streamMetrics.get(streamId) || {};
        const now = Date.now();
        const startTime = new Date(stream.startedAt).getTime();

        return {
            streamId,
            userId: stream.userId,
            title: stream.title,
            isLive: stream.isLive,
            startedAt: stream.startedAt,
            duration: stream.isLive ? Math.floor((now - startTime) / 1000) : stream.duration,
            currentViewers: stream.currentViewers,
            maxViewers: stream.maxViewers,
            totalViewers: stream.totalViewers,
            messages: metrics.messages || 0,
            reactions: metrics.reactions || 0,
            peakViewers: metrics.peakViewers || 0,
            chatMessages: stream.chatMessages.length
        };
    }

    getLiveStreams() {
        const result = [];
        for (const [streamId, stream] of this.streams) {
            if (stream.isLive) {
                const analytics = this.getStreamAnalytics(streamId);
                result.push({
                    ...stream,
                    viewers: Array.from(stream.viewers),
                    analytics
                });
            }
        }
        return result;
    }

    // ===== RECORDING =====
    async startRecording(streamId, userId) {
        const stream = this.streams.get(streamId);
        if (!stream || stream.userId !== userId) {
            return { success: false, error: 'این لایو متعلق به شما نیست' };
        }

        stream.isRecording = true;
        stream.recordingUrl = `/uploads/live/${streamId}_${Date.now()}.mp4`;

        return { success: true, recordingUrl: stream.recordingUrl };
    }

    async stopRecording(streamId, userId) {
        const stream = this.streams.get(streamId);
        if (!stream || stream.userId !== userId) {
            return { success: false, error: 'این لایو متعلق به شما نیست' };
        }

        stream.isRecording = false;
        return { success: true };
    }

    // ===== STREAM STATS =====
    getStreamStats() {
        let totalStreams = 0;
        let activeStreams = 0;
        let totalViewers = 0;

        for (const [streamId, stream] of this.streams) {
            totalStreams++;
            if (stream.isLive) {
                activeStreams++;
                totalViewers += stream.currentViewers;
            }
        }

        return {
            totalStreams,
            activeStreams,
            totalViewers,
            averageViewers: activeStreams > 0 ? Math.round(totalViewers / activeStreams) : 0,
            maxConcurrentStreams: this.MAX_STREAMS,
            maxViewersPerStream: this.MAX_VIEWERS_PER_STREAM
        };
    }

    // ===== CLEANUP =====
    cleanup() {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;

        // Remove ended streams older than 1 hour
        for (const [streamId, stream] of this.streams) {
            if (!stream.isLive && stream.endedAt) {
                const endedTime = new Date(stream.endedAt).getTime();
                if (now - endedTime > oneHour) {
                    this.streams.delete(streamId);
                    this.viewers.delete(streamId);
                    this.streamMetrics.delete(streamId);
                }
            }
        }

        // Clean old chat messages (keep last 1000)
        for (const [streamId, stream] of this.streams) {
            if (stream.chatMessages.length > 1000) {
                stream.chatMessages = stream.chatMessages.slice(-1000);
            }
        }
    }
}

module.exports = new LiveStreamService();
