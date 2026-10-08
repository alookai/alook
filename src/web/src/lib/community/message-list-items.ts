import { deriveView, viewEvidence } from "@/lib/observability/data-source"
import { dateKey, formatDateLabel } from "./format-time"
import type { Msg, RenderMsg } from "./models/message"

function messageDisplayKey(message: Msg): string {
  const nonce = message.clientNonce
  if (!message.authorId || !nonce || nonce.startsWith("srv:")) return `msg:id:${message.id}`
  return `msg:client:${JSON.stringify([message.authorId, nonce])}`
}

const MESSAGE_GROUP_WINDOW_MS = 7 * 60 * 1000

export type FlatItem = {
  kind: "message"
  m: RenderMsg
  key: string
} | {
  kind: "leading"
  key: string
} | {
  kind: "trailing"
  key: string
} | {
  kind: "divider"
  key: string
  messageId: string
  dateLabel?: string
  newDivider?: boolean
}

export function flattenMessageItems(
  messages: Msg[],
  newDividerBefore: string | undefined,
  hasMoreOlder = false,
  hasMoreNewer = false,
): FlatItem[] {
  const items: FlatItem[] = []
  if (messages.length > 0) items.push({ kind: "leading", key: "rail:leading" })
  let prev: Msg | null = null
  let seenFirstMessage = false
  for (const m of messages) {
    const prevDate = prev ? dateKey(prev.createdAt) : ""
    const curDate = dateKey(m.createdAt)
    const showDateDivider = !!(curDate && curDate !== prevDate)
    const isNewDivider = m.id === newDividerBefore
    const isPendingWindowFirst = !seenFirstMessage && hasMoreOlder && m.type === "chat"
    const grouped = isPendingWindowFirst || !!(prev && m.type === "chat" && !m.replyTo && !showDateDivider && prev.authorName === m.authorName
      && prev.createdAt && m.createdAt && (new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime()) < MESSAGE_GROUP_WINDOW_MS)
    if (showDateDivider || isNewDivider) {
      items.push({
        kind: "divider",
        key: isNewDivider ? `new:${messageDisplayKey(m)}` : `date:${messageDisplayKey(m)}`,
        messageId: m.id,
        ...(showDateDivider ? { dateLabel: formatDateLabel(m.createdAt!) } : {}),
        ...(isNewDivider ? { newDivider: true } : {}),
      })
    }
    items.push({
      kind: "message",
      m: deriveView({ ...m, grouped }, [viewEvidence(m)]),
      key: messageDisplayKey(m),
    })
    seenFirstMessage = true
    prev = m
  }
  if (messages.length > 0 && hasMoreNewer) items.push({ kind: "trailing", key: "rail:trailing" })
  return items
}

// ── Row height estimation ────────────────────────────────────────────────
// Fast, allocation-light guesses for `useVirtualizer`'s `estimateSize` —
// corrected after paint via `measureElement`, same as `member-list.tsx`
// already relies on for its own rows. No precision beyond that is required.
const DATE_DIVIDER_ESTIMATE_PX = 32
const NEW_DIVIDER_ESTIMATE_PX = 24
const MESSAGE_BASE_ESTIMATE_PX = 24
const CHARS_PER_LINE_ESTIMATE = 55
const LINE_HEIGHT_ESTIMATE_PX = 20
const MAX_TEXT_ESTIMATE_PX = 400
const ATTACHMENT_FALLBACK_ESTIMATE_PX = 200
const ATTACHMENT_MAX_HEIGHT_ESTIMATE_PX = 300
const ATTACHMENT_TYPICAL_WIDTH_ESTIMATE_PX = 320
const EMBED_ESTIMATE_PX = 120
const REACTIONS_ESTIMATE_PX = 32
const THREAD_PREVIEW_ESTIMATE_PX = 36
const REPLY_HEADER_ESTIMATE_PX = 28

function estimateTextHeight(content: string | undefined): number {
  if (!content) return 0
  const lines = Math.max(1, Math.ceil(content.length / CHARS_PER_LINE_ESTIMATE))
  return Math.min(lines * LINE_HEIGHT_ESTIMATE_PX, MAX_TEXT_ESTIMATE_PX)
}

function estimateAttachmentsHeight(m: Msg): number {
  if (!m.attachments?.length) return 0
  let total = 0
  for (const a of m.attachments) {
    if (a.kind !== "image") continue
    total += a.width && a.height
      ? Math.min(
          ATTACHMENT_MAX_HEIGHT_ESTIMATE_PX,
          Math.round((ATTACHMENT_TYPICAL_WIDTH_ESTIMATE_PX * a.height) / a.width),
        )
      : ATTACHMENT_FALLBACK_ESTIMATE_PX
  }
  return total
}

// Exported for direct unit testing (see message-list.test.ts).
export function estimateRowHeight(item: FlatItem, hasMoreOlder = false): number {
  if (item.kind === "leading") return hasMoreOlder ? 88 : 152
  if (item.kind === "trailing") return 56
  if (item.kind === "divider") return item.dateLabel ? DATE_DIVIDER_ESTIMATE_PX : NEW_DIVIDER_ESTIMATE_PX
  const m = item.m
  let height = MESSAGE_BASE_ESTIMATE_PX + estimateTextHeight(m.content) + estimateAttachmentsHeight(m)
  if (m.replyTo) height += REPLY_HEADER_ESTIMATE_PX
  if (m.embeds?.length) height += EMBED_ESTIMATE_PX * m.embeds.length
  if (m.reactions?.length) height += REACTIONS_ESTIMATE_PX
  if (m.thread) height += THREAD_PREVIEW_ESTIMATE_PX
  return height
}

export function computeBelowCount(items: FlatItem[], lastVisibleIndex: number): number {
  return items.slice(Math.max(0, lastVisibleIndex + 1)).filter((item) => item.kind === "message").length
}
