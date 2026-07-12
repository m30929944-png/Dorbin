const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: '*' } });

const PORT = 3000;
const JWT_SECRET = 'sadegram_secret_key_2024';

// =============================================
// اتصال به دیتابیس (MongoDB)
// =============================================
mongoose.connect('mongodb://127.0.0.1:27017/sadegram', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('✅ متصل به MongoDB'))
  .catch(err => console.log('❌ خطا در اتصال:', err));

// =============================================
// مدل‌ها (Schemas)
// =============================================
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    name: { type: String, default: '' },
    bio: { type: String, default: '' },
    avatar: { type: String, default: 'default.png' },
    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    createdAt: { type: Date, default: Date.now }
});

const PostSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    image: { type: String, required: true },
    caption: { type: String, default: '' },
    hashtags: [{ type: String }],
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    comments: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        text: { type: String, required: true },
        replies: [{
            userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            text: { type: String, required: true },
            createdAt: { type: Date, default: Date.now }
        }],
        createdAt: { type: Date, default: Date.now }
    }],
    createdAt: { type: Date, default: Date.now }
});

const StorySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    media: { type: String, required: true },
    type: { type: String, enum: ['image', 'video'], default: 'image' },
    views: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    expiresAt: { type: Date, default: () => new Date(Date.now() + 24*60*60*1000) },
    createdAt: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true },
    read: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Post = mongoose.model('Post', PostSchema);
const Story = mongoose.model('Story', StorySchema);
const Message = mongoose.model('Message', MessageSchema);

// =============================================
// تنظیمات آپلود فایل
// =============================================
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync('./uploads/avatars')) fs.mkdirSync('./uploads/avatars');
if (!fs.existsSync('./uploads/posts')) fs.mkdirSync('./uploads/posts');
if (!fs.existsSync('./uploads/stories')) fs.mkdirSync('./uploads/stories');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir = './uploads/posts';
        if (file.fieldname === 'avatar') dir = './uploads/avatars';
        if (file.fieldname === 'story') dir = './uploads/stories';
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, unique + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

// =============================================
// Middleware
// =============================================
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// =============================================
// توابع احراز هویت
// =============================================
const authMiddleware = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'لطفاً وارد شوید' });
        
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch {
        res.status(401).json({ error: 'توکن نامعتبر' });
    }
};

// =============================================
// API ها
// =============================================

// ثبت نام
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, name } = req.body;
        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: 'نام کاربری تکراری' });
        
        const hashed = await bcrypt.hash(password, 10);
        const user = new User({ username, password: hashed, name: name || username });
        await user.save();
        
        const token = jwt.sign({ userId: user._id }, JWT_SECRET);
        res.json({ token, userId: user._id, username: user.username });
    } catch (err) {
        res.status(500).json({ error: 'خطا در ثبت نام' });
    }
});

// ورود
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.status(401).json({ error: 'نام کاربری یا رمز اشتباه' });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'نام کاربری یا رمز اشتباه' });
        
        const token = jwt.sign({ userId: user._id }, JWT_SECRET);
        res.json({ token, userId: user._id, username: user.username });
    } catch (err) {
        res.status(500).json({ error: 'خطا در ورود' });
    }
});

// دریافت اطلاعات کاربر
app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.userId)
            .select('-password')
            .populate('followers', 'username avatar')
            .populate('following', 'username avatar');
        
        const posts = await Post.countDocuments({ userId: req.userId });
        res.json({ ...user.toObject(), postsCount: posts });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// دریافت پروفایل کاربر دیگر
app.get('/api/user/:id', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.params.id)
            .select('-password')
            .populate('followers', 'username avatar')
            .populate('following', 'username avatar');
        
        if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
        
        const posts = await Post.countDocuments({ userId: user._id });
        const isFollowing = user.followers.some(f => f._id.toString() === req.userId);
        
        res.json({ ...user.toObject(), postsCount: posts, isFollowing });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// بروزرسانی بیو
app.put('/api/bio', authMiddleware, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.userId, { bio: req.body.bio });
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// آپلود آواتار
app.post('/api/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'فایلی انتخاب نشده' });
        
        const avatarUrl = `/uploads/avatars/${req.file.filename}`;
        await User.findByIdAndUpdate(req.userId, { avatar: avatarUrl });
        res.json({ avatar: avatarUrl });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// فالو کردن
app.post('/api/follow/:id', authMiddleware, async (req, res) => {
    try {
        const targetId = req.params.id;
        const userId = req.userId;
        
        if (targetId === userId) return res.status(400).json({ error: 'نمی‌توانید خود را فالو کنید' });
        
        const target = await User.findById(targetId);
        if (!target) return res.status(404).json({ error: 'کاربر یافت نشد' });
        
        const isFollowing = target.followers.includes(userId);
        
        if (isFollowing) {
            await User.findByIdAndUpdate(targetId, { $pull: { followers: userId } });
            await User.findByIdAndUpdate(userId, { $pull: { following: targetId } });
        } else {
            await User.findByIdAndUpdate(targetId, { $push: { followers: userId } });
            await User.findByIdAndUpdate(userId, { $push: { following: targetId } });
        }
        
        res.json({ success: true, isFollowing: !isFollowing });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// ایجاد پست
app.post('/api/post', authMiddleware, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'فایلی انتخاب نشده' });
        
        const { caption, hashtags } = req.body;
        const post = new Post({
            userId: req.userId,
            image: `/uploads/posts/${req.file.filename}`,
            caption: caption || '',
            hashtags: hashtags ? hashtags.split(',').map(h => h.trim()) : []
        });
        await post.save();
        
        res.json({ success: true, postId: post._id });
    } catch {
        res.status(500).json({ error: 'خطا در آپلود' });
    }
});

// دریافت پست‌ها (اکسپلور)
app.get('/api/posts', authMiddleware, async (req, res) => {
    try {
        const posts = await Post.find()
            .sort({ createdAt: -1 })
            .limit(50)
            .populate('userId', 'username avatar')
            .populate('likes', 'username')
            .populate('comments.userId', 'username');
        
        const formatted = posts.map(p => ({
            ...p.toObject(),
            isLiked: p.likes.some(l => l._id.toString() === req.userId),
            likesCount: p.likes.length,
            commentsCount: p.comments.length
        }));
        
        res.json(formatted);
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// پست‌های یک کاربر
app.get('/api/user-posts/:id', authMiddleware, async (req, res) => {
    try {
        const posts = await Post.find({ userId: req.params.id })
            .sort({ createdAt: -1 })
            .populate('userId', 'username avatar')
            .populate('likes', 'username');
        
        res.json(posts);
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// لایک کردن
app.post('/api/like/:postId', authMiddleware, async (req, res) => {
    try {
        const post = await Post.findById(req.params.postId);
        if (!post) return res.status(404).json({ error: 'پست یافت نشد' });
        
        const isLiked = post.likes.includes(req.userId);
        if (isLiked) {
            post.likes.pull(req.userId);
        } else {
            post.likes.push(req.userId);
        }
        await post.save();
        
        res.json({ likesCount: post.likes.length, isLiked: !isLiked });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// کامنت گذاشتن
app.post('/api/comment/:postId', authMiddleware, async (req, res) => {
    try {
        const post = await Post.findById(req.params.postId);
        if (!post) return res.status(404).json({ error: 'پست یافت نشد' });
        
        post.comments.push({
            userId: req.userId,
            text: req.body.text
        });
        await post.save();
        
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// پاسخ به کامنت
app.post('/api/reply/:postId/:commentId', authMiddleware, async (req, res) => {
    try {
        const post = await Post.findById(req.params.postId);
        if (!post) return res.status(404).json({ error: 'پست یافت نشد' });
        
        const comment = post.comments.id(req.params.commentId);
        if (!comment) return res.status(404).json({ error: 'کامنت یافت نشد' });
        
        comment.replies.push({
            userId: req.userId,
            text: req.body.text
        });
        await post.save();
        
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// ایجاد استوری
app.post('/api/story', authMiddleware, upload.single('story'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'فایلی انتخاب نشده' });
        
        const story = new Story({
            userId: req.userId,
            media: `/uploads/stories/${req.file.filename}`,
            type: req.file.mimetype.startsWith('video') ? 'video' : 'image'
        });
        await story.save();
        
        // ارسال به همه کاربران آنلاین
        io.emit('new_story', { userId: req.userId, storyId: story._id });
        
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// دریافت استوری‌ها
app.get('/api/stories', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        const following = [...user.following, req.userId];
        
        const stories = await Story.find({
            userId: { $in: following },
            expiresAt: { $gt: new Date() }
        })
        .sort({ createdAt: -1 })
        .populate('userId', 'username avatar');
        
        const formatted = stories.map(s => ({
            ...s.toObject(),
            viewed: s.views.includes(req.userId),
            viewsCount: s.views.length,
            likesCount: s.likes.length
        }));
        
        res.json(formatted);
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// مشاهده استوری
app.post('/api/view-story/:storyId', authMiddleware, async (req, res) => {
    try {
        const story = await Story.findById(req.params.storyId);
        if (!story) return res.status(404).json({ error: 'استوری یافت نشد' });
        
        if (!story.views.includes(req.userId)) {
            story.views.push(req.userId);
            await story.save();
        }
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// لایک استوری
app.post('/api/like-story/:storyId', authMiddleware, async (req, res) => {
    try {
        const story = await Story.findById(req.params.storyId);
        if (!story) return res.status(404).json({ error: 'استوری یافت نشد' });
        
        if (!story.likes.includes(req.userId)) {
            story.likes.push(req.userId);
            await story.save();
        }
        res.json({ likesCount: story.likes.length });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// ارسال پیام
app.post('/api/message', authMiddleware, async (req, res) => {
    try {
        const { receiverId, text } = req.body;
        const message = new Message({
            senderId: req.userId,
            receiverId,
            text
        });
        await message.save();
        
        // ارسال به گیرنده اگر آنلاین باشد
        io.to(receiverId).emit('new_message', {
            senderId: req.userId,
            text,
            createdAt: message.createdAt
        });
        
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// دریافت پیام‌ها
app.get('/api/messages/:userId', authMiddleware, async (req, res) => {
    try {
        const messages = await Message.find({
            $or: [
                { senderId: req.userId, receiverId: req.params.userId },
                { senderId: req.params.userId, receiverId: req.userId }
            ]
        }).sort({ createdAt: 1 });
        
        res.json(messages);
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// جستجو
app.get('/api/search', authMiddleware, async (req, res) => {
    try {
        const q = req.query.q || '';
        const users = await User.find({
            username: { $regex: q, $options: 'i' }
        }).limit(10).select('username avatar name');
        
        const posts = await Post.find({
            $or: [
                { caption: { $regex: q, $options: 'i' } },
                { hashtags: { $regex: q, $options: 'i' } }
            ]
        }).limit(10).populate('userId', 'username avatar');
        
        res.json({ users, posts });
    } catch {
        res.status(500).json({ error: 'خطا' });
    }
});

// =============================================
// WebSocket (Socket.io)
// =============================================
io.on('connection', (socket) => {
    console.log('🔌 کاربر متصل شد');
    
    socket.on('auth', (userId) => {
        socket.join(userId);
        console.log(`✅ کاربر ${userId} متصل شد`);
    });
    
    socket.on('typing', ({ receiverId }) => {
        io.to(receiverId).emit('typing', { userId: socket.userId });
    });
    
    socket.on('disconnect', () => {
        console.log('❌ کاربر قطع شد');
    });
});

// =============================================
// اجرای سرور
// =============================================
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 سرور روی http://localhost:${PORT} اجرا شد`);
    console.log(`📱 برنامه را در مرورگر باز کنید`);
});
