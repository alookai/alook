import { DEFAULT_MESSAGE_PAGE_SIZE, MAX_MESSAGE_PAGE_SIZE } from "@alook/shared"

// Format file sizes for display
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Parse cursor from query params (format: "createdAt|id")
export function parseCursor(cursorParam: string | null): { createdAt: string; id: string } | undefined {
  if (!cursorParam) return undefined
  const [createdAt, id] = cursorParam.split("|")
  if (createdAt && id) return { createdAt, id }
  return undefined
}

// Parse a member cursor from query params (format: "joinedAt|id"). Members
// paginate on the `joinedAt` timestamp — a sibling of `parseCursor` above
// with a different keying field, kept separate so both stay narrowly typed.
export function parseMemberCursor(cursorParam: string | null): { joinedAt: string; id: string } | undefined {
  if (!cursorParam) return undefined
  const [joinedAt, id] = cursorParam.split("|")
  if (joinedAt && id) return { joinedAt, id }
  return undefined
}

// Parse page size from query params with bounds
export function parsePageSize(limitParam: string | null): number {
  if (!limitParam) return DEFAULT_MESSAGE_PAGE_SIZE
  return Math.min(Math.max(parseInt(limitParam, 10) || DEFAULT_MESSAGE_PAGE_SIZE, 1), MAX_MESSAGE_PAGE_SIZE)
}

// Parse a positive integer query param with default + ceiling.
export function parseBoundedInt(
  param: string | null,
  defaultValue: number,
  max: number,
  min = 1,
): number {
  if (!param) return defaultValue
  const n = parseInt(param, 10)
  if (!Number.isFinite(n) || Number.isNaN(n)) return defaultValue
  return Math.min(Math.max(n, min), max)
}

// Build next cursor string from the last item, or undefined if no more pages
export function buildPaginatedResponse<T extends { createdAt: string; id: string }>(
  rows: T[],
  pageSize: number
): { items: T[]; hasMore: boolean; cursor: string | undefined } {
  const hasMore = rows.length > pageSize
  const items = hasMore ? rows.slice(0, pageSize) : rows
  const cursor = hasMore && items.length > 0
    ? `${items[items.length - 1].createdAt}|${items[items.length - 1].id}`
    : undefined
  return { items, hasMore, cursor }
}

// Build a paginated member response — same shape as buildPaginatedResponse but
// the cursor is keyed on `joinedAt`. The shared query returns `hasMore` + a
// typed `{ joinedAt, id }` cursor already; this helper encodes that as the
// URL-transport string. Callers pass the raw rows plus a pre-computed
// hasMore/cursor from the query (so the "sliced +1" logic doesn't run twice).
export function buildMemberPaginatedResponse<T extends { joinedAt: string; id: string }>(
  members: T[],
  hasMore: boolean,
): { members: T[]; hasMore: boolean; cursor: string | undefined } {
  const cursor = hasMore && members.length > 0
    ? `${members[members.length - 1].joinedAt}|${members[members.length - 1].id}`
    : undefined
  return { members, hasMore, cursor }
}

// Group raw attachment rows by messageId into display format
export function groupAttachments(
  attachments: Array<{ messageId: string; filename: string; url: string; contentType: string | null; size: number | null }>
): Record<string, Array<{ kind: "image" | "file"; name: string; url: string; size?: string }>> {
  const map: Record<string, Array<{ kind: "image" | "file"; name: string; url: string; size?: string }>> = {}
  for (const a of attachments) {
    const kind = a.contentType?.startsWith("image/") ? "image" : "file"
    const entry = { kind, name: a.filename, url: a.url, ...(kind === "file" && a.size ? { size: formatBytes(a.size) } : {}) } as { kind: "image" | "file"; name: string; url: string; size?: string }
    ;(map[a.messageId] ??= []).push(entry)
  }
  return map
}

// Group raw reaction rows by messageId into aggregated display format
export function groupReactions(
  reactions: Array<{ messageId: string; emoji: string; userId: string }>,
  currentUserId: string
): Record<string, Array<{ emoji: string; count: number; me: boolean; userIds: string[] }>> {
  const map: Record<string, Array<{ emoji: string; count: number; me: boolean; userIds: string[] }>> = {}
  for (const r of reactions) {
    const list = (map[r.messageId] ??= [])
    const existing = list.find((x) => x.emoji === r.emoji)
    if (existing) {
      existing.count++
      existing.userIds.push(r.userId)
      if (r.userId === currentUserId) existing.me = true
    } else {
      list.push({ emoji: r.emoji, count: 1, me: r.userId === currentUserId, userIds: [r.userId] })
    }
  }
  return map
}
