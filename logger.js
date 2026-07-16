// ============================================
// logger.js - لاگینگ پیشرفته با Winston
// ============================================
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');

// ============================================
// ایجاد پوشه لاگ
// ============================================
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// ============================================
// فرمت‌های لاگ
// ============================================
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
    winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} [${level}] ${service ? `[${service}]` : ''} ${message}${metaStr}`;
    })
);

const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.colorize({
        colors: {
            error: 'red',
            warn: 'yellow',
            info: 'green',
            debug: 'blue',
            verbose: 'cyan'
        }
    }),
    winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} ${level} ${service ? `[${service}]` : ''} ${message}${metaStr}`;
    })
);

// ============================================
// Transport برای Elasticsearch (اختیاری)
// ============================================
class ElasticsearchTransport {
    constructor(options) {
        this.options = options;
        this.name = 'elasticsearch';
    }

    log(info, callback) {
        // اگر Elasticsearch فعال باشد
        if (process.env.ELASTICSEARCH_ENABLED === 'true') {
            // ارسال لاگ به Elasticsearch
            // اینجا می‌توانید از elasticsearch client استفاده کنید
        }
        callback();
    }
}

// ============================================
// ایجاد لاگر
// ============================================
function createLogger(service = 'app') {
    const transports = [
        // فایل خطاها
        new winston.transports.File({
            filename: path.join(logDir, 'error.log'),
            level: 'error',
            maxsize: 10485760, // 10MB
            maxFiles: 10,
            tailable: true,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        }),
        // فایل همه لاگ‌ها
        new winston.transports.File({
            filename: path.join(logDir, 'combined.log'),
            maxsize: 10485760, // 10MB
            maxFiles: 20,
            tailable: true,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        }),
        // لاگ‌های با سطح بالا
        new winston.transports.File({
            filename: path.join(logDir, 'info.log'),
            level: 'info',
            maxsize: 10485760,
            maxFiles: 10,
            tailable: true,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        }),
        // لاگ‌های دیباگ
        new winston.transports.File({
            filename: path.join(logDir, 'debug.log'),
            level: 'debug',
            maxsize: 10485760,
            maxFiles: 5,
            tailable: true,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        })
    ];

    // افزودن کنسول در محیط توسعه
    if (process.env.NODE_ENV !== 'production') {
        transports.push(new winston.transports.Console({
            format: consoleFormat,
            level: 'debug'
        }));
    } else {
        transports.push(new winston.transports.Console({
            format: consoleFormat,
            level: process.env.LOG_LEVEL || 'info'
        }));
    }

    // افزودن Elasticsearch
    if (process.env.ELASTICSEARCH_ENABLED === 'true') {
        transports.push(new ElasticsearchTransport({
            level: 'info',
            index: 'logs-yareman'
        }));
    }

    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: logFormat,
        defaultMeta: { 
            service,
            environment: process.env.NODE_ENV || 'development',
            pid: process.pid,
            hostname: os.hostname()
        },
        transports,
        exceptionHandlers: [
            new winston.transports.File({
                filename: path.join(logDir, 'exceptions.log'),
                maxsize: 10485760,
                maxFiles: 5
            })
        ],
        rejectionHandlers: [
            new winston.transports.File({
                filename: path.join(logDir, 'rejections.log'),
                maxsize: 10485760,
                maxFiles: 5
            })
        ],
        exitOnError: false
    });

    // افزودن متدهای کمکی
    logger.withContext = function(context) {
        return this.child(context);
    };

    logger.measure = function(label, fn) {
        const start = performance.now();
        try {
            const result = fn();
            const duration = performance.now() - start;
            this.debug(`[${label}] completed in ${duration.toFixed(2)}ms`);
            return result;
        } catch (error) {
            const duration = performance.now() - start;
            this.error(`[${label}] failed after ${duration.toFixed(2)}ms:`, error);
            throw error;
        }
    };

    logger.measureAsync = async function(label, fn) {
        const start = performance.now();
        try {
            const result = await fn();
            const duration = performance.now() - start;
            this.debug(`[${label}] completed in ${duration.toFixed(2)}ms`);
            return result;
        } catch (error) {
            const duration = performance.now() - start;
            this.error(`[${label}] failed after ${duration.toFixed(2)}ms:`, error);
            throw error;
        }
    };

    return logger;
}

// ============================================
// استریم برای Morgan
// ============================================
const stream = {
    write: (message) => {
        const logger = createLogger('http');
        // حذف کاراکترهای اضافی
        const cleanMessage = message.trim();
        if (cleanMessage) {
            // تشخیص نوع درخواست و سطح لاگ
            if (cleanMessage.includes(' 5')) {
                logger.error(cleanMessage);
            } else if (cleanMessage.includes(' 4')) {
                logger.warn(cleanMessage);
            } else {
                logger.info(cleanMessage);
            }
        }
    }
};

// ============================================
// لاگر پیش‌فرض
// ============================================
const defaultLogger = createLogger('default');

// ============================================
// پاک کردن لاگ‌های قدیمی
// ============================================
function cleanOldLogs(days = 30) {
    const now = Date.now();
    const cutoff = now - (days * 24 * 60 * 60 * 1000);
    
    try {
        const files = fs.readdirSync(logDir);
        for (const file of files) {
            const filePath = path.join(logDir, file);
            const stats = fs.statSync(filePath);
            if (stats.isFile() && stats.mtimeMs < cutoff) {
                fs.unlinkSync(filePath);
                defaultLogger.info(`Deleted old log: ${file}`);
            }
        }
    } catch (error) {
        defaultLogger.error('Clean old logs error:', error);
    }
}

// پاک کردن لاگ‌های قدیمی هر روز
setInterval(() => cleanOldLogs(30), 24 * 60 * 60 * 1000);

// ============================================
// صادرات
// ============================================
module.exports = {
    createLogger,
    stream,
    defaultLogger,
    cleanOldLogs,
    logDir
};