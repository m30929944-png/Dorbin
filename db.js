const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI در .env تنظیم نشده — یه دیتابیس واقعی MongoDB Atlas بساز و آدرسش رو بذار.");
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);
  console.log("✅ اتصال به MongoDB برقرار شد");

  mongoose.connection.on("error", (err) => {
    console.error("❌ خطای اتصال MongoDB:", err.message);
  });
}

module.exports = connectDB;
