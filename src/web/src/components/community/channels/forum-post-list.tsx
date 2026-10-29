"use client"

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { defaultRangeExtractor, measureElement, useVirtualizer, type Range, type Virtualizer } from "@tanstack/react-virtual"
import { ListChevronsUpDown } from "lucide-react"
import { hashKey } from "@tanstack/react-query"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS } from "@/hooks/community/virtualizer-react-options"
import { useVirtualCursorPagination } from "@/hooks/community/use-virtual-cursor-pagination"
import { conversationListScopeKey, type ConversationListScope } from "@/lib/community/conversation-qualification"
import { useObservedRegion, type ResourceObservation } from "@/lib/observability/regions"
import { visibleVirtualItems } from "@/lib/observability/virtual-window"
import type { ForumThread } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import { EmptyState } from "../empty-state"
import { VirtualRows } from "../messages/virtual-cursor-list"

const OVERSCAN = 5
const forumRangeExtractor = (range: Range) => defaultRangeExtractor({ ...range, overscan: range.overscan + range.endIndex - range.startIndex + 1 })
type Props = {
  posts: ForumThread[]
  loading?: boolean
  observation?: ResourceObservation
  positionScope?: ConversationListScope
  hasMore?: boolean
  loadingMore?: boolean
  isFetching?: boolean
  isError?: boolean
  onLoadMore?: () => void
  onScrollRoot?: (node: HTMLDivElement | null) => void
  loadingContent: ReactNode
  renderPost: (post: ForumThread, index: number) => ReactNode
}

export function ForumPostList(props: Props) {
  return <ForumPostListEntry key={props.positionScope ? hashKey(conversationListScopeKey(props.positionScope)) : undefined} {...props} />
}

function ForumPostListEntry(props: Props) {
  const [admitted, setAdmitted] = useState(false)
  if (!props.loading && !admitted || props.posts.length > 0 && !admitted) setAdmitted(true)
  if (!admitted && props.loading && !props.posts.length) return <div data-testid={tid.forumPostList} aria-label="Loading forum" aria-busy="true" data-community-conversation-subtype="forum" className="flex-1 overflow-y-auto thin-scrollbar px-0 py-2 sm:px-4">{props.loadingContent}</div>
  return <ForumPostListOwner {...props} />
}

function ForumPostListOwner({ posts, loading, observation, hasMore, loadingMore, isFetching, isError, onLoadMore, onScrollRoot, renderPost }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const initialized = useRef(false)
  const [positionReady, setPositionReady] = useState(false)
  const postsRef = useRef(posts)
  useLayoutEffect(() => { postsRef.current = posts }, [posts])
  const bindScrollRoot = useCallback((node: HTMLDivElement | null) => { scrollRef.current = node; onScrollRoot?.(node) }, [onScrollRoot])
  const inspectPosition = useCallback((native: Virtualizer<HTMLDivElement, Element>) => {
    const root = scrollRef.current
    const current = postsRef.current
    if (!initialized.current || !root || !root.isConnected || root.clientWidth <= 0 || root.clientHeight <= 0
      || native.isScrolling || Math.abs((native.scrollOffset ?? 0) - root.scrollTop) > 1
      || native.options.count !== current.length
      || current.some((post, index) => native.options.getItemKey(index) !== post.id)) return
    const fold = native.getVirtualItemForOffset(root.scrollTop + 1)
    const wrapper = fold && root.querySelector<HTMLElement>(`[data-index="${fold.index}"]`)
    const rect = wrapper?.getBoundingClientRect()
    const padding = Number.parseFloat(window.getComputedStyle(root).paddingTop) || 0
    if (!fold || !rect || rect.height <= 0 || Math.abs(rect.height - fold.size) > 1
      || Math.abs(rect.top - root.getBoundingClientRect().top + root.scrollTop - padding - fold.start) > 1) return
    setPositionReady(true)
  }, [])
  const getItemKey = useCallback((index: number) => posts[index]?.id ?? index, [posts])
  const initializePosition = useCallback((native: Virtualizer<HTMLDivElement, Element>) => {
    const current = postsRef.current
    if (initialized.current || !current.length || native.options.count !== current.length
      || current.some((post, index) => native.options.getItemKey(index) !== post.id)) return
    initialized.current = true
    native.scrollToIndex(0, { align: "start" })
  }, [])
  // eslint-disable-next-line react-hooks/incompatible-library -- supported TanStack Virtual imperative adapter
  const virtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    directDomUpdatesMode: "position",
    count: posts.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 128,
    measureElement: (element, entry, instance) => {
      const size = measureElement(element, entry, instance)
      if (size > 0) return size
      const index = instance.indexFromElement(element)
      const cached = instance.itemSizeCache.get(instance.options.getItemKey(index))
      return cached && cached > 0 ? cached : instance.options.estimateSize(index)
    },
    getItemKey,
    overscan: OVERSCAN,
    rangeExtractor: forumRangeExtractor,
    initialRect: { width: 0, height: 800 },
    onChange: native => { initializePosition(native); inspectPosition(native) },
  })
  useLayoutEffect(() => {
    initializePosition(virtualizer)
    inspectPosition(virtualizer)
  })
  const virtualItems = virtualizer.getVirtualItems()
  const range = virtualizer.range
  const paginationItems = useMemo(() => {
    if (!range) return []
    const indexes = new Set(defaultRangeExtractor({ ...range, count: posts.length, overscan: OVERSCAN }))
    return virtualItems.filter(item => indexes.has(item.index))
  }, [posts.length, range, virtualItems])
  const observedPosts = visibleVirtualItems(virtualizer).flatMap(item => posts[item.index] ? [posts[item.index]] : [])
  useObservedRegion("forum", (!loading || posts.length > 0) && (!posts.length || observedPosts.length > 0), observedPosts.length, observation)
  useVirtualCursorPagination({
    virtualizer: { getVirtualItems: () => paginationItems }, count: posts.length, enabled: !loading,
    hasMore, isFetching: isFetching || loadingMore, isError, onLoad: onLoadMore, edge: "end",
  })
  return <div ref={bindScrollRoot} role="main" data-testid={tid.forumPostList} className="flex-1 overflow-y-auto thin-scrollbar [overflow-anchor:none] px-0 py-2 sm:px-4">
    {!posts.length ? <div data-message-list-content aria-hidden="false" data-read-position-ready="true"><EmptyState icon={ListChevronsUpDown} label="No posts with this tag yet. Start one with New Post." /></div>
      : <VirtualRows directDomUpdatesMode="position" items={posts} virtualizer={virtualizer} renderItem={renderPost}
        containerAttributes={{ "data-message-list-content": "", "aria-hidden": false, "data-read-position-ready": positionReady ? "true" : "false" }} />}
  </div>
}
