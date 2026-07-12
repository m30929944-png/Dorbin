// ============================================
// 📸 m3.js - POSTS & STORIES
// ============================================

const { app, db, io, encryption, authMiddleware, adminMiddleware, upload, storyUpload } = require('./m1.js');
const path = require('path');
const fs = require('fs');

// ============================================
// 📸 POST SYSTEM
// ============================================
class PostSystem {
    constructor() {
        this.postCache = new Map();
        this.hashtagCache = new Map();
        this.trendingCache = null;
        this.trendingCacheTime = 0;
        this.CACHE_TTL = 10 * 1000;
    }

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
}

const postSystem = new PostSystem();

// ============================================
// 📸 STORY SYSTEM
// ============================================
class StorySystem {
    constructor() {
        this.storyCache = new Map();
        this.CACHE_TTL = 5 * 1000;
    }

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
            reactions: [],
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            isDeleted: false,
            hasMusic: false,
            music: null
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
}

const storySystem = new StorySystem();

// ============================================
// 📡 POST ROUTES
// ============================================
app.get('/api/posts', authMiddleware, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const hashtag = req.query.hashtag || null;
    const userId = req.query.userId || null;

    const result = postSystem.getPosts(page, limit, hashtag, userId);
    res.json(result);
});

app.post('/api/posts', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        const { caption, hashtags, location, mentions } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'فایل الزامی است' });
        }

        const result = await postSystem.createPost({
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
                io.to(`user_${follower.userId}`).emit('new-post', {
                    userId: result.post.userId,
                    postId: result.post.postId
                });
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

app.get('/api/posts/:postId', authMiddleware, (req, res) => {
    const post = postSystem.getPost(req.params.postId);
    if (!post) return res.status(404).json({ error: 'پست یافت نشد' });
    res.json(post);
});

app.delete('/api/posts/:postId', authMiddleware, async (req, res) => {
    const { postId } = req.params;
    const result = await postSystem.deletePost(postId, req.user.userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(404).json(result);
    }
});

app.get('/api/trends', authMiddleware, (req, res) => {
    const trends = postSystem.getTrendingHashtags(10);
    res.json(trends);
});

// ============================================
// 📡 STORY ROUTES
// ============================================
app.get('/api/stories', authMiddleware, (req, res) => {
    const stories = storySystem.getStories();
    res.json(stories);
});

app.get('/api/stories/:userId', authMiddleware, (req, res) => {
    const stories = storySystem.getStories(req.params.userId);
    res.json(stories);
});

app.post('/api/stories', authMiddleware, storyUpload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) {
        return res.status(400).json({ error: 'فایل الزامی است' });
    }

    const result = await storySystem.createStory({
        userId: req.user.userId,
        username: req.user.username,
        fullName: req.user.fullName,
        file: '/uploads/stories/' + file.filename,
        isVideo: file.mimetype.startsWith('video/')
    });

    if (result.success) {
        const followers = db.getFollowers(result.story.userId);
        for (const follower of followers) {
            io.to(`user_${follower.userId}`).emit('new-story', {
                userId: result.story.userId,
                storyId: result.story.storyId
            });
        }
        res.status(201).json(result.story);
    } else {
        res.status(400).json(result);
    }
});

app.delete('/api/stories/:storyId', authMiddleware, async (req, res) => {
    const { storyId } = req.params;
    const result = await storySystem.deleteStory(storyId, req.user.userId);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(404).json(result);
    }
});

app.post('/api/stories/:storyId/view', authMiddleware, async (req, res) => {
    const { storyId } = req.params;
    const result = await storySystem.viewStory(storyId, req.user.userId);
    res.json(result);
});

module.exports = {
    postSystem,
    storySystem
};