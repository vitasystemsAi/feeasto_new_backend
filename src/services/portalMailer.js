const nodemailer = require("nodemailer");
const env = require("../config/env");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!env.smtpHost) return null;
  transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
  });
  return transporter;
}

async function sendPasswordResetEmail({ to, fullName, resetUrl }) {
  const transport = getTransporter();
  if (!transport) {
    // eslint-disable-next-line no-console
    console.warn("[portal] SMTP not configured; password reset email skipped for", to);
    return;
  }
  await transport.sendMail({
    from: `"${env.smtpFromName}" <${env.smtpFromEmail}>`,
    to,
    subject: "Feeasto Portal — Reset your password",
    html: `<p>Hi ${fullName},</p><p>Reset your Customer Admin portal password:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour.</p>`,
  });
}

async function sendPortalNotificationEmail({ to, title, body }) {
  const transport = getTransporter();
  if (!transport) return;
  await transport.sendMail({
    from: `"${env.smtpFromName}" <${env.smtpFromEmail}>`,
    to,
    subject: title,
    html: `<p>${body}</p>`,
  });
}

module.exports = { sendPasswordResetEmail, sendPortalNotificationEmail };
