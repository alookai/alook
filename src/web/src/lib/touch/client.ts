export function isTouchClient(verification: unknown): boolean {
  return !!verification && typeof verification === "object" && !Array.isArray(verification) && "client_type" in verification && verification.client_type === "touch"
}
