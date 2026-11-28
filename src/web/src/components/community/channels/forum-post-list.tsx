"use client"

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual"
import { ListChevronsUpDown } from "@/components/icons/lucide";
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS } from "@/hooks/community/virtualizer-react-options"
import { useVirtualCursorPagination } from "@/hooks/community/use-virtual-cursor-pagination"
import type { ConversationListScope } from "@/lib/community/conversation-qualification"
import type { ForumThread } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import { EmptyState } from "../empty-state"
import { Separator } from "@/components/ui/separator"
import { ScrollAreaContent, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area"
import { VirtualRows } from "../messages/virtual-cursor-list"
import { useInitialPositionTransition } from "../messages/initial-position-transition"

const OVERSCAN = 8
export const FORUM_LIST_SPACING_CLASS = "p-0"
type Props = {
  forumChannelId?: string
  tag?: string
  posts: ForumThread[]
  loading?: boolean
  positionScope?: ConversationListScope
  hasMore?: boolean
  loadingMore?: boolean
  isFetching?: boolean
  isError?: boolean
  onLoadMore?: () => void
  onScrollRoot?: (node: HTMLDivElement | null) => void
  loadingContent: ReactNode
  onOpenPost?: (postId: string) => void
  renderPost: (post: ForumThread, index: number) => ReactNode
}

export function ForumPostListItem({ first, children, onActivate }: { first: boolean; children: ReactNode; onActivate?: () => void }) {
  return <div data-slot="community-forum-list-item" className="flow-root">
    {!first && <Separator aria-hidden="true" className="bg-border/50" />}
    <div
      data-slot="community-forum-list-card"
      className="group/card flow-root rounded py-[6.6px] transition-colors has-data-page-swipe-navigation-row:cursor-pointer has-data-page-swipe-navigation-row:hover:bg-accent/45"
      role={onActivate ? "presentation" : undefined}
      onClick={onActivate ? event => {
        const post = event.currentTarget.querySelector(":scope > [data-page-swipe-navigation-row]")
        if (!post || (event.target instanceof Node && post.contains(event.target))) return
        onActivate()
      } : undefined}
    >
      {children}
    </div>
  </div>
}

export function ForumPostList(props: Props) {
  const viewerId = props.positionScope?.proof.viewerId ?? null
  const channelId = props.forumChannelId ?? props.positionScope?.proof.channelId ?? null
  const [mountSlot, setMountSlot] = useState(() => ({
    viewerId,
    channelId,
    generation: 0,
  }))
  let nextMountSlot = mountSlot
  if (
    (viewerId !== null && mountSlot.viewerId !== null && viewerId !== mountSlot.viewerId)
    || (channelId !== null && mountSlot.channelId !== null && channelId !== mountSlot.channelId)
  ) {
    nextMountSlot = { viewerId, channelId, generation: mountSlot.generation + 1 }
    setMountSlot(nextMountSlot)
  } else if (
    (mountSlot.viewerId === null && viewerId !== null)
    || (mountSlot.channelId === null && channelId !== null)
  ) {
    nextMountSlot = {
      ...mountSlot,
      viewerId: mountSlot.viewerId ?? viewerId,
      channelId: mountSlot.channelId ?? channelId,
    }
    setMountSlot(nextMountSlot)
  }
  return <ForumPostListOwner key={nextMountSlot.generation} {...props} />
}

function ForumPostListOwner({ posts, loading, tag, positionScope, hasMore, loadingMore, isFetching, isError, onLoadMore, onScrollRoot, onOpenPost, renderPost, loadingContent }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const initialized = useRef(false)
  const activeTag = tag ?? positionScope?.tag ?? null
  const previousTagRef = useRef(activeTag)
  const [positionReady, setPositionReady] = useState(false)
  const positionReadyRef = useRef(false)
  useLayoutEffect(() => {
    if (posts.length === 0) {
      const next = !loading
      positionReadyRef.current = next
      setPositionReady(next)
    }
  }, [loading, posts.length])
  const presentation = useInitialPositionTransition({ firstWindowReady: !loading || posts.length > 0,
    authoritativeEmpty: !loading && posts.length === 0, positionSettled: positionReady })
  const postsRef = useRef(posts)
  useLayoutEffect(() => { postsRef.current = posts }, [posts])
  const bindScrollRoot = useCallback((node: HTMLDivElement | null) => { scrollRef.current = node; onScrollRoot?.(node) }, [onScrollRoot])
  const inspectPosition = useCallback((native: Virtualizer<HTMLDivElement, Element>) => {
    if (positionReadyRef.current) return
    const root = scrollRef.current
    const current = postsRef.current
    if (!initialized.current || !root || !root.isConnected || root.clientWidth <= 0 || root.clientHeight <= 0
      || native.isScrolling || Math.abs((native.scrollOffset ?? 0) - root.scrollTop) > 1
      || native.options.count !== current.length
      || current.some((post, index) => native.options.getItemKey(index) !== post.id)) return
    const viewport = root.getBoundingClientRect()
    if (viewport.width <= 0 || viewport.height <= 0) return
    const fold = native.getVirtualItemForOffset(root.scrollTop + 1)
    const wrapper = fold && root.querySelector<HTMLElement>(`[data-index="${fold.index}"]`)
    const rect = wrapper?.getBoundingClientRect()
    const padding = Number.parseFloat(window.getComputedStyle(root).paddingTop) || 0
    if (!fold || !rect || rect.height <= 0 || Math.abs(rect.height - fold.size) > 1
      || Math.abs(rect.top - viewport.top + root.scrollTop - padding - fold.start) > 1) return
    positionReadyRef.current = true
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
      const index = instance.indexFromElement(element)
      const cached = instance.itemSizeCache.get(instance.options.getItemKey(index))
      if (instance.options.useCachedMeasurements) {
        return cached ?? instance.options.estimateSize(index)
      }
      const observed = entry?.borderBoxSize?.[0]?.blockSize
      if (observed !== undefined) {
        return observed > 0 ? observed : cached && cached > 0 ? cached : instance.options.estimateSize(index)
      }
      if (!entry && cached !== undefined && cached > 0) {
        return cached
      }
      const size = element.getBoundingClientRect().height
      if (size > 0) return size
      return cached && cached > 0 ? cached : instance.options.estimateSize(index)
    },
    getItemKey,
    overscan: OVERSCAN,
    initialRect: { width: 0, height: 800 },
    onChange: native => { initializePosition(native); inspectPosition(native) },
  })
  useLayoutEffect(() => {
    if (previousTagRef.current !== activeTag) {
      previousTagRef.current = activeTag
      const root = scrollRef.current
      if (root) root.scrollTop = 0
      if (postsRef.current.length > 0) {
        virtualizer.scrollToIndex(0, { align: "start" })
      }
    }
  }, [activeTag, virtualizer])
  const virtualItems = virtualizer.getVirtualItems()
  useLayoutEffect(() => {
    initializePosition(virtualizer)
    inspectPosition(virtualizer)
  }, [initializePosition, inspectPosition, posts, virtualItems, virtualizer])
  useVirtualCursorPagination({
    virtualizer, count: posts.length, enabled: !loading,
    hasMore, isFetching: isFetching || loadingMore, isError, onLoad: onLoadMore, edge: "end",
  })
  const readPositionReady = !posts.length ? !loading : positionReady
  return <ScrollAreaRoot className="relative flex min-h-0 flex-1 flex-col">
    <ScrollAreaViewport ref={bindScrollRoot} role="main" data-testid={tid.forumPostList} data-community-conversation-subtype="forum"
      aria-busy={presentation.showSkeleton || undefined} aria-label={presentation.showSkeleton ? "Loading forum" : undefined}
      className={`min-h-0 flex-1 overflow-x-clip overflow-y-auto scroll-fade-y scroll-fade-4 [overflow-anchor:none] ${FORUM_LIST_SPACING_CLASS}`}>
      <ScrollAreaContent
        data-message-list-content
        aria-hidden="false"
        data-read-position-ready={readPositionReady ? "true" : "false"}
        className="flex min-h-full flex-col"
      >
        {!posts.length && loading ? <div>{loadingContent}</div>
          : !posts.length ? <div className="flex min-h-full flex-1 flex-col"><EmptyState icon={ListChevronsUpDown} label="No posts with this tag yet. Start one with New Post." /></div>
          : <VirtualRows directDomUpdatesMode="position" items={posts} virtualizer={virtualizer}
            renderItem={(post, index) => <ForumPostListItem first={index === 0} onActivate={onOpenPost ? () => onOpenPost(post.id) : undefined}>{renderPost(post, index)}</ForumPostListItem>}
            containerAttributes={{ "data-message-rows": "" }} />}
      </ScrollAreaContent>
    </ScrollAreaViewport>
    <ScrollBar orientation="vertical" />
  </ScrollAreaRoot>
}
