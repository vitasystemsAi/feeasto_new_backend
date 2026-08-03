const fs = require("fs");
const path = require("path");

const { uploadDir } = require("../config/uploads");
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

let cache = { mtimeMs: 0, byKey: new Map(), files: [] };

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function fileNameToKey(filename) {
  const base = path.basename(filename, path.extname(filename));
  const dash = base.indexOf("-");
  const slug = dash >= 0 ? base.slice(dash + 1) : base;
  return normalizeKey(slug);
}

function refreshIndexIfNeeded() {
  let mtimeMs = 0;
  try {
    const st = fs.statSync(uploadDir);
    mtimeMs = st.mtimeMs;
  } catch {
    cache = { mtimeMs: 0, byKey: new Map(), files: [] };
    return cache;
  }
  if (cache.mtimeMs === mtimeMs && cache.files.length) return cache;

  const byKey = new Map();
  const files = [];
  let entries = [];
  try {
    entries = fs.readdirSync(uploadDir, { withFileTypes: true });
  } catch {
    cache = { mtimeMs, byKey, files };
    return cache;
  }

  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const webPath = `/uploads/${ent.name}`;
    const key = fileNameToKey(ent.name);
    files.push({ name: ent.name, webPath, key });
    if (!byKey.has(key)) byKey.set(key, webPath);
  }

  cache = { mtimeMs, byKey, files };
  return cache;
}

function uploadFileExists(webPath) {
  if (!webPath || !String(webPath).startsWith("/uploads/")) return false;
  const name = path.basename(webPath);
  try {
    return fs.existsSync(path.join(uploadDir, name));
  } catch {
    return false;
  }
}

function normalizeStoredUploadPath(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/uploads/")) return s;
  if (s.startsWith("uploads/")) return `/${s}`;
  if (!s.includes("/")) return `/uploads/${s}`;
  return s;
}

/** Resolve /uploads/... only when the file exists, or exact slug match to item name (no fuzzy guess). */
function resolveMenuItemUploadPath(itemName, storedImageUrl) {
  const normalized = normalizeStoredUploadPath(storedImageUrl);
  if (normalized && /^https?:\/\//i.test(normalized)) return normalized;
  if (normalized && uploadFileExists(normalized)) return normalized;

  const index = refreshIndexIfNeeded();
  const itemKey = normalizeKey(itemName);
  if (itemKey && index.byKey.has(itemKey)) return index.byKey.get(itemKey);

  return null;
}

function resolveMenuItemDiskPath(webPath) {
  const normalized = normalizeStoredUploadPath(webPath);
  if (!normalized || /^https?:\/\//i.test(normalized)) return null;
  if (!uploadFileExists(normalized)) return null;
  return path.join(uploadDir, path.basename(normalized));
}

module.exports = {
  uploadDir,
  resolveMenuItemUploadPath,
  resolveMenuItemDiskPath,
  normalizeStoredUploadPath,
  uploadFileExists,
  refreshIndexIfNeeded,
};
