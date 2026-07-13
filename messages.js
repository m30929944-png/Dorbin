const express = require("express");
const Message = require("../models/Message");
const User = require("../models/User");
const { requireAuth } = require("../middleware/auth");
const { broadcastToUser } = require("../realtime");

const router = express.Router();

router.get("/conversations", requireAuth, async (req, res) => {
  const messages = await Message.find({
    $or: [{ from: req.userId }, { to: req.userId }]
  }).sort({ createdAt: -1 });

  const seen = new Set();
  const conversations = [];
  for (const m of messages) {
    const otherId = m.from.toString() === req.userId ? m.to.toString() : m.from.toString();
    if (seen.has(otherId)) continue;
    seen.add(otherId);
    const other = await User.findById(otherId);
    if (!other) continue;
    conversations.push({
      user: { id: other._id, username: other.username, avatarUrl: other.avatarUrl },
      lastMessage: m.text,
      lastMessageAt: m.createdAt
    });
  }
  res.json({ conversations });
});

router.get("/thread/:userId", requireAuth, async (req, res) => {
  const limit = 50;
  const messages = await Message.find({
    $or: [
      { from: req.userId, to: req.params.userId },
      { from: req.params.userId, to: req.userId }
    ]
  }).sort({ createdAt: -1 }).limit(limit);

  res.json({ messages: messages.reverse().map((m) => ({
    id: m._id,
    text: m.text,
    fromMe: m.from.toString() === req.userId,
    createdAt: m.createdAt
  })) });
});

router.post("/thread/:userId", requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ message: "متن پیام خالی است" });

  const message = await Message.create({ from: req.userId, to: req.params.userId, text: text.trim() });
  broadcastToUser(req.params.userId, "new_message", {
    fromUserId: req.userId,
    text: message.text,
    createdAt: message.createdAt
  });
  res.status(201).json({ id: message._id, text: message.text, fromMe: true, createdAt: message.createdAt });
});

module.exports = router;
