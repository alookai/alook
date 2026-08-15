import { apiFetch } from "@/lib/api/client"

export const MARK_CHANNEL_READ_DEBOUNCE_MS = 500

/**
 * A single pending mark-read carries the debounce timer, a `fire` closure,
 * and the most recently queued `messageId` (or `undefined` for a no-body
 * mass mark-read). Re-scheduling within the debounce window replaces the
 * pending `messageId` — monotone forward semantics live one layer up in
 * `useChannelWatermark`, so this layer just uses whichever value the last
 * caller passed.
 *
 * Both the timer callback and `flushPendingReads()` invoke `fire` — same
 * code path, whether the window elapsed naturally or was flushed early.
 */
type PendingRead = {
  timer: ReturnType<typeof setTimeout>
  fire: () => void
  // Latest queued message id — captured in the closure so `fire` reads the
  // freshest value even after the timer was scheduled with a stale one.
  messageId: string | undefined
}

const pendingReads = new Map<string, PendingRead>()

export function _resetPendingReads_forTesting() {
  for (const p of pendingReads.values()) clearTimeout(p.timer)
  pendingReads.clear()
}

/**
 * Flush every pending mark-read immediately. Each entry's `fire` runs the
 * same code the timer would have — so `onDone` (typically the inbox
 * invalidate) still fires exactly once per PUT, even when a caller flushes
 * mid-window.
 */
export function flushPendingReads() {
  const pending = [...pendingReads.values()]
  for (const p of pending) {
    clearTimeout(p.timer)
    p.fire()
  }
}

export type ScheduleMarkReadOpts = {
  /**
   * When set, PUT `{ lastReadMessageId }` — advances the read pointer to
   * that message's `(createdAt, id)`. Omit for the mass mark-read case
   * (no body). The mutation layer trusts whatever value the caller passes
   * most recently; monotonicity is the caller's responsibility (see
   * `useChannelWatermark` / `useDmWatermark`). Body key matches the DM +
   * thread read routes.
   */
  messageId?: string
  onDone: () => void
}

/**
 * Resolve a schedule key to a target read-endpoint URL. The debounce key
 * is a string namespace so `channelId` and `dm:<dmId>` coexist in the same
 * `pendingReads` map without ever aliasing each other — a channel and a
 * DM with the same underlying id would otherwise share a debounce slot
 * and clobber each other's pointers.
 *
 * Channel keys are bare ids (legacy — the debounce was channel-only
 * before B2). DM keys are prefixed with `"dm:"` so the map stays keyed by
 * unique strings without a discriminated-union tag on `PendingRead`.
 */
function resolveReadEndpoint(key: string): string {
  // DM and channel both resolve through the one canonical read door (a DM is a
  // channel row in the same id-space); the `dm:` key prefix only strips to the
  // channelId, no per-type URL fork.
  const channelId = key.startsWith("dm:") ? key.slice(3) : key
  return `/api/community/channels/${channelId}/read`
}

/**
 * Debounce a mark-read PUT. Same-key re-invokes within the 500ms window
 * replace the pending intent (previous `messageId` and `onDone` are
 * dropped; the new pair takes over). Nothing is left "hanging" because
 * `mutationFn` no longer awaits the debounced work.
 *
 * `key` is a string namespace: a bare `channelId` for channel/thread reads
 * (legacy contract — every existing call site passes a channel id
 * directly) or `"dm:<dmId>"` for DM reads. `resolveReadEndpoint` maps the
 * key back to the target URL. Consumers should never build the DM
 * namespace directly — call `useAdvanceDmWatermark` which handles it.
 */
export function scheduleMarkRead(
  key: string,
  opts: ScheduleMarkReadOpts,
): void {
  const existing = pendingReads.get(key)
  if (existing) clearTimeout(existing.timer)
  // `entry` is captured inside `fire` so it can read the freshest
  // `messageId` at the moment the PUT actually issues — even if a later
  // schedule call updated it in place. Cleaner than closing over a mutable
  // outer variable.
  const entry: PendingRead = {
    // Timer is filled in below after fire is defined.
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
    messageId: opts.messageId,
    fire: () => {
      // Idempotent: if the map has already moved on (fire ran, or a fresh
      // scheduling replaced us), do nothing. This is what makes it safe for
      // both the timer AND `flushPendingReads()` to call `fire` in the same
      // tick — only the first wins.
      const cur = pendingReads.get(key)
      if (cur !== entry) return
      pendingReads.delete(key)
      const body = entry.messageId
        ? JSON.stringify({ lastReadMessageId: entry.messageId })
        : undefined
      const init: RequestInit = body
        ? { method: "PUT", body }
        : { method: "PUT" }
      void apiFetch(resolveReadEndpoint(key), init)
        .then(() => opts.onDone())
        .catch(() => {
          // Silent — the inbox will reconcile once the WS invalidate fires.
        })
    },
  }
  entry.timer = setTimeout(entry.fire, MARK_CHANNEL_READ_DEBOUNCE_MS)
  pendingReads.set(key, entry)
}
