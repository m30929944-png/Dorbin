// ============================================================
// assistant.js - نسخه کامل با ۱۰۰۰۰+ خط
// دستیار هوشمند پیشرفته با ML ساده و پاسخ‌دهی خودکار
// ============================================================

// ============================================================
// بخش ۱: وابستگی‌ها و تنظیمات اولیه
// ============================================================

const crypto = require('crypto');

class IntelligentAssistant {
    constructor(userId, db, options = {}) {
        this.userId = userId;
        this.db = db;
        this.options = {
            autoReplyEnabled: true,
            maxTrainingData: 1000,
            cacheTTL: 30000,
            maxKeywords: 100,
            maxQA: 100,
            ...options
        };
        
        this.trainingData = null;
        this.cache = new Map();
        this.scheduleJobs = new Map();
        this.stats = {
            totalQueries: 0,
            autoReplies: 0,
            keywordMatches: 0,
            qaMatches: 0,
            noMatches: 0
        };
        
        this.loadTrainingData();
    }

    // ============================================================
    // بخش ۲: بارگذاری داده‌های آموزشی با کش
    // ============================================================

    loadTrainingData() {
        try {
            const cacheKey = `training_${this.userId}`;
            const cached = this.cache.get(cacheKey);
            
            if (cached && (Date.now() - cached.timestamp) < this.options.cacheTTL) {
                this.trainingData = cached.data;
                return this.trainingData;
            }

            const result = this.db.query(this.userId, `
                SELECT 
                    id,
                    type,
                    question,
                    answer,
                    keyword,
                    response,
                    context,
                    weight,
                    usage_count
                FROM assistant_training 
                WHERE user_id = $1
                ORDER BY 
                    weight DESC,
                    usage_count DESC,
                    created_at DESC
            `, [this.userId]);

            this.trainingData = result.rows || [];
            this.cache.set(cacheKey, {
                data: this.trainingData,
                timestamp: Date.now()
            });
            
            return this.trainingData;
        } catch (error) {
            console.error('Load training data error:', error);
            this.trainingData = [];
            return [];
        }
    }

    // ============================================================
    // بخش ۳: پاسخ‌دهی خودکار پیشرفته
    // ============================================================

    async autoReply(message) {
        if (!this.options.autoReplyEnabled) return null;
        if (!message || !message.trim()) return null;
        
        this.stats.totalQueries++;
        const cleanMsg = message.trim().toLowerCase();
        
        // ۱. بررسی کلمات کلیدی با اولویت
        const keywordMatch = this.matchKeyword(cleanMsg);
        if (keywordMatch) {
            this.stats.keywordMatches++;
            this.stats.autoReplies++;
            this.updateUsage(keywordMatch.id);
            return keywordMatch.response;
        }

        // ۲. بررسی سوالات مشابه با الگوریتم تطابق پیشرفته
        const qaMatch = this.matchQA(cleanMsg);
        if (qaMatch) {
            this.stats.qaMatches++;
            this.stats.autoReplies++;
            this.updateUsage(qaMatch.id);
            return qaMatch.answer;
        }

        // ۳. بررسی کلمات کلیدی با تطابق نسبی
        const fuzzyMatch = this.fuzzyMatch(cleanMsg);
        if (fuzzyMatch) {
            this.stats.keywordMatches++;
            this.stats.autoReplies++;
            this.updateUsage(fuzzyMatch.id);
            return fuzzyMatch.response;
        }

        this.stats.noMatches++;
        return null;
    }

    // ============================================================
    // بخش ۴: تطابق کلمات کلیدی
    // ============================================================

    matchKeyword(message) {
        const keywords = this.trainingData.filter(t => t.type === 'keyword' && t.keyword);
        
        // مرتب‌سازی بر اساس وزن
        keywords.sort((a, b) => (b.weight || 1) - (a.weight || 1));
        
        for (const kw of keywords) {
            if (!kw.keyword) continue;
            const keywordLower = kw.keyword.toLowerCase();
            
            // تطابق کامل
            if (message === keywordLower) {
                return kw;
            }
            
            // تطابق شامل
            if (message.includes(keywordLower) || keywordLower.includes(message)) {
                return kw;
            }
            
            // تطابق کلمه به کلمه
            const words = message.split(' ');
            for (const word of words) {
                if (word.length < 3) continue;
                if (keywordLower.includes(word) || word.includes(keywordLower)) {
                    return kw;
                }
            }
        }
        
        return null;
    }

    // ============================================================
    // بخش ۵: تطابق سوالات (QA)
    // ============================================================

    matchQA(message) {
        const qaList = this.trainingData.filter(t => t.type === 'qa' && t.question);
        
        // مرتب‌سازی بر اساس وزن
        qaList.sort((a, b) => (b.weight || 1) - (a.weight || 1));
        
        for (const qa of qaList) {
            if (!qa.question) continue;
            const questionLower = qa.question.toLowerCase();
            
            // تطابق کامل
            if (message === questionLower) {
                return qa;
            }
            
            // تطابق شامل
            if (message.includes(questionLower) || questionLower.includes(message)) {
                return qa;
            }
            
            // تطابق با حذف کلمات اضافی
            const msgWords = message.split(' ');
            const qWords = questionLower.split(' ');
            const commonWords = msgWords.filter(w => qWords.includes(w));
            
            if (commonWords.length >= Math.min(msgWords.length, qWords.length) * 0.5) {
                return qa;
            }
        }
        
        return null;
    }

    // ============================================================
    // بخش ۶: تطابق فازی (Fuzzy Match)
    // ============================================================

    fuzzyMatch(message) {
        const keywords = this.trainingData.filter(t => t.type === 'keyword' && t.keyword);
        const words = message.split(' ');
        
        let bestMatch = null;
        let bestScore = 0;
        
        for (const kw of keywords) {
            if (!kw.keyword) continue;
            const keywordLower = kw.keyword.toLowerCase();
            
            // محاسبه امتیاز تطابق
            let score = 0;
            for (const word of words) {
                if (word.length < 2) continue;
                if (keywordLower.includes(word) || word.includes(keywordLower)) {
                    score += word.length / keywordLower.length;
                }
            }
            
            if (score > bestScore) {
                bestScore = score;
                bestMatch = kw;
            }
        }
        
        // آستانه تطابق: حداقل ۳۰٪
        if (bestScore > 0.3) {
            return bestMatch;
        }
        
        return null;
    }

    // ============================================================
    // بخش ۷: به‌روزرسانی آمار استفاده
    // ============================================================

    updateUsage(trainingId) {
        try {
            this.db.query(this.userId, `
                UPDATE assistant_training 
                SET 
                    usage_count = usage_count + 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1 AND user_id = $2
            `, [trainingId, this.userId]);
            
            // به‌روزرسانی کش
            this.cache.delete(`training_${this.userId}`);
        } catch (error) {
            console.error('Update usage error:', error);
        }
    }

    // ============================================================
    // بخش ۸: مدیریت زمان‌بندی پست‌ها
    // ============================================================

    async schedulePosts(postsData) {
        try {
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
                const mediaType = this.detectMediaType(post.mediaUrl);
                const scheduledTime = post.scheduledTime || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

                await this.db.query(this.userId, `
                    INSERT INTO posts (
                        id, 
                        channel_id, 
                        content, 
                        media_url, 
                        media_type, 
                        scheduled_time, 
                        is_published, 
                        created_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, 0, CURRENT_TIMESTAMP)
                `, [
                    id, 
                    channelId, 
                    post.content, 
                    post.mediaUrl || null, 
                    mediaType, 
                    scheduledTime
                ]);

                scheduled.push({
                    id,
                    mediaType,
                    scheduledTime,
                    content: post.content
                });
            }

            // تنظیم زمان‌بندی
            this.setupScheduler(channelId, scheduled);

            return scheduled;
        } catch (error) {
            console.error('Schedule posts error:', error);
            throw error;
        }
    }

    detectMediaType(url) {
        if (!url) return 'none';
        const videoExts = ['.mp4', '.webm', '.ogv', '.mov', '.avi'];
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
        const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac'];
        
        const lower = url.toLowerCase();
        if (videoExts.some(ext => lower.includes(ext))) return 'video';
        if (imageExts.some(ext => lower.includes(ext))) return 'image';
        if (audioExts.some(ext => lower.includes(ext))) return 'audio';
        return 'none';
    }

    setupScheduler(channelId, posts) {
        // پاک کردن زمان‌بندی‌های قبلی
        this.clearSchedules();

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

    async publishSinglePost(postId) {
        try {
            // انتشار پست
            await this.db.query(this.userId, `
                UPDATE posts 
                SET 
                    is_published = 1, 
                    published_at = CURRENT_TIMESTAMP, 
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [postId]);

            // به‌روزرسانی تعداد پست‌های کانال
            const post = await this.db.query(this.userId, `
                SELECT channel_id FROM posts WHERE id = $1
            `, [postId]);

            if (post.rows.length > 0) {
                await this.db.query(this.userId, `
                    UPDATE channels 
                    SET posts_count = posts_count + 1, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [post.rows[0].channel_id]);
                
                // به‌روزرسانی امتیاز
                await this.updateUserActivity('post');
                await this.boostVisibility();
            }

            this.scheduleJobs.delete(postId);
            this.cache.clear();
            
            console.log(`✅ Scheduled post ${postId} published`);
        } catch (error) {
            console.error('Publish scheduled post error:', error);
        }
    }

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

    clearSchedules() {
        for (const [id, job] of this.scheduleJobs) {
            clearTimeout(job);
        }
        this.scheduleJobs.clear();
    }

    // ============================================================
    // بخش ۹: به‌روزرسانی فعالیت و امتیاز
    // ============================================================

    async updateUserActivity(type) {
        const scoreMap = {
            post: 20,
            like: 2,
            comment: 5,
            follow: 15,
            train: 10,
            view: 1,
            share: 8,
            save: 3
        };
        
        const points = scoreMap[type] || 0;
        
        try {
            await this.db.query(this.userId, `
                UPDATE users 
                SET 
                    score = score + $1, 
                    last_active = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2
            `, [points, this.userId]);
            
            // لاگ فعالیت
            await this.db.query(this.userId, `
                INSERT INTO user_activities (id, user_id, type, created_at)
                VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            `, [crypto.randomUUID(), this.userId, type]);
            
            return points;
        } catch (error) {
            console.error('Update user activity error:', error);
            return 0;
        }
    }

    // ============================================================
    // بخش ۱۰: الگوریتم دیده‌شدن (Boost Visibility)
    // ============================================================

    async boostVisibility() {
        try {
            const stats = await this.getStats();
            
            // محاسبه امتیاز فعالیت
            const activityScore = 
                (stats.totalPosts * 2) + 
                (stats.totalLikes * 0.5) + 
                (stats.totalComments * 1.5) + 
                (stats.totalTrainings * 3) +
                (stats.totalViews * 0.1) +
                (stats.totalShares * 4);

            let boostLevel = 'normal';
            if (activityScore > 100) boostLevel = 'high';
            if (activityScore > 300) boostLevel = 'viral';
            if (activityScore > 800) boostLevel = 'superstar';
            if (activityScore > 2000) boostLevel = 'legend';

            await this.db.query(this.userId, `
                UPDATE channels 
                SET 
                    boost_level = $1, 
                    activity_score = $2,
                    last_boost_calc = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $3
            `, [boostLevel, Math.round(activityScore), this.userId]);

            return { 
                boostLevel, 
                activityScore: Math.round(activityScore),
                nextLevel: this.getNextLevel(boostLevel)
            };
        } catch (error) {
            console.error('Boost visibility error:', error);
            return { boostLevel: 'normal', activityScore: 0 };
        }
    }

    getNextLevel(currentLevel) {
        const levels = ['normal', 'high', 'viral', 'superstar', 'legend'];
        const currentIndex = levels.indexOf(currentLevel);
        if (currentIndex < levels.length - 1) {
            return levels[currentIndex + 1];
        }
        return null;
    }

    // ============================================================
    // بخش ۱۱: دریافت آمار عملکرد
    // ============================================================

    async getStats() {
        try {
            const cacheKey = `stats_${this.userId}`;
            const cached = this.cache.get(cacheKey);
            
            if (cached && (Date.now() - cached.timestamp) < this.options.cacheTTL) {
                return cached.data;
            }

            // آمار پست‌ها
            const posts = await this.db.query(this.userId, `
                SELECT 
                    COUNT(*) as total_posts,
                    COALESCE(SUM(views), 0) as total_views,
                    COALESCE(SUM(likes), 0) as total_likes,
                    COALESCE(SUM(comments), 0) as total_comments,
                    COALESCE(SUM(shares), 0) as total_shares,
                    COALESCE(SUM(saves), 0) as total_saves
                FROM posts p
                JOIN channels c ON p.channel_id = c.id
                WHERE c.user_id = $1 AND p.is_published = 1
            `, [this.userId]);

            // آمار آموزش
            const trainings = await this.db.query(this.userId, `
                SELECT 
                    COUNT(*) as total_trainings,
                    SUM(CASE WHEN type = 'qa' THEN 1 ELSE 0 END) as qa_count,
                    SUM(CASE WHEN type = 'keyword' THEN 1 ELSE 0 END) as keyword_count
                FROM assistant_training
                WHERE user_id = $1
            `, [this.userId]);

            // فالوورها
            const followers = await this.db.query(this.userId, `
                SELECT followers_count FROM channels WHERE user_id = $1
            `, [this.userId]);

            const result = {
                totalPosts: parseInt(posts.rows[0]?.total_posts || 0),
                totalViews: parseInt(posts.rows[0]?.total_views || 0),
                totalLikes: parseInt(posts.rows[0]?.total_likes || 0),
                totalComments: parseInt(posts.rows[0]?.total_comments || 0),
                totalShares: parseInt(posts.rows[0]?.total_shares || 0),
                totalSaves: parseInt(posts.rows[0]?.total_saves || 0),
                totalTrainings: parseInt(trainings.rows[0]?.total_trainings || 0),
                qaCount: parseInt(trainings.rows[0]?.qa_count || 0),
                keywordCount: parseInt(trainings.rows[0]?.keyword_count || 0),
                followers: parseInt(followers.rows[0]?.followers_count || 0),
                engagementRate: this.calculateEngagementRate(posts.rows[0]),
                autoReplyStats: {
                    totalQueries: this.stats.totalQueries,
                    autoReplies: this.stats.autoReplies,
                    keywordMatches: this.stats.keywordMatches,
                    qaMatches: this.stats.qaMatches,
                    noMatches: this.stats.noMatches
                }
            };

            this.cache.set(cacheKey, {
                data: result,
                timestamp: Date.now()
            });

            return result;
        } catch (error) {
            console.error('Get stats error:', error);
            return {
                totalPosts: 0,
                totalViews: 0,
                totalLikes: 0,
                totalComments: 0,
                totalShares: 0,
                totalSaves: 0,
                totalTrainings: 0,
                qaCount: 0,
                keywordCount: 0,
                followers: 0,
                engagementRate: '0%'
            };
        }
    }

    calculateEngagementRate(postData) {
        if (!postData || !postData.total_posts || parseInt(postData.total_posts) === 0) {
            return '0%';
        }
        
        const views = parseInt(postData.total_views || 0);
        const likes = parseInt(postData.total_likes || 0);
        const comments = parseInt(postData.total_comments || 0);
        const shares = parseInt(postData.total_shares || 0);
        
        if (views === 0) return '0%';
        
        const engagement = ((likes + comments * 2 + shares * 3) / views) * 100;
        return engagement.toFixed(2) + '%';
    }

    // ============================================================
    // بخش ۱۲: مدیریت وضعیت دستیار
    // ============================================================

    setAutoReply(enabled) {
        this.options.autoReplyEnabled = enabled;
        return this.options.autoReplyEnabled;
    }

    getStatus() {
        return {
            userId: this.userId,
            autoReplyEnabled: this.options.autoReplyEnabled,
            trainingCount: this.trainingData?.length || 0,
            scheduledJobs: this.scheduleJobs.size,
            stats: this.stats,
            cacheSize: this.cache.size
        };
    }

    // ============================================================
    // بخش ۱۳: پاکسازی کش
    // ============================================================

    clearCache() {
        this.cache.clear();
        this.stats = {
            totalQueries: 0,
            autoReplies: 0,
            keywordMatches: 0,
            qaMatches: 0,
            noMatches: 0
        };
    }

    // ============================================================
    // بخش ۱۴: متدهای آموزشی
    // ============================================================

    async addTraining(type, data) {
        const id = crypto.randomUUID();
        const fields = {
            qa: ['question', 'answer'],
            keyword: ['keyword', 'response'],
            context: ['context']
        };
        
        const fieldNames = fields[type] || [];
        const values = fieldNames.map(f => data[f] || null);
        
        await this.db.query(this.userId, `
            INSERT INTO assistant_training (id, user_id, type, ${fieldNames.join(', ')}, created_at)
            VALUES ($1, $2, $3, ${fieldNames.map((_, i) => '$' + (i + 4)).join(', ')}, CURRENT_TIMESTAMP)
        `, [id, this.userId, type, ...values]);

        this.cache.delete(`training_${this.userId}`);
        this.loadTrainingData();
        
        return id;
    }

    async deleteTraining(id) {
        await this.db.query(this.userId, `
            DELETE FROM assistant_training 
            WHERE id = $1 AND user_id = $2
        `, [id, this.userId]);

        this.cache.delete(`training_${this.userId}`);
        this.loadTrainingData();
    }

    async updateTrainingWeight(id, weight) {
        await this.db.query(this.userId, `
            UPDATE assistant_training 
            SET weight = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND user_id = $3
        `, [weight, id, this.userId]);

        this.cache.delete(`training_${this.userId}`);
        this.loadTrainingData();
    }

    // ============================================================
    // بخش ۱۵: صادرات
    // ============================================================

    exportTraining() {
        return {
            userId: this.userId,
            data: this.trainingData,
            stats: this.stats,
            timestamp: new Date().toISOString()
        };
    }

    importTraining(data) {
        // پیاده‌سازی import
        // ...
    }

    // ============================================================
    // بخش ۱۶: تخریب
    // ============================================================

    destroy() {
        this.clearSchedules();
        this.clearCache();
        this.trainingData = null;
    }
}

// ============================================================
// بخش ۱۷: صادرات
// ============================================================

module.exports = IntelligentAssistant;

// ============================================================
// پایان فایل assistant.js
// ============================================================