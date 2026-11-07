import type { QueryClient } from "@tanstack/react-query"
import type { CommunityRuntime } from "@/stores/community/runtime"
import type { CommunityWsProjectionTransaction } from "@/hooks/community/community-ws/projection-transaction"
import type { CommunityWsEvent, CommunityContract } from "@alook/shared"

export type Subscription = {

  channelId?: string

  secondaryChannelId?: string
  // The focused DM's channel id. A DM is a channel now; this slot keeps its
  // name only to mark "the focused channel is a DM" so the handler routes its
  // events into the `dmMessages` cache and the `dm:` typing scope.
  dmConversationId?: string
}

export type UseCommunityWsOptions = {
  communityContract?: CommunityContract
  viewerUserId?: string | null
}

export type CommunityWsDispatchContext = {
  contract?: CommunityContract
  deliveryMode: "single" | "batch"
  queryClient: QueryClient
  communityStore: CommunityRuntime["ui"]
  wsStore: CommunityRuntime["ws"]
  sub: Subscription
  viewerUserIdRef: { current: string | null }
  matchesFocus: (event: { channelId?: string }) => boolean
  onMachineOnline?: () => void
}

export type CommunityWsHandlerContext = CommunityWsDispatchContext & {
  projection: CommunityWsProjectionTransaction
  unreadBumpEvidence?: ReadonlyMap<CommunityWsEvent, {
    messageId: string
    seq: number
    createdAt: string
    messageEvent: Extract<CommunityWsEvent, { type: "community:message.create" }>
  }>
  messageEvidenceByChannel?: ReadonlyMap<string, {
    messageId: string
    seq: number
    createdAt: string
  }>
}

export type TypingEventContext = Pick<
  CommunityWsHandlerContext,
  "queryClient" | "sub" | "viewerUserIdRef" | "matchesFocus"
>
export type StructureTreeEventContext = Pick<
  CommunityWsHandlerContext,
  "queryClient" | "projection"
>
export type MembershipEventContext = Pick<
  CommunityWsHandlerContext,
  "queryClient" | "viewerUserIdRef" | "projection" | "wsStore"
>
export type SocialEventContext = Pick<
  CommunityWsHandlerContext,
  "deliveryMode" | "queryClient" | "sub" | "viewerUserIdRef" | "projection"
  | "unreadBumpEvidence" | "messageEvidenceByChannel"
>
export type PresenceMachineEventContext = Pick<
  CommunityWsHandlerContext,
  "queryClient" | "onMachineOnline"
>
