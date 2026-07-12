// ============================================
// 📸 m3.js - POSTS, STORIES, LIKES, COMMENTS
// ============================================

const { app, db, io, encryption, authMiddleware, upload, storyUpload } = require('./m1.js');
const path = require('path');
const fs = require('fs');

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
    }

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
            reportedCount: 0
        };

        db.savePost(post);
        db.updateUser(userId, { postsCount: (user.postsCount || 0) + 1 });

        this.postCache.clear();
        this.hashtagCache.clear();
        this.trendingCache = null;

        return {
            success: true,
            post: post
        };
    }

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

    getPost(postId) {
        return db.getPost(postId);
    }

    getPostWithDetails(postId, viewerId = null) {
        const post = db.getPost(postId);
        if (!post) return null;

        const isLiked = viewerId ? this.isLiked(postId, viewerId) : false;
        const isBookmarked = viewerId ? this.isBookmarked(postId, viewerId) : false;
        const user = db.getUser(post.userId);

        return {
            ...post,
            userAvatar: user?.avatar || '',
            userFullName: user?.fullName || post.fullName,
            isLiked,
            isBookmarked,
            comments: post.comments || []
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

    async likePost(postId, userId) {
        const result = db.likePost(postId, userId);
        this.postCache.clear();
        return result;
    }

    async viewPost(postId, userId) {
        const viewed = db.viewPost(postId, userId);
        if (viewed) {
            this.postCache.clear();
        }
        return { success: viewed };
    }

    async sharePost(postId, userId) {
        const shared = db.sharePost(postId, userId);
        if (shared) {
            this.postCache.clear();
        }
        return { success: shared };
    }

    async bookmarkPost(postId, userId) {
        const result = db.bookmarkPost(postId, userId);
        return result;
    }

    getBookmarks(userId) {
        return db.getBookmarks(userId);
    }

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

    // ===== GET USER POSTS =====
    getUserPosts(userId, page = 1, limit = 20) {
        return db.getPosts(page, limit, null, userId);
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
        return { success: true };
    }

    async viewStory(storyId, userId) {
        const viewed = db.viewStory(storyId, userId);
        if (viewed) {
            this.storyCache.clear();
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

        return { success: true, reactions: story.reactions };
    }
}

const storyService = new StoryService();

// ============================================
// 📡 POST ROUTES
// ============================================

app.get('/api/posts', authMiddleware, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const hashtag = req.query.hashtag || null;
    const userId = req.query.userId || null;

    const result = postService.getPosts(page, limit, hashtag, userId);
    res.json(result);
});

app.get('/api/posts/:postId', authMiddleware, (req, res) => {
    const post = postService.getPostWithDetails(req.params.postId, req.user.userId);
    if (!post) return res.status(404).json({ error: 'پست یافت نشد' });
    res.json(post);
});

app.post('/api/posts', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        const { caption, hashtags, location, mentions } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'فایل الزامی است' });
        }

        const result = await postService.createPost({
            userId: req.user.userId,
            username: req.user.username,
            fullName: req.user.fullName,
            caption,
            hashtags,
            location,
            mentions: mentions ? mentions.split(',') : [],
            file: '/uploads/posts/' + file.filename,
            isVideo: file.mimetype.startsWith('video/')
        });

        if (result.success) {
            const followers = db.getFollowers(result.post.userId);
            for (const follower of followers) {
                const socketId = encryption.getUserSocket(follower.userId);
                if (socketId) {
                    io.to(socketId).emit('new-post', {
                        userId: result.post.userId,
                        postId: result.post.postId
                    });
                }
            }
            res.status(201).json(result.post);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Post creation error:', error);
        res.status(500).json({ error: 'خطای سرور' });
    }
});

app.delete('/api/posts/:postId', authMiddleware, async (req, res) => {
    const { postId } = req.params;
    const result = await postService.deletePost(postId, req.user.userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(404).json(result);
    }
});

app.post('/api/posts/:postId/view', authMiddleware, async (req, res) => {
    const { postId } = req.params;
    const result = await postService.viewPost(postId, req.user.userId);
    res.json(result);
});

app.put('/api/posts/:postId/like', authMiddleware, async (req, res) => {
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
});

app.post('/api/posts/:postId/comment', authMiddleware, async (req, res) => {
    const { postId } = req.params;
    const { text } = req.body;

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
});

app.delete('/api/posts/:postId/comments/:commentId', authMiddleware, async (req, res) => {
    const { postId, commentId } = req.params;
    const result = await postService.deleteComment(postId, commentId, req.user.userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(404).json(result);
    }
});

app.get('/api/posts/:postId/comments', authMiddleware, (req, res) => {
    const comments = postService.getPostComments(req.params.postId);
    res.json(comments);
});

app.post('/api/posts/:postId/share', authMiddleware, async (req, res) => {
    const { postId } = req.params;
    const result = await postService.sharePost(postId, req.user.userId);
    res.json(result);
});

app.post('/api/posts/:postId/bookmark', authMiddleware, async (req, res) => {
    const { postId } = req.params;
    const result = await postService.bookmarkPost(postId, req.user.userId);
    res.json(result);
});

app.get('/api/bookmarks', authMiddleware, (req, res) => {
    const bookmarks = postService.getBookmarks(req.user.userId);
    res.json(bookmarks);
});

app.get('/api/trends', authMiddleware, (req, res) => {
    const trends = postService.getTrendingHashtags(10);
    res.json(trends);
});

app.post('/api/posts/:postId/report', authMiddleware, async (req, res) => {
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
});

app.get('/api/users/:userId/posts', authMiddleware, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = postService.getUserPosts(req.params.userId, page, limit);
    res.json(result);
});

// ============================================
// 📡 STORY ROUTES
// ============================================

app.get('/api/stories', authMiddleware, (req, res) => {
    const stories = storyService.getStories();
    res.json(stories);
});

app.get('/api/stories/:userId', authMiddleware, (req, res) => {
    const stories = storyService.getUserStories(req.params.userId);
    res.json(stories);
});

app.post('/api/stories', authMiddleware, storyUpload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) {
        return res.status(400).json({ error: 'فایل الزامی است' });
    }

    const result = await storyService.createStory({
        userId: req.user.userId,
        username: req.user.username,
        fullName: req.user.fullName,
        file: '/uploads/stories/' + file.filename,
        isVideo: file.mimetype.startsWith('video/')
    });

    if (result.success) {
        const followers = db.getFollowers(result.story.userId);
        for (const follower of followers) {
            const socketId = encryption.getUserSocket(follower.userId);
            if (socketId) {
                io.to(socketId).emit('new-story', {
                    userId: result.story.userId,
                    storyId: result.story.storyId
                });
            }
        }
        res.status(201).json(result.story);
    } else {
        res.status(400).json(result);
    }
});

app.delete('/api/stories/:storyId', authMiddleware, async (req, res) => {
    const { storyId } = req.params;
    const result = await storyService.deleteStory(storyId, req.user.userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(404).json(result);
    }
});

app.post('/api/stories/:storyId/view', authMiddleware, async (req, res) => {
    const { storyId } = req.params;
    const result = await storyService.viewStory(storyId, req.user.userId);
    res.json(result);
});

app.post('/api/stories/:storyId/react', authMiddleware, async (req, res) => {
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
});

module.exports = {
    postService,
    storyService
};