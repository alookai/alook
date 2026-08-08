import type { CommunityTypingStart, CommunityWsEvent } from "@alook/shared"
import {
  applyTypingIndicator,
  clearTypingIndicator,
  typingScopeKey,
} from "@/hooks/community/community-ws/typing"
import type { TypingEventContext } from "@/hooks/community/community-ws/handler-context"

type CommunityTypingStop = Extract<
  CommunityWsEvent,
  { type: "community:typing.stop" }
>

export function handleTypingStart(
  event: CommunityTypingStart,
  { viewerUserIdRef, matchesFocus, sub }: TypingEventContext,
) {
  const userId = event.userId
  const viewerId = viewerUserIdRef.current
  if (viewerId && userId === viewerId) return
  // Focus check: only surface typing for the currently-viewed target.
  if (!matchesFocus(event)) return
  applyTypingIndicator(typingScopeKey(event, sub), userId, event.name ?? null)
}

export function handleTypingStop(
  event: CommunityTypingStop,
  { viewerUserIdRef, matchesFocus, sub }: TypingEventContext,
) {
  // Symmetric with typing.start: only clear when focused on the same
  // target so a stop for a different DM doesn't wipe the local pill.
  const userId = event.userId
  const viewerId = viewerUserIdRef.current
  if (viewerId && userId === viewerId) return
  if (!matchesFocus(event)) return
  clearTypingIndicator(typingScopeKey(event, sub), userId)
}
