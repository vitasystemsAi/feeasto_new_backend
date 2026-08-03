const env = require("../config/env");

/** 10-digit Indian mobile → E.164 without + */
function normalizeSmsMobile(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10 && /^[6-9]/.test(digits)) return digits;
  if (digits.length === 12 && digits.startsWith("91")) {
    const local = digits.slice(2);
    if (local.length === 10 && /^[6-9]/.test(local)) return local;
  }
  if (digits.length === 11 && digits.startsWith("0")) {
    const local = digits.slice(1);
    if (local.length === 10 && /^[6-9]/.test(local)) return local;
  }
  return null;
}

function smsConfigured() {
  return Boolean(
    env.twofactorApiKey ||
    env.textlocalApiKey ||
    env.msg91AuthKey ||
    env.fast2SmsApiKey ||
    (env.twilioAccountSid && env.twilioAuthToken && env.twilioFromNumber) ||
    env.smsWebhookUrl
  );
}

/** 2Factor.in — free test credits on signup; create OTP template FEAOTP in dashboard */
async function sendVia2Factor(mobile10, otp) {
  const key = env.twofactorApiKey;
  const template = env.twofactorOtpTemplate || "FEAOTP";
  const phone = `91${mobile10}`;
  const url = `https://2factor.in/API/V1/${encodeURIComponent(key)}/SMS/${phone}/${encodeURIComponent(String(otp))}/${encodeURIComponent(template)}`;
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`2Factor HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const status = String(data.Status || data.status || "").toLowerCase();
  if (status === "success") return { sent: true, provider: "2factor" };
  if (status === "error" || data.Details?.toLowerCase?.().includes("error")) {
    throw new Error(`2Factor: ${data.Details || data.Message || text.slice(0, 200)}`);
  }
  if (/success/i.test(text)) return { sent: true, provider: "2factor" };
  throw new Error(`2Factor: ${text.slice(0, 200)}`);
}

/** TextLocal — free trial credits on signup (India) */
async function sendViaTextLocal(mobile10, body) {
  const params = new URLSearchParams({
    apikey: env.textlocalApiKey,
    numbers: `91${mobile10}`,
    message: body,
  });
  if (env.textlocalSender) params.set("sender", env.textlocalSender);
  const res = await fetch(`https://api.textlocal.in/send/?${params.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`TextLocal HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  if (data.status !== "success") {
    const errMsg = data.errors?.[0]?.message || data.warning || JSON.stringify(data).slice(0, 200);
    throw new Error(`TextLocal: ${errMsg}`);
  }
  return { sent: true, provider: "textlocal" };
}

async function sendViaMsg91(mobile10, otp, expiresMinutes) {
  const authkey = env.msg91AuthKey;
  const sender = env.msg91SenderId || "FEASTR";
  const message =
    env.msg91OtpMessage ||
    `Your Feeasto verification code is ##OTP##. Valid for ${expiresMinutes} minutes. Do not share.`;
  const params = new URLSearchParams({
    authkey,
    mobile: `91${mobile10}`,
    sender,
    otp: String(otp),
    message,
    otp_expiry: String(Math.max(1, expiresMinutes)),
  });
  const url = `https://control.msg91.com/api/sendotp.php?${params.toString()}`;
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MSG91 HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (/^error/i.test(text) || text.toLowerCase().includes("invalid")) {
    throw new Error(`MSG91: ${text.slice(0, 200)}`);
  }
  return { sent: true, provider: "msg91" };
}

async function sendViaFast2Sms(mobile10, otp) {
  const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: {
      authorization: env.fast2SmsApiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      route: "otp",
      variables_values: String(otp),
      numbers: mobile10,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.return === false) {
    throw new Error(`Fast2SMS: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { sent: true, provider: "fast2sms" };
}

async function sendViaTwilio(mobile10, body) {
  const auth = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString("base64");
  const params = new URLSearchParams({
    To: `+91${mobile10}`,
    From: env.twilioFromNumber,
    Body: body,
  });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twilio: ${errText.slice(0, 200)}`);
  }
  return { sent: true, provider: "twilio" };
}

async function sendViaWebhook(mobile10, body, otp) {
  const res = await fetch(env.smsWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: mobile10, mobile: `91${mobile10}`, message: body, otp }),
  });
  if (!res.ok) throw new Error(`SMS webhook HTTP ${res.status}`);
  return { sent: true, provider: "webhook" };
}

function buildSmsTryOrder() {
  const provider = String(env.smsProvider || "").toLowerCase();
  const preferred = [];
  const add = (name, enabled) => {
    if (enabled) preferred.push(name);
  };

  if (provider === "2factor") add("2factor", env.twofactorApiKey);
  else if (provider === "textlocal") add("textlocal", env.textlocalApiKey);
  else if (provider === "fast2sms") add("fast2sms", env.fast2SmsApiKey);
  else if (provider === "msg91") add("msg91", env.msg91AuthKey);
  else if (provider === "twilio") {
    add("twilio", env.twilioAccountSid && env.twilioAuthToken && env.twilioFromNumber);
  }

  add("2factor", env.twofactorApiKey);
  add("textlocal", env.textlocalApiKey);
  add("fast2sms", env.fast2SmsApiKey);
  add("msg91", env.msg91AuthKey);
  add("twilio", env.twilioAccountSid && env.twilioAuthToken && env.twilioFromNumber);
  add("webhook", env.smsWebhookUrl);

  return [...new Set(preferred)];
}

/**
 * Send SMS OTP to Indian mobile. Configure TWOFACTOR_API_KEY, TEXTLOCAL_API_KEY, etc. in .env.
 */
async function sendPasswordResetOtpSms({ to, otp, expiresMinutes = 5 }) {
  const mobile10 = normalizeSmsMobile(to);
  if (!mobile10) {
    return { sent: false, reason: "invalid_phone" };
  }

  const body = `Your Feeasto OTP is ${otp}. Valid for ${expiresMinutes} min. Do not share this code.`;

  const unique = buildSmsTryOrder();

  if (!unique.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[sms] NOT SENT to ${mobile10} — add TWOFACTOR_API_KEY or FAST2SMS_API_KEY (free trial) in backend/.env`
    );
    if (env.nodeEnv !== "production") {
      // eslint-disable-next-line no-console
      console.log(`[sms-dev] OTP for +91${mobile10}: ${otp}`);
    }
    return { sent: false, reason: "sms_not_configured" };
  }

  const errors = [];
  for (const name of unique) {
    try {
      if (name === "2factor") return await sendVia2Factor(mobile10, otp);
      if (name === "textlocal") return await sendViaTextLocal(mobile10, body);
      if (name === "msg91") return await sendViaMsg91(mobile10, otp, expiresMinutes);
      if (name === "fast2sms") return await sendViaFast2Sms(mobile10, otp);
      if (name === "twilio") return await sendViaTwilio(mobile10, body);
      if (name === "webhook") return await sendViaWebhook(mobile10, body, otp);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
      // eslint-disable-next-line no-console
      console.error(`[sms] ${name} failed for ${mobile10}:`, err.message);
    }
  }

  return { sent: false, reason: "all_providers_failed", details: errors.join("; ") };
}

module.exports = { sendPasswordResetOtpSms, smsConfigured, normalizeSmsMobile };
