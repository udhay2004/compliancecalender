// models/Counter.js — atomic sequence numbers (invoice and credit-note
// numbering). findOneAndUpdate with $inc is atomic in MongoDB, so two
// payments at the same moment can never get the same number.
const mongoose = require("mongoose");

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // e.g. "invoice:2026-27"
  seq: { type: Number, default: 0 },
});

counterSchema.statics.next = async function next(name) {
  const doc = await this.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return doc.seq;
};

module.exports = mongoose.model("Counter", counterSchema);
