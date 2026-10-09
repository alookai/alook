"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useEffect, useMemo, useRef } from "react"
import type { RenderMsg } from "@/lib/community/models/message"
import { flattenMessageItems } from "@/lib/community/message-list-items"
import {
  resolveMessageRailTailPaddingEnd,
  useScrollAnchor,
} from "@/hooks/community/use-scroll-anchor"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useVirtualCursorPagination } from "@/hooks/community/use-virtual-cursor-pagination"
import { useInitialPositionTransition } from "./initial-position-transition"
import type { ResolvedMessageListProps } from "./message-list-types"

export function useMessageListController({
  messages,
  loading,
  initialLoadError,
  newDividerBefore,
  scrollToMessageId,
  initialScrollReady,
  hasMore,
  hasMoreNewer,
  isFetching,
  isFetchingOlder,
  isFetchingNewer,
  onLoadOlder,
  onLoadNewer,
  onJumpToPresent,
  presentVersion,
  unreadCount,
  viewerUserId,
  onScrollRoot,
  onScrollTargetConsumed,
}: ResolvedMessageListProps) {
  const breakpoint = useBreakpoint()
  const tailPaddingEnd = resolveMessageRailTailPaddingEnd(breakpoint)
  const [jumpRevision, setJumpRevision] = useAtom(useCreateAtom(0))
  const [jumped, setJumped] = useAtom(useCreateAtom<string | null>(null))
  const [anchorPositionSettled, setAnchorPositionSettled] = useAtom(useCreateAtom(false))

  const items = useMemo(
    () => flattenMessageItems(messages, newDividerBefore, !!hasMore, !!hasMoreNewer),
    [messages, newDividerBefore, hasMore, hasMoreNewer],
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
  const settleAnchorPosition = useCallback(() => setAnchorPositionSettled(true), [setAnchorPositionSettled])
  const {
    scrollRef,
    virtualizer,
    belowCount,
    scrollToBottom,
    requestPresentPosition,
    jumpTo: jumpToIndex,
    readPositionReady,
    paginationEnabled,
    captureOlderPageAnchor,
    isOlderPageAnchorSettling,
    captureNewerPageAnchor,
    isNewerPageAnchorSettling,
  } = useScrollAnchor({
    items,
    newDividerBefore,
    initialScrollReady,
    scrollToMessageId,
    onScrollTargetCancelled: onScrollTargetConsumed,
    onScrollTargetPositioned: (id) => { setJumped(id); setJumpRevision((value) => value + 1); onScrollTargetConsumed?.(id) },
    hasMoreNewer,
    isFetchingOlder,
    isFetchingNewer,
    presentVersion,
    viewerUserId,
    hasMoreOlder: hasMore,
    tailPaddingEnd,
    onInitialPositionSettled: settleAnchorPosition,
  })
  const initialPosition = useInitialPositionTransition({
    firstWindowReady: !isLoading && (messages.length > 0 || !initialLoadError),
    authoritativeEmpty,
    positionSettled: anchorPositionSettled,
  })

  useEffect(() => {
    if (!onScrollRoot) return
    onScrollRoot(scrollRef.current)
    return () => onScrollRoot(null)
  }, [onScrollRoot, scrollRef])

  useVirtualCursorPagination({
    virtualizer,
    count: items.length,
    enabled: paginationEnabled,
    hasMore,
    isFetching: isFetching || isFetchingOlder || isFetchingNewer,
    isSettling: isOlderPageAnchorSettling || isNewerPageAnchorSettling,
    isError: !!initialLoadError,
    onBeforeLoad: captureOlderPageAnchor,
    onLoad: onLoadOlder,
    edge: "start",
  })
  useVirtualCursorPagination({
    virtualizer,
    count: items.length,
    enabled: paginationEnabled,
    hasMore: hasMoreNewer,
    hasMoreAtStart: hasMore,
    isFetching: isFetching || isFetchingOlder || isFetchingNewer,
    isSettling: isOlderPageAnchorSettling || isNewerPageAnchorSettling,
    isError: !!initialLoadError,
    onBeforeLoad: captureNewerPageAnchor,
    onLoad: onLoadNewer,
    edge: "end",
  })

  const jumpClearTimerRef = useRef<number | null>(null)
  const jumpVisibilityFrameRef = useRef<number | null>(null)
  const jumpTo = useCallback((id: string, behavior: ScrollBehavior = "smooth") => {
    setJumped(id)
    setJumpRevision((value) => value + 1)
    jumpToIndex(id, behavior)
  }, [jumpToIndex, setJumped, setJumpRevision])
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
  const pillCount = jumpMode ? ((unreadCount ?? belowCount) || 0) : belowCount
  const jumpToPresent = useCallback(() => {
    requestPresentPosition()
    onJumpToPresent?.()
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
    readPositionReady,
    jumpTo,
    pillCount,
    pillMode: jumpMode ? "jump" as const : "scroll" as const,
    pillOnClick,
  }
}

export type MessageListController = ReturnType<typeof useMessageListController>
