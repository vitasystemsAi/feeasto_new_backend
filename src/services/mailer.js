const nodemailer = require("nodemailer");
const env = require("../config/env");

let transporter = null;
let warmupDone = false;

function smtpConfigured() {
  return Boolean(env.smtpHost && env.smtpPort && env.smtpUser && env.smtpPass && env.smtpFromEmail);
}

function getTransporter() {
  if (!smtpConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      requireTLS: !env.smtpSecure && Number(env.smtpPort) === 587,
      auth: {
        user: env.smtpUser,
        pass: env.smtpPass,
      },
      connectionTimeout: 12_000,
      greetingTimeout: 12_000,
      socketTimeout: 20_000,
    });
  }
  return transporter;
}

/** Pre-open SMTP connection so first OTP email is faster. */
async function warmSmtpConnection() {
  if (warmupDone || !smtpConfigured()) return;
  const tx = getTransporter();
  if (!tx) return;
  try {
    await tx.verify();
    warmupDone = true;
    // eslint-disable-next-line no-console
    console.log("[mailer] SMTP connection ready");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[mailer] SMTP warmup failed:", err.message);
  }
}

async function sendMailFast({ to, subject, text, html }) {
  const tx = getTransporter();
  if (!tx) {
    throw new Error("SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM_EMAIL.");
  }
  return tx.sendMail({
    from: `"${env.smtpFromName}" <${env.smtpFromEmail}>`,
    to,
    subject,
    text,
    html,
  });
}

async function sendRegistrationOtpEmail({ to, otp, fullName, expiresInMinutes }) {
  const displayName = fullName || "there";
  const html = `
    <div style="font-family: Arial, sans-serif; color: #111; line-height: 1.5;">
      <h2 style="margin: 0 0 8px;">Verify your feeasto.com account</h2>
      <p style="margin: 0 0 12px;">Hi ${displayName},</p>
      <p style="margin: 0 0 12px;">Your verification code:</p>
      <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px; margin: 8px 0 14px;">${otp}</p>
      <p style="margin: 0 0 8px;">Expires in ${expiresInMinutes} minutes.</p>
    </div>
  `;
  await sendMailFast({
    to,
    subject: "Your feeasto.com verification code",
    text: `Your Feeasto code is ${otp}. Expires in ${expiresInMinutes} minutes.`,
    html,
  });
}

async function sendPasswordResetOtpEmail({ to, otp, expiresInMinutes }) {
  const html = `
    <div style="font-family: Arial, sans-serif; color: #111; line-height: 1.5;">
      <h2 style="margin: 0 0 8px;">Password reset code</h2>
      <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px; margin: 8px 0 14px;">${otp}</p>
      <p style="margin: 0 0 8px;">Expires in ${expiresInMinutes} minutes.</p>
    </div>
  `;
  await sendMailFast({
    to,
    subject: "Feeasto password reset code",
    text: `Your verification code is ${otp}. Expires in ${expiresInMinutes} minutes.`,
    html,
  });
}

module.exports = {
  sendRegistrationOtpEmail,
  sendPasswordResetOtpEmail,
  smtpConfigured,
  warmSmtpConnection,
};
