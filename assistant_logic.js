// ============================================
// assistant.logic.js - هسته‌ی اصلی دستیار
// ============================================

class IntelligentAssistant {
    constructor(userId, db) {
        this.userId = userId;
        this.db = db;
        this.trainingData = null;
        this.postQueue = [];
        this.autoReplyEnabled = true;
    }
    
    // بارگذاری داده‌های آموزشی
    async loadTrainingData() {
        const result = await this.db.query(this.userId, `
            SELECT * FROM assistant_training 
            WHERE user_id = $1
        `, [this.userId]);
        
        this.trainingData = result.rows;
        return this.trainingData;
    }
    
    // پاسخ‌دهی خودکار بر اساس کلمات کلیدی
    async autoReply(message) {
        if (!this.autoReplyEnabled) return null;
        
        await this.loadTrainingData();
        
        // بررسی کلمات کلیدی
        const keywords = this.trainingData.filter(t => t.type === 'keyword');
        for (const kw of keywords) {
            if (message.includes(kw.keyword)) {
                return kw.response;
            }
        }
        
        // بررسی سوالات مشابه (با تطابق ساده)
        const qa = this.trainingData.filter(t => t.type === 'qa');
        for (const q of qa) {
            if (message.includes(q.question) || q.question.includes(message)) {
                return q.answer;
            }
        }
        
        return null;
    }
    
    // زمان‌بندی پست‌ها
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
            await this.db.query(this.userId, `
                INSERT INTO posts (id, channel_id, content, media_url, scheduled_time, is_published)
                VALUES ($1, $2, $3, $4, $5, false)
            `, [id, channelId, post.content, post.mediaUrl, post.scheduledTime]);
            
            scheduled.push(id);
        }
        
        return scheduled;
    }
    
    // انتشار پست‌های زمان‌بندی شده
    async publishScheduledPosts() {
        const now = new Date().toISOString();
        const result = await this.db.query(this.userId, `
            SELECT * FROM posts 
            WHERE channel_id IN (
                SELECT id FROM channels WHERE user_id = $1
            )
            AND is_published = false
            AND scheduled_time <= $2::timestamp
        `, [this.userId, now]);
        
        const published = [];
        for (const post of result.rows) {
            // انتشار پست
            await this.db.query(this.userId, `
                UPDATE posts SET is_published = true, published_at = NOW()
                WHERE id = $1
            `, [post.id]);
            
            // به‌روزرسانی تعداد پست‌های کانال
            await this.db.query(this.userId, `
                UPDATE channels SET posts_count = posts_count + 1
                WHERE id = $1
            `, [post.channel_id]);
            
            published.push(post.id);
        }
        
        return published;
    }
    
    // تحلیل فعالیت کاربر و به‌روزرسانی امتیاز
    async updateUserActivity(type) {
        const scoreMap = {
            'post': 20,
            'like': 2,
            'comment': 5,
            'follow': 15,
            'train': 10
        };
        
        const points = scoreMap[type] || 0;
        await this.db.query(this.userId, `
            UPDATE users SET score = score + $1 WHERE id = $2
        `, [points, this.userId]);
        
        return points;
    }
    
    // دریافت آمار عملکرد دستیار
    async getStats() {
        const posts = await this.db.query(this.userId, `
            SELECT COUNT(*) as total_posts, 
                   SUM(views) as total_views,
                   SUM(likes) as total_likes
            FROM posts p
            JOIN channels c ON p.channel_id = c.id
            WHERE c.user_id = $1 AND p.is_published = true
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
        if (!postData || postData.total_posts === 0) return 0;
        const views = parseInt(postData.total_views || 0);
        const likes = parseInt(postData.total_likes || 0);
        const posts = parseInt(postData.total_posts || 1);
        return ((likes / views) * 100).toFixed(2) + '%';
    }
    
    // الگوریتم هوشمند برای دیده شدن بیشتر
    async boostVisibility(userId) {
        // محاسبه‌ی امتیاز فعالیت
        const stats = await this.getStats();
        const activityScore = (stats.totalPosts * 2) + (stats.totalLikes * 0.5) + (stats.totalTrainings * 3);
        
        // تعیین سطح دیده شدن
        let boostLevel = 'normal';
        if (activityScore > 500) boostLevel = 'high';
        if (activityScore > 1000) boostLevel = 'viral';
        if (activityScore > 5000) boostLevel = 'superstar';
        
        // به‌روزرسانی رتبه‌ی کانال
        await this.db.query(userId, `
            UPDATE channels 
            SET boost_level = $1, 
                activity_score = $2,
                last_boost_calc = NOW()
            WHERE user_id = $3
        `, [boostLevel, activityScore, userId]);
        
        return { boostLevel, activityScore };
    }
}

module.exports = IntelligentAssistant;