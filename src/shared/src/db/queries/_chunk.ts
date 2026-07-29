// Cloudflare D1 rejects any single SQL statement binding more than 100
// parameters (SQLite SQLITE_MAX_VARIABLE_NUMBER = 100 in the D1 build). Queries
// that build a WHERE `inArray(col, ids)` or a bulk INSERT `values(rows)` from an
// unbounded runtime array must slice the array so no single statement crosses
// the limit. These helpers centralize that arithmetic — spec, not incidental.
export const D1_MAX_BIND_PARAMS = 100;

// Safe slice size for an `inArray(col, ids)` whose statement also binds a
// handful of fixed WHERE params (userId, read flag, join-baseline guard,
// correlated subselects, ...). None of the chunked sites carry more than ~10
// such fixed params, so 90 keeps every statement's total <= 100. Chunk id
// arrays at this size, not at D1_MAX_BIND_PARAMS, so the fixed params fit.
export const D1_MAX_IN_PARAMS = 90;

/**
 * Split `arr` into ordered slices of at most `size` elements. `chunk([], n)`
 * returns `[]`; order is preserved. `size` must be >= 1.
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Max rows per bulk-insert statement given the REAL number of bind params each
 * row emits. `paramsPerRow` is the emitted bind count — Drizzle binds every
 * non-disabled column of each row, including a `$defaultFn` primary key and
 * columns with a literal `default(...)`, so count from the built statement, not
 * the "logical" columns. floor(100 / paramsPerRow) keeps rows*paramsPerRow
 * <= D1_MAX_BIND_PARAMS (the limit rejects > 100, so hitting exactly 100 is fine).
 */
export function maxRowsPerInsert(paramsPerRow: number): number {
  if (paramsPerRow < 1) throw new Error("paramsPerRow must be >= 1");
  return Math.floor(D1_MAX_BIND_PARAMS / paramsPerRow);
}
