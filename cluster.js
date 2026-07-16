// cluster.js - نسخه نهایی با ۵۰ کارگر
const cluster = require('cluster');
const os = require('os');
const path = require('path');

const numCPUs = os.cpus().length;
const isDevelopment = process.env.NODE_ENV === 'development';

if (cluster.isMaster) {
    console.log(`🚀 Master process ${process.pid} is running`);
    console.log(`📊 Available CPUs: ${numCPUs}`);

    // ============================================
    // ۵۰ کارگر برای پشتیبانی از بار سنگین
    // ============================================
    const workerCount = isDevelopment ? 1 : Math.min(numCPUs * 2, 50);
    console.log(`👷 Starting ${workerCount} worker(s)`);

    for (let i = 0; i < workerCount; i++) {
        const worker = cluster.fork();
        worker.on('exit', (code, signal) => {
            console.log(`⚠️ Worker ${worker.process.pid} died with code ${code}`);
            if (!isDevelopment) { console.log('🔄 Restarting worker...'); cluster.fork(); }
        });
        worker.on('message', (msg) => {
            if (msg.type === 'stats') { console.log(`📊 Worker ${worker.process.pid}: ${msg.data}`); }
        });
    }

    setInterval(() => {
        const workers = Object.values(cluster.workers || {});
        console.log(`📊 Workers: ${workers.length} active`);
        for (const worker of workers) {
            if (worker.isConnected()) { worker.send({ type: 'getStats' }); }
        }
    }, 30000);

    process.on('SIGINT', () => {
        console.log('🛑 Shutting down gracefully...');
        for (const id in cluster.workers) {
            const worker = cluster.workers[id];
            if (worker) { worker.kill(); }
        }
        process.exit(0);
    });

} else {
    console.log(`👷 Worker ${process.pid} started`);
    require('./server');

    setInterval(() => {
        if (process.send) {
            process.send({ type: 'stats', data: { pid: process.pid, memory: process.memoryUsage(), uptime: process.uptime() } });
        }
    }, 10000);

    process.on('message', (msg) => {
        if (msg.type === 'getStats' && process.send) {
            process.send({ type: 'stats', data: { pid: process.pid, memory: process.memoryUsage(), uptime: process.uptime() } });
        }
    });
}