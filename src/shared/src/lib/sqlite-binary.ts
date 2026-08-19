/** Matches SQLite BINARY ordering for the ASCII ids and ISO timestamps used by Alook. */
export function compareAsciiSqliteBinary(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
