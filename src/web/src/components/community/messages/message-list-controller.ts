"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { RenderMsg } from "@/lib/community/models/message"
import { flattenMessageItems } from "@/lib/community/message-list-items"
import { useScrollAnchor } from "@/hooks/community/use-scroll-anchor"
import { useVirtualCursorSentinel } from "@/hooks/community/use-virtual-cursor-sentinel"
import type { ResolvedMessageListProps } from "./message-list-types"

export function useMessageListController({
  messages,
  loading,
  newDividerBefore,
  scrollToMessageId,
  initialScrollReady,
  hasMore,
  hasMoreNewer,
  isFetchingOlder,
  isFetchingNewer,
  onLoadOlder,
  onLoadNewer,
  onJumpToPresent,
  presentVersion,
  unreadCount,
  viewerUserId,
  hero,
  onScrollRoot,
  onScrollTargetConsumed,
}: ResolvedMessageListProps) {
  const [jumped, setJumped] = useState<string | null>(null)

  const items = useMemo(
    () => flattenMessageItems(messages, newDividerBefore, !!hasMore),
    [messages, newDividerBefore, hasMore],
  )
  const scrollTargetLoaded = !!scrollToMessageId
    && messages.some((message) => message.id === scrollToMessageId)
  const scrollAnchorReady = scrollToMessageId ? scrollTargetLoaded : initialScrollReady

  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [shareOpen, setShareOpen] = useState(false)
  const onEnterSelectId = useCallback((id: string) => {
    setSelectMode(true)
    setSelectedIds(new Set([id]))
  }, [])
  const onToggleSelectId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const exitSelect = useCallback(() => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }, [])
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

  const heroRef = useRef<HTMLDivElement>(null)
  const [heroHeight, setHeroHeight] = useState(0)
  const [heroMeasured, setHeroMeasured] = useState(false)
  const isLoading = !!loading && messages.length === 0
  useEffect(() => {
    const element = heroRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight
      setHeroHeight(height)
      setHeroMeasured(true)
    })
    observer.observe(element)
    setHeroHeight(element.offsetHeight)
    setHeroMeasured(true)
    return () => observer.disconnect()
  }, [isLoading, hasMore, hero])

  const {
    scrollRef,
    virtualizer,
    belowCount,
    scrollToBottom,
    jumpTo: jumpToIndex,
    onImageLoad,
  } = useScrollAnchor({
    items,
    newDividerBefore,
    initialScrollReady: scrollAnchorReady,
    hasMoreNewer,
    presentVersion,
    viewerUserId,
    heroHeight,
    heroMeasured,
  })

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || !selectMode || selectedIds.size === 0) return

    let frame = 0
    let attempts = 0
    let stableFrames = 0
    const keepSelectionClearOfRail = () => {
      frame = window.requestAnimationFrame(() => {
        attempts += 1
        const rail = element.parentElement?.querySelector<HTMLElement>(
          '[data-selection="active"]',
        )
        const selectedRows = Array.from(
          element.querySelectorAll<HTMLElement>("[data-msg-id]"),
        ).filter((row) => selectedIds.has(row.dataset.msgId ?? ""))

        if (rail && selectedRows.length > 0) {
          const railTop = rail.getBoundingClientRect().top
          const lowestSelectedBottom = Math.max(...selectedRows.map(
            (row) => row.getBoundingClientRect().bottom,
          ))
          const overlap = lowestSelectedBottom - railTop
          if (overlap > 1) {
            element.scrollTop += overlap
            stableFrames = 0
          } else {
            stableFrames += 1
          }
        } else {
          stableFrames = 0
        }

        if (stableFrames < 2 && attempts < 120) keepSelectionClearOfRail()
      })
    }
    keepSelectionClearOfRail()
    return () => window.cancelAnimationFrame(frame)
  }, [selectMode, selectedIds, scrollRef])

  useEffect(() => {
    if (!onScrollRoot) return
    onScrollRoot(scrollRef.current)
    return () => onScrollRoot(null)
  }, [onScrollRoot, scrollRef])

  const topSentinelRef = useVirtualCursorSentinel({
    scrollRef,
    hasMore,
    isFetching: isFetchingOlder,
    onLoad: onLoadOlder,
    edge: "start",
  })
  const bottomSentinelRef = useVirtualCursorSentinel({
    scrollRef,
    hasMore: hasMoreNewer,
    isFetching: isFetchingNewer,
    onLoad: onLoadNewer,
    edge: "end",
  })

  const jumpClearTimerRef = useRef<number | null>(null)
  const jumpVisibilityFrameRef = useRef<number | null>(null)
  const jumpTo = useCallback((id: string, behavior: ScrollBehavior = "smooth") => {
    if (jumpClearTimerRef.current !== null) clearTimeout(jumpClearTimerRef.current)
    if (jumpVisibilityFrameRef.current !== null) {
      window.cancelAnimationFrame(jumpVisibilityFrameRef.current)
    }
    setJumped(id)
    jumpToIndex(id, behavior)
    let attempts = 0
    const armClear = () => {
      jumpVisibilityFrameRef.current = null
      const timeout = window.setTimeout(() => {
        setJumped((value) => (value === id ? null : value))
        if (jumpClearTimerRef.current === timeout) jumpClearTimerRef.current = null
      }, 1600)
      jumpClearTimerRef.current = timeout
    }
    const waitUntilVisible = () => {
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
  }, [jumpToIndex, scrollRef])
  useEffect(() => () => {
    if (jumpClearTimerRef.current !== null) clearTimeout(jumpClearTimerRef.current)
    if (jumpVisibilityFrameRef.current !== null) {
      window.cancelAnimationFrame(jumpVisibilityFrameRef.current)
    }
  }, [])

  const consumedScrollTargetRef = useRef<string | null>(null)
  useEffect(() => {
    if (!scrollToMessageId) {
      consumedScrollTargetRef.current = null
      return
    }
    if (consumedScrollTargetRef.current === scrollToMessageId) return
    if (!scrollTargetLoaded || !heroMeasured) return
    consumedScrollTargetRef.current = scrollToMessageId
    jumpTo(scrollToMessageId, "auto")
    onScrollTargetConsumed?.(scrollToMessageId)
  }, [
    scrollToMessageId,
    scrollTargetLoaded,
    heroMeasured,
    jumpTo,
    onScrollTargetConsumed,
  ])

  const jumpMode = !!hasMoreNewer
  const pillCount = jumpMode ? ((unreadCount ?? belowCount) || 0) : belowCount
  const pillOnClick = jumpMode
    ? (onJumpToPresent ?? scrollToBottom)
    : scrollToBottom

  const closeShare = useCallback(() => {
    setShareOpen(false)
    exitSelect()
  }, [exitSelect])

  return {
    items,
    isLoading,
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
    heroRef,
    scrollRef,
    virtualizer,
    topSentinelRef,
    bottomSentinelRef,
    onImageLoad,
    jumpTo,
    pillCount,
    pillMode: jumpMode ? "jump" as const : "scroll" as const,
    pillOnClick,
  }
}

export type MessageListController = ReturnType<typeof useMessageListController>
