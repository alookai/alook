import { TYPING_INDICATOR_TIMEOUT_MS } from "@alook/shared"
import { useCommunityStore } from "@/stores/community"

/**
 * The conversation scope key an event belongs to. Every event carries a single
 * `channelId` now (a DM is a channel), so the `dm:` / `ch:` prefix — which the
 * DM page (`dm:<id>`) and channel page (`ch:<id>`) read via
 * `useTypingUsersForScope` — is derived from the subscription: if the event's
 * channelId is the focused DM channel, it's a `dm:` scope; otherwise `ch:`.
 * Threads collapse to `ch:<channelId>`.
 */
export function typingScopeKey(
  e: { channelId: string },
  sub: { channelId?: string; dmConversationId?: string },
): string {
  return e.channelId === sub.dmConversationId ? `dm:${e.channelId}` : `ch:${e.channelId}`
}

// Timer map key: one auto-expire timer per (scope, user) pair.
const timerKey = (scopeKey: string, userId: string) => `${scopeKey}|${userId}`

/**
 * Add userId to a conversation scope's typing set and start (or extend) an
 * auto-expire timer. The timer removes the user from THAT scope after
 * `TYPING_INDICATOR_TIMEOUT_MS` if no follow-up typing event arrives.
 * No-ops the set write when the user is already typing in the scope (rule 2 —
 * typing.start re-fires every ~3s).
 */
export function applyTypingIndicator(scopeKey: string, userId: string, name: string | null) {
  useCommunityStore.setState((state) => {
    const tKey = timerKey(scopeKey, userId)
    const existing = state.typingTimers.get(tKey)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      useCommunityStore.setState((s) => removeTypingUser(s, scopeKey, userId))
    }, TYPING_INDICATOR_TIMEOUT_MS)
    const nextTimers = new Map(state.typingTimers)
    nextTimers.set(tKey, timer)

    const current = state.typingByScope.get(scopeKey)
    // Already typing here with the same known name — only the timer refreshed,
    // leave the name map alone (avoids a needless re-render). Otherwise (new
    // typer, or a name we didn't have before) write the entry.
    if (current?.has(userId) && current.get(userId) === name) {
      return { typingTimers: nextTimers }
    }
    const nextByScope = new Map(state.typingByScope)
    nextByScope.set(scopeKey, new Map(current ?? []).set(userId, name))
    return { typingByScope: nextByScope, typingTimers: nextTimers }
  })
}

/**
 * Immediately remove userId from a scope's typing set and cancel its pending
 * timer. Called when the user sends a message — sending is an implicit
 * typing.stop, and waiting for the 8s timeout leaves a ghost indicator hanging
 * under the message that just arrived.
 */
export function clearTypingIndicator(scopeKey: string, userId: string) {
  useCommunityStore.setState((state) => {
    const tKey = timerKey(scopeKey, userId)
    const existing = state.typingTimers.get(tKey)
    if (!existing && !state.typingByScope.get(scopeKey)?.has(userId)) return {}
    if (existing) clearTimeout(existing)
    return removeTypingUser(state, scopeKey, userId)
  })
}

export function clearAllTypingIndicators() {
  const state = useCommunityStore.getState()
  state.typingTimers.forEach((timer) => clearTimeout(timer))
  useCommunityStore.setState({
    typingByScope: new Map(),
    typingTimers: new Map(),
  })
}

/**
 * Pure state patch: drop userId from `scopeKey`'s typing map (deleting the
 * scope key when it empties, to avoid unbounded Map growth) and its
 * `(scope, user)` timer. Shared by the auto-expire timer and the explicit clear.
 */
function removeTypingUser(
  state: { typingByScope: Map<string, Map<string, string | null>>; typingTimers: Map<string, ReturnType<typeof setTimeout>> },
  scopeKey: string,
  userId: string,
): Partial<{ typingByScope: Map<string, Map<string, string | null>>; typingTimers: Map<string, ReturnType<typeof setTimeout>> }> {
  const nextTimers = new Map(state.typingTimers)
  nextTimers.delete(timerKey(scopeKey, userId))
  const current = state.typingByScope.get(scopeKey)
  if (!current?.has(userId)) return { typingTimers: nextTimers }
  const nextMap = new Map(current)
  nextMap.delete(userId)
  const nextByScope = new Map(state.typingByScope)
  if (nextMap.size === 0) nextByScope.delete(scopeKey)
  else nextByScope.set(scopeKey, nextMap)
  return { typingByScope: nextByScope, typingTimers: nextTimers }
}
