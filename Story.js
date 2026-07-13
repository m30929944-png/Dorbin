const mongoose = require("mongoose");

const storySchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    mediaUrl: { type: String, required: true },
    mediaType: { type: String, enum: ["image", "video"], default: "image" },
    viewers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    expiresAt: { type: Date, required: true, index: { expires: 0 } } // TTL: مونگو خودش بعد از این زمان حذفش می‌کنه (استوری ۲۴ ساعته واقعی)
  },
  { timestamps: true }
);

module.exports = mongoose.model("Story", storySchema);
