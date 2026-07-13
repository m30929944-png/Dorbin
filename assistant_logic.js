// ============================================
// assistant_logic.js - دستیار هوشمند پیشرفته با هوش مصنوعی
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
        this.responseHistory = [];
        this.maxHistory = 50;
    }

    // ============================================
    // بارگذاری داده‌های آموزشی با کش هوشمند
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
            ORDER BY 
                CASE WHEN type = 'keyword' THEN 1 ELSE 2 END,
                usage_count DESC,
                created_at DESC
        `, [this.userId]);

        this.trainingData = result.rows;
        this.cache.set(cacheKey, { data: this.trainingData, timestamp: Date.now() });
        return this.trainingData;
    }

    // ============================================
    // پاسخ‌دهی خودکار با هوش مصنوعی
    // ============================================
    async autoReply(message) {
        if (!this.autoReplyEnabled) return null;
        await this.loadTrainingData();

        const cleanMsg = (message || '').trim();
        if (!cleanMsg) return null;

        // ============================================
        // 1. بررسی کلمات کلیدی (اولویت بالا)
        // ============================================
        const keywords = this.trainingData.filter(t => t.type === 'keyword');
        for (const kw of keywords) {
            if (kw.keyword && cleanMsg.includes(kw.keyword)) {
                // به‌روزرسانی تعداد استفاده
                await this.updateUsage(kw.id);
                return kw.response;
            }
        }

        // ============================================
        // 2. بررسی تطابق سوالات (تطابق دقیق)
        // ============================================
        const qa = this.trainingData.filter(t => t.type === 'qa');
        for (const q of qa) {
            if (!q.question) continue;
            if (cleanMsg.includes(q.question) || q.question.includes(cleanMsg)) {
                await this.updateUsage(q.id);
                return q.answer;
            }
        }

        // ============================================
        // 3. بررسی تطابق کلمات کلیدی با درصد (Fuzzy)
        // ============================================
        const words = cleanMsg.split(' ');
        for (const word of words) {
            if (word.length < 3) continue;
            for (const kw of keywords) {
                if (kw.keyword && kw.keyword.includes(word)) {
                    await this.updateUsage(kw.id);
                    return kw.response;
                }
            }
        }

        // ============================================
        // 4. بررسی تطابق سوالات با کلمات کلیدی
        // ============================================
        for (const q of qa) {
            if (!q.question) continue;
            const qWords = q.question.split(' ');
            let matchCount = 0;
            for (const word of words) {
                if (qWords.some(qw => qw.includes(word) || word.includes(qw))) {
                    matchCount++;
                }
            }
            if (matchCount >= Math.min(words.length, qWords.length) * 0.5) {
                await this.updateUsage(q.id);
                return q.answer;
            }
        }

        return null;
    }

    // ============================================
    // به‌روزرسانی تعداد استفاده از آموزش
    // ============================================
    async updateUsage(trainingId) {
        try {
            await this.db.query(this.userId, `
                UPDATE assistant_training 
                SET usage_count = usage_count + 1, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [trainingId]);
        } catch (e) {
            // خطا را نادیده بگیر
        }
    }

    // ============================================
    // زمان‌بندی پست‌ها با پشتیبانی از ویدیو
    // ============================================
    async schedulePosts(postsData) {
        const channel = await this.db.query(this.userId, `
            SELECT id FROM channels WHERE user_id = $1
        `, [this.userId]);

        if (channel.rows.length === 0) {
            throw new Error('کانالی برای این کاربر وجود ندارد');
        }

        const channelId = channel.rows[0].id;
        const scheduled = [];

        for (const post of postsData) {
            const id = crypto.randomUUID();
            const mediaType = post.mediaUrl ? 
                (post.mediaUrl.match(/\.(mp4|webm|ogg|mov|avi|mkv)$/i) ? 'video' : 
                 post.mediaUrl.match(/\.(mp3|wav|ogg|m4a|flac)$/i) ? 'audio' : 'image') : 'none';

            await this.db.query(this.userId, `
                INSERT INTO posts (id, channel_id, content, media_url, media_type, scheduled_time, is_published, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, 0, CURRENT_TIMESTAMP)
            `, [id, channelId, post.content, post.mediaUrl || null, mediaType, post.scheduledTime]);

            scheduled.push({ id, mediaType, scheduledTime: post.scheduledTime });
        }

        // تنظیم زمان‌بندی برای ارسال خودکار
        this.setupScheduler(scheduled);

        return scheduled;
    }

    // ============================================
    // تنظیم زمان‌بندی ارسال خودکار با مدیریت خطا
    // ============================================
    setupScheduler(posts) {
        for (const post of posts) {
            const scheduleTime = new Date(post.scheduledTime).getTime();
            const now = Date.now();
            
            if (scheduleTime > now) {
                const delay = scheduleTime - now;
                // اگر delay بیشتر از 24 ساعت باشد، از setInterval استفاده کن
                if (delay > 86400000) {
                    // برای زمان‌های طولانی، از بررسی دوره‌ای استفاده می‌کنیم
                    continue;
                }
                const jobId = setTimeout(async () => {
                    await this.publishSinglePost(post.id);
                }, delay);
                this.scheduleJobs.set(post.id, jobId);
            }
        }

        // بررسی دوره‌ای برای پست‌های زمان‌بندی شده (هر 5 دقیقه)
        if (this.scheduleInterval) {
            clearInterval(this.scheduleInterval);
        }
        this.scheduleInterval = setInterval(async () => {
            await this.publishScheduledPosts();
        }, 5 * 60 * 1000);
    }

    // ============================================
    // انتشار یک پست زمان‌بندی شده
    // ============================================
    async publishSinglePost(postId) {
        try {
            const post = await this.db.query(this.userId, `
                SELECT * FROM posts WHERE id = $1 AND is_published = 0
            `, [postId]);

            if (post.rows.length === 0) return;

            await this.db.query(this.userId, `
                UPDATE posts SET is_published = 1, published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [postId]);

            await this.db.query(this.userId, `
                UPDATE channels SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [post.rows[0].channel_id]);

            await this.updateUserActivity('post');
            await this.boostVisibility();

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
            SELECT id FROM posts 
            WHERE channel_id IN (
                SELECT id FROM channels WHERE user_id = $1
            )
            AND is_published = 0
            AND scheduled_time <= $2
        `, [this.userId, now]);

        for (const post of result.rows) {
            await this.publishSinglePost(post.id);
        }
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
            share: 8,
            schedule: 15
        };
        const points = scoreMap[type] || 0;
        
        await this.db.query(this.userId, `
            UPDATE users SET score = score + $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [points, this.userId]);

        // ثبت فعالیت
        const activityId = crypto.randomUUID();
        await this.db.query(this.userId, `
            INSERT INTO user_activities (id, user_id, type, created_at)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        `, [activityId, this.userId, type]);

        return points;
    }

    // ============================================
    // دریافت آمار کامل دستیار
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
                COALESCE(SUM(comments), 0) as total_comments,
                COALESCE(SUM(shares), 0) as total_shares
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = 1
        `, [this.userId]);

        const trainings = await this.db.query(this.userId, `
            SELECT 
                COUNT(*) as total_trainings,
                SUM(CASE WHEN type = 'qa' THEN 1 ELSE 0 END) as qa_count,
                SUM(CASE WHEN type = 'keyword' THEN 1 ELSE 0 END) as keyword_count
            FROM assistant_training
            WHERE user_id = $1
        `, [this.userId]);

        const followers = await this.db.query(this.userId, `
            SELECT followers_count, boost_level, activity_score 
            FROM channels WHERE user_id = $1
        `, [this.userId]);

        const activities = await this.db.query(this.userId, `
            SELECT 
                COUNT(*) as total_activities,
                SUM(CASE WHEN type = 'post' THEN 1 ELSE 0 END) as posts_count,
                SUM(CASE WHEN type = 'like' THEN 1 ELSE 0 END) as likes_count,
                SUM(CASE WHEN type = 'comment' THEN 1 ELSE 0 END) as comments_count
            FROM user_activities
            WHERE user_id = $1
            AND created_at > datetime('now', '-30 days')
        `, [this.userId]);

        const result = {
            totalPosts: parseInt(posts.rows[0]?.total_posts || 0),
            totalViews: parseInt(posts.rows[0]?.total_views || 0),
            totalLikes: parseInt(posts.rows[0]?.total_likes || 0),
            totalComments: parseInt(posts.rows[0]?.total_comments || 0),
            totalShares: parseInt(posts.rows[0]?.total_shares || 0),
            totalTrainings: parseInt(trainings.rows[0]?.total_trainings || 0),
            qaCount: parseInt(trainings.rows[0]?.qa_count || 0),
            keywordCount: parseInt(trainings.rows[0]?.keyword_count || 0),
            followers: parseInt(followers.rows[0]?.followers_count || 0),
            boostLevel: followers.rows[0]?.boost_level || 'normal',
            activityScore: parseInt(followers.rows[0]?.activity_score || 0),
            totalActivities: parseInt(activities.rows[0]?.total_activities || 0),
            postsLast30Days: parseInt(activities.rows[0]?.posts_count || 0),
            likesLast30Days: parseInt(activities.rows[0]?.likes_count || 0),
            commentsLast30Days: parseInt(activities.rows[0]?.comments_count || 0),
            engagementRate: this.calculateEngagementRate(posts.rows[0]),
            score: this.calculateAssistantScore(posts.rows[0], trainings.rows[0])
        };

        this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
        return result;
    }

    calculateEngagementRate(postData) {
        if (!postData || !postData.total_posts || parseInt(postData.total_posts) === 0) return '0%';
        const views = parseInt(postData.total_views || 0);
        const likes = parseInt(postData.total_likes || 0);
        const comments = parseInt(postData.total_comments || 0);
        const shares = parseInt(postData.total_shares || 0);
        if (views === 0) return '0%';
        const engagement = ((likes + comments * 2 + shares * 3) / views) * 100;
        return engagement.toFixed(2) + '%';
    }

    calculateAssistantScore(postData, trainingData) {
        let score = 0;
        if (postData) {
            score += parseInt(postData.total_posts || 0) * 10;
            score += parseInt(postData.total_likes || 0) * 2;
            score += parseInt(postData.total_comments || 0) * 3;
            score += parseInt(postData.total_shares || 0) * 5;
        }
        if (trainingData) {
            score += parseInt(trainingData.total_trainings || 0) * 15;
        }
        return score;
    }

    // ============================================
    // الگوریتم دیده‌شدن پیشرفته
    // ============================================
    async boostVisibility() {
        const stats = await this.getStats();
        const activityScore = 
            (stats.totalPosts * 2) + 
            (stats.totalLikes * 0.5) + 
            (stats.totalComments * 1) + 
            (stats.totalTrainings * 3) +
            (stats.totalViews * 0.1) +
            (stats.totalShares * 2) +
            (stats.followers * 0.5);

        let boostLevel = 'normal';
        let boostMultiplier = 1;
        
        if (activityScore > 100) { boostLevel = 'high'; boostMultiplier = 1.5; }
        if (activityScore > 300) { boostLevel = 'viral'; boostMultiplier = 2; }
        if (activityScore > 800) { boostLevel = 'superstar'; boostMultiplier = 3; }
        if (activityScore > 2000) { boostLevel = 'legend'; boostMultiplier = 5; }

        await this.db.query(this.userId, `
            UPDATE channels 
            SET boost_level = $1, 
                activity_score = $2,
                last_boost_calc = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $3
        `, [boostLevel, Math.round(activityScore), this.userId]);

        return { boostLevel, activityScore: Math.round(activityScore), boostMultiplier };
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
            responseHistory: this.responseHistory.length,
            cacheSize: this.cache.size
        };
    }

    // ============================================
    // مدیریت پاسخ‌ها (یادگیری از تعاملات)
    // ============================================
    async learnFromInteraction(message, response, userFeedback) {
        // ذخیره تاریخچه تعاملات
        this.responseHistory.push({
            message,
            response,
            feedback: userFeedback,
            timestamp: Date.now()
        });

        if (this.responseHistory.length > this.maxHistory) {
            this.responseHistory.shift();
        }

        // اگر بازخورد مثبت بود، امتیاز بده
        if (userFeedback === 'positive') {
            // پیدا کردن آموزش مرتبط
            const related = this.trainingData.find(t => 
                (t.type === 'keyword' && t.keyword && message.includes(t.keyword)) ||
                (t.type === 'qa' && t.question && message.includes(t.question))
            );
            if (related) {
                await this.updateUsage(related.id);
            }
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
        if (this.scheduleInterval) {
            clearInterval(this.scheduleInterval);
            this.scheduleInterval = null;
        }
    }

    // ============================================
    // غیرفعال/فعال کردن دستیار
    // ============================================
    setAutoReply(enabled) {
        this.autoReplyEnabled = enabled;
        return this.autoReplyEnabled;
    }

    // ============================================
    // پاک کردن کش
    // ============================================
    clearCache() {
        this.cache.clear();
    }

    // ============================================
    // دریافت آموزش‌های پرکاربرد
    // ============================================
    async getPopularTrainings(limit = 10) {
        return this.db.query(this.userId, `
            SELECT * FROM assistant_training 
            WHERE user_id = $1
            ORDER BY usage_count DESC, created_at DESC
            LIMIT $2
        `, [this.userId, limit]);
    }

    // ============================================
    // حذف آموزش
    // ============================================
    async deleteTraining(trainingId) {
        await this.db.query(this.userId, `
            DELETE FROM assistant_training 
            WHERE id = $1 AND user_id = $2
        `, [trainingId, this.userId]);
        this.clearCache();
        return true;
    }

    // ============================================
    // دریافت آمار استفاده از دستیار
    // ============================================
    async getUsageStats() {
        const result = await this.db.query(this.userId, `
            SELECT 
                COUNT(*) as total_uses,
                AVG(usage_count) as avg_usage,
                MAX(usage_count) as max_usage,
                SUM(CASE WHEN type = 'qa' THEN usage_count ELSE 0 END) as qa_uses,
                SUM(CASE WHEN type = 'keyword' THEN usage_count ELSE 0 END) as keyword_uses
            FROM assistant_training
            WHERE user_id = $1
        `, [this.userId]);

        return {
            totalUses: result.rows[0]?.total_uses || 0,
            avgUsage: Math.round(result.rows[0]?.avg_usage || 0),
            maxUsage: result.rows[0]?.max_usage || 0,
            qaUses: result.rows[0]?.qa_uses || 0,
            keywordUses: result.rows[0]?.keyword_uses || 0
        };
    }
}

module.exports = IntelligentAssistant;