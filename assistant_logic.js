// ============================================
// assistant_logic.js - دستیار هوشمند پیشرفته
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
    }

    // ============================================
    // بارگذاری داده‌های آموزشی با کش
    // ============================================
    async loadTrainingData() {
        const cacheKey = `training_${this.userId}`;
        const cached = this.cache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
            this.trainingData = cached.data;
            return this.trainingData;
        }

        const result = await this.db.query(this.userId, `
            SELECT * FROM assistant_training 
            WHERE user_id = $1
            ORDER BY created_at DESC
        `, [this.userId]);

        this.trainingData = result.rows;
        this.cache.set(cacheKey, { data: this.trainingData, timestamp: Date.now() });
        return this.trainingData;
    }

    // ============================================
    // پاسخ‌دهی خودکار
    // ============================================
    async autoReply(message) {
        if (!this.autoReplyEnabled) return null;
        await this.loadTrainingData();

        const cleanMsg = (message || '').trim().toLowerCase();
        if (!cleanMsg) return null;

        // بررسی کلمات کلیدی
        const keywords = this.trainingData.filter(t => t.type === 'keyword');
        for (const kw of keywords) {
            if (kw.keyword && cleanMsg.includes(kw.keyword.toLowerCase())) {
                return kw.response;
            }
        }

        // بررسی سوالات مشابه (تطابق ساده‌ی متنی)
        const qa = this.trainingData.filter(t => t.type === 'qa');
        for (const q of qa) {
            if (!q.question) continue;
            const questionLower = q.question.toLowerCase();
            if (cleanMsg.includes(questionLower) || questionLower.includes(cleanMsg)) {
                return q.answer;
            }
        }

        // بررسی تطابق کلمات کلیدی با درصد
        const words = cleanMsg.split(' ');
        for (const word of words) {
            if (word.length < 3) continue;
            for (const kw of keywords) {
                if (kw.keyword && kw.keyword.toLowerCase().includes(word)) {
                    return kw.response;
                }
            }
        }

        return null;
    }

    // ============================================
    // زمان‌بندی پست‌ها
    // ============================================
    async schedulePosts(postsData) {
        if (!Array.isArray(postsData) || postsData.length === 0) {
            throw new Error('لیست پست‌ها نامعتبر است');
        }

        const channel = await this.db.query(this.userId, `
            SELECT id FROM channels WHERE user_id = $1
        `, [this.userId]);

        if (channel.rows.length === 0) {
            throw new Error('کانالی برای این کاربر وجود ندارد');
        }

        const channelId = channel.rows[0].id;
        const scheduled = [];

        for (const post of postsData) {
            if (!post || !post.content || !post.content.trim()) continue;
            const id = crypto.randomUUID();
            const mediaType = post.mediaUrl ? 
                (post.mediaUrl.match(/\.(mp4|webm|ogg|mov|avi)$/i) ? 'video' : 
                 post.mediaUrl.match(/\.(mp3|wav|ogg|m4a)$/i) ? 'audio' : 'image') : 'none';

            await this.db.query(this.userId, `
                INSERT INTO posts (id, channel_id, content, media_url, media_type, scheduled_time, is_published, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, 0, CURRENT_TIMESTAMP)
            `, [id, channelId, post.content, post.mediaUrl || null, mediaType, post.scheduledTime]);

            scheduled.push({ id, mediaType, scheduledTime: post.scheduledTime });
        }

        // تنظیم زمان‌بندی برای ارسال خودکار
        this.setupScheduler(channelId, scheduled);

        return scheduled;
    }

    // ============================================
    // تنظیم زمان‌بندی ارسال خودکار
    // ============================================
    // نکته مهم: این فقط یه "مسیر سریع" برای پست‌های نزدیک (کمتر از ۲۴ ساعت) هست.
    // تایمر جاوااسکریپت (setTimeout) با ری‌استارت سرور/worker از بین می‌ره، و برای تاخیرهای
    // طولانی (بیشتر از ~۲۴.۸ روز) به‌خاطر سرریز عدد صحیح ۳۲بیتی فوراً اجرا می‌شه (باگ شناخته‌شده‌ی Node).
    // ناشرِ واقعی و قابل‌اعتماد، polling دوره‌ای توی server.js هست (publishDueScheduledPosts)
    // که مستقل از این تایمرها، هر پست عقب‌افتاده‌ای رو دیر یا زود منتشر می‌کنه.
    setupScheduler(channelId, posts) {
        const MAX_SAFE_DELAY = 24 * 60 * 60 * 1000; // ۲۴ ساعت
        for (const post of posts) {
            const scheduleTime = new Date(post.scheduledTime).getTime();
            const delay = scheduleTime - Date.now();

            if (delay > 0 && delay <= MAX_SAFE_DELAY) {
                const jobId = setTimeout(() => {
                    this.publishSinglePost(post.id).catch(err =>
                        console.error('خطا در انتشار پست زمان‌بندی‌شده (مسیر سریع):', err.message)
                    );
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
            const claim = await this.db.query(this.userId, `
                UPDATE posts SET is_published = 1, published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1 AND is_published = 0
            `, [postId]);

            // اگه ردیفی عوض نشد یعنی یه مسیر دیگه (poller یا worker دیگه) قبلاً منتشرش کرده - کار تکراری نکن
            if (!claim.rowCount) {
                this.scheduleJobs.delete(postId);
                return;
            }

            const post = await this.db.query(this.userId, `
                SELECT channel_id FROM posts WHERE id = $1
            `, [postId]);

            if (post.rows.length > 0) {
                await this.db.query(this.userId, `
                    UPDATE channels SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [post.rows[0].channel_id]);
                
                // به‌روزرسانی امتیاز
                await this.updateUserActivity('post');
                await this.boostVisibility();
            }

            this.scheduleJobs.delete(postId);
            this.cache.clear();
        } catch (error) {
            console.error('Error publishing scheduled post:', error);
        }
    }

    // ============================================
    // انتشار پست‌های زمان‌بندی شده (فراخوانی دوره‌ای)
    // ============================================
    async publishScheduledPosts() {
        const now = new Date().toISOString();
        const result = await this.db.query(this.userId, `
            SELECT * FROM posts 
            WHERE channel_id IN (
                SELECT id FROM channels WHERE user_id = $1
            )
            AND is_published = 0
            AND scheduled_time <= $2
        `, [this.userId, now]);

        const published = [];
        for (const post of result.rows) {
            await this.publishSinglePost(post.id);
            published.push(post.id);
        }

        return published;
    }

    // ============================================
    // به‌روزرسانی فعالیت کاربر
    // ============================================
    async updateUserActivity(type) {
        const scoreMap = { 
            post: 20, 
            like: 2, 
            comment: 5, 
            follow: 15, 
            train: 10,
            view: 1,
            share: 8
        };
        const points = scoreMap[type] || 0;

        try {
            await this.db.query(this.userId, `
                UPDATE users SET score = score + $1, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2
            `, [points, this.userId]);
            return points;
        } catch (error) {
            // این آپدیت جانبیه (امتیاز)؛ نباید کل درخواستِ اصلی (مثلاً ثبت پست) رو با شکست مواجه کنه
            console.error('updateUserActivity error:', error.message);
            return 0;
        }
    }

    // ============================================
    // دریافت آمار عملکرد دستیار
    // ============================================
    async getStats() {
        const cacheKey = `stats_${this.userId}`;
        const cached = this.cache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
            return cached.data;
        }

        const posts = await this.db.query(this.userId, `
            SELECT 
                COUNT(*) as total_posts,
                COALESCE(SUM(views), 0) as total_views,
                COALESCE(SUM(likes), 0) as total_likes,
                COALESCE(SUM(comments), 0) as total_comments
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 1
        `, [this.userId]);

        const trainings = await this.db.query(this.userId, `
            SELECT COUNT(*) as total_trainings
            FROM assistant_training
            WHERE user_id = $1
        `, [this.userId]);

        const followers = await this.db.query(this.userId, `
            SELECT followers_count FROM channels WHERE user_id = $1
        `, [this.userId]);

        const result = {
            totalPosts: parseInt(posts.rows[0]?.total_posts || 0),
            totalViews: parseInt(posts.rows[0]?.total_views || 0),
            totalLikes: parseInt(posts.rows[0]?.total_likes || 0),
            totalComments: parseInt(posts.rows[0]?.total_comments || 0),
            totalTrainings: parseInt(trainings.rows[0]?.total_trainings || 0),
            followers: parseInt(followers.rows[0]?.followers_count || 0),
            engagementRate: this.calculateEngagementRate(posts.rows[0])
        };

        this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
        return result;
    }

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
    // الگوریتم دیده‌شدن
    // ============================================
    async boostVisibility() {
        try {
            const stats = await this.getStats();
            const activityScore = 
                (stats.totalPosts * 2) + 
                (stats.totalLikes * 0.5) + 
                (stats.totalComments * 1) + 
                (stats.totalTrainings * 3) +
                (stats.totalViews * 0.1);

            let boostLevel = 'normal';
            if (activityScore > 100) boostLevel = 'high';
            if (activityScore > 300) boostLevel = 'viral';
            if (activityScore > 800) boostLevel = 'superstar';
            if (activityScore > 2000) boostLevel = 'legend';

            await this.db.query(this.userId, `
                UPDATE channels 
                SET boost_level = $1, 
                    activity_score = $2,
                    last_boost_calc = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $3
            `, [boostLevel, Math.round(activityScore), this.userId]);

            return { boostLevel, activityScore: Math.round(activityScore) };
        } catch (error) {
            // این هم یه محاسبه‌ی جانبیه؛ خطای موقت توش نباید عملیات اصلی رو خراب کنه
            console.error('boostVisibility error:', error.message);
            return { boostLevel: 'normal', activityScore: 0 };
        }
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
            scheduledJobs: this.scheduleJobs.size
        };
    }

    // ============================================
    // پاک کردن کش
    // ============================================
    clearCache() {
        this.cache.clear();
    }
}

module.exports = IntelligentAssistant;