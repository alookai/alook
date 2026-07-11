import { dateKey, formatDateLabel } from "./format-time"
import type { Msg, RenderMsg } from "./_types"

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
  | { kind: "new-divider"; key: string }
  | { kind: "message"; m: RenderMsg; key: string }

// Flatten a message array into one row per divider/message. Exported for
// direct unit testing (see message-list.test.ts) — mirrors `member-list.tsx`'s
// `flattenGroups`/`computeDuplicateNames` pattern of exporting pure list-prep
// logic out of the component for testability without rendering.
export function flattenMessageItems(messages: Msg[], newDividerBefore: string | undefined): FlatItem[] {
  const items: FlatItem[] = []
  let prev: Msg | null = null
  for (const m of messages) {
    const prevDate = prev ? dateKey(prev.createdAt) : ""
    const curDate = dateKey(m.createdAt)
    const showDateDivider = !!(curDate && curDate !== prevDate)
    if (showDateDivider) {
      items.push({ kind: "date-divider", label: formatDateLabel(m.createdAt!), key: `date:${m.id}` })
    }
    if (m.id === newDividerBefore) {
      items.push({ kind: "new-divider", key: "new-divider" })
    }
    const grouped = !!(prev && m.type === "chat" && !m.replyTo && !showDateDivider && prev.authorName === m.authorName
      && prev.createdAt && m.createdAt && (new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime()) < MESSAGE_GROUP_WINDOW_MS)
    items.push({ kind: "message", m: { ...m, grouped }, key: `msg:${m.id}` })
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
  if (item.kind === "new-divider") return NEW_DIVIDER_ESTIMATE_PX
  const m = item.m
  let height = MESSAGE_BASE_ESTIMATE_PX + estimateTextHeight(m.content) + estimateAttachmentsHeight(m)
  if (m.embeds?.length) height += EMBED_ESTIMATE_PX * m.embeds.length
  if (m.reactions?.length) height += REACTIONS_ESTIMATE_PX
  if (m.thread) height += THREAD_PREVIEW_ESTIMATE_PX
  return height
}

// ── "↓ N below" pill count ───────────────────────────────────────────────
// Replaces the pre-virtualization `recomputeBelow`'s DOM-row-walk
// (`querySelectorAll("[data-msg-id]")` + `offsetTop` comparison) with a
// plain arithmetic derivation from data `getVirtualItems()` already
// exposes on every render. Exported for direct unit testing.
export function computeBelowCount(itemCount: number, lastVisibleIndex: number): number {
  return Math.max(0, itemCount - 1 - lastVisibleIndex)
}
