import { deriveThreadName } from "@alook/shared"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import type { FileAttachment, ImagePreview, Msg } from "@/lib/community/models/message"
import type { CommunityRuntime } from "@/stores/community/runtime"
import { isAbortError } from "@/lib/errors"
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
function current(assert: () => void) { try { assert(); return true } catch { return false } }

export type MessageActionContext = {
  messageIds: readonly string[]
  pinnedIds: Set<string>
  channelName: string
  uiHandlers: MessageUiHandlers
  onOpenThread?: (threadId: string) => void
  onOpenPinned?: () => void
}

export function createMessageActions({
  runtime,
  actionContext,
  getMessage,
  captureView,
  serverId,
  channelId,
  viewerUserId,
  setReplyTo,
  toggleReactionApi,
  addReactionApi,
  unpinMessageMutate,
  pinMessageMutate,
  toggleMark,
  createThreadAsync,
  editMessage,
  messageScope,
  runAcceptedIntent,
}: {
  runtime: CommunityRuntime
  actionContext: { get: () => MessageActionContext }
  getMessage: (id: string) => Msg | undefined
  captureView: () => (() => void) & { signal: AbortSignal }
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
    assertActive?: (() => void) & { signal: AbortSignal }
  }) => void
  addReactionApi: (input: {
    serverId: string
    channelId: string
    messageId: string
    emoji: string
    userId: string
    assertActive?: (() => void) & { signal: AbortSignal }
  }) => void
  unpinMessageMutate: (
    input: { channelId: string; messageId: string; assertActive?: (() => void) & { signal: AbortSignal } },
    options?: MutationOptions,
  ) => void
  pinMessageMutate: (
    input: { channelId: string; messageId: string; assertActive?: (() => void) & { signal: AbortSignal } },
    options?: MutationOptions,
  ) => void
  toggleMark: (channelId: string, messageId: string, assertActive?: (() => void) & { signal: AbortSignal }) => void
  createThreadAsync: (input: {
    serverId: string
    channelId: string
    messageId: string
    name: string
    assertActive?: (() => void) & { signal: AbortSignal }
  }) => Promise<{ id: string }>
  editMessage: (
    input: { serverId: string; channelId: string; messageId: string; content: string; assertActive?: (() => void) & { signal: AbortSignal } },
    options?: MutationOptions,
  ) => void
  messageScope: ChannelMessageScope
  runAcceptedIntent: (nonce: string) => Promise<void>
}): MessageActions {
  return {
    onToggleReaction: (id, emoji) =>
      toggleReactionApi({ serverId, channelId, messageId: id, emoji, userId: viewerUserId, assertActive: captureView() }),
    onReact: (id, emoji) =>
      addReactionApi({ serverId, channelId, messageId: id, emoji, userId: viewerUserId, assertActive: captureView() }),
    onReply: (id) => {
      captureView()()
      const message = getMessage(id)
      if (message) {
        setReplyTo({
          id: message.id,
          authorName: message.authorName ?? "",
          text: displayReplyContent(message.content ?? "", message.replyTo),
        })
      }
    },
    onPin: (id) => {
      const original = captureView(), context = actionContext.get()
      original()
      if (context.pinnedIds.has(id)) {
        unpinMessageMutate({ channelId, messageId: id, assertActive: original }, {
          onSuccess: () => { if (current(original)) toast("Message unpinned") },
          onError: (error) => toastApiError(error, "Failed to unpin message", original),
        })
        return
      }
      pinMessageMutate({ channelId, messageId: id, assertActive: original }, {
        onSuccess: () => {
          if (!current(original)) return
          toast("Message pinned")
          context.onOpenPinned?.()
        },
        onError: (error) => toastApiError(error, "Failed to pin message", original),
      })
    },
    onMark: (id) => toggleMark(channelId, id, captureView()),
    onCreateThread: async (id) => {
      const original = captureView(), context = actionContext.get()
      original()
      const message = getMessage(id)
      const content = message
        ? displayReplyContent(message.content ?? "", message.replyTo)
        : undefined
      const name = deriveThreadName(content, context.channelName)
      try {
        const data = await createThreadAsync({ serverId, channelId, messageId: id, name, assertActive: original })
        original()
        actionContext.get().onOpenThread?.(data.id)
      } catch (error) {
        toastApiError(error, "Failed to create thread", original)
      }
    },
    onCopy: async (id) => {
      const original = captureView()
      original()
      const message = getMessage(id)
      if (!message) return
      const content = displayReplyContent(message.content ?? "", message.replyTo)
      if (!content) return
      if (!navigator.clipboard) return
      try { await navigator.clipboard.writeText(content); original(); toast("Copied to clipboard") }
      catch (error) { if (!isAbortError(error)) toastApiError(error, "Failed to copy message", original) }
    },
    onEdit: (id) => {
      const original = captureView()
      original()
      const message = getMessage(id)
      if (!message || message.authorId !== viewerUserId || message.seq === undefined) return
      const visibleContent = displayReplyContent(message.content ?? "", message.replyTo)
      if (!visibleContent) return
      const editedContent = window.prompt("Edit message", visibleContent)
      if (!editedContent || editedContent === visibleContent) return
      const content = canonicalizeReplyContent(editedContent, message.replyTo)
      original()
      editMessage({ serverId, channelId, messageId: id, content, assertActive: original }, {
        onError: (error) => toastApiError(error, "Failed to edit message", original),
      })
    },
    onRetry: (id) => {
      captureView()()
      const message = getMessage(id)
      if (!message?.clientNonce) return
      runtime.messageStream.actions.dispatch(messageScope, {
        type: "retry",
        nonce: message.clientNonce,
      })
      void runAcceptedIntent(message.clientNonce)
    },
    onDismiss: (id) => {
      captureView()()
      const message = getMessage(id)
      if (!message?.clientNonce) return
      runtime.messageStream.actions.dispatch(messageScope, {
        type: "dismissFailed",
        nonce: message.clientNonce,
      })
    },
    onPreviewImage: (image: ImagePreview) => { captureView()(); actionContext.get().uiHandlers.previewImage?.(image) },
    onPreviewAttachment: (attachment: FileAttachment) => { captureView()(); actionContext.get().uiHandlers.previewAttachment?.(attachment) },
  }
}
