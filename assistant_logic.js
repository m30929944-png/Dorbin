// ============================================
// assistant_logic.js - با بهینه‌سازی و کش
// ============================================
const crypto = require('crypto');

class IntelligentAssistant {
  constructor(userId, db) {
    this.userId = userId;
    this.db = db;
    this.trainingData = null;
    this.autoReplyEnabled = true;
    this.cache = new Map();
  }

  async loadTrainingData() {
    if (this.trainingData) return this.trainingData;

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

    const cleanMsg = (message || '').trim().toLowerCase();
    if (!cleanMsg) return null;

    // بررسی کلمات کلیدی (با اولویت)
    const keywords = this.trainingData.filter(t => t.type === 'keyword');
    for (const kw of keywords) {
      if (kw.keyword && cleanMsg.includes(kw.keyword.toLowerCase())) {
        return kw.response;
      }
    }

    // بررسی سوالات با تطابق پیشرفته‌تر
    const qa = this.trainingData.filter(t => t.type === 'qa');
    let bestMatch = null;
    let bestScore = 0;

    for (const q of qa) {
      if (!q.question) continue;
      const qLower = q.question.toLowerCase();
      const score = this.similarityScore(cleanMsg, qLower);
      if (score > bestScore && score > 0.3) {
        bestScore = score;
        bestMatch = q.answer;
      }
    }

    return bestMatch || null;
  }

  similarityScore(text1, text2) {
    const words1 = text1.split(/\s+/);
    const words2 = text2.split(/\s+/);
    const common = words1.filter(w => words2.includes(w)).length;
    const total = Math.max(words1.length, words2.length);
    return total > 0 ? common / total : 0;
  }

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
        VALUES ($1, $2, $3, $4, $5, 0)
      `, [id, channelId, post.content, post.mediaUrl || null, post.scheduledTime]);
      scheduled.push(id);
    }

    return scheduled;
  }

  async publishScheduledPosts() {
    const now = new Date().toISOString();
    const result = await this.db.query(this.userId, `
      SELECT * FROM posts 
      WHERE channel_id IN (SELECT id FROM channels WHERE user_id = $1)
      AND is_published = 0
      AND scheduled_time <= $2
    `, [this.userId, now]);

    const published = [];
    for (const post of result.rows) {
      await this.db.query(this.userId, `
        UPDATE posts SET is_published = 1, published_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [post.id]);

      await this.db.query(this.userId, `
        UPDATE channels SET posts_count = posts_count + 1
        WHERE id = $1
      `, [post.channel_id]);

      published.push(post.id);
    }

    return published;
  }

  async updateUserActivity(type) {
    const scoreMap = { post: 20, like: 2, comment: 5, follow: 15, train: 10 };
    const points = scoreMap[type] || 0;
    await this.db.query(this.userId, `
      UPDATE users SET score = score + $1 WHERE id = $2
    `, [points, this.userId]);
    return points;
  }

  async getStats() {
    const cacheKey = `stats_${this.userId}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

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

    const result = {
      totalPosts: parseInt(posts.rows[0]?.total_posts || 0),
      totalViews: parseInt(posts.rows[0]?.total_views || 0),
      totalLikes: parseInt(posts.rows[0]?.total_likes || 0),
      totalTrainings: parseInt(trainings.rows[0]?.total_trainings || 0),
      followers: parseInt(followers.rows[0]?.followers_count || 0),
      engagementRate: this.calculateEngagementRate(posts.rows[0])
    };

    this.cache.set(cacheKey, result);
    setTimeout(() => this.cache.delete(cacheKey), 60000);
    return result;
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
          last_boost_calc = CURRENT_TIMESTAMP
      WHERE user_id = $3
    `, [boostLevel, activityScore, this.userId]);

    return { boostLevel, activityScore };
  }
}

module.exports = IntelligentAssistant;