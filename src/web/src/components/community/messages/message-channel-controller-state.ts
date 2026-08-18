"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import type { MentionType } from "@alook/shared"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { avatarInitial } from "@/lib/community/avatar"
import type { Msg } from "@/lib/community/models/message"
import type { SendAttachment } from "./composer"
import {
  useCommunityStore,
  useTypingNamesForScope,
  useTypingUsersForScope,
} from "@/stores/community"
import {
  useCreateThread,
  useEditMessage,
  usePinMessage,
  useSendMessage,
  useToggleMark,
  useToggleReactionApi,
  useUnpinMessage,
  useUploadFile,
} from "@/hooks/community/mutations"
import { communityWsSendTyping } from "@/hooks/community/use-community-ws"
import {
  createMessageActions,
  type MessageActionContext,
} from "./message-channel-controller-actions"
import {
  acceptChannelMessage,
  runAcceptedMessageIntent,
} from "./message-channel-controller-send"
import { removeCommunityParam } from "@/lib/community/community-route"
import type {
  MessageChannelControllerProps,
  MessageChannelControllerValue,
  MessageContextTarget,
  ReplyTarget,
} from "./message-channel-controller-types"

export function useMessageChannelController({
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
}: Omit<MessageChannelControllerProps, "children">): MessageChannelControllerValue {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<Msg[]>([])
  const [scrollTargetId, setScrollTargetId] = useState<string | null>(anchorMessageId)
  const [contextTarget, setContextTarget] = useState<MessageContextTarget | null>(null)
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
  const pinnedIds = useMemo(
    () => new Set(feed.pinned.map((message) => message.id)),
    [feed.pinned],
  )
  const consumeScrollTarget = useCallback((targetId: string) => {
    setScrollTargetId((current) => (current === targetId ? null : current))
  }, [])

  useEffect(() => {
    if (!scrollTargetId) return
    if (feed.messages.some((message) => message.id === scrollTargetId)) return
    if (feed.isError) {
      setScrollTargetId((current) => (current === scrollTargetId ? null : current))
    }
  }, [scrollTargetId, feed.messages, feed.isError])

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
    setContextTarget((current) => (
      current ? { ...current, seq } : { serverId, channelId, label: channelName, seq }
    ))
  }, [serverId, channelId, channelName])

  const onSheetReply = useCallback((target: ReplyTarget) => {
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

  const actionContext = useRef<MessageActionContext>({
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

  const openMessageContext = useCallback((target: MessageContextTarget) => {
    setContextTarget(target)
  }, [])

  useEffect(() => {
    useCommunityStore.getState().registerUiHandlers({ jumpToSeq, openMessageContext })
    return () => useCommunityStore.getState().registerUiHandlers({
      jumpToSeq: undefined,
      openMessageContext: undefined,
    })
  }, [jumpToSeq, openMessageContext])

  const seqParam = searchParams.get("seq")
  const searchParamsString = searchParams.toString()
  useEffect(() => {
    if (!seqParam) return
    const seq = Number(seqParam)
    if (!Number.isFinite(seq)) return
    setContextTarget({ serverId, channelId, label: channelName, seq })
    const href = `/c/channels/${serverParam}/${channelId}${searchParamsString ? `?${searchParamsString}` : ""}`
    router.replace(removeCommunityParam(href, "seq"), { scroll: false })
  }, [seqParam, serverId, channelId, channelName, router, searchParamsString, serverParam])

  const messageScope = useMemo(
    () => ({ kind: "channel" as const, id: channelId, serverId }),
    [channelId, serverId],
  )

  const runAcceptedIntent = useCallback(async (nonce: string) => {
    await runAcceptedMessageIntent({
      messageScope,
      nonce,
      uploadFileAsync,
      sendMessageAsync,
      channelId,
      forumParentChannelId,
      serverId,
      viewer: { id: viewer.id, name: viewer.name, avatar: viewer.avatar },
    })
  }, [
    messageScope,
    uploadFileAsync,
    channelId,
    forumParentChannelId,
    sendMessageAsync,
    serverId,
    viewer.id,
    viewer.name,
    viewer.avatar,
  ])

  // eslint-disable-next-line react-hooks/refs -- helper closes over the ref; current is read only by user actions
  const messageActions = useMemo(() => createMessageActions({
    actionContext,
    serverId,
    channelId,
    viewerUserId: viewer.id,
    setReplyTo,
    toggleReactionApi,
    unpinMessageMutate,
    pinMessageMutate,
    toggleMark,
    createThreadAsync,
    editMessage,
    messageScope,
    runAcceptedIntent,
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
  ): boolean => acceptChannelMessage({
    markdown,
    attachments,
    mentionType,
    messageScope,
    viewer: { id: viewer.id, name: viewer.name, avatar: viewer.avatar },
    replyTo,
    runAcceptedIntent,
    channelId,
    clearReply: () => setReplyTo(null),
  }), [channelId, messageScope, replyTo, runAcceptedIntent, viewer.avatar, viewer.id, viewer.name])

  return useMemo<MessageChannelControllerValue>(() => ({
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
}
