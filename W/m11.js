// ============================================
// 📤 FILE UPLOAD & PROCESSING SERVICE
// ============================================

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');

class UploadService {
    constructor() {
        this.uploadDir = './uploads';
        this.tempDir = './uploads/temp';
        this.maxFileSize = 2 * 1024 * 1024 * 1024; // 2GB
        this.allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/heic'];
        this.allowedVideoTypes = ['video/mp4', 'video/webm', 'video/ogg', 'video/avi', 'video/mov', 'video/mkv'];
        this.allowedDocumentTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
        this.allowedTypes = [...this.allowedImageTypes, ...this.allowedVideoTypes, ...this.allowedDocumentTypes];
        this.maxConcurrent = 10;
        this.uploadStats = { total: 0, success: 0, failed: 0 };
        
        this.initDirectories();
        this.configureMulter();
    }

    // ===== DIRECTORY MANAGEMENT =====
    initDirectories() {
        const dirs = [
            this.uploadDir,
            this.tempDir,
            './uploads/posts',
            './uploads/stories',
            './uploads/avatars',
            './uploads/live',
            './uploads/documents',
            './uploads/temp',
            './uploads/thumbnails'
        ];

        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }

    // ===== FILE VALIDATION =====
    validateFile(file, maxSize = this.maxFileSize) {
        if (!file) {
            return { valid: false, error: 'فایلی ارسال نشده است' };
        }

        if (file.size > maxSize) {
            return { valid: false, error: `حجم فایل بیش از ${maxSize / 1024 / 1024 / 1024}GB است` };
        }

        if (!this.allowedTypes.includes(file.mimetype)) {
            return { valid: false, error: 'نوع فایل مجاز نیست' };
        }

        return { valid: true };
    }

    // ===== CONFIGURE MULTER =====
    configureMulter() {
        const storage = multer.diskStorage({
            destination: (req, file, cb) => {
                let dir = this.uploadDir;
                if (file.fieldname === 'avatar') dir = './uploads/avatars';
                else if (file.fieldname === 'story') dir = './uploads/stories';
                else if (file.fieldname === 'live') dir = './uploads/live';
                else if (file.fieldname === 'document') dir = './uploads/documents';
                else dir = './uploads/posts';
                
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                cb(null, dir);
            },
            filename: (req, file, cb) => {
                const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`;
                cb(null, uniqueName);
            }
        });

        const fileFilter = (req, file, cb) => {
            const validation = this.validateFile(file);
            if (validation.valid) {
                cb(null, true);
            } else {
                cb(new Error(validation.error), false);
            }
        };

        this.upload = multer({
            storage: storage,
            limits: {
                fileSize: this.maxFileSize,
                files: 10,
                fieldSize: 2 * 1024 * 1024 * 1024
            },
            fileFilter: fileFilter
        });

        // Story upload
        this.storyUpload = multer({
            storage: multer.diskStorage({
                destination: './uploads/stories',
                filename: (req, file, cb) => {
                    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`);
                }
            }),
            limits: { fileSize: 200 * 1024 * 1024 },
            fileFilter: (req, file, cb) => {
                const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'];
                cb(null, allowed.includes(file.mimetype));
            }
        });

        // Avatar upload
        this.avatarUpload = multer({
            storage: multer.diskStorage({
                destination: './uploads/avatars',
                filename: (req, file, cb) => {
                    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`);
                }
            }),
            limits: { fileSize: 10 * 1024 * 1024 },
            fileFilter: (req, file, cb) => {
                const allowed = ['image/jpeg', 'image/png', 'image/webp'];
                cb(null, allowed.includes(file.mimetype));
            }
        });

        // Multiple upload
        this.multipleUpload = multer({
            storage: storage,
            limits: {
                fileSize: this.maxFileSize,
                files: 20
            },
            fileFilter: fileFilter
        });
    }

    // ===== IMAGE PROCESSING =====
    async processImage(filePath, options = {}) {
        try {
            const {
                width = null,
                height = null,
                quality = 85,
                format = 'jpeg',
                resize = true,
                optimize = true,
                thumbnail = false,
                thumbnailSize = 200
            } = options;

            let image = sharp(filePath);
            const metadata = await image.metadata();

            if (resize && (width || height)) {
                image = image.resize({
                    width: width || metadata.width,
                    height: height || metadata.height,
                    fit: 'cover',
                    position: 'center',
                    withoutEnlargement: true
                });
            }

            if (optimize) {
                if (format === 'jpeg' || format === 'jpg') {
                    image = image.jpeg({ quality, progressive: true, mozjpeg: true });
                } else if (format === 'png') {
                    image = image.png({ quality: Math.min(quality, 100), compressionLevel: 9 });
                } else if (format === 'webp') {
                    image = image.webp({ quality, lossless: false });
                } else if (format === 'avif') {
                    image = image.avif({ quality });
                } else if (format === 'heic') {
                    image = image.heic({ quality });
                }
            }

            const outputPath = filePath.replace(path.extname(filePath), `.${format}`);
            await image.toFile(outputPath);

            // Create thumbnail if requested
            let thumbnailPath = null;
            if (thumbnail) {
                const thumbDir = './uploads/thumbnails';
                if (!fs.existsSync(thumbDir)) {
                    fs.mkdirSync(thumbDir, { recursive: true });
                }
                thumbnailPath = path.join(thumbDir, `${path.basename(filePath, path.extname(filePath))}_thumb.${format}`);
                await sharp(filePath)
                    .resize(thumbnailSize, thumbnailSize, { fit: 'cover', position: 'center' })
                    .toFile(thumbnailPath);
            }

            // Remove original if processed
            if (filePath !== outputPath) {
                fs.unlinkSync(filePath);
            }

            this.uploadStats.success++;
            return {
                success: true,
                path: outputPath,
                thumbnail: thumbnailPath,
                size: fs.statSync(outputPath).size,
                metadata: await sharp(outputPath).metadata()
            };
        } catch (error) {
            this.uploadStats.failed++;
            console.error('Image processing error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // ===== VIDEO PROCESSING =====
    async processVideo(filePath, options = {}) {
        try {
            const {
                width = 1280,
                height = 720,
                bitrate = '2M',
                format = 'mp4',
                thumbnail = true,
                thumbnailTime = 1
            } = options;

            // In production, use ffmpeg or similar
            // For now, just return the original file
            
            // Create thumbnail if requested
            let thumbnailPath = null;
            if (thumbnail) {
                const thumbDir = './uploads/thumbnails';
                if (!fs.existsSync(thumbDir)) {
                    fs.mkdirSync(thumbDir, { recursive: true });
                }
                thumbnailPath = path.join(thumbDir, `${path.basename(filePath, path.extname(filePath))}_thumb.jpg`);
                // In production, extract thumbnail from video
            }

            this.uploadStats.success++;
            return {
                success: true,
                path: filePath,
                thumbnail: thumbnailPath,
                size: fs.statSync(filePath).size,
                duration: 0 // In production, get from ffmpeg
            };
        } catch (error) {
            this.uploadStats.failed++;
            console.error('Video processing error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // ===== FILE MANAGEMENT =====
    async deleteFile(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                this.uploadStats.total++;
                return { success: true };
            }
            return { success: false, error: 'فایل یافت نشد' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async deleteFiles(filePaths) {
        const results = [];
        for (const path of filePaths) {
            results.push(await this.deleteFile(path));
        }
        return results;
    }

    getFileInfo(filePath) {
        try {
            const stats = fs.statSync(filePath);
            const ext = path.extname(filePath);
            return {
                path: filePath,
                name: path.basename(filePath),
                size: stats.size,
                extension: ext,
                createdAt: stats.birthtime,
                modifiedAt: stats.mtime,
                isFile: stats.isFile(),
                isDirectory: stats.isDirectory(),
                type: this.getFileType(ext)
            };
        } catch (error) {
            return null;
        }
    }

    getFileType(extension) {
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.heic', '.avif'];
        const videoExts = ['.mp4', '.webm', '.ogg', '.avi', '.mov', '.mkv'];
        const docExts = ['.pdf', '.doc', '.docx'];
        
        if (imageExts.includes(extension)) return 'image';
        if (videoExts.includes(extension)) return 'video';
        if (docExts.includes(extension)) return 'document';
        return 'other';
    }

    // ===== STATISTICS =====
    getStats() {
        const stats = {
            totalFiles: 0,
            totalSize: 0,
            byType: {},
            byExtension: {}
        };

        const walkDir = (dir) => {
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const filePath = path.join(dir, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.isDirectory()) {
                        walkDir(filePath);
                    } else {
                        stats.totalFiles++;
                        stats.totalSize += stat.size;
                        const ext = path.extname(file).toLowerCase();
                        stats.byExtension[ext] = (stats.byExtension[ext] || 0) + 1;
                        const type = this.getFileType(ext);
                        stats.byType[type] = (stats.byType[type] || 0) + 1;
                    }
                } catch (e) {
                    // Skip inaccessible files
                }
            }
        };

        walkDir(this.uploadDir);
        
        return {
            ...stats,
            totalSizeGB: (stats.totalSize / 1024 / 1024 / 1024).toFixed(2),
            uploadStats: this.uploadStats,
            maxFileSize: this.maxFileSize,
            allowedTypes: this.allowedTypes
        };
    }

    // ===== CLEANUP =====
    cleanup() {
        const now = Date.now();
        const tempExpiry = 24 * 60 * 60 * 1000; // 24 hours

        if (fs.existsSync(this.tempDir)) {
            const files = fs.readdirSync(this.tempDir);
            for (const file of files) {
                const filePath = path.join(this.tempDir, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (now - stat.mtime.getTime() > tempExpiry) {
                        fs.unlinkSync(filePath);
                    }
                } catch (e) {
                    // Skip
                }
            }
        }

        // Clean empty directories
        const cleanDir = (dir) => {
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir);
            if (files.length === 0) {
                fs.rmdirSync(dir);
            } else {
                for (const file of files) {
                    const filePath = path.join(dir, file);
                    try {
                        if (fs.statSync(filePath).isDirectory()) {
                            cleanDir(filePath);
                        }
                    } catch (e) {
                        // Skip
                    }
                }
            }
        };

        cleanDir('./uploads/temp');
    }

    // ===== START CLEANUP SCHEDULER =====
    startCleanupScheduler() {
        this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    }

    stopCleanupScheduler() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
    }
}

module.exports = new UploadService();
