import { dateKey, formatDateLabel } from "./format-time"
import type { Msg, RenderMsg } from "./models/message"

function messageDisplayKey(message: Msg, viewerUserId?: string | null): string {
  const nonce = message.clientNonce
  if (!viewerUserId || message.authorId !== viewerUserId || !nonce || nonce.startsWith("srv:")) return `msg:id:${message.id}`
  return `msg:client:${JSON.stringify([message.authorId, nonce])}`
}

const MESSAGE_GROUP_WINDOW_MS = 7 * 60 * 1000
export const MESSAGE_ROW_VERTICAL_PADDING_PX = 8
export const MESSAGE_GROUPED_ROW_PADDING_PX = MESSAGE_ROW_VERTICAL_PADDING_PX / 2

const renderMsgCache = new WeakMap<Msg, { groupedTrue?: RenderMsg; groupedFalse?: RenderMsg }>()

function toRenderMsg(message: Msg, grouped: boolean): RenderMsg {
  let entry = renderMsgCache.get(message)
  if (!entry) {
    entry = {}
    renderMsgCache.set(message, entry)
  }
  if (grouped) {
    if (!entry.groupedTrue) entry.groupedTrue = { ...message, grouped: true }
    return entry.groupedTrue
  }
  if (!entry.groupedFalse) entry.groupedFalse = { ...message, grouped: false }
  return entry.groupedFalse
}

export type FlatItem = {
  kind: "message"
  m: RenderMsg
  key: string
  paddingTop?: number
  paddingBottom?: number
} | {
  kind: "leading"
  key: string
  hidden?: boolean
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

export type FirstMessageGrouping = Readonly<{
  key: string
  grouped: boolean
}>

export function stabilizeFirstRowGrouping(
  items: FlatItem[],
  previousFirst: FirstMessageGrouping | null,
  newDividerBefore?: string,
): { items: FlatItem[]; firstMessageGrouping: FirstMessageGrouping | null } {
  const firstIndex = items.findIndex((item) => item.kind === "message")
  if (firstIndex === -1) return { items, firstMessageGrouping: null }
  const firstItem = items[firstIndex]!
  if (firstItem.kind !== "message") return { items, firstMessageGrouping: null }
  const eligible =
    firstItem.m.type === "chat"
    && !firstItem.m.replyTo
    && firstItem.m.id !== newDividerBefore
  if (
    eligible
    && previousFirst
    && previousFirst.key === firstItem.key
    && !previousFirst.grouped
    && firstItem.m.grouped
  ) {
    const stabilized = items.slice()
    stabilized[firstIndex] = {
      ...firstItem,
      m: toRenderMsg(firstItem.m, false),
    }
    return { items: stabilized, firstMessageGrouping: previousFirst }
  }
  return {
    items,
    firstMessageGrouping: { key: firstItem.key, grouped: firstItem.m.grouped },
  }
}

export function flattenMessageItems(
  messages: Msg[],
  newDividerBefore: string | undefined,
  hasMoreOlder = false,
  showNewerLoading = false,
  showLeading = true,
  viewerUserId?: string | null,
): FlatItem[] {
  const items: FlatItem[] = []
  if (messages.length > 0) items.push({ kind: "leading", key: "rail:leading", ...(!showLeading ? { hidden: true } : {}) })
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
    if (joinsPrevious && previousItem?.kind === "message") previousItem.paddingBottom = MESSAGE_GROUPED_ROW_PADDING_PX
    if (showDateDivider || isNewDivider) {
      items.push({
        kind: "divider",
        key: isNewDivider ? `new:${messageDisplayKey(m, viewerUserId)}` : `date:${messageDisplayKey(m, viewerUserId)}`,
        messageId: m.id,
        ...(showDateDivider ? { dateLabel: formatDateLabel(m.createdAt!) } : {}),
        ...(isNewDivider ? { newDivider: true } : {}),
      })
    }
    items.push({
      kind: "message",
      m: toRenderMsg(m, grouped),
      key: messageDisplayKey(m, viewerUserId),
      paddingTop: joinsPrevious ? MESSAGE_GROUPED_ROW_PADDING_PX : MESSAGE_ROW_VERTICAL_PADDING_PX,
      paddingBottom: MESSAGE_ROW_VERTICAL_PADDING_PX,
    })
    seenFirstMessage = true
    prev = m
  }
  if (messages.length > 0 && showNewerLoading) items.push({ kind: "trailing", key: "rail:trailing" })
  return items
}

export function computeBelowCount(items: FlatItem[], lastVisibleIndex: number): number {
  return items.slice(Math.max(0, lastVisibleIndex + 1)).filter((item) => item.kind === "message").length
}
