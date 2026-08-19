// config/r2.js
// Cloudflare R2 client (S3-compatible API).
// Install: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

const { S3Client } = require('@aws-sdk/client-s3');

const REQUIRED_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.warn(`[r2] Missing env var ${key} — document upload/download will fail until this is set.`);
  }
}

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

module.exports = {
  r2Client,
  bucketName: process.env.R2_BUCKET_NAME,
};
