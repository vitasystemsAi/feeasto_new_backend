const DEFAULT_AD_IMAGE_URL =
  "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=1200&h=600&fit=crop";

function imageUrlFromRedirectUrl(url) {
  if (!url) return null;
  const u = String(url).trim();
  const match = u.match(
    /(?:youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  if (match) return `https://img.youtube.com/vi/${match[1]}/maxresdefault.jpg`;
  if (/^https?:\/\//i.test(u) && !u.includes("unsplash.com")) return u;
  return null;
}

function isGenericPlaceholder(url) {
  if (!url) return true;
  const u = String(url).trim();
  return !u || u === DEFAULT_AD_IMAGE_URL || u.includes("unsplash.com");
}

function isUploadedAsset(url) {
  return String(url || "").includes("/uploads/");
}

function resolveAdImageUrl(file, bodyImageUrl, redirectUrl) {
  if (file) return `/uploads/portal-ads/${file.filename}`;
  const explicit = bodyImageUrl && String(bodyImageUrl).trim();
  if (explicit && !isGenericPlaceholder(explicit)) return explicit;
  const fromRedirect = imageUrlFromRedirectUrl(redirectUrl);
  if (fromRedirect) return fromRedirect;
  return DEFAULT_AD_IMAGE_URL;
}

function resolveStoredImageUrl(imageUrl, redirectUrl) {
  const stored = imageUrl && String(imageUrl).trim();
  const fromRedirect = imageUrlFromRedirectUrl(redirectUrl);
  const fromStoredAsUrl = imageUrlFromRedirectUrl(stored);

  if (stored && isUploadedAsset(stored)) return stored;
  if (fromRedirect) return fromRedirect;
  if (stored && /^https?:\/\//i.test(stored) && !isGenericPlaceholder(stored)) return stored;
  if (fromStoredAsUrl) return fromStoredAsUrl;
  if (stored) return stored;
  return DEFAULT_AD_IMAGE_URL;
}

module.exports = {
  DEFAULT_AD_IMAGE_URL,
  imageUrlFromRedirectUrl,
  resolveAdImageUrl,
  resolveStoredImageUrl,
};
