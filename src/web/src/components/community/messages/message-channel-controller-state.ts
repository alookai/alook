"use client"
import { createStore, useAtom, useCreateAtom } from "@tanstack/react-store";
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { useCanonicalMessagesById, useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { captureCommunityLiveSnapshotToken, publishCommunityMessages } from "@/lib/community-db/sync"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { useCommunityRuntime } from "@/stores/community/runtime"


import { useCallback, useEffect, useLayoutEffect, useMemo } from "react"
import { materializeMessageStream, type CanonicalMessage } from "@/lib/community/message-stream"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import type { MentionType } from "@alook/shared"

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
  useAddReactionApi,
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
  const profileQueryClient = useQueryClient()
  const communityRuntime = useCommunityRuntime()
  const source = useCommunityViewSource(`message-actions:${serverId}:${channelId}`)
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [replyTo, setReplyTo] = useAtom(useCreateAtom<ReplyTarget | null>(null))
  const [searchQuery, setSearchQuery] = useAtom(useCreateAtom(""))
  const [scrollTargetId, setScrollTargetId] = useAtom(useCreateAtom<string | null>(anchorMessageId))
  const [contextTarget, setContextTarget] = useAtom(useCreateAtom<MessageContextTarget | null>(null))
  const { mutateAsync: sendMessageAsync } = useSendMessage()
  const toggleReactionApi = useToggleReactionApi()
  const addReactionApi = useAddReactionApi()
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
  }, [setScrollTargetId])

  useEffect(() => {
    if (!scrollTargetId) return
    if (feed.messages.some((message) => message.id === scrollTargetId)) return
    if (feed.isError) {
      setScrollTargetId((current) => (current === scrollTargetId ? null : current))
    }
  }, [scrollTargetId, feed.messages, feed.isError, setScrollTargetId])

  useEffect(() => {
    setReplyTo(null)
    setSearchQuery("")
    setContextTarget(null)
  }, [channelId, setContextTarget, setReplyTo, setSearchQuery])

  const term = searchQuery.trim()
  const searchResource = useQuery({
    queryKey: ["community", "message-search", channelId, term],
    enabled: term.length > 0, subscribed: term.length > 0, gcTime: 5 * 60 * 1000, retry: false,
    queryFn: async ({ signal }) => {
      const token = captureCommunityLiveSnapshotToken(profileQueryClient)
      const params = new URLSearchParams({ q: term, channelId })
      const data = await apiFetchProfiles<{
        results: Array<{
          message: { id: string; content: string; authorId: string; createdAt: string; seq?: number }
          author: { id: string; name: string; image: string | null; avatarVersion: number }
        }>
      }>(
        "/api/community/messages/search?" + params,
        (response) => response.results.map((result) => ({
          id: result.author.id, identityAbout: { name: result.author.name },
          avatar: { avatar: result.author.image ?? avatarInitial(result.author.name), avatarVersion: result.author.avatarVersion },
        })),
        communityRequestOptions(profileQueryClient, token, signal), token.registry,
      )
      publishCommunityMessages(profileQueryClient, {
        channelId,
        messages: data.results.map((result) => ({
          id: result.message.id, type: "chat", content: result.message.content,
          createdAt: result.message.createdAt, authorId: result.author.id,
          ...(result.message.seq !== undefined ? { seq: result.message.seq } : {}),
        })),
        proof: { token, signal },
      })
      return data.results.map((result) => result.message.id)
    },
  })
  const searchIds = useMemo(() => term ? searchResource.data ?? [] : [], [term, searchResource.data])
  const searchMessages = useCanonicalMessagesById(searchIds)
  const searchProfiles = useCanonicalProfilesByUserId(searchIds.flatMap((id) => {
    const authorId = searchMessages?.get(id)?.authorId
    return authorId ? [authorId] : []
  }))
  const searchResults = useMemo(() => searchIds.flatMap((id) => {
    const message = searchMessages?.get(id)
    if (!message) return []
    const profile = message.authorId ? readCommunityProfile(searchProfiles.get(message.authorId), message.authorId) : null
    return [{ ...message, ...(profile ? { authorName: profile.name, authorAvatar: profile.avatar, authorAvatarVersion: profile.avatarVersion } : {}) }]
  }), [searchIds, searchMessages, searchProfiles])
  const { refetch: refetchSearch } = searchResource
  const search = useCallback(async (query: string) => {
    if (query.trim() === term && term) await refetchSearch({ cancelRefetch: false })
    else setSearchQuery(query)
  }, [term, refetchSearch, setSearchQuery])

  const openContextSeq = useCallback((seq: number) => {
    setContextTarget((current) => (
      current ? { ...current, seq } : { serverId, channelId, label: channelName, seq }
    ))
  }, [setContextTarget, serverId, channelId, channelName])

  const onSheetReply = useCallback((target: ReplyTarget) => {
    if (contextTarget && contextTarget.channelId !== channelId) {
      communityRuntime.ui.actions.setPendingReply({ channelId: contextTarget.channelId, target })
      setContextTarget(null)
      uiHandlers.navigate?.(contextTarget.serverId, contextTarget.channelId)
      return
    }
    setReplyTo(target)
    setContextTarget(null)
  }, [contextTarget, channelId, setReplyTo, setContextTarget, communityRuntime.ui.actions, uiHandlers])

  const pendingReply = useCommunityStore((state) => state.pendingReply)
  useEffect(() => {
    if (!pendingReply || pendingReply.channelId !== channelId) return
    setReplyTo(pendingReply.target)
    communityRuntime.ui.actions.setPendingReply(null)
  }, [pendingReply, channelId, setReplyTo, communityRuntime.ui.actions])

  const actionContext = useMemo(() => ({ scope: [communityRuntime, channelId], store: createStore<MessageActionContext>({
    messageIds: [],
    pinnedIds: new Set<string>(),
    channelName: "",
    uiHandlers: {},
    onOpenThread: () => undefined,
    onOpenPinned: () => undefined,
  }) }), [communityRuntime, channelId]).store
  useLayoutEffect(() => {
    actionContext.setState(() => ({
      messageIds: feed.messages.map((message) => message.id),
      pinnedIds,
      channelName,
      uiHandlers,
      onOpenThread,
      onOpenPinned,
    }))
  }, [actionContext, feed.messages, pinnedIds, channelName, uiHandlers, onOpenThread, onOpenPinned])
  const getMessage = useCallback((id: string): Msg | undefined => {
    const registry = getCommunityDbRegistry(profileQueryClient)
    const row = registry?.collections.messages.get(id)
    const scope = { kind: "channel" as const, id: channelId, serverId }
    const message = materializeMessageStream(row?.channelId === channelId ? [row as CanonicalMessage] : [], communityRuntime.messageStream.actions.overlayFor(scope)).find((item) => item.id === id)
    if (!message) return undefined
    const profile = message.authorId ? registry?.collections.profiles.get(message.authorId) : undefined
    return profile ? { ...message, authorName: profile.name, authorAvatar: profile.avatar, authorAvatarVersion: profile.avatarVersion } : message
  }, [profileQueryClient, communityRuntime, channelId, serverId])

  const jumpToSeq = useCallback((seq: number) => {
    source.capture()()
    const message = actionContext.get().messageIds.map(getMessage).find((item) => item?.seq === seq)
    if (message) setScrollTargetId(message.id)
    else setContextTarget({ serverId, channelId, label: channelName, seq })
  }, [source, actionContext, getMessage, setScrollTargetId, setContextTarget, serverId, channelId, channelName])

  const seqParam = searchParams.get("seq")
  const searchParamsString = searchParams.toString()
  useEffect(() => {
    if (!seqParam) return
    const seq = Number(seqParam)
    if (!Number.isFinite(seq)) return
    setContextTarget({ serverId, channelId, label: channelName, seq })
    const href = `${pathname}${searchParamsString ? `?${searchParamsString}` : ""}`
    router.replace(removeCommunityParam(href, "seq"), { scroll: false })
  }, [seqParam, serverId, channelId, channelName, pathname, router, searchParamsString, setContextTarget])

  const messageScope = useMemo(
    () => ({ kind: "channel" as const, id: channelId, serverId }),
    [channelId, serverId],
  )

  const runAcceptedIntent = useCallback(async (nonce: string) => {
    const assertActive = source.capture()
    await runAcceptedMessageIntent({
    runtime: communityRuntime,
      assertActive,
      messageScope,
      nonce,
      uploadFileAsync,
      sendMessageAsync,
      channelId,
      forumParentChannelId,
      serverId,
      viewer: { id: viewer.id, name: viewer.name, avatar: viewer.avatar },
    })
  }, [source, communityRuntime, messageScope, uploadFileAsync, sendMessageAsync, channelId, forumParentChannelId, serverId, viewer.id, viewer.name, viewer.avatar])

  const messageActions = useMemo(() => createMessageActions({
    runtime: communityRuntime,
    actionContext,
    getMessage,
    captureView: source.capture,
    serverId,
    channelId,
    viewerUserId: viewer.id,
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
  }), [communityRuntime, actionContext, getMessage, source.capture, serverId, channelId, viewer.id, setReplyTo, toggleReactionApi, addReactionApi, unpinMessageMutate, pinMessageMutate, toggleMark, createThreadAsync, editMessage, messageScope, runAcceptedIntent])

  const acceptMessage = useCallback((
    markdown: string,
    attachments?: SendAttachment[],
    mentionType?: MentionType,
  ): boolean => acceptChannelMessage({
    runtime: communityRuntime,
    markdown,
    attachments,
    mentionType,
    messageScope,
    viewer: { id: viewer.id, name: viewer.name, avatar: viewer.avatar },
    replyTo,
    runAcceptedIntent,
    channelId,
    clearReply: () => setReplyTo(null),
  }), [channelId, communityRuntime, messageScope, replyTo, runAcceptedIntent, setReplyTo, viewer.avatar, viewer.id, viewer.name])

  return useMemo<MessageChannelControllerValue>(() => ({
    feed,
    pinnedIds,
    replyTo,
    setReplyTo,
    searchQuery,
    searchResults,
    searchError: searchResource.isError ? "Search failed. Try again." : undefined,
    searchLoading: searchResource.isFetching,
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
    handleTyping: () => communityWsSendTyping(communityRuntime, { channelId }),
    typingUsers: typingUserIds.map((id) => typingNames[id] ?? resolveUserName(id)),
  }), [feed, pinnedIds, replyTo, setReplyTo, searchQuery, searchResults, searchResource.isError, searchResource.isFetching, search, scrollTargetId, setScrollTargetId, consumeScrollTarget, contextTarget, setContextTarget, openContextSeq, onSheetReply, jumpToSeq, messageActions, acceptMessage, typingUserIds, communityRuntime, channelId, typingNames, resolveUserName])
}
