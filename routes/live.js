const express = require("express");
const crypto = require("crypto");
const LiveSession = require("../models/LiveSession");
const Follow = require("../models/Follow");
const User = require("../models/User");
const { requireAuth } = require("../middleware/auth");
const { broadcastToUser } = require("../realtime");

const router = express.Router();

router.post("/start", requireAuth, async (req, res) => {
  const streamKey = crypto.randomBytes(20).toString("hex");
  const session = await LiveSession.create({
    host: req.userId,
    title: req.body.title || "",
    streamKey,
    status: "live"
  });
  // streamKey همون چیزیه که یک سرور رسانه (RTMP/WebRTC ingest) برای پذیرش استریم لازم داره — پایین توضیح داده شده
  res.status(201).json({ id: session._id, streamKey, status: session.status });
});

router.post("/:id/stop", requireAuth, async (req, res) => {
  const session = await LiveSession.findById(req.params.id);
  if (!session) return res.status(404).json({ message: "لایو یافت نشد" });
  if (session.host.toString() !== req.userId) return res.status(403).json({ message: "اجازه نداری این لایو رو تموم کنی" });
  session.status = "ended";
  session.endedAt = new Date();
  await session.save();
  res.json({ ok: true });
});

router.get("/active", requireAuth, async (req, res) => {
  const following = await Follow.find({ follower: req.userId }).select("following");
  const followingIds = following.map((f) => f.following);
  const sessions = await LiveSession.find({ host: { $in: followingIds }, status: "live" }).populate("host");
  res.json({
    sessions: sessions.map((s) => ({
      id: s._id,
      title: s.title,
      viewerCount: s.viewerCount,
      host: { id: s.host._id, username: s.host.username, avatarUrl: s.host.avatarUrl }
    }))
  });
});

router.post("/:id/notify", requireAuth, async (req, res) => {
  const session = await LiveSession.findById(req.params.id).populate("host");
  if (!session) return res.status(404).json({ message: "لایو یافت نشد" });

  const followers = await Follow.find({ following: req.userId }).select("follower");
  for (const f of followers) {
    broadcastToUser(f.follower.toString(), "live_started", {
      sessionId: session._id,
      host: { id: session.host._id, username: session.host.username, avatarUrl: session.host.avatarUrl },
      title: session.title
    });
  }
  res.json({ notified: followers.length });
});

module.exports = router;

/**
 * نکته مهم و صادقانه درباره‌ی لایو واقعی:
 * این route ها جلسه‌ی لایو رو در دیتابیس ثبت می‌کنن و به فالوورها realtime اطلاع می‌دن —
 * این بخش کاملاً واقعیه. اما «انتقال تصویر زنده» بین دوربین گوشی و بیننده‌ها
 * نیاز به یه سرور رسانه‌ی جداگانه داره (مثل mediasoup، Node-Media-Server برای RTMP،
 * یا یه سرویس آماده مثل Mux/Agora/Ant Media). این یه کامپوننت زیرساختی سنگین‌تره
 * که پیشنهاد می‌کنم به‌عنوان گام بعدی، جدا و با دقت اضافه‌ش کنیم.
 */
