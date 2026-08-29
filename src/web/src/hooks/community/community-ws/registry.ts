import type { CommunityWsEvent } from "@alook/shared"
import type { CommunityWsReconcilePolicy } from "@/lib/analytics"
import type {
  CommunityWsDispatchContext,
  CommunityWsHandlerContext,
} from "@/hooks/community/community-ws/handler-context"
import { runCommunityWsProjectionTransaction } from "@/hooks/community/community-ws/projection-transaction"
import {
  handleMessageCreate,
  handleMessageEdited,
  handleMessageUpdated,
  handlePinEvent,
  handleReactionEvent,
} from "@/hooks/community/community-ws/message-events"
import { handleTypingStart, handleTypingStop } from "@/hooks/community/community-ws/typing-events"
import {
  handleCategoryEvent,
  handleChannelEvent,
  handleChildChannelCreate,
  handleChildChannelUpdate,
  handleInviteCreate,
  handleServerDelete,
  handleServerUpdate,
} from "@/hooks/community/community-ws/structure-tree-events"
import {
  handleChannelMemberEvent,
  handleMemberJoin,
  handleMemberLeave,
  handleMemberUpdate,
} from "@/hooks/community/community-ws/membership-events"
import {
  handleFriendEvent,
  handleInboxChanged,
  handleMentionCreate,
  handleReadStateAdvanced,
  handleUnreadBump,
} from "@/hooks/community/community-ws/social-events"
import {
  handleBotAuditEvent,
  handleMachineCreated,
  handleMachineRemoved,
  handleMachineStatus,
  handleMachineUpdated,
  handlePresenceUpdate,
  handleStatusUpdate,
} from "@/hooks/community/community-ws/presence-machine-events"

type CommunityEventType = CommunityWsEvent["type"]
type CommunityEventFor<T extends CommunityEventType> = Extract<CommunityWsEvent, { type: T }>
type RegistryEntry<T extends CommunityEventType> = {
  handler: (event: CommunityEventFor<T>, context: CommunityWsHandlerContext) => void
  reconnectPolicies: readonly [CommunityWsReconcilePolicy, ...CommunityWsReconcilePolicy[]]
}
type CommunityWsRegistry = { [T in CommunityEventType]: RegistryEntry<T> }

export const communityWsRegistry = {
  "community:message.create": { handler: handleMessageCreate, reconnectPolicies: ["focused-messages", "inbox-dms"] },
  "community:message.updated": { handler: handleMessageUpdated, reconnectPolicies: ["focused-messages", "friends"] },
  "community:message.edited": { handler: handleMessageEdited, reconnectPolicies: ["focused-messages", "focused-opener", "focused-threads", "all-cached-servers"] },
  "community:reaction.add": { handler: handleReactionEvent, reconnectPolicies: ["focused-messages", "focused-opener"] },
  "community:reaction.remove": { handler: handleReactionEvent, reconnectPolicies: ["focused-messages", "focused-opener"] },
  "community:pin.add": { handler: handlePinEvent, reconnectPolicies: ["focused-messages", "focused-pins"] },
  "community:pin.remove": { handler: handlePinEvent, reconnectPolicies: ["focused-messages", "focused-pins"] },
  "community:typing.start": { handler: handleTypingStart, reconnectPolicies: ["ephemeral-typing"] },
  "community:typing.stop": { handler: handleTypingStop, reconnectPolicies: ["ephemeral-typing"] },
  "community:channel.child_create": { handler: handleChildChannelCreate, reconnectPolicies: ["focused-threads", "all-cached-servers"] },
  "community:channel.child_update": { handler: handleChildChannelUpdate, reconnectPolicies: ["focused-threads", "all-cached-servers"] },
  "community:server.update": { handler: handleServerUpdate, reconnectPolicies: ["all-cached-servers"] },
  "community:server.delete": { handler: handleServerDelete, reconnectPolicies: ["all-cached-servers"] },
  "community:channel.create": { handler: handleChannelEvent, reconnectPolicies: ["all-cached-servers"] },
  "community:channel.update": { handler: handleChannelEvent, reconnectPolicies: ["all-cached-servers"] },
  "community:channel.delete": { handler: handleChannelEvent, reconnectPolicies: ["all-cached-servers", "focused-messages"] },
  "community:channel.reorder": { handler: handleChannelEvent, reconnectPolicies: ["all-cached-servers"] },
  "community:channel.member_add": { handler: handleChannelMemberEvent, reconnectPolicies: ["focused-channel-roster", "all-cached-servers"] },
  "community:channel.member_remove": { handler: handleChannelMemberEvent, reconnectPolicies: ["focused-channel-roster", "all-cached-servers"] },
  "community:category.create": { handler: handleCategoryEvent, reconnectPolicies: ["all-cached-servers"] },
  "community:category.update": { handler: handleCategoryEvent, reconnectPolicies: ["all-cached-servers"] },
  "community:category.delete": { handler: handleCategoryEvent, reconnectPolicies: ["all-cached-servers"] },
  "community:category.reorder": { handler: handleCategoryEvent, reconnectPolicies: ["all-cached-servers"] },
  "community:member.join": { handler: handleMemberJoin, reconnectPolicies: ["all-cached-servers"] },
  "community:member.leave": { handler: handleMemberLeave, reconnectPolicies: ["all-cached-servers"] },
  "community:member.update": { handler: handleMemberUpdate, reconnectPolicies: ["all-cached-servers"] },
  "community:friend.request": { handler: handleFriendEvent, reconnectPolicies: ["friends"] },
  "community:friend.accept": { handler: handleFriendEvent, reconnectPolicies: ["friends"] },
  "community:friend.reject": { handler: handleFriendEvent, reconnectPolicies: ["friends"] },
  "community:friend.remove": { handler: handleFriendEvent, reconnectPolicies: ["friends"] },
  "community:friend.block": { handler: handleFriendEvent, reconnectPolicies: ["friends"] },
  "community:invite.create": { handler: handleInviteCreate, reconnectPolicies: ["all-cached-servers"] },
  "community:mention.create": { handler: handleMentionCreate, reconnectPolicies: ["inbox-dms"] },
  "community:unread.bump": { handler: handleUnreadBump, reconnectPolicies: ["inbox-dms", "all-cached-servers"] },
  "community:read_state.advanced": { handler: handleReadStateAdvanced, reconnectPolicies: ["cached-read-state", "inbox-dms", "all-cached-servers"] },
  "community:inbox.changed": { handler: handleInboxChanged, reconnectPolicies: ["cached-read-state", "inbox-dms", "all-cached-servers"] },
  "community:presence.update": { handler: handlePresenceUpdate, reconnectPolicies: ["presence-overlay", "all-cached-servers"] },
  "community:status.update": { handler: (event) => handleStatusUpdate(event), reconnectPolicies: ["status-overlay"] },
  "community:machine.created": { handler: handleMachineCreated, reconnectPolicies: ["machines"] },
  "community:machine.status": { handler: handleMachineStatus, reconnectPolicies: ["machines"] },
  "community:machine.updated": { handler: handleMachineUpdated, reconnectPolicies: ["machines"] },
  "community:machine.removed": { handler: handleMachineRemoved, reconnectPolicies: ["machines"] },
  "community:bot.audit_event": { handler: (event) => handleBotAuditEvent(event), reconnectPolicies: ["bot-audits"] },
} satisfies CommunityWsRegistry

export function dispatchCommunityWsEvent(
  event: CommunityWsEvent,
  context: CommunityWsDispatchContext,
) {
  dispatchCommunityWsEvents([event], context)
}

export function dispatchCommunityWsEvents(
  events: readonly CommunityWsEvent[],
  context: CommunityWsDispatchContext,
) {
  runCommunityWsProjectionTransaction(context.queryClient, (projection) => {
    const handlerContext: CommunityWsHandlerContext = { ...context, projection }
    for (const event of events) {
      const entry = communityWsRegistry[event.type] as RegistryEntry<typeof event.type>
      entry.handler(event, handlerContext)
    }
  })
}

export const communityWsReconnectPolicies = Array.from(new Set(
  Object.values(communityWsRegistry).flatMap((entry) => entry.reconnectPolicies),
))
