// ============================================
// ⚡ CACHE & PERFORMANCE MONITOR
// ============================================

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

class CacheService {
    constructor() {
        this.cache = new Map();
        this.hits = 0;
        this.misses = 0;
        this.maxSize = 100000;
        this.defaultTTL = 5 * 60 * 1000;
        this.stats = {
            sets: 0,
            deletes: 0,
            hits: 0,
            misses: 0,
            evictions: 0
        };
        this.prefetchQueue = [];
        this.prefetchInterval = null;
        this.backupInterval = null;
    }

    // ===== CACHE OPERATIONS =====
    set(key, value, ttl = this.defaultTTL) {
        if (this.cache.size >= this.maxSize) {
            this.evictLRU();
        }

        const expires = Date.now() + ttl;
        this.cache.set(key, {
            value,
            expires,
            accessed: Date.now(),
            hits: 0,
            size: this.calculateSize(value)
        });

        this.stats.sets++;
        return true;
    }

    get(key, refresh = false) {
        const entry = this.cache.get(key);
        if (!entry) {
            this.stats.misses++;
            return null;
        }

        if (Date.now() > entry.expires) {
            this.cache.delete(key);
            this.stats.misses++;
            return null;
        }

        entry.accessed = Date.now();
        entry.hits++;
        this.stats.hits++;

        if (refresh && entry.hits % 10 === 0) {
            entry.expires = Date.now() + this.defaultTTL;
        }

        return entry.value;
    }

    async getOrSet(key, fetchFn, ttl = this.defaultTTL) {
        const cached = this.get(key);
        if (cached !== null) {
            return cached;
        }

        const value = await fetchFn();
        if (value !== null && value !== undefined) {
            this.set(key, value, ttl);
        }
        return value;
    }

    delete(key) {
        const deleted = this.cache.delete(key);
        if (deleted) this.stats.deletes++;
        return deleted;
    }

    clear() {
        this.cache.clear();
        this.stats.sets = 0;
        this.stats.deletes = 0;
    }

    has(key) {
        const entry = this.cache.get(key);
        if (!entry) return false;
        if (Date.now() > entry.expires) {
            this.cache.delete(key);
            return false;
        }
        return true;
    }

    // ===== CACHE SIZE =====
    calculateSize(value) {
        if (typeof value === 'string') return value.length * 2;
        if (typeof value === 'number') return 8;
        if (typeof value === 'boolean') return 4;
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value).length * 2;
            } catch {
                return 1024;
            }
        }
        return 1024;
    }

    getTotalSize() {
        let total = 0;
        for (const [key, entry] of this.cache) {
            total += entry.size || 0;
        }
        return total;
    }

    // ===== EVICTION STRATEGIES =====
    evictLRU() {
        let oldest = null;
        let oldestTime = Infinity;

        for (const [key, entry] of this.cache) {
            if (entry.accessed < oldestTime) {
                oldestTime = entry.accessed;
                oldest = key;
            }
        }

        if (oldest) {
            this.cache.delete(oldest);
            this.stats.evictions++;
        }
    }

    evictByPolicy(policy = 'lru') {
        switch (policy) {
            case 'lru':
                this.evictLRU();
                break;
            case 'fifo':
                const firstKey = this.cache.keys().next().value;
                if (firstKey) {
                    this.cache.delete(firstKey);
                    this.stats.evictions++;
                }
                break;
            case 'ttl':
                const now = Date.now();
                for (const [key, entry] of this.cache) {
                    if (now > entry.expires) {
                        this.cache.delete(key);
                        this.stats.evictions++;
                    }
                }
                break;
            case 'size':
                let maxSize = 0;
                let maxKey = null;
                for (const [key, entry] of this.cache) {
                    if (entry.size > maxSize) {
                        maxSize = entry.size;
                        maxKey = key;
                    }
                }
                if (maxKey) {
                    this.cache.delete(maxKey);
                    this.stats.evictions++;
                }
                break;
            default:
                this.evictLRU();
        }
    }

    // ===== PREFETCH =====
    prefetch(key, fetchFn, ttl = this.defaultTTL) {
        this.prefetchQueue.push({ key, fetchFn, ttl });
        this.processPrefetchQueue();
    }

    async processPrefetchQueue() {
        if (this.prefetchQueue.length === 0) return;

        const tasks = this.prefetchQueue.splice(0, 5);
        for (const task of tasks) {
            if (!this.cache.has(task.key)) {
                try {
                    const value = await task.fetchFn();
                    if (value !== null && value !== undefined) {
                        this.set(task.key, value, task.ttl);
                    }
                } catch (error) {
                    console.error('Prefetch error:', error);
                }
            }
        }
    }

    startPrefetchScheduler(interval = 10000) {
        if (this.prefetchInterval) {
            clearInterval(this.prefetchInterval);
        }
        this.prefetchInterval = setInterval(() => this.processPrefetchQueue(), interval);
    }

    stopPrefetchScheduler() {
        if (this.prefetchInterval) {
            clearInterval(this.prefetchInterval);
            this.prefetchInterval = null;
        }
    }

    // ===== CACHE STATISTICS =====
    getStats() {
        return {
            ...this.stats,
            size: this.cache.size,
            maxSize: this.maxSize,
            totalSize: this.getTotalSize(),
            hitRate: this.hits + this.misses > 0 ? 
                (this.hits / (this.hits + this.misses) * 100).toFixed(2) + '%' : '0%',
            prefetchQueue: this.prefetchQueue.length,
            keys: Array.from(this.cache.keys()).slice(0, 100)
        };
    }

    // ===== CACHE KEYS =====
    generateKey(...parts) {
        const str = parts.join(':');
        return crypto.createHash('md5').update(str).digest('hex');
    }

    generateUserKey(userId, ...parts) {
        return this.generateKey('user', userId, ...parts);
    }

    generatePostKey(postId, ...parts) {
        return this.generateKey('post', postId, ...parts);
    }

    // ===== PERSISTENCE =====
    saveToFile(filePath = './cache.json') {
        try {
            const data = {
                cache: Array.from(this.cache.entries()).map(([key, entry]) => [
                    key,
                    { ...entry, value: entry.value }
                ]),
                stats: this.stats,
                savedAt: new Date().toISOString()
            };
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    loadFromFile(filePath = './cache.json') {
        try {
            if (!fs.existsSync(filePath)) {
                return { success: false, error: 'فایل یافت نشد' };
            }

            const data = JSON.parse(fs.readFileSync(filePath));
            this.cache = new Map(data.cache);
            this.stats = data.stats;
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    startBackupScheduler(interval = 300000) {
        if (this.backupInterval) {
            clearInterval(this.backupInterval);
        }
        this.backupInterval = setInterval(() => {
            this.saveToFile(`./cache_${Date.now()}.json`);
        }, interval);
    }

    stopBackupScheduler() {
        if (this.backupInterval) {
            clearInterval(this.backupInterval);
            this.backupInterval = null;
        }
    }

    // ===== CLEANUP =====
    cleanup() {
        const now = Date.now();
        const expired = [];

        for (const [key, entry] of this.cache) {
            if (now > entry.expires) {
                expired.push(key);
            }
        }

        for (const key of expired) {
            this.cache.delete(key);
            this.stats.evictions++;
        }

        return expired.length;
    }

    startCleanupScheduler(interval = 60000) {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.cleanupInterval = setInterval(() => this.cleanup(), interval);
    }

    stopCleanupScheduler() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}

// ============================================
// 📊 PERFORMANCE MONITOR
// ============================================
class PerformanceMonitor {
    constructor() {
        this.metrics = {
            requests: [],
            memory: [],
            cpu: [],
            network: []
        };
        this.maxHistory = 10000;
        this.startTime = Date.now();
        this.alertThresholds = {
            cpu: 80,
            memory: 80,
            responseTime: 5000
        };
        this.alerts = [];
    }

    recordRequest(duration, status, path = null) {
        this.metrics.requests.push({
            duration,
            status,
            path,
            timestamp: Date.now()
        });

        if (this.metrics.requests.length > this.maxHistory) {
            this.metrics.requests = this.metrics.requests.slice(-this.maxHistory);
        }

        // Check for slow requests
        if (duration > this.alertThresholds.responseTime) {
            this.addAlert('slow_request', `درخواست کند: ${duration}ms`, { path, duration });
        }
    }

    recordMemory() {
        const usage = process.memoryUsage();
        this.metrics.memory.push({
            ...usage,
            timestamp: Date.now()
        });

        if (this.metrics.memory.length > this.maxHistory) {
            this.metrics.memory = this.metrics.memory.slice(-this.maxHistory);
        }

        // Check memory usage
        const heapUsedPercent = (usage.heapUsed / usage.heapTotal) * 100;
        if (heapUsedPercent > this.alertThresholds.memory) {
            this.addAlert('high_memory', `حافظه بالا: ${heapUsedPercent.toFixed(1)}%`, { heapUsed: usage.heapUsed });
        }
    }

    recordCPU() {
        const usage = process.cpuUsage();
        this.metrics.cpu.push({
            ...usage,
            timestamp: Date.now()
        });

        if (this.metrics.cpu.length > this.maxHistory) {
            this.metrics.cpu = this.metrics.cpu.slice(-this.maxHistory);
        }
    }

    recordNetwork(bytesIn, bytesOut) {
        this.metrics.network.push({
            bytesIn,
            bytesOut,
            timestamp: Date.now()
        });

        if (this.metrics.network.length > this.maxHistory) {
            this.metrics.network = this.metrics.network.slice(-this.maxHistory);
        }
    }

    // ===== ALERTS =====
    addAlert(type, message, data = {}) {
        this.alerts.push({
            id: `alert_${Date.now()}`,
            type,
            message,
            data,
            timestamp: new Date().toISOString(),
            resolved: false
        });

        if (this.alerts.length > 1000) {
            this.alerts = this.alerts.slice(-1000);
        }
    }

    resolveAlert(alertId) {
        const alert = this.alerts.find(a => a.id === alertId);
        if (alert) {
            alert.resolved = true;
            alert.resolvedAt = new Date().toISOString();
            return true;
        }
        return false;
    }

    // ===== STATISTICS =====
    getStats() {
        const now = Date.now();
        const uptime = (now - this.startTime) / 1000;

        // Request stats
        const recentRequests = this.metrics.requests.filter(r => now - r.timestamp < 60000);
        const avgResponse = recentRequests.length > 0 ?
            recentRequests.reduce((sum, r) => sum + r.duration, 0) / recentRequests.length :
            0;

        const errors = recentRequests.filter(r => r.status >= 400).length;
        const errorRate = recentRequests.length > 0 ?
            (errors / recentRequests.length * 100) :
            0;

        // Memory stats
        const memory = process.memoryUsage();
        const memoryPercent = (memory.heapUsed / memory.heapTotal) * 100;

        // CPU stats
        const cpu = process.cpuUsage();
        const cpuTotal = cpu.user + cpu.system;

        return {
            uptime: uptime,
            requests: {
                total: this.metrics.requests.length,
                recent: recentRequests.length,
                avgResponse: avgResponse.toFixed(2) + 'ms',
                errorRate: errorRate.toFixed(2) + '%'
            },
            memory: {
                ...memory,
                percent: memoryPercent.toFixed(1) + '%'
            },
            cpu: {
                user: cpu.user,
                system: cpu.system,
                total: cpuTotal
            },
            alerts: {
                active: this.alerts.filter(a => !a.resolved).length,
                total: this.alerts.length
            },
            timestamp: new Date().toISOString()
        };
    }

    // ===== COLLECTORS =====
    startCollectors(interval = 10000) {
        if (this.collectorInterval) {
            clearInterval(this.collectorInterval);
        }
        this.collectorInterval = setInterval(() => {
            this.recordMemory();
            this.recordCPU();
        }, interval);
    }

    stopCollectors() {
        if (this.collectorInterval) {
            clearInterval(this.collectorInterval);
            this.collectorInterval = null;
        }
    }

    // ===== NETWORK MONITOR =====
    getNetworkStats() {
        const now = Date.now();
        const recent = this.metrics.network.filter(n => now - n.timestamp < 60000);
        const totalIn = recent.reduce((sum, n) => sum + n.bytesIn, 0);
        const totalOut = recent.reduce((sum, n) => sum + n.bytesOut, 0);

        return {
            totalIn: totalIn,
            totalOut: totalOut,
            totalInMB: (totalIn / 1024 / 1024).toFixed(2),
            totalOutMB: (totalOut / 1024 / 1024).toFixed(2),
            recentCount: recent.length
        };
    }

    // ===== SYSTEM INFO =====
    getSystemInfo() {
        return {
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            pid: process.pid,
            cpus: os.cpus().length,
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
            hostname: os.hostname(),
            uptime: os.uptime()
        };
    }

    // ===== HEALTH CHECK =====
    checkHealth() {
        const stats = this.getStats();
        const issues = [];

        if (stats.memory.percent > 90) {
            issues.push('حافظه بالای 90%');
        }

        if (stats.requests.errorRate > 10) {
            issues.push('نرخ خطا بالای 10%');
        }

        if (stats.requests.avgResponse > 3000) {
            issues.push('زمان پاسخ بالای 3 ثانیه');
        }

        return {
            healthy: issues.length === 0,
            issues: issues,
            stats: stats,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = {
    cache: new CacheService(),
    performance: new PerformanceMonitor()
};
