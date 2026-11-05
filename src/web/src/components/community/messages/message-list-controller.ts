"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { RenderMsg } from "@/lib/community/models/message"
import { flattenMessageItems } from "@/lib/community/message-list-items"
import { useScrollAnchor } from "@/hooks/community/use-scroll-anchor"
import { useVirtualCursorPagination } from "@/hooks/community/use-virtual-cursor-pagination"
import { useInitialPositionTransition } from "./initial-position-transition"
import type { ResolvedMessageListProps } from "./message-list-types"
import { conversationListScopeKey } from "@/lib/community/conversation-qualification"
import { hashKey } from "@tanstack/react-query"
import { MESSAGE_RAIL_TAIL_PADDING_END_PX } from "@/lib/community/conversation-layout"
import { READ_VISIBILITY_THRESHOLD } from "@/hooks/community/use-read-observer"

export function useMessageListController({
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
  active,
  positioningActive,
  initialScrollReady,
  preserveInitialPresentation,
  hasMore,
  hasMoreNewer,
  isFetching,
  isFetchingOlder,
  isFetchingNewer,
  onLoadOlder,
  onLoadNewer,
  onJumpToPresent,
  presentVersion,
  presentRequest,
  localSubmitVersion,
  unreadCount,
  onScrollRoot,
  onScrollTargetConsumed,
  onUserTakeover,
}: ResolvedMessageListProps, overlayHeight = 0) {
  const [jumpRevision, setJumpRevision] = useAtom(useCreateAtom(0))
  const [jumped, setJumped] = useAtom(useCreateAtom<string | null>(null))
  const scopeKey = positionScope ? hashKey(conversationListScopeKey(positionScope)) : null
  const observedSeq = Math.max(latestSeq ?? 0, ...messages.map(message => message.seq ?? 0))
  const createLookback = () => ({ owner: {}, scopeKey, entry: positionEntry,
    initialized: newBoundary !== undefined || newDividerBefore !== undefined,
    target: newBoundary !== undefined ? newBoundary.target?.id ?? null : newDividerBefore ?? null,
    targetSeq: newBoundary !== undefined ? newBoundary.target?.seq : messages.find(message => message.id === newDividerBefore)?.seq,
    used: false, pending: false, checking: false, throughSeq: observedSeq, checkedThrough: -1, error: null as Error | null })
  const [lookback, setLookback] = useState(createLookback)
  if (lookback.scopeKey !== scopeKey || lookback.entry !== positionEntry) setLookback(createLookback())
  const dividerTarget = lookback.initialized ? lookback.target ?? undefined
    : newBoundary !== undefined ? newBoundary.target?.id : newDividerBefore

  const items = useMemo(
    () => flattenMessageItems(messages, dividerTarget, !!hasMore, !!hasMoreNewer),
    [messages, dividerTarget, hasMore, hasMoreNewer],
  )

  const [selectMode, setSelectMode] = useAtom(useCreateAtom(false))
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
  const {
    scrollRef,
    virtualizer,
    onRowsLayoutCommit,
    belowCount,
    scrollToBottom,
    requestPresentPosition,
    jumpTo: jumpToIndex,
    readPositionReady,
    paginationEnabled,
    paginationRequestPending,
    captureOlderPageAnchor,
    captureNewerPageAnchor,
    positionOutcome,
    requestNewPosition,
    newDividerVisibility,
    followingTail,
  } = useScrollAnchor({
    items,
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
    active,
    positioningActive,
    onScrollTargetCancelled: onScrollTargetConsumed,
    onScrollTargetPositioned: (id) => { setJumped(id); setJumpRevision((value) => value + 1); onScrollTargetConsumed?.(id) },
    hasMoreNewer,
    isFetchingOlder,
    isFetchingNewer,
    presentVersion,
    presentRequest,
    localSubmitVersion,
    hasMoreOlder: hasMore,
    tailPaddingEnd: MESSAGE_RAIL_TAIL_PADDING_END_PX + overlayHeight,
    viewportInsetEnd: overlayHeight,
  })
  const initialPosition = useInitialPositionTransition({
    firstWindowReady: !isLoading && (messages.length > 0 || !initialLoadError),
    authoritativeEmpty,
    positionSettled: positionOutcome !== "pending",
  })
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
      const visibleArea = Math.max(0, Math.min(rect.bottom, viewport.bottom - overlayHeight) - Math.max(rect.top, viewport.top))
        * Math.max(0, Math.min(rect.right, viewport.right) - Math.max(rect.left, viewport.left))
      if (rect.width > 0 && rect.height > 0 && visibleArea / (rect.width * rect.height) >= READ_VISIBILITY_THRESHOLD) through = seq
    }
    return through
  }, [active, messages, overlayHeight, readPositionReady, scrollRef, viewerUserId])
  const lookbackView = useRef<{ owner: object; throughSeq: number; followingTail: boolean; readable: boolean; dividerVisibility: typeof newDividerVisibility; visiblePeerSeq: () => number } | null>(null)
  useLayoutEffect(() => {
    lookbackView.current = { owner: lookback.owner, throughSeq: observedSeq, followingTail,
      readable: active !== false && readPositionReady, dividerVisibility: newDividerVisibility, visiblePeerSeq: readVisiblePeerSeq }
    return () => { if (lookbackView.current?.owner === lookback.owner) lookbackView.current = null }
  }, [active, followingTail, lookback.owner, observedSeq, readPositionReady, newDividerVisibility, readVisiblePeerSeq])
  useLayoutEffect(() => {
    if (!lookback.initialized && newBoundary !== undefined) {
      setLookback(current => current.owner === lookback.owner ? { ...current, initialized: true, target: newBoundary.target?.id ?? null, targetSeq: newBoundary.target?.seq,
        throughSeq: observedSeq } : current)
    } else if (lookback.target && lookback.target === retiredNewTargetId) {
      setLookback(current => current.owner === lookback.owner ? { ...current, target: null, targetSeq: undefined, used: true, pending: false } : current)
    } else if (lookback.target && !lookback.used && observedSeq > lookback.throughSeq) {
      setLookback(current => current.owner === lookback.owner ? { ...current, throughSeq: observedSeq } : current)
    }
  }, [lookback, newBoundary, observedSeq, retiredNewTargetId])
  useEffect(() => {
    if (!lookback.initialized || lookback.target && !lookback.used || observedSeq <= lookback.throughSeq) return
    if (active === false || !readPositionReady || lookback.pending || lookback.checking) return
    const visibleThrough = followingTail ? observedSeq : readVisiblePeerSeq()
    if (visibleThrough > lookback.throughSeq) {
      setLookback(current => current.owner === lookback.owner ? { ...current, throughSeq: visibleThrough, error: null } : current)
      return
    }
    if (lookback.target && lookback.used && newDividerVisibility !== "above" && newDividerVisibility !== "below") return
    if (lookback.checkedThrough >= observedSeq || !onReadNewBoundary
      || !messages.some(message => message.authorId && message.authorId !== viewerUserId && (message.seq ?? 0) > lookback.throughSeq)) return
    const owner = lookback.owner
    setLookback(current => current.owner === owner ? { ...current, checking: true, checkedThrough: observedSeq, error: null } : current)
    void onReadNewBoundary(lookback.throughSeq).then(result => {
      const view = lookbackView.current
      if (!view || view.owner !== owner) return
      const visibleThrough = view.visiblePeerSeq()
      setLookback(current => {
        if (current.owner !== owner) return current
        if (!result) return { ...current, checking: false, error: new Error("Could not load New") }
        if (view.readable && view.followingTail) return { ...current, checking: false, throughSeq: Math.max(current.throughSeq, result.latestSeq, view.throughSeq) }
        if (!result.boundary.target) return { ...current, checking: false, throughSeq: Math.max(current.throughSeq, result.latestSeq) }
        if (result.boundary.target.seq <= visibleThrough) return { ...current, checking: false,
          throughSeq: Math.max(current.throughSeq, visibleThrough), checkedThrough: -1 }
        if (current.target && current.used && view.dividerVisibility !== "above" && view.dividerVisibility !== "below") return { ...current, checking: false, checkedThrough: -1 }
        return { ...current, checking: false, target: result.boundary.target.id, targetSeq: result.boundary.target.seq, used: false,
          throughSeq: Math.max(current.throughSeq, result.latestSeq) }
      })
    }, error => {
      if (lookbackView.current?.owner === owner) setLookback(current => current.owner === owner
        ? { ...current, checking: false, error: error instanceof Error ? error : new Error("Could not load New") } : current)
    })
  }, [active, followingTail, lookback, messages, newDividerVisibility, observedSeq, onReadNewBoundary, readPositionReady, readVisiblePeerSeq, viewerUserId])
  const jumpToNew = useCallback(() => {
    const id = lookback.target, owner = lookback.owner
    if (!id || lookback.used || lookback.pending || lookbackView.current?.owner !== owner) return
    const request = requestNewPosition(id, onLoadNewTarget ? () => onLoadNewTarget(id) : undefined)
    if (!request.accepted) return
    setLookback(current => current.owner === owner ? { ...current, pending: true, error: null } : current)
    void request.completed.then(result => {
      if (lookbackView.current?.owner !== owner) return
      setLookback(current => current.owner !== owner || current.target !== id ? current : { ...current, pending: false,
        used: result === "success" || result === "missing" || current.used,
        target: result === "missing" ? null : current.target,
        targetSeq: result === "missing" ? undefined : current.targetSeq,
        error: result === "error" ? new Error("Could not jump to New") : null })
    })
  }, [lookback, onLoadNewTarget, requestNewPosition])
  const retryNew = useCallback(() => {
    if (lookback.target && !lookback.used) jumpToNew()
    else setLookback(current => ({ ...current, checkedThrough: -1, error: null }))
  }, [jumpToNew, lookback.target, lookback.used])

  useEffect(() => {
    if (!onScrollRoot) return
    onScrollRoot(scrollRef.current)
    return () => onScrollRoot(null)
  }, [onScrollRoot, scrollRef])

  useVirtualCursorPagination({
    virtualizer,
    count: items.length,
    enabled: paginationEnabled && !paginationRequestPending,
    hasMore,
    isFetching: isFetching || isFetchingOlder || isFetchingNewer,
    isError: !!initialLoadError,
    onBeforeLoad: captureOlderPageAnchor,
    onLoad: onLoadOlder,
    edge: "start",
    requestKey: messageWindow,
    preloadWithinViewport: true,
  })
  useVirtualCursorPagination({
    virtualizer,
    count: items.length,
    enabled: paginationEnabled && !paginationRequestPending,
    hasMore: hasMoreNewer,
    hasMoreAtStart: hasMore,
    isFetching: isFetching || isFetchingOlder || isFetchingNewer,
    isError: !!initialLoadError,
    onBeforeLoad: captureNewerPageAnchor,
    onLoad: onLoadNewer,
    edge: "end",
    requestKey: messageWindow,
    preloadWithinViewport: true,
  })

  const jumpClearTimerRef = useRef<number | null>(null)
  const jumpVisibilityFrameRef = useRef<number | null>(null)
  const jumpTo = useCallback((id: string, behavior: ScrollBehavior = "smooth") => {
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

  const jumpMode = !!hasMoreNewer
  const pillCount = jumpMode ? unreadCount : belowCount
  const jumpToPresent = useCallback(() => {
    requestPresentPosition(onJumpToPresent?.())
  }, [onJumpToPresent, requestPresentPosition])
  const pillOnClick = jumpMode && onJumpToPresent ? jumpToPresent : scrollToBottom

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
    virtualizer,
    onRowsLayoutCommit,
    readPositionReady,
    paginationEnabled,
    jumpTo,
    pillCount,
    pillMode: jumpMode ? "jump" as const : "scroll" as const,
    pillOnClick,
    newJumpVisible: !!dividerTarget && !lookback.used && newDividerVisibility === "above"
      && (!!onLoadNewTarget || messages.some(message => message.id === dividerTarget)),
    newJumpPending: lookback.pending,
    jumpToNew,
    newLoadError: lookback.error,
    retryNew,
  }
}

export type MessageListController = ReturnType<typeof useMessageListController>
