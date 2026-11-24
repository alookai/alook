"use client"

import { createStore, useAtom, useCreateAtom, useSelector } from "@tanstack/react-store";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { RenderMsg } from "@/lib/community/models/message"
import { flattenMessageItems, stabilizeFirstRowGrouping, type FirstMessageGrouping } from "@/lib/community/message-list-items"
import { useConversationScroll } from "@/hooks/community/use-conversation-scroll"
import { useVirtualCursorPagination } from "@/hooks/community/use-virtual-cursor-pagination"
import { useInitialPositionTransition } from "./initial-position-transition"
import type { ResolvedMessageListProps } from "./message-list-types"
import { hashKey } from "@tanstack/react-query"
import { messageRailTailPaddingEnd } from "@/lib/community/conversation-layout"
import { messageScrollBehavior } from "@/lib/community/message-scroll-behavior"
import { READ_VISIBILITY_THRESHOLD } from "@/hooks/community/use-read-observer"
import { useConversationFooterSlot } from "./conversation-footer-shell"

export function useMessageListController({
  channelId,
  messages,
  viewerUserId,
  onOpenContextId,
  loading,
  initialLoadError,
  newDividerBefore,
  newBoundary,
  latestSeq,
  retiredNewTargetId,
  onLoadNewTarget,
  onReadNewBoundary,
  scrollToMessageId,
  initialPositionMessageId,
  positionEntry,
  positionScope,
  positionDataState,
  targetPositionDataState,
  messageWindow,
  messageNeighborhood,
  onReadingMessage,
  active,
  positioningActive,
  initialScrollReady,
  preserveInitialPresentation,
  hasMore,
  historyStartKnown,
  olderLoadError,
  newerLoadError,
  presentPending,
  presentError,
  hasMoreNewer,
  isFetching,
  isFetchingOlder,
  isFetchingNewer,
  onLoadOlder,
  onFillHistory,
  onLoadNewer,
  onJumpToPresent,
  presentVersion,
  presentRequest,
  localSubmitVersion,
  unreadCount,
  onScrollRoot,
  onScrollTargetConsumed,
  onUserTakeover,
}: ResolvedMessageListProps, capsuleHeight = 0) {
  const [jumpRevision, setJumpRevision] = useAtom(useCreateAtom(0))
  const [jumped, setJumped] = useAtom(useCreateAtom<string | null>(null))
  const resolvedChannelId = channelId ?? positionScope?.proof.channelId ?? null
  const scopeKey = hashKey([
    viewerUserId ?? positionScope?.proof.viewerId ?? null,
    resolvedChannelId,
    positionScope?.tag ?? null,
  ])
  const observedSeq = Math.max(latestSeq ?? 0, ...messages.map(message => message.seq ?? 0))
  const createLookback = () => ({ owner: {}, scopeKey, entry: positionEntry,
    initialized: newBoundary !== undefined || newDividerBefore !== undefined,
    target: newBoundary !== undefined ? newBoundary.target?.id ?? null : newDividerBefore ?? null,
    targetSeq: newBoundary !== undefined ? newBoundary.target?.seq : messages.find(message => message.id === newDividerBefore)?.seq,
    used: false, pending: false })
  const [lookbackState, setLookback] = useState(createLookback)
  let lookback = lookbackState
  if (lookback.scopeKey !== scopeKey || lookback.entry !== positionEntry) {
    lookback = createLookback()
  } else if (!lookback.initialized && newBoundary !== undefined) {
    lookback = {
      ...lookback,
      initialized: true,
      target: newBoundary.target?.id ?? null,
      targetSeq: newBoundary.target?.seq,
    }
  } else if (lookback.target && lookback.target === retiredNewTargetId) {
    lookback = { ...lookback, target: null, targetSeq: undefined, used: true, pending: false }
  }
  if (lookback !== lookbackState) setLookback(lookback)
  const [lookbackErrorStore] = useState(() => createStore<{ owner: object; error: Error | null; retryNonce: number }>({
    owner: lookback.owner,
    error: null,
    retryNonce: 0,
  }))
  const lookbackErrorState = useSelector(lookbackErrorStore, state => state)
  const lookbackError = lookbackErrorState.owner === lookback.owner ? lookbackErrorState.error : null
  const lookbackRetryNonce = lookbackErrorState.owner === lookback.owner ? lookbackErrorState.retryNonce : 0
  const lookbackSyncRef = useRef<{ owner: object; throughSeq: number; checking: boolean; checkedThrough: number } | null>(null)
  const dividerTarget = lookback.initialized ? lookback.target ?? undefined
    : newBoundary !== undefined ? newBoundary.target?.id : newDividerBefore

  const rawItems = useMemo(
    () => flattenMessageItems(messages, dividerTarget, !!hasMore, !!hasMoreNewer && (!!isFetchingNewer || !!newerLoadError),
      !!historyStartKnown || !!isFetchingOlder || !!olderLoadError, viewerUserId ?? positionScope?.proof.viewerId),
    [messages, dividerTarget, hasMore, hasMoreNewer, isFetchingNewer, newerLoadError, historyStartKnown, isFetchingOlder, olderLoadError, viewerUserId, positionScope?.proof.viewerId],
  )
  const [firstGroupingState, setFirstGroupingState] = useState<{
    scopeKey: string
    entry: typeof positionEntry
    first: FirstMessageGrouping | null
  }>(() => ({ scopeKey, entry: positionEntry, first: null }))
  const previousFirst =
    firstGroupingState.scopeKey === scopeKey && firstGroupingState.entry === positionEntry
      ? firstGroupingState.first
      : null
  const stabilized = useMemo(
    () => stabilizeFirstRowGrouping(rawItems, previousFirst, dividerTarget),
    [rawItems, previousFirst, dividerTarget],
  )
  const items = stabilized.items
  if (
    firstGroupingState.scopeKey !== scopeKey
    || firstGroupingState.entry !== positionEntry
    || firstGroupingState.first?.key !== stabilized.firstMessageGrouping?.key
    || firstGroupingState.first?.grouped !== stabilized.firstMessageGrouping?.grouped
  ) {
    setFirstGroupingState({
      scopeKey,
      entry: positionEntry,
      first: stabilized.firstMessageGrouping,
    })
  }

  const footerSlot = useConversationFooterSlot()
  const localSelection = useCreateAtom(false)
  const [selectMode, setSelectMode] = useAtom(footerSlot?.selection ?? localSelection)
  useLayoutEffect(() => () => setSelectMode(false), [setSelectMode])
  const [selectedIds, setSelectedIds] = useAtom(useCreateAtom<Set<string>>(useMemo<Set<string>>(() => new Set<string>(), [])))
  const [shareOpen, setShareOpen] = useAtom(useCreateAtom(false))
  const onEnterSelectId = useCallback((id: string) => {
    setSelectMode(true)
    setSelectedIds(new Set([id]))
  }, [setSelectMode, setSelectedIds])
  const onToggleSelectId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [setSelectedIds])
  const exitSelect = useCallback(() => {
    setSelectMode(false)
    setSelectedIds(new Set<string>())
  }, [setSelectMode, setSelectedIds])
  const selectedMessages = useMemo<RenderMsg[]>(() => {
    if (selectedIds.size === 0) return []
    const picked = items.flatMap((item) => (
      item.kind === "message" && selectedIds.has(item.m.id) ? [item.m] : []
    ))
    let prev: RenderMsg | null = null
    return picked.map((message) => {
      const grouped = !!(
        prev
        && !message.replyTo
        && (prev.authorId && message.authorId
          ? prev.authorId === message.authorId
          : prev.authorName === message.authorName)
        && prev.createdAt
        && message.createdAt
        && new Date(message.createdAt).getTime() - new Date(prev.createdAt).getTime() < 7 * 60 * 1000
      )
      prev = message
      return { ...message, grouped }
    })
  }, [items, selectedIds])

  const isLoading = (!!loading || !!initialLoadError) && messages.length === 0
  const authoritativeEmpty = !loading && !initialLoadError && messages.length === 0
  const tailPaddingEnd = messageRailTailPaddingEnd(items.at(-1), capsuleHeight)
  const {
    scrollRef,
    paginationScroller,
    belowCount,
    scrollToBottom,
    requestPresentPosition,
    jumpTo: jumpToIndex,
    readPositionReady,
    paginationEnabled,
    underfillEnabled,
    paginationRequestPending,
    captureOlderPageAnchor,
    captureNewerPageAnchor,
    positionOutcome,
    requestNewPosition,
    newDividerVisibility,
    readingTail,
    jumpToPresentVisible,
  } = useConversationScroll({
    items,
    messageRows: messages,
    newDividerBefore: dividerTarget,
    newDividerSeq: lookback.initialized ? lookback.targetSeq : newBoundary?.target?.seq,
    initialScrollReady,
    ...(preserveInitialPresentation ? { preserveInitialPresentation } : {}),
    ...(onUserTakeover ? { onUserTakeover } : {}),
    scrollToMessageId,
    initialPositionMessageId,
    positionEntry,
    positionScope,
    positionDataState: positionDataState ?? (initialLoadError ? "error" : loading ? "pending" : undefined),
    targetPositionDataState,
    messageWindow,
    onReadingMessage,
    active,
    positioningActive,
    onScrollTargetCancelled: onScrollTargetConsumed,
    onScrollTargetPositioned: (id) => { setJumped(id); setJumpRevision((value) => value + 1); onScrollTargetConsumed?.(id) },
    hasMoreNewer,
    isFetchingOlder,
    isFetchingNewer,
    presentVersion,
    presentRequest,
    presentPending,
    onJumpToPresent,
    localSubmitVersion,
    hasMoreOlder: hasMore,
    tailPaddingEnd,
    viewportInsetEnd: capsuleHeight,
    newBoundaryOwner: lookback.owner,
    onNewBoundaryReached: consumeReachedNew,
  })
  const initialPosition = useInitialPositionTransition({
    firstWindowReady: !isLoading && (messages.length > 0 || !initialLoadError),
    authoritativeEmpty,
    positionSettled: positionOutcome !== "pending",
  })
  function consumeReachedNew(boundary: { id: string; entry: object | null | undefined; owner: object | undefined }): void {
    if (lookback.used || active === false || !readPositionReady || typeof document === "undefined" || document.visibilityState !== "visible"
      || boundary.owner !== lookback.owner || boundary.entry !== positionEntry) return
    lookbackErrorStore.setState(current => current.owner === lookback.owner && current.error ? { ...current, error: null } : current)
    setLookback(current => current.owner === lookback.owner && current.target === boundary.id && !current.used
      ? { ...current, used: true } : current)
  }
  const readVisiblePeerSeq = useCallback(() => {
    const root = scrollRef.current
    if (!root || active === false || !readPositionReady) return 0
    const viewport = root.getBoundingClientRect()
    const peers = new Map(messages.filter(message => message.authorId && message.authorId !== viewerUserId)
      .map(message => [message.id, message.seq ?? 0]))
    let through = 0
    for (const body of root.querySelectorAll<HTMLElement>("[data-msg-id]")) {
      const seq = peers.get(body.dataset.msgId ?? "")
      if (!seq || seq <= through) continue
      const rect = body.getBoundingClientRect()
      const visibleArea = Math.max(0, Math.min(rect.bottom, viewport.bottom - capsuleHeight) - Math.max(rect.top, viewport.top))
        * Math.max(0, Math.min(rect.right, viewport.right) - Math.max(rect.left, viewport.left))
      if (rect.width > 0 && rect.height > 0 && visibleArea / (rect.width * rect.height) >= READ_VISIBILITY_THRESHOLD) through = seq
    }
    return through
  }, [active, messages, capsuleHeight, readPositionReady, scrollRef, viewerUserId])
  const lookbackView = useRef<{ owner: object; throughSeq: number; readingTail: boolean; readable: boolean; dividerVisibility: typeof newDividerVisibility; visiblePeerSeq: () => number } | null>(null)
  useLayoutEffect(() => {
    lookbackView.current = { owner: lookback.owner, throughSeq: observedSeq, readingTail,
      readable: active !== false && readPositionReady, dividerVisibility: newDividerVisibility, visiblePeerSeq: readVisiblePeerSeq }
    return () => { if (lookbackView.current?.owner === lookback.owner) lookbackView.current = null }
  }, [active, readingTail, lookback.owner, observedSeq, readPositionReady, newDividerVisibility, readVisiblePeerSeq])
  useEffect(() => {
    let sync = lookbackSyncRef.current
    if (!sync || sync.owner !== lookback.owner) {
      sync = { owner: lookback.owner, throughSeq: observedSeq, checking: false, checkedThrough: -1 }
      lookbackSyncRef.current = sync
    }
    if (lookback.target && !lookback.used && observedSeq > sync.throughSeq) {
      sync.throughSeq = observedSeq
    }
    if (!lookback.initialized || lookback.target && !lookback.used || observedSeq <= sync.throughSeq) return
    if (active === false || !readPositionReady || lookback.pending || sync.checking) return
    const visibleThrough = readingTail ? observedSeq : readVisiblePeerSeq()
    if (visibleThrough > sync.throughSeq) {
      sync.throughSeq = visibleThrough
      lookbackErrorStore.setState(current => current.owner === lookback.owner && current.error ? { ...current, error: null } : current)
      return
    }
    if (lookback.target && lookback.used && newDividerVisibility !== "above" && newDividerVisibility !== "below") return
    if (sync.checkedThrough >= observedSeq || !onReadNewBoundary
      || !messages.some(message => message.authorId && message.authorId !== viewerUserId && (message.seq ?? 0) > sync.throughSeq)) return
    const owner = lookback.owner
    const checkFromSeq = sync.throughSeq
    sync.checking = true
    sync.checkedThrough = observedSeq
    lookbackErrorStore.setState(current => current.owner === owner && current.error ? { ...current, error: null } : current)
    void onReadNewBoundary(checkFromSeq).then(result => {
      const view = lookbackView.current
      const currentSync = lookbackSyncRef.current
      if (!view || view.owner !== owner || !currentSync || currentSync.owner !== owner) return
      currentSync.checking = false
      const visibleAfter = view.visiblePeerSeq()
      if (!result) {
        lookbackErrorStore.setState(current => ({ owner, error: new Error("Could not load New"), retryNonce: current.owner === owner ? current.retryNonce : 0 }))
        return
      }
      if (view.readable && view.readingTail) {
        currentSync.throughSeq = Math.max(currentSync.throughSeq, result.latestSeq, view.throughSeq)
        return
      }
      if (!result.boundary.target) {
        currentSync.throughSeq = Math.max(currentSync.throughSeq, result.latestSeq)
        return
      }
      if (result.boundary.target.seq <= visibleAfter) {
        currentSync.throughSeq = Math.max(currentSync.throughSeq, visibleAfter)
        currentSync.checkedThrough = -1
        lookbackErrorStore.setState(current => ({
          owner,
          error: null,
          retryNonce: (current.owner === owner ? current.retryNonce : 0) + 1,
        }))
        return
      }
      let retryNeeded = false
      setLookback(current => {
        if (current.owner !== owner) return current
        if (current.target && current.used && view.dividerVisibility !== "above" && view.dividerVisibility !== "below") {
          currentSync.checkedThrough = -1
          retryNeeded = true
          return current
        }
        currentSync.throughSeq = Math.max(currentSync.throughSeq, result.latestSeq)
        return { ...current, target: result.boundary.target!.id, targetSeq: result.boundary.target!.seq, used: false }
      })
      if (retryNeeded) {
        lookbackErrorStore.setState(current => ({
          owner,
          error: null,
          retryNonce: (current.owner === owner ? current.retryNonce : 0) + 1,
        }))
      }
    }, error => {
      const currentSync = lookbackSyncRef.current
      if (currentSync && currentSync.owner === owner) currentSync.checking = false
      if (lookbackView.current?.owner === owner) {
        lookbackErrorStore.setState(current => ({
          owner,
          error: error instanceof Error ? error : new Error("Could not load New"),
          retryNonce: current.owner === owner ? current.retryNonce : 0,
        }))
      }
    })
  }, [active, readingTail, lookback, lookbackErrorStore, lookbackRetryNonce, messages, newDividerVisibility, observedSeq, onReadNewBoundary, readPositionReady, readVisiblePeerSeq, viewerUserId])
  const jumpToNew = useCallback(() => {
    const id = lookback.target, owner = lookback.owner
    if (!id || lookback.used || lookback.pending || lookbackView.current?.owner !== owner) return
    const request = requestNewPosition(id, onLoadNewTarget ? () => onLoadNewTarget(id) : undefined)
    if (!request.accepted) return
    lookbackErrorStore.setState(current => current.owner === owner && current.error ? { ...current, error: null } : current)
    setLookback(current => current.owner === owner ? { ...current, pending: true } : current)
    void request.completed.then(result => {
      if (lookbackView.current?.owner !== owner) return
      if (result === "error") {
        lookbackErrorStore.setState(current => ({ owner, error: new Error("Could not jump to New"), retryNonce: current.owner === owner ? current.retryNonce : 0 }))
      } else {
        lookbackErrorStore.setState(current => current.owner === owner && current.error ? { ...current, error: null } : current)
      }
      setLookback(current => current.owner !== owner || current.target !== id ? current : { ...current, pending: false,
        used: result === "success" || result === "missing" || current.used,
        target: result === "missing" ? null : current.target,
        targetSeq: result === "missing" ? undefined : current.targetSeq })
    })
  }, [lookback, lookbackErrorStore, onLoadNewTarget, requestNewPosition])
  const retryNew = useCallback(() => {
    if (lookback.target && !lookback.used) jumpToNew()
    else {
      if (lookbackSyncRef.current?.owner === lookback.owner) lookbackSyncRef.current.checkedThrough = -1
      lookbackErrorStore.setState(current => ({
        owner: lookback.owner,
        error: null,
        retryNonce: (current.owner === lookback.owner ? current.retryNonce : 0) + 1,
      }))
    }
  }, [jumpToNew, lookback.owner, lookback.target, lookback.used, lookbackErrorStore])

  useEffect(() => {
    if (!onScrollRoot) return
    onScrollRoot(scrollRef.current)
    return () => onScrollRoot(null)
  }, [onScrollRoot, scrollRef])

  const retryOlder = useVirtualCursorPagination({
    virtualizer: paginationScroller,
    count: items.length,
    enabled: paginationEnabled && !paginationRequestPending && !initialLoadError && !!messageNeighborhood,
    hasMore: messageNeighborhood?.older,
    isFetching: isFetching || isFetchingOlder || isFetchingNewer,
    isError: !!olderLoadError,
    onBeforeLoad: captureOlderPageAnchor,
    onLoad: onLoadOlder,
    edge: "start",
    requestKey: messageNeighborhood?.page,
    fillViewport: underfillEnabled && !paginationRequestPending && !initialLoadError && messageWindow && onFillHistory
      ? { window: messageWindow, load: onFillHistory } : undefined,
    loadWhenReady: true,
  })
  const retryNewer = useVirtualCursorPagination({
    virtualizer: paginationScroller,
    count: items.length,
    enabled: paginationEnabled && !paginationRequestPending && !initialLoadError && !!messageNeighborhood,
    hasMore: messageNeighborhood?.newer,
    hasMoreAtStart: hasMore,
    isFetching: isFetching || isFetchingOlder || isFetchingNewer,
    isError: !!newerLoadError,
    onBeforeLoad: captureNewerPageAnchor,
    onLoad: onLoadNewer,
    edge: "end",
    requestKey: messageNeighborhood?.page,
    loadWhenReady: true,
  })

  const jumpClearTimerRef = useRef<number | null>(null)
  const jumpVisibilityFrameRef = useRef<number | null>(null)
  const jumpTo = useCallback((id: string, behavior: ScrollBehavior = messageScrollBehavior()) => {
    if (!messages.some(message => message.id === id)) { onOpenContextId?.(id); return }
    setJumped(id)
    setJumpRevision((value) => value + 1)
    jumpToIndex(id, behavior)
  }, [messages, onOpenContextId, jumpToIndex, setJumped, setJumpRevision])
  useEffect(() => {
    if (!jumped) return
    const id = jumped
    let active = true
    if (jumpClearTimerRef.current !== null) clearTimeout(jumpClearTimerRef.current)
    if (jumpVisibilityFrameRef.current !== null) window.cancelAnimationFrame(jumpVisibilityFrameRef.current)
    let attempts = 0
    const armClear = () => {
      if (!active) return
      jumpVisibilityFrameRef.current = null
      const timeout = window.setTimeout(() => {
        if (!active) return
        setJumped((value) => (value === id ? null : value))
        if (jumpClearTimerRef.current === timeout) jumpClearTimerRef.current = null
      }, 1600)
      jumpClearTimerRef.current = timeout
    }
    const waitUntilVisible = () => {
      if (!active) return
      const root = scrollRef.current
      const row = root
        ? Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
          .find((element) => element.dataset.msgId === id)
        : undefined
      if (root && row) {
        const rootRect = root.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        if (rowRect.bottom > rootRect.top && rowRect.top < rootRect.bottom) {
          armClear()
          return
        }
      }
      attempts += 1
      if (attempts >= 120) {
        armClear()
        return
      }
      jumpVisibilityFrameRef.current = window.requestAnimationFrame(waitUntilVisible)
    }
    jumpVisibilityFrameRef.current = window.requestAnimationFrame(waitUntilVisible)
    return () => {
      active = false
      if (jumpClearTimerRef.current !== null) clearTimeout(jumpClearTimerRef.current)
      if (jumpVisibilityFrameRef.current !== null) window.cancelAnimationFrame(jumpVisibilityFrameRef.current)
    }
  }, [jumped, jumpRevision, scrollRef, setJumped])

  const jumpMode = jumpToPresentVisible
  const pillCount = jumpMode ? unreadCount : belowCount
  const jumpToPresent = useCallback(() => {
    requestPresentPosition(onJumpToPresent?.())
  }, [onJumpToPresent, requestPresentPosition])
  const pillOnClick = (jumpMode || !!presentError) && onJumpToPresent ? jumpToPresent : scrollToBottom

  const closeShare = useCallback(() => {
    setShareOpen(false)
    exitSelect()
  }, [exitSelect, setShareOpen])

  return {
    items,
    isLoading,
    initialPosition,
    jumped,
    selectMode,
    selectedIds,
    selectedMessages,
    shareOpen,
    setShareOpen,
    exitSelect,
    closeShare,
    onEnterSelectId,
    onToggleSelectId,
    scrollRef,
    tailPaddingEnd,
    readPositionReady,
    paginationEnabled: paginationEnabled && !paginationRequestPending,
    jumpTo,
    pillCount,
    pillMode: jumpMode ? "jump" as const : "scroll" as const,
    pillOnClick,
    pillError: !!presentError,
    retryOlder, retryNewer,
    newJumpVisible: lookback.pending || !!dividerTarget && !lookback.used && newDividerVisibility === "above"
      && (!!onLoadNewTarget || messages.some(message => message.id === dividerTarget)),
    newJumpPending: lookback.pending,
    jumpToNew,
    newLoadError: lookbackError,
    retryNew,
  }
}

export type MessageListController = ReturnType<typeof useMessageListController>
