function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function razorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

/**
 * @returns {Promise<{ provider: string, orderId: string, amount: number, currency: string, keyId?: string, mock?: boolean }|null>}
 */
async function createRazorpayOrder({ amountInr, receipt, notes }) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;

  const amountPaise = Math.round(roundMoney(amountInr) * 100);
  if (amountPaise < 100) {
    throw new Error("Payment amount must be at least ₹1 for online gateway.");
  }

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt: String(receipt).slice(0, 40),
      notes: notes || {},
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.description || body?.message || "Razorpay order creation failed");
  }

  return {
    provider: "RAZORPAY",
    orderId: body.id,
    amount: amountPaise,
    currency: body.currency || "INR",
    keyId,
    mock: false,
  };
}

/**
 * @param {{ amountInr: number, receipt: string, subscriberId: number, planId: number }} params
 */
async function createSubscriptionPaymentIntent(params) {
  const amount = roundMoney(params.amountInr);
  if (amount <= 0) {
    throw new Error("Payment amount must be greater than zero.");
  }

  if (razorpayConfigured()) {
    const order = await createRazorpayOrder({
      amountInr: amount,
      receipt: params.receipt,
      notes: {
        subscriberId: String(params.subscriberId),
        planId: String(params.planId),
      },
    });
    return order;
  }

  return {
    provider: "MOCK",
    orderId: `mock_${Date.now()}_${params.subscriberId}`,
    amount: Math.round(amount * 100),
    currency: "INR",
    keyId: null,
    mock: true,
  };
}

function validateSubscriptionPayment({ planPrice, collectionType, amount }) {
  const price = roundMoney(planPrice);
  const pay = roundMoney(amount);

  if (price <= 0) {
    return { ok: true, amount: 0, balanceDue: 0 };
  }
  if (pay <= 0) {
    return { ok: false, message: "Enter a payment amount greater than zero." };
  }
  if (pay > price + 0.009) {
    return { ok: false, message: `Payment amount cannot exceed plan price (₹${price.toFixed(2)}).` };
  }

  const balanceDue = roundMoney(price - pay);

  if (collectionType === "FULL") {
    if (Math.abs(pay - price) > 0.009) {
      return { ok: false, message: `Full amount must equal plan price (₹${price.toFixed(2)}).` };
    }
  } else if (collectionType === "PARTIAL" || collectionType === "ADVANCE") {
    if (pay >= price - 0.009) {
      return {
        ok: false,
        message: `${collectionType === "ADVANCE" ? "Advance" : "Partial"} payment must be less than full plan price.`,
      };
    }
  }

  return { ok: true, amount: pay, balanceDue };
}

function mapProviderToMethod(provider) {
  const p = String(provider || "").toUpperCase();
  if (p === "CASH" || p === "COD") return { paymentMethod: "COD", paymentProvider: "CASH" };
  return { paymentMethod: "ONLINE", paymentProvider: p || "RAZORPAY" };
}

module.exports = {
  roundMoney,
  razorpayConfigured,
  createRazorpayOrder,
  createSubscriptionPaymentIntent,
  validateSubscriptionPayment,
  mapProviderToMethod,
};
