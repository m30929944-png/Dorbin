// ============================================
// 📸 POSTS & STORIES MANAGEMENT
// ============================================

const { db, encryption } = require('./m1.js');
const { v4: uuidv4 } = require('uuid');

class PostService {
    constructor() {
        this.postCache = new Map();
        this.storyCache = new Map();
        this.hashtagCache = new Map();
        this.trendingCache = null;
        this.trendingCacheTime = 0;
        this.CACHE_TTL = 10 * 1000;
    }

    // ===== CREATE POST =====
    async createPost(data) {
        const { userId, username, fullName, caption, hashtags, file, isVideo, location, mentions } = data;

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر یافت نشد یا مسدود شده است' };
        }

        const postId = encryption.generateId('post');

        const post = {
            postId,
            userId,
            username: username || user.username,
            fullName: fullName || user.fullName || user.username,
            image: file,
            caption: caption || '',
            hashtags: hashtags ? hashtags.split(',').map(h => h.trim()) : [],
            mentions: mentions || [],
            location: location || '',
            likes: 0,
            comments: [],
            shares: 0,
            views: 0,
            isVideo: isVideo || false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            isDeleted: false,
            reported: false
        };

        db.savePost(post);
        db.updateUser(userId, { postsCount: (user.postsCount || 0) + 1 });

        // Clear caches
        this.postCache.clear();
        this.hashtagCache.clear();
        this.trendingCache = null;

        return {
            success: true,
            post: post
        };
    }

    // ===== GET POSTS =====
    getPosts(page = 1, limit = 20, hashtag = null, userId = null) {
        const cacheKey = `posts_${page}_${limit}_${hashtag || 'all'}_${userId || 'all'}`;
        
        if (this.postCache.has(cacheKey)) {
            return this.postCache.get(cacheKey);
        }

        const result = db.getPosts(page, limit, hashtag, userId);
        
        this.postCache.set(cacheKey, result);
        setTimeout(() => this.postCache.delete(cacheKey), this.CACHE_TTL);

        return result;
    }

    // ===== GET SINGLE POST =====
    getPost(postId) {
        return db.getPost(postId);
    }

    // ===== DELETE POST =====
    async deletePost(postId, userId) {
        const post = db.getPost(postId);
        if (!post) return { success: false, error: 'پست یافت نشد' };
        if (post.userId !== userId) return { success: false, error: 'این پست متعلق به شما نیست' };

        db.deletePost(postId);
        const user = db.getUser(userId);
        if (user) {
            db.updateUser(userId, { postsCount: Math.max((user.postsCount || 0) - 1, 0) });
        }

        this.postCache.clear();
        this.hashtagCache.clear();
        this.trendingCache = null;

        return { success: true };
    }

    // ===== LIKE / UNLIKE =====
    async toggleLike(postId, userId) {
        const result = db.likePost(postId, userId);
        this.postCache.clear();
        return result;
    }

    // ===== VIEW POST =====
    async viewPost(postId, userId) {
        const result = db.viewPost(postId, userId);
        if (result) {
            this.postCache.clear();
        }
        return { success: result };
    }

    // ===== SHARE POST =====
    async sharePost(postId, userId) {
        const result = db.sharePost(postId, userId);
        if (result) {
            this.postCache.clear();
        }
        return { success: result };
    }

    // ===== COMMENTS =====
    async addComment(postId, data) {
        const { userId, username, fullName, text, parentId } = data;

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر یافت نشد یا مسدود شده است' };
        }

        if (!text || text.trim().length === 0) {
            return { success: false, error: 'متن کامنت الزامی است' };
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

        this.postCache.clear();

        return { success: true, comment };
    }

    async deleteComment(postId, commentId, userId) {
        const deleted = db.deleteComment(postId, commentId, userId);
        if (!deleted) {
            return { success: false, error: 'کامنت یافت نشد یا متعلق به شما نیست' };
        }

        this.postCache.clear();
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

        this.postCache.clear();
        return { success: true };
    }

    getComments(postId) {
        return db.getComments(postId);
    }

    // ===== BOOKMARKS =====
    async toggleBookmark(postId, userId) {
        const result = db.bookmarkPost(postId, userId);
        return result;
    }

    getBookmarks(userId) {
        return db.getBookmarks(userId);
    }

    // ===== HASHTAGS =====
    getTrendingHashtags(limit = 10) {
        const now = Date.now();
        if (this.trendingCache && now - this.trendingCacheTime < 60000) {
            return this.trendingCache;
        }

        const trends = db.getTrendingHashtags(limit);
        this.trendingCache = trends;
        this.trendingCacheTime = now;

        return trends;
    }

    // ===== STORIES =====
    async createStory(data) {
        const { userId, username, fullName, file, isVideo, duration } = data;

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر یافت نشد یا مسدود شده است' };
        }

        const storyId = encryption.generateId('story');
        const story = {
            storyId,
            userId,
            username: username || user.username,
            fullName: fullName || user.fullName || user.username,
            image: file,
            isVideo: isVideo || false,
            duration: duration || 5,
            views: 0,
            viewers: [],
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            isDeleted: false
        };

        db.saveStory(story);
        this.storyCache.clear();

        return { success: true, story };
    }

    getStories(userId = null) {
        const cacheKey = `stories_${userId || 'all'}`;
        if (this.storyCache.has(cacheKey)) {
            return this.storyCache.get(cacheKey);
        }

        const stories = db.getStories(userId);
        this.storyCache.set(cacheKey, stories);
        setTimeout(() => this.storyCache.delete(cacheKey), 5000);

        return stories;
    }

    async deleteStory(storyId, userId) {
        const deleted = db.deleteStory(storyId, userId);
        if (!deleted) {
            return { success: false, error: 'استوری یافت نشد یا متعلق به شما نیست' };
        }

        this.storyCache.clear();
        return { success: true };
    }

    async viewStory(storyId, userId) {
        const viewed = db.viewStory(storyId, userId);
        if (viewed) {
            this.storyCache.clear();
        }
        return { success: viewed };
    }

    // ===== ADMIN =====
    async getAllPosts() {
        const result = db.getPosts(1, 100000);
        return result.posts;
    }

    async deletePostAdmin(postId) {
        return db.deletePost(postId);
    }

    // ===== CLEANUP =====
    cleanExpiredStories() {
        const allStories = db.getStories();
        const now = Date.now();
        
        for (const story of allStories) {
            const age = now - new Date(story.createdAt).getTime();
            if (age >= 24 * 60 * 60 * 1000) {
                db.deleteStory(story.storyId, story.userId);
            }
        }
    }
}

module.exports = new PostService();
