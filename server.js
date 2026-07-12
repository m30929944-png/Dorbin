// ============================================
// 🚀 server.js - نقطه شروع برنامه
// ============================================
// این فایل، فایلیه که باید اجرا کنی: node server.js
// کارش اینه که به ترتیب درست همه ماژول‌ها رو بارگذاری کنه:
// m1 (هسته + دیتابیس + احراز هویت) -> m2 (کاربران/چت) ->
// m3 (پست/استوری) -> m4 (پنل ادمین) -> و بعد سرور رو روشن کنه.
//
// چرا این فایل لازم بود؟
// توی نسخه قبلی، m1.js خودش server.listen() رو صدا می‌زد،
// در حالی که m2.js و m3.js و m4.js هیچ‌جا require نمی‌شدن.
// یعنی مسیرهای API مربوط به کاربر، پست، چت و پنل ادمین
// اصلاً هیچ‌وقت ثبت نمی‌شدن و همه‌شون خطای 404 می‌دادن.
// ============================================

const m1 = require('./m1.js');

// این سه خط باعث میشه مسیرهای هر فایل روی همون app مشترک ثبت بشن
require('./m2.js');
require('./m3.js');
require('./m4.js');

const { server, PORT, SHARD_COUNT, ADMIN_EMAIL } = m1;
const os = require('os');
const numCPUs = os.cpus().length;

server.listen(PORT, '0.0.0.0', () => {
    console.log('═'.repeat(60));
    console.log('🚀 ULTIMATE SOCIAL MEDIA ENGINE');
    console.log('═'.repeat(60));
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`💾 ${SHARD_COUNT} Shards`);
    console.log(`⚡ ${numCPUs} CPU Cores`);
    console.log(`🔐 AES-256-GCM Encryption`);
    console.log(`📦 2GB Max Payload Size`);
    console.log(`👑 Admin: ${ADMIN_EMAIL}`);
    console.log('═'.repeat(60));
});

// جلوگیری از کرش کامل سرور در صورت بروز خطای پیش‌بینی‌نشده
process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});
