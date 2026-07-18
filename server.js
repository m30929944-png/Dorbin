const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('./database');
const IntelligentAssistant = require('./assistant_logic');

// ============================================
// تنظیمات سرور
// ============================================
const app = express();
// پشت پراکسی (Codespaces، Nginx، لودبالانسر) اجرا می‌شه؛ بدون این خط express-rate-limit
// روی هدر X-Forwarded-For کرش می‌کنه (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = socketIO(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8 // 100MB
});
const db = new DatabaseManager();

// ============================================
// توکن ورود (ثبت‌نام/لاگین واقعی با ایمیل و رمز)
// چون سرور با cluster روی چند worker اجرا می‌شه، سکرت امضای توکن رو یک بار
// روی دیسک ذخیره می‌کنیم تا همه‌ی worker ها همون سکرت رو بخونن و توکن هرکدوم
// توسط بقیه هم قابل تایید باشه.
// ============================================
const sessionSecretPath = path.join(__dirname, '.session_secret');
let SESSION_SECRET;
try {
    if (fs.existsSync(sessionSecretPath)) {
        SESSION_SECRET = fs.readFileSync(sessionSecretPath, 'utf8').trim();
    }
    if (!SESSION_SECRET) {
        SESSION_SECRET = crypto.randomBytes(48).toString('hex');
        fs.writeFileSync(sessionSecretPath, SESSION_SECRET, { mode: 0o600 });
    }
} catch (e) {
    console.error('⚠️ خطا در بارگذاری سکرت نشست، از یک سکرت موقت استفاده می‌شه:', e.message);
    SESSION_SECRET = crypto.randomBytes(48).toString('hex');
}

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // ۳۰ روز

function signToken(userId) {
    const expires = Date.now() + TOKEN_TTL_MS;
    const payload = `${userId}.${expires}`;
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyToken(token) {
    try {
        const decoded = Buffer.from(String(token), 'base64url').toString('utf8');
        const parts = decoded.split('.');
        if (parts.length !== 3) return null;
        const [userId, expires, sig] = parts;
        const payload = `${userId}.${expires}`;
        const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
        const a = Buffer.from(sig, 'hex');
        const b = Buffer.from(expectedSig, 'hex');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        if (Date.now() > Number(expires)) return null;
        return userId;
    } catch (e) {
        return null;
    }
}

// ============================================
// امنیت و بهینه‌سازی
// ============================================
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors());

// محدودیت نرخ درخواست
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    message: { error: 'تعداد درخواست‌ها بیش از حد مجاز است' }
});
app.use('/api/', limiter);

// نکته مقیاس: مدیا (عکس/ویدیو) دیگه از این مسیر (JSON) رد نمی‌شه، از /api/upload چندبخشی رد می‌شه.
// به همین خاطر سقف JSON رو از ۱۰۰ مگابایت به یه مقدار منطقی برای متن کاهش دادیم -
// این از بلاک شدن event loop با پارس یه JSON غول‌پیکر (که کل سرور رو برای همه‌ی کاربرها هنگ می‌کرد) جلوگیری می‌کنه.
app.use(bodyParser.json({ limit: '3mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '3mb' }));
app.use(express.static(__dirname, {
    maxAge: '1d',
    etag: true
}));

// ============================================
// آپلود فایل (عکس/ویدیو) - استریم مستقیم به دیسک، نه Base64 توی JSON
// ============================================
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
            cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
        }
    }),
    limits: {
        fileSize: parseInt(process.env.MAX_UPLOAD_MB || '300', 10) * 1024 * 1024, // پیش‌فرض ۳۰۰ مگابایت
        files: 1
    },
    fileFilter: (req, file, cb) => {
        const allowed = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime|ogg))$/;
        if (allowed.test(file.mimetype)) return cb(null, true);
        cb(new Error('نوع فایل مجاز نیست (فقط عکس یا ویدیو)'));
    }
});

// محدودیت نرخ جداگانه و سخت‌گیرانه‌تر برای آپلود، تا مصرف دیسک/پهنای‌باند سوءاستفاده نشه
const uploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    message: { success: false, error: 'تعداد آپلودها بیش از حد مجاز است، کمی صبر کن' }
});

app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', etag: true }));

app.post('/api/upload', uploadLimiter, (req, res) => {
    // از multer.single به‌صورت دستی استفاده می‌کنیم تا خطاها (حجم زیاد، نوع نامعتبر و ...)
    // به‌جای کرش کردن سرور یا هنگ کردن درخواست، به‌صورت JSON تمیز به کاربر برگردن.
    upload.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ success: false, error: `حجم فایل بیشتر از حد مجاز (${process.env.MAX_UPLOAD_MB || 300} مگابایت) است` });
            }
            return res.status(400).json({ success: false, error: 'خطا در آپلود فایل: ' + err.message });
        } else if (err) {
            return res.status(400).json({ success: false, error: err.message || 'خطا در آپلود فایل' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'فایلی ارسال نشده' });
        }

        const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
        res.json({
            success: true,
            url: `/uploads/${req.file.filename}`,
            mediaType,
            size: req.file.size
        });
    });
});

// برای مانیتورینگ سلامت هر worker پشت لود بالانسر (Nginx/K8s) موقع مقیاس‌دهی افقی
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage().rss,
        shards: db.shardCount
    });
});

// ============================================
// بررسی ادمین
// ============================================
function isAdmin(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers['x-auth-token'] || '');
    const userId = verifyToken(token);
    if (!userId) {
        return res.status(401).json({ error: 'ورود الزامی است' });
    }
    // نقش رو از دیتابیس می‌خونیم، نه از چیزی که کلاینت فرستاده - چون کلاینت می‌تونه هدر رو جعل کنه
    db.query(userId, `SELECT role FROM users WHERE id = $1`, [userId]).then(r => {
        if (r.rows[0] && r.rows[0].role === 'admin') {
            req.currentUserId = userId;
            return next();
        }
        res.status(403).json({ error: 'دسترسی غیرمجاز' });
    }).catch(() => res.status(500).json({ error: 'خطای داخلی' }));
}

// ============================================
// API ثبت‌نام
// ============================================
app.post('/api/user/register', async (req, res) => {
    try {
        const { name, avatar } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'نام الزامی است' });
        }
        
        let id;
        const nameLower = name.trim().toLowerCase();
        if (nameLower === 'milad' || nameLower === 'مدیر سیستم' || nameLower === 'admin') {
            id = 'admin_milad';
        } else {
            id = 'user_' + crypto.randomBytes(8).toString('hex');
        }
        
        const channelId = 'channel_' + id;

        const check = await db.query(id, `SELECT id FROM users WHERE id = $1`, [id]);
        if (check.rows.length === 0) {
            await db.query(id, `
                INSERT INTO users (id, name, avatar, role, is_verified, score, created_at) 
                VALUES ($1, $2, $3, $4, 1, $5, CURRENT_TIMESTAMP)
            `, [id, name.trim(), avatar || null, id === 'admin_milad' ? 'admin' : 'user', id === 'admin_milad' ? 999999 : 0]);
            
            await db.query(id, `
                INSERT INTO channels (id, user_id, name, boost_level, created_at) 
                VALUES ($1, $2, $3, 'normal', CURRENT_TIMESTAMP)
            `, [channelId, id, name.trim() + ' - کانال']);
        }

        const u = await db.query(id, `SELECT id, name, avatar, score, role FROM users WHERE id = $1`, [id]);
        res.json({ success: true, user: u.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// محدودیت نرخ جداگانه برای لاگین/ثبت‌نام - جلوی حدس زدن رمز رو می‌گیره
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, error: 'تعداد تلاش‌ها بیش از حد مجاز است، کمی صبر کن' }
});

// ============================================
// API ثبت‌نام واقعی (یوزرنیم + ایمیل + رمز عبور)
// ============================================
app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const { username, email, password, name } = req.body || {};
        const uname = String(username || '').trim();
        const mail = String(email || '').trim().toLowerCase();
        const pass = String(password || '');
        const displayName = String(name || uname).trim();

        if (!uname || uname.length < 3) {
            return res.status(400).json({ success: false, error: 'نام کاربری باید حداقل ۳ کاراکتر باشد' });
        }
        if (!/^[a-zA-Z0-9_.]+$/.test(uname)) {
            return res.status(400).json({ success: false, error: 'نام کاربری فقط می‌تواند شامل حروف انگلیسی، عدد، نقطه و آندرلاین باشد' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
            return res.status(400).json({ success: false, error: 'ایمیل معتبر نیست' });
        }
        if (pass.length < 8) {
            return res.status(400).json({ success: false, error: 'رمز عبور باید حداقل ۸ کاراکتر باشد' });
        }

        const existing = db.findUserByUsernameOrEmail(uname) || db.findUserByUsernameOrEmail(mail);
        if (existing) {
            return res.status(409).json({ success: false, error: 'این نام کاربری یا ایمیل قبلاً ثبت شده است' });
        }

        const id = 'user_' + crypto.randomBytes(8).toString('hex');
        const channelId = 'channel_' + id;
        const passwordHash = db.hashPassword(pass);

        await db.query(id, `
            INSERT INTO users (id, name, username, email, password_hash, role, is_verified, score, created_at)
            VALUES ($1, $2, $3, $4, $5, 'user', 0, 0, CURRENT_TIMESTAMP)
        `, [id, displayName, uname, mail, passwordHash]);

        await db.query(id, `
            INSERT INTO channels (id, user_id, name, boost_level, created_at)
            VALUES ($1, $2, $3, 'normal', CURRENT_TIMESTAMP)
        `, [channelId, id, displayName + ' - کانال']);

        const token = signToken(id);
        const u = await db.query(id, `SELECT id, name, username, email, avatar, score, role FROM users WHERE id = $1`, [id]);
        res.json({ success: true, token, user: u.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// API ورود (لاگین با یوزرنیم/ایمیل + رمز عبور)
// ============================================
app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { identifier, password } = req.body || {};
        if (!identifier || !password) {
            return res.status(400).json({ success: false, error: 'نام کاربری/ایمیل و رمز عبور الزامی است' });
        }

        const row = db.findUserByUsernameOrEmail(identifier);
        if (!row || !row.password_hash || !db.verifyPassword(password, row.password_hash)) {
            return res.status(401).json({ success: false, error: 'نام کاربری/ایمیل یا رمز عبور اشتباه است' });
        }
        if (row.restricted) {
            return res.status(403).json({ success: false, error: 'حساب کاربری شما محدود شده است' });
        }

        const token = signToken(row.id);
        res.json({
            success: true,
            token,
            user: {
                id: row.id, name: row.name, username: row.username,
                email: row.email, avatar: row.avatar, score: row.score, role: row.role
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// API کاربر
// ============================================
app.get('/api/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const u = await db.query(id, `
            SELECT id, name, avatar, score, bio, role, is_verified, created_at 
            FROM users WHERE id = $1
        `, [id]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'کاربر یافت نشد' });
        const ch = await db.query(id, `SELECT followers_count FROM channels WHERE user_id = $1`, [id]);
        res.json({ ...u.rows[0], followers: ch.rows[0]?.followers_count || 0 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/user/avatar', async (req, res) => {
    try {
        const { userId, avatar } = req.body;
        await db.query(userId, `UPDATE users SET avatar = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [avatar, userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/bio', async (req, res) => {
    try {
        const { userId, bio } = req.body;
        await db.query(userId, `UPDATE users SET bio = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [bio, userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// پروفایل عمومی با کش
// ============================================
const profileCache = new Map();
const PROFILE_CACHE_TTL = 30000;

app.get('/api/profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { viewerId } = req.query;
        
        const cacheKey = `${userId}_${viewerId}`;
        const cached = profileCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < PROFILE_CACHE_TTL) {
            return res.json(cached.data);
        }

        const u = await db.query(userId, `
            SELECT id, name, avatar, bio, score, is_verified, created_at 
            FROM users WHERE id = $1
        `, [userId]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'کاربر یافت نشد' });

        const ch = await db.query(userId, `SELECT * FROM channels WHERE user_id = $1`, [userId]);
        const channel = ch.rows[0];

        const posts = await db.query(userId, `
            SELECT p.*, c.name as channel_name
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC LIMIT 30
        `, [userId]);

        let isFollowing = false;
        if (viewerId && viewerId !== userId) {
            const f = await db.query(userId, `
                SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2
            `, [viewerId, userId]);
            isFollowing = f.rows.length > 0;
        }

        const data = { user: u.rows[0], channel, posts: posts.rows, isFollowing };
        profileCache.set(cacheKey, { data, timestamp: Date.now() });
        
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// فالو / آنفالو با تراکنش
// ============================================
app.post('/api/follow', async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        if (!followerId || !followingId) {
            return res.status(400).json({ success: false, error: 'اطلاعات ناقص است' });
        }

        const result = db.followUser(followerId, followingId);
        if (result.success && !result.alreadyFollowing) {
            const assistant = new IntelligentAssistant(followerId, db);
            await assistant.updateUserActivity('follow');
            profileCache.clear();
        }

        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/unfollow', async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        db.unfollowUser(followerId, followingId);
        profileCache.clear();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// پست‌ها با پشتیبانی ویدیو
// ============================================
// ============================================
// استوری - عکس/ویدیو/متن ۲۴ ساعته + بازدیدکنندگان + هایلایت
// ============================================
app.post('/api/stories/create', async (req, res) => {
    try {
        const { userId, mediaUrl, mediaType, caption, bgColor, textColor } = req.body;
        if (!userId) {
            return res.status(400).json({ success: false, error: 'شناسه کاربر الزامی است' });
        }
        if (!mediaUrl && !(caption && caption.trim())) {
            return res.status(400).json({ success: false, error: 'استوری باید عکس/ویدیو یا متن داشته باشد' });
        }

        const userRow = await db.query(userId, `SELECT role, restricted FROM users WHERE id = $1`, [userId]);
        const u = userRow.rows[0];
        if (!u) return res.status(404).json({ success: false, error: 'کاربر پیدا نشد' });
        if (u.role === 'banned') return res.status(403).json({ success: false, error: 'حساب شما مسدود شده است' });
        if (u.restricted) return res.status(403).json({ success: false, error: 'حساب شما محدود شده است' });

        const storyId = crypto.randomUUID();
        const type = mediaUrl ? (mediaType === 'video' ? 'video' : 'image') : 'text';

        await db.query(userId, `
            INSERT INTO stories (id, user_id, media_url, media_type, caption, bg_color, text_color, views_count, created_at, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 0, CURRENT_TIMESTAMP, datetime('now', '+24 hours'))
        `, [storyId, userId, mediaUrl || null, type, (caption || '').trim().substring(0, 300) || null,
            bgColor || '#6c5ce7', textColor || '#ffffff']);

        res.json({ success: true, storyId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// فید استوری: خودِ کاربر + هرکسی که فالو می‌کنه، گروه‌بندی‌شده بر اساس کاربر
app.get('/api/stories/feed/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const followingRes = await db.query(userId, `SELECT following_id FROM follows WHERE follower_id = $1`, [userId]);
        const authorIds = [userId, ...followingRes.rows.map(r => r.following_id)];

        const groups = [];
        for (const authorId of authorIds) {
            try {
                const r = await db.query(authorId, `
                    SELECT s.*, u.name, u.avatar
                    FROM stories s JOIN users u ON u.id = s.user_id
                    WHERE s.user_id = $1 AND s.expires_at > CURRENT_TIMESTAMP
                    ORDER BY s.created_at ASC
                `, [authorId]);
                if (r.rows.length) {
                    groups.push({
                        user_id: authorId,
                        name: r.rows[0].name,
                        avatar: r.rows[0].avatar,
                        stories: r.rows.map(({ name, avatar, ...s }) => s)
                    });
                }
            } catch (e) {}
        }

        // خودِ کاربر همیشه اول فید باشه (مثل اینستاگرام)
        groups.sort((a, b) => (a.user_id === userId ? -1 : b.user_id === userId ? 1 : 0));
        res.json(groups);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/stories/:storyId/view', async (req, res) => {
    try {
        const { storyId } = req.params;
        const { viewerId, ownerId } = req.body;
        if (!viewerId || !ownerId) {
            return res.status(400).json({ success: false, error: 'اطلاعات ناقص است' });
        }
        if (viewerId === ownerId) return res.json({ success: true }); // بازدید خودِ صاحب استوری شمرده نمی‌شه

        const inserted = await db.query(ownerId, `
            INSERT OR IGNORE INTO story_views (id, story_id, viewer_id, viewed_at)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        `, [crypto.randomUUID(), storyId, viewerId]);

        if (inserted.rowCount > 0) {
            await db.query(ownerId, `UPDATE stories SET views_count = views_count + 1 WHERE id = $1`, [storyId]);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// فقط صاحب استوری می‌تونه لیست بازدیدکننده‌ها رو ببینه
app.get('/api/stories/:storyId/viewers', async (req, res) => {
    try {
        const { storyId } = req.params;
        const { ownerId } = req.query;
        if (!ownerId) return res.status(400).json({ error: 'شناسه صاحب استوری الزامی است' });

        const story = await db.query(ownerId, `SELECT user_id FROM stories WHERE id = $1`, [storyId]);
        if (!story.rows[0] || story.rows[0].user_id !== ownerId) {
            return res.status(403).json({ error: 'دسترسی غیرمجاز' });
        }

        const views = await db.query(ownerId, `
            SELECT viewer_id, viewed_at FROM story_views WHERE story_id = $1 ORDER BY viewed_at DESC
        `, [storyId]);

        const viewers = [];
        for (const v of views.rows) {
            try {
                const u = await db.query(v.viewer_id, `SELECT name, avatar FROM users WHERE id = $1`, [v.viewer_id]);
                viewers.push({ user_id: v.viewer_id, name: u.rows[0]?.name || 'کاربر', avatar: u.rows[0]?.avatar, viewed_at: v.viewed_at });
            } catch (e) {}
        }
        res.json(viewers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/stories/:storyId', async (req, res) => {
    try {
        const { storyId } = req.params;
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ success: false, error: 'شناسه کاربر الزامی است' });

        const result = await db.query(userId, `DELETE FROM stories WHERE id = $1 AND user_id = $2`, [storyId, userId]);
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'استوری پیدا نشد یا مالک آن نیستید' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/post/create', async (req, res) => {
    try {
        const { userId, content, mediaUrl, mediaType } = req.body;
        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, error: 'متن پست الزامی است' });
        }

        const userRow = await db.query(userId, `SELECT role, restricted FROM users WHERE id = $1`, [userId]);
        const u = userRow.rows[0];
        if (u?.role === 'banned') {
            return res.status(403).json({ success: false, error: 'حساب شما مسدود شده است' });
        }
        if (u?.restricted) {
            return res.status(403).json({ success: false, error: 'حساب شما محدود شده و امکان انتشار پست ندارید' });
        }

        const channel = await db.query(userId, `SELECT id FROM channels WHERE user_id = $1`, [userId]);
        if (channel.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });
        }

        const postId = crypto.randomUUID();
        const type = mediaType || 'none';
        
        await db.query(userId, `
            INSERT INTO posts (id, channel_id, content, media_url, media_type, is_published, published_at, created_at)
            VALUES ($1, $2, $3, $4, $5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [postId, channel.rows[0].id, content.trim(), mediaUrl || null, type]);

        await db.query(userId, `UPDATE channels SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`, [userId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('post');
        const boost = await assistant.boostVisibility();

        profileCache.clear();
        exploreCache.clear();

        res.json({ success: true, postId, boost });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// حذف پست توسط خودِ کاربر (فقط پست خودش، تایید مالکیت روی شارد خودش)
app.post('/api/post/:postId/delete', async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ success: false, error: 'شناسه کاربر الزامی است' });

        const channel = await db.query(userId, `SELECT id FROM channels WHERE user_id = $1`, [userId]);
        if (!channel.rows[0]) return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });

        const result = await db.query(userId, `DELETE FROM posts WHERE id = $1 AND channel_id = $2`, [postId, channel.rows[0].id]);
        if (result.rowCount === 0) {
            return res.status(403).json({ success: false, error: 'این پست مال شما نیست یا قبلاً حذف شده' });
        }
        await db.query(userId, `UPDATE channels SET posts_count = MAX(posts_count - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`, [userId]);

        profileCache.clear();
        exploreCache.clear();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/post/:postId/view', async (req, res) => {
    try {
        const { postId } = req.params;
        await db.query(postId, `UPDATE posts SET views = views + 1 WHERE id = $1`, [postId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// لایک و کامنت
// ============================================
app.post('/api/post/:postId/like', async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ success: false, error: 'کاربر نامعتبر' });

        const result = db.toggleLike(postId, userId);

        if (result.liked) {
            const assistant = new IntelligentAssistant(userId, db);
            await assistant.updateUserActivity('like');
        }

        profileCache.clear();
        exploreCache.clear();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/post/:postId/comment', async (req, res) => {
    try {
        const { postId } = req.params;
        const { userId, text } = req.body;
        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, error: 'متن کامنت الزامی است' });
        }

        // نام/آواتار کاربر رو از شارد خودش می‌خونیم و همون لحظه روی کامنت اسنپ‌شات می‌کنیم،
        // چون کامنت روی شارد پست ذخیره می‌شه (نه شارد کاربر) و JOIN بین شارد مختلف امکان‌پذیر نیست.
        const u = await db.query(userId, `SELECT name, avatar FROM users WHERE id = $1`, [userId]);
        const userName = u.rows[0]?.name || 'کاربر';
        const userAvatar = u.rows[0]?.avatar || null;

        const id = crypto.randomUUID();
        await db.query(postId, `
            INSERT INTO post_comments (id, post_id, user_id, user_name, user_avatar, text, created_at) 
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        `, [id, postId, userId, userName, userAvatar, text.trim()]);
        await db.query(postId, `UPDATE posts SET comments = comments + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [postId]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('comment');

        profileCache.clear();
        exploreCache.clear();
        res.json({ success: true, comment: { id, userId, text: text.trim(), name: userName, avatar: userAvatar } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/post/:postId/comments', async (req, res) => {
    try {
        const { postId } = req.params;
        const result = await db.query(postId, `
            SELECT id, user_id, user_name AS name, user_avatar AS avatar, text, created_at
            FROM post_comments
            WHERE post_id = $1 ORDER BY created_at ASC
        `, [postId]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// دستیار هوشمند
// ============================================
app.post('/api/assistant/train', async (req, res) => {
    try {
        const { userId, question, answer } = req.body;
        const id = crypto.randomUUID();

        await db.query(userId, `
            INSERT INTO assistant_training (id, user_id, type, question, answer, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [id, userId, 'qa', question, answer]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();

        res.json({ success: true, message: 'آموزش با موفقیت ثبت شد', boost });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/assistant/keyword', async (req, res) => {
    try {
        const { userId, keyword, response } = req.body;
        const id = crypto.randomUUID();

        await db.query(userId, `
            INSERT INTO assistant_training (id, user_id, type, keyword, response, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [id, userId, 'keyword', keyword, response]);

        const assistant = new IntelligentAssistant(userId, db);
        await assistant.updateUserActivity('train');
        const boost = await assistant.boostVisibility();

        res.json({ success: true, message: 'کلمه کلیدی با موفقیت ثبت شد', boost });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/assistant/schedule', async (req, res) => {
    try {
        const { userId, posts } = req.body;
        
        const channel = await db.query(userId, `SELECT id FROM channels WHERE user_id = $1`, [userId]);
        if (channel.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'کانالی یافت نشد' });
        }

        const assistant = new IntelligentAssistant(userId, db);
        const scheduled = await assistant.schedulePosts(posts);

        res.json({ success: true, message: `${posts.length} پست با موفقیت زمان‌بندی شد`, posts: scheduled });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/assistant/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const qa = await db.query(userId, `
            SELECT question, answer FROM assistant_training 
            WHERE user_id = $1 AND type = 'qa' ORDER BY created_at DESC
        `, [userId]);

        const keywords = await db.query(userId, `
            SELECT keyword, response FROM assistant_training 
            WHERE user_id = $1 AND type = 'keyword' ORDER BY created_at DESC
        `, [userId]);

        const posts = await db.query(userId, `
            SELECT p.*, c.name as channel_name 
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 0
            ORDER BY p.scheduled_time ASC
        `, [userId]);

        const assistant = new IntelligentAssistant(userId, db);
        const stats = await assistant.getStats();

        res.json({ qa: qa.rows, keywords: keywords.rows, posts: posts.rows, stats });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/assistant/chat/:targetUserId', async (req, res) => {
    try {
        const { targetUserId } = req.params;
        const { message } = req.body;

        const assistant = new IntelligentAssistant(targetUserId, db);
        const reply = await assistant.autoReply(message);

        res.json({ reply: reply || 'دستیار هنوز برای این موضوع آموزش ندیده 🤖' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// کانال و اکسپلور با کش
// ============================================
const exploreCache = new Map();
const EXPLORE_CACHE_TTL = 15000;

app.get('/api/explore', async (req, res) => {
    try {
        const cached = exploreCache.get('explore');
        if (cached && (Date.now() - cached.timestamp) < EXPLORE_CACHE_TTL) {
            return res.json(cached.data);
        }

        const result = await db.query(null, `
            SELECT 
                u.id as user_id,
                u.name,
                u.avatar,
                u.score,
                c.id as channel_id,
                c.followers_count,
                c.posts_count,
                c.boost_level,
                c.activity_score,
                (
                    SELECT json_group_array(
                        json_object(
                            'id', p.id,
                            'content', p.content,
                            'media_url', p.media_url,
                            'media_type', p.media_type,
                            'likes', p.likes,
                            'comments', p.comments,
                            'views', p.views,
                            'created_at', p.created_at
                        )
                    )
                    FROM posts p
                    WHERE p.channel_id = c.id AND p.is_published = 1
                    ORDER BY p.created_at DESC
                    LIMIT 5
                ) as recent_posts
            FROM channels c
            JOIN users u ON u.id = c.user_id
            WHERE c.posts_count > 0
            ORDER BY c.activity_score DESC, c.followers_count DESC
            LIMIT 50
        `);
        
        const items = result.rows.map(row => ({
            ...row,
            recent_posts: row.recent_posts ? JSON.parse(row.recent_posts) : []
        }));
        
        exploreCache.set('explore', { data: items, timestamp: Date.now() });
        res.json(items);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/channel/:userId/posts', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await db.query(userId, `
            SELECT p.*, c.name as channel_name
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 1
            ORDER BY p.created_at DESC LIMIT 50
        `, [userId]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) return res.json([]);
        
        const result = await db.query(null, `
            SELECT id, name, avatar, 'user' as type FROM users 
            WHERE name LIKE $1 AND id != 'admin_milad'
            UNION
            SELECT id, name, NULL as avatar, 'channel' as type FROM channels 
            WHERE name LIKE $1
            LIMIT 20
        `, [`%${q}%`]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// چت خصوصی با تاریخچه کامل
// ============================================
app.post('/api/chat/save', async (req, res) => {
    try {
        const { from, to, message } = req.body;
        const id = crypto.randomUUID();
        
        await db.query(from, `
            INSERT INTO messages (id, from_user, to_user, message, created_at) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `, [id, from, to, message]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/chat/history/:userId/:targetId', async (req, res) => {
    try {
        const { userId, targetId } = req.params;
        const result = await db.query(userId, `
            SELECT * FROM messages 
            WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
            ORDER BY created_at ASC LIMIT 200
        `, [userId, targetId]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/chat/list/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        // پیام‌های این کاربر رو جمع می‌کنیم (این کوئری به‌درستی بین همه‌ی شاردها پخش می‌شه چون فقط
        // روی جدول messages کار می‌کنه - مسیریابی ویژه‌ی messages این الگو رو تشخیص می‌ده)
        const msgResult = await db.query(userId, `
            SELECT from_user, to_user, message, created_at, is_read
            FROM messages
            WHERE from_user = $1 OR to_user = $1
        `, [userId]);

        const lastMsgMap = new Map(); // partnerId -> { message, created_at }
        const unreadMap = new Map();  // partnerId -> count

        for (const m of msgResult.rows) {
            const partnerId = m.from_user === userId ? m.to_user : m.from_user;
            const cur = lastMsgMap.get(partnerId);
            if (!cur || new Date(m.created_at) > new Date(cur.created_at)) {
                lastMsgMap.set(partnerId, { message: m.message, created_at: m.created_at });
            }
            if (m.to_user === userId && !m.is_read) {
                unreadMap.set(partnerId, (unreadMap.get(partnerId) || 0) + 1);
            }
        }

        // هر طرف مکالمه رو از شارد خودش می‌خونیم (چون کاربر ممکنه روی شارد کاملاً متفاوتی نسبت به پیام باشه)
        const chats = [];
        for (const partnerId of lastMsgMap.keys()) {
            try {
                const u = await db.query(partnerId, `SELECT id, name, avatar FROM users WHERE id = $1`, [partnerId]);
                if (u.rows[0]) {
                    const info = lastMsgMap.get(partnerId);
                    chats.push({
                        id: partnerId,
                        name: u.rows[0].name,
                        avatar: u.rows[0].avatar,
                        lastMessage: info.message,
                        lastTime: info.created_at,
                        unreadCount: unreadMap.get(partnerId) || 0
                    });
                }
            } catch (e) {}
        }

        chats.sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
        res.json(chats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/chat/read', async (req, res) => {
    try {
        const { userId, fromUser } = req.body;
        await db.query(userId, `
            UPDATE messages SET is_read = 1 
            WHERE from_user = $1 AND to_user = $2 AND is_read = 0
        `, [fromUser, userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// پنل مدیریت کامل
// ============================================
app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const users = await db.query(null, `
            SELECT u.*, c.followers_count, c.posts_count 
            FROM users u
            LEFT JOIN channels c ON u.id = c.user_id
            ORDER BY u.created_at DESC
        `);
        res.json(users.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/user/:action', isAdmin, async (req, res) => {
    try {
        const { action } = req.params;
        const { userId } = req.body;
        
        const actions = {
            verify: `UPDATE users SET is_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            unverify: `UPDATE users SET is_verified = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            ban: `UPDATE users SET role = 'banned', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            unban: `UPDATE users SET role = 'user', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            restrict: `UPDATE users SET restricted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            unrestrict: `UPDATE users SET restricted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`
        };
        
        if (!actions[action]) return res.status(400).json({ error: 'عملیات نامعتبر' });
        await db.query(null, actions[action], [userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/posts', isAdmin, async (req, res) => {
    try {
        const posts = await db.query(null, `
            SELECT p.*, u.name as user_name, c.name as channel_name
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            JOIN users u ON c.user_id = u.id
            ORDER BY p.created_at DESC LIMIT 100
        `);
        res.json(posts.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/post/delete', isAdmin, async (req, res) => {
    try {
        const { postId } = req.body;
        await db.query(null, `DELETE FROM posts WHERE id = $1`, [postId]);
        profileCache.clear();
        exploreCache.clear();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/channels', isAdmin, async (req, res) => {
    try {
        const channels = await db.query(null, `
            SELECT c.*, u.name as user_name, u.avatar
            FROM channels c
            JOIN users u ON c.user_id = u.id
            ORDER BY c.followers_count DESC
        `);
        res.json(channels.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/notifications/latest-broadcast/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await db.query(userId, `
            SELECT broadcast_id, title, message, created_at FROM system_notifications
            WHERE user_id = $1 AND type = 'broadcast'
            ORDER BY created_at DESC LIMIT 1
        `, [userId]);
        res.json(result.rows[0] || null);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    try {
        const { message, title } = req.body;
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'متن پیام الزامی است' });
        }

        // چون کاربرها بین چند شارد پخشن، باید روی هر شارد جدا insert بزنیم
        // (استفاده از یه اتصال تنها اینجا باعث خطای FK و rollback کل تراکنش برای کاربرهای شاردهای دیگه می‌شد)
        const broadcastId = crypto.randomUUID();
        let totalSent = 0;
        for (const conn of db.getAllShards()) {
            const users = conn.prepare(`SELECT id FROM users`).all();
            if (!users.length) continue;

            const insert = conn.prepare(`
                INSERT INTO system_notifications (id, user_id, title, message, type, broadcast_id, created_at) 
                VALUES (?, ?, ?, ?, 'broadcast', ?, CURRENT_TIMESTAMP)
            `);
            const transaction = conn.transaction(() => {
                for (const user of users) {
                    insert.run(crypto.randomUUID(), user.id, title || 'اعلان سیستمی', message, broadcastId);
                }
            });
            transaction();

            for (const user of users) {
                io.to(`user_${user.id}`).emit('broadcast', { broadcastId, title: title || 'اعلان سیستمی', message });
            }
            totalSent += users.length;
        }

        res.json({ success: true, message: `پیام به ${totalSent} کاربر ارسال شد` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const users = await db.query(null, `SELECT COUNT(*) as total FROM users`);
        const posts = await db.query(null, `SELECT COUNT(*) as total FROM posts WHERE is_published = 1`);
        const channels = await db.query(null, `SELECT COUNT(*) as total FROM channels`);
        const messages = await db.query(null, `SELECT COUNT(*) as total FROM messages`);
        const follows = await db.query(null, `SELECT COUNT(*) as total FROM follows`);
        const comments = await db.query(null, `SELECT COUNT(*) as total FROM post_comments`);
        const trainings = await db.query(null, `SELECT COUNT(*) as total FROM assistant_training`);
        const reports = await db.query(null, `SELECT COUNT(*) as total FROM reports WHERE status = 'pending'`);

        res.json({
            users: users.rows[0]?.total || 0,
            posts: posts.rows[0]?.total || 0,
            channels: channels.rows[0]?.total || 0,
            messages: messages.rows[0]?.total || 0,
            follows: follows.rows[0]?.total || 0,
            comments: comments.rows[0]?.total || 0,
            trainings: trainings.rows[0]?.total || 0,
            pendingReports: reports.rows[0]?.total || 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// گزارش‌ها (پست/کاربر/کامنت)
// ============================================
app.post('/api/report', async (req, res) => {
    try {
        const { reporterId, targetId, targetType, reason } = req.body;
        if (!reporterId || !targetId || !targetType || !reason || !reason.trim()) {
            return res.status(400).json({ success: false, error: 'اطلاعات گزارش ناقص است' });
        }
        if (!['user', 'post', 'comment'].includes(targetType)) {
            return res.status(400).json({ success: false, error: 'نوع گزارش نامعتبر است' });
        }

        const id = crypto.randomUUID();
        // با کلید ثابت می‌نویسیم (نه null) تا گزارش فقط روی یه شارد مشخص ذخیره بشه، نه اینکه
        // روی هر ۱۵۰ شارد کپی تکراری بسازه (db.query(null,...) برای INSERT یعنی پخش روی همه‌ی شاردها)
        await db.query('global_reports', `
            INSERT INTO reports (id, reporter_id, target_id, target_type, reason, status, created_at)
            VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP)
        `, [id, reporterId, targetId, targetType, reason.trim().substring(0, 500)]);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/reports', isAdmin, async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const reports = await db.query(null, `
            SELECT * FROM reports WHERE status = $1 ORDER BY created_at DESC LIMIT 200
        `, [status]);
        res.json(reports.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/report/:action', isAdmin, async (req, res) => {
    try {
        const { action } = req.params;
        const { reportId } = req.body;
        if (!['resolve', 'dismiss'].includes(action)) {
            return res.status(400).json({ error: 'عملیات نامعتبر' });
        }
        const status = action === 'resolve' ? 'resolved' : 'dismissed';
        await db.query(null, `
            UPDATE reports SET status = $1, resolved_at = CURRENT_TIMESTAMP WHERE id = $2
        `, [status, reportId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ارتقای پست - رسید پرداخت کارت‌به‌کارت + تایید/رد توسط مدیر
// ============================================
app.post('/api/payment/submit', async (req, res) => {
    try {
        const { userId, postId, amount, receiptUrl } = req.body;
        if (!userId || !receiptUrl) {
            return res.status(400).json({ success: false, error: 'اطلاعات فیش ناقص است' });
        }
        if (typeof receiptUrl !== 'string' || !receiptUrl.startsWith('/uploads/')) {
            return res.status(400).json({ success: false, error: 'فایل رسید نامعتبر است' });
        }

        const id = crypto.randomUUID();
        // همون دلیل بالا: کلید ثابت به‌جای null، تا فیش فقط یه بار ذخیره بشه نه ۱۵۰ بار
        await db.query('global_payment_receipts', `
            INSERT INTO payment_receipts (id, user_id, post_id, receipt_image, amount, status, created_at)
            VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP)
        `, [id, userId, postId || null, receiptUrl, amount ? String(amount).substring(0, 40) : null]);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/payments', isAdmin, async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const result = await db.query(null, `
            SELECT * FROM payment_receipts WHERE status = $1 ORDER BY created_at DESC LIMIT 200
        `, [status]);

        const receipts = result.rows;
        const userIds = [...new Set(receipts.map(r => r.user_id))];
        const nameMap = {};
        for (const uid of userIds) {
            try {
                const u = await db.query(uid, `SELECT name FROM users WHERE id = $1`, [uid]);
                if (u.rows[0]) nameMap[uid] = u.rows[0].name;
            } catch (e) {}
        }
        res.json(receipts.map(r => ({ ...r, user_name: nameMap[r.user_id] || r.user_id })));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/payments/:id/:action', isAdmin, async (req, res) => {
    try {
        const { id, action } = req.params;
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: 'عملیات نامعتبر' });
        }
        const status = action === 'approve' ? 'approved' : 'rejected';

        const existing = await db.query(null, `SELECT * FROM payment_receipts WHERE id = $1 LIMIT 1`, [id]);
        const receipt = existing.rows[0];
        if (!receipt) return res.status(404).json({ error: 'رسید پیدا نشد' });

        await db.query(null, `
            UPDATE payment_receipts SET status = $1, reviewed_at = CURRENT_TIMESTAMP WHERE id = $2
        `, [status, id]);

        const title = action === 'approve' ? '✅ فیش واریزی تایید شد' : '❌ فیش واریزی رد شد';
        const message = action === 'approve'
            ? 'رسید پرداخت شما بررسی و تایید شد. ممنون از حمایتت 🙏'
            : 'رسید پرداختی که فرستاده بودی رد شد. اگه فکر می‌کنی اشتباهی رخ داده، دوباره یه فیش واضح‌تر ارسال کن.';

        try {
            await db.query(receipt.user_id, `
                INSERT INTO system_notifications (id, user_id, title, message, type, created_at)
                VALUES ($1, $2, $3, $4, 'payment', CURRENT_TIMESTAMP)
            `, [crypto.randomUUID(), receipt.user_id, title, message]);
        } catch (e) {}

        io.to(`user_${receipt.user_id}`).emit('broadcast', { title, message });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// مسدود کردن کاربر در چت خصوصی
// ============================================
app.post('/api/user/block', async (req, res) => {
    try {
        const { blockerId, blockedId } = req.body;
        if (!blockerId || !blockedId) return res.status(400).json({ success: false, error: 'اطلاعات ناقص است' });
        res.json(db.blockUser(blockerId, blockedId));
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/unblock', async (req, res) => {
    try {
        const { blockerId, blockedId } = req.body;
        res.json(db.unblockUser(blockerId, blockedId));
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/user/:userId/is-blocked/:targetId', async (req, res) => {
    try {
        const { userId, targetId } = req.params;
        res.json({ blocked: db.isBlocked(userId, targetId) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// تبلیغات داخل کانال‌ها
// ============================================
app.get('/api/ads/active', async (req, res) => {
    try {
        const ads = await db.query(null, `SELECT * FROM ads WHERE is_active = 1 ORDER BY created_at DESC LIMIT 20`);
        res.json(ads.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/ads', isAdmin, async (req, res) => {
    try {
        const ads = await db.query(null, `SELECT * FROM ads ORDER BY created_at DESC`);
        res.json(ads.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/ads/create', isAdmin, async (req, res) => {
    try {
        const { title, content, mediaUrl, mediaType, linkUrl } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ success: false, error: 'عنوان تبلیغ الزامی است' });

        const id = crypto.randomUUID();
        // همون دلیل بالا: کلید ثابت به‌جای null، تا هر تبلیغ فقط یه بار ذخیره بشه نه ۱۵۰ بار تکراری
        await db.query('global_ads', `
            INSERT INTO ads (id, title, content, media_url, media_type, link_url, is_active, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, 1, CURRENT_TIMESTAMP)
        `, [id, title.trim(), content || '', mediaUrl || null, mediaType || 'none', linkUrl || null]);

        res.json({ success: true, adId: id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/ads/toggle', isAdmin, async (req, res) => {
    try {
        const { adId, active } = req.body;
        await db.query(null, `UPDATE ads SET is_active = $1 WHERE id = $2`, [active ? 1 : 0, adId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/ads/delete', isAdmin, async (req, res) => {
    try {
        const { adId } = req.body;
        await db.query(null, `DELETE FROM ads WHERE id = $1`, [adId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// ۴۰۴ و مدیریت خطای سراسری - همیشه JSON تمیز برمی‌گردونه، نه HTML یا هنگ کردن
// ============================================
app.use('/api/', (req, res) => {
    res.status(404).json({ success: false, error: 'مسیر یافت نشد' });
});

app.use((err, req, res, next) => {
    console.error('Unhandled route error:', err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ success: false, error: 'خطای داخلی سرور' });
});

// ============================================
// WebSocket با پشتیبانی از میلیون‌ها کاربر
// ============================================
io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);
    let msgTimestamps = []; // محدودیت نرخ پیام برای همین اتصال

    socket.on('join', (userId) => {
        if (!userId) return;
        socket.data.userId = userId;
        socket.join(`user_${userId}`);
        console.log(`User ${userId} joined room`);
    });

    socket.on('private_message', async (data) => {
        const { from, to, message, mediaUrl, mediaType, timestamp } = data || {};

        const hasMedia = typeof mediaUrl === 'string' && mediaUrl.startsWith('/uploads/');
        const text = typeof message === 'string' ? message.trim() : '';

        if (!from || !to || (!text && !hasMedia)) {
            return io.to(`user_${from}`).emit('message_sent', { success: false, error: 'پیام نامعتبر است', timestamp });
        }
        if (text.length > 4000) {
            return io.to(`user_${from}`).emit('message_sent', { success: false, error: 'پیام خیلی طولانیه', timestamp });
        }
        if (db.isBlocked(from, to)) {
            return io.to(`user_${from}`).emit('message_sent', { success: false, error: 'امکان ارسال پیام به این کاربر وجود ندارد', timestamp });
        }

        // حداکثر ۲۰ پیام در ۱۰ ثانیه به‌ازای هر اتصال - جلوی اسپم سوکت رو می‌گیره
        // (این جدا از rate-limiter مسیرهای HTTP هست، چون سوکت‌ها از اون رد نمی‌شن)
        const now = Date.now();
        msgTimestamps = msgTimestamps.filter(t => now - t < 10000);
        if (msgTimestamps.length >= 20) {
            return io.to(`user_${from}`).emit('message_sent', { success: false, error: 'خیلی سریع پیام می‌فرستی، کمی صبر کن', timestamp });
        }
        msgTimestamps.push(now);

        const trimmed = text;
        const safeMediaType = hasMedia ? (mediaType === 'video' ? 'video' : 'image') : null;
        try {
            const id = crypto.randomUUID();
            await db.query(from, `
                INSERT INTO messages (id, from_user, to_user, message, media_url, media_type, created_at) 
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            `, [id, from, to, trimmed, hasMedia ? mediaUrl : null, safeMediaType]);

            io.to(`user_${to}`).emit('new_message', { from, message: trimmed, mediaUrl: hasMedia ? mediaUrl : null, mediaType: safeMediaType, timestamp });
            io.to(`user_${from}`).emit('message_sent', { success: true, timestamp });
        } catch (e) {
            console.error('save message error', e);
            io.to(`user_${from}`).emit('message_sent', { success: false, error: 'ذخیره پیام ناموفق بود', timestamp });
        }
    });

    socket.on('typing', (data) => {
        const { from, to } = data || {};
        if (!from || !to) return;
        io.to(`user_${to}`).emit('user_typing', { from });
    });

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// ============================================
// راه‌اندازی سرور
// ============================================
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await db.initTables();
        console.log('✅ Database ready');
        console.log('✅ Tables created/verified');

        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT} (pid ${process.pid})`);
            console.log(`📍 http://localhost:${PORT}`);
            console.log(`📊 Mode: ${process.env.NODE_ENV || 'development'} | Shards: ${db.shardCount}`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// ============================================
// ناشر دوره‌ای پست‌های زمان‌بندی‌شده - پشتیبان قابل‌اعتماد پشت مسیر سریع setTimeout
// مستقل از ری‌استارت worker اجرا می‌شه و هر پست عقب‌افتاده‌ای رو دیر یا زود منتشر می‌کنه.
// با «ادعا کردن» اتمیک (UPDATE ... WHERE is_published = 0) در برابر چند worker موازی امنه.
// ============================================
async function publishDueScheduledPosts() {
    try {
        const now = new Date().toISOString();
        const due = await db.query(null, `
            SELECT p.id, p.channel_id, c.user_id 
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE p.is_published = 0 AND p.scheduled_time IS NOT NULL AND p.scheduled_time <= $1
            LIMIT 200
        `, [now]);

        for (const row of due.rows) {
            try {
                const claim = await db.query(row.id, `
                    UPDATE posts SET is_published = 1, published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = $1 AND is_published = 0
                `, [row.id]);
                if (!claim.rowCount) continue; // یه worker دیگه زودتر منتشرش کرد

                await db.query(row.user_id, `UPDATE channels SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.channel_id]);

                const assistant = new IntelligentAssistant(row.user_id, db);
                await assistant.updateUserActivity('post');
                await assistant.boostVisibility();

                profileCache.clear();
                exploreCache.clear();
            } catch (e) {
                console.error('خطا در انتشار پست زمان‌بندی‌شده', row.id, e.message);
            }
        }
        if (due.rows.length) console.log(`📅 ${due.rows.length} پست زمان‌بندی‌شده منتشر شد`);
    } catch (e) {
        console.error('خطا در بررسی پست‌های زمان‌بندی‌شده:', e.message);
    }
}
setInterval(publishDueScheduledPosts, 60 * 1000);
publishDueScheduledPosts();

// ============================================
// ناشر دوره‌ای پست‌های زمان‌بندی‌شده - پشتیبان قابل‌اعتماد پشت مسیر سریع setTimeout
// مستقل از ری‌استارت worker/سرور اجرا می‌شه و امن در برابر چند worker همزمانه
// (هر آپدیت با شرط is_published=0 "claim" می‌شه، فقط برنده‌ی race کار جانبی رو انجام می‌ده)
// ============================================
async function publishDueScheduledPosts() {
    try {
        const now = new Date().toISOString();
        const due = await db.query(null, `
            SELECT p.id, p.channel_id, c.user_id 
            FROM posts p JOIN channels c ON p.channel_id = c.id
            WHERE p.is_published = 0 AND p.scheduled_time IS NOT NULL AND p.scheduled_time <= $1
            LIMIT 200
        `, [now]);

        for (const row of due.rows) {
            try {
                const claim = await db.query(row.id, `
                    UPDATE posts SET is_published = 1, published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1 AND is_published = 0
                `, [row.id]);
                if (!claim.rowCount) continue; // یه worker دیگه زودتر منتشرش کرد

                await db.query(row.user_id, `UPDATE channels SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.channel_id]);
                const assistant = new IntelligentAssistant(row.user_id, db);
                await assistant.updateUserActivity('post');
                await assistant.boostVisibility();
                profileCache.clear();
                exploreCache.clear();
            } catch (e) {
                console.error('خطا در انتشار پست زمان‌بندی‌شده', row.id, e.message);
            }
        }
        if (due.rows.length) console.log(`📅 ${due.rows.length} پست زمان‌بندی‌شده منتشر شد`);
    } catch (e) {
        console.error('خطا در بررسی پست‌های زمان‌بندی‌شده:', e.message);
    }
}
setInterval(publishDueScheduledPosts, 60 * 1000);

startServer();
publishDueScheduledPosts();

// ============================================
// محافظت در برابر کرش کل worker با یک خطای غیرمنتظره
// (خطا لاگ می‌شه و worker با کنترل خارج می‌شه؛ cluster.js خودش worker جدید بالا میاره)
// ============================================
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
    gracefulExit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled Rejection:', reason);
});

function gracefulExit(code) {
    server.close(() => process.exit(code));
    // اگه بعد از ۱۰ ثانیه بسته نشد، به‌زور خارج می‌شیم
    setTimeout(() => process.exit(code), 10000).unref();
}

process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM دریافت شد، خاموشی مرتب...');
    gracefulExit(0);
});

module.exports = { app, server, io };