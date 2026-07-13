// ============================================
// cleanup.js - پاکسازی و بهینه‌سازی دیتابیس
// ============================================
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.sqlite');

function cleanupDatabase() {
    console.log('🧹 Starting database cleanup...');
    console.log('');

    const db = new Database(DB_PATH);
    
    try {
        // ============================================
        // 1. حذف پست‌های منتشر نشده قدیمی (بیش از 30 روز)
        // ============================================
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const result1 = db.prepare(`
            DELETE FROM posts 
            WHERE is_published = 0 
            AND scheduled_time < ?
        `).run(thirtyDaysAgo.toISOString());
        console.log(`📝 Removed ${result1.changes} unpublished old posts`);

        // ============================================
        // 2. حذف پیام‌های خوانده شده قدیمی (بیش از 90 روز)
        // ============================================
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
        const result2 = db.prepare(`
            DELETE FROM messages 
            WHERE is_read = 1 
            AND created_at < ?
        `).run(ninetyDaysAgo.toISOString());
        console.log(`💬 Removed ${result2.changes} old read messages`);

        // ============================================
        // 3. حذف نوتیفیکیشن‌های خوانده شده قدیمی (بیش از 60 روز)
        // ============================================
        const sixtyDaysAgo = new Date();
        sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
        const result3 = db.prepare(`
            DELETE FROM system_notifications 
            WHERE is_read = 1 
            AND created_at < ?
        `).run(sixtyDaysAgo.toISOString());
        console.log(`🔔 Removed ${result3.changes} old read notifications`);

        // ============================================
        // 4. حذف فعالیت‌های قدیمی (بیش از 180 روز)
        // ============================================
        const hundredEightyDaysAgo = new Date();
        hundredEightyDaysAgo.setDate(hundredEightyDaysAgo.getDate() - 180);
        const result4 = db.prepare(`
            DELETE FROM user_activities 
            WHERE created_at < ?
        `).run(hundredEightyDaysAgo.toISOString());
        console.log(`📊 Removed ${result4.changes} old user activities`);

        // ============================================
        // 5. به‌روزرسانی آمار کاربران
        // ============================================
        db.exec(`
            UPDATE channels SET 
                posts_count = (
                    SELECT COUNT(*) FROM posts 
                    WHERE channel_id = channels.id AND is_published = 1
                ),
                updated_at = CURRENT_TIMESTAMP
        `);
        console.log('🔄 Updated channel statistics');

        // ============================================
        // 6. به‌روزرسانی امتیاز کاربران
        // ============================================
        db.exec(`
            UPDATE users SET 
                score = (
                    SELECT COALESCE(SUM(
                        CASE 
                            WHEN type = 'post' THEN 20
                            WHEN type = 'like' THEN 2
                            WHEN type = 'comment' THEN 5
                            WHEN type = 'follow' THEN 15
                            WHEN type = 'train' THEN 10
                            WHEN type = 'share' THEN 8
                            ELSE 0
                        END
                    ), 0)
                    FROM user_activities
                    WHERE user_activities.user_id = users.id
                ),
                updated_at = CURRENT_TIMESTAMP
        `);
        console.log('🔄 Updated user scores');

        // ============================================
        // 7. وکیوم و بهینه‌سازی دیتابیس
        // ============================================
        console.log('⏳ Running VACUUM...');
        db.exec('VACUUM');
        console.log('✅ VACUUM completed');

        console.log('⏳ Running ANALYZE...');
        db.exec('ANALYZE');
        console.log('✅ ANALYZE completed');

        // ============================================
        // 8. نمایش آمار نهایی
        // ============================================
        console.log('');
        console.log('📊 ====== Final Statistics ======');
        const stats = db.prepare(`
            SELECT 
                (SELECT COUNT(*) FROM users) as users,
                (SELECT COUNT(*) FROM posts WHERE is_published = 1) as posts,
                (SELECT COUNT(*) FROM messages) as messages,
                (SELECT COUNT(*) FROM follows) as follows,
                (SELECT COUNT(*) FROM post_comments) as comments,
                (SELECT COUNT(*) FROM assistant_training) as trainings
        `).get();
        
        console.log(`👥 Users: ${stats.users}`);
        console.log(`📝 Posts: ${stats.posts}`);
        console.log(`💬 Messages: ${stats.messages}`);
        console.log(`👤 Follows: ${stats.follows}`);
        console.log(`💭 Comments: ${stats.comments}`);
        console.log(`🤖 Trainings: ${stats.trainings}`);
        console.log('📊 ===============================');

        console.log('');
        console.log('✅ Cleanup completed successfully');

    } catch (error) {
        console.error('❌ Cleanup error:', error);
    } finally {
        db.close();
    }
}

// اجرای پاکسازی
cleanupDatabase();