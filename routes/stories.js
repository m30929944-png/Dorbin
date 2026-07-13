const express = require("express");
const Story = require("../models/Story");
const Follow = require("../models/Follow");
const User = require("../models/User");
const { requireAuth } = require("../middleware/auth");
const upload = require("../middleware/upload");

const router = express.Router();

router.post("/", requireAuth, upload.single("media"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "فایل استوری ارسال نشده" });
  const isVideo = /\.(mp4|mov|webm)$/i.test(req.file.filename);
  const story = await Story.create({
    author: req.userId,
    mediaUrl: `/uploads/${req.file.filename}`,
    mediaType: isVideo ? "video" : "image",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // ۲۴ ساعت واقعی — بعدش مونگو خودش حذفش می‌کنه
  });
  res.status(201).json({ id: story._id, mediaUrl: story.mediaUrl, expiresAt: story.expiresAt });
});

// استوری‌های افرادی که فالو می‌کنم، گروه‌بندی‌شده بر اساس کاربر
router.get("/feed", requireAuth, async (req, res) => {
  const following = await Follow.find({ follower: req.userId }).select("following");
  const followingIds = following.map((f) => f.following);

  const stories = await Story.find({ author: { $in: followingIds } }).sort({ createdAt: 1 }).populate("author");

  const groups = {};
  for (const s of stories) {
    const key = s.author._id.toString();
    if (!groups[key]) {
      groups[key] = {
        user: { id: s.author._id, username: s.author.username, avatarUrl: s.author.avatarUrl },
        seen: true,
        stories: []
      };
    }
    const seenByMe = s.viewers.some((v) => v.toString() === req.userId);
    if (!seenByMe) groups[key].seen = false;
    groups[key].stories.push({ id: s._id, mediaUrl: s.mediaUrl, mediaType: s.mediaType, createdAt: s.createdAt });
  }

  res.json({ storyGroups: Object.values(groups) });
});

router.get("/me", requireAuth, async (req, res) => {
  const stories = await Story.find({ author: req.userId }).sort({ createdAt: -1 });
  res.json({
    stories: stories.map((s) => ({
      id: s._id,
      mediaUrl: s.mediaUrl,
      viewCount: s.viewers.length,
      likeCount: s.likedBy.length,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt
    }))
  });
});

router.post("/:id/view", requireAuth, async (req, res) => {
  await Story.findByIdAndUpdate(req.params.id, { $addToSet: { viewers: req.userId } });
  res.json({ ok: true });
});

router.post("/:id/like", requireAuth, async (req, res) => {
  await Story.findByIdAndUpdate(req.params.id, { $addToSet: { likedBy: req.userId } });
  res.json({ ok: true });
});

// بازدید و لایک استوری خودم (فقط صاحب استوری می‌تونه ببینه)
router.get("/:id/insights", requireAuth, async (req, res) => {
  const story = await Story.findById(req.params.id).populate("viewers").populate("likedBy");
  if (!story) return res.status(404).json({ message: "استوری یافت نشد" });
  if (story.author.toString() !== req.userId) return res.status(403).json({ message: "اجازه دسترسی نداری" });
  res.json({
    viewCount: story.viewers.length,
    likeCount: story.likedBy.length,
    viewers: story.viewers.map((v) => ({ id: v._id, username: v.username, avatarUrl: v.avatarUrl }))
  });
});

module.exports = router;
