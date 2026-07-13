# بک‌اند واقعی بامگرام

## راه‌اندازی (یک‌بار)

1. **Node.js** نصب کن (نسخه ۱۸ به بالا) از nodejs.org
2. یه دیتابیس واقعی و رایگان بساز: برو به mongodb.com/cloud/atlas → Free Cluster بساز → آدرس اتصال (connection string) رو کپی کن
3. توی پوشه‌ی backend:
   ```
   npm install
   cp .env.example .env
   ```
4. فایل `.env` رو باز کن و:
   - `MONGO_URI` رو با آدرس واقعی MongoDB Atlas عوض کن
   - `JWT_ACCESS_SECRET` و `JWT_REFRESH_SECRET` رو با دو رشته‌ی تصادفی طولانی پر کن
5. اجرا کن:
   ```
   npm start
   ```
   اگه درست باشه می‌بینی: `✅ اتصال به MongoDB برقرار شد` و `🚀 سرور بامگرام روی پورت ۴۰۰۰ در حال اجراست`

## تست سریع که واقعاً کار می‌کنه

```
curl http://localhost:4000/v1/health
```
باید `{"ok":true,...}` برگردونه.

ثبت‌نام واقعی:
```
curl -X POST http://localhost:4000/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"ali","email":"ali@test.com","password":"12345678"}'
```

## وصل کردن به فرانت‌اند (index.html)

توی index.html، قبل از تگ `<script src="m1.js">` این خط رو اضافه کن:
```html
<script>window.BAMGRAM_API_BASE_URL = "http://localhost:4000/v1";</script>
```
بعد فایل‌های فرانت‌اند رو با یه Live Server (یا هر سرور استاتیک) باز کن — مستقیم دابل‌کلیک روی index.html به‌خاطر CORS جواب نمیده.

## دیپلوی واقعی (رایگان)

- بک‌اند: Render.com یا Railway.app → پروژه رو از گیت‌هاب وصل کن → متغیرهای `.env` رو توی پنل سرویس ست کن
- دیتابیس: همون MongoDB Atlas (که از قبل ساختی) کار می‌کنه
- فرانت‌اند: همون index.html/m1.js/m2.js رو روی Netlify یا Vercel آپلود کن، و `BAMGRAM_API_BASE_URL` رو به آدرس واقعی بک‌اند دیپلوی‌شده تغییر بده

## چیزی که هنوز واقعی نیست (صادقانه بگم)

- **آپلود فایل**: الان روی دیسک همون سرور ذخیره میشه — برای تست کاملاً واقعیه، ولی برای پروداکشن جدی بهتره Cloudinary/S3 اضافه بشه (فایل‌ها با هر دیپلوی مجدد پاک میشن)
- **لایو استریم**: بخش ثبت جلسه و اعلان به فالوورها کاملاً واقعیه، ولی خودِ پخش تصویر زنده نیاز به یه سرور رسانه‌ی جدا داره (RTMP/WebRTC) — گام بعدی طبیعیه که جدا اضافه‌ش کنیم
