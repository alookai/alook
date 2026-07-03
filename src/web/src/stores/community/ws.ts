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

export type CommunityWsStoreState = {
  onlineUserIds: Set<string>
  seenMessageIds: Set<string>

  setPresence: (userId: string, online: boolean) => void
  /** Atomic bulk seed — one notification for N users. Use on server switch. */
  hydratePresence: (userIds: readonly string[]) => void
  resetPresence: () => void
  hasSeenMessage: (id: string) => boolean
  markSeenMessage: (id: string) => void
  reset: () => void
}

const initialState = (): Pick<
  CommunityWsStoreState,
  "onlineUserIds" | "seenMessageIds"
> => ({
  onlineUserIds: new Set(),
  seenMessageIds: new Set(),
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

  reset: () => set(initialState()),
}))

// ── Selectors ────────────────────────────────────────────────────────────────

export const useOnlineUserIds = () =>
  useCommunityWsStore((s) => s.onlineUserIds)

export const useIsUserOnline = (userId: string | null | undefined): boolean =>
  useCommunityWsStore((s) => (userId ? s.onlineUserIds.has(userId) : false))
