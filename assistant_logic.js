// ============================================
// assistant_logic.js - دستیار هوشمند پیشرفته
// ============================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class IntelligentAssistant {
    constructor(userId, db) {
        this.userId = userId;
        this.db = db;
        this.trainingData = null;
        this.autoReplyEnabled = true;
        this.scheduleJobs = new Map();
    }

    async loadTrainingData() {
        const result = await this.db.query(this.userId, `
            SELECT * FROM assistant_training 
            WHERE user_id = $1
        `, [this.userId]);
        this.trainingData = result.rows;
        return this.trainingData;
    }

    async autoReply(message) {
        if (!this.autoReplyEnabled) return null;
        await this.loadTrainingData();

        const cleanMsg = (message || '').trim();
        if (!cleanMsg) return null;

        const keywords = this.trainingData.filter(t => t.type === 'keyword');
        for (const kw of keywords) {
            if (kw.keyword && cleanMsg.includes(kw.keyword)) {
                return kw.response;
            }
        }

        const qa = this.trainingData.filter(t => t.type === 'qa');
        for (const q of qa) {
            if (!q.question) continue;
            if (cleanMsg.includes(q.question) || q.question.includes(cleanMsg)) {
                return q.answer;
            }
        }

        return null;
    }

    // زمان‌بندی پست‌ها با پشتیبانی از ویدیو
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
                (post.mediaUrl.match(/\.(mp4|webm|ogg|mov)$/i) ? 'video' : 
                 post.mediaUrl.match(/\.(mp3|wav|ogg)$/i) ? 'audio' : 'image') : 'none';

            await this.db.query(this.userId, `
                INSERT INTO posts (id, channel_id, content, media_url, media_type, scheduled_time, is_published)
                VALUES ($1, $2, $3, $4, $5, $6, 0)
            `, [id, channelId, post.content, post.mediaUrl || null, mediaType, post.scheduledTime]);

            scheduled.push({ id, mediaType, scheduledTime: post.scheduledTime });
        }

        // تنظیم زمان‌بندی برای ارسال خودکار
        this.setupScheduler(channelId, scheduled);

        return scheduled;
    }

    // تنظیم زمان‌بندی ارسال خودکار پست‌ها
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

    // انتشار یک پست زمان‌بندی شده
    async publishSinglePost(postId) {
        try {
            await this.db.query(this.userId, `
                UPDATE posts SET is_published = 1, published_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [postId]);

            const post = await this.db.query(this.userId, `
                SELECT channel_id FROM posts WHERE id = $1
            `, [postId]);

            if (post.rows.length > 0) {
                await this.db.query(this.userId, `
                    UPDATE channels SET posts_count = posts_count + 1
                    WHERE id = $1
                `, [post.rows[0].channel_id]);
            }

            this.scheduleJobs.delete(postId);
        } catch (error) {
            console.error('Error publishing scheduled post:', error);
        }
    }

    // انتشار پست‌های زمان‌بندی شده (فراخوانی دوره‌ای)
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

    async updateUserActivity(type) {
        const scoreMap = { post: 20, like: 2, comment: 5, follow: 15, train: 10 };
        const points = scoreMap[type] || 0;
        await this.db.query(this.userId, `
            UPDATE users SET score = score + $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [points, this.userId]);
        return points;
    }

    async getStats() {
        const posts = await this.db.query(this.userId, `
            SELECT COUNT(*) as total_posts, 
                   SUM(views) as total_views,
                   SUM(likes) as total_likes
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

        return {
            totalPosts: parseInt(posts.rows[0]?.total_posts || 0),
            totalViews: parseInt(posts.rows[0]?.total_views || 0),
            totalLikes: parseInt(posts.rows[0]?.total_likes || 0),
            totalTrainings: parseInt(trainings.rows[0]?.total_trainings || 0),
            followers: parseInt(followers.rows[0]?.followers_count || 0),
            engagementRate: this.calculateEngagementRate(posts.rows[0])
        };
    }

    calculateEngagementRate(postData) {
        if (!postData || !postData.total_posts) return '0%';
        const views = parseInt(postData.total_views || 0);
        const likes = parseInt(postData.total_likes || 0);
        if (!views) return '0%';
        return ((likes / views) * 100).toFixed(2) + '%';
    }

    async boostVisibility() {
        const stats = await this.getStats();
        const activityScore = (stats.totalPosts * 2) + (stats.totalLikes * 0.5) + (stats.totalTrainings * 3);

        let boostLevel = 'normal';
        if (activityScore > 500) boostLevel = 'high';
        if (activityScore > 1000) boostLevel = 'viral';
        if (activityScore > 5000) boostLevel = 'superstar';

        await this.db.query(this.userId, `
            UPDATE channels 
            SET boost_level = $1, 
                activity_score = $2,
                last_boost_calc = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $3
        `, [boostLevel, activityScore, this.userId]);

        return { boostLevel, activityScore };
    }

    // پاک کردن زمان‌بندی‌ها
    clearSchedules() {
        for (const [id, job] of this.scheduleJobs) {
            clearTimeout(job);
        }
        this.scheduleJobs.clear();
    }
}

module.exports = IntelligentAssistant;