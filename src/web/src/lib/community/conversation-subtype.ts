export type ConversationSubtype = "unknown" | "text" | "forum" | "thread"

/**
 * Persisted route data may describe a skeleton subtype, but it cannot authorize
 * mounting the conversation content surface.
 */
export function resolveConversationSubtype({
  routeLifecycle,
  accessAllowed,
  isChild,
  isForum,
  structuralHint = "unknown",
}: {
  routeLifecycle: "pending" | "ready" | "terminal-error"
  accessAllowed: boolean
  isChild: boolean
  isForum: boolean
  structuralHint?: ConversationSubtype
}): ConversationSubtype {
  if (routeLifecycle === "pending") return structuralHint
  if (routeLifecycle !== "ready" || !accessAllowed) return "unknown"
  if (isChild) return "thread"
  return isForum ? "forum" : "text"
}
