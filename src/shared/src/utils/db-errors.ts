/**
 * Returns true when the error represents a SQLite UNIQUE constraint violation,
 * whether thrown directly by the driver or wrapped by DrizzleQueryError (0.44+).
 */
export function isUniqueConstraintError(err: unknown, expectedColumns?: readonly string[]): boolean {
  if (err instanceof Error) {
    const e = err as Error & { code?: string; cause?: unknown };
    if (expectedColumns) {
      if (e.cause instanceof Error) return isUniqueConstraintError(e.cause, expectedColumns);
      const signature = e.message.match(/UNIQUE constraint failed:\s*([^:\n]+)/)?.[1];
      const columns = signature?.split(",").map((column) => column.trim());
      if (!columns || expectedColumns.length === 0 || columns.length !== expectedColumns.length) return false;
      return expectedColumns.every((column, index) => columns[index] === column);
    }
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    if (e.message.includes("UNIQUE")) return true;
    // DrizzleQueryError (0.44+) wraps the driver error as .cause
    if (e.cause) return isUniqueConstraintError(e.cause);
  }
  return false;
}
