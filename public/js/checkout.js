// public/js/checkout.js
//
// Include this BEFORE this script tag on any page that calls payForTask():
// <script src="https://checkout.razorpay.com/v1/checkout.js"></script>

async function payForTask(complianceTaskId, amountRupees) {
  const orderRes = await fetch('/api/payments/create-order', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify({ complianceTaskId, amountRupees }),
  });
  const order = await orderRes.json();

  if (!orderRes.ok) {
    alert(order.error || 'Could not start payment');
    return;
  }

  const options = {
    key: order.keyId,
    amount: order.amount,
    currency: order.currency,
    name: 'ComplyGlobally',
    description: 'Compliance filing service',
    order_id: order.orderId,
    handler: async function (response) {
      const verifyRes = await fetch('/api/payments/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAuthToken()}`,
        },
        body: JSON.stringify(response),
      });
      const result = await verifyRes.json();

      if (verifyRes.ok) {
        window.location.href = `/dashboard/task/${complianceTaskId}?payment=success`;
      } else {
        alert('Payment verification failed — contact support if you were charged.');
      }
    },
    prefill: {
      // name: currentUser.name, email: currentUser.email, contact: currentUser.phone
    },
    theme: { color: '#0f172a' },
  };

  const rzp = new Razorpay(options);
  rzp.on('payment.failed', function (response) {
    alert(`Payment failed: ${response.error.description}`);
  });
  rzp.open();
}

function getAuthToken() {
  return localStorage.getItem('authToken'); // adjust to however your JWT is stored client-side
}
