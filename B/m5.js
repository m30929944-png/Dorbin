// ============================================
// 💬 COMMENTS, LIKES & INTERACTIONS
// ============================================

const { db, encryption } = require('../A/m1.js');

class InteractionService {
    constructor() {
        this.likeCache = new Map();
        this.commentCache = new Map();
        this.interactionAnalytics = new Map();
        this.CACHE_TTL = 5 * 60 * 1000;
    }

    // ===== LIKE MANAGEMENT =====
    async toggleLike(postId, userId) {
        const result = db.likePost(postId, userId);
        
        this.likeCache.set(`like_${postId}_${userId}`, result.liked);
        this.trackInteraction('like', userId, postId);

        return result;
    }

    getLikeStatus(postId, userId) {
        const cacheKey = `like_${postId}_${userId}`;
        if (this.likeCache.has(cacheKey)) {
            return this.likeCache.get(cacheKey);
        }

        const post = db.getPost(postId);
        if (!post) return false;

        const likeKey = `${postId}_${userId}`;
        const idx = db.getShardIndex(postId);
        const liked = db.shards[idx].likes.has(likeKey);
        
        this.likeCache.set(cacheKey, liked);
        return liked;
    }

    getPostLikesCount(postId) {
        const post = db.getPost(postId);
        return post ? post.likes || 0 : 0;
    }

    // ===== COMMENT MANAGEMENT =====
    async addComment(postId, data) {
        const { userId, username, fullName, text, parentId } = data;

        if (!text || text.trim().length === 0) {
            return { success: false, error: 'متن کامنت الزامی است' };
        }

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر یافت نشد یا مسدود شده است' };
        }

        const comment = {
            commentId: encryption.generateId('cmt'),
            userId: userId,
            username: username || user.username,
            fullName: fullName || user.fullName || user.username,
            text: text.trim(),
            parentId: parentId || null,
            likes: 0,
            replies: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            isDeleted: false
        };

        const added = db.addComment(postId, comment);
        if (!added) {
            return { success: false, error: 'پست یافت نشد' };
        }

        this.commentCache.delete(`comments_${postId}`);
        this.trackInteraction('comment', userId, postId);

        return { success: true, comment };
    }

    async deleteComment(postId, commentId, userId) {
        const deleted = db.deleteComment(postId, commentId, userId);
        if (!deleted) {
            return { success: false, error: 'کامنت یافت نشد یا متعلق به شما نیست' };
        }

        this.commentCache.delete(`comments_${postId}`);
        return { success: true };
    }

    async editComment(postId, commentId, userId, text) {
        if (!text || text.trim().length === 0) {
            return { success: false, error: 'متن کامنت الزامی است' };
        }

        const edited = db.editComment(postId, commentId, userId, text.trim());
        if (!edited) {
            return { success: false, error: 'کامنت یافت نشد یا متعلق به شما نیست' };
        }

        this.commentCache.delete(`comments_${postId}`);
        return { success: true };
    }

    getComments(postId, includeReplies = true) {
        const cacheKey = `comments_${postId}`;
        if (this.commentCache.has(cacheKey)) {
            return this.commentCache.get(cacheKey);
        }

        const comments = db.getComments(postId);
        this.commentCache.set(cacheKey, comments);
        setTimeout(() => this.commentCache.delete(cacheKey), 5000);

        return comments;
    }

    async replyToComment(postId, commentId, data) {
        const { userId, username, fullName, text } = data;

        if (!text || text.trim().length === 0) {
            return { success: false, error: 'متن پاسخ الزامی است' };
        }

        const post = db.getPost(postId);
        if (!post || !post.comments) {
            return { success: false, error: 'پست یافت نشد' };
        }

        const parentComment = post.comments.find(c => c.commentId === commentId);
        if (!parentComment) {
            return { success: false, error: 'کامنت یافت نشد' };
        }

        if (!parentComment.replies) {
            parentComment.replies = [];
        }

        const reply = {
            replyId: encryption.generateId('reply'),
            userId: userId,
            username: username || db.getUser(userId)?.username || 'کاربر',
            fullName: fullName || db.getUser(userId)?.fullName || '',
            text: text.trim(),
            createdAt: new Date().toISOString(),
            likes: 0
        };

        parentComment.replies.push(reply);
        db.savePost(post);
        this.commentCache.delete(`comments_${postId}`);

        return { success: true, reply };
    }

    async deleteReply(postId, commentId, replyId, userId) {
        const post = db.getPost(postId);
        if (!post || !post.comments) {
            return { success: false, error: 'پست یافت نشد' };
        }

        const parentComment = post.comments.find(c => c.commentId === commentId);
        if (!parentComment || !parentComment.replies) {
            return { success: false, error: 'کامنت یافت نشد' };
        }

        const replyIndex = parentComment.replies.findIndex(
            r => r.replyId === replyId && r.userId === userId
        );
        if (replyIndex === -1) {
            return { success: false, error: 'پاسخ یافت نشد یا متعلق به شما نیست' };
        }

        parentComment.replies.splice(replyIndex, 1);
        db.savePost(post);
        this.commentCache.delete(`comments_${postId}`);

        return { success: true };
    }

    // ===== INTERACTION ANALYTICS =====
    trackInteraction(type, userId, targetId) {
        const key = `${type}_${userId}`;
        const now = Date.now();

        if (!this.interactionAnalytics.has(userId)) {
            this.interactionAnalytics.set(userId, {
                likes: 0,
                comments: 0,
                shares: 0,
                totalInteractions: 0,
                lastActive: now,
                dailyCount: 0,
                lastReset: now
            });
        }

        const stats = this.interactionAnalytics.get(userId);
        
        // Reset daily count if new day
        if (now - stats.lastReset > 24 * 60 * 60 * 1000) {
            stats.dailyCount = 0;
            stats.lastReset = now;
        }

        if (type === 'like') stats.likes = (stats.likes || 0) + 1;
        if (type === 'comment') stats.comments = (stats.comments || 0) + 1;
        if (type === 'share') stats.shares = (stats.shares || 0) + 1;
        
        stats.totalInteractions = (stats.likes || 0) + (stats.comments || 0) + (stats.shares || 0);
        stats.dailyCount++;
        stats.lastActive = now;
    }

    getUserInteractionStats(userId) {
        return this.interactionAnalytics.get(userId) || {
            likes: 0,
            comments: 0,
            shares: 0,
            totalInteractions: 0,
            lastActive: Date.now(),
            dailyCount: 0
        };
    }

    getTopInteractingUsers(limit = 10) {
        const users = Array.from(this.interactionAnalytics.entries());
        return users
            .sort((a, b) => b[1].totalInteractions - a[1].totalInteractions)
            .slice(0, limit)
            .map(([userId, stats]) => ({ userId, ...stats }));
    }

    // ===== ENGAGEMENT SCORE =====
    getPostEngagementScore(postId) {
        const post = db.getPost(postId);
        if (!post) return 0;

        const likes = post.likes || 0;
        const comments = (post.comments || []).length;
        const shares = post.shares || 0;
        const views = post.views || 0;
        const timeSince = Math.max(1, (Date.now() - new Date(post.createdAt).getTime()) / 3600000);

        // Weighted score with time decay
        const rawScore = (likes * 2) + (comments * 5) + (shares * 10) + (views * 0.5);
        const timeDecay = Math.exp(-0.1 * timeSince);
        
        return Math.round(rawScore * timeDecay);
    }

    getPopularPosts(limit = 10) {
        const allPosts = [];
        for (let i = 0; i < db.SHARD_COUNT; i++) {
            allPosts.push(...db.shards[i].posts);
        }

        return allPosts
            .filter(p => !p.isDeleted)
            .map(post => ({
                ...post,
                engagementScore: this.getPostEngagementScore(post.postId)
            }))
            .sort((a, b) => b.engagementScore - a.engagementScore)
            .slice(0, limit);
    }

    // ===== INTERACTION SUMMARY =====
    getInteractionSummary(postId) {
        const post = db.getPost(postId);
        if (!post) return null;

        return {
            postId: post.postId,
            likes: post.likes || 0,
            comments: (post.comments || []).length,
            shares: post.shares || 0,
            views: post.views || 0,
            engagementScore: this.getPostEngagementScore(postId),
            total: (post.likes || 0) + (post.comments || []).length + (post.shares || 0)
        };
    }

    // ===== CLEANUP =====
    cleanup() {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;

        // Clean old analytics (keep 30 days)
        for (const [userId, stats] of this.interactionAnalytics) {
            if (now - stats.lastActive > 30 * oneDay) {
                this.interactionAnalytics.delete(userId);
            }
        }

        // Clean caches
        if (this.likeCache.size > 10000) {
            const entries = Array.from(this.likeCache.keys()).slice(0, 1000);
            for (const key of entries) {
                this.likeCache.delete(key);
            }
        }
    }
}

module.exports = new InteractionService();
