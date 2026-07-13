const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    passwordHash: { type: String, required: true },
    displayName: { type: String, default: "" },
    bio: { type: String, default: "", maxlength: 300 },
    avatarUrl: { type: String, default: "" },
    followerCount: { type: Number, default: 0 },
    followingCount: { type: Number, default: 0 },
    postCount: { type: Number, default: 0 },
    refreshTokenHash: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
