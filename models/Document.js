// models/Document.js
// Stores only metadata + the R2 object key. Never stores raw file bytes in Mongo.

const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    complianceTask: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceTask' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    objectKey: { type: String, required: true, unique: true }, // path inside the R2 bucket
    originalFilename: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },

    documentType: {
      type: String,
      enum: [
        'tax_return',
        'financial_statement',
        'registration_certificate',
        'bank_statement',
        'acknowledgement',
        'certificate',
        'filing_copy',
        'other',
      ],
      default: 'other',
    },

    status: {
      type: String,
      enum: ['pending_review', 'accepted', 'rejected'],
      default: 'pending_review',
    },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewNotes: String,
  },
  { timestamps: true }
);

documentSchema.index({ company: 1, complianceTask: 1 });

module.exports = mongoose.model('Document', documentSchema);
