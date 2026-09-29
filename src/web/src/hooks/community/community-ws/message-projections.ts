import type {
  CommunityMessageUpdated,
  CommunityReactionAdd,
  CommunityReactionRemove,
} from "@alook/shared"
import type { CanonicalMessage, MessageScope } from "@/lib/community/message-stream"
import { useCommunityStore } from "@/stores/community"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import { applyReactionToMessage } from "./cache"
import type { MessageEventContext } from "./handler-context"

type ReactionEvent = CommunityReactionAdd | CommunityReactionRemove
type MessageProjectionContext = Pick<
  MessageEventContext,
  "projection" | "sub" | "viewerUserIdRef"
>

function refreshOverlayCopy(
  scope: MessageScope,
  messageId: string,
  update: (message: CanonicalMessage) => CanonicalMessage,
) {
  const message = [...getMessageOverlay(scope).liveById.values()]
    .find((candidate) => candidate.id === messageId)
  if (!message) return
  useMessageStreamStore.getState().dispatch(scope, {
    type: "liveRefreshed",
    message: update(message),
  })
}

export function projectReactionCopies(
  event: ReactionEvent,
  context: MessageProjectionContext,
) {
  const { projection, sub, viewerUserIdRef } = context
  projection.project(() => {
    const viewerId = viewerUserIdRef.current
    if (event.channelId === sub.channelId || event.channelId === sub.secondaryChannelId) {
      const serverId = useCommunityStore.getState().currentServerId
      if (serverId) {
        refreshOverlayCopy(
          { kind: "channel", id: event.channelId, serverId },
          event.messageId,
          (message) => applyReactionToMessage(message, event, viewerId) as CanonicalMessage,
        )
      }
    }
    if (event.channelId === sub.dmConversationId) {
      refreshOverlayCopy(
        { kind: "dm", id: event.channelId },
        event.messageId,
        (message) => applyReactionToMessage(message, event, viewerId) as CanonicalMessage,
      )
    }
  })
}

export function projectApprovalCopies(
  event: CommunityMessageUpdated,
  context: MessageProjectionContext,
) {
  const { projection, sub } = context
  projection.project(() => {
    if (event.channelId === sub.dmConversationId) {
      refreshOverlayCopy(
        { kind: "dm", id: event.channelId },
        event.messageId,
        (message) => ({ ...message, approval: event.approval }),
      )
      return
    }
    if (event.channelId === sub.channelId || event.channelId === sub.secondaryChannelId) {
      const serverId = useCommunityStore.getState().currentServerId
      if (serverId) {
        refreshOverlayCopy(
          { kind: "channel", id: event.channelId, serverId },
          event.messageId,
          (message) => ({ ...message, approval: event.approval }),
        )
      }
    }
  })
}

export function projectEditedCopies(
  event: { channelId: string; messageId: string; content: string },
  context: Pick<MessageEventContext, "projection">,
) {
  context.projection.project(() => {
    const streamStore = useMessageStreamStore.getState()
    for (const entry of streamStore.entries.values()) {
      if (entry.scope.id !== event.channelId) continue
      streamStore.dispatch(entry.scope, {
        type: "messageEdited",
        messageId: event.messageId,
        content: event.content,
      })
    }
  })
}
