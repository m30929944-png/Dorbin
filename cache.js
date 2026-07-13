// ================================================================
// cache.js - سیستم کش با Redis + fallback محلی
// ================================================================

const NodeCache = require('node-cache');

class CacheManager {
  constructor() {
    this.local = new NodeCache({ stdTTL: 60, checkperiod: 120 });
    this.redis = null;
    this.connected = false;
  }

  async connect() {
    try {
      const redis = require('redis');
      this.redis = redis.createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379'
      });
      await this.redis.connect();
      this.connected = true;
      console.log('✅ Redis connected');
    } catch (e) {
      console.log('⚠️ Redis not available, using local cache');
    }
  }

  async get(key) {
    const local = this.local.get(key);
    if (local !== undefined) return local;
    if (this.connected) {
      try {
        const data = await this.redis.get(key);
        if (data) { const parsed = JSON.parse(data); this.local.set(key, parsed, 10); return parsed; }
      } catch (e) {}
    }
    return null;
  }

  async set(key, value, ttl = 60) {
    this.local.set(key, value, Math.min(ttl, 300));
    if (this.connected) {
      try { await this.redis.set(key, JSON.stringify(value), { EX: ttl }); } catch (e) {}
    }
  }

  async del(key) {
    this.local.del(key);
    if (this.connected) {
      try { await this.redis.del(key); } catch (e) {}
    }
  }

  async delPattern(pattern) {
    if (this.connected) {
      try {
        const keys = await this.redis.keys(pattern);
        if (keys.length) await this.redis.del(keys);
      } catch (e) {}
    }
  }
}

module.exports = new CacheManager();