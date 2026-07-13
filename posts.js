const express = require("express");
const Post = require("../models/Post");
const Like = require("../models/Like");
const Comment = require("../models/Comment");
const User = require("../models/User");
const { requireAuth } = require("../middleware/auth");
const upload = require("../middleware/upload");
const { broadcastToUser } = require("../realtime");

const router = express.Router();

function serializePost(post, author, likedByMe) {
  return {
    id: post._id,
    imageUrl: post.imageUrl,
    caption: post.caption,
    hashtags: post.hashtags,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    createdAt: post.createdAt,
    likedByMe: !!likedByMe,
    author: author ? { id: author._id, username: author.username, avatarUrl: author.avatarUrl } : null
  };
}

// فید اکسپلور: جدیدترین پست‌های همه کاربران
router.get("/explore", requireAuth, async (req, res) => {
  const limit = 24;
  const cursor = req.query.cursor;
  const filter = cursor ? { createdAt: { $lt: new Date(cursor) } } : {};
  const posts = await Post.find(filter).sort({ createdAt: -1 }).limit(limit).populate("author");
  const likedIds = new Set(
    (await Like.find({ user: req.userId, post: { $in: posts.map((p) => p._id) } })).map((l) => l.post.toString())
  );
  res.json({
    posts: posts.map((p) => serializePost(p, p.author, likedIds.has(p._id.toString()))),
    nextCursor: posts.length === limit ? posts[posts.length - 1].createdAt.toISOString() : null
  });
});

router.get("/:id", requireAuth, async (req, res) => {
  const post = await Post.findById(req.params.id).populate("author");
  if (!post) return res.status(404).json({ message: "پست یافت نشد" });
  const liked = await Like.exists({ user: req.userId, post: post._id });
  res.json(serializePost(post, post.author, liked));
});

router.post("/", requireAuth, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "عکس ارسال نشده" });
  const hashtags = JSON.parse(req.body.hashtags || "[]");
  const post = await Post.create({
    author: req.userId,
    imageUrl: `/uploads/${req.file.filename}`,
    caption: req.body.caption || "",
    hashtags
  });
  await User.findByIdAndUpdate(req.userId, { $inc: { postCount: 1 } });
  const author = await User.findById(req.userId);
  res.status(201).json(serializePost(post, author, false));
});

router.delete("/:id", requireAuth, async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ message: "پست یافت نشد" });
  if (post.author.toString() !== req.userId) return res.status(403).json({ message: "اجازه حذف این پست رو نداری" });
  await post.deleteOne();
  await User.findByIdAndUpdate(req.userId, { $inc: { postCount: -1 } });
  res.json({ ok: true });
});

router.post("/:id/like", requireAuth, async (req, res) => {
  try {
    await Like.create({ user: req.userId, post: req.params.id });
    const post = await Post.findByIdAndUpdate(req.params.id, { $inc: { likeCount: 1 } }, { new: true });
    if (post) broadcastToUser(post.author.toString(), "post_liked", { postId: post._id });
    res.json({ ok: true });
  } catch {
    res.status(409).json({ message: "قبلاً لایک کردی" });
  }
});

router.delete("/:id/like", requireAuth, async (req, res) => {
  const deleted = await Like.findOneAndDelete({ user: req.userId, post: req.params.id });
  if (deleted) await Post.findByIdAndUpdate(req.params.id, { $inc: { likeCount: -1 } });
  res.json({ ok: true });
});

router.get("/:id/comments", requireAuth, async (req, res) => {
  const topLevel = await Comment.find({ post: req.params.id, replyTo: null }).sort({ createdAt: 1 }).populate("author");
  const replies = await Comment.find({ post: req.params.id, replyTo: { $ne: null } }).populate("author");

  const repliesByParent = {};
  for (const r of replies) {
    const key = r.replyTo.toString();
    (repliesByParent[key] ||= []).push({
      id: r._id,
      text: r.text,
      createdAt: r.createdAt,
      author: { id: r.author._id, username: r.author.username, avatarUrl: r.author.avatarUrl }
    });
  }

  res.json({
    comments: topLevel.map((c) => ({
      id: c._id,
      text: c.text,
      createdAt: c.createdAt,
      author: { id: c.author._id, username: c.author.username, avatarUrl: c.author.avatarUrl },
      replies: repliesByParent[c._id.toString()] || []
    }))
  });
});

router.post("/:id/comments", requireAuth, async (req, res) => {
  const { text, replyToCommentId } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ message: "متن کامنت خالی است" });

  const comment = await Comment.create({
    post: req.params.id,
    author: req.userId,
    text: text.trim(),
    replyTo: replyToCommentId || null
  });
  const post = await Post.findByIdAndUpdate(req.params.id, { $inc: { commentCount: 1 } }, { new: true });
  if (post) broadcastToUser(post.author.toString(), "new_comment", { postId: post._id.toString() });

  const author = await User.findById(req.userId);
  res.status(201).json({
    id: comment._id,
    text: comment.text,
    createdAt: comment.createdAt,
    author: { id: author._id, username: author.username, avatarUrl: author.avatarUrl }
  });
});

module.exports = router;
