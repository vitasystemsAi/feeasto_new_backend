const { z } = require("zod");

const DEFAULT_COUNTRY = "India";
const AD_TARGET_RADIUS_KM = 15;

const pincodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Pincode must be a 6-digit Indian PIN code");

const structuredAddressBodySchema = z.object({
  village: z.string().trim().max(120).optional().nullable(),
  city: z.string().trim().min(1).max(120),
  district: z.string().trim().min(1).max(120),
  state: z.string().trim().min(1).max(120),
  country: z.string().trim().max(80).optional().nullable(),
  pincode: pincodeSchema,
  addressLine: z.string().trim().max(500).optional().nullable(),
  latitude: z.coerce.number().min(-90).max(90).optional().nullable(),
  longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
});

function normalizeCountry(country) {
  const c = String(country || "").trim();
  return c || DEFAULT_COUNTRY;
}

function formatStructuredAddress(parts) {
  const village = String(parts.village || "").trim();
  const city = String(parts.city || "").trim();
  const district = String(parts.district || "").trim();
  const state = String(parts.state || "").trim();
  const country = normalizeCountry(parts.country);
  const pincode = String(parts.pincode || "").trim();
  const line = String(parts.addressLine || parts.address_line || "").trim();

  const segments = [];
  if (line) segments.push(line);
  if (village) segments.push(village);
  if (city) segments.push(city);
  if (district && district.toLowerCase() !== city.toLowerCase()) segments.push(district);
  segments.push(state);
  segments.push(country);
  if (pincode) segments.push(pincode);
  return segments.filter(Boolean).join(", ");
}

function parseStructuredAddressFromBody(body = {}) {
  const parsed = structuredAddressBodySchema.safeParse({
    village: body.village ?? body.addressVillage ?? null,
    city: body.city ?? body.addressCity,
    district: body.district ?? body.addressDistrict,
    state: body.state ?? body.addressState,
    country: body.country ?? body.addressCountry ?? DEFAULT_COUNTRY,
    pincode: body.pincode ?? body.addressPincode,
    addressLine: body.addressLine ?? body.address_line ?? null,
    latitude: body.latitude ?? body.addressLatitude ?? null,
    longitude: body.longitude ?? body.addressLongitude ?? null,
  });
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues };
  }
  const d = parsed.data;
  const formatted = formatStructuredAddress(d);
  return {
    ok: true,
    data: {
      village: d.village ? String(d.village).trim() : null,
      city: d.city.trim(),
      district: d.district.trim(),
      state: d.state.trim(),
      country: normalizeCountry(d.country),
      pincode: d.pincode.trim(),
      addressLine: d.addressLine ? String(d.addressLine).trim() : null,
      formattedAddress: formatted,
      latitude: d.latitude != null && !Number.isNaN(Number(d.latitude)) ? Number(d.latitude) : null,
      longitude: d.longitude != null && !Number.isNaN(Number(d.longitude)) ? Number(d.longitude) : null,
    },
  };
}

function rowToStructuredAddress(row, prefix = "") {
  if (!row) return null;
  const p = prefix ? `${prefix}_` : "";
  const city = row[`${p}city`] ?? row.city;
  if (!city && !row[`${p}pincode`] && !row.pincode) return null;
  return {
    village: row[`${p}village`] || null,
    city: city || "",
    district: row[`${p}district`] || "",
    state: row[`${p}state`] || "",
    country: normalizeCountry(row[`${p}country`]),
    pincode: row[`${p}pincode`] || "",
    addressLine: row[`${p}address_line`] || row.address_line || null,
    formattedAddress: formatStructuredAddress({
      village: row[`${p}village`],
      city,
      district: row[`${p}district`],
      state: row[`${p}state`],
      country: row[`${p}country`],
      pincode: row[`${p}pincode`],
      addressLine: row[`${p}address_line`] || row.address_line,
    }),
  };
}

function normalizePincode(value) {
  const s = String(value || "").trim();
  return /^\d{6}$/.test(s) ? s : "";
}

function normalizeDistrict(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

/** Ad is shown when untargeted, or customer matches pincode / district rules. */
function adMatchesCustomerLocation(ad, customer = {}) {
  const targetPin = normalizePincode(ad.target_pincode);
  const targetDist = normalizeDistrict(ad.target_district);
  if (!targetPin && !targetDist) return true;

  const custPin = normalizePincode(customer.pincode);
  const custDist = normalizeDistrict(customer.district);

  if (targetPin && custPin && targetPin === custPin) return true;
  if (targetDist && custDist && targetDist === custDist) {
    if (!targetPin) return true;
    if (custPin && targetPin === custPin) return true;
  }
  return false;
}

module.exports = {
  DEFAULT_COUNTRY,
  AD_TARGET_RADIUS_KM,
  structuredAddressBodySchema,
  formatStructuredAddress,
  parseStructuredAddressFromBody,
  rowToStructuredAddress,
  normalizePincode,
  normalizeDistrict,
  adMatchesCustomerLocation,
};
