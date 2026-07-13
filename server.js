require("dotenv").config();
const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const { setupRealtime } = require("./realtime");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const postRoutes = require("./routes/posts");
const storyRoutes = require("./routes/stories");
const messageRoutes = require("./routes/messages");
const liveRoutes = require("./routes/live");

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*", credentials: true }));
app.use(express.json());

// فایل‌های آپلودشده (عکس/ویدیو) از این مسیر واقعی سرو میشن
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/v1/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use("/v1/auth", authRoutes);
app.use("/v1/users", userRoutes);
app.use("/v1/posts", postRoutes);
app.use("/v1/stories", storyRoutes);
app.use("/v1/messages", messageRoutes);
app.use("/v1/live", liveRoutes);

app.use((req, res) => res.status(404).json({ message: "مسیر یافت نشد" }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "خطای غیرمنتظره سرور", detail: err.message });
});

const server = http.createServer(app);
setupRealtime(server);

const PORT = process.env.PORT || 4000;

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🚀 سرور بامگرام روی پورت ${PORT} در حال اجراست`);
    });
  })
  .catch((err) => {
    console.error("❌ راه‌اندازی سرور ناموفق بود:", err.message);
    process.exit(1);
  });
