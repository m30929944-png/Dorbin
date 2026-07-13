// ============================================
// assistant_logic.js - دستیار هوشمند پیشرفته با کیفیت بالا
// ============================================
const crypto = require('crypto');

class IntelligentAssistant {
    constructor(userId, db) {
        this.userId = userId;
        this.db = db;
        this.trainingData = null;
        this.autoReplyEnabled = true;
        this.scheduleJobs = new Map();
        this.cache = new Map();
        this.cacheTTL = 30000;
        this.maxCacheSize = 100;
        this.boostLevels = {
            normal: { minScore: 0, label: 'عادی', icon: '📊', color: '#6b74a8' },
            high: { minScore: 100, label: '🔥 داغ', icon: '🔥', color: '#60a5fa' },
            viral: { minScore: 300, label: '🚀 وایرال', icon: '🚀', color: '#f45b69' },
            superstar: { minScore: 800, label: '⭐ ستاره', icon: '⭐', color: '#f6b93b' },
            legend: { minScore: 2000, label: '👑 افسانه', icon: '👑', color: '#7c6cf6' }
        };
    }

    // ============================================
    // مدیریت کش با حذف خودکار
    // ============================================
    setCache(key, data) {
        if (this.cache.size >= this.maxCacheSize) {
            const entries = Array.from(this.cache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toDelete = Math.floor(this.maxCacheSize * 0.2);
            for (let i = 0; i < toDelete && i < entries.length; i++) {
                this.cache.delete(entries[i][0]);
            }
        }
        this.cache.set(key, { data, timestamp: Date.now() });
    }

    getCache(key) {
        const cached = this.cache.get(key);
        if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
            return cached.data;
        }
        return null;
    }

    clearCache() {
        this.cache.clear();
    }

    // ============================================
    // بارگذاری داده‌های آموزشی با کش
    // ============================================
    async loadTrainingData() {
        const cacheKey = `training_${this.userId}`;
        const cached = this.getCache(cacheKey);
        if (cached) {
            this.trainingData = cached;
            return this.trainingData;
        }

        const result = await this.db.query(`
            SELECT * FROM assistant_training 
            WHERE user_id = $1
            ORDER BY created_at DESC
        `, [this.userId]);

        this.trainingData = result || [];
        this.setCache(cacheKey, this.trainingData);
        return this.trainingData;
    }

    // ============================================
    // پاسخ‌دهی خودکار با کیفیت بالا
    // ============================================
    async autoReply(message) {
        if (!this.autoReplyEnabled) return null;
        await this.loadTrainingData();

        const cleanMsg = (message || '').trim().toLowerCase();
        if (!cleanMsg) return null;

        // بررسی کلمات کلیدی با تطابق پیشرفته
        const keywords = this.trainingData.filter(t => t.type === 'keyword');
        let bestMatch = null;
        let bestScore = 0;

        for (const kw of keywords) {
            if (!kw.keyword) continue;
            const keywordLower = kw.keyword.toLowerCase();
            
            // تطابق کامل
            if (cleanMsg.includes(keywordLower)) {
                return kw.response;
            }
            
            // تطابق با امتیاز (تقسیم کلمات)
            const kwWords = keywordLower.split(' ');
            const msgWords = cleanMsg.split(' ');
            let matchCount = 0;
            for (const w of kwWords) {
                if (w.length < 2) continue;
                for (const mw of msgWords) {
                    if (mw.includes(w) || w.includes(mw)) {
                        matchCount++;
                        break;
                    }
                }
            }
            const score = (matchCount / kwWords.length) * 100;
            if (score > bestScore && score > 50) {
                bestScore = score;
                bestMatch = kw.response;
            }
        }

        if (bestMatch) return bestMatch;

        // بررسی سوالات مشابه با تطابق پیشرفته
        const qa = this.trainingData.filter(t => t.type === 'qa');
        for (const q of qa) {
            if (!q.question) continue;
            const questionLower = q.question.toLowerCase();
            // تطابق کامل
            if (cleanMsg.includes(questionLower) || questionLower.includes(cleanMsg)) {
                return q.answer;
            }
            // تطابق کلمات کلیدی سوال
            const qWords = questionLower.split(' ');
            let matchCount = 0;
            for (const w of qWords) {
                if (w.length < 2) continue;
                if (cleanMsg.includes(w)) {
                    matchCount++;
                }
            }
            if ((matchCount / qWords.length) > 0.6) {
                return q.answer;
            }
        }

        return null;
    }

    // ============================================
    // زمان‌بندی پست‌ها با کیفیت بالا
    // ============================================
    async schedulePosts(postsData) {
        const channel = await this.db.query(`
            SELECT id FROM channels WHERE user_id = $1
        `, [this.userId]);

        if (!channel || channel.length === 0) {
            throw new Error('کانالی برای این کاربر وجود ندارد');
        }

        const channelId = channel[0].id;
        const scheduled = [];

        for (const post of postsData) {
            const id = crypto.randomUUID();
            let mediaType = 'none';
            
            if (post.mediaUrl) {
                // تشخیص نوع فایل با کیفیت بالا
                const url = post.mediaUrl.toLowerCase();
                if (url.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|mpeg)$/i)) {
                    mediaType = 'video';
                } else if (url.match(/\.(mp3|wav|ogg|m4a|flac|aac|wma)$/i)) {
                    mediaType = 'audio';
                } else if (url.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg|tiff|ico)$/i)) {
                    mediaType = 'image';
                } else if (url.startsWith('data:image/')) {
                    mediaType = 'image';
                } else if (url.startsWith('data:video/')) {
                    mediaType = 'video';
                }
            }

            await this.db.query(`
                INSERT INTO posts (id, channel_id, content, media_url, media_type, scheduled_time, is_published, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, 0, CURRENT_TIMESTAMP)
            `, [id, channelId, post.content, post.mediaUrl || null, mediaType, post.scheduledTime]);

            scheduled.push({ id, mediaType, scheduledTime: post.scheduledTime });
        }

        // تنظیم زمان‌بندی برای ارسال خودکار
        this.setupScheduler(channelId, scheduled);

        // پاک کردن کش
        this.clearCache();

        return scheduled;
    }

    // ============================================
    // تنظیم زمان‌بندی ارسال خودکار
    // ============================================
    setupScheduler(channelId, posts) {
        for (const post of posts) {
            const scheduleTime = new Date(post.scheduledTime).getTime();
            const now = Date.now();
            
            if (scheduleTime > now) {
                const delay = scheduleTime - now;
                const jobId = setTimeout(async () => {
                    await this.publishSinglePost(post.id);
                }, delay);
                this.scheduleJobs.set(post.id, jobId);
            }
        }
    }

    // ============================================
    // انتشار یک پست زمان‌بندی شده
    // ============================================
    async publishSinglePost(postId) {
        try {
            await this.db.query(`
                UPDATE posts SET is_published = 1, published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [postId]);

            const post = await this.db.query(`
                SELECT channel_id FROM posts WHERE id = $1
            `, [postId]);

            if (post && post.length > 0) {
                await this.db.query(`
                    UPDATE channels SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [post[0].channel_id]);
                
                // به‌روزرسانی امتیاز
                await this.updateUserActivity('post');
                await this.boostVisibility();
            }

            this.scheduleJobs.delete(postId);
            this.clearCache();
        } catch (error) {
            console.error('Error publishing scheduled post:', error);
        }
    }

    // ============================================
    // انتشار پست‌های زمان‌بندی شده (فراخوانی دوره‌ای)
    // ============================================
    async publishScheduledPosts() {
        const now = new Date().toISOString();
        const result = await this.db.query(`
            SELECT * FROM posts 
            WHERE channel_id IN (
                SELECT id FROM channels WHERE user_id = $1
            )
            AND is_published = 0
            AND scheduled_time <= $2
        `, [this.userId, now]);

        const published = [];
        for (const post of (result || [])) {
            await this.publishSinglePost(post.id);
            published.push(post.id);
        }

        return published;
    }

    // ============================================
    // به‌روزرسانی فعالیت کاربر با امتیازدهی پیشرفته
    // ============================================
    async updateUserActivity(type) {
        const scoreMap = { 
            post: 20, 
            like: 2, 
            comment: 5, 
            follow: 15, 
            train: 10,
            view: 1,
            share: 8,
            boost: 30,
            viral: 50
        };
        const points = scoreMap[type] || 0;
        
        await this.db.query(`
            UPDATE users SET score = score + $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [points, this.userId]);
        
        return points;
    }

    // ============================================
    // دریافت آمار عملکرد دستیار با جزئیات کامل
    // ============================================
    async getStats() {
        const cacheKey = `stats_${this.userId}`;
        const cached = this.getCache(cacheKey);
        if (cached) return cached;

        const posts = await this.db.query(`
            SELECT 
                COUNT(*) as total_posts,
                COALESCE(SUM(views), 0) as total_views,
                COALESCE(SUM(likes), 0) as total_likes,
                COALESCE(SUM(comments), 0) as total_comments
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 1
        `, [this.userId]);

        const trainings = await this.db.query(`
            SELECT COUNT(*) as total_trainings
            FROM assistant_training
            WHERE user_id = $1
        `, [this.userId]);

        const followers = await this.db.query(`
            SELECT followers_count FROM channels WHERE user_id = $1
        `, [this.userId]);

        const boost = await this.db.query(`
            SELECT boost_level, activity_score FROM channels WHERE user_id = $1
        `, [this.userId]);

        const result = {
            totalPosts: parseInt(posts[0]?.total_posts || 0),
            totalViews: parseInt(posts[0]?.total_views || 0),
            totalLikes: parseInt(posts[0]?.total_likes || 0),
            totalComments: parseInt(posts[0]?.total_comments || 0),
            totalTrainings: parseInt(trainings[0]?.total_trainings || 0),
            followers: parseInt(followers[0]?.followers_count || 0),
            boostLevel: boost[0]?.boost_level || 'normal',
            activityScore: parseInt(boost[0]?.activity_score || 0),
            engagementRate: this.calculateEngagementRate(posts[0])
        };

        this.setCache(cacheKey, result);
        return result;
    }

    // ============================================
    // محاسبه نرخ تعامل با دقت بالا
    // ============================================
    calculateEngagementRate(postData) {
        if (!postData || !postData.total_posts || parseInt(postData.total_posts) === 0) return '0%';
        const views = parseInt(postData.total_views || 0);
        const likes = parseInt(postData.total_likes || 0);
        const comments = parseInt(postData.total_comments || 0);
        if (views === 0) return '0%';
        const engagement = ((likes + comments * 2) / views) * 100;
        return engagement.toFixed(2) + '%';
    }

    // ============================================
    // الگوریتم دیده‌شدن پیشرفته
    // ============================================
    async boostVisibility() {
        const stats = await this.getStats();
        
        // محاسبه امتیاز فعالیت با وزن‌دهی هوشمند
        const activityScore = 
            (stats.totalPosts * 2.5) + 
            (stats.totalLikes * 0.5) + 
            (stats.totalComments * 1.2) + 
            (stats.totalTrainings * 3) +
            (stats.totalViews * 0.1) +
            (stats.followers * 0.3);

        let boostLevel = 'normal';
        let boostLabel = '📊 عادی';
        let boostColor = '#6b74a8';

        if (activityScore > 100) { boostLevel = 'high'; boostLabel = '🔥 داغ'; boostColor = '#60a5fa'; }
        if (activityScore > 300) { boostLevel = 'viral'; boostLabel = '🚀 وایرال'; boostColor = '#f45b69'; }
        if (activityScore > 800) { boostLevel = 'superstar'; boostLabel = '⭐ ستاره'; boostColor = '#f6b93b'; }
        if (activityScore > 2000) { boostLevel = 'legend'; boostLabel = '👑 افسانه'; boostColor = '#7c6cf6'; }

        await this.db.query(`
            UPDATE channels 
            SET boost_level = $1, 
                activity_score = $2,
                last_boost_calc = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $3
        `, [boostLevel, Math.round(activityScore), this.userId]);

        return { 
            boostLevel, 
            boostLabel,
            boostColor,
            activityScore: Math.round(activityScore),
            engagementRate: stats.engagementRate
        };
    }

    // ============================================
    // دریافت وضعیت کامل دستیار
    // ============================================
    async getFullStatus() {
        const stats = await this.getStats();
        const boost = await this.boostVisibility();
        
        return {
            userId: this.userId,
            autoReplyEnabled: this.autoReplyEnabled,
            trainingCount: stats.totalTrainings,
            scheduledJobs: this.scheduleJobs.size,
            stats: stats,
            boost: boost,
            status: 'active',
            lastUpdate: new Date().toISOString()
        };
    }

    // ============================================
    // پاک کردن زمان‌بندی‌ها
    // ============================================
    clearSchedules() {
        for (const [id, job] of this.scheduleJobs) {
            clearTimeout(job);
        }
        this.scheduleJobs.clear();
    }

    // ============================================
    // غیرفعال کردن دستیار
    // ============================================
    setAutoReply(enabled) {
        this.autoReplyEnabled = enabled;
        return this.autoReplyEnabled;
    }

    // ============================================
    // دریافت وضعیت دستیار
    // ============================================
    getStatus() {
        return {
            userId: this.userId,
            autoReplyEnabled: this.autoReplyEnabled,
            trainingCount: this.trainingData?.length || 0,
            scheduledJobs: this.scheduleJobs.size,
            cacheSize: this.cache.size
        };
    }

    // ============================================
    // پاسخ‌دهی با هوش مصنوعی ساده (Fallback)
    // ============================================
    async smartReply(message) {
        const autoReply = await this.autoReply(message);
        if (autoReply) return autoReply;

        // پاسخ‌های پیش‌فرض هوشمند
        const defaultReplies = [
            'ممنون از پیامت! 🤗',
            'چیز جالبی گفتی! 😊',
            'میشه بیشتر توضیح بدی؟ 🤔',
            'متوجه شدم! 👍',
            'عالی! ادامه بده! 💪',
            'این خیلی جالب بود! ✨',
            'دستت درد نکنه! 🌟',
            'چه ایده خوبی! 🎯'
        ];
        
        const randomIndex = Math.floor(Math.random() * defaultReplies.length);
        return defaultReplies[randomIndex];
    }

    // ============================================
    // تجزیه و تحلیل پیام
    // ============================================
    analyzeMessage(message) {
        const msg = (message || '').trim().toLowerCase();
        const words = msg.split(' ');
        const analysis = {
            length: msg.length,
            wordCount: words.length,
            hasQuestion: msg.includes('؟') || msg.includes('?'),
            sentiment: 'neutral',
            topics: []
        };

        // تشخیص احساسات ساده
        const positiveWords = ['❤️', '♥️', '😍', '🤗', '👍', 'عالی', 'خوب', 'ممنون', 'دوست', 'زیبا', 'خوشحال', 'باحال'];
        const negativeWords = ['😡', '🤬', '💢', 'بد', 'ناراحت', 'عصبانی', 'متاسف', 'افتضاح', 'بی‌مزه'];
        const questionWords = ['چه', 'چرا', 'چطور', 'کجا', 'کی', 'آیا', 'میشه', 'می‌شه', 'چند', 'کدوم', 'چه‌طور'];

        for (const word of words) {
            if (positiveWords.some(w => word.includes(w))) analysis.sentiment = 'positive';
            if (negativeWords.some(w => word.includes(w))) analysis.sentiment = 'negative';
            if (questionWords.some(w => word.includes(w))) analysis.hasQuestion = true;
        }

        // تشخیص موضوعات
        const topicKeywords = {
            'پست': ['پست', 'نوشت', 'مطلب', 'content', 'article'],
            'ویدیو': ['ویدیو', 'فیلم', 'video', 'movie', 'clip'],
            'عکس': ['عکس', 'تصویر', 'photo', 'image', 'picture'],
            'صدا': ['صدا', 'آهنگ', 'موزیک', 'audio', 'music', 'sound'],
            'کامنت': ['کامنت', 'نظر', 'comment', 'opinion'],
            'فالو': ['فالو', 'دنبال', 'follow', 'subscribe'],
            'دستیار': ['دستیار', 'هوش', 'ربات', 'assistant', 'bot', 'ai']
        };

        for (const [topic, keywords] of Object.entries(topicKeywords)) {
            for (const kw of keywords) {
                if (msg.includes(kw)) {
                    analysis.topics.push(topic);
                    break;
                }
            }
        }

        if (analysis.topics.length === 0 && words.length > 3) {
            analysis.topics.push('عمومی');
        }

        return analysis;
    }
}

module.exports = IntelligentAssistant;