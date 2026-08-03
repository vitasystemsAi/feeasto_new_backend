/** Normalize Indian mobile to 10 digits (no country code). */
function normalizeIndianPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
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

function validateIndianPhone(value) {
  const normalized = normalizeIndianPhone(value);
  if (!normalized) {
    return { ok: false, message: "Enter a valid 10-digit Indian mobile number." };
  }
  return { ok: true, phone: normalized };
}

module.exports = { normalizeIndianPhone, validateIndianPhone };
