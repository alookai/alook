import { dateKey, formatDateLabel } from "./format-time"
import type { Msg, RenderMsg } from "./models/message"

function messageDisplayKey(message: Msg): string {
  const nonce = message.clientNonce
  if (!message.authorId || !nonce || nonce.startsWith("srv:")) return `msg:id:${message.id}`
  return `msg:client:${JSON.stringify([message.authorId, nonce])}`
}

const MESSAGE_GROUP_WINDOW_MS = 7 * 60 * 1000
export const MESSAGE_ROW_VERTICAL_PADDING_PX = 8

export type FlatItem = {
  kind: "message"
  m: RenderMsg
  key: string
  paddingTop?: number
  paddingBottom?: number
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
    const isPendingWindowFirst = !seenFirstMessage && hasMoreOlder && m.type === "chat" && !m.replyTo && !isNewDivider
    const elapsed = prev?.createdAt && m.createdAt ? new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() : NaN
    const joinsPrevious = !!(prev && prev.type === "chat" && m.type === "chat" && !prev.replyTo && !m.replyTo
      && !showDateDivider && !isNewDivider && m.authorId && prev.authorId === m.authorId
      && elapsed >= 0 && elapsed < MESSAGE_GROUP_WINDOW_MS)
    const grouped = isPendingWindowFirst || joinsPrevious
    const previousItem = items.at(-1)
    if (joinsPrevious && previousItem?.kind === "message") previousItem.paddingBottom = MESSAGE_ROW_VERTICAL_PADDING_PX / 2
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
      m: { ...m, grouped },
      key: messageDisplayKey(m),
      paddingTop: joinsPrevious ? MESSAGE_ROW_VERTICAL_PADDING_PX / 2 : MESSAGE_ROW_VERTICAL_PADDING_PX,
      paddingBottom: MESSAGE_ROW_VERTICAL_PADDING_PX,
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
const MESSAGE_BASE_ESTIMATE_PX = 8
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
  let height = MESSAGE_BASE_ESTIMATE_PX + (item.paddingTop ?? MESSAGE_ROW_VERTICAL_PADDING_PX)
    + (item.paddingBottom ?? MESSAGE_ROW_VERTICAL_PADDING_PX) + estimateTextHeight(m.content) + estimateAttachmentsHeight(m)
  if (m.replyTo) height += REPLY_HEADER_ESTIMATE_PX
  if (m.embeds?.length) height += EMBED_ESTIMATE_PX * m.embeds.length
  if (m.reactions?.length) height += REACTIONS_ESTIMATE_PX
  if (m.thread) height += THREAD_PREVIEW_ESTIMATE_PX
  return height
}

export function computeBelowCount(items: FlatItem[], lastVisibleIndex: number): number {
  return items.slice(Math.max(0, lastVisibleIndex + 1)).filter((item) => item.kind === "message").length
}
