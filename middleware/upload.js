const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueName = crypto.randomBytes(16).toString("hex") + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp|gif|mp4|mov|webm/;
  const ok = allowed.test(path.extname(file.originalname).toLowerCase());
  cb(ok ? null : new Error("نوع فایل مجاز نیست"), ok);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

module.exports = upload;

/**
 * توجه: این نسخه فایل‌ها رو روی دیسک همون سرور ذخیره می‌کنه — برای شروع و تست خوبه.
 * برای پروداکشن واقعی (چند سرور، مقیاس بالا) بهتره از یه سرویس ابری مثل
 * Cloudinary یا AWS S3 استفاده کنی تا فایل‌ها با دیپلوی مجدد سرور پاک نشن.
 */
