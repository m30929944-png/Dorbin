// ============================================
// 🚀 ULTIMATE CORE ENGINE - BIG DATA READY
// ============================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cluster = require('cluster');
const os = require('os');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');

const numCPUs = os.cpus().length;

// ============================================
// ⚡ MILITARY GRADE ENCRYPTION ENGINE
// ============================================
class MilitaryEncryption {
    constructor() {
        this.SECRET_KEY = crypto.randomBytes(64).toString('hex');
        this.MASTER_KEY = crypto.createHash('sha512').update(this.SECRET_KEY).digest();
        this.ALGORITHM = 'aes-256-gcm';
        this.ITERATIONS = 100000;
        this.KEY_LENGTH = 64;
        this.DIGEST = 'sha512';
    }

    hashPassword(password) {
        const salt = crypto.randomBytes(32).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, this.ITERATIONS, this.KEY_LENGTH, this.DIGEST).toString('hex');
        return `${salt}:${hash}`;
    }

    verifyPassword(password, stored) {
        const [salt, hash] = stored.split(':');
        const verifyHash = crypto.pbkdf2Sync(password, salt, this.ITERATIONS, this.KEY_LENGTH, this.DIGEST).toString('hex');
        return hash === verifyHash;
    }

    encrypt(text, key) {
        try {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag().toString('hex');
            return `${iv.toString('hex')}:${authTag}:${encrypted}`;
        } catch (error) {
            return text;
        }
    }

    decrypt(encrypted, key) {
        try {
            const parts = encrypted.split(':');
            if (parts.length !== 3) return '[پیام رمزنگاری شده]';
            const [iv, authTag, data] = parts;
            const decipher = crypto.createDecipheriv(this.ALGORITHM, key, Buffer.from(iv, 'hex'));
            decipher.setAuthTag(Buffer.from(authTag, 'hex'));
            let decrypted = decipher.update(data, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) {
            return '[پیام رمزنگاری شده]';
        }
    }

    generateToken() {
        return crypto.randomBytes(64).toString('hex') + crypto.randomBytes(32).toString('hex');
    }

    generateId(prefix) {
        return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
    }

    getUserKey(userId) {
        return crypto.createHash('sha256').update(this.MASTER_KEY + userId).digest();
    }

    generateRoomId(user1, user2) {
        return [user1, user2].sort().join('_');
    }
}

// ============================================
// 💾 ULTRA SHARDED DATABASE (100 Shards)
// ============================================
class UltraShardedDatabase {
    constructor() {
        this.SHARD_COUNT = 100;
        this.shards = {};
        this.cache = new Map();
        this.cacheTTL = 5 * 60 * 1000;
        this.cacheStats = { hits: 0, misses: 0, sets: 0 };
        this.transactionLog = [];
        this.backupInterval = null;
        
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            this.shards[i] = {
                users: new Map(),
                posts: [],
                stories: [],
                messages: new Map(),
                likes: new Set(),
                comments: new Map(),
                followers: new Map(),
                following: new Map(),
                bookmarks: new Map(),
                hashtags: new Map(),
                notifications: [],
                liveStreams: new Map(),
                views: new Map(),
                shares: new Map(),
                reports: [],
                analytics: new Map(),
                sessions: new Map(),
                temp: new Map()
            };
        }

        // Start auto-backup
        this.startAutoBackup();
    }

    getShardIndex(key) {
        const hash = crypto.createHash('md5').update(key.toString()).digest('hex');
        return parseInt(hash.substring(0, 4), 16) % this.SHARD_COUNT;
    }

    generateId(prefix) {
        return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
    }

    // ===== CACHE SYSTEM =====
    getCache(key) {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            this.cacheStats.hits++;
            return cached.data;
        }
        this.cacheStats.misses++;
        return null;
    }

    setCache(key, data) {
        this.cache.set(key, { data, timestamp: Date.now() });
        this.cacheStats.sets++;
        if (this.cache.size > 100000) {
            const entries = Array.from(this.cache.keys());
            for (let i = 0; i < 1000; i++) {
                this.cache.delete(entries[i]);
            }
        }
        return data;
    }

    clearCache(pattern = null) {
        if (pattern) {
            for (const key of this.cache.keys()) {
                if (key.includes(pattern)) {
                    this.cache.delete(key);
                }
            }
        } else {
            this.cache.clear();
        }
        return true;
    }

    // ===== TRANSACTION LOGGING =====
    logTransaction(operation, data) {
        this.transactionLog.push({
            id: this.generateId('txn'),
            operation,
            data,
            timestamp: new Date().toISOString()
        });
        if (this.transactionLog.length > 10000) {
            this.transactionLog = this.transactionLog.slice(-5000);
        }
    }

    // ===== AUTO BACKUP =====
    startAutoBackup() {
        this.backupInterval = setInterval(() => {
            this.createBackup();
        }, 60 * 60 * 1000);
    }

    createBackup() {
        try {
            const backup = {
                timestamp: new Date().toISOString(),
                shards: {},
                stats: this.cacheStats
            };
            for (let i = 0; i < this.SHARD_COUNT; i++) {
                backup.shards[i] = {
                    users: Array.from(this.shards[i].users.entries()),
                    posts: this.shards[i].posts,
                    stories: this.shards[i].stories,
                    messages: Array.from(this.shards[i].messages.entries()),
                    likes: Array.from(this.shards[i].likes),
                    comments: Array.from(this.shards[i].comments.entries()),
                    followers: Array.from(this.shards[i].followers.entries()),
                    following: Array.from(this.shards[i].following.entries()),
                    bookmarks: Array.from(this.shards[i].bookmarks.entries()),
                    hashtags: Array.from(this.shards[i].hashtags.entries()),
                    notifications: this.shards[i].notifications
                };
            }
            fs.writeFileSync(
                `./backups/backup_${Date.now()}.json`,
                JSON.stringify(backup, null, 2)
            );
        } catch (error) {
            console.error('Backup failed:', error);
        }
    }

    // ===== USERS =====
    saveUser(user) {
        const idx = this.getShardIndex(user.userId);
        this.shards[idx].users.set(user.userId, user);
        this.setCache(`user:${user.userId}`, user);
        this.logTransaction('saveUser', { userId: user.userId });
        return user;
    }

    getUser(userId) {
        const cached = this.getCache(`user:${userId}`);
        if (cached) return cached;
        const idx = this.getShardIndex(userId);
        const user = this.shards[idx].users.get(userId);
        if (user) this.setCache(`user:${userId}`, user);
        return user || null;
    }

    getUserByEmail(email) {
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            for (const [key, user] of this.shards[i].users) {
                if (user.email === email) return user;
            }
        }
        return null;
    }

    getUserByUsername(username) {
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            for (const [key, user] of this.shards[i].users) {
                if (user.username === username) return user;
            }
        }
        return null;
    }

    getAllUsers() {
        const all = [];
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            all.push(...Array.from(this.shards[i].users.values()));
        }
        return all;
    }

    updateUser(userId, data) {
        const idx = this.getShardIndex(userId);
        const user = this.shards[idx].users.get(userId);
        if (user) {
            const updated = { ...user, ...data };
            this.shards[idx].users.set(userId, updated);
            this.setCache(`user:${userId}`, updated);
            this.logTransaction('updateUser', { userId, data });
            return updated;
        }
        return null;
    }

    deleteUser(userId) {
        const idx = this.getShardIndex(userId);
        if (this.shards[idx].users.has(userId)) {
            this.shards[idx].users.delete(userId);
            this.cache.delete(`user:${userId}`);
            this.logTransaction('deleteUser', { userId });
            return true;
        }
        return false;
    }

    searchUsers(query, limit = 20) {
        const q = query.toLowerCase();
        const results = [];
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            for (const [key, user] of this.shards[i].users) {
                if (results.length >= limit) break;
                if (user.username.toLowerCase().includes(q) || 
                    user.email.toLowerCase().includes(q) ||
                    (user.fullName && user.fullName.toLowerCase().includes(q))) {
                    results.push(user);
                }
            }
        }
        return results;
    }

    // ===== FOLLOW SYSTEM =====
    followUser(userId, targetId) {
        const userIdx = this.getShardIndex(userId);
        const targetIdx = this.getShardIndex(targetId);
        
        if (!this.shards[userIdx].users.has(userId) || !this.shards[targetIdx].users.has(targetId)) {
            return false;
        }

        if (!this.shards[userIdx].following.has(userId)) {
            this.shards[userIdx].following.set(userId, new Set());
        }
        if (!this.shards[targetIdx].followers.has(targetId)) {
            this.shards[targetIdx].followers.set(targetId, new Set());
        }

        const following = this.shards[userIdx].following.get(userId);
        const followers = this.shards[targetIdx].followers.get(targetId);

        if (following.has(targetId)) return false;

        following.add(targetId);
        followers.add(userId);

        const user = this.shards[userIdx].users.get(userId);
        const target = this.shards[targetIdx].users.get(targetId);
        user.following = (user.following || 0) + 1;
        target.followers = (target.followers || 0) + 1;

        this.setCache(`user:${userId}`, user);
        this.setCache(`user:${targetId}`, target);
        this.logTransaction('followUser', { userId, targetId });

        return true;
    }

    unfollowUser(userId, targetId) {
        const userIdx = this.getShardIndex(userId);
        const targetIdx = this.getShardIndex(targetId);
        
        if (!this.shards[userIdx].following.has(userId)) return false;
        
        const following = this.shards[userIdx].following.get(userId);
        if (!following.has(targetId)) return false;

        following.delete(targetId);
        
        if (this.shards[targetIdx].followers.has(targetId)) {
            this.shards[targetIdx].followers.get(targetId).delete(userId);
        }

        const user = this.shards[userIdx].users.get(userId);
        const target = this.shards[targetIdx].users.get(targetId);
        user.following = Math.max((user.following || 0) - 1, 0);
        target.followers = Math.max((target.followers || 0) - 1, 0);

        this.setCache(`user:${userId}`, user);
        this.setCache(`user:${targetId}`, target);
        this.logTransaction('unfollowUser', { userId, targetId });

        return true;
    }

    getFollowers(userId) {
        const idx = this.getShardIndex(userId);
        if (!this.shards[idx].followers.has(userId)) return [];
        const followers = this.shards[idx].followers.get(userId);
        const result = [];
        for (const id of followers) {
            const user = this.getUser(id);
            if (user) result.push(user);
        }
        return result;
    }

    getFollowing(userId) {
        const idx = this.getShardIndex(userId);
        if (!this.shards[idx].following.has(userId)) return [];
        const following = this.shards[idx].following.get(userId);
        const result = [];
        for (const id of following) {
            const user = this.getUser(id);
            if (user) result.push(user);
        }
        return result;
    }

    // ===== POSTS =====
    savePost(post) {
        const idx = this.getShardIndex(post.postId);
        this.shards[idx].posts.unshift(post);
        this.setCache(`post:${post.postId}`, post);

        if (post.hashtags && post.hashtags.length > 0) {
            for (const tag of post.hashtags) {
                const tagKey = tag.toLowerCase();
                if (!this.shards[idx].hashtags.has(tagKey)) {
                    this.shards[idx].hashtags.set(tagKey, new Set());
                }
                this.shards[idx].hashtags.get(tagKey).add(post.postId);
            }
        }
        this.logTransaction('savePost', { postId: post.postId });
        return post;
    }

    getPosts(page = 1, limit = 20, hashtag = null, userId = null) {
        const cacheKey = `posts:${page}:${limit}:${hashtag || 'all'}:${userId || 'all'}`;
        const cached = this.getCache(cacheKey);
        if (cached) return cached;

        let allPosts = [];
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            allPosts = allPosts.concat(this.shards[i].posts);
        }

        if (hashtag) {
            const tag = hashtag.toLowerCase();
            allPosts = allPosts.filter(p => 
                p.hashtags && p.hashtags.some(h => h.toLowerCase() === tag)
            );
        }

        if (userId) {
            allPosts = allPosts.filter(p => p.userId === userId);
        }

        allPosts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const start = (page - 1) * limit;
        const result = {
            posts: allPosts.slice(start, start + limit),
            total: allPosts.length,
            page: page,
            totalPages: Math.ceil(allPosts.length / limit)
        };
        
        this.setCache(cacheKey, result);
        return result;
    }

    getPost(postId) {
        const cached = this.getCache(`post:${postId}`);
        if (cached) return cached;
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (post) this.setCache(`post:${postId}`, post);
        return post || null;
    }

    deletePost(postId) {
        const idx = this.getShardIndex(postId);
        const index = this.shards[idx].posts.findIndex(p => p.postId === postId);
        if (index !== -1) {
            const post = this.shards[idx].posts[index];
            if (post.hashtags) {
                for (const tag of post.hashtags) {
                    const tagKey = tag.toLowerCase();
                    if (this.shards[idx].hashtags.has(tagKey)) {
                        this.shards[idx].hashtags.get(tagKey).delete(postId);
                    }
                }
            }
            this.shards[idx].posts.splice(index, 1);
            this.cache.delete(`post:${postId}`);
            this.logTransaction('deletePost', { postId });
            return true;
        }
        return false;
    }

    likePost(postId, userId) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post) return { liked: false, likes: 0 };
        
        const likeKey = `${postId}_${userId}`;
        if (this.shards[idx].likes.has(likeKey)) {
            this.shards[idx].likes.delete(likeKey);
            post.likes = Math.max((post.likes || 0) - 1, 0);
            this.setCache(`post:${postId}`, post);
            return { liked: false, likes: post.likes };
        } else {
            this.shards[idx].likes.add(likeKey);
            post.likes = (post.likes || 0) + 1;
            this.setCache(`post:${postId}`, post);
            return { liked: true, likes: post.likes };
        }
    }

    viewPost(postId, userId) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post) return false;
        
        const viewKey = `${postId}_${userId}`;
        if (!this.shards[idx].views.has(viewKey)) {
            this.shards[idx].views.add(viewKey);
            post.views = (post.views || 0) + 1;
            this.setCache(`post:${postId}`, post);
            return true;
        }
        return false;
    }

    sharePost(postId, userId) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post) return false;
        
        const shareKey = `${postId}_${userId}`;
        if (!this.shards[idx].shares.has(shareKey)) {
            this.shards[idx].shares.add(shareKey);
            post.shares = (post.shares || 0) + 1;
            this.setCache(`post:${postId}`, post);
            return true;
        }
        return false;
    }

    // ===== COMMENTS =====
    addComment(postId, comment) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post) return false;
        if (!post.comments) post.comments = [];
        post.comments.push(comment);
        this.setCache(`post:${postId}`, post);
        this.logTransaction('addComment', { postId, commentId: comment.commentId });
        return true;
    }

    deleteComment(postId, commentId, userId) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post || !post.comments) return false;
        const index = post.comments.findIndex(c => c.commentId === commentId && c.userId === userId);
        if (index === -1) return false;
        post.comments.splice(index, 1);
        this.setCache(`post:${postId}`, post);
        this.logTransaction('deleteComment', { postId, commentId });
        return true;
    }

    editComment(postId, commentId, userId, newText) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post || !post.comments) return false;
        const comment = post.comments.find(c => c.commentId === commentId && c.userId === userId);
        if (!comment) return false;
        comment.text = newText;
        comment.editedAt = new Date().toISOString();
        this.setCache(`post:${postId}`, post);
        return true;
    }

    getComments(postId) {
        const idx = this.getShardIndex(postId);
        const post = this.shards[idx].posts.find(p => p.postId === postId);
        if (!post) return [];
        return post.comments || [];
    }

    // ===== STORIES =====
    saveStory(story) {
        const idx = this.getShardIndex(story.storyId);
        this.shards[idx].stories.push(story);
        this.setCache(`story:${story.storyId}`, story);
        this.logTransaction('saveStory', { storyId: story.storyId });
        return story;
    }

    getStories(userId = null) {
        let allStories = [];
        const now = Date.now();
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            let stories = this.shards[i].stories.filter(s => {
                const age = now - new Date(s.createdAt).getTime();
                return age < 24 * 60 * 60 * 1000;
            });
            if (userId) {
                stories = stories.filter(s => s.userId === userId);
            }
            allStories = allStories.concat(stories);
        }
        return allStories.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    deleteStory(storyId, userId) {
        const idx = this.getShardIndex(storyId);
        const index = this.shards[idx].stories.findIndex(s => s.storyId === storyId && s.userId === userId);
        if (index !== -1) {
            this.shards[idx].stories.splice(index, 1);
            this.cache.delete(`story:${storyId}`);
            this.logTransaction('deleteStory', { storyId });
            return true;
        }
        return false;
    }

    viewStory(storyId, userId) {
        const idx = this.getShardIndex(storyId);
        const story = this.shards[idx].stories.find(s => s.storyId === storyId);
        if (story && !story.viewers) {
            story.viewers = [];
        }
        if (story && !story.viewers.includes(userId)) {
            story.views = (story.views || 0) + 1;
            story.viewers.push(userId);
            this.setCache(`story:${storyId}`, story);
            return true;
        }
        return false;
    }

    // ===== MESSAGES =====
    saveMessage(roomId, message) {
        const idx = this.getShardIndex(roomId);
        if (!this.shards[idx].messages.has(roomId)) {
            this.shards[idx].messages.set(roomId, []);
        }
        this.shards[idx].messages.get(roomId).push(message);
        this.logTransaction('saveMessage', { roomId, messageId: message.messageId });
        return message;
    }

    getMessages(roomId, limit = 50) {
        const idx = this.getShardIndex(roomId);
        if (!this.shards[idx].messages.has(roomId)) return [];
        return this.shards[idx].messages.get(roomId).slice(-limit);
    }

    // ===== BOOKMARKS =====
    bookmarkPost(postId, userId) {
        const idx = this.getShardIndex(userId);
        if (!this.shards[idx].bookmarks.has(userId)) {
            this.shards[idx].bookmarks.set(userId, new Set());
        }
        const bookmarks = this.shards[idx].bookmarks.get(userId);
        if (bookmarks.has(postId)) {
            bookmarks.delete(postId);
            return { bookmarked: false };
        } else {
            bookmarks.add(postId);
            return { bookmarked: true };
        }
    }

    getBookmarks(userId) {
        const idx = this.getShardIndex(userId);
        if (!this.shards[idx].bookmarks.has(userId)) return [];
        const bookmarks = this.shards[idx].bookmarks.get(userId);
        const result = [];
        for (const id of bookmarks) {
            const post = this.getPost(id);
            if (post) result.push(post);
        }
        return result;
    }

    // ===== HASHTAGS =====
    getTrendingHashtags(limit = 10) {
        const allHashtags = new Map();
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            for (const [tag, posts] of this.shards[i].hashtags) {
                if (!allHashtags.has(tag)) {
                    allHashtags.set(tag, 0);
                }
                allHashtags.set(tag, allHashtags.get(tag) + posts.size);
            }
        }
        const sorted = Array.from(allHashtags.entries()).sort((a, b) => b[1] - a[1]);
        return sorted.slice(0, limit).map(([tag, count]) => ({ tag, count }));
    }

    // ===== NOTIFICATIONS =====
    addNotification(notification) {
        const idx = this.getShardIndex(notification.userId);
        this.shards[idx].notifications.push(notification);
        return notification;
    }

    getNotifications(userId, limit = 50) {
        const idx = this.getShardIndex(userId);
        const notifs = this.shards[idx].notifications || [];
        return notifs.slice(-limit).reverse();
    }

    markNotificationRead(notificationId, userId) {
        const idx = this.getShardIndex(userId);
        const notif = this.shards[idx].notifications.find(n => n.notificationId === notificationId);
        if (notif) {
            notif.isRead = true;
            return true;
        }
        return false;
    }

    // ===== LIVE STREAMS =====
    startLiveStream(userId, title) {
        const idx = this.getShardIndex(userId);
        const streamId = `live_${crypto.randomBytes(16).toString('hex')}`;
        const stream = {
            streamId,
            userId,
            title,
            viewers: new Set(),
            isLive: true,
            startedAt: new Date().toISOString(),
            endedAt: null,
            maxViewers: 0,
            totalViewers: 0
        };
        this.shards[idx].liveStreams.set(streamId, stream);
        this.logTransaction('startLiveStream', { streamId, userId });
        return streamId;
    }

    endLiveStream(streamId) {
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            if (this.shards[i].liveStreams.has(streamId)) {
                const stream = this.shards[i].liveStreams.get(streamId);
                stream.isLive = false;
                stream.endedAt = new Date().toISOString();
                return true;
            }
        }
        return false;
    }

    getLiveStreams() {
        const allStreams = [];
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            for (const [key, stream] of this.shards[i].liveStreams) {
                if (stream.isLive) {
                    allStreams.push({
                        ...stream,
                        viewers: Array.from(stream.viewers)
                    });
                }
            }
        }
        return allStreams;
    }

    joinLiveStream(streamId, userId) {
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            if (this.shards[i].liveStreams.has(streamId)) {
                const stream = this.shards[i].liveStreams.get(streamId);
                if (stream.isLive && !stream.viewers.has(userId)) {
                    stream.viewers.add(userId);
                    stream.totalViewers++;
                    if (stream.viewers.size > stream.maxViewers) {
                        stream.maxViewers = stream.viewers.size;
                    }
                    return true;
                }
            }
        }
        return false;
    }

    leaveLiveStream(streamId, userId) {
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            if (this.shards[i].liveStreams.has(streamId)) {
                const stream = this.shards[i].liveStreams.get(streamId);
                stream.viewers.delete(userId);
                return true;
            }
        }
        return false;
    }

    // ===== STATS =====
    getStats() {
        let totalUsers = 0, totalPosts = 0, totalStories = 0;
        let totalMessages = 0, totalLikes = 0, totalComments = 0;
        let totalViews = 0, totalShares = 0, totalNotifications = 0;

        for (let i = 0; i < this.SHARD_COUNT; i++) {
            totalUsers += this.shards[i].users.size;
            totalPosts += this.shards[i].posts.length;
            totalStories += this.shards[i].stories.length;
            totalLikes += this.shards[i].likes.size;
            totalViews += this.shards[i].views.size;
            totalShares += this.shards[i].shares.size;
            totalNotifications += this.shards[i].notifications.length;
            for (const post of this.shards[i].posts) {
                totalComments += (post.comments || []).length;
            }
            for (const [key, msgs] of this.shards[i].messages) {
                totalMessages += msgs.length;
            }
        }

        return {
            totalUsers,
            totalPosts,
            totalStories,
            totalMessages,
            totalLikes,
            totalComments,
            totalViews,
            totalShares,
            totalNotifications,
            shardCount: this.SHARD_COUNT,
            cacheHits: this.cacheStats.hits,
            cacheMisses: this.cacheStats.misses,
            cacheSize: this.cache.size,
            transactionLog: this.transactionLog.length
        };
    }

    // ===== CLEANUP =====
    cleanup() {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const oneMonth = 30 * oneDay;

        // Clean expired stories
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            this.shards[i].stories = this.shards[i].stories.filter(s => {
                const age = now - new Date(s.createdAt).getTime();
                return age < oneDay;
            });
        }

        // Clean old notifications
        for (let i = 0; i < this.SHARD_COUNT; i++) {
            this.shards[i].notifications = this.shards[i].notifications.filter(n => {
                const age = now - new Date(n.createdAt).getTime();
                return age < oneMonth;
            });
        }

        // Clean cache
        this.clearCache();
    }
}

// ============================================
// 🚀 CORE ENGINE
// ============================================
class CoreEngine {
    constructor() {
        this.app = express();
        this.server = null;
        this.io = null;
        this.db = new UltraShardedDatabase();
        this.encryption = new MilitaryEncryption();
        this.port = process.env.PORT || 3000;
        this.onlineUsers = new Map();
        
        // Configure Express
        this.app.use(helmet({
            contentSecurityPolicy: false,
            crossOriginEmbedderPolicy: false,
            crossOriginResourcePolicy: false
        }));
        this.app.use(compression());
        this.app.use(cors({
            origin: '*',
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization']
        }));
        this.app.use(express.json({ limit: '2gb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '2gb' }));
        this.app.use(express.static('public'));
        this.app.use('/uploads', express.static('uploads'));
        this.app.use(morgan('combined'));

        // ============================================
        // 📁 مسیردهی به فایل‌های W (Frontend)
        // ============================================
        // مسیردهی به index.html در پوشه W
        this.app.get('/', (req, res) => {
            const indexPath = path.join(__dirname, '../W/index.html');
            if (fs.existsSync(indexPath)) {
                res.sendFile(indexPath);
            } else {
                res.status(404).send('فایل index.html یافت نشد. لطفاً مطمئن شوید که در پوشه W قرار دارد.');
            }
        });

        // مسیردهی به فایل‌های استاتیک در پوشه W
        this.app.use('/static', express.static(path.join(__dirname, '../W')));

        // Create directories
        this.createDirectories();
        
        // Create admin account
        this.createAdminAccount();
    }

    createDirectories() {
        const dirs = [
            './uploads', './uploads/posts', './uploads/stories',
            './uploads/avatars', './uploads/live', './uploads/documents',
            './uploads/temp', './uploads/thumbnails', './public', './logs', './backups'
        ];
        dirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }

    createAdminAccount() {
        const adminEmail = 'milad.yari1377m@gmail.com';
        const adminPassword = 'M09145978426M';
        const adminUsername = 'milad_admin';

        const existing = this.db.getUserByEmail(adminEmail);
        if (!existing) {
            const adminId = this.encryption.generateId('admin');
            const admin = {
                userId: adminId,
                username: adminUsername,
                email: adminEmail,
                fullName: 'مدیر ارشد سیستم',
                password: this.encryption.hashPassword(adminPassword),
                bio: 'مدیر ارشد پلتفرم سوشال مدیا',
                avatar: '',
                followers: 0,
                following: 0,
                postsCount: 0,
                language: 'fa',
                theme: 'dark',
                isOnline: false,
                isAdmin: true,
                isBanned: false,
                isVerified: true,
                createdAt: new Date().toISOString(),
                lastSeen: new Date().toISOString()
            };
            this.db.saveUser(admin);
            console.log('═'.repeat(50));
            console.log('👑 ADMIN ACCOUNT CREATED');
            console.log('═'.repeat(50));
            console.log(`📧 Email: ${adminEmail}`);
            console.log(`🔑 Password: ${adminPassword}`);
            console.log(`👤 Username: ${adminUsername}`);
            console.log('═'.repeat(50));
        }
    }

    start() {
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"],
                credentials: true
            },
            transports: ['websocket', 'polling'],
            pingTimeout: 60000,
            pingInterval: 25000,
            maxHttpBufferSize: 2e9,
            allowEIO3: true
        });

        this.server.listen(this.port, '0.0.0.0', () => {
            console.log('═'.repeat(60));
            console.log('🚀 ULTIMATE SOCIAL MEDIA ENGINE');
            console.log('═'.repeat(60));
            console.log(`📍 http://localhost:${this.port}`);
            console.log(`💾 ${this.db.SHARD_COUNT} Shards`);
            console.log(`⚡ ${numCPUs} CPU Cores`);
            console.log(`🔐 AES-256-GCM Encryption`);
            console.log(`📦 2GB Max Payload Size`);
            console.log(`👑 Admin: milad.yari1377m@gmail.com`);
            console.log('═'.repeat(60));
            
            // Start cleanup scheduler
            setInterval(() => this.db.cleanup(), 60 * 60 * 1000);
        });

        return { 
            app: this.app, 
            server: this.server, 
            io: this.io, 
            db: this.db, 
            encryption: this.encryption,
            onlineUsers: this.onlineUsers
        };
    }
}

const const core = new CoreEngine();
const { app, server, io, db, encryption, onlineUsers } = core.start();

// ===== IMPORT API GATEWAY =====
const apiGateway = require('./m10.js');
apiGateway.init();

module.exports = { 
    app, 
    server, 
    io, 
    db, 
    encryption, 
    onlineUsers,
    core 
};
