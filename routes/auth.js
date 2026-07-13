const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");

const router = express.Router();

function signTokens(userId) {
  const accessToken = jwt.sign({ sub: userId }, process.env.JWT_ACCESS_SECRET, { expiresIn: "15m" });
  const refreshToken = jwt.sign({ sub: userId, jti: crypto.randomUUID() }, process.env.JWT_REFRESH_SECRET, { expiresIn: "30d" });
  return { accessToken, refreshToken };
}

function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    followerCount: user.followerCount,
    followingCount: user.followingCount,
    postCount: user.postCount
  };
}

router.post("/register", async (req, res) => {
  try {
    const { username, email, password, displayName } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ message: "نام کاربری، ایمیل و رمز عبور لازم است" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "رمز عبور باید حداقل ۸ کاراکتر باشد" });
    }
    const exists = await User.findOne({ $or: [{ username: username.toLowerCase() }, { email: email.toLowerCase() }] });
    if (exists) {
      return res.status(409).json({ message: "این نام کاربری یا ایمیل قبلاً ثبت شده" });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      passwordHash,
      displayName: displayName || username
    });

    const { accessToken, refreshToken } = signTokens(user._id.toString());
    user.refreshTokenHash = await bcrypt.hash(refreshToken, 10);
    await user.save();

    res.status(201).json({ accessToken, refreshToken, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ message: "خطای سرور در ثبت‌نام", detail: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ message: "نام کاربری/ایمیل و رمز عبور لازم است" });
    }
    const user = await User.findOne({
      $or: [{ username: identifier.toLowerCase() }, { email: identifier.toLowerCase() }]
    });
    if (!user) return res.status(401).json({ message: "کاربر یافت نشد" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ message: "رمز عبور اشتباه است" });

    const { accessToken, refreshToken } = signTokens(user._id.toString());
    user.refreshTokenHash = await bcrypt.hash(refreshToken, 10);
    await user.save();

    res.json({ accessToken, refreshToken, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ message: "خطای سرور در ورود", detail: err.message });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ message: "توکن تازه‌سازی ارسال نشده" });

    let payload;
    try {
      payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ message: "توکن تازه‌سازی نامعتبر است" });
    }

    const user = await User.findById(payload.sub);
    if (!user || !user.refreshTokenHash) return res.status(401).json({ message: "نشست منقضی شده — دوباره وارد شو" });

    const matches = await bcrypt.compare(refreshToken, user.refreshTokenHash);
    if (!matches) return res.status(401).json({ message: "نشست منقضی شده — دوباره وارد شو" });

    const tokens = signTokens(user._id.toString());
    user.refreshTokenHash = await bcrypt.hash(tokens.refreshToken, 10);
    await user.save();

    res.json(tokens);
  } catch (err) {
    res.status(500).json({ message: "خطای سرور در تازه‌سازی توکن", detail: err.message });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (token) {
      const payload = jwt.decode(token);
      if (payload?.sub) {
        await User.findByIdAndUpdate(payload.sub, { refreshTokenHash: null });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: "خطای سرور در خروج" });
  }
});

module.exports = router;
