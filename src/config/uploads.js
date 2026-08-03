const path = require("path");

/** Single source of truth for menu/restaurant file uploads (must match express.static). */
const uploadDir = path.resolve(__dirname, "..", "..", "uploads");

module.exports = { uploadDir };
