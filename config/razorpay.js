// config/razorpay.js
// Install: npm install razorpay
//
// Lazy-initialized so a missing key doesn't crash the whole server on boot.
// Razorpay is only ever touched inside route handlers (create-order), so we
// build the client on first use instead of at require() time.

const Razorpay = require('razorpay');

let client = null;

function getRazorpay() {
  if (client) return client;

  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.warn('[razorpay] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — payments will fail.');
    const err = new Error('Payments are not configured yet.');
    err.code = 'RAZORPAY_NOT_CONFIGURED';
    throw err;
  }

  client = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  return client;
}

// Proxy so existing call sites (`razorpay.orders.create(...)`) don't need
// to change — property access is deferred until actually used.
module.exports = new Proxy(
  {},
  {
    get(_target, prop) {
      return getRazorpay()[prop];
    },
  }
);
