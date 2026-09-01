import type { MutableRefObject } from "react"
import { deriveThreadName } from "@alook/shared"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import type { FileAttachment, ImagePreview, Msg } from "@/lib/community/models/message"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { canonicalizeReplyContent, displayReplyContent } from "@/lib/community/reply-content"
import type {
  MessageActions,
  MessageUiHandlers,
  ReplyTarget,
} from "./message-channel-controller-types"

type ChannelMessageScope = {
  kind: "channel"
  id: string
  serverId: string
}

type MutationOptions = {
  onSuccess?: () => void
  onError?: (error: unknown) => void
}

export type MessageActionContext = {
  messages: Msg[]
  pinnedIds: Set<string>
  channelName: string
  uiHandlers: MessageUiHandlers
  onOpenThread: (threadId: string) => void
  onOpenPinned: () => void
}

export function createMessageActions({
  actionContext,
  serverId,
  channelId,
  viewerUserId,
  setReplyTo,
  toggleReactionApi,
  unpinMessageMutate,
  pinMessageMutate,
  toggleMark,
  createThreadAsync,
  editMessage,
  messageScope,
  runAcceptedIntent,
}: {
  actionContext: MutableRefObject<MessageActionContext>
  serverId: string
  channelId: string
  viewerUserId: string
  setReplyTo: (reply: ReplyTarget) => void
  toggleReactionApi: (input: {
    serverId: string
    channelId: string
    messageId: string
    emoji: string
    userId: string
  }) => void
  unpinMessageMutate: (
    input: { channelId: string; messageId: string },
    options?: MutationOptions,
  ) => void
  pinMessageMutate: (
    input: { channelId: string; messageId: string },
    options?: MutationOptions,
  ) => void
  toggleMark: (channelId: string, messageId: string) => void
  createThreadAsync: (input: {
    serverId: string
    channelId: string
    messageId: string
    name: string
  }) => Promise<{ id: string }>
  editMessage: (
    input: { serverId: string; channelId: string; messageId: string; content: string },
    options?: MutationOptions,
  ) => void
  messageScope: ChannelMessageScope
  runAcceptedIntent: (nonce: string) => Promise<void>
}): MessageActions {
  return {
    onToggleReaction: (id, emoji) =>
      toggleReactionApi({ serverId, channelId, messageId: id, emoji, userId: viewerUserId }),
    onReact: (id, emoji) =>
      toggleReactionApi({ serverId, channelId, messageId: id, emoji, userId: viewerUserId }),
    onReply: (id) => {
      const message = actionContext.current.messages.find((item) => item.id === id)
      if (message) {
        setReplyTo({
          id: message.id,
          authorName: message.authorName ?? "",
          text: displayReplyContent(message.content ?? "", message.replyTo),
        })
      }
    },
    onPin: (id) => {
      if (actionContext.current.pinnedIds.has(id)) {
        unpinMessageMutate({ channelId, messageId: id }, {
          onSuccess: () => toast("Message unpinned"),
          onError: (error) => toastApiError(error, "Failed to unpin message"),
        })
        return
      }
      pinMessageMutate({ channelId, messageId: id }, {
        onSuccess: () => toast("Message pinned"),
        onError: (error) => toastApiError(error, "Failed to pin message"),
      })
      actionContext.current.onOpenPinned()
    },
    onMark: (id) => toggleMark(channelId, id),
    onCreateThread: async (id) => {
      const message = actionContext.current.messages.find((item) => item.id === id)
      const content = message
        ? displayReplyContent(message.content ?? "", message.replyTo)
        : undefined
      const name = deriveThreadName(content, actionContext.current.channelName)
      try {
        const data = await createThreadAsync({ serverId, channelId, messageId: id, name })
        actionContext.current.onOpenThread(data.id)
      } catch (error) {
        toastApiError(error, "Failed to create thread")
      }
    },
    onCopy: (id) => {
      const message = actionContext.current.messages.find((item) => item.id === id)
      if (!message) return
      const content = displayReplyContent(message.content ?? "", message.replyTo)
      if (!content) return
      void navigator.clipboard?.writeText(content)
      toast("Copied to clipboard")
    },
    onEdit: (id) => {
      const message = actionContext.current.messages.find((item) => item.id === id)
      if (!message || message.authorId !== viewerUserId || message.seq === undefined) return
      const visibleContent = displayReplyContent(message.content ?? "", message.replyTo)
      if (!visibleContent) return
      const editedContent = window.prompt("Edit message", visibleContent)
      if (!editedContent || editedContent === visibleContent) return
      const content = canonicalizeReplyContent(editedContent, message.replyTo)
      editMessage({ serverId, channelId, messageId: id, content }, {
        onError: (error) => toastApiError(error, "Failed to edit message"),
      })
    },
    onRetry: (id) => {
      const message = actionContext.current.messages.find((item) => item.id === id)
      if (!message?.clientNonce) return
      useMessageStreamStore.getState().dispatch(messageScope, {
        type: "retry",
        nonce: message.clientNonce,
      })
      void runAcceptedIntent(message.clientNonce)
    },
    onDismiss: (id) => {
      const message = actionContext.current.messages.find((item) => item.id === id)
      if (!message?.clientNonce) return
      useMessageStreamStore.getState().dispatch(messageScope, {
        type: "dismissFailed",
        nonce: message.clientNonce,
      })
    },
    onPreviewImage: (image: ImagePreview) => actionContext.current.uiHandlers.previewImage?.(image),
    onPreviewAttachment: (attachment: FileAttachment) =>
      actionContext.current.uiHandlers.previewAttachment?.(attachment),
  }
}
