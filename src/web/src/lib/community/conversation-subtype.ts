export type ConversationSubtype = "unknown" | "text" | "forum" | "thread"

/**
 * Persisted route data may describe a subtype, but it cannot authorize showing
 * that subtype. Canonical metadata and the current navigation access proof must
 * both be ready first.
 */
export function resolveConversationSubtype({
  routeLifecycle,
  accessAllowed,
  isChild,
  isForum,
}: {
  routeLifecycle: "pending" | "ready" | "terminal-error"
  accessAllowed: boolean
  isChild: boolean
  isForum: boolean
}): ConversationSubtype {
  if (routeLifecycle !== "ready" || !accessAllowed) return "unknown"
  if (isChild) return "thread"
  return isForum ? "forum" : "text"
}
