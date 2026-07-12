// ============================================
// 📸 m3.js - POSTS, STORIES, LIKES, COMMENTS
// ============================================

const { app, db, io, encryption, authMiddleware, adminMiddleware } = require('./m1.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ============================================
// 📸 POST SERVICE
// ============================================
class PostService {
    constructor() {
        this.postCache = new Map();
        this.hashtagCache = new Map();
        this.trendingCache = null;
        this.trendingCacheTime = 0;
        this.CACHE_TTL = 10 * 1000;
        this.postReports = new Map();
        this.commentLikes = new Map();
        this.postAnalytics = new Map();
        this.postViews = new Map();
        this.savedPosts = new Map();
    }

    // ===== CREATE POST =====
    async createPost(data) {
        const { userId, username, fullName, caption, hashtags, file, isVideo, location, mentions } = data;

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر یافت نشد یا مسدود شده است' };
        }

        const postId = db.generateId('post');

        const post = {
            postId,
            userId,
            username: username || user.username,
            fullName: fullName || user.fullName || user.username,
            image: file,
            caption: caption || '',
            hashtags: hashtags ? hashtags.split(',').map(h => h.trim()).filter(h => h) : [],
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
            reported: false,
            reportedCount: 0,
            isSaved: false
        };

        db.savePost(post);
        db.updateUser(userId, { postsCount: (user.postsCount || 0) + 1 });

        this.postCache.clear();
        this.hashtagCache.clear();
        this.trendingCache = null;

        // Track analytics
        this.trackPostAnalytics(postId, 'create');

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

    getPostWithDetails(postId, viewerId = null) {
        const post = db.getPost(postId);
        if (!post) return null;

        const isLiked = viewerId ? this.isLiked(postId, viewerId) : false;
        const isBookmarked = viewerId ? this.isBookmarked(postId, viewerId) : false;
        const user = db.getUser(post.userId);

        // Track view
        if (viewerId && viewerId !== post.userId) {
            this.trackPostView(postId, viewerId);
        }

        return {
            ...post,
            userAvatar: user?.avatar || '',
            userFullName: user?.fullName || post.fullName,
            isLiked,
            isBookmarked,
            comments: post.comments || [],
            viewCount: this.getPostViewCount(postId)
        };
    }

    isLiked(postId, userId) {
        const likeKey = `${postId}_${userId}`;
        const idx = db.getShardIndex(postId);
        return db.shards[idx].likes.has(likeKey);
    }

    isBookmarked(postId, userId) {
        const idx = db.getShardIndex(userId);
        if (!db.shards[idx].bookmarks.has(userId)) return false;
        return db.shards[idx].bookmarks.get(userId).has(postId);
    }

    // ===== POST VIEWS =====
    trackPostView(postId, userId) {
        const key = `${postId}_${userId}`;
        if (!this.postViews.has(key)) {
            this.postViews.set(key, {
                postId,
                userId,
                count: 0,
                lastView: null
            });
        }
        const view = this.postViews.get(key);
        view.count += 1;
        view.lastView = new Date().toISOString();
    }

    getPostViewCount(postId) {
        let total = 0;
        for (const [key, view] of this.postViews) {
            if (view.postId === postId) {
                total += view.count;
            }
        }
        return total;
    }

    getPostViewers(postId, limit = 10) {
        const viewers = [];
        for (const [key, view] of this.postViews) {
            if (view.postId === postId) {
                const user = db.getUser(view.userId);
                if (user) {
                    viewers.push({
                        userId: user.userId,
                        username: user.username,
                        fullName: user.fullName,
                        avatar: user.avatar,
                        lastView: view.lastView,
                        count: view.count
                    });
                }
            }
        }
        return viewers.slice(0, limit);
    }

    // ===== POST ANALYTICS =====
    trackPostAnalytics(postId, action) {
        if (!this.postAnalytics.has(postId)) {
            this.postAnalytics.set(postId, {
                likes: 0,
                comments: 0,
                shares: 0,
                views: 0,
                saves: 0,
                createdAt: new Date().toISOString()
            });
        }
        const stats = this.postAnalytics.get(postId);
        if (action === 'like') stats.likes += 1;
        else if (action === 'comment') stats.comments += 1;
        else if (action === 'share') stats.shares += 1;
        else if (action === 'view') stats.views += 1;
        else if (action === 'save') stats.saves += 1;
    }

    getPostAnalytics(postId) {
        return this.postAnalytics.get(postId) || {
            likes: 0,
            comments: 0,
            shares: 0,
            views: 0,
            saves: 0,
            createdAt: null
        };
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
        this.postAnalytics.delete(postId);

        return { success: true };
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

    // ===== COMMENTS =====
    getPostComments(postId) {
        return db.getComments(postId);
    }

    async addComment(postId, data) {
        const { userId, username, fullName, text } = data;

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر یافت نشد یا مسدود شده است' };
        }

        if (!text || text.trim().length === 0) {
            return { success: false, error: 'متن کامنت الزامی است' };
        }

        const comment = {
            commentId: db.generateId('cmt'),
            userId: userId,
            username: username || user.username,
            fullName: fullName || user.fullName || user.username,
            text: text.trim(),
            createdAt: new Date().toISOString(),
            likes: 0
        };

        const added = db.addComment(postId, comment);
        if (!added) {
            return { success: false, error: 'پست یافت نشد' };
        }

        this.postCache.clear();
        this.trackPostAnalytics(postId, 'comment');

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

    async likeComment(postId, commentId, userId) {
        const key = `${commentId}_${userId}`;
        if (this.commentLikes.has(key)) {
            this.commentLikes.delete(key);
            return { liked: false };
        } else {
            this.commentLikes.set(key, true);
            return { liked: true };
        }
    }

    // ===== LIKES =====
    async likePost(postId, userId) {
        const result = db.likePost(postId, userId);
        if (result.liked) {
            this.trackPostAnalytics(postId, 'like');
        }
        this.postCache.clear();
        return result;
    }

    // ===== VIEWS =====
    async viewPost(postId, userId) {
        const viewed = db.viewPost(postId, userId);
        if (viewed) {
            this.postCache.clear();
            this.trackPostAnalytics(postId, 'view');
        }
        return { success: viewed };
    }

    // ===== SHARES =====
    async sharePost(postId, userId) {
        const shared = db.sharePost(postId, userId);
        if (shared) {
            this.postCache.clear();
            this.trackPostAnalytics(postId, 'share');
        }
        return { success: shared };
    }

    // ===== BOOKMARKS =====
    async bookmarkPost(postId, userId) {
        const result = db.bookmarkPost(postId, userId);
        if (result.bookmarked) {
            this.trackPostAnalytics(postId, 'save');
        }
        return result;
    }

    getBookmarks(userId) {
        return db.getBookmarks(userId);
    }

    // ===== REPORT =====
    async reportPost(postId, userId, reason) {
        const post = db.getPost(postId);
        if (!post) return { success: false, error: 'پست یافت نشد' };

        post.reported = true;
        post.reportedCount = (post.reportedCount || 0) + 1;
        post.reportReason = reason;
        post.reportedBy = userId;
        post.reportedAt = new Date().toISOString();

        db.savePost(post);
        return { success: true };
    }

    // ===== USER POSTS =====
    getUserPosts(userId, page = 1, limit = 20) {
        return db.getPosts(page, limit, null, userId);
    }

    // ===== SAVE POST =====
    async savePostToCollection(postId, userId, collectionName = 'default') {
        const key = `${userId}_${collectionName}`;
        if (!this.savedPosts.has(key)) {
            this.savedPosts.set(key, new Set());
        }
        const collection = this.savedPosts.get(key);
        if (collection.has(postId)) {
            collection.delete(postId);
            return { saved: false };
        } else {
            collection.add(postId);
            this.trackPostAnalytics(postId, 'save');
            return { saved: true };
        }
    }

    getSavedPosts(userId, collectionName = 'default') {
        const key = `${userId}_${collectionName}`;
        if (!this.savedPosts.has(key)) return [];
        const saved = this.savedPosts.get(key);
        const posts = [];
        for (const postId of saved) {
            const post = db.getPost(postId);
            if (post) posts.push(post);
        }
        return posts;
    }
}

const postService = new PostService();

// ============================================
// 📸 STORY SERVICE
// ============================================
class StoryService {
    constructor() {
        this.storyCache = new Map();
        this.CACHE_TTL = 5 * 1000;
        this.storyViews = new Map();
        this.storyReactions = new Map();
        this.storyAnalytics = new Map();
    }

    async createStory(data) {
        const { userId, username, fullName, file, isVideo, duration } = data;

        const user = db.getUser(userId);
        if (!user || user.isBanned) {
            return { success: false, error: 'کاربر یافت نشد یا مسدود شده است' };
        }

        const storyId = db.generateId('story');
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
            reactions: [],
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            isDeleted: false,
            hasMusic: false,
            music: null
        };

        db.saveStory(story);
        this.storyCache.clear();

        // Track analytics
        this.trackStoryAnalytics(storyId, 'create');

        return { success: true, story };
    }

    getStories(userId = null) {
        const cacheKey = `stories_${userId || 'all'}`;
        if (this.storyCache.has(cacheKey)) {
            return this.storyCache.get(cacheKey);
        }

        const stories = db.getStories(userId);
        this.storyCache.set(cacheKey, stories);
        setTimeout(() => this.storyCache.delete(cacheKey), this.CACHE_TTL);

        return stories;
    }

    getUserStories(userId) {
        return this.getStories(userId);
    }

    async deleteStory(storyId, userId) {
        const deleted = db.deleteStory(storyId, userId);
        if (!deleted) {
            return { success: false, error: 'استوری یافت نشد یا متعلق به شما نیست' };
        }
        this.storyCache.clear();
        this.storyAnalytics.delete(storyId);
        return { success: true };
    }

    async viewStory(storyId, userId) {
        const viewed = db.viewStory(storyId, userId);
        if (viewed) {
            this.storyCache.clear();
            this.trackStoryAnalytics(storyId, 'view');
        }
        return { success: viewed };
    }

    async reactToStory(storyId, userId, reaction) {
        const idx = db.getShardIndex(storyId);
        const story = db.shards[idx].stories.find(s => s.storyId === storyId);
        if (!story) return { success: false, error: 'استوری یافت نشد' };

        if (!story.reactions) story.reactions = [];
        
        const existingIndex = story.reactions.findIndex(r => r.userId === userId);
        if (existingIndex !== -1) {
            if (story.reactions[existingIndex].reaction === reaction) {
                story.reactions.splice(existingIndex, 1);
            } else {
                story.reactions[existingIndex].reaction = reaction;
                story.reactions[existingIndex].timestamp = new Date().toISOString();
            }
        } else {
            story.reactions.push({ userId, reaction, timestamp: new Date().toISOString() });
        }

        db.saveStory(story);
        this.storyCache.clear();
        this.trackStoryAnalytics(storyId, 'react');

        return { success: true, reactions: story.reactions };
    }

    trackStoryAnalytics(storyId, action) {
        if (!this.storyAnalytics.has(storyId)) {
            this.storyAnalytics.set(storyId, {
                views: 0,
                reactions: 0,
                createdAt: new Date().toISOString()
            });
        }
        const stats = this.storyAnalytics.get(storyId);
        if (action === 'view') stats.views += 1;
        else if (action === 'react') stats.reactions += 1;
    }

    getStoryAnalytics(storyId) {
        return this.storyAnalytics.get(storyId) || {
            views: 0,
            reactions: 0,
            createdAt: null
        };
    }
}

const storyService = new StoryService();

// ============================================
// 📡 POST ROUTES
// ============================================

app.get('/api/posts', authMiddleware, (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const hashtag = req.query.hashtag || null;
        const userId = req.query.userId || null;

        const result = postService.getPosts(page, limit, hashtag, userId);
        res.json(result);
    } catch (error) {
        console.error('Get posts error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/posts/:postId', authMiddleware, (req, res) => {
    try {
        const post = postService.getPostWithDetails(req.params.postId, req.user.userId);
        if (!post) return res.status(404).json({ error: 'پست یافت نشد' });
        res.json(post);
    } catch (error) {
        console.error('Get post error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.post('/api/posts/:postId/view', authMiddleware, async (req, res) => {
    try {
        const { postId } = req.params;
        const result = await postService.viewPost(postId, req.user.userId);
        res.json(result);
    } catch (error) {
        console.error('View post error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.put('/api/posts/:postId/like', authMiddleware, async (req, res) => {
    try {
        const { postId } = req.params;
        const result = await postService.likePost(postId, req.user.userId);
        
        if (result.liked) {
            const post = db.getPost(postId);
            if (post && post.userId !== req.user.userId) {
                const notification = {
                    notificationId: db.generateId('notif'),
                    userId: post.userId,
                    fromUserId: req.user.userId,
                    type: 'like',
                    postId: postId,
                    isRead: false,
                    createdAt: new Date().toISOString()
                };
                db.addNotification(notification);
                const socketId = encryption.getUserSocket(post.userId);
                if (socketId) {
                    io.to(socketId).emit('notification', {
                        type: 'like',
                        fromUserId: req.user.userId,
                        postId: postId
                    });
                }
            }
        }
        
        res.json(result);
    } catch (error) {
        console.error('Like post error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.post('/api/posts/:postId/comment', authMiddleware, async (req, res) => {
    try {
        const { postId } = req.params;
        const { text } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'متن کامنت الزامی است' });
        }

        const result = await postService.addComment(postId, {
            userId: req.user.userId,
            username: req.user.username,
            fullName: req.user.fullName,
            text
        });

        if (result.success) {
            const post = db.getPost(postId);
            if (post && post.userId !== req.user.userId) {
                const notification = {
                    notificationId: db.generateId('notif'),
                    userId: post.userId,
                    fromUserId: req.user.userId,
                    type: 'comment',
                    postId: postId,
                    isRead: false,
                    createdAt: new Date().toISOString()
                };
                db.addNotification(notification);
                const socketId = encryption.getUserSocket(post.userId);
                if (socketId) {
                    io.to(socketId).emit('notification', {
                        type: 'comment',
                        fromUserId: req.user.userId,
                        postId: postId
                    });
                }
            }
            res.status(201).json(result.comment);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Add comment error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.delete('/api/posts/:postId/comments/:commentId', authMiddleware, async (req, res) => {
    try {
        const { postId, commentId } = req.params;
        const result = await postService.deleteComment(postId, commentId, req.user.userId);
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(404).json(result);
        }
    } catch (error) {
        console.error('Delete comment error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/posts/:postId/comments', authMiddleware, (req, res) => {
    try {
        const comments = postService.getPostComments(req.params.postId);
        res.json(comments);
    } catch (error) {
        console.error('Get comments error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.post('/api/posts/:postId/share', authMiddleware, async (req, res) => {
    try {
        const { postId } = req.params;
        const result = await postService.sharePost(postId, req.user.userId);
        res.json(result);
    } catch (error) {
        console.error('Share post error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.post('/api/posts/:postId/bookmark', authMiddleware, async (req, res) => {
    try {
        const { postId } = req.params;
        const result = await postService.bookmarkPost(postId, req.user.userId);
        res.json(result);
    } catch (error) {
        console.error('Bookmark post error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/bookmarks', authMiddleware, (req, res) => {
    try {
        const bookmarks = postService.getBookmarks(req.user.userId);
        res.json(bookmarks);
    } catch (error) {
        console.error('Get bookmarks error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/trends', authMiddleware, (req, res) => {
    try {
        const trends = postService.getTrendingHashtags(10);
        res.json(trends);
    } catch (error) {
        console.error('Get trends error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.post('/api/posts/:postId/report', authMiddleware, async (req, res) => {
    try {
        const { postId } = req.params;
        const { reason } = req.body;
        if (!reason) {
            return res.status(400).json({ error: 'دلیل گزارش الزامی است' });
        }
        const result = await postService.reportPost(postId, req.user.userId, reason);
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(404).json(result);
        }
    } catch (error) {
        console.error('Report post error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/users/:userId/posts', authMiddleware, (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const result = postService.getUserPosts(req.params.userId, page, limit);
        res.json(result);
    } catch (error) {
        console.error('Get user posts error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/posts/:postId/analytics', authMiddleware, (req, res) => {
    try {
        const analytics = postService.getPostAnalytics(req.params.postId);
        res.json(analytics);
    } catch (error) {
        console.error('Get post analytics error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/posts/:postId/viewers', authMiddleware, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const viewers = postService.getPostViewers(req.params.postId, limit);
        res.json(viewers);
    } catch (error) {
        console.error('Get post viewers error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.post('/api/posts/:postId/save', authMiddleware, async (req, res) => {
    try {
        const { postId } = req.params;
        const { collectionName = 'default' } = req.body;
        const result = await postService.savePostToCollection(postId, req.user.userId, collectionName);
        res.json(result);
    } catch (error) {
        console.error('Save post error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/posts/saved', authMiddleware, (req, res) => {
    try {
        const { collectionName = 'default' } = req.query;
        const posts = postService.getSavedPosts(req.user.userId, collectionName);
        res.json(posts);
    } catch (error) {
        console.error('Get saved posts error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

// ============================================
// 📡 STORY ROUTES
// ============================================

app.get('/api/stories', authMiddleware, (req, res) => {
    try {
        const stories = storyService.getStories();
        res.json(stories);
    } catch (error) {
        console.error('Get stories error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/stories/:userId', authMiddleware, (req, res) => {
    try {
        const stories = storyService.getUserStories(req.params.userId);
        res.json(stories);
    } catch (error) {
        console.error('Get user stories error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/stories/:storyId', authMiddleware, (req, res) => {
    try {
        const { storyId } = req.params;
        const idx = db.getShardIndex(storyId);
        const story = db.shards[idx].stories.find(s => s.storyId === storyId);
        if (!story) return res.status(404).json({ error: 'استوری یافت نشد' });
        res.json(story);
    } catch (error) {
        console.error('Get story error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.post('/api/stories/:storyId/view', authMiddleware, async (req, res) => {
    try {
        const { storyId } = req.params;
        const result = await storyService.viewStory(storyId, req.user.userId);
        if (result.success) {
            const idx = db.getShardIndex(storyId);
            const story = db.shards[idx].stories.find(s => s.storyId === storyId);
            const analytics = storyService.getStoryAnalytics(storyId);
            res.json({ 
                success: true, 
                views: story?.views || 0, 
                viewers: story?.viewers || [],
                analytics: analytics
            });
        } else {
            res.json({ success: false });
        }
    } catch (error) {
        console.error('View story error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.post('/api/stories/:storyId/react', authMiddleware, async (req, res) => {
    try {
        const { storyId } = req.params;
        const { reaction } = req.body;
        if (!reaction) {
            return res.status(400).json({ error: 'واکنش الزامی است' });
        }
        const result = await storyService.reactToStory(storyId, req.user.userId, reaction);
        if (result.success) {
            io.to(`story_${storyId}`).emit('story-reaction', {
                storyId,
                userId: req.user.userId,
                reaction
            });
            res.json(result);
        } else {
            res.status(404).json(result);
        }
    } catch (error) {
        console.error('React to story error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.get('/api/stories/:storyId/analytics', authMiddleware, (req, res) => {
    try {
        const analytics = storyService.getStoryAnalytics(req.params.storyId);
        res.json(analytics);
    } catch (error) {
        console.error('Get story analytics error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

module.exports = {
    postService,
    storyService
};