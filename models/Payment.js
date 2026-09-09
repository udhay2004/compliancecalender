// models/Payment.js

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    complianceTask: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceTask', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },

    amountCents: { type: Number, required: true }, // Razorpay works in the smallest currency unit (cents for USD)
    currency: { type: String, default: 'USD' },

    method: { type: String, enum: ['razorpay', 'bank_transfer'], default: 'razorpay' },

    status: {
      type: String,
      enum: ['created', 'pending', 'processing', 'paid', 'failed', 'refunded', 'awaiting_verification'],
      default: 'created',
    },

    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // for manual bank transfer confirms
    notes: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', paymentSchema);
