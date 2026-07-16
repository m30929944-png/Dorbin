// ============================================
// media_processor.js - پردازش تصاویر و ویدیوها با بالاترین کیفیت
// ============================================
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { uploadToCloud, getFileUrl, deleteFromCloud } = require('./storage');
const { createLogger } = require('./logger');
const { Worker } = require('worker_threads');
const os = require('os');

const logger = createLogger('media-processor');
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(process.env.FFPROBE_PATH || 'ffprobe');

// ============================================
// تنظیمات پردازش
// ============================================
const MAX_IMAGE_SIZE = parseInt(process.env.MAX_IMAGE_SIZE || '4096', 10);
const MAX_VIDEO_SIZE = parseInt(process.env.MAX_VIDEO_SIZE || '1080', 10);
const IMAGE_QUALITY = parseInt(process.env.IMAGE_QUALITY || '85', 10);
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || '1.5M';
const MAX_CONCURRENT_PROCESSING = parseInt(process.env.MAX_CONCURRENT_PROCESSING || os.cpus().length, 10);
const PROCESSING_TIMEOUT = parseInt(process.env.PROCESSING_TIMEOUT || '3600000', 10);

// ============================================
// کش پردازش
// ============================================
const processingCache = new Map();
const CACHE_TTL = 3600000; // 1 ساعت

// ============================================
// صف پردازش داخلی
// ============================================
class ProcessingQueue {
    constructor() {
        this.queue = [];
        this.processing = 0;
        this.maxConcurrent = MAX_CONCURRENT_PROCESSING;
        this.results = new Map();
    }

    async add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.processNext();
        });
    }

    async processNext() {
        if (this.processing >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }

        this.processing++;
        const item = this.queue.shift();

        try {
            const result = await item.task();
            item.resolve(result);
        } catch (error) {
            item.reject(error);
        } finally {
            this.processing--;
            this.processNext();
        }
    }

    getStats() {
        return {
            queueLength: this.queue.length,
            processing: this.processing,
            maxConcurrent: this.maxConcurrent
        };
    }
}

const processingQueue = new ProcessingQueue();

// ============================================
// تشخیص نوع فایل
// ============================================
function detectFileType(mimeType, buffer) {
    if (mimeType) {
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('video/')) return 'video';
        if (mimeType.startsWith('application/')) return 'document';
        if (mimeType.startsWith('audio/')) return 'audio';
    }

    // تشخیص از طریق محتوای فایل
    if (buffer) {
        const header = buffer.toString('hex', 0, 12);
        // JPEG
        if (header.startsWith('ffd8ffe0') || header.startsWith('ffd8ffe1')) return 'image';
        // PNG
        if (header.startsWith('89504e47')) return 'image';
        // WebP
        if (header.startsWith('52494646') && buffer.toString('utf8', 8, 12) === 'WEBP') return 'image';
        // MP4
        if (header.startsWith('0000001466747970')) return 'video';
        // GIF
        if (header.startsWith('47494638')) return 'image';
    }

    return 'unknown';
}

// ============================================
// استخراج متادیتا
// ============================================
async function extractMetadata(filePath, type) {
    try {
        const stats = fs.statSync(filePath);
        const metadata = {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime
        };

        if (type === 'image') {
            try {
                const imageInfo = await sharp(filePath).metadata();
                metadata.width = imageInfo.width;
                metadata.height = imageInfo.height;
                metadata.format = imageInfo.format;
                metadata.hasAlpha = imageInfo.hasAlpha;
                metadata.space = imageInfo.space;
                metadata.channels = imageInfo.channels;
                metadata.density = imageInfo.density;
            } catch (e) {
                logger.warn('Failed to extract image metadata:', e);
            }
        }

        if (type === 'video') {
            try {
                const probeData = await new Promise((resolve, reject) => {
                    ffmpeg.ffprobe(filePath, (err, data) => {
                        if (err) reject(err);
                        else resolve(data);
                    });
                });

                const videoStream = probeData.streams.find(s => s.codec_type === 'video');
                const audioStream = probeData.streams.find(s => s.codec_type === 'audio');

                metadata.duration = probeData.format?.duration || 0;
                metadata.bitrate = probeData.format?.bit_rate || 0;
                metadata.size = probeData.format?.size || stats.size;
                
                if (videoStream) {
                    metadata.width = videoStream.width;
                    metadata.height = videoStream.height;
                    metadata.videoCodec = videoStream.codec_name;
                    metadata.videoBitrate = videoStream.bit_rate;
                    metadata.framerate = eval(videoStream.avg_frame_rate || '0');
                    metadata.pixelFormat = videoStream.pix_fmt;
                }
                
                if (audioStream) {
                    metadata.audioCodec = audioStream.codec_name;
                    metadata.audioBitrate = audioStream.bit_rate;
                    metadata.sampleRate = audioStream.sample_rate;
                    metadata.channels = audioStream.channels;
                }
            } catch (e) {
                logger.warn('Failed to extract video metadata:', e);
            }
        }

        return metadata;
    } catch (error) {
        logger.error('Metadata extraction error:', error);
        return { size: fs.statSync(filePath).size };
    }
}

// ============================================
// پردازش تصویر با Sharp (پیشرفته)
// ============================================
async function processImage(inputPath, userId, options = {}) {
    const startTime = performance.now();
    const cacheKey = `${inputPath}_${userId}_${JSON.stringify(options)}`;
    
    // بررسی کش
    if (processingCache.has(cacheKey)) {
        const cached = processingCache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            logger.debug(`Image cache hit: ${inputPath}`);
            return cached.result;
        }
        processingCache.delete(cacheKey);
    }

    const quality = options.quality || IMAGE_QUALITY;
    const maxWidth = options.maxWidth || MAX_IMAGE_SIZE;
    const maxHeight = options.maxHeight || MAX_IMAGE_SIZE;
    const format = options.format || 'webp';
    const fit = options.fit || 'inside';
    const withoutEnlargement = options.withoutEnlargement !== false;

    try {
        // خواندن فایل
        const inputBuffer = fs.readFileSync(inputPath);
        const image = sharp(inputBuffer);

        // استخراج متادیتا
        const metadata = await image.metadata();
        
        // پردازش با تنظیمات پیشرفته
        let pipeline = image;

        // تبدیل رنگ
        if (metadata.space && metadata.space !== 'srgb') {
            pipeline = pipeline.toColorspace('srgb');
        }

        // تغییر اندازه با حفظ نسبت
        if (metadata.width > maxWidth || metadata.height > maxHeight) {
            pipeline = pipeline.resize(maxWidth, maxHeight, {
                fit,
                withoutEnlargement,
                kernel: sharp.kernel.lanczos3,
                fastShrinkOnLoad: true
            });
        }

        // بهبود تصویر
        pipeline = pipeline
            .sharpen({
                sigma: 0.5,
                m1: 1.0,
                m2: 2.0,
                x1: 2.0,
                y2: 10.0,
                y3: 20.0
            })
            .normalize();

        // تبدیل به فرمت هدف
        const outputOptions = {
            quality,
            progressive: true,
            optimizeScans: true
        };

        if (format === 'webp') {
            pipeline = pipeline.webp({
                ...outputOptions,
                alphaQuality: quality,
                lossless: false,
                nearLossless: false,
                smartSubsample: true
            });
        } else if (format === 'jpeg' || format === 'jpg') {
            pipeline = pipeline.jpeg({
                ...outputOptions,
                mozjpeg: true,
                trellisQuantisation: true,
                overshootDeringing: true,
                optimizeScans: true
            });
        } else if (format === 'png') {
            pipeline = pipeline.png({
                compressionLevel: 9,
                palette: true,
                quality: quality,
                progressive: true
            });
        } else if (format === 'avif') {
            pipeline = pipeline.avif({
                quality,
                lossless: false,
                speed: 8
            });
        } else {
            throw new Error(`Unsupported format: ${format}`);
        }

        // اجرای پردازش
        const outputBuffer = await pipeline.toBuffer();
        const outputPath = inputPath.replace(path.extname(inputPath), `.${format}`);

        // ذخیره فایل پردازش شده
        fs.writeFileSync(outputPath, outputBuffer);

        // آپلود به فضای ابری
        const uploaded = await uploadToCloud(outputPath, userId, 'images', format);

        // استخراج متادیتای نهایی
        const finalMetadata = await sharp(outputBuffer).metadata();

        // پاک کردن فایل‌های temp
        try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            if (inputPath !== outputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        } catch (e) {}

        const result = {
            url: uploaded.url,
            key: uploaded.key,
            size: uploaded.size,
            format: format,
            width: finalMetadata.width,
            height: finalMetadata.height,
            processed: true,
            originalSize: metadata.size,
            compressionRatio: metadata.size / uploaded.size,
            duration: performance.now() - startTime,
            metadata: finalMetadata
        };

        // ذخیره در کش
        processingCache.set(cacheKey, {
            result,
            timestamp: Date.now()
        });

        logger.info(`Image processed: ${path.basename(inputPath)} in ${result.duration.toFixed(2)}ms, ${(result.compressionRatio).toFixed(2)}x compression`);

        return result;

    } catch (error) {
        logger.error('Image processing error:', error);
        throw error;
    }
}

// ============================================
// پردازش ویدیو با FFmpeg (پیشرفته)
// ============================================
async function processVideo(inputPath, userId, options = {}) {
    const startTime = performance.now();
    const cacheKey = `${inputPath}_${userId}_${JSON.stringify(options)}`;
    
    // بررسی کش
    if (processingCache.has(cacheKey)) {
        const cached = processingCache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            logger.debug(`Video cache hit: ${inputPath}`);
            return cached.result;
        }
        processingCache.delete(cacheKey);
    }

    const bitrate = options.bitrate || VIDEO_BITRATE;
    const targetCodec = options.targetCodec || 'libx264';
    const targetFormat = options.targetFormat || 'mp4';
    const maxHeight = options.maxHeight || MAX_VIDEO_SIZE;
    const maxWidth = options.maxWidth || MAX_VIDEO_SIZE;

    try {
        // استخراج متادیتا
        const probeData = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(inputPath, (err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        });

        const videoStream = probeData.streams.find(s => s.codec_type === 'video');
        const audioStream = probeData.streams.find(s => s.codec_type === 'audio');
        
        if (!videoStream) {
            throw new Error('No video stream found');
        }

        // محاسبه ابعاد جدید
        let width = parseInt(videoStream.width) || 0;
        let height = parseInt(videoStream.height) || 0;
        
        if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
            // اطمینان از زوج بودن ابعاد
            if (width % 2 !== 0) width--;
            if (height % 2 !== 0) height--;
        }

        const outputPath = inputPath.replace(path.extname(inputPath), `.${targetFormat}`);

        // تنظیمات پیشرفته FFmpeg
        const command = ffmpeg(inputPath)
            .videoCodec(targetCodec)
            .audioCodec('aac')
            .outputOptions([
                `-b:v ${bitrate}`,
                `-maxrate ${parseInt(bitrate) * 1.5}M`,
                `-bufsize ${parseInt(bitrate) * 2}M`,
                '-preset medium',
                '-profile:v high',
                '-level 4.0',
                '-pix_fmt yuv420p',
                '-movflags +faststart',
                '-metadata title="Yareman Video"',
                '-metadata artist="User"'
            ]);

        // تنظیم ابعاد
        if (width > 0 && height > 0) {
            command.size(`${width}x${height}`);
        }

        // تنظیمات صدا
        if (audioStream) {
            command.audioBitrate('128k');
            command.audioChannels(2);
            command.audioFrequency(44100);
        } else {
            command.noAudio();
        }

        // اجرای پردازش با مانیتورینگ پیشرفت
        let progressData = { percent: 0 };
        const processingPromise = new Promise((resolve, reject) => {
            command
                .on('progress', (progress) => {
                    progressData = progress;
                    if (progress.percent) {
                        logger.debug(`Video processing: ${Math.round(progress.percent)}%`);
                    }
                })
                .on('end', () => resolve(progressData))
                .on('error', (err) => reject(err))
                .save(outputPath);
        });

        // تایم‌اوت پردازش
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Video processing timeout')), PROCESSING_TIMEOUT);
        });

        await Promise.race([processingPromise, timeoutPromise]);

        // استخراج متادیتای فایل نهایی
        const finalMetadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(outputPath, (err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        });

        // آپلود به فضای ابری
        const uploaded = await uploadToCloud(outputPath, userId, 'videos', targetFormat);

        // پاک کردن فایل‌های temp
        try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            if (inputPath !== outputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        } catch (e) {}

        const duration = performance.now() - startTime;
        const result = {
            url: uploaded.url,
            key: uploaded.key,
            size: uploaded.size,
            format: targetFormat,
            width: width || videoStream.width,
            height: height || videoStream.height,
            duration: finalMetadata.format?.duration || 0,
            bitrate: finalMetadata.format?.bit_rate || 0,
            processed: true,
            originalSize: fs.statSync(inputPath).size,
            compressionRatio: fs.statSync(inputPath).size / uploaded.size,
            duration: duration,
            metadata: finalMetadata
        };

        // ذخیره در کش
        processingCache.set(cacheKey, {
            result,
            timestamp: Date.now()
        });

        logger.info(`Video processed: ${path.basename(inputPath)} in ${result.duration.toFixed(2)}ms, ${(result.compressionRatio).toFixed(2)}x compression`);

        return result;

    } catch (error) {
        logger.error('Video processing error:', error);
        throw error;
    }
}

// ============================================
// پردازش تام‌نیل ویدئو
// ============================================
async function generateVideoThumbnail(inputPath, userId, options = {}) {
    const thumbnailPath = inputPath.replace(path.extname(inputPath), '_thumb.jpg');
    
    try {
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .screenshots({
                    timestamps: [options.timestamp || '00:00:02'],
                    filename: path.basename(thumbnailPath),
                    folder: path.dirname(thumbnailPath),
                    size: options.size || '320x180'
                })
                .on('end', () => resolve())
                .on('error', (err) => reject(err));
        });

        // پردازش تام‌نیل با Sharp
        const thumbnailResult = await processImage(thumbnailPath, userId, {
            quality: 80,
            maxWidth: 320,
            maxHeight: 180,
            format: 'webp'
        });

        return {
            url: thumbnailResult.url,
            key: thumbnailResult.key,
            width: 320,
            height: 180
        };

    } catch (error) {
        logger.error('Thumbnail generation error:', error);
        return null;
    }
}

// ============================================
// تابع اصلی پردازش مدیا (برای Bull)
// ============================================
async function processMediaJob(job) {
    const { userId, tempPath, originalName, mimeType, isVideo, isDocument, ext } = job.data;
    const startTime = performance.now();

    logger.info(`Processing ${isVideo ? 'video' : isDocument ? 'document' : 'image'} for user ${userId}`);

    try {
        // تشخیص نوع فایل
        const fileType = detectFileType(mimeType);
        
        let result;
        let thumbnail = null;
        let metadata = null;

        // استخراج متادیتا
        metadata = await extractMetadata(tempPath, fileType);

        if (fileType === 'image') {
            // پردازش تصویر با بالاترین کیفیت
            result = await processImage(tempPath, userId, {
                quality: IMAGE_QUALITY,
                maxWidth: MAX_IMAGE_SIZE,
                maxHeight: MAX_IMAGE_SIZE,
                format: 'webp'
            });
        } else if (fileType === 'video') {
            // پردازش ویدیو
            result = await processVideo(tempPath, userId, {
                bitrate: VIDEO_BITRATE,
                maxHeight: MAX_VIDEO_SIZE,
                maxWidth: MAX_VIDEO_SIZE,
                targetFormat: 'mp4'
            });
            
            // تولید تام‌نیل
            thumbnail = await generateVideoThumbnail(tempPath, userId, {
                size: '320x180',
                timestamp: '00:00:02'
            });
        } else if (fileType === 'document') {
            // برای اسناد، فقط آپلود می‌کنیم
            const uploaded = await uploadToCloud(tempPath, userId, 'documents', ext.replace('.', ''));
            result = {
                url: uploaded.url,
                key: uploaded.key,
                size: uploaded.size,
                format: ext.replace('.', ''),
                processed: true,
                metadata: metadata
            };
            
            // پاک کردن فایل temp
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } else {
            throw new Error(`Unsupported file type: ${fileType}`);
        }

        const processingTime = performance.now() - startTime;

        const finalResult = {
            success: true,
            ...result,
            userId,
            originalName,
            mimeType,
            thumbnail,
            metadata,
            processingTime,
            timestamp: new Date().toISOString()
        };

        logger.info(`Media processing completed for user ${userId} in ${processingTime.toFixed(2)}ms`);

        return finalResult;

    } catch (error) {
        const processingTime = performance.now() - startTime;
        logger.error(`Media processing failed for user ${userId} after ${processingTime.toFixed(2)}ms:`, error);
        
        // پاک کردن فایل temp در صورت خطا
        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch (e) {}

        throw error;
    }
}

// ============================================
// پردازش با Worker Threads (برای عملیات سنگین)
// ============================================
async function processWithWorker(task, data) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const { parentPort, workerData } = require('worker_threads');
            const sharp = require('sharp');
            const ffmpeg = require('fluent-ffmpeg');
            
            parentPort.on('message', async (message) => {
                try {
                    const result = await processTask(message);
                    parentPort.postMessage({ success: true, result });
                } catch (error) {
                    parentPort.postMessage({ success: false, error: error.message });
                }
            });
            
            async function processTask(data) {
                // پردازش در Worker
                const { type, inputPath, options } = data;
                if (type === 'image') {
                    // پردازش تصویر
                } else if (type === 'video') {
                    // پردازش ویدیو
                }
                return { processed: true };
            }
        `, { eval: true });

        worker.postMessage({ task, data });

        worker.on('message', (result) => {
            if (result.success) {
                resolve(result.result);
            } else {
                reject(new Error(result.error));
            }
        });

        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Worker stopped with exit code ${code}`));
            }
        });

        // تایم‌اوت
        setTimeout(() => {
            worker.terminate();
            reject(new Error('Worker timeout'));
        }, PROCESSING_TIMEOUT);
    });
}

// ============================================
// تابع‌های کمکی
// ============================================
function getProcessingStats() {
    return {
        queue: processingQueue.getStats(),
        cacheSize: processingCache.size,
        cacheTTL: CACHE_TTL
    };
}

function clearProcessingCache() {
    processingCache.clear();
    logger.info('Processing cache cleared');
}

function getSupportedFormats() {
    return {
        images: ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff', 'heic', 'heif'],
        videos: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv', '3gp'],
        documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'zip', 'rar', '7z']
    };
}

module.exports = {
    processImage,
    processVideo,
    processMediaJob,
    generateVideoThumbnail,
    extractMetadata,
    detectFileType,
    getProcessingStats,
    clearProcessingCache,
    getSupportedFormats,
    processingQueue
};