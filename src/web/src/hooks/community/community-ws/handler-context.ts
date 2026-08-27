import type { QueryClient } from "@tanstack/react-query"
import type { useCommunityStore } from "@/stores/community"
import type { useCommunityWsStore } from "@/stores/community/ws"
import type { CommunityWsProjectionTransaction } from "@/hooks/community/community-ws/projection-transaction"

export type Subscription = {
  // The focused regular channel/thread.
  channelId?: string
  // The focused DM's channel id. A DM is a channel now; this slot keeps its
  // name only to mark "the focused channel is a DM" so the handler routes its
  // events into the `dmMessages` cache and the `dm:` typing scope.
  dmConversationId?: string
}

/**
 * Optional args — the community feature needs to know the viewer's userId so
 * reactions from that user light up the "me" flag. Passing null keeps the
 * hook usable in places where the viewer identity isn't yet loaded.
 */
export type UseCommunityWsOptions = {
  viewerUserId?: string | null
}

export type CommunityInboxRefreshRequest = {
  inbox: true
  dms: boolean
}

export type CommunityWsDispatchContext = {
  deliveryMode: "single" | "batch"
  queryClient: QueryClient
  communityStore: ReturnType<typeof useCommunityStore.getState>
  wsStore: ReturnType<typeof useCommunityWsStore.getState>
  sub: Subscription
  viewerUserIdRef: { current: string | null }
  matchesFocus: (event: { channelId?: string }) => boolean
  scheduleInboxInvalidate: (request: CommunityInboxRefreshRequest) => void
}

export type CommunityWsHandlerContext = CommunityWsDispatchContext & {
  projection: CommunityWsProjectionTransaction
}

export type MessageEventContext = CommunityWsHandlerContext
export type TypingEventContext = Pick<
  CommunityWsHandlerContext,
  "sub" | "viewerUserIdRef" | "matchesFocus"
>
export type StructureTreeEventContext = Pick<
  CommunityWsHandlerContext,
  "queryClient" | "projection"
>
export type MembershipEventContext = Pick<
  CommunityWsHandlerContext,
  "queryClient" | "viewerUserIdRef" | "projection"
>
export type SocialEventContext = Pick<
  CommunityWsHandlerContext,
  "deliveryMode" | "queryClient" | "sub" | "viewerUserIdRef" | "projection"
  | "scheduleInboxInvalidate"
>
export type PresenceMachineEventContext = Pick<
  CommunityWsHandlerContext,
  "queryClient"
>
