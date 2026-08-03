function normalizeCategoryKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function titleCaseFromKey(key) {
  return String(key || "")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

module.exports = { normalizeCategoryKey, titleCaseFromKey };
