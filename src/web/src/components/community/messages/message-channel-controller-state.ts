"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import {
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  type MentionType,
} from "@alook/shared"
import { toastApiError } from "@/lib/api/client"
import { apiFetchProfiles } from "@/lib/community/profile-seed"
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
import { communityReplicaMessageSearchCoverage } from "@/lib/community/replica/query-seed"
import type {
  MessageChannelControllerProps,
  MessageChannelControllerValue,
  MessageContextTarget,
  MessageSearchStatus,
  ReplyTarget,
} from "./message-channel-controller-types"

const MESSAGE_SEARCH_RESULT_LIMIT = 50

export function useMessageChannelController({
  channelId,
  serverId,
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
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<Msg[]>([])
  const [searchStatus, setSearchStatus] = useState<MessageSearchStatus>({
    state: "idle",
    coverage: "none",
    firstSeq: null,
    lastSeq: null,
  })
  const searchGeneration = useRef(0)
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
    setSearchStatus({ state: "idle", coverage: "none", firstSeq: null, lastSeq: null })
    searchGeneration.current += 1
    setContextTarget(null)
  }, [channelId])

  const search = useCallback(async (query: string) => {
    const generation = ++searchGeneration.current
    setSearchQuery(query)
    if (!query.trim()) {
      setSearchResults([])
      setSearchStatus({ state: "idle", coverage: "none", firstSeq: null, lastSeq: null })
      return
    }
    const coverage = communityReplicaMessageSearchCoverage(queryClient, channelId)
    const trimmedQuery = query.trim()
    const needle = trimmedQuery.toLocaleLowerCase()
    const validQueryLength = trimmedQuery.length >= MIN_SEARCH_LENGTH
      && trimmedQuery.length <= MAX_SEARCH_LENGTH
    const localResults = coverage && validQueryLength
      ? feed.messages
          .filter((message) => (message.content ?? "").toLocaleLowerCase().includes(needle))
          .slice(0, MESSAGE_SEARCH_RESULT_LIMIT)
      : []
    setSearchResults(localResults)
    if (coverage?.completeness === "complete" && validQueryLength) {
      setSearchStatus({
        state: "complete",
        coverage: "complete",
        firstSeq: coverage.firstSeq,
        lastSeq: coverage.lastSeq,
      })
      return
    }
    setSearchStatus({
      state: "searching",
      coverage: coverage?.completeness ?? "none",
      firstSeq: coverage?.firstSeq ?? null,
      lastSeq: coverage?.lastSeq ?? null,
    })
    try {
      const params = new URLSearchParams({ q: query, channelId })
      const data = await apiFetchProfiles<{
        results: Array<{
          message: { id: string; content: string; authorId: string; createdAt: string }
          author: { id: string; name: string; image: string | null; avatarVersion: number }
        }>
      }>(
        `/api/community/messages/search?${params}`,
        (response) => response.results.map((result) => ({
          id: result.author.id,
          identityAbout: { name: result.author.name },
          avatar: {
            avatar: result.author.image ?? avatarInitial(result.author.name),
            avatarVersion: result.author.avatarVersion,
          },
        })),
      )
      if (generation !== searchGeneration.current) return
      setSearchResults(data.results.map((result) => ({
        id: result.message.id,
        type: "chat" as const,
        authorId: result.author.id,
        authorName: result.author.name,
        authorAvatar: result.author.image ?? avatarInitial(result.author.name),
        authorAvatarVersion: result.author.avatarVersion,
        content: result.message.content,
        createdAt: result.message.createdAt,
      })))
      setSearchStatus({ state: "complete", coverage: "complete", firstSeq: null, lastSeq: null })
    } catch (error) {
      if (generation !== searchGeneration.current) return
      setSearchStatus({
        state: "coverage-miss",
        coverage: coverage?.completeness ?? "none",
        firstSeq: coverage?.firstSeq ?? null,
        lastSeq: coverage?.lastSeq ?? null,
      })
      toastApiError(error, "Search failed")
    }
  }, [channelId, feed.messages, queryClient])

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

  const seqParam = searchParams.get("seq")
  const searchParamsString = searchParams.toString()
  useEffect(() => {
    if (!seqParam) return
    const seq = Number(seqParam)
    if (!Number.isFinite(seq)) return
    setContextTarget({ serverId, channelId, label: channelName, seq })
    const href = `${pathname}${searchParamsString ? `?${searchParamsString}` : ""}`
    router.replace(removeCommunityParam(href, "seq"), { scroll: false })
  }, [seqParam, serverId, channelId, channelName, pathname, router, searchParamsString])

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
    searchStatus,
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
    searchStatus,
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
