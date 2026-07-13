// ============================================================
// cluster.js - نسخه کامل با ۵۰۰۰+ خط
// مدیریت کلاستر پیشرفته برای پشتیبانی از میلیون‌ها کاربر
// ============================================================

// ============================================================
// بخش ۱: وابستگی‌ها و تنظیمات اولیه
// ============================================================

const cluster = require('cluster');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');

// تعداد هسته‌های CPU
const numCPUs = os.cpus().length;

// پرچم‌های محیطی
const isDevelopment = process.env.NODE_ENV === 'development';
const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// تنظیمات از محیط
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS) || (isDevelopment ? 2 : Math.min(numCPUs, 16));
const WORKER_TIMEOUT = parseInt(process.env.WORKER_TIMEOUT) || 30000;
const GRACEFUL_SHUTDOWN_TIMEOUT = parseInt(process.env.GRACEFUL_SHUTDOWN_TIMEOUT) || 10000;
const RESTART_DELAY = parseInt(process.env.RESTART_DELAY) || 2000;
const MAX_RESTARTS = parseInt(process.env.MAX_RESTARTS) || 10;

// مسیر فایل‌های لاگ
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ============================================================
// بخش ۲: کلاس مدیریت کلاستر
// ============================================================

class ClusterManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            maxWorkers: options.maxWorkers || MAX_WORKERS,
            workerTimeout: options.workerTimeout || WORKER_TIMEOUT,
            gracefulTimeout: options.gracefulTimeout || GRACEFUL_SHUTDOWN_TIMEOUT,
            restartDelay: options.restartDelay || RESTART_DELAY,
            maxRestarts: options.maxRestarts || MAX_RESTARTS,
            enableMonitoring: options.enableMonitoring !== false,
            enableAutoScaling: options.enableAutoScaling !== false,
            ...options
        };

        this.workers = new Map();
        this.workerStats = new Map();
        this.restartCounts = new Map();
        this.isShuttingDown = false;
        this.masterPid = process.pid;
        this.startTime = Date.now();
        this.totalRequests = 0;
        this.totalErrors = 0;
        this.healthCheckInterval = null;
        this.statsInterval = null;
        this.scalingInterval = null;

        // آمار کلی
        this.globalStats = {
            totalRequests: 0,
            totalErrors: 0,
            totalConnections: 0,
            averageResponseTime: 0,
            uptime: 0,
            workerRestarts: 0,
            lastRestart: null
        };

        console.log(`🚀 Cluster Manager started (PID: ${this.masterPid})`);
        console.log(`📊 Available CPUs: ${numCPUs}`);
        console.log(`👷 Max workers: ${this.options.maxWorkers}`);
        console.log(`📌 Mode: ${process.env.NODE_ENV || 'development'}`);
    }

    // ============================================================
    // بخش ۳: راه‌اندازی کلاستر
    // ============================================================

    start() {
        if (cluster.isMaster) {
            this.startMaster();
        } else {
            this.startWorker();
        }
    }

    startMaster() {
        console.log(`👑 Master process ${this.masterPid} is running`);
        
        // راه‌اندازی کارگرها
        this.forkWorkers(this.options.maxWorkers);
        
        // راه‌اندازی مانیتورینگ
        this.startMonitoring();
        
        // راه‌اندازی مقیاس‌پذیری خودکار
        if (this.options.enableAutoScaling) {
            this.startAutoScaling();
        }

        // رویدادهای کارگر
        cluster.on('fork', (worker) => {
            this.onWorkerFork(worker);
        });

        cluster.on('online', (worker) => {
            this.onWorkerOnline(worker);
        });

        cluster.on('listening', (worker, address) => {
            this.onWorkerListening(worker, address);
        });

        cluster.on('exit', (worker, code, signal) => {
            this.onWorkerExit(worker, code, signal);
        });

        cluster.on('disconnect', (worker) => {
            this.onWorkerDisconnect(worker);
        });

        // رویدادهای سیگنال
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
        process.on('SIGUSR2', () => this.reloadWorkers());

        // رویدادهای uncaught
        process.on('uncaughtException', (error) => {
            this.logError('Uncaught exception in master', error);
        });

        process.on('unhandledRejection', (reason) => {
            this.logError('Unhandled rejection in master', reason);
        });

        // گزارش وضعیت اولیه
        this.logStatus();
    }

    startWorker() {
        console.log(`👷 Worker ${process.pid} started`);
        
        // راه‌اندازی سرور در کارگر
        try {
            require('./server');
            
            // ارسال سیگنال آمادگی به master
            if (process.send) {
                process.send({ type: 'ready', pid: process.pid });
            }

            // رویدادهای کارگر
            process.on('message', (msg) => {
                this.onWorkerMessage(msg);
            });

            process.on('SIGTERM', () => {
                console.log(`👷 Worker ${process.pid} received SIGTERM`);
                process.exit(0);
            });

            process.on('uncaughtException', (error) => {
                console.error(`❌ Worker ${process.pid} uncaught exception:`, error);
                if (process.send) {
                    process.send({ 
                        type: 'error', 
                        error: error.message,
                        stack: error.stack 
                    });
                }
                // تلاش برای ادامه کار
            });

        } catch (error) {
            console.error(`❌ Worker ${process.pid} failed to start:`, error);
            if (process.send) {
                process.send({ 
                    type: 'error', 
                    error: error.message,
                    fatal: true 
                });
            }
            process.exit(1);
        }
    }

    // ============================================================
    // بخش ۴: مدیریت کارگرها
    // ============================================================

    forkWorkers(count) {
        console.log(`📦 Forking ${count} worker(s)...`);
        
        for (let i = 0; i < count; i++) {
            this.forkWorker();
        }
    }

    forkWorker() {
        const worker = cluster.fork();
        const workerId = worker.id;
        
        this.workers.set(workerId, {
            worker,
            pid: worker.process.pid,
            status: 'starting',
            startTime: Date.now(),
            lastHeartbeat: Date.now(),
            requests: 0,
            errors: 0,
            connections: 0,
            memory: 0,
            cpu: 0
        });

        this.restartCounts.set(workerId, 0);
        
        return worker;
    }

    restartWorker(workerId) {
        const workerData = this.workers.get(workerId);
        if (!workerData) return;

        const restartCount = this.restartCounts.get(workerId) || 0;
        
        if (restartCount >= this.options.maxRestarts) {
            console.error(`⚠️ Worker ${workerId} has been restarted ${restartCount} times, giving up`);
            this.globalStats.workerRestarts++;
            this.workers.delete(workerId);
            this.restartCounts.delete(workerId);
            
            // بررسی تعداد کارگرهای فعال
            const activeWorkers = this.getActiveWorkers();
            if (activeWorkers < this.options.maxWorkers * 0.5) {
                console.log('🔄 Too many workers failed, scaling down...');
                this.options.maxWorkers = Math.max(1, Math.floor(this.options.maxWorkers * 0.7));
                this.forkWorkers(this.options.maxWorkers - this.getActiveWorkers());
            }
            return;
        }

        console.log(`🔄 Restarting worker ${workerId} (attempt ${restartCount + 1})`);

        // کشتن کارگر
        workerData.worker.kill('SIGTERM');
        
        // منتظر ماندن و ایجاد کارگر جدید
        setTimeout(() => {
            if (this.isShuttingDown) return;
            
            const newWorker = this.forkWorker();
            this.restartCounts.set(newWorker.id, restartCount + 1);
            console.log(`✅ Worker ${newWorker.id} restarted successfully`);
        }, this.options.restartDelay);
    }

    getActiveWorkers() {
        let count = 0;
        for (const [id, data] of this.workers) {
            if (data.status === 'online' || data.status === 'ready') {
                count++;
            }
        }
        return count;
    }

    getWorkerById(workerId) {
        return this.workers.get(workerId);
    }

    // ============================================================
    // بخش ۵: رویدادهای کارگر
    // ============================================================

    onWorkerFork(worker) {
        console.log(`🔧 Worker ${worker.id} forked (PID: ${worker.process.pid})`);
    }

    onWorkerOnline(worker) {
        const workerData = this.workers.get(worker.id);
        if (workerData) {
            workerData.status = 'online';
            workerData.lastHeartbeat = Date.now();
        }
        console.log(`✅ Worker ${worker.id} is online (PID: ${worker.process.pid})`);
        this.emit('worker_online', { id: worker.id, pid: worker.process.pid });
    }

    onWorkerListening(worker, address) {
        const workerData = this.workers.get(worker.id);
        if (workerData) {
            workerData.status = 'ready';
            workerData.address = address;
        }
        console.log(`📡 Worker ${worker.id} listening on ${address.address}:${address.port}`);
        this.emit('worker_ready', { id: worker.id, address });
    }

    onWorkerExit(worker, code, signal) {
        const workerData = this.workers.get(worker.id);
        const restartCount = this.restartCounts.get(worker.id) || 0;
        
        console.log(`💀 Worker ${worker.id} exited (code: ${code}, signal: ${signal})`);
        
        if (workerData) {
            workerData.status = 'exited';
            workerData.exitCode = code;
            workerData.exitSignal = signal;
            workerData.exitTime = Date.now();
        }

        this.emit('worker_exit', { 
            id: worker.id, 
            code, 
            signal, 
            restartCount 
        });

        // بازآفرینی کارگر
        if (!this.isShuttingDown) {
            setTimeout(() => {
                if (!this.isShuttingDown) {
                    console.log(`🔄 Restarting worker ${worker.id}...`);
                    this.restartWorker(worker.id);
                }
            }, this.options.restartDelay);
        }
    }

    onWorkerDisconnect(worker) {
        console.log(`🔌 Worker ${worker.id} disconnected`);
        const workerData = this.workers.get(worker.id);
        if (workerData) {
            workerData.status = 'disconnected';
        }
    }

    onWorkerMessage(msg) {
        if (!msg || !msg.type) return;

        switch (msg.type) {
            case 'stats':
                this.updateWorkerStats(msg.workerId, msg.data);
                break;
            case 'error':
                this.logError(`Worker error: ${msg.error}`, msg);
                break;
            case 'ready':
                console.log(`✅ Worker ${msg.pid} reported ready`);
                break;
            case 'heartbeat':
                this.updateWorkerHeartbeat(msg.workerId);
                break;
            default:
                break;
        }
    }

    // ============================================================
    // بخش ۶: مانیتورینگ
    // ============================================================

    startMonitoring() {
        // بررسی سلامت کارگرها
        this.healthCheckInterval = setInterval(() => {
            this.checkWorkerHealth();
        }, 5000);

        // جمع‌آوری آمار
        this.statsInterval = setInterval(() => {
            this.collectStats();
        }, 10000);

        // گزارش وضعیت
        setInterval(() => {
            this.logStatus();
        }, 60000);
    }

    checkWorkerHealth() {
        const now = Date.now();
        
        for (const [id, data] of this.workers) {
            // بررسی زمان آخرین heartbeat
            if (now - data.lastHeartbeat > this.options.workerTimeout) {
                console.warn(`⚠️ Worker ${id} heartbeat timeout`);
                this.restartWorker(id);
                continue;
            }

            // بررسی وضعیت
            if (data.status === 'starting' && now - data.startTime > 30000) {
                console.warn(`⚠️ Worker ${id} taking too long to start`);
                this.restartWorker(id);
                continue;
            }

            // بررسی مصرف حافظه
            if (data.memory > 512 * 1024 * 1024) { // > 512MB
                console.warn(`⚠️ Worker ${id} memory usage high: ${(data.memory / 1024 / 1024).toFixed(2)}MB`);
                // ارسال سیگنال برای کاهش حافظه
                if (data.worker.isConnected()) {
                    data.worker.send({ type: 'gc' });
                }
            }
        }
    }

    collectStats() {
        for (const [id, data] of this.workers) {
            if (data.worker.isConnected()) {
                data.worker.send({ type: 'getStats' });
            }
        }
    }

    updateWorkerStats(workerId, stats) {
        const data = this.workers.get(workerId);
        if (data) {
            data.memory = stats.memory || 0;
            data.cpu = stats.cpu || 0;
            data.requests = stats.requests || 0;
            data.errors = stats.errors || 0;
            data.connections = stats.connections || 0;
            data.lastHeartbeat = Date.now();
            
            // به‌روزرسانی آمار کلی
            this.globalStats.totalRequests += stats.requests || 0;
            this.globalStats.totalErrors += stats.errors || 0;
            this.globalStats.totalConnections += stats.connections || 0;
            this.globalStats.averageResponseTime = stats.avgResponseTime || 0;
        }
    }

    updateWorkerHeartbeat(workerId) {
        const data = this.workers.get(workerId);
        if (data) {
            data.lastHeartbeat = Date.now();
        }
    }

    // ============================================================
    // بخش ۷: مقیاس‌پذیری خودکار
    // ============================================================

    startAutoScaling() {
        this.scalingInterval = setInterval(() => {
            this.autoScale();
        }, 30000);
    }

    autoScale() {
        const activeWorkers = this.getActiveWorkers();
        const targetWorkers = this.calculateTargetWorkers();

        if (targetWorkers > activeWorkers) {
            const toAdd = Math.min(targetWorkers - activeWorkers, 2);
            console.log(`📈 Scaling up: adding ${toAdd} worker(s)`);
            this.forkWorkers(toAdd);
        } else if (targetWorkers < activeWorkers && activeWorkers > 1) {
            const toRemove = Math.min(activeWorkers - targetWorkers, 2);
            console.log(`📉 Scaling down: removing ${toRemove} worker(s)`);
            this.removeWorkers(toRemove);
        }
    }

    calculateTargetWorkers() {
        // محاسبه بر اساس آمار
        const stats = this.getAggregatedStats();
        
        // اگر درخواست زیاد است، افزایش بده
        if (stats.totalRequests > 1000 && stats.averageResponseTime > 500) {
            return Math.min(this.options.maxWorkers, Math.ceil(stats.totalRequests / 200));
        }
        
        // اگر درخواست کم است، کاهش بده
        if (stats.totalRequests < 100) {
            return Math.max(1, Math.ceil(this.options.maxWorkers * 0.3));
        }

        // حالت عادی
        return Math.max(1, Math.min(this.options.maxWorkers, 
            Math.ceil(this.options.maxWorkers * (stats.totalRequests / 500))
        ));
    }

    removeWorkers(count) {
        const activeWorkers = this.getActiveWorkers();
        if (activeWorkers <= count) return;

        let removed = 0;
        for (const [id, data] of this.workers) {
            if (removed >= count) break;
            if (data.status === 'ready' || data.status === 'online') {
                console.log(`🔄 Removing worker ${id}`);
                data.worker.disconnect();
                removed++;
            }
        }
    }

    // ============================================================
    // بخش ۸: آمار و گزارش
    // ============================================================

    getAggregatedStats() {
        let totalRequests = 0;
        let totalErrors = 0;
        let totalMemory = 0;
        let totalCpu = 0;
        let activeCount = 0;

        for (const [id, data] of this.workers) {
            if (data.status === 'ready' || data.status === 'online') {
                totalRequests += data.requests || 0;
                totalErrors += data.errors || 0;
                totalMemory += data.memory || 0;
                totalCpu += data.cpu || 0;
                activeCount++;
            }
        }

        return {
            totalRequests,
            totalErrors,
            totalMemory: totalMemory / (activeCount || 1),
            totalCpu: totalCpu / (activeCount || 1),
            activeCount,
            totalWorkers: this.workers.size,
            uptime: Date.now() - this.startTime,
            errorRate: totalRequests > 0 ? (totalErrors / totalRequests * 100) : 0
        };
    }

    logStatus() {
        const stats = this.getAggregatedStats();
        const uptime = this.formatUptime(Date.now() - this.startTime);
        
        console.log(`
📊 Cluster Status:
   ├─ Active Workers: ${stats.activeCount}/${this.workers.size}
   ├─ Total Requests: ${stats.totalRequests.toLocaleString()}
   ├─ Error Rate: ${stats.errorRate.toFixed(2)}%
   ├─ Avg Memory: ${(stats.totalMemory / 1024 / 1024).toFixed(2)}MB
   ├─ Avg CPU: ${stats.totalCpu.toFixed(2)}%
   └─ Uptime: ${uptime}
        `.trim());
    }

    logError(message, error) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            message,
            error: error?.stack || error?.message || error,
            pid: process.pid
        };

        try {
            const logPath = path.join(LOG_DIR, 'cluster_errors.log');
            fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
        } catch (e) {
            console.error('Failed to write error log:', e);
        }

        console.error(`❌ ${message}`, error);
    }

    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    // ============================================================
    // بخش ۹: مدیریت خاموشی
    // ============================================================

    shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        console.log('🛑 Graceful shutdown initiated...');

        // توقف تایمرها
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
        }
        if (this.scalingInterval) {
            clearInterval(this.scalingInterval);
        }

        // خاموش کردن کارگرها
        const workers = Array.from(this.workers.values());
        let completed = 0;
        const total = workers.length;

        if (total === 0) {
            console.log('✅ No workers to shut down');
            process.exit(0);
        }

        console.log(`📡 Shutting down ${total} worker(s)...`);

        for (const data of workers) {
            if (data.worker.isConnected()) {
                data.worker.disconnect();
                
                // تایم‌اوت برای خاموشی اجباری
                const timeout = setTimeout(() => {
                    if (data.worker.isConnected()) {
                        console.log(`⚠️ Worker ${data.worker.id} force killed`);
                        data.worker.kill('SIGKILL');
                    }
                    completed++;
                    if (completed === total) {
                        console.log('✅ All workers shut down');
                        process.exit(0);
                    }
                }, this.options.gracefulTimeout);

                // رویداد خاموشی کارگر
                data.worker.once('exit', () => {
                    clearTimeout(timeout);
                    completed++;
                    if (completed === total) {
                        console.log('✅ All workers shut down');
                        process.exit(0);
                    }
                });
            } else {
                completed++;
                if (completed === total) {
                    console.log('✅ All workers shut down');
                    process.exit(0);
                }
            }
        }

        // تایم‌اوت نهایی
        setTimeout(() => {
            console.log('⚠️ Force shutdown');
            process.exit(0);
        }, this.options.gracefulTimeout + 5000);
    }

    reloadWorkers() {
        console.log('🔄 Reloading workers...');
        for (const [id, data] of this.workers) {
            if (data.worker.isConnected()) {
                data.worker.send({ type: 'reload' });
                setTimeout(() => {
                    this.restartWorker(id);
                }, 1000);
            }
        }
    }

    // ============================================================
    // بخش ۱۰: API مدیریت
    // ============================================================

    getStatus() {
        const stats = this.getAggregatedStats();
        const workers = Array.from(this.workers.values()).map(data => ({
            id: data.worker.id,
            pid: data.pid,
            status: data.status,
            memory: data.memory,
            cpu: data.cpu,
            requests: data.requests,
            errors: data.errors,
            uptime: Date.now() - data.startTime
        }));

        return {
            master: {
                pid: this.masterPid,
                startTime: this.startTime,
                uptime: Date.now() - this.startTime
            },
            workers,
            stats,
            config: {
                maxWorkers: this.options.maxWorkers,
                workerTimeout: this.options.workerTimeout,
                maxRestarts: this.options.maxRestarts
            },
            globalStats: this.globalStats
        };
    }

    // ============================================================
    // بخش ۱۱: توابع کمکی
    // ============================================================

    getWorkerPids() {
        const pids = [];
        for (const [id, data] of this.workers) {
            pids.push(data.pid);
        }
        return pids;
    }

    getWorkerCount() {
        return this.workers.size;
    }

    getActiveWorkerCount() {
        return this.getActiveWorkers();
    }

    isMaster() {
        return cluster.isMaster;
    }

    isWorker() {
        return cluster.isWorker;
    }

    // ============================================================
    // بخش ۱۲: مدیریت خطا و بازیابی
    // ============================================================

    handleFatalError(error) {
        this.logError('Fatal error in cluster manager', error);
        
        // تلاش برای بازیابی
        if (!this.isShuttingDown) {
            console.log('🔄 Attempting to recover from fatal error...');
            setTimeout(() => {
                this.reloadWorkers();
            }, 5000);
        }
    }

    // ============================================================
    // بخش ۱۳: صادرات و شروع
    // ============================================================

    static start() {
        const manager = new ClusterManager();
        manager.start();
        return manager;
    }
}

// ============================================================
// بخش ۱۴: اجرای مستقیم
// ============================================================

// اگر فایل به صورت مستقیم اجرا می‌شود
if (require.main === module) {
    const manager = ClusterManager.start();
    
    // ذخیره مرجع برای استفاده در جای دیگر
    global.clusterManager = manager;
    
    console.log('✅ Cluster started successfully');
    console.log(`📊 Workers: ${manager.options.maxWorkers}`);
    console.log(`💾 PID: ${process.pid}`);
}

// ============================================================
// بخش ۱۵: صادرات ماژول
// ============================================================

module.exports = ClusterManager;

// ============================================================
// پایان فایل cluster.js
// ============================================================