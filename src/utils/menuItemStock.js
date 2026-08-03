/** Same rules as frontend menuItemStock.js */
function isMenuItemInStock(row) {
  if (!row || Number(row.is_active) === 0 || Number(row.is_available) === 0) return false;
  const raw = row.available_stock;
  if (raw == null || raw === "") return true;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return true;
  return n > 0;
}

module.exports = { isMenuItemInStock };
