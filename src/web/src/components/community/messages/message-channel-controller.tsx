"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { deriveThreadName, type MentionType } from "@alook/shared"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { avatarInitial } from "@/lib/community/avatar"
import type { FileAttachment, ImagePreview, Msg } from "@/lib/community/models/message"
import type { SendAttachment } from "@/components/community/messages/composer"
import type { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"
import {
  useCommunityStore,
  useTypingNamesForScope,
  useTypingUsersForScope,
} from "@/stores/community"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { toOptimisticReplyPreview } from "@/lib/community/reply-preview"
import {
  sendNonce,
  tempMessageId,
  toAttachmentVm,
  useCreateThread,
  useEditMessage,
  usePinMessage,
  useSendMessage,
  useToggleMark,
  useToggleReactionApi,
  useUnpinMessage,
  useUploadFile,
  zipUploadResultsWithDimensions,
  type UploadedAttachment,
} from "@/hooks/community/mutations"
import {
  communityWsResetTypingThrottle,
  communityWsSendTyping,
} from "@/hooks/community/use-community-ws"

type MessageFeed = ReturnType<typeof useChannelMessageFeed>

type Viewer = {
  id: string
  name: string
  avatar: string
}

type MessageUiHandlers = {
  navigate?: (serverId: string, channelId: string) => void
  previewImage?: (image: ImagePreview) => void
  previewAttachment?: (attachment: FileAttachment) => void
}

export function MessageChannelController({
  channelId,
  serverId,
  serverParam,
  channelName,
  forumParentChannelId,
  viewer,
  anchorMessageId,
  feed,
  uiHandlers,
  onOpenThread,
  onOpenPinned,
  resolveUserName,
  children,
}: {
  channelId: string
  serverId: string
  serverParam: string
  channelName: string
  forumParentChannelId?: string
  viewer: Viewer
  anchorMessageId: string | null
  feed: MessageFeed
  uiHandlers: MessageUiHandlers
  onOpenThread: (threadId: string) => void
  onOpenPinned: () => void
  resolveUserName: (userId: string) => string
  children: (controller: MessageChannelControllerValue) => ReactNode
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string; text: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<Msg[]>([])
  const [scrollTargetId, setScrollTargetId] = useState<string | null>(anchorMessageId)
  const [contextTarget, setContextTarget] = useState<{
    serverId: string
    channelId: string
    label: string
    seq: number
  } | null>(null)
  const { mutateAsync: sendMessageAsync } = useSendMessage()
  const toggleReactionApi = useToggleReactionApi()
  const { mutate: pinMessageMutate } = usePinMessage()
  const { mutate: unpinMessageMutate } = useUnpinMessage()
  const toggleMark = useToggleMark()
  const { mutate: editMessage } = useEditMessage()
  const { mutateAsync: createThreadAsync } = useCreateThread()
  const { mutateAsync: uploadFileAsync } = useUploadFile()
  const typingUserIds = useTypingUsersForScope(`ch:${channelId}`)
  const typingNames = useTypingNamesForScope(`ch:${channelId}`)
  const pinnedIds = useMemo(() => new Set(feed.pinned.map((message) => message.id)), [feed.pinned])
  const consumeScrollTarget = useCallback((targetId: string) => {
    setScrollTargetId((current) => (current === targetId ? null : current))
  }, [])

  useEffect(() => {
    if (!scrollTargetId) return
    if (feed.messages.some((message) => message.id === scrollTargetId)) return
    if (feed.isError) {
      setScrollTargetId((current) => (current === scrollTargetId ? null : current))
    }
  }, [
    scrollTargetId,
    feed.messages,
    feed.isError,
  ])

  useEffect(() => {
    setReplyTo(null)
    setSearchQuery("")
    setSearchResults([])
    setContextTarget(null)
  }, [channelId])

  const search = useCallback(async (query: string) => {
    setSearchQuery(query)
    if (!query.trim()) {
      setSearchResults([])
      return
    }
    try {
      const params = new URLSearchParams({ q: query, channelId })
      const data = await apiFetch<{
        results: Array<{
          message: { id: string; content: string; authorId: string; createdAt: string }
          author: { name: string; image: string | null }
        }>
      }>(`/api/community/messages/search?${params}`)
      setSearchResults(data.results.map((result) => ({
        id: result.message.id,
        type: "chat" as const,
        authorName: result.author.name,
        authorAvatar: result.author.image ?? avatarInitial(result.author.name),
        content: result.message.content,
        createdAt: result.message.createdAt,
      })))
    } catch (error) {
      setSearchResults([])
      toastApiError(error, "Search failed")
    }
  }, [channelId])

  const openContextSeq = useCallback((seq: number) => {
    setContextTarget((current) =>
      current ? { ...current, seq } : { serverId, channelId, label: channelName, seq },
    )
  }, [serverId, channelId, channelName])

  const onSheetReply = useCallback((target: { id: string; authorName: string; text: string }) => {
    if (contextTarget && contextTarget.channelId !== channelId) {
      useCommunityStore.getState().setPendingReply({ channelId: contextTarget.channelId, target })
      setContextTarget(null)
      uiHandlers.navigate?.(contextTarget.serverId, contextTarget.channelId)
      return
    }
    setReplyTo(target)
    setContextTarget(null)
  }, [contextTarget, channelId, uiHandlers])

  const pendingReply = useCommunityStore((state) => state.pendingReply)
  useEffect(() => {
    if (!pendingReply || pendingReply.channelId !== channelId) return
    setReplyTo(pendingReply.target)
    useCommunityStore.getState().setPendingReply(null)
  }, [pendingReply, channelId])

  const actionContext = useRef({
    messages: feed.messages,
    pinnedIds,
    channelName,
    uiHandlers,
    onOpenThread,
    onOpenPinned,
  })
  useLayoutEffect(() => {
    actionContext.current = {
      messages: feed.messages,
      pinnedIds,
      channelName,
      uiHandlers,
      onOpenThread,
      onOpenPinned,
    }
  }, [feed.messages, pinnedIds, channelName, uiHandlers, onOpenThread, onOpenPinned])

  const jumpToSeq = useCallback((seq: number) => {
    const message = actionContext.current.messages.find((item) => item.seq === seq)
    if (message) setScrollTargetId(message.id)
    else setContextTarget({ serverId, channelId, label: channelName, seq })
  }, [serverId, channelId, channelName])

  const openMessageContext = useCallback(
    (target: { serverId: string; channelId: string; label: string; seq: number }) => setContextTarget(target),
    [],
  )

  useEffect(() => {
    useCommunityStore.getState().registerUiHandlers({ jumpToSeq, openMessageContext })
    return () => useCommunityStore.getState().registerUiHandlers({ jumpToSeq: undefined, openMessageContext: undefined })
  }, [jumpToSeq, openMessageContext])

  const seqParam = searchParams.get("seq")
  useEffect(() => {
    if (!seqParam) return
    const seq = Number(seqParam)
    if (!Number.isFinite(seq)) return
    setContextTarget({ serverId, channelId, label: channelName, seq })
    router.replace(`/c/channels/${serverParam}/${channelId}`, { scroll: false })
  }, [seqParam, serverId, channelId, channelName, router, serverParam])

  const messageScope = useMemo(
    () => ({ kind: "channel" as const, id: channelId, serverId }),
    [channelId, serverId],
  )

  const runAcceptedIntent = useCallback(
    async (nonce: string) => {
      const streamStore = useMessageStreamStore.getState()
      const payload = streamStore.getRetryPayload(messageScope, nonce)
      if (!payload) return
      let uploadedAttachments: UploadedAttachment[] | undefined
      if (payload.localUploads.length > 0 && payload.uploadStatus === "settled") {
        const projected = payload.message.attachments
        if (projected?.length === payload.localUploads.length) {
          uploadedAttachments = projected.map((attachment, index) => {
            const local = payload.localUploads[index]
            return {
              id: attachment.url.slice(attachment.url.lastIndexOf("/") + 1),
              filename: local.file.name,
              contentType: local.file.type,
              size: local.file.size,
              ...(attachment.kind === "image" && attachment.thumbnailUrl !== undefined
                ? { hasThumbnail: true }
                : {}),
              width: local.width,
              height: local.height,
            }
          })
        }
      }
      if (payload.localUploads.length > 0 && !uploadedAttachments) {
        const results = await Promise.all(
          payload.localUploads.map((upload) =>
            uploadFileAsync({
              target: { channelId },
              file: upload.file,
              thumbnailBlob: upload.thumbnailBlob,
              width: upload.width,
              height: upload.height,
            }).catch((error) => {
              toastApiError(error, "Failed to attach file")
              return null
            }),
          ),
        )
        if (results.some((result) => result === null)) {
          streamStore.dispatch(messageScope, { type: "uploadFailed", nonce })
          return
        }
        uploadedAttachments = zipUploadResultsWithDimensions(results, [...payload.localUploads])
        streamStore.dispatch(messageScope, {
          type: "uploadSettled",
          nonce,
          attachments: uploadedAttachments.map((attachment) =>
            toAttachmentVm(channelId, attachment)),
        })
      }
      try {
        await sendMessageAsync({
          serverId,
          channelId,
          forumParentChannelId,
          content: payload.message.content ?? "",
          replyToId: payload.message.replyTo?.id,
          mentionType: payload.mentionType,
          attachments: uploadedAttachments,
          nonce,
          author: {
            id: viewer.id,
            name: viewer.name,
            avatar: viewer.avatar,
          },
        })
      } catch {
        return
      }
    },
    [messageScope, uploadFileAsync, channelId, forumParentChannelId, sendMessageAsync, serverId, viewer.id, viewer.name, viewer.avatar],
  )

  const messageActions = useMemo(() => ({
    onToggleReaction: (id: string, emoji: string) =>
      toggleReactionApi({ serverId, channelId, messageId: id, emoji, userId: viewer.id }),
    onReact: (id: string, emoji: string) =>
      toggleReactionApi({ serverId, channelId, messageId: id, emoji, userId: viewer.id }),
    onReply: (id: string) => {
      const message = actionContext.current.messages.find((item) => item.id === id)
      if (message) {
        setReplyTo({
          id: message.id,
          authorName: message.authorName ?? "",
          text: message.content ?? "",
        })
      }
    },
    onPin: (id: string) => {
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
    onMark: (id: string) => toggleMark(channelId, id),
    onCreateThread: async (id: string) => {
      const message = actionContext.current.messages.find((item) => item.id === id)
      const name = deriveThreadName(message?.content, actionContext.current.channelName)
      try {
        const data = await createThreadAsync({ serverId, channelId, messageId: id, name })
        actionContext.current.onOpenThread(data.id)
      } catch (error) {
        toastApiError(error, "Failed to create thread")
      }
    },
    onCopy: (id: string) => {
      const message = actionContext.current.messages.find((item) => item.id === id)
      if (!message?.content) return
      void navigator.clipboard?.writeText(message.content)
      toast("Copied to clipboard")
    },
    onEdit: (id: string) => {
      const message = actionContext.current.messages.find((item) => item.id === id)
      if (!message?.content || message.authorId !== viewer.id || message.seq === undefined) return
      const content = window.prompt("Edit message", message.content)
      if (!content || content === message.content) return
      editMessage({ serverId, channelId, messageId: id, content }, {
        onError: (error) => toastApiError(error, "Failed to edit message"),
      })
    },
    onRetry: (id: string) => {
      const message = actionContext.current.messages.find((item) => item.id === id)
      if (!message?.clientNonce) return
      useMessageStreamStore.getState().dispatch(messageScope, {
        type: "retry",
        nonce: message.clientNonce,
      })
      void runAcceptedIntent(message.clientNonce)
    },
    onDismiss: (id: string) => {
      const message = actionContext.current.messages.find((item) => item.id === id)
      if (!message?.clientNonce) return
      useMessageStreamStore.getState().dispatch(messageScope, {
        type: "dismissFailed",
        nonce: message.clientNonce,
      })
    },
    onPreviewImage: (image: ImagePreview) => actionContext.current.uiHandlers.previewImage?.(image),
    onPreviewAttachment: (attachment: FileAttachment) => actionContext.current.uiHandlers.previewAttachment?.(attachment),
    onDownloadFile: (url: string, name: string) => {
      const link = document.createElement("a")
      link.href = url
      link.download = name
      link.click()
    },
  }), [
    channelId,
    serverId,
    viewer.id,
    toggleReactionApi,
    unpinMessageMutate,
    pinMessageMutate,
    toggleMark,
    createThreadAsync,
    editMessage,
    messageScope,
    runAcceptedIntent,
  ])

  const acceptMessage = useCallback((
    markdown: string,
    attachments?: SendAttachment[],
    mentionType?: MentionType,
  ): boolean => {
    if (!markdown && !attachments?.length) return false
    const nonce = sendNonce()
    const createdPreviewUrls: string[] = []
    const accepted = useMessageStreamStore.getState().accept(messageScope, {
      nonce,
      tempId: tempMessageId(),
      message: {
        type: "chat",
        authorId: viewer.id,
        authorName: viewer.name,
        authorAvatar: viewer.avatar,
        content: markdown,
        createdAt: new Date().toISOString(),
        ...(replyTo ? { replyTo: toOptimisticReplyPreview(replyTo) } : {}),
      },
      localUploads: attachments?.map((attachment) => {
        const previewObjectUrl = attachment.previewObjectUrl ?? URL.createObjectURL(attachment.file)
        if (!attachment.previewObjectUrl) createdPreviewUrls.push(previewObjectUrl)
        return {
          file: attachment.file,
          thumbnailBlob: attachment.thumbnailBlob,
          previewObjectUrl,
          width: attachment.width,
          height: attachment.height,
        }
      }) ?? [],
      mentionType,
    })
    if (!accepted) {
      for (const url of createdPreviewUrls) URL.revokeObjectURL(url)
      return false
    }
    void runAcceptedIntent(nonce)
    communityWsResetTypingThrottle({ channelId })
    setReplyTo(null)
    return true
  }, [channelId, messageScope, replyTo, runAcceptedIntent, viewer.avatar, viewer.id, viewer.name])

  const value = useMemo<MessageChannelControllerValue>(() => ({
    feed,
    pinnedIds,
    replyTo,
    setReplyTo,
    searchQuery,
    searchResults,
    search,
    scrollTargetId,
    setScrollTargetId,
    consumeScrollTarget,
    contextTarget,
    setContextTarget,
    openContextSeq,
    onSheetReply,
    jumpToSeq,
    messageActions,
    threadActions: { ...messageActions, onCreateThread: undefined },
    acceptMessage,
    handleTyping: () => communityWsSendTyping({ channelId }),
    typingUsers: typingUserIds.map((id) => typingNames[id] ?? resolveUserName(id)),
  }), [
    feed,
    pinnedIds,
    replyTo,
    searchQuery,
    searchResults,
    search,
    scrollTargetId,
    consumeScrollTarget,
    contextTarget,
    openContextSeq,
    onSheetReply,
    jumpToSeq,
    messageActions,
    acceptMessage,
    channelId,
    typingUserIds,
    typingNames,
    resolveUserName,
  ])

  // eslint-disable-next-line react-hooks/refs -- render prop receives callbacks that read the latest ref only on user actions
  return children(value)
}

export type MessageChannelControllerValue = {
  feed: MessageFeed
  pinnedIds: Set<string>
  replyTo: { id: string; authorName: string; text: string } | null
  setReplyTo: (reply: { id: string; authorName: string; text: string } | null) => void
  searchQuery: string
  searchResults: Msg[]
  search: (query: string) => void
  scrollTargetId: string | null
  setScrollTargetId: (targetId: string | null) => void
  consumeScrollTarget: (targetId: string) => void
  contextTarget: { serverId: string; channelId: string; label: string; seq: number } | null
  setContextTarget: (target: { serverId: string; channelId: string; label: string; seq: number } | null) => void
  openContextSeq: (seq: number) => void
  onSheetReply: (target: { id: string; authorName: string; text: string }) => void
  jumpToSeq: (seq: number) => void
  messageActions: {
    onToggleReaction: (id: string, emoji: string) => void
    onReact: (id: string, emoji: string) => void
    onReply: (id: string) => void
    onPin: (id: string) => void
    onMark: (id: string) => void
    onCreateThread: (id: string) => Promise<void>
    onCopy: (id: string) => void
    onEdit: (id: string) => void
    onRetry: (id: string) => void
    onDismiss: (id: string) => void
    onPreviewImage: (image: ImagePreview) => void
    onPreviewAttachment: (attachment: FileAttachment) => void
    onDownloadFile: (url: string, name: string) => void
  }
  threadActions: Omit<MessageChannelControllerValue["messageActions"], "onCreateThread"> & {
    onCreateThread: undefined
  }
  acceptMessage: (markdown: string, attachments?: SendAttachment[], mentionType?: MentionType) => boolean
  handleTyping: () => void
  typingUsers: string[]
}
