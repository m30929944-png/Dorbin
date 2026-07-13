// ============================================
// assistant_logic.js - دستیار هوشمند پیشرفته با الگوریتم‌های AI
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
        this.contextMemory = new Map(); // حافظه مکالمه
        this.learningRate = 0.85;
        this.confidenceThreshold = 0.6;
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
    // پاسخ‌دهی خودکار با هوش مصنوعی
    // ============================================
    async autoReply(message) {
        if (!this.autoReplyEnabled) return null;
        await this.loadTrainingData();

        const cleanMsg = (message || '').trim();
        if (!cleanMsg) return null;

        // 1. بررسی کلمات کلیدی (دقیق)
        const keywords = this.trainingData.filter(t => t.type === 'keyword');
        for (const kw of keywords) {
            if (kw.keyword && cleanMsg.toLowerCase().includes(kw.keyword.toLowerCase())) {
                return this.formatResponse(kw.response, 'keyword');
            }
        }

        // 2. بررسی سوالات (تطابق دقیق)
        const qa = this.trainingData.filter(t => t.type === 'qa');
        for (const q of qa) {
            if (!q.question) continue;
            const questionLower = q.question.toLowerCase();
            const msgLower = cleanMsg.toLowerCase();
            
            // تطابق کامل
            if (msgLower === questionLower) {
                return this.formatResponse(q.answer, 'qa');
            }
            
            // تطابق جزئی (حداقل 70% کلمات)
            const qWords = questionLower.split(' ');
            const mWords = msgLower.split(' ');
            const matchCount = qWords.filter(w => mWords.includes(w)).length;
            const matchPercent = matchCount / qWords.length;
            
            if (matchPercent >= 0.7) {
                return this.formatResponse(q.answer, 'qa');
            }
        }

        // 3. بررسی کلمات کلیدی با تطابق جزئی
        for (const kw of keywords) {
            if (!kw.keyword) continue;
            const kwLower = kw.keyword.toLowerCase();
            const msgLower = cleanMsg.toLowerCase();
            
            // اگر کلمه کلیدی در پیام وجود دارد
            if (msgLower.includes(kwLower) || kwLower.includes(msgLower)) {
                return this.formatResponse(kw.response, 'keyword');
            }
            
            // بررسی کلمات جداگانه
            const kwWords = kwLower.split(' ');
            const msgWords = msgLower.split(' ');
            const matchCount = kwWords.filter(w => msgWords.includes(w)).length;
            
            if (kwWords.length > 1 && matchCount / kwWords.length >= 0.5) {
                return this.formatResponse(kw.response, 'keyword');
            }
        }

        // 4. حافظه مکالمه (Context Memory)
        const context = this.contextMemory.get(this.userId) || [];
        if (context.length > 0) {
            const lastContext = context[context.length - 1];
            for (const q of qa) {
                if (!q.question) continue;
                if (lastContext.includes(q.question.toLowerCase().split(' ').slice(0, 3).join(' '))) {
                    return this.formatResponse(q.answer, 'context');
                }
            }
        }

        // 5. پاسخ‌های هوشمند (بر اساس دسته‌بندی)
        const categoryResponse = this.getCategoryResponse(cleanMsg);
        if (categoryResponse) {
            return this.formatResponse(categoryResponse, 'category');
        }

        return null;
    }

    // ============================================
    // دسته‌بندی پیام‌ها برای پاسخ‌های هوشمند
    // ============================================
    getCategoryResponse(message) {
        const msg = message.toLowerCase();
        
        // احوالپرسی
        if (this.matchAny(msg, ['سلام', 'درود', 'هی', 'سلامت', 'چطوری', 'چه خبر', 'خوبی'])) {
            return this.getRandomResponse([
                'سلام! چطور می‌توانم کمک کنم؟',
                'درود بر شما! چه سوالی دارید؟',
                'سلام وقت بخیر! در خدمت شما هستم'
            ]);
        }
        
        // خداحافظی
        if (this.matchAny(msg, ['خداحافظ', 'بای', 'فعلا', 'بعدا', 'خدا نگهدار'])) {
            return this.getRandomResponse([
                'خداحافظ! موفق باشید',
                'به امید دیدار مجدد',
                'موفق باشید!'
            ]);
        }
        
        // تشکر
        if (this.matchAny(msg, ['مرسی', 'ممنون', 'سپاس', 'متشکرم', 'دمت گرم'])) {
            return this.getRandomResponse([
                'خواهش می‌کنم! خوشحالم که کمک کردم',
                'قابل شما را نداشت',
                'خوشحالم که مفید بودم'
            ]);
        }
        
        // سوالات عمومی
        if (this.matchAny(msg, ['کی هستی', 'تو کی هستی', 'دستیار', 'چیستی'])) {
            return 'من دستیار هوشمند یارِ من هستم! برای کمک به شما طراحی شده‌ام. می‌توانم به سوالات شما پاسخ دهم و اطلاعات مفید ارائه کنم.';
        }
        
        if (this.matchAny(msg, ['چیکار میکنی', 'چه کاری انجام میدی', 'کارت چیه'])) {
            return 'من به کاربران کمک می‌کنم! می‌توانم به سوالات پاسخ دهم، اطلاعات ارائه کنم، پست‌ها را زمان‌بندی کنم و در تعاملات اجتماعی کمک کنم.';
        }
        
        return null;
    }

    // ============================================
    // توابع کمکی برای دسته‌بندی
    // ============================================
    matchAny(text, patterns) {
        return patterns.some(p => text.includes(p));
    }

    getRandomResponse(responses) {
        return responses[Math.floor(Math.random() * responses.length)];
    }

    // ============================================
    // فرمت کردن پاسخ
    // ============================================
    formatResponse(response, source) {
        // اضافه کردن اعتماد به پاسخ
        let confidence = 0.7;
        if (source === 'keyword') confidence = 0.9;
        if (source === 'qa') confidence = 0.85;
        if (source === 'context') confidence = 0.75;
        if (source === 'category') confidence = 0.6;
        
        return {
            text: response,
            source: source,
            confidence: confidence,
            timestamp: new Date().toISOString()
        };
    }

    // ============================================
    // زمان‌بندی پست‌ها
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
            await this.db.query(this.userId, `
                UPDATE posts SET is_published = 1, published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [postId]);

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
            share: 8,
            schedule: 15
        };
        const points = scoreMap[type] || 0;
        
        await this.db.query(this.userId, `
            UPDATE users SET score = score + $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [points, this.userId]);
        
        // ثبت فعالیت
        await this.db.logActivity(this.userId, type);
        
        return points;
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
    // الگوریتم دیده‌شدن (Boost Visibility)
    // ============================================
    async boostVisibility() {
        const stats = await this.getStats();
        const activityScore = 
            (stats.totalPosts * 2) + 
            (stats.totalLikes * 0.5) + 
            (stats.totalComments * 1) + 
            (stats.totalTrainings * 3) +
            (stats.totalViews * 0.1) +
            (stats.followers * 1.5);

        let boostLevel = 'normal';
        let boostMultiplier = 1;
        
        if (activityScore > 50) { boostLevel = 'high'; boostMultiplier = 1.5; }
        if (activityScore > 150) { boostLevel = 'viral'; boostMultiplier = 2.5; }
        if (activityScore > 400) { boostLevel = 'superstar'; boostMultiplier = 4; }
        if (activityScore > 1000) { boostLevel = 'legend'; boostMultiplier = 6; }

        await this.db.query(this.userId, `
            UPDATE channels 
            SET boost_level = $1, 
                activity_score = $2,
                last_boost_calc = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $3
        `, [boostLevel, Math.round(activityScore), this.userId]);

        return { 
            boostLevel, 
            activityScore: Math.round(activityScore),
            boostMultiplier,
            message: this.getBoostMessage(boostLevel)
        };
    }

    getBoostMessage(level) {
        const messages = {
            normal: 'کانال شما در حالت عادی است. با فعالیت بیشتر، دیده‌شوید افزایش می‌یابد.',
            high: '🔥 کانال شما داغ شده! پست‌های شما بیشتر دیده می‌شوند.',
            viral: '🚀 کانال شما وایرال شده! پست‌های شما به بسیاری از کاربران نمایش داده می‌شود.',
            superstar: '⭐ کانال شما فوق‌ستاره است! بهترین پست‌ها را منتشر کنید.',
            legend: '👑 کانال شما افسانه‌ای است! شما جزو بهترین کاربران هستید.'
        };
        return messages[level] || messages.normal;
    }

    // ============================================
    // تشخیص رفتارهای نامناسب با هوش مصنوعی
    // ============================================
    async detectAnomalies() {
        const anomalies = [];
        
        // 1. بررسی نرخ آنفالو
        const unfollowRate = await this.db.query(this.userId, `
            SELECT COUNT(*) as count FROM follows 
            WHERE following_id = $1 AND created_at > datetime('now', '-7 days')
        `, [this.userId]);
        
        const unfollowCount = unfollowRate.rows[0]?.count || 0;
        if (unfollowCount > 20) {
            anomalies.push({
                type: 'unfollow_spike',
                severity: 'high',
                message: `نرخ آنفالو بالا: ${unfollowCount} نفر در ۷ روز اخیر`,
                score: unfollowCount * 2
            });
        }

        // 2. بررسی نرخ گزارش پست‌ها
        const reportRate = await this.db.query(this.userId, `
            SELECT COUNT(*) as count FROM reports 
            WHERE target_id IN (
                SELECT id FROM posts 
                WHERE channel_id IN (SELECT id FROM channels WHERE user_id = $1)
            )
            AND created_at > datetime('now', '-7 days')
        `, [this.userId]);
        
        const reportCount = reportRate.rows[0]?.count || 0;
        if (reportCount > 5) {
            anomalies.push({
                type: 'report_spike',
                severity: 'medium',
                message: `تعداد گزارش‌های بالا: ${reportCount} گزارش در ۷ روز اخیر`,
                score: reportCount * 3
            });
        }

        // 3. بررسی فعالیت مشکوک (اسپم)
        const spamActivity = await this.db.query(this.userId, `
            SELECT COUNT(*) as count FROM posts 
            WHERE channel_id IN (SELECT id FROM channels WHERE user_id = $1)
            AND created_at > datetime('now', '-1 hour')
        `, [this.userId]);
        
        const spamCount = spamActivity.rows[0]?.count || 0;
        if (spamCount > 15) {
            anomalies.push({
                type: 'spam_activity',
                severity: 'high',
                message: `فعالیت اسپم: ${spamCount} پست در یک ساعت اخیر`,
                score: spamCount * 1.5
            });
        }

        // 4. بررسی محتوای نامناسب (کلمات کلیدی)
        const badWords = ['کلاهبرداری', 'فروش', 'تبلیغ', 'اسپم', 'بی‌ادبی', 'فحش'];
        const contentCheck = await this.db.query(this.userId, `
            SELECT content FROM posts 
            WHERE channel_id IN (SELECT id FROM channels WHERE user_id = $1)
            AND created_at > datetime('now', '-7 days')
            LIMIT 50
        `, [this.userId]);
        
        for (const post of contentCheck.rows) {
            const content = post.content.toLowerCase();
            for (const word of badWords) {
                if (content.includes(word)) {
                    anomalies.push({
                        type: 'inappropriate_content',
                        severity: 'medium',
                        message: `محتوای نامناسب: شامل کلمه "${word}"`,
                        score: 10
                    });
                    break;
                }
            }
        }

        // 5. بررسی نرخ تعامل پایین
        const engagement = await this.getStats();
        if (engagement.totalPosts > 5) {
            const rate = parseFloat(engagement.engagementRate);
            if (rate < 1) {
                anomalies.push({
                    type: 'low_engagement',
                    severity: 'low',
                    message: `نرخ تعامل پایین: ${rate}%`,
                    score: 5
                });
            }
        }

        return anomalies;
    }

    // ============================================
    // تحلیل و پیشنهادات هوشمند
    // ============================================
    async getSmartSuggestions() {
        const stats = await this.getStats();
        const anomalies = await this.detectAnomalies();
        const suggestions = [];

        // پیشنهاد بر اساس آمار
        if (stats.totalPosts === 0) {
            suggestions.push({
                type: 'content',
                message: '📝 هنوز پستی منتشر نکرده‌اید. اولین پست خود را بنویسید!',
                priority: 'high'
            });
        }

        if (stats.totalPosts > 0 && parseFloat(stats.engagementRate) < 2) {
            suggestions.push({
                type: 'engagement',
                message: '📊 نرخ تعامل پایین است. سعی کنید محتوای جذاب‌تر منتشر کنید.',
                priority: 'medium'
            });
        }

        if (stats.totalTrainings < 3) {
            suggestions.push({
                type: 'training',
                message: '🤖 دستیار خود را آموزش دهید تا بهتر بتواند به کاربران پاسخ دهد.',
                priority: 'medium'
            });
        }

        if (stats.followers < 10) {
            suggestions.push({
                type: 'followers',
                message: '👥 تعداد فالوورهای شما کم است. با کاربران دیگر تعامل کنید.',
                priority: 'low'
            });
        }

        // پیشنهاد بر اساس ناهنجاری‌ها
        for (const anomaly of anomalies) {
            if (anomaly.severity === 'high') {
                suggestions.push({
                    type: 'warning',
                    message: `⚠️ ${anomaly.message}. لطفاً این موضوع را بررسی کنید.`,
                    priority: 'high'
                });
            }
        }

        return suggestions;
    }

    // ============================================
    // هوش مصنوعی برای بهبود محتوا
    // ============================================
    async enhanceContent(content) {
        if (!content || content.length < 10) return content;

        // تحلیل محتوا
        const words = content.split(' ');
        const hashtags = words.filter(w => w.startsWith('#'));
        const mentions = words.filter(w => w.startsWith('@'));
        
        // پیشنهاد هشتگ
        let enhanced = content;
        if (hashtags.length === 0) {
            const suggestedTags = this.generateHashtags(content);
            if (suggestedTags.length > 0) {
                enhanced += '\n\n' + suggestedTags.join(' ');
            }
        }

        // پیشنهاد بهبود
        return {
            original: content,
            enhanced: enhanced,
            suggestions: {
                hashtags: hashtags.length === 0 ? 'افزودن هشتگ مناسب' : 'هشتگ مناسب است',
                length: words.length < 20 ? 'محتوا می‌تواند طولانی‌تر باشد' : 'طول محتوا مناسب است'
            }
        };
    }

    // ============================================
    // تولید هشتگ‌های هوشمند
    // ============================================
    generateHashtags(content) {
        const commonTags = [
            '#یار_من', '#پلتفرم_اجتماعی', '#هوش_مصنوعی',
            '#محتوا', '#ارتباطات', '#شبکه_اجتماعی'
        ];
        
        const words = content.split(' ');
        const tags = [];
        
        // استخراج کلمات کلیدی
        for (const word of words) {
            if (word.length > 3 && !word.startsWith('#') && !word.startsWith('@')) {
                tags.push('#' + word);
                if (tags.length >= 2) break;
            }
        }
        
        return [...tags, ...commonTags.slice(0, 3 - tags.length)];
    }

    // ============================================
    // حافظه مکالمه (Context Memory)
    // ============================================
    async updateContext(message, response) {
        const context = this.contextMemory.get(this.userId) || [];
        context.push({
            message: message,
            response: response,
            timestamp: Date.now()
        });
        
        // نگهداری فقط ۱۰ مکالمه آخر
        if (context.length > 10) {
            context.shift();
        }
        
        this.contextMemory.set(this.userId, context);
    }

    // ============================================
    // یادگیری از تعاملات
    // ============================================
    async learnFromInteraction(message, response, feedback) {
        if (!feedback) return;
        
        // ذخیره تعامل برای یادگیری
        await this.db.query(this.userId, `
            INSERT INTO assistant_training (id, user_id, type, question, answer, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [
            crypto.randomUUID(),
            this.userId,
            'qa',
            message,
            response + ` [${feedback === 'positive' ? '✓' : '✗'}]`
        ]);
        
        this.cache.delete(`training_${this.userId}`);
        await this.loadTrainingData();
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
            contextMemorySize: this.contextMemory.get(this.userId)?.length || 0,
            learningRate: this.learningRate,
            confidenceThreshold: this.confidenceThreshold
        };
    }

    // ============================================
    // پاک کردن کش
    // ============================================
    clearCache() {
        this.cache.clear();
        this.contextMemory.clear();
    }

    // ============================================
    // دریافت آمار پیشرفته
    // ============================================
    async getAdvancedStats() {
        const stats = await this.getStats();
        const anomalies = await this.detectAnomalies();
        const suggestions = await this.getSmartSuggestions();
        const status = this.getStatus();

        // محاسبه نمره کیفیت
        const qualityScore = this.calculateQualityScore(stats, anomalies);

        return {
            ...stats,
            anomalies,
            suggestions,
            status,
            qualityScore,
            timestamp: new Date().toISOString()
        };
    }

    // ============================================
    // محاسبه نمره کیفیت
    // ============================================
    calculateQualityScore(stats, anomalies) {
        let score = 0;
        
        // امتیاز بر اساس پست‌ها
        score += Math.min(stats.totalPosts * 2, 30);
        
        // امتیاز بر اساس تعامل
        const engagement = parseFloat(stats.engagementRate);
        score += Math.min(engagement * 3, 30);
        
        // امتیاز بر اساس فالوورها
        score += Math.min(stats.followers * 0.5, 20);
        
        // امتیاز بر اساس آموزش
        score += Math.min(stats.totalTrainings * 2, 20);
        
        // کاهش امتیاز بر اساس ناهنجاری‌ها
        for (const anomaly of anomalies) {
            if (anomaly.severity === 'high') score -= 15;
            if (anomaly.severity === 'medium') score -= 10;
            if (anomaly.severity === 'low') score -= 5;
        }
        
        return Math.max(0, Math.min(100, score));
    }

    // ============================================
    // پاسخ‌دهی با قابلیت یادگیری
    // ============================================
    async smartResponse(message) {
        // دریافت پاسخ اولیه
        const response = await this.autoReply(message);
        
        if (response) {
            // به‌روزرسانی حافظه مکالمه
            await this.updateContext(message, response.text);
            
            // بازخورد ضمنی (اگر کاربر دوباره سوال کرد، پاسخ را تقویت کن)
            const context = this.contextMemory.get(this.userId) || [];
            const similarQuestions = context.filter(c => 
                c.message.toLowerCase().includes(message.toLowerCase().split(' ').slice(0, 3).join(' '))
            );
            
            if (similarQuestions.length > 1) {
                // افزایش اعتماد به پاسخ
                response.confidence = Math.min(response.confidence + 0.1, 1);
            }
            
            return {
                ...response,
                source: response.source || 'assistant'
            };
        }
        
        return null;
    }
}

module.exports = IntelligentAssistant;