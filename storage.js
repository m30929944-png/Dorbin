// ============================================
// storage.js - فضای ابری پیشرفته با AWS S3 و Cloudinary
// ============================================
const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { createLogger } = require('./logger');
const { v4: uuidv4 } = require('uuid');

const logger = createLogger('storage');

// ============================================
// تنظیمات
// ============================================
const STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || 's3'; // s3, cloudinary, local, minio
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || 'yareman-uploads';
const REGION = process.env.AWS_REGION || 'us-east-1';
const CDN_DOMAIN = process.env.CDN_DOMAIN || '';
const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '536870912', 10); // 512MB
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '5242880', 10); // 5MB

// ============================================
// کش URL
// ============================================
const urlCache = new Map();
const URL_CACHE_TTL = 3600000; // 1 ساعت

// ============================================
// S3 Client با تنظیمات پیشرفته
// ============================================
const s3Config = {
    region: REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    },
    endpoint: process.env.AWS_ENDPOINT || undefined,
    forcePathStyle: !!process.env.AWS_ENDPOINT,
    maxAttempts: 3,
    retryMode: 'adaptive',
    requestTimeout: 30000,
    connectionTimeout: 10000,
    socketTimeout: 30000
};

const s3Client = new S3Client(s3Config);

// ============================================
// سازگاری با Cloudinary
// ============================================
let cloudinary;
if (STORAGE_PROVIDER === 'cloudinary') {
    cloudinary = require('cloudinary').v2;
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
    logger.info('✅ Cloudinary configured');
}

// ============================================
// تولید کلید فایل با ساختار سازمان‌یافته
// ============================================
function generateFileKey(userId, folder, format, options = {}) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const timestamp = Date.now();
    const random = crypto.randomBytes(16).toString('hex');
    const id = options.id || random;
    
    return `users/${userId}/${folder}/${year}/${month}/${day}/${timestamp}_${id}.${format}`;
}

// ============================================
// آپلود به S3 با Multipart Upload
// ============================================
async function uploadToCloud(filePath, userId, folder, format, options = {}) {
    const startTime = performance.now();
    const key = generateFileKey(userId, folder, format, options);
    const fileStream = fs.createReadStream(filePath);
    const fileStats = fs.statSync(filePath);

    try {
        if (fileStats.size > MAX_UPLOAD_SIZE) {
            throw new Error(`File size ${fileStats.size} exceeds maximum ${MAX_UPLOAD_SIZE}`);
        }

        // برای Cloudinary
        if (STORAGE_PROVIDER === 'cloudinary' && cloudinary) {
            const result = await new Promise((resolve, reject) => {
                cloudinary.uploader.upload(filePath, {
                    folder: `users/${userId}/${folder}`,
                    public_id: key.replace(/\.[^.]+$/, ''),
                    format: format,
                    resource_type: folder === 'videos' ? 'video' : 'image',
                    transformation: folder === 'videos' ? [
                        { quality: 'auto', fetch_format: 'auto' }
                    ] : [
                        { quality: 'auto:best', fetch_format: 'auto', crop: 'limit' }
                    ]
                }, (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                });
            });

            const url = result.secure_url || result.url;
            
            logger.info(`File uploaded to Cloudinary: ${key} (${fileStats.size} bytes) in ${(performance.now() - startTime).toFixed(2)}ms`);

            return {
                url,
                key: result.public_id,
                size: fileStats.size,
                provider: 'cloudinary',
                format: format,
                duration: performance.now() - startTime
            };
        }

        // برای S3/Minio
        const upload = new Upload({
            client: s3Client,
            params: {
                Bucket: BUCKET_NAME,
                Key: key,
                Body: fileStream,
                ContentType: options.contentType || `application/octet-stream`,
                CacheControl: options.cacheControl || 'public, max-age=31536000, immutable',
                ContentDisposition: options.contentDisposition || 'inline',
                StorageClass: options.storageClass || 'STANDARD',
                Metadata: {
                    'user-id': userId,
                    'uploaded-at': new Date().toISOString(),
                    'original-name': options.originalName || '',
                    'x-amz-meta-user-id': userId
                }
            },
            queueSize: 4,
            partSize: CHUNK_SIZE,
            leavePartsOnError: false,
            concurrency: 4
        });

        const result = await upload.done();

        // تولید URL
        let url;
        if (CDN_DOMAIN) {
            url = `https://${CDN_DOMAIN}/${key}`;
        } else if (process.env.AWS_ENDPOINT) {
            url = `${process.env.AWS_ENDPOINT}/${BUCKET_NAME}/${key}`;
        } else {
            url = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${key}`;
        }

        // اعمال URL signing برای فایل‌های خصوصی
        if (options.public === false) {
            const command = new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: key,
                ACL: 'private'
            });
            await s3Client.send(command);
        }

        const duration = performance.now() - startTime;
        logger.info(`File uploaded to S3: ${key} (${fileStats.size} bytes) in ${duration.toFixed(2)}ms`);

        // ذخیره در کش URL
        urlCache.set(key, {
            url,
            timestamp: Date.now(),
            expires: options.expires || Date.now() + URL_CACHE_TTL
        });

        return {
            url,
            key,
            size: fileStats.size,
            bucket: BUCKET_NAME,
            provider: 's3',
            format: format,
            eTag: result.ETag,
            duration: duration
        };

    } catch (error) {
        logger.error('Upload to cloud failed:', error);
        throw error;
    }
}

// ============================================
// آپلود با استریم (برای فایل‌های بزرگ)
// ============================================
async function uploadStream(readStream, userId, folder, format, options = {}) {
    const key = generateFileKey(userId, folder, format, options);
    
    try {
        const upload = new Upload({
            client: s3Client,
            params: {
                Bucket: BUCKET_NAME,
                Key: key,
                Body: readStream,
                ContentType: options.contentType || 'application/octet-stream',
                CacheControl: options.cacheControl || 'public, max-age=31536000, immutable',
                Metadata: {
                    'user-id': userId,
                    'uploaded-at': new Date().toISOString()
                }
            },
            queueSize: 4,
            partSize: CHUNK_SIZE,
            leavePartsOnError: false
        });

        const result = await upload.done();

        let url;
        if (CDN_DOMAIN) {
            url = `https://${CDN_DOMAIN}/${key}`;
        } else if (process.env.AWS_ENDPOINT) {
            url = `${process.env.AWS_ENDPOINT}/${BUCKET_NAME}/${key}`;
        } else {
            url = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${key}`;
        }

        return {
            url,
            key,
            bucket: BUCKET_NAME,
            provider: 's3',
            format: format
        };

    } catch (error) {
        logger.error('Stream upload failed:', error);
        throw error;
    }
}

// ============================================
// حذف از فضای ابری
// ============================================
async function deleteFromCloud(key, provider = 's3') {
    try {
        if (provider === 'cloudinary' && cloudinary) {
            const result = await cloudinary.uploader.destroy(key);
            if (result.result === 'ok') {
                logger.info(`File deleted from Cloudinary: ${key}`);
                urlCache.delete(key);
                return { success: true };
            }
            throw new Error(`Cloudinary delete failed: ${result.result}`);
        }

        // S3/Minio
        const command = new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        await s3Client.send(command);

        // پاک کردن از کش
        urlCache.delete(key);

        logger.info(`File deleted from S3: ${key}`);
        return { success: true };

    } catch (error) {
        logger.error('Delete from cloud failed:', error);
        throw error;
    }
}

// ============================================
// دریافت URL با کش
// ============================================
function getFileUrl(key, options = {}) {
    const cacheKey = `${key}_${JSON.stringify(options)}`;
    
    // بررسی کش
    if (urlCache.has(cacheKey)) {
        const cached = urlCache.get(cacheKey);
        if (Date.now() < cached.expires) {
            return cached.url;
        }
        urlCache.delete(cacheKey);
    }

    let url;
    if (CDN_DOMAIN) {
        url = `https://${CDN_DOMAIN}/${key}`;
    } else if (process.env.AWS_ENDPOINT) {
        url = `${process.env.AWS_ENDPOINT}/${BUCKET_NAME}/${key}`;
    } else {
        url = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${key}`;
    }

    // اضافه کردن پارامترهای اضافی
    if (options.width || options.height) {
        url += `?w=${options.width || ''}&h=${options.height || ''}`;
    }

    if (options.quality) {
        url += `${url.includes('?') ? '&' : '?'}q=${options.quality}`;
    }

    // ذخیره در کش
    urlCache.set(cacheKey, {
        url,
        expires: Date.now() + URL_CACHE_TTL
    });

    return url;
}

// ============================================
// بررسی وجود فایل
// ============================================
async function fileExists(key) {
    try {
        const command = new HeadObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        await s3Client.send(command);
        return true;
    } catch (error) {
        if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
            return false;
        }
        throw error;
    }
}

// ============================================
// لیست فایل‌های کاربر
// ============================================
async function listUserFiles(userId, options = {}) {
    const prefix = `users/${userId}/`;
    const limit = options.limit || 100;
    const startAfter = options.startAfter || '';

    try {
        const command = new ListObjectsV2Command({
            Bucket: BUCKET_NAME,
            Prefix: prefix,
            MaxKeys: limit,
            StartAfter: startAfter,
            Delimiter: '/'
        });

        const result = await s3Client.send(command);
        
        const files = result.Contents?.map(item => ({
            key: item.Key,
            size: item.Size,
            lastModified: item.LastModified,
            url: getFileUrl(item.Key)
        })) || [];

        return {
            files,
            nextToken: result.NextContinuationToken || null,
            count: files.length
        };

    } catch (error) {
        logger.error('List user files error:', error);
        throw error;
    }
}

// ============================================
// دریافت اطلاعات فایل
// ============================================
async function getFileInfo(key) {
    try {
        const command = new HeadObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        const result = await s3Client.send(command);

        return {
            key,
            size: result.ContentLength,
            contentType: result.ContentType,
            lastModified: result.LastModified,
            eTag: result.ETag,
            metadata: result.Metadata,
            url: getFileUrl(key)
        };

    } catch (error) {
        logger.error('Get file info error:', error);
        throw error;
    }
}

// ============================================
// کپی فایل
// ============================================
async function copyFile(sourceKey, destKey) {
    try {
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: destKey,
            Body: await getFileStream(sourceKey),
            CacheControl: 'public, max-age=31536000, immutable'
        });

        await s3Client.send(command);
        
        logger.info(`File copied: ${sourceKey} -> ${destKey}`);
        return {
            sourceKey,
            destKey,
            url: getFileUrl(destKey)
        };

    } catch (error) {
        logger.error('Copy file error:', error);
        throw error;
    }
}

// ============================================
// دریافت استریم فایل
// ============================================
async function getFileStream(key) {
    try {
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        // برای دریافت استریم باید از getObject استفاده کرد
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const getCommand = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        const result = await s3Client.send(getCommand);
        return result.Body;
    } catch (error) {
        logger.error('Get file stream error:', error);
        throw error;
    }
}

// ============================================
// آمار ذخیره‌سازی
// ============================================
async function getStorageStats() {
    try {
        const command = new ListObjectsV2Command({
            Bucket: BUCKET_NAME,
            MaxKeys: 1000
        });

        const result = await s3Client.send(command);
        
        let totalSize = 0;
        let totalFiles = 0;
        const users = new Map();

        if (result.Contents) {
            for (const item of result.Contents) {
                totalSize += item.Size || 0;
                totalFiles++;
                
                // استخراج userId از key
                const parts = item.Key.split('/');
                if (parts.length >= 3) {
                    const userId = parts[1];
                    if (!users.has(userId)) {
                        users.set(userId, { files: 0, size: 0 });
                    }
                    const userStats = users.get(userId);
                    userStats.files++;
                    userStats.size += item.Size || 0;
                }
            }
        }

        return {
            totalFiles,
            totalSize,
            totalSizeMB: Math.round(totalSize / 1024 / 1024),
            totalSizeGB: (totalSize / 1024 / 1024 / 1024).toFixed(2),
            users: Array.from(users.entries()).map(([userId, stats]) => ({
                userId,
                ...stats,
                sizeMB: Math.round(stats.size / 1024 / 1024)
            })),
            provider: STORAGE_PROVIDER,
            bucket: BUCKET_NAME,
            region: REGION
        };

    } catch (error) {
        logger.error('Get storage stats error:', error);
        throw error;
    }
}

// ============================================
// پاک کردن کش URL
// ============================================
function clearUrlCache() {
    urlCache.clear();
    logger.info('URL cache cleared');
}

module.exports = {
    uploadToCloud,
    uploadStream,
    deleteFromCloud,
    getFileUrl,
    fileExists,
    listUserFiles,
    getFileInfo,
    copyFile,
    getFileStream,
    getStorageStats,
    clearUrlCache,
    s3Client,
    BUCKET_NAME,
    STORAGE_PROVIDER,
    CDN_DOMAIN
};