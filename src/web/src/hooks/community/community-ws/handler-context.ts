import type { QueryClient } from "@tanstack/react-query"
import type {
  CommunityCategoryCreate,
  CommunityCategoryDelete,
  CommunityCategoryReorder,
  CommunityCategoryUpdate,
  CommunityChannelCreate,
  CommunityChannelDelete,
  CommunityChannelReorder,
  CommunityChannelUpdate,
  CommunityChildChannelCreate,
  CommunityChildChannelUpdate,
  CommunityFriendAccept,
  CommunityFriendBlock,
  CommunityFriendReject,
  CommunityFriendRemove,
  CommunityFriendRequest,
  CommunityMachineCreated,
  CommunityMachineRemoved,
  CommunityMachineStatus,
  CommunityMachineUpdated,
  CommunityMemberJoin,
  CommunityMemberLeave,
  CommunityMemberUpdate,
  CommunityMentionCreate,
  CommunityMessageCreate,
  CommunityPinAdd,
  CommunityPinRemove,
  CommunityPresenceUpdate,
  CommunityReactionAdd,
  CommunityReactionRemove,
  CommunityServerDelete,
  CommunityServerUpdate,
  CommunityTypingStart,
} from "@alook/shared"
import type { useCommunityStore } from "@/stores/community"
import type { useCommunityWsStore } from "@/stores/community/ws"

export type Subscription = {
  // The focused regular channel/thread.
  channelId?: string
  // The focused DM's channel id. A DM is a channel now; this slot keeps its
  // name only to mark "the focused channel is a DM" so the handler routes its
  // events into the `dmMessages` cache and the `dm:` typing scope.
  dmConversationId?: string
}

/**
 * DEPRECATED callback shape retained until the God-context (`contexts/
 * community/context.tsx`) is deleted in Step 4. The primary integration path
 * now writes state directly into the query cache and Zustand stores; callers
 * subscribe via `useQuery` and receive updates through those channels.
 *
 * Passing callbacks still fires them (in addition to the cache patches) so
 * legacy consumers don't observe silent regressions during the migration.
 */
export type CommunityWsCallbacks = {
  onMessage?: (event: CommunityMessageCreate) => void
  onAnyMessage?: (event: CommunityMessageCreate) => void
  onReaction?: (event: CommunityReactionAdd | CommunityReactionRemove) => void
  onTyping?: (event: CommunityTypingStart) => void
  onPresence?: (event: CommunityPresenceUpdate) => void
  onChildChannel?: (event: CommunityChildChannelCreate | CommunityChildChannelUpdate) => void
  onMember?: (event: CommunityMemberJoin | CommunityMemberLeave | CommunityMemberUpdate) => void
  onChannel?: (event: CommunityChannelCreate | CommunityChannelUpdate | CommunityChannelDelete | CommunityChannelReorder) => void
  onPin?: (event: CommunityPinAdd | CommunityPinRemove) => void
  onFriend?: (event: CommunityFriendRequest | CommunityFriendAccept | CommunityFriendReject | CommunityFriendRemove | CommunityFriendBlock) => void
  onServer?: (event: CommunityServerUpdate | CommunityServerDelete) => void
  onCategory?: (event: CommunityCategoryCreate | CommunityCategoryUpdate | CommunityCategoryDelete | CommunityCategoryReorder) => void
  onMention?: (event: CommunityMentionCreate) => void
  onMachine?: (event: CommunityMachineCreated | CommunityMachineStatus | CommunityMachineUpdated | CommunityMachineRemoved) => void
}

/**
 * Optional args — the community feature needs to know the viewer's userId so
 * reactions from that user light up the "me" flag. Passing null keeps the
 * hook usable in places where the viewer identity isn't yet loaded.
 */
export type UseCommunityWsOptions = CommunityWsCallbacks & {
  viewerUserId?: string | null
}

export type CommunityWsHandlerContext = {
  queryClient: QueryClient
  communityStore: ReturnType<typeof useCommunityStore.getState>
  wsStore: ReturnType<typeof useCommunityWsStore.getState>
  sub: Subscription
  cbs: CommunityWsCallbacks
  viewerUserIdRef: { current: string | null }
  matchesFocus: (event: { channelId?: string }) => boolean
  scheduleInboxInvalidate: () => void
}

export type MessageEventContext = CommunityWsHandlerContext
export type TypingEventContext = Pick<
  CommunityWsHandlerContext,
  "sub" | "cbs" | "viewerUserIdRef" | "matchesFocus"
>
export type StructureTreeEventContext = Pick<
  CommunityWsHandlerContext,
  "queryClient" | "cbs"
>
export type MembershipEventContext = Pick<
  CommunityWsHandlerContext,
  "queryClient" | "cbs" | "viewerUserIdRef"
>
export type SocialEventContext = Pick<
  CommunityWsHandlerContext,
  "queryClient" | "sub" | "cbs" | "viewerUserIdRef"
>
export type PresenceMachineEventContext = Pick<
  CommunityWsHandlerContext,
  "queryClient" | "cbs"
>
