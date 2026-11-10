export function isRejectedSession(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false
  return error.status === 401 || error.status === 403
}
