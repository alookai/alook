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
