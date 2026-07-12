// ============================================
// 📸 POSTS, STORIES & UPLOAD - m3.js
// ============================================
// این فایل شامل: مدیریت پست‌ها، استوری‌ها،
// آپلود فایل، هشتگ‌ها، گالری
// ============================================

const { app, db, io, encryption, authMiddleware, adminMiddleware } = require('./m1.js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');

// ============================================
// 📤 FILE UPLOAD CONFIG
// ============================================
const uploadDir = './uploads';
const maxFileSize = 2 * 1024 * 1024 * 1024; // 2GB

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir = './uploads/posts';
        if (file.fieldname === 'avatar') dir = './uploads/avatars';
        else if (file.fieldname === 'story') dir = './uploads/stories';
        else if (file.fieldname === 'live') dir = './uploads/live';
        else if (file.fieldname === 'document') dir = './uploads/documents';
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const fileFilter = (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 
                     'video/mp4', 'video/webm', 'video/ogg', 'application/pdf'];
    cb(null, allowed.includes(file.mimetype));
};

const upload = multer({
    storage: storage,
    limits: { fileSize: maxFileSize, files: 10 },
    fileFilter: fileFilter
});

const storyUpload = multer({
    storage: multer.diskStorage({
        destination: './uploads/stories',
        filename: (req, file, cb) => {
            cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`);
        }
    }),
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'];
        cb(null, allowed.includes(file.mimetype));
    }
});

const avatarUpload = multer({
    storage: multer.diskStorage({
        destination: './uploads/avatars',
        filename: (req, file, cb) => {
            cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`);
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        cb(null, allowed.includes(file.mimetype));
    }
});

// ============================================
// 🖼️ IMAGE PROCESSING
// ============================================
class ImageProcessor {
    constructor() {
        this.thumbnailDir = './uploads/thumbnails';
        if (!fs.existsSync(this.thumbnailDir)) {
            fs.mkdirSync(this.thumbnailDir, { recursive: true });
        }
    }

    async processImage(filePath, options = {}) {
        try {
            const {
                width = null,
                height = null,
                quality = 85,
                format = 'jpeg',
                resize = true,
                optimize = true,
                thumbnail = false,
                thumbnailSize = 200
            } = options;

            let image = sharp(filePath);
            const metadata = await image.metadata();

            if (resize && (width || height)) {
                image = image.resize({
                    width: width || metadata.width,
                    height: height || metadata.height,
                    fit: 'cover',
                    position: 'center',
                    withoutEnlargement: true
                });
            }

            if (optimize) {
                if (format === 'jpeg' || format === 'jpg') {
                    image = image.jpeg({ quality, progressive: true, mozjpeg: true });
                } else if (format === 'png') {
                    image = image.png({ quality: Math.min(quality, 100), compressionLevel: 9 });
                } else if (format === 'webp') {
                    image = image.webp({ quality, lossless: false });
                } else if (format === 'avif') {
                    image = image.avif({ quality });
                }
            }

            const outputPath = filePath.replace(path.extname(filePath), `.${format}`);
            await image.toFile(outputPath);

            let thumbnailPath = null;
            if (thumbnail) {
                const thumbDir = './uploads/thumbnails';
                if (!fs.existsSync(thumbDir)) {
                    fs.mkdirSync(thumbDir, { recursive: true });
                }
                thumbnailPath = path.join(thumbDir, `${path.basename(filePath, path.extname(filePath))}_thumb.${format}`);
                await sharp(filePath)
                    .resize(thumbnailSize, thumbnailSize, { fit: 'cover', position: 'center' })
                    .toFile(thumbnailPath);
            }

            if (filePath !== outputPath) {
                fs.unlinkSync(filePath);
            }

            return {
                success: true,
                path: outputPath,
                thumbnail: thumbnailPath,
                size: fs.statSync(outputPath).size,
                metadata: await sharp(outputPath).metadata()
            };
        } catch (error) {
            console.error('Image processing error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async createVideoThumbnail(videoPath, thumbnailTime = 1) {
        try {
            const thumbDir = './uploads/thumbnails';
            if (!fs.existsSync(thumbDir)) {
                fs.mkdirSync(thumbDir, { recursive: true });
            }
            const thumbnailPath = path.join(thumbDir, `${path.basename(videoPath, path.extname(videoPath))}_thumb.jpg`);
            
            // In production, use ffmpeg
            // For now, return a placeholder
            return thumbnailPath;
        } catch (error) {
            console.error('Video thumbnail error:', error);
            return null;
        }
    }
}

const imageProcessor = new ImageProcessor();

// ============================================
// 📸 POSTS SYSTEM
// ============================================
class PostSystem {
    constructor() {
        this.postCache = new Map();
        this.hashtagCache = new Map();
        this.trendingCache = null;
        this.trendingCacheTime = 0;
        this.CACHE_TTL = 10 * 1000;
        this.postAnalytics = new Map();
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

    getPostAnalytics(postId) {
        const post = db.getPost(postId);
        if (!post) return null;

        return {
            postId: post.postId,
            likes: post.likes || 0,
            comments: (post.comments || []).length,
            shares: post.shares || 0,
            views: post.views || 0,
            engagement: (post.likes || 0) + (post.comments || []).length + (post.shares || 0)
        };
    }
}

const postSystem = new PostSystem();

// ============================================
// 📸 STORIES SYSTEM
// ============================================
class StorySystem {
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
        const { caption, userId, username, hashtags, location, mentions } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'فایل الزامی است' });
        }

        // Process image if it's an image
        let filePath = '/uploads/posts/' + file.filename;
        if (file.mimetype.startsWith('image/')) {
            const processed = await imageProcessor.processImage(file.path, {
                quality: 85,
                format: 'webp',
                thumbnail: true,
                thumbnailSize: 200
            });
            if (processed.success) {
                filePath = processed.path.replace('./uploads', '/uploads');
            }
        }

        const result = await postSystem.createPost({
            userId: userId || req.user.userId,
            username: username || req.user.username,
            fullName: req.user.fullName,
            caption,
            hashtags,
            location,
            mentions: mentions ? mentions.split(',') : [],
            file: filePath,
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

app.post('/api/posts/:postId/report', authMiddleware, async (req, res) => {
    const { postId } = req.params;
    const { reason } = req.body;
    if (!reason) {
        return res.status(400).json({ error: 'دلیل گزارش الزامی است' });
    }
    const result = await postSystem.reportPost(postId, req.user.userId, reason);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(404).json(result);
    }
});

app.get('/api/posts/:postId/analytics', authMiddleware, (req, res) => {
    const analytics = postSystem.getPostAnalytics(req.params.postId);
    if (!analytics) return res.status(404).json({ error: 'پست یافت نشد' });
    res.json(analytics);
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
    const { userId, username } = req.body;
    const file = req.file;

    if (!file) {
        return res.status(400).json({ error: 'فایل الزامی است' });
    }

    let filePath = '/uploads/stories/' + file.filename;
    if (file.mimetype.startsWith('image/')) {
        const processed = await imageProcessor.processImage(file.path, {
            quality: 80,
            format: 'webp'
        });
        if (processed.success) {
            filePath = processed.path.replace('./uploads', '/uploads');
        }
    }

    const result = await storySystem.createStory({
        userId: userId || req.user.userId,
        username: username || req.user.username,
        fullName: req.user.fullName,
        file: filePath,
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

app.post('/api/stories/:storyId/react', authMiddleware, async (req, res) => {
    const { storyId } = req.params;
    const { reaction } = req.body;
    if (!reaction) {
        return res.status(400).json({ error: 'واکنش الزامی است' });
    }
    const result = await storySystem.reactToStory(storyId, req.user.userId, reaction);
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

// ============================================
// 📡 HASHTAG ROUTES
// ============================================
app.get('/api/trends', authMiddleware, (req, res) => {
    const trends = postSystem.getTrendingHashtags(10);
    res.json(trends);
});

app.get('/api/hashtags/:tag/posts', authMiddleware, (req, res) => {
    const { tag } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = postSystem.getPosts(page, limit, tag);
    res.json(result);
});

// ============================================
// 📡 AVATAR UPLOAD
// ============================================
app.post('/api/users/avatar', authMiddleware, avatarUpload.single('avatar'), async (req, res) => {
    const file = req.file;
    if (!file) {
        return res.status(400).json({ error: 'فایل الزامی است' });
    }

    const processed = await imageProcessor.processImage(file.path, {
        width: 400,
        height: 400,
        quality: 85,
        format: 'webp',
        thumbnail: true,
        thumbnailSize: 100
    });

    if (!processed.success) {
        return res.status(500).json({ error: 'خطا در پردازش تصویر' });
    }

    const avatarPath = processed.path.replace('./uploads', '/uploads');
    db.updateUser(req.user.userId, { avatar: avatarPath });

    res.json({ success: true, avatar: avatarPath });
});

// ============================================
// 📡 ADMIN POST ROUTES
// ============================================
app.get('/api/admin/posts', authMiddleware, adminMiddleware, async (req, res) => {
    const result = db.getPosts(1, 10000);
    res.json(result.posts);
});

app.delete('/api/admin/posts/:postId', authMiddleware, adminMiddleware, async (req, res) => {
    const { postId } = req.params;
    const deleted = db.deletePost(postId);
    res.json({ success: deleted });
});

module.exports = {
    postSystem,
    storySystem,
    imageProcessor,
    upload,
    storyUpload,
    avatarUpload
};