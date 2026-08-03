function parsePagination(query, defaults = { page: 1, limit: 20, maxLimit: 100 }) {
  const page = Math.max(1, Number(query.page) || defaults.page);
  const limit = Math.min(defaults.maxLimit, Math.max(1, Number(query.limit) || defaults.limit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function paginatedResponse(rows, total, page, limit) {
  return {
    data: rows,
    pagination: {
      page,
      limit,
      total: Number(total || 0),
      totalPages: Math.ceil(Number(total || 0) / limit) || 1,
    },
  };
}

/** mysql2 can fail on prepared LIMIT/OFFSET placeholders — use validated inline clause */
function sqlLimitClause(limit, offset) {
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)));
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  return `LIMIT ${lim} OFFSET ${off}`;
}

function sqlLimitOnly(limit) {
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)));
  return `LIMIT ${lim}`;
}

module.exports = { parsePagination, paginatedResponse, sqlLimitClause, sqlLimitOnly };
