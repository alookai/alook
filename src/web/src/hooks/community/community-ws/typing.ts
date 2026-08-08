import { TYPING_INDICATOR_TIMEOUT_MS } from "@alook/shared"
import { useCommunityStore } from "@/stores/community"

export function typingScopeKey(
  e: { channelId: string },
  sub: { channelId?: string; dmConversationId?: string },
): string {
  return e.channelId === sub.dmConversationId ? `dm:${e.channelId}` : `ch:${e.channelId}`
}

const timerKey = (scopeKey: string, userId: string) => `${scopeKey}|${userId}`

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
    if (current?.has(userId) && current.get(userId) === name) {
      return { typingTimers: nextTimers }
    }
    const nextByScope = new Map(state.typingByScope)
    nextByScope.set(scopeKey, new Map(current ?? []).set(userId, name))
    return { typingByScope: nextByScope, typingTimers: nextTimers }
  })
}

export function clearTypingIndicator(scopeKey: string, userId: string) {
  useCommunityStore.setState((state) => {
    const tKey = timerKey(scopeKey, userId)
    const existing = state.typingTimers.get(tKey)
    if (!existing && !state.typingByScope.get(scopeKey)?.has(userId)) return {}
    if (existing) clearTimeout(existing)
    return removeTypingUser(state, scopeKey, userId)
  })
}

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
