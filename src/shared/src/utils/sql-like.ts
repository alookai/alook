/**
 * Escape user input destined for a SQL LIKE pattern.
 *
 * `%` and `_` are wildcards in LIKE; if user-supplied text isn't escaped,
 * a single character is enough to bypass intended search semantics
 * (e.g. searching for `%` matches every row). Drizzle parameterises the
 * value but not the wildcards inside it.
 *
 * Use with `like(col, `%${escapeLikePattern(input)}%`)` and pair with
 * the matching `ESCAPE '\\'` clause if your driver requires it (D1 / SQLite
 * supports the backslash escape natively via `LIKE ? ESCAPE '\\'`).
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (m) => "\\" + m)
}
