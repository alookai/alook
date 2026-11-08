import type { CommunityBotAuditEvent } from "@alook/shared"

export type AuditKind = CommunityBotAuditEvent["kind"]

export type AuditEvent = {
  id: string
  kind: AuditKind
  payload: unknown
  sessionId: string | null
  launchId: string | null
  createdAt: string
}

export type AuditLogPage = {
  events: AuditEvent[]
  nextCursor: { beforeCreatedAt: string; beforeId: string } | null
  liveIds?: string[]
}

export function compareAuditEventsNewestFirst(
  left: Pick<AuditEvent, "createdAt" | "id">,
  right: Pick<AuditEvent, "createdAt" | "id">,
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1
  return left.id > right.id ? -1 : left.id < right.id ? 1 : 0
}
