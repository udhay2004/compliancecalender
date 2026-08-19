// routes/documents.js
//
// ADJUST: this file assumes `middleware/auth.js` exports `requireAuth`, which sets
// req.user = { id, role, companyId }. If your existing middleware uses different names,
// just change the import on the line below — nothing else in this file needs to change.
const { requireAuth } = require('../middleware/auth');

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { r2Client, bucketName } = require('../config/r2');
const Document = require('../models/Document');

const router = express.Router();

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

/**
 * STEP 1 — Client asks for a signed PUT URL before uploading anything.
 * POST /api/documents/upload-url
 * body: { filename, mimeType, sizeBytes, companyId, complianceTaskId, documentType }
 */
router.post('/upload-url', requireAuth, async (req, res) => {
  try {
    const { filename, mimeType, sizeBytes, companyId, complianceTaskId, documentType } = req.body;

    if (!filename || !mimeType || !sizeBytes || !companyId) {
      return res.status(400).json({ error: 'filename, mimeType, sizeBytes and companyId are required' });
    }
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return res.status(400).json({ error: `File type ${mimeType} is not allowed` });
    }
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      return res.status(400).json({ error: 'File exceeds the 25MB limit' });
    }

    // Resource-level authorization: a client can only upload for their own company.
    if (req.user.role === 'client' && String(req.user.companyId) !== String(companyId)) {
      return res.status(403).json({ error: 'Not authorized to upload for this company' });
    }

    const ext = path.extname(filename);
    const objectKey = `companies/${companyId}/documents/${crypto.randomUUID()}${ext}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      ContentType: mimeType,
    });

    const signedUrl = await getSignedUrl(r2Client, command, { expiresIn: 300 }); // 5 min to upload

    // Pre-create the Document record; the client confirms once the PUT actually succeeds.
    const doc = await Document.create({
      company: companyId,
      complianceTask: complianceTaskId || undefined,
      uploadedBy: req.user.id,
      objectKey,
      originalFilename: filename,
      mimeType,
      sizeBytes,
      documentType: documentType || 'other',
      status: 'pending_review',
    });

    res.json({ uploadUrl: signedUrl, documentId: doc._id, objectKey });
  } catch (err) {
    console.error('[documents] upload-url error:', err);
    res.status(500).json({ error: 'Could not generate upload URL' });
  }
});

/**
 * STEP 2 — Client confirms the upload succeeded after PUTting directly to R2.
 * POST /api/documents/:id/confirm
 */
router.post('/:id/confirm', requireAuth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    // Optional hardening: HEAD the object in R2 here to verify it actually landed
    // before trusting the client's "done" signal.
    res.json({ ok: true, document: doc });
  } catch (err) {
    console.error('[documents] confirm error:', err);
    res.status(500).json({ error: 'Could not confirm upload' });
  }
});

/**
 * GET /api/documents/:id/view — returns a short-lived signed GET URL.
 * Never returns a permanent/public R2 URL.
 */
router.get('/:id/view', requireAuth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Client A must never fetch Client B's document, even with a valid document ID.
    if (req.user.role === 'client' && String(req.user.companyId) !== String(doc.company)) {
      return res.status(403).json({ error: 'Not authorized to view this document' });
    }

    const command = new GetObjectCommand({ Bucket: bucketName, Key: doc.objectKey });
    const signedUrl = await getSignedUrl(r2Client, command, { expiresIn: 120 }); // 2 min

    res.json({ url: signedUrl, filename: doc.originalFilename });
  } catch (err) {
    console.error('[documents] view error:', err);
    res.status(500).json({ error: 'Could not generate view URL' });
  }
});

/**
 * GET /api/documents?companyId=&complianceTaskId=
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { companyId, complianceTaskId } = req.query;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });

    if (req.user.role === 'client' && String(req.user.companyId) !== String(companyId)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const filter = { company: companyId };
    if (complianceTaskId) filter.complianceTask = complianceTaskId;

    const docs = await Document.find(filter).sort({ createdAt: -1 });
    res.json({ documents: docs });
  } catch (err) {
    console.error('[documents] list error:', err);
    res.status(500).json({ error: 'Could not list documents' });
  }
});

/**
 * DELETE /api/documents/:id
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    if (req.user.role === 'client' && String(req.user.companyId) !== String(doc.company)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await r2Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: doc.objectKey }));
    await doc.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    console.error('[documents] delete error:', err);
    res.status(500).json({ error: 'Could not delete document' });
  }
});

module.exports = router;
