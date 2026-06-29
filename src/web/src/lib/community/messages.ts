import { DEFAULT_MESSAGE_PAGE_SIZE, MAX_MESSAGE_PAGE_SIZE } from "@alook/shared"

// Format file sizes for display
export function formatBytes(bytes: number): string {
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

// Parse page size from query params with bounds
export function parsePageSize(limitParam: string | null): number {
  if (!limitParam) return DEFAULT_MESSAGE_PAGE_SIZE
  return Math.min(Math.max(parseInt(limitParam, 10) || DEFAULT_MESSAGE_PAGE_SIZE, 1), MAX_MESSAGE_PAGE_SIZE)
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
