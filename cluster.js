// ============================================
// cluster.js - اجرای سرور با کلاستر پیشرفته برای پشتیبانی از میلیون‌ها کاربر
// ============================================

const cluster = require('cluster');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ============================================
// تنظیمات کلاستر
// ============================================
const isDevelopment = process.env.NODE_ENV === 'development';
const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// تعداد هسته‌های CPU
const numCPUs = os.cpus().length;

// تعداد کارگرها بر اساس محیط
const getWorkerCount = () => {
    if (isDevelopment) return 1;
    if (isTest) return 1;
    if (isProduction) return Math.min(numCPUs, 8);
    return Math.min(numCPUs, 4);
};

const WORKER_COUNT = getWorkerCount();
const MAX_RESTARTS = 10;
const RESTART_WINDOW = 60000; // 1 دقیقه

// ============================================
// کلاس مدیریت کلاستر
// ============================================
class ClusterManager {
    constructor() {
        this.workers = new Map();
        this.restartCounts = new Map();
        this.startTime = Date.now();
        this.isShuttingDown = false;
        this.masterPid = process.pid;
        this.stats = {
            totalRequests: 0,
            totalErrors: 0,
            workersRestarted: 0,
            workersCrashed: 0,
            startTime: new Date().toISOString()
        };
        
        // بارگذاری تنظیمات
        this.loadConfig();
    }

    // ============================================
    // بارگذاری تنظیمات
    // ============================================
    loadConfig() {
        try {
            const configPath = path.join(__dirname, 'cluster.config.json');
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                this.config = config;
                console.log('✅ Cluster config loaded');
            }
        } catch (error) {
            console.warn('⚠️ No cluster config found, using defaults');
            this.config = {
                workerCount: WORKER_COUNT,
                maxRestarts: MAX_RESTARTS,
                restartWindow: RESTART_WINDOW,
                healthCheckInterval: 5000,
                statsInterval: 30000,
                gracefulShutdownTimeout: 10000
            };
        }
    }

    // ============================================
    // شروع کلاستر
    // ============================================
    start() {
        console.log('=' .repeat(60));
        console.log('🚀 YAREMAN CLUSTER MANAGER');
        console.log('=' .repeat(60));
        console.log(`📊 Process: ${this.masterPid}`);
        console.log(`💻 CPUs: ${numCPUs}`);
        console.log(`👷 Workers: ${this.config.workerCount}`);
        console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log('=' .repeat(60));

        if (cluster.isMaster) {
            this.runMaster();
        } else {
            this.runWorker();
        }
    }

    // ============================================
    // اجرای Master
    // ============================================
    runMaster() {
        console.log(`👑 Master process ${process.pid} is running`);

        // ایجاد کارگرها
        this.forkWorkers();

        // راه‌اندازی سیستم‌های نظارتی
        this.setupHealthCheck();
        this.setupStatsReporting();
        this.setupWorkerMonitoring();
        this.setupSignalHandlers();

        // راه‌اندازی API برای مدیریت
        this.setupManagementAPI();

        // اجرای پشتیبان‌گیری دوره‌ای
        this.setupBackup();

        console.log(`✅ Master initialized with ${this.workers.size} workers`);
    }

    // ============================================
    // اجرای Worker
    // ============================================
    runWorker() {
        console.log(`👷 Worker ${process.pid} started`);

        // تنظیم ارتباط با master
        process.on('message', (msg) => {
            if (msg.type === 'shutdown') {
                this.gracefulShutdown();
            }
            if (msg.type === 'healthCheck') {
                process.send({ type: 'healthResponse', pid: process.pid });
            }
            if (msg.type === 'getStats') {
                process.send({ 
                    type: 'statsResponse', 
                    pid: process.pid,
                    memory: process.memoryUsage(),
                    uptime: process.uptime()
                });
            }
        });

        // بارگذاری و اجرای سرور
        try {
            require('./server');
            console.log(`✅ Worker ${process.pid} server started`);

            // ارسال سیگنال آماده‌بودن به master
            process.send({ 
                type: 'workerReady', 
                pid: process.pid,
                startTime: Date.now()
            });

        } catch (error) {
            console.error(`❌ Worker ${process.pid} failed to start:`, error);
            process.exit(1);
        }

        // مدیریت خطاهای کشنده
        process.on('uncaughtException', (error) => {
            console.error(`❌ Worker ${process.pid} uncaught exception:`, error);
            process.send({ 
                type: 'workerError', 
                pid: process.pid,
                error: error.message,
                stack: error.stack
            });
            setTimeout(() => process.exit(1), 1000);
        });

        process.on('unhandledRejection', (reason) => {
            console.error(`❌ Worker ${process.pid} unhandled rejection:`, reason);
            process.send({ 
                type: 'workerError', 
                pid: process.pid,
                error: reason?.message || 'Unhandled rejection'
            });
        });
    }

    // ============================================
    // ایجاد کارگرها
    // ============================================
    forkWorkers() {
        for (let i = 0; i < this.config.workerCount; i++) {
            this.forkWorker();
        }
    }

    forkWorker() {
        const worker = cluster.fork({
            WORKER_ID: this.workers.size + 1,
            MASTER_PID: this.masterPid
        });

        const workerInfo = {
            id: this.workers.size + 1,
            pid: worker.process.pid,
            startTime: Date.now(),
            status: 'starting',
            restarts: 0,
            lastRestart: null,
            isHealthy: true,
            lastHealthCheck: Date.now()
        };

        this.workers.set(worker.process.pid, {
            worker,
            info: workerInfo
        });

        // رویدادهای کارگر
        worker.on('message', (msg) => {
            this.handleWorkerMessage(worker, msg);
        });

        worker.on('exit', (code, signal) => {
            this.handleWorkerExit(worker, code, signal);
        });

        worker.on('error', (error) => {
            console.error(`⚠️ Worker ${worker.process.pid} error:`, error);
            this.handleWorkerExit(worker, 1, 'error');
        });

        console.log(`✅ Worker ${workerInfo.id} (PID: ${worker.process.pid}) forked`);
        return worker;
    }

    // ============================================
    // مدیریت پیام‌های کارگر
    // ============================================
    handleWorkerMessage(worker, msg) {
        const workerData = this.workers.get(worker.process.pid);
        if (!workerData) return;

        switch (msg.type) {
            case 'workerReady':
                workerData.info.status = 'ready';
                workerData.info.isHealthy = true;
                console.log(`✅ Worker ${workerData.info.id} (PID: ${worker.process.pid}) is ready`);
                break;

            case 'healthResponse':
                workerData.info.lastHealthCheck = Date.now();
                workerData.info.isHealthy = true;
                break;

            case 'statsResponse':
                this.updateWorkerStats(workerData, msg);
                break;

            case 'workerError':
                console.error(`❌ Worker ${workerData.info.id} error:`, msg.error);
                workerData.info.isHealthy = false;
                break;

            default:
                // پیام‌های دیگر را نادیده بگیر
                break;
        }
    }

    // ============================================
    // مدیریت خروج کارگر
    // ============================================
    handleWorkerExit(worker, code, signal) {
        const workerData = this.workers.get(worker.process.pid);
        if (!workerData) return;

        const pid = worker.process.pid;
        const info = workerData.info;

        console.log(`⚠️ Worker ${info.id} (PID: ${pid}) exited with code ${code} (${signal || 'unknown'})`);

        this.stats.workersCrashed++;
        info.status = 'dead';
        info.isHealthy = false;

        // حذف کارگر از لیست
        this.workers.delete(pid);

        // بررسی محدودیت restart
        if (this.isShuttingDown) {
            console.log(`🛑 Not restarting worker ${info.id} during shutdown`);
            return;
        }

        // شمارش تعداد restart در بازه زمانی
        const restartKey = info.id;
        const restarts = this.restartCounts.get(restartKey) || [];
        const now = Date.now();
        const recentRestarts = restarts.filter(t => now - t < this.config.restartWindow);
        
        if (recentRestarts.length >= this.config.maxRestarts) {
            console.error(`❌ Worker ${info.id} has crashed too many times (${recentRestarts.length} times in ${this.config.restartWindow/1000}s)`);
            console.error(`❌ Not restarting worker ${info.id} to prevent crash loop`);
            return;
        }

        // ثبت restart
        recentRestarts.push(now);
        this.restartCounts.set(restartKey, recentRestarts);
        this.stats.workersRestarted++;

        // راه‌اندازی مجدد کارگر
        console.log(`🔄 Restarting worker ${info.id}...`);
        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.forkWorker();
            }
        }, 2000);
    }

    // ============================================
    // بررسی سلامت کارگرها
    // ============================================
    setupHealthCheck() {
        setInterval(() => {
            for (const [pid, data] of this.workers) {
                if (data.info.status === 'ready' && data.worker.isConnected()) {
                    data.worker.send({ type: 'healthCheck' });
                    
                    // اگر بیش از 30 ثانیه از آخرین بررسی گذشته باشد
                    if (Date.now() - data.info.lastHealthCheck > 30000) {
                        console.warn(`⚠️ Worker ${data.info.id} (PID: ${pid}) health check timeout`);
                        data.info.isHealthy = false;
                    }
                }
            }
        }, this.config.healthCheckInterval || 5000);
    }

    // ============================================
    // گزارش آمار
    // ============================================
    setupStatsReporting() {
        setInterval(() => {
            this.reportStats();
        }, this.config.statsInterval || 30000);
    }

    reportStats() {
        const totalWorkers = this.workers.size;
        const readyWorkers = Array.from(this.workers.values())
            .filter(w => w.info.status === 'ready').length;
        const healthyWorkers = Array.from(this.workers.values())
            .filter(w => w.info.isHealthy).length;

        console.log('\n' + '=' .repeat(50));
        console.log(`📊 CLUSTER STATS - ${new Date().toISOString()}`);
        console.log('=' .repeat(50));
        console.log(`👷 Workers: ${totalWorkers} total, ${readyWorkers} ready, ${healthyWorkers} healthy`);
        console.log(`🔄 Restarts: ${this.stats.workersRestarted}`);
        console.log(`💥 Crashes: ${this.stats.workersCrashed}`);
        console.log(`⏱️ Uptime: ${this.getUptime()}`);
        console.log(`📈 Total Requests: ${this.stats.totalRequests}`);
        console.log(`❌ Total Errors: ${this.stats.totalErrors}`);
        console.log('=' .repeat(50) + '\n');

        // ارسال آمار به همه کارگرها
        for (const [pid, data] of this.workers) {
            if (data.worker.isConnected()) {
                data.worker.send({ type: 'getStats' });
            }
        }
    }

    // ============================================
    // نظارت بر کارگرها
    // ============================================
    setupWorkerMonitoring() {
        // مانیتورینگ مصرف حافظه
        setInterval(() => {
            let totalMemory = 0;
            for (const [pid, data] of this.workers) {
                try {
                    const memory = process.memoryUsage();
                    totalMemory += memory.rss;
                } catch (e) {}
            }
            
            const memoryMB = (totalMemory / 1024 / 1024).toFixed(2);
            if (parseFloat(memoryMB) > 1024) {
                console.warn(`⚠️ High memory usage: ${memoryMB} MB`);
            }
        }, 60000);

        // بررسی کارگرهای مرده
        setInterval(() => {
            for (const [pid, data] of this.workers) {
                if (!data.worker.isConnected() && data.info.status !== 'dead') {
                    console.warn(`⚠️ Worker ${data.info.id} (PID: ${pid}) is not responding`);
                    data.worker.kill();
                }
            }
        }, 10000);
    }

    // ============================================
    // مدیریت سیگنال‌ها
    // ============================================
    setupSignalHandlers() {
        // خروج gracefully
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
        process.on('SIGQUIT', () => this.shutdown());

        // گزارش وضعیت
        process.on('SIGUSR1', () => {
            console.log('📊 Current status:');
            this.reportStats();
        });

        // افزایش تعداد کارگرها
        process.on('SIGUSR2', () => {
            console.log('📈 Scaling up workers...');
            const targetCount = this.config.workerCount + 1;
            this.config.workerCount = targetCount;
            this.forkWorker();
            console.log(`✅ Scaled to ${this.workers.size} workers`);
        });
    }

    // ============================================
    // خروج gracefully
    // ============================================
    async shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        console.log('🛑 Shutting down cluster gracefully...');

        // ارسال سیگنال خروج به همه کارگرها
        const shutdownPromises = [];
        for (const [pid, data] of this.workers) {
            if (data.worker.isConnected()) {
                shutdownPromises.push(new Promise((resolve) => {
                    data.worker.send({ type: 'shutdown' });
                    setTimeout(resolve, 2000);
                }));
            }
        }

        // منتظر خروج کارگرها
        await Promise.all(shutdownPromises);

        // کشتن کارگرهای باقی‌مانده
        for (const [pid, data] of this.workers) {
            if (data.worker.isConnected()) {
                data.worker.kill();
            }
        }

        console.log('✅ All workers terminated');
        console.log('👋 Goodbye!');
        process.exit(0);
    }

    // ============================================
    // API مدیریت
    // ============================================
    setupManagementAPI() {
        // این API فقط از طریق process.send قابل دسترسی است
        process.on('message', (msg) => {
            if (msg.type === 'clusterCommand') {
                this.handleClusterCommand(msg.command);
            }
        });
    }

    handleClusterCommand(command) {
        switch (command.action) {
            case 'scale':
                const count = command.count || 1;
                for (let i = 0; i < count; i++) {
                    this.forkWorker();
                }
                console.log(`✅ Scaled to ${this.workers.size} workers`);
                break;
                
            case 'status':
                this.reportStats();
                break;
                
            case 'restart':
                for (const [pid, data] of this.workers) {
                    data.worker.kill();
                }
                setTimeout(() => {
                    this.forkWorkers();
                }, 3000);
                break;
                
            case 'health':
                for (const [pid, data] of this.workers) {
                    if (data.worker.isConnected()) {
                        data.worker.send({ type: 'healthCheck' });
                    }
                }
                break;
                
            default:
                console.log(`❌ Unknown command: ${command.action}`);
        }
    }

    // ============================================
    // پشتیبان‌گیری دوره‌ای
    // ============================================
    setupBackup() {
        setInterval(() => {
            try {
                const backupDir = path.join(__dirname, 'backups');
                if (!fs.existsSync(backupDir)) {
                    fs.mkdirSync(backupDir);
                }
                
                const backupFile = path.join(backupDir, `cluster_state_${Date.now()}.json`);
                const state = {
                    timestamp: new Date().toISOString(),
                    workers: Array.from(this.workers.entries()).map(([pid, data]) => ({
                        pid,
                        id: data.info.id,
                        status: data.info.status,
                        startTime: data.info.startTime,
                        isHealthy: data.info.isHealthy
                    })),
                    stats: this.stats,
                    config: this.config
                };
                
                fs.writeFileSync(backupFile, JSON.stringify(state, null, 2));
                
                // حذف پشتیبان‌های قدیمی (فقط ۵ عدد آخر)
                const backups = fs.readdirSync(backupDir)
                    .filter(f => f.startsWith('cluster_state_'))
                    .sort()
                    .reverse();
                
                for (const file of backups.slice(5)) {
                    fs.unlinkSync(path.join(backupDir, file));
                }
            } catch (error) {
                console.error('Backup error:', error);
            }
        }, 3600000); // هر ساعت
    }

    // ============================================
    // به‌روزرسانی آمار کارگر
    // ============================================
    updateWorkerStats(workerData, msg) {
        if (msg.memory) {
            workerData.info.memory = msg.memory;
        }
        if (msg.uptime) {
            workerData.info.uptime = msg.uptime;
        }
        if (msg.requests) {
            this.stats.totalRequests += msg.requests;
        }
        if (msg.errors) {
            this.stats.totalErrors += msg.errors;
        }
    }

    // ============================================
    // محاسبه زمان اجرا
    // ============================================
    getUptime() {
        const uptime = Date.now() - this.startTime;
        const seconds = Math.floor(uptime / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    // ============================================
    // gracefulShutdown برای کارگر
    // ============================================
    gracefulShutdown() {
        console.log(`🛑 Worker ${process.pid} shutting down gracefully...`);
        // این تابع توسط کارگر اجرا می‌شود
        // می‌تواند برای بستن اتصالات دیتابیس و... استفاده شود
        setTimeout(() => {
            process.exit(0);
        }, 5000);
    }
}

// ============================================
// راه‌اندازی کلاستر
// ============================================
const manager = new ClusterManager();
manager.start();

// ============================================
// صادرات برای استفاده در سایر ماژول‌ها
// ============================================
module.exports = { ClusterManager, manager };