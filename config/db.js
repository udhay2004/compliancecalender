// config/db.js
//
// One job: connect to MongoDB using MONGODB_URI from .env.
// Exits the process on failure at startup so you never silently run with
// "no database" again (that was the whole problem we're fixing).

const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error(
      "\n[startup error] MONGODB_URI is not set.\n" +
      "Add it to your .env — a MongoDB Atlas connection string looks like:\n" +
      "mongodb+srv://<user>:<password>@<cluster>.mongodb.net/compliance_calendar\n"
    );
    process.exit(1);
  }

  mongoose.set("strictQuery", true);

  try {
    await mongoose.connect(uri);
    console.log(`[db] Connected to MongoDB (${mongoose.connection.name})`);
  } catch (err) {
    console.error("[db] Failed to connect to MongoDB:", err.message);
    process.exit(1);
  }

  mongoose.connection.on("error", (err) => {
    console.error("[db] Connection error after startup:", err.message);
  });
}

module.exports = { connectDB };
