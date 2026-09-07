const READ_ONLY_POST_PATHS = new Set([
  "/api/community/messages/batch",
  "/api/community/messages/tags/batch",
  "/api/community/channels/participants/batch",
  "/api/community/replica/bootstrap",
  "/api/community/replica/delta",
])

/**
 * Classify browser traffic by business semantics rather than HTTP verb alone.
 * Replica bootstrap/delta and the legacy batch query doors are reads expressed
 * as POSTs. Replica intents are deliberately absent: they remain mutations.
 */
export function isClientMutationRequest(method: string, pathname: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return false
  return method !== "POST" || !READ_ONLY_POST_PATHS.has(pathname)
}
