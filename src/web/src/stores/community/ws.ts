"use client"

import { create } from "zustand"

/**
 * Zustand store for community WS-live-patched state.
 *
 * Owned exclusively by the WS handler (`hooks/community/use-community-ws.ts`)
 * after Step 4 lands; consumers read via the selector hooks below. Kept
 * separate from `useCommunityStore` so subscription re-renders only fire on
 * the axis that changed — a presence tick doesn't re-render a component that
 * only cares about the current channel id.
 *
 * Loop-breaker rules (short version — full rulebook lives in `./index.ts`):
 * - Setters no-op on identical state (`hydratePresence` / `resetPresence`
 *   below). Zustand notifies every subscriber on every `set(...)`; guard
 *   writes with a content-equality check so a redundant seed doesn't cascade
 *   into every subscriber and shift a dep that re-fires the seeder.
 * - Effect writers into this store must pass reference-stable arguments —
 *   a fresh `[]` fallback per render will trigger the seeder each pass and
 *   without the guards above would loop.
 */

// Cap the seen-message set to bound memory. Mirrors the current dedup logic
// in `hooks/community/use-community-ws.ts` (grow to 500, trim to the newest
// 400). Extracted as constants so the tests can assert the boundary directly.
export const SEEN_MESSAGE_MAX = 500
export const SEEN_MESSAGE_TRIM_TO = 400

/**
 * Bounded ring for live bot-audit events, PER bot. The modal reads from here
 * and prepends into the React Query cache — the ring only holds enough for
 * the "in-flight" window while the modal is open. Older events are always
 * available via paginated GETs. Per-bot bounding prevents a chatty bot from
 * evicting a quiet bot's live events before the modal for that bot mounts.
 */
export const BOT_AUDIT_RING_MAX = 200

export type BotAuditEventEntry = {
  id: string
  botId: string
  kind: "cli_invocation" | "tool_call" | "thinking"
  payload: unknown
  sessionId?: string | null
  launchId?: string | null
  createdAt: string
}

type UserStatus = { emoji: string | null; text: string | null }

export type CommunityWsStoreState = {
  /**
   * Everyone online right now — human or bot. The server pushes
   * `community:presence.update` identically for both (see
   * plans/community-account-debt-fixes.md Fix 3: a bot's bound-machine
   * connect/disconnect fans out through the same audience-based pipeline as
   * a human WS connect/disconnect), so there's a single stream to store.
   */
  onlineUserIds: Set<string>
  seenMessageIds: Set<string>
  /**
   * Live status deltas learned via `community:status.update` after the
   * initial member/friend fetch — see plans/profile-card.md's "overlay
   * pattern, not cache-patching" section. Only ever holds users who changed
   * status since page load; everyone else's status comes straight off the
   * fetched row.
   */
  userStatuses: Map<string, UserStatus>
  /**
   * Per-bot rings of recent audit events, each bounded by BOT_AUDIT_RING_MAX.
   * Newest first inside each bot's array. A chatty bot never evicts a quieter
   * bot's events. Absent-bot lookup returns an empty array.
   */
  botAuditEvents: Map<string, BotAuditEventEntry[]>

  setPresence: (userId: string, online: boolean) => void
  /** Atomic bulk seed — one notification for N users. Use on server switch. */
  hydratePresence: (userIds: readonly string[]) => void
  resetPresence: () => void
  hasSeenMessage: (id: string) => boolean
  markSeenMessage: (id: string) => void
  setUserStatus: (userId: string, emoji: string | null, text: string | null) => void
  resetUserStatuses: () => void
  pushBotAuditEvent: (event: BotAuditEventEntry) => void
  reset: () => void
}

const initialState = (): Pick<
  CommunityWsStoreState,
  "onlineUserIds" | "seenMessageIds" | "userStatuses" | "botAuditEvents"
> => ({
  onlineUserIds: new Set(),
  seenMessageIds: new Set(),
  userStatuses: new Map(),
  botAuditEvents: new Map(),
})

export const useCommunityWsStore = create<CommunityWsStoreState>((set, get) => ({
  ...initialState(),

  setPresence: (userId, online) => {
    const next = new Set(get().onlineUserIds)
    if (online) next.add(userId)
    else next.delete(userId)
    set({ onlineUserIds: next })
  },

  hydratePresence: (userIds) => {
    const current = get().onlineUserIds
    // Fast-path: same members, same size → no store write, no notification.
    // Prevents render loops when a caller re-runs seeding with the same list
    // (e.g., an effect that re-fires because a dep re-renders identically).
    if (current.size === userIds.length && userIds.every((id) => current.has(id))) {
      return
    }
    set({ onlineUserIds: new Set(userIds) })
  },

  resetPresence: () => {
    if (get().onlineUserIds.size === 0) return
    set({ onlineUserIds: new Set() })
  },

  hasSeenMessage: (id) => get().seenMessageIds.has(id),

  markSeenMessage: (id) => {
    const current = get().seenMessageIds
    if (current.has(id)) return
    const next = new Set(current)
    next.add(id)
    if (next.size > SEEN_MESSAGE_MAX) {
      // Sliding window: drop the oldest entries so the newest survive.
      const trimmed = new Set([...next].slice(-SEEN_MESSAGE_TRIM_TO))
      set({ seenMessageIds: trimmed })
      return
    }
    set({ seenMessageIds: next })
  },

  setUserStatus: (userId, emoji, text) => {
    const next = new Map(get().userStatuses)
    next.set(userId, { emoji, text })
    set({ userStatuses: next })
  },

  resetUserStatuses: () => {
    if (get().userStatuses.size === 0) return
    set({ userStatuses: new Map() })
  },

  pushBotAuditEvent: (event) => {
    const current = get().botAuditEvents
    const perBot = current.get(event.botId) ?? []
    // Dedup by id — the same event can arrive via WS *and* be in the initial
    // GET response (the plan's cache-race case); the hook does its own
    // per-cache dedup too, but keeping the store honest costs nothing.
    if (perBot.some((e) => e.id === event.id)) return
    const nextPerBot = [event, ...perBot]
    if (nextPerBot.length > BOT_AUDIT_RING_MAX) nextPerBot.length = BOT_AUDIT_RING_MAX
    const next = new Map(current)
    next.set(event.botId, nextPerBot)
    set({ botAuditEvents: next })
  },

  reset: () => set(initialState()),
}))

// ── Selectors ────────────────────────────────────────────────────────────────

/**
 * Every consumer that asks "is X online?" reads this — the server already
 * pushes bot presence into the same `onlineUserIds` stream as human
 * presence (see the store-level comment above), so this is a direct
 * passthrough, not a union of two sources.
 */
export const useOnlineUserIds = (): ReadonlySet<string> => {
  return useCommunityWsStore((s) => s.onlineUserIds)
}

const EMPTY_AUDIT_EVENTS: BotAuditEventEntry[] = []

/**
 * Live bot-audit events for a single botId. Newest first.
 *
 * The zustand selector reads only the per-bot slice of the ring map — a
 * presence/status update, or an event for a different bot, doesn't force a
 * re-render because zustand short-circuits on `Object.is` identity.
 */
export const useBotAuditEventsForBot = (botId: string | null | undefined): BotAuditEventEntry[] => {
  return useCommunityWsStore((s) =>
    botId ? s.botAuditEvents.get(botId) ?? EMPTY_AUDIT_EVENTS : EMPTY_AUDIT_EVENTS,
  )
}
