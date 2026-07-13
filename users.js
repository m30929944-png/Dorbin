const express = require("express");
const User = require("../models/User");
const Follow = require("../models/Follow");
const Post = require("../models/Post");
const Like = require("../models/Like");
const { requireAuth } = require("../middleware/auth");
const upload = require("../middleware/upload");

const router = express.Router();

function publicUser(user, extra = {}) {
  return {
    id: user._id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    followerCount: user.followerCount,
    followingCount: user.followingCount,
    postCount: user.postCount,
    ...extra
  };
}

router.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ message: "کاربر یافت نشد" });
  res.json(publicUser(user));
});

router.patch("/me", requireAuth, async (req, res) => {
  const { displayName, bio } = req.body;
  const update = {};
  if (displayName !== undefined) update.displayName = displayName.slice(0, 60);
  if (bio !== undefined) update.bio = bio.slice(0, 300);
  const user = await User.findByIdAndUpdate(req.userId, update, { new: true });
  res.json(publicUser(user));
});

router.post("/me/avatar", requireAuth, upload.single("avatar"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "فایل عکس ارسال نشده" });
  const avatarUrl = `/uploads/${req.file.filename}`;
  const user = await User.findByIdAndUpdate(req.userId, { avatarUrl }, { new: true });
  res.json(publicUser(user));
});

router.get("/search", requireAuth, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ users: [] });
  const users = await User.find({
    $or: [
      { username: new RegExp(q, "i") },
      { displayName: new RegExp(q, "i") }
    ]
  }).limit(20);
  res.json({ users: users.map((u) => publicUser(u)) });
});

router.get("/:username", requireAuth, async (req, res) => {
  const user = await User.findOne({ username: req.params.username.toLowerCase() });
  if (!user) return res.status(404).json({ message: "کاربر یافت نشد" });
  const isFollowing = await Follow.exists({ follower: req.userId, following: user._id });
  res.json(publicUser(user, { isFollowedByMe: !!isFollowing }));
});

router.post("/:id/follow", requireAuth, async (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.userId) return res.status(400).json({ message: "نمی‌تونی خودت رو فالو کنی" });
  try {
    await Follow.create({ follower: req.userId, following: targetId });
    await User.findByIdAndUpdate(req.userId, { $inc: { followingCount: 1 } });
    await User.findByIdAndUpdate(targetId, { $inc: { followerCount: 1 } });
    res.json({ ok: true });
  } catch {
    res.status(409).json({ message: "قبلاً فالو کردی" });
  }
});

router.delete("/:id/follow", requireAuth, async (req, res) => {
  const targetId = req.params.id;
  const deleted = await Follow.findOneAndDelete({ follower: req.userId, following: targetId });
  if (deleted) {
    await User.findByIdAndUpdate(req.userId, { $inc: { followingCount: -1 } });
    await User.findByIdAndUpdate(targetId, { $inc: { followerCount: -1 } });
  }
  res.json({ ok: true });
});

router.get("/:id/followers", requireAuth, async (req, res) => {
  const follows = await Follow.find({ following: req.params.id }).populate("follower").limit(50);
  res.json({ users: follows.map((f) => publicUser(f.follower)) });
});

router.get("/:id/following", requireAuth, async (req, res) => {
  const follows = await Follow.find({ follower: req.params.id }).populate("following").limit(50);
  res.json({ users: follows.map((f) => publicUser(f.following)) });
});

router.get("/:id/posts", requireAuth, async (req, res) => {
  const limit = 30;
  const cursor = req.query.cursor;
  const filter = { author: req.params.id, ...(cursor ? { createdAt: { $lt: new Date(cursor) } } : {}) };
  const posts = await Post.find(filter).sort({ createdAt: -1 }).limit(limit);
  const likedIds = new Set(
    (await Like.find({ user: req.userId, post: { $in: posts.map((p) => p._id) } })).map((l) => l.post.toString())
  );
  res.json({
    posts: posts.map((p) => ({
      id: p._id,
      imageUrl: p.imageUrl,
      caption: p.caption,
      likeCount: p.likeCount,
      commentCount: p.commentCount,
      likedByMe: likedIds.has(p._id.toString()),
      createdAt: p.createdAt
    })),
    nextCursor: posts.length === limit ? posts[posts.length - 1].createdAt.toISOString() : null
  });
});

module.exports = router;
