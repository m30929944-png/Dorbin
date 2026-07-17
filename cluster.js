// ============================================
// cluster.js - اجرای سرور با کلاستر برای پشتیبانی از میلیون‌ها کاربر
// ============================================
const cluster = require('cluster');
const os = require('os');
const path = require('path');

// تعداد هسته‌های CPU
const numCPUs = os.cpus().length;

// پرچم برای اجرا در محیط توسعه
const isDevelopment = process.env.NODE_ENV === 'development';

if (cluster.isMaster) {
    console.log(`🚀 Master process ${process.pid} is running`);
    console.log(`📊 Available CPUs: ${numCPUs}`);
    
    // تعداد کارگرها - در توسعه ۱ کارگر، در تولید تا ۵۰ کارگر (با WORKER_COUNT قابل تغییره)
    // نکته: اگه تعداد CPU واقعی سرور کمتر از ۵۰ باشه، کارگرهای اضافی روی همون هسته‌ها زمان‌بندی می‌شن
    // (context-switch بیشتر ولی هر worker سبک و I/O-bound هست، پس معمولاً مشکلی پیش نمیاد).
    // برای تنظیم دقیق‌تر روی سرور خودت: WORKER_COUNT=<عدد دلخواه> npm start
    const workerCount = isDevelopment ? 1 : Math.max(1, parseInt(process.env.WORKER_COUNT || '50', 10));
    console.log(`👷 Starting ${workerCount} worker(s)`);

    // ایجاد کارگرها
    for (let i = 0; i < workerCount; i++) {
        const worker = cluster.fork();
        
        worker.on('exit', (code, signal) => {
            console.log(`⚠️ Worker ${worker.process.pid} died with code ${code}`);
            if (!isDevelopment) {
                console.log('🔄 Restarting worker...');
                cluster.fork();
            }
        });
        
        worker.on('message', (msg) => {
            if (msg.type === 'stats') {
                console.log(`📊 Worker ${worker.process.pid}: ${msg.data}`);
            }
        });
    }

    // نمایش آمار هر 30 ثانیه
    setInterval(() => {
        const workers = Object.values(cluster.workers || {});
        console.log(`📊 Workers: ${workers.length} active`);
        for (const worker of workers) {
            if (worker.isConnected()) {
                worker.send({ type: 'getStats' });
            }
        }
    }, 30000);

    // مدیریت خروج
    process.on('SIGINT', () => {
        console.log('🛑 Shutting down gracefully...');
        for (const id in cluster.workers) {
            const worker = cluster.workers[id];
            if (worker) {
                worker.kill();
            }
        }
        process.exit(0);
    });

} else {
    // ============================================
    // کد کارگر - هر کارگر یک سرور اجرا می‌کند
    // ============================================
    console.log(`👷 Worker ${process.pid} started`);
    
    // بارگذاری سرور
    require('./server');
    
    // ارسال آمار به master
    setInterval(() => {
        if (process.send) {
            process.send({
                type: 'stats',
                data: {
                    pid: process.pid,
                    memory: process.memoryUsage(),
                    uptime: process.uptime()
                }
            });
        }
    }, 10000);

    // مدیریت پیام‌های master
    process.on('message', (msg) => {
        if (msg.type === 'getStats') {
            if (process.send) {
                process.send({
                    type: 'stats',
                    data: {
                        pid: process.pid,
                        memory: process.memoryUsage(),
                        uptime: process.uptime()
                    }
                });
            }
        }
    });
}