"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react"
import type { Msg } from "@/lib/community/models/message"
import {
  materializeMessageStream,
  type CanonicalMessage,
  type MessageScope,
} from "@/lib/community/message-stream"
import { useMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import {
  useMessageWindowProjection,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"
import type { MessageCollectionDemand } from "@/lib/community-db/message-resource"

function messageMatchesTag(message: Msg, tag?: string | null): boolean {
  return !tag || message.thread?.tags?.includes(tag) === true
}

type MessagesReturn = {
  data: Msg[] | undefined
  error: Error | null
  fetchStatus: "fetching" | "idle" | "paused"
  isError: boolean
  isFetching: boolean
  isLoading: boolean
  isPending: boolean
  isSuccess: boolean
  refetch: () => Promise<void>
  status: "pending" | "error" | "success"
  messages: Msg[]
  latestSeq: number
  hasMoreOlder: boolean
  hasMoreNewer: boolean
  isFetchingOlder: boolean
  isFetchingNewer: boolean
  fetchOlder: () => void
  fetchNewer: () => void
  jumpToPresent: () => void
  presentVersion: number
  anchorReconciled: boolean
  hasMore: boolean
  navigationBlocked: boolean
}

type MessagesOpts = {
  viewerUserId?: string
  tag?: string | null
  lastReadMessageId?: string | null
  anchorMessageId?: string | null
  waitForAnchor?: boolean
  reconcileLateAnchor?: boolean
  revalidateOnMount?: boolean
}

type ChannelMessagesOpts = MessagesOpts & { serverId: string }

const MESSAGE_TAIL_LIMIT = 50
const MESSAGE_ANCHOR_SIDE_LIMIT = 26
const MESSAGE_PAGE_GROWTH = 50

export type MessageWindowState = {
  key: string
  newerLimit: number
  olderLimit: number
  presentRequested: boolean
  presentVersion: number
  tail: boolean
}

export function settleMessageWindowPresentRequest(
  current: MessageWindowState,
  identityKey: string,
): MessageWindowState {
  if (current.key !== identityKey || !current.presentRequested) return current
  return {
    ...current,
    presentRequested: false,
    presentVersion: current.presentVersion + 1,
  }
}

function initialMessageWindowState(key: string, anchored: boolean): MessageWindowState {
  return {
    key,
    newerLimit: anchored ? MESSAGE_ANCHOR_SIDE_LIMIT : 0,
    olderLimit: anchored ? MESSAGE_ANCHOR_SIDE_LIMIT : MESSAGE_TAIL_LIMIT,
    presentRequested: false,
    presentVersion: 0,
    tail: !anchored,
  }
}

function useCollectionMessageWindow(
  channelId: string | null,
  kind: "server-channel" | "dm",
  serverId: string | null,
  opts: MessagesOpts,
): MessagesReturn {
  const registry = useOptionalCommunityDbRegistry()
  useEffect(() => {
    if (!channelId || !registry) return
    return registry.activateMessageScope(channelId)
  }, [channelId, registry])
  const anchorResolved = opts.waitForAnchor === false
    || opts.anchorMessageId != null
    || opts.lastReadMessageId !== undefined
  const requestedAnchor = opts.anchorMessageId ?? opts.lastReadMessageId ?? null
  const identityKey = JSON.stringify([
    registry?.scopeId ?? opts.viewerUserId ?? "__none__",
    kind,
    serverId,
    channelId,
    opts.tag?.trim() || null,
    anchorResolved ? requestedAnchor : "pending",
  ])
  const [storedWindow, setStoredWindow] = useState<MessageWindowState>(() => (
    initialMessageWindowState(identityKey, requestedAnchor !== null)
  ))
  const window = storedWindow.key === identityKey
    ? storedWindow
    : initialMessageWindowState(identityKey, requestedAnchor !== null)
  useLayoutEffect(() => {
    if (storedWindow.key !== identityKey) {
      setStoredWindow(initialMessageWindowState(identityKey, requestedAnchor !== null))
    }
  }, [identityKey, requestedAnchor, storedWindow.key])
  const demand = useMemo<MessageCollectionDemand | undefined>(() => {
    if (!registry || !channelId || !anchorResolved) return undefined
    return {
      scope: {
        accountId: registry.scopeId,
        kind,
        serverId,
        channelId,
      },
      tag: opts.tag?.trim() || null,
      sequence: {
        base: window.tail || !requestedAnchor
          ? { mode: "tail" }
          : { mode: "anchor", anchor: requestedAnchor },
        direction: "older",
        order: ["seq", "asc", "id", "asc"],
      },
    }
  }, [anchorResolved, channelId, kind, opts.tag, registry, requestedAnchor, serverId, window.tail])
  const projection = useMessageWindowProjection({
    channelId,
    demand,
    newerLimit: window.newerLimit,
    olderLimit: window.olderLimit,
  })
  const scope = useMemo<MessageScope>(() => kind === "dm" ? {
    kind: "dm",
    id: channelId ?? "__none__",
  } : {
    kind: "channel",
    id: channelId ?? "__none__",
    serverId: serverId ?? "__none__",
  }, [channelId, kind, serverId])
  const overlay = useMessageOverlay(scope)
  const canonical = useMemo(
    () => (projection.messages ?? []).filter(
      (message): message is CanonicalMessage => (
        typeof message.seq === "number" && messageMatchesTag(message, opts.tag)
      ),
    ),
    [opts.tag, projection.messages],
  )
  useEffect(() => {
    if (!channelId) return
    useMessageStreamStore.getState().dispatch(scope, {
      type: "baseChanged",
      messages: canonical,
    })
  }, [canonical, channelId, scope])
  const messages = useMemo(
    () => materializeMessageStream(canonical, overlay),
    [canonical, overlay],
  )
  const fetchOlder = useCallback(() => {
    if (!projection.hasMoreOlder || projection.isFetchingOlder) return
    setStoredWindow((current) => {
      const active = current.key === identityKey
        ? current
        : initialMessageWindowState(identityKey, requestedAnchor !== null)
      return { ...active, olderLimit: active.olderLimit + MESSAGE_PAGE_GROWTH }
    })
  }, [identityKey, projection.hasMoreOlder, projection.isFetchingOlder, requestedAnchor])
  const fetchNewer = useCallback(() => {
    if (!projection.hasMoreNewer || projection.isFetchingNewer) return
    setStoredWindow((current) => {
      const active = current.key === identityKey
        ? current
        : initialMessageWindowState(identityKey, requestedAnchor !== null)
      return { ...active, newerLimit: active.newerLimit + MESSAGE_PAGE_GROWTH }
    })
  }, [identityKey, projection.hasMoreNewer, projection.isFetchingNewer, requestedAnchor])
  const jumpToPresent = useCallback(() => {
    if (!demand || window.tail) return
    setStoredWindow((current) => ({
      ...(current.key === identityKey
        ? current
        : initialMessageWindowState(identityKey, requestedAnchor !== null)),
      newerLimit: 0,
      olderLimit: MESSAGE_TAIL_LIMIT,
      presentRequested: true,
      tail: true,
    }))
  }, [demand, identityKey, requestedAnchor, window.tail])
  useEffect(() => {
    if (!window.presentRequested || projection.isPending || projection.isError) return
    setStoredWindow((current) => settleMessageWindowPresentRequest(current, identityKey))
  }, [identityKey, projection.isError, projection.isPending, window.presentRequested])
  const isPending = !anchorResolved || projection.isPending
  const anchorReconciled = !requestedAnchor
    || messages.some((message) => message.id === requestedAnchor)
    || (!projection.isPending && !projection.isError)
  return {
    anchorReconciled,
    data: projection.messages,
    error: projection.isError ? new Error("message acquisition failed") : null,
    fetchNewer,
    fetchOlder,
    fetchStatus: projection.isFetchingNewer || projection.isFetchingOlder
      ? "fetching"
      : "idle",
    hasMore: projection.hasMoreOlder,
    hasMoreNewer: projection.hasMoreNewer,
    hasMoreOlder: projection.hasMoreOlder,
    isError: projection.isError,
    isFetching: projection.isFetchingNewer || projection.isFetchingOlder,
    isFetchingNewer: projection.isFetchingNewer || window.presentRequested,
    isFetchingOlder: projection.isFetchingOlder,
    isLoading: isPending && messages.length === 0,
    isPending,
    isSuccess: !isPending && !projection.isError,
    jumpToPresent,
    latestSeq: projection.latestSeq,
    messages,
    navigationBlocked: false,
    presentVersion: window.presentVersion,
    refetch: projection.refetch,
    status: projection.isError ? "error" : isPending ? "pending" : "success",
  }
}

export function useMessages(
  channelId: string | null,
  opts: ChannelMessagesOpts,
): MessagesReturn {
  return useCollectionMessageWindow(
    channelId,
    "server-channel",
    opts.serverId,
    opts,
  )
}

/** DM-scoped sibling of `useMessages`. */
export function useDmMessages(
  dmId: string | null,
  opts?: MessagesOpts,
): MessagesReturn {
  return useCollectionMessageWindow(dmId, "dm", null, opts ?? {})
}
