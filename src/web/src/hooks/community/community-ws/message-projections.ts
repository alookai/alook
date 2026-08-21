import type { QueryKey } from "@tanstack/react-query"
import type {
  CommunityMessageUpdated,
  CommunityReactionAdd,
  CommunityReactionRemove,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import type { CanonicalMessage, MessageScope } from "@/lib/community/message-stream"
import type { Msg } from "@/lib/community/models/message"
import { useCommunityStore } from "@/stores/community"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import {
  applyReactionToCache,
  applyReactionToMessage,
  findCachedMessage,
  patchApprovalInCache,
  patchMessageContentInCache,
  type PageCache,
} from "./cache"
import type { MessageEventContext } from "./handler-context"

type ReactionEvent = CommunityReactionAdd | CommunityReactionRemove
type MessageProjectionContext = Pick<
  MessageEventContext,
  "projection" | "queryClient" | "sub" | "viewerUserIdRef"
>

function refreshOverlayCopy(
  context: MessageProjectionContext,
  scope: MessageScope,
  cacheKey: QueryKey,
  messageId: string,
  update: (message: CanonicalMessage) => CanonicalMessage,
) {
  const fallback = [...getMessageOverlay(scope).liveById.values()]
    .find((message) => message.id === messageId)
  if (!fallback) return
  const cached = findCachedMessage(
    context.queryClient.getQueryData<PageCache>(cacheKey),
    messageId,
  )
  const source = cached?.seq !== undefined ? cached as CanonicalMessage : fallback
  useMessageStreamStore.getState().dispatch(scope, {
    type: "liveRefreshed",
    message: update(source),
  })
}

export function projectReactionCopies(
  event: ReactionEvent,
  context: MessageProjectionContext,
) {
  const { projection, queryClient, sub, viewerUserIdRef } = context
  projection.project(() => {
    const viewerId = viewerUserIdRef.current
    queryClient.setQueriesData<PageCache>(
      { queryKey: communityKeys.channelMessages(event.channelId) },
      (cache) => applyReactionToCache(cache, event, viewerId),
    )
    queryClient.setQueryData<PageCache>(
      communityKeys.dmMessages(event.channelId),
      (cache) => applyReactionToCache(cache, event, viewerId),
    )
    queryClient.setQueryData<Msg | undefined>(
      communityKeys.message(event.messageId),
      (message) => message ? applyReactionToMessage(message, event, viewerId) : message,
    )
    if (event.channelId === sub.channelId) {
      const serverId = useCommunityStore.getState().currentServerId
      if (serverId) {
        refreshOverlayCopy(
          context,
          { kind: "channel", id: event.channelId, serverId },
          communityKeys.channelMessages(event.channelId),
          event.messageId,
          (message) => applyReactionToMessage(message, event, viewerId) as CanonicalMessage,
        )
      }
    }
    if (event.channelId === sub.dmConversationId) {
      refreshOverlayCopy(
        context,
        { kind: "dm", id: event.channelId },
        communityKeys.dmMessages(event.channelId),
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
  const { projection, queryClient, sub } = context
  projection.project(() => {
    if (event.channelId === sub.dmConversationId || event.channelId === sub.channelId) {
      queryClient.setQueryData<PageCache>(
        communityKeys.dmMessages(event.channelId),
        (cache) => patchApprovalInCache(cache, event.messageId, event.approval),
      )
      queryClient.setQueryData<PageCache>(
        communityKeys.channelMessages(event.channelId),
        (cache) => patchApprovalInCache(cache, event.messageId, event.approval),
      )
    }
    if (event.channelId === sub.dmConversationId) {
      refreshOverlayCopy(
        context,
        { kind: "dm", id: event.channelId },
        communityKeys.dmMessages(event.channelId),
        event.messageId,
        (message) => ({ ...message, approval: event.approval }),
      )
    } else if (event.channelId === sub.channelId) {
      const serverId = useCommunityStore.getState().currentServerId
      if (serverId) {
        refreshOverlayCopy(
          context,
          { kind: "channel", id: event.channelId, serverId },
          communityKeys.channelMessages(event.channelId),
          event.messageId,
          (message) => ({ ...message, approval: event.approval }),
        )
      }
    }
  })
}

export function projectEditedCopies(
  event: { channelId: string; messageId: string; content: string },
  context: Pick<MessageEventContext, "projection" | "queryClient">,
) {
  const { projection, queryClient } = context
  projection.project(() => {
    queryClient.setQueryData<{ content: string }>(
      communityKeys.message(event.messageId),
      (message) => message ? { ...message, content: event.content } : message,
    )
    queryClient.setQueriesData<PageCache>(
      { queryKey: communityKeys.channelMessages(event.channelId) },
      (cache) => patchMessageContentInCache(cache, event.messageId, event.content),
    )
    queryClient.setQueryData<PageCache>(
      communityKeys.dmMessages(event.channelId),
      (cache) => patchMessageContentInCache(cache, event.messageId, event.content),
    )
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
