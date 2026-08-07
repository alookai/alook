import { dateKey, formatDateLabel } from "./format-time"
import type { Msg, RenderMsg } from "./_types"

function messageDisplayKey(message: Msg): string {
  const nonce = message.clientNonce
  if (!message.authorId || !nonce || nonce.startsWith("srv:")) return `msg:id:${message.id}`
  return `msg:client:${JSON.stringify([message.authorId, nonce])}`
}

// Pure list-prep logic for the virtualized `MessageList` — split out of
// `message-list.tsx` (a "use client" component) into its own module with no
// React/JSX so `use-scroll-anchor.ts` can import `FlatItem`/`estimateRowHeight`
// /`computeBelowCount` without creating a `message-list.tsx` ↔
// `use-scroll-anchor.ts` circular import (message-list.tsx also imports
// `useScrollAnchor` from that file).

// Consecutive messages from the same author cluster (avatar+name suppressed
// on the second+ row) when they land within this window of each other.
const MESSAGE_GROUP_WINDOW_MS = 7 * 60 * 1000

// One virtual row per divider or per message — flattened rather than
// nested into cluster arrays (the pre-virtualization shape) so
// `@tanstack/react-virtual` can measure/position each row independently.
// `grouped` (avatar/name suppressed) is still computed against the
// immediately preceding MESSAGE item, same rule the old `clusters` memo
// used — just not re-nested into a cluster array afterward.
export type FlatItem =
  | { kind: "date-divider"; label: string; key: string }
  | { kind: "new-divider"; key: string; dateLabel?: string }
  | { kind: "message"; m: RenderMsg; key: string }

// Flatten a message array into one row per divider/message. Exported for
// direct unit testing (see message-list.test.ts) — mirrors `member-list.tsx`'s
// `flattenGroups`/`computeDuplicateNames` pattern of exporting pure list-prep
// logic out of the component for testability without rendering.
// `hasMoreOlder` — whether an older page exists beyond this window's top (the
// reverse-infinite top sentinel is live). When true, the window's FIRST message
// has an unknowable true predecessor: its real grouping can't be computed until
// the older page loads. Defaulting it to ungrouped (avatar shown) then
// re-grouping on prepend produces a pop-OUT flash (avatar appears, then
// vanishes when the older same-author message arrives) — read by the eye as
// "something broke". Instead, default the window-first message to GROUPED (no
// avatar) while older content is still pending: the common mid-history reload
// has that top message continuing an older same-author run (so grouped is
// usually already correct), and when it is genuinely a new group the avatar
// fades IN on prepend — a gentler, expected "content arrived" motion. Once the
// top is truly reached (`hasMoreOlder` false), the first message groups by the
// real rule (nothing above it → ungrouped → its avatar shows, correctly).
export function flattenMessageItems(
  messages: Msg[],
  newDividerBefore: string | undefined,
  hasMoreOlder = false,
): FlatItem[] {
  const items: FlatItem[] = []
  let prev: Msg | null = null
  let seenFirstMessage = false
  for (const m of messages) {
    const prevDate = prev ? dateKey(prev.createdAt) : ""
    const curDate = dateKey(m.createdAt)
    const showDateDivider = !!(curDate && curDate !== prevDate)
    const isNewDivider = m.id === newDividerBefore
    if (showDateDivider && isNewDivider) {
      items.push({ kind: "new-divider", key: "new-divider", dateLabel: formatDateLabel(m.createdAt!) })
    } else {
      if (showDateDivider) {
        // Keyed by the DATE (not the first-of-day message id) so an older-page
        // prepend that pushes new same-day messages in front of the current
        // first-of-day row keeps the divider's key stable. Without this,
        // `@tanstack/react-virtual`'s anchor path (see use-scroll-anchor.ts) —
        // which captures the anchor row's key before prepend and finds it in
        // the new items after — falls off when the anchor sits on `items[0]`
        // (the top-of-window divider), the divider gets re-emitted with a
        // different `date:${id}` key, and `anchorTo: "end"` silently no-ops.
        // Symptom: viewport jumps to the top of the loaded window on every
        // top-sentinel load. `curDate` is `YYYY-MM-DD`, one row per day, so
        // it's a stable identity.
        items.push({ kind: "date-divider", label: formatDateLabel(m.createdAt!), key: `date:${curDate}` })
      }
      if (isNewDivider) {
        items.push({ kind: "new-divider", key: "new-divider" })
      }
    }
    // Window-first message with an older page still pending: force grouped
    // (suppress its avatar) rather than guess ungrouped — see the doc comment
    // above. `m.type === "chat"` keeps a system message (which never groups)
    // out of this special-case. Chat first-messages only.
    const isPendingWindowFirst = !seenFirstMessage && hasMoreOlder && m.type === "chat"
    const grouped = isPendingWindowFirst || !!(prev && m.type === "chat" && !m.replyTo && !showDateDivider && prev.authorName === m.authorName
      && prev.createdAt && m.createdAt && (new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime()) < MESSAGE_GROUP_WINDOW_MS)
    items.push({ kind: "message", m: { ...m, grouped }, key: messageDisplayKey(m) })
    seenFirstMessage = true
    prev = m
  }
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
// Attachment images render inside a max-width box (see message.tsx's
// `max-w-[320px]`) — an aspect-ratio estimate is clamped against that width
// so a very tall/narrow image doesn't produce an absurd height guess.
const ATTACHMENT_MAX_WIDTH_PX = 320
const ATTACHMENT_FALLBACK_ESTIMATE_PX = 200
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
    if (a.width && a.height) {
      total += Math.round((ATTACHMENT_MAX_WIDTH_PX * a.height) / a.width)
    } else {
      total += ATTACHMENT_FALLBACK_ESTIMATE_PX
    }
  }
  return total
}

// Exported for direct unit testing (see message-list.test.ts).
export function estimateRowHeight(item: FlatItem): number {
  if (item.kind === "date-divider") return DATE_DIVIDER_ESTIMATE_PX
  if (item.kind === "new-divider") return item.dateLabel ? DATE_DIVIDER_ESTIMATE_PX : NEW_DIVIDER_ESTIMATE_PX
  const m = item.m
  let height = MESSAGE_BASE_ESTIMATE_PX + estimateTextHeight(m.content) + estimateAttachmentsHeight(m)
  if (m.replyTo) height += REPLY_HEADER_ESTIMATE_PX
  if (m.embeds?.length) height += EMBED_ESTIMATE_PX * m.embeds.length
  if (m.reactions?.length) height += REACTIONS_ESTIMATE_PX
  if (m.thread) height += THREAD_PREVIEW_ESTIMATE_PX
  return height
}

// ── "↓ N below" pill count ───────────────────────────────────────────────
// Replaces the pre-virtualization `recomputeBelow`'s DOM-row-walk
// (`querySelectorAll("[data-msg-id]")` + `offsetTop` comparison) with a
// plain arithmetic derivation from data `getVirtualItems()` already
// exposes on every render. Counts only MESSAGE rows below the last visible
// index — date/NEW dividers are structural, not messages, so a bare
// `itemCount - 1 - lastVisibleIndex` would inflate the badge by one per
// divider below the fold. Exported for direct unit testing.
export function computeBelowCount(items: FlatItem[], lastVisibleIndex: number): number {
  let count = 0
  for (let i = lastVisibleIndex + 1; i < items.length; i++) {
    if (items[i].kind === "message") count++
  }
  return count
}
