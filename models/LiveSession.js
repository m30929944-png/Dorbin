const mongoose = require("mongoose");

const liveSessionSchema = new mongoose.Schema(
  {
    host: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, default: "" },
    status: { type: String, enum: ["live", "ended"], default: "live", index: true },
    streamKey: { type: String, required: true },
    viewerCount: { type: Number, default: 0 },
    endedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("LiveSession", liveSessionSchema);
