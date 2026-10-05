import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react"
import { useVirtualizer, type ReactVirtualizer } from "@tanstack/react-virtual"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS } from "./virtualizer-react-options"
import { estimateRowHeight, computeBelowCount, type FlatItem } from "@/lib/community/message-list-items"

export const INITIAL_POSITION_TIMEOUT_MS = 2_000
export const NEAR_BOTTOM_PX = 100
export const MESSAGE_RAIL_TAIL_PADDING_END_PX = {
  mobile: 40,
  desktop: 48,
} as const

export function resolveMessageRailTailPaddingEnd(
  breakpoint: "unknown" | "desktop" | "mobile",
): number {
  return breakpoint === "mobile"
    ? MESSAGE_RAIL_TAIL_PADDING_END_PX.mobile
    : MESSAGE_RAIL_TAIL_PADDING_END_PX.desktop
}

type ViewportResizeAnchor = "tail" | "start"

export interface ResolveViewportResizeAnchorInput {
  previousClientHeight: number
  nextClientHeight: number
  previousScrollHeight: number
  nextScrollHeight: number
  previousScrollTop: number
}

export interface ViewportResizeAnchorResult {
  anchor: ViewportResizeAnchor
  scrollTop: number
  distanceToEnd: number
}

export function resolveViewportResizeAnchor({
  previousClientHeight,
  nextClientHeight,
  previousScrollHeight,
  nextScrollHeight,
  previousScrollTop,
}: ResolveViewportResizeAnchorInput): ViewportResizeAnchorResult {
  const distanceToEnd = Math.max(
    0,
    previousScrollHeight - previousClientHeight - previousScrollTop,
  )
  const viewportGrowth = Math.max(0, nextClientHeight - previousClientHeight)
  const anchor: ViewportResizeAnchor = distanceToEnd <= Math.max(
    NEAR_BOTTOM_PX,
    viewportGrowth,
  )
    ? "tail"
    : "start"
  const maxScrollTop = Math.max(0, nextScrollHeight - nextClientHeight)
  const requestedScrollTop = anchor === "tail"
    ? maxScrollTop - distanceToEnd
    : previousScrollTop

  return {
    anchor,
    scrollTop: Math.max(0, Math.min(requestedScrollTop, maxScrollTop)),
    distanceToEnd,
  }
}

export function measureMessageRow(element: Element): number {
  const row = element as HTMLElement
  return Math.ceil(Math.max(element.getBoundingClientRect().height, row.scrollHeight))
}
export interface ScrollAnchorMessage {
  id: string
  authorId?: string
}

export interface ScrollAnchorState {
  didInitialScroll: boolean
  didDividerConverge: boolean
  lastTailId: string | null
}

export function createScrollAnchorState(): ScrollAnchorState {
  return {
    didInitialScroll: false,
    didDividerConverge: false,
    lastTailId: null,
  }
}

export interface DecideScrollActionInput {
  state: ScrollAnchorState
  messages: ScrollAnchorMessage[]
  newDividerBefore?: string
  initialScrollReady: boolean
  viewportReady: boolean
  hasMoreNewer?: boolean
  isPaginatingNewer?: boolean
  viewerUserId?: string
  isAtEnd: boolean
  userScrolledAway?: boolean
}

type ScrollAction =
  | { type: "none" }
  | { type: "mount"; newDividerBefore: string | undefined }
  | { type: "scrollToEnd" }

export interface DecideScrollActionResult {
  action: ScrollAction
  nextState: ScrollAnchorState
}

export function decideScrollAction(input: DecideScrollActionInput): DecideScrollActionResult {
  const { state, messages, newDividerBefore, initialScrollReady, viewportReady, hasMoreNewer, isPaginatingNewer, viewerUserId, isAtEnd, userScrolledAway } = input

  const nextTail = messages[messages.length - 1]?.id ?? null
  const nextLen = messages.length

  const baseNextState: ScrollAnchorState = {
    didInitialScroll: state.didInitialScroll,
    didDividerConverge: state.didDividerConverge,
    lastTailId: nextTail,
  }
  if (nextLen === 0) {
    return {
      action: { type: "none" },
      nextState: { ...baseNextState, didInitialScroll: false, didDividerConverge: false },
    }
  }
  const tailAttached = !hasMoreNewer
  if (!state.didInitialScroll) {
    if (viewportReady && userScrolledAway) {
      return {
        action: { type: "none" },
        nextState: { ...baseNextState, didInitialScroll: true, didDividerConverge: true },
      }
    }
    if (viewportReady && initialScrollReady) {
      return {
        action: { type: "mount", newDividerBefore },
        nextState: { ...baseNextState, didInitialScroll: true, didDividerConverge: true },
      }
    }
    if (viewportReady && tailAttached) {
      return {
        action: { type: "scrollToEnd" },
        nextState: { ...baseNextState, didInitialScroll: true, didDividerConverge: false },
      }
    }
    return {
      action: { type: "none" },
      nextState: { ...baseNextState, didInitialScroll: false },
    }
  }
  const tailChanged = state.lastTailId !== null && state.lastTailId !== nextTail
  if (!state.didDividerConverge && !tailChanged) {
    if (!initialScrollReady || !viewportReady) {
      return { action: { type: "none" }, nextState: baseNextState }
    }
    if (newDividerBefore && isAtEnd && !userScrolledAway) {
      return {
        action: { type: "mount", newDividerBefore },
        nextState: { ...baseNextState, didDividerConverge: true },
      }
    }
    return { action: { type: "none" }, nextState: { ...baseNextState, didDividerConverge: true } }
  }
  if (tailChanged) {
    const liveState = { ...baseNextState, didDividerConverge: true }
    if (isPaginatingNewer) {
      return { action: { type: "none" }, nextState: liveState }
    }
    const tail = messages[messages.length - 1]
    const isSelfSend = !!viewerUserId && tail?.authorId === viewerUserId
    if (isSelfSend) {
      return { action: { type: "scrollToEnd" }, nextState: liveState }
    }
    if (!hasMoreNewer && isAtEnd && !userScrolledAway) {
      return { action: { type: "scrollToEnd" }, nextState: liveState }
    }
    return { action: { type: "none" }, nextState: liveState }
  }

  return { action: { type: "none" }, nextState: baseNextState }
}

export function findMessageIndex(items: FlatItem[], messageId: string): number | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === "message" && item.m.id === messageId) return i
  }
  return null
}

export function findMountScrollTargetIndex(items: FlatItem[], newDividerBefore: string): number | null {
  return findMessageIndex(items, newDividerBefore)
}

export function extractScrollAnchorMessages(items: FlatItem[]): ScrollAnchorMessage[] {
  const out: ScrollAnchorMessage[] = []
  for (const item of items) {
    if (item.kind === "message") out.push({ id: item.m.id, authorId: item.m.authorId })
  }
  return out
}

export function useScrollAnchor({
  items,
  newDividerBefore,
  initialScrollReady,
  scrollToMessageId,
  onScrollTargetPositioned,
  onScrollTargetCancelled,
  hasMoreOlder,
  hasMoreNewer,
  isFetchingOlder,
  isFetchingNewer,
  presentVersion,
  viewerUserId,
  tailPaddingEnd = MESSAGE_RAIL_TAIL_PADDING_END_PX.desktop,
  onInitialPositionSettled,
}: {
  items: FlatItem[]
  newDividerBefore?: string
  initialScrollReady: boolean
  scrollToMessageId?: string | null
  onScrollTargetPositioned?: (id: string) => void
  onScrollTargetCancelled?: (id: string) => void
  hasMoreOlder?: boolean
  hasMoreNewer?: boolean
  isFetchingOlder?: boolean
  isFetchingNewer?: boolean
  presentVersion?: number
  viewerUserId?: string
  tailPaddingEnd?: number
  onInitialPositionSettled?: () => void
}) {
  type Kind = "initial" | "target" | "present" | "idle"
  type Intent = {
    epoch: number
    type: "unread" | "target" | "end"
    id: string | null
    index: number | null
    layout: string | null
    stableFrames: number
    behavior: ScrollBehavior
    notifyTarget: boolean
  }
  type Geometry = {
    epoch: number
    key: string | number | bigint
    prefix: number
    itemStart: number
    clientHeight: number
    clientWidth: number
    scrollHeight: number
    scrollTop: number
    total: number
    paddingEnd: number
    pinEligible: boolean
    isScrolling: boolean
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizerRef = useRef<ReactVirtualizer<HTMLDivElement, Element> | null>(null)
  const positionOwnerRef = useRef({ epoch: 0, kind: "initial" as Kind, active: true, nativeIndex: false })
  const [ownerKind, setOwnerKind] = useAtom(useCreateAtom<Kind>("initial"))
  const [nativeOriginKey, setNativeOriginKey] = useAtom(useCreateAtom<string | number | bigint | null>(null))
  const nativeOriginKeyRef = useRef<string | number | bigint | null>(null)
  const [readPositionReady, setReadPositionReady] = useAtom(useCreateAtom(false))
  const [shortGap, setShortGap] = useAtom(useCreateAtom(0))
  const [paginationDirection, setPaginationDirection] = useAtom(useCreateAtom<"older" | "newer" | null>(null))
  const paginationRef = useRef<{ direction: "older" | "newer"; observed: boolean } | null>(null)
  const stateRef = useRef<ScrollAnchorState>(createScrollAnchorState())
  const initialRetiredRef = useRef(false)
  const initialPositionSettledRef = useRef(false)
  const initialDeadlineRef = useRef<number | null>(null)
  const positionBudgetStartedRef = useRef(false)
  const initialSettleFrameRef = useRef<number | null>(null)
  const semanticIntentRef = useRef<Intent | null>(null)
  const targetIntentRef = useRef<string | null>(null)
  const positionedTargetRef = useRef<string | null>(null)
  const presentIntentEpochRef = useRef<number | null>(null)
  const consumedPresentVersionRef = useRef(0)
  const currentItemsRef = useRef(items)
  currentItemsRef.current = items
  const initialScrollReadyRef = useRef(initialScrollReady)
  initialScrollReadyRef.current = initialScrollReady
  const onTargetPositionedRef = useRef(onScrollTargetPositioned)
  onTargetPositionedRef.current = onScrollTargetPositioned
  const onTargetCancelledRef = useRef(onScrollTargetCancelled)
  onTargetCancelledRef.current = onScrollTargetCancelled
  const settleCallbackRef = useRef(onInitialPositionSettled)
  settleCallbackRef.current = onInitialPositionSettled
  const readReadyRef = useRef(readPositionReady)
  readReadyRef.current = readPositionReady
  const wasAtEndRef = useRef(false)
  const userScrolledAwayRef = useRef(false)
  const acceptedGeometryRef = useRef<Geometry | null>(null)
  const geometrySampleRef = useRef<{ value: string; frames: number } | null>(null)
  const geometryFrameRef = useRef<number | null>(null)
  const scheduleGeometryRef = useRef<() => void>(() => {})
  const reconcileViewportRef = useRef<() => void>(() => {})
  const userInputRef = useRef({ at: -Infinity, scrollAt: -Infinity, touch: false, pointers: new Set<number>(), handover: false })
  const tailKeyRef = useRef<string | null>(null)
  const messages = useMemo(() => extractScrollAnchorMessages(items), [items])
  const tailId = messages.at(-1)?.id ?? null
  const holdNativeOrigin = useCallback((key: string | number | bigint | null) => {
    nativeOriginKeyRef.current = key
    setNativeOriginKey(key)
    const native = virtualizerRef.current
    if (key !== null && native) native.setOptions({ ...native.options, anchorTo: "start" })
  }, [setNativeOriginKey])
  const cancelFrame = useCallback(() => {
    if (initialSettleFrameRef.current !== null) window.cancelAnimationFrame(initialSettleFrameRef.current)
    initialSettleFrameRef.current = null
  }, [])
  const settlePresentation = useCallback(() => {
    if (!positionOwnerRef.current.active || initialPositionSettledRef.current) return
    initialPositionSettledRef.current = true
    settleCallbackRef.current?.()
  }, [])
  const clearBudget = useCallback(() => {
    if (initialDeadlineRef.current !== null) window.clearTimeout(initialDeadlineRef.current)
    initialDeadlineRef.current = null
    positionBudgetStartedRef.current = false
  }, [])
  const claimPosition = useCallback((kind: Kind) => {
    const owner = positionOwnerRef.current
    if (owner.nativeIndex && scrollRef.current) {
      virtualizerRef.current?.scrollToOffset(scrollRef.current.scrollTop, { behavior: "auto" })
    }
    owner.nativeIndex = false
    owner.epoch += 1
    owner.kind = kind
    setOwnerKind(kind)
    cancelFrame()
    clearBudget()
    semanticIntentRef.current = null
    acceptedGeometryRef.current = null
    holdNativeOrigin(null)
    geometrySampleRef.current = null
    presentIntentEpochRef.current = null
    readReadyRef.current = false
    setReadPositionReady(false)
    return owner.epoch
  }, [cancelFrame, clearBudget, holdNativeOrigin, setOwnerKind, setReadPositionReady])
  const retireInitialPosition = useCallback(() => {
    initialRetiredRef.current = true
    stateRef.current = { ...stateRef.current, didInitialScroll: true, didDividerConverge: true }
  }, [])
  const releasePosition = useCallback((userHandover = false) => {
    const intent = semanticIntentRef.current
    const cancelledTarget = positionOwnerRef.current.kind === "target"
      ? intent?.notifyTarget ? intent.id
        : !intent && positionedTargetRef.current !== targetIntentRef.current ? targetIntentRef.current : null
      : null
    const wasReadable = positionOwnerRef.current.kind === "idle" && readReadyRef.current
    claimPosition("idle")
    if (userHandover && wasReadable) { readReadyRef.current = true; setReadPositionReady(true) }
    retireInitialPosition()
    positionedTargetRef.current = targetIntentRef.current
    if (cancelledTarget) onTargetCancelledRef.current?.(cancelledTarget)
    if (userHandover) userInputRef.current.handover = true
    settlePresentation()
    scheduleGeometryRef.current()
  }, [claimPosition, retireInitialPosition, setReadPositionReady, settlePresentation])
  const armBudget = useCallback(() => {
    if (positionBudgetStartedRef.current) return
    positionBudgetStartedRef.current = true
    const epoch = positionOwnerRef.current.epoch
    initialDeadlineRef.current = window.setTimeout(() => {
      if (!positionOwnerRef.current.active || positionOwnerRef.current.epoch !== epoch) return
      releasePosition()
    }, INITIAL_POSITION_TIMEOUT_MS)
  }, [releasePosition])


  const awaitingTarget = !!scrollToMessageId && positionedTargetRef.current !== scrollToMessageId
  // eslint-disable-next-line react-hooks/incompatible-library -- supported TanStack Virtual imperative adapter
  const virtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateRowHeight(items[index])
      + (index === 0 ? (hasMoreOlder ? 88 : 152) : 0)
      + (index === items.length - 1 && hasMoreNewer ? 56 : 0),
    measureElement: measureMessageRow,
    getItemKey: (index) => items[index].key,
    anchorTo: ownerKind === "idle" && readPositionReady && !awaitingTarget
      && (nativeOriginKey === null || nativeOriginKey !== items[0]?.key || paginationDirection !== null) ? "end" : "start",
    followOnAppend: false,
    scrollEndThreshold: 1,
    scrollMargin: 0,
    paddingStart: shortGap,
    paddingEnd: tailPaddingEnd,
    overscan: 8,
    onChange: () => { reconcileViewportRef.current(); scheduleGeometryRef.current() },
  })
  virtualizerRef.current = virtualizer

  const scheduleInitialPositionSettled = useCallback(() => {
    if (initialSettleFrameRef.current !== null) return
    const epoch = positionOwnerRef.current.epoch
    const settle = () => {
      const owner = positionOwnerRef.current
      if (!owner.active || owner.epoch !== epoch) return
      initialSettleFrameRef.current = null
      const intent = semanticIntentRef.current
      const root = scrollRef.current
      const native = virtualizerRef.current
      if (!intent || intent.epoch !== owner.epoch || !root || !native) return
      const viewport = root.getBoundingClientRect()
      if (root.clientHeight <= 0 || viewport.height <= 0) {
        initialSettleFrameRef.current = window.requestAnimationFrame(settle)
        return
      }
      let landed = false
      if (intent.type === "end") {
        const index = currentItemsRef.current.length - 1
        if (intent.index !== index) {
          intent.index = index
          intent.stableFrames = 0
          owner.nativeIndex = index >= 0
          native.scrollToEnd({ behavior: intent.behavior })
        }
        landed = Math.abs(root.scrollHeight - root.clientHeight - root.scrollTop) <= 1
      } else if (intent.id) {
        const index = findMessageIndex(currentItemsRef.current, intent.id)
        if (index !== null && index !== intent.index) {
          intent.index = index
          intent.layout = null
          intent.stableFrames = 0
          owner.nativeIndex = true
          native.scrollToIndex(index, { align: "center", behavior: "auto" })
        }
        const row = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
          .find((element) => element.dataset.msgId === intent.id)
        const boundary = intent.type === "unread"
          ? row?.parentElement?.querySelector<HTMLElement>("[data-new-divider]")
          : row
        const rect = boundary?.getBoundingClientRect()
        const body = row?.getBoundingClientRect()
        if (rect && body && rect.height > 0 && body.height > 0) {
          const contentCenter = (rect.top + rect.bottom) / 2 - viewport.top + root.scrollTop
          const max = Math.max(0, root.scrollHeight - root.clientHeight)
          const targetOffset = Math.max(0, Math.min(contentCenter - viewport.height / 2, max))
          const layout = JSON.stringify([index, Math.round(contentCenter), max, viewport.height])
          if (intent.layout !== layout) {
            intent.layout = layout
            intent.stableFrames = 0
            const cancelNativeIndex = owner.nativeIndex
            owner.nativeIndex = false
            if (cancelNativeIndex || Math.abs(root.scrollTop - targetOffset) > 1) native.scrollToOffset(targetOffset, { behavior: "auto" })
          }
          landed = Math.abs(root.scrollTop - targetOffset) <= 1
            && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
            && body.bottom > viewport.top + 1 && body.top < viewport.bottom - 1
        }
      }
      intent.stableFrames = landed ? intent.stableFrames + 1 : 0
      if (intent.stableFrames >= 2) {
        settlePresentation()
        if (owner.kind === "initial" && !initialScrollReadyRef.current) return
        semanticIntentRef.current = null
        owner.nativeIndex = false
        if (intent.type !== "end" && root.scrollTop <= 1) holdNativeOrigin(currentItemsRef.current[0]?.key ?? null)
        owner.kind = "idle"
        setOwnerKind("idle")
        readReadyRef.current = true
        setReadPositionReady(true)
        clearBudget()
        if (intent.notifyTarget && intent.id) {
          positionedTargetRef.current = intent.id
          onTargetPositionedRef.current?.(intent.id)
        }
        scheduleGeometryRef.current()
        return
      }
      initialSettleFrameRef.current = window.requestAnimationFrame(settle)
    }
    initialSettleFrameRef.current = window.requestAnimationFrame(settle)
  }, [clearBudget, holdNativeOrigin, setOwnerKind, setReadPositionReady, settlePresentation])

  const startIntent = useCallback((type: Intent["type"], id: string | null, behavior: ScrollBehavior = "auto", notifyTarget = false) => {
    const owner = positionOwnerRef.current
    const index = type === "end" ? currentItemsRef.current.length - 1
      : id ? findMessageIndex(currentItemsRef.current, id) : null
    semanticIntentRef.current = { epoch: owner.epoch, type, id, index, layout: null, stableFrames: 0, behavior, notifyTarget }
    if (type === "end") {
      owner.nativeIndex = currentItemsRef.current.length > 0
      virtualizerRef.current?.scrollToEnd({ behavior })
    }
    else if (index !== null) {
      owner.nativeIndex = true
      virtualizerRef.current?.scrollToIndex(index, { align: "center", behavior })
    }
    armBudget()
    scheduleInitialPositionSettled()
  }, [armBudget, scheduleInitialPositionSettled])

  useLayoutEffect(() => {
    const owner = positionOwnerRef.current
    const root = scrollRef.current
    owner.active = true
    const intent = semanticIntentRef.current
    if (intent && intent.epoch !== owner.epoch) {
      startIntent(intent.type, intent.id, intent.behavior, intent.notifyTarget)
    } else if (owner.kind === "present" && presentIntentEpochRef.current !== null) {
      presentIntentEpochRef.current = owner.epoch
      armBudget()
    }
    return () => {
      owner.active = false
      owner.epoch += 1
      if (owner.nativeIndex && root) virtualizerRef.current?.scrollToOffset(root.scrollTop, { behavior: "auto" })
      owner.nativeIndex = false
      cancelFrame()
      clearBudget()
      if (geometryFrameRef.current !== null) window.cancelAnimationFrame(geometryFrameRef.current)
      geometryFrameRef.current = null
    }
  }, [armBudget, cancelFrame, clearBudget, startIntent])

  useLayoutEffect(() => {
    const target = scrollToMessageId ?? null
    if (targetIntentRef.current === target) return
    targetIntentRef.current = target
    if (!target) {
      if (positionOwnerRef.current.kind === "target") releasePosition()
      positionedTargetRef.current = null
      return
    }
    claimPosition("target")
    retireInitialPosition()
    positionedTargetRef.current = null
    if (items.length > 0) startIntent("target", target, "auto", true)
  }, [claimPosition, items.length, releasePosition, retireInitialPosition, scrollToMessageId, startIntent])

  useLayoutEffect(() => {
    if (items.length === 0) return
    const owner = positionOwnerRef.current
    if (owner.kind === "target") {
      if (!semanticIntentRef.current && targetIntentRef.current) startIntent("target", targetIntentRef.current, "auto", true)
      else scheduleInitialPositionSettled()
    } else if (owner.kind === "initial") armBudget()
  }, [armBudget, items, scheduleInitialPositionSettled, startIntent])

  const readGeometry = useCallback((viewportTransition = false): Geometry | null => {
    const root = scrollRef.current
    const native = virtualizerRef.current
    const owner = positionOwnerRef.current
    const previous = acceptedGeometryRef.current
    const pendingViewportRect = viewportTransition && previous?.epoch === owner.epoch
      && (previous.clientHeight !== root?.clientHeight || previous.clientWidth !== root?.clientWidth)
      && Math.abs((native?.scrollRect?.height ?? 0) - previous.clientHeight) <= 1
      && Math.abs((native?.scrollRect?.width ?? 0) - previous.clientWidth) <= 1
    if (!owner.active || !root || !native || root.clientHeight <= 0
      || Math.abs((native.scrollOffset ?? 0) - root.scrollTop) > 1
      || (!pendingViewportRect && (Math.abs((native.scrollRect?.height ?? 0) - root.clientHeight) > 1
        || Math.abs((native.scrollRect?.width ?? 0) - root.clientWidth) > 1))) return null
    const total = native.getTotalSize()
    const max = Math.max(0, root.scrollHeight - root.clientHeight)
    if (root.scrollTop < 0 || root.scrollTop > max + 1) return null
    const virtualItems = native.getVirtualItems()
    const fold = [...virtualItems].reverse().find((item) => item.start <= root.scrollTop + 1) ?? virtualItems[0]
    if (!fold) return null
    const item = currentItemsRef.current[fold.index]
    const wrapper = root.querySelector<HTMLElement>(`[data-index="${fold.index}"]`)
    const body = wrapper?.querySelector<HTMLElement>("[data-msg-id]")
    if (!item || !wrapper || body?.dataset.msgId !== item.m.id || fold.key !== item.key) return null
    const wrapperRect = wrapper.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    const viewport = root.getBoundingClientRect()
    if (wrapperRect.height <= 0 || bodyRect.height <= 0
      || Math.abs(wrapperRect.height - fold.size) > 1
      || Math.abs(wrapperRect.top - viewport.top + root.scrollTop - fold.start) > 1) return null
    return {
      epoch: owner.epoch, key: fold.key, prefix: bodyRect.top - wrapperRect.top,
      itemStart: fold.start, clientHeight: root.clientHeight, clientWidth: root.clientWidth,
      scrollHeight: root.scrollHeight, scrollTop: root.scrollTop,
      total, paddingEnd: native.options.paddingEnd ?? 0,
      pinEligible: max - root.scrollTop <= 1 && !userScrolledAwayRef.current
        && nativeOriginKeyRef.current !== currentItemsRef.current[0]?.key,
      isScrolling: native.isScrolling,
    }
  }, [])
  const observeGeometry = useCallback((next: Geometry, scrollEvent = false) => {
    const previous = acceptedGeometryRef.current
    const previousFold = previous && virtualizerRef.current?.getVirtualItems().find((item) => item.key === previous.key)
    const scrolledAfterResize = scrollEvent && previous?.epoch === next.epoch
      && previous.clientWidth === next.clientWidth
      && (previous.clientHeight !== next.clientHeight || previous.paddingEnd !== next.paddingEnd)
      && previous.scrollTop <= Math.max(0, next.scrollHeight - next.clientHeight) + 1
      && previous.scrollTop !== next.scrollTop
    if (positionOwnerRef.current.kind === "idle" && readReadyRef.current
      && (!previous || scrolledAfterResize || (previous.epoch === next.epoch
        && previous.clientHeight === next.clientHeight && previous.clientWidth === next.clientWidth
        && previous.scrollHeight === next.scrollHeight
        && previous.total === next.total && previous.paddingEnd === next.paddingEnd
        && previousFold?.start === previous.itemStart
        && (previous.key !== next.key || previous.prefix === next.prefix)))) {
      const unchangedPosition = previous?.epoch === next.epoch
        && previous.clientHeight === next.clientHeight && previous.clientWidth === next.clientWidth
        && previous.scrollHeight === next.scrollHeight
        && virtualizerRef.current?.scrollOffset === previous.scrollTop
        && Math.abs(previous.scrollTop - next.scrollTop) <= 1
      acceptedGeometryRef.current = {
        ...next, isScrolling: next.isScrolling && unchangedPosition ? previous.isScrolling : next.isScrolling,
      }
      holdNativeOrigin(next.scrollTop <= 1 && !next.pinEligible ? currentItemsRef.current[0]?.key ?? null : null)
    }
  }, [holdNativeOrigin])

  const reconcileGeometry = useCallback((viewportOnly = false) => {
    const root = scrollRef.current
    const native = virtualizerRef.current
    const owner = positionOwnerRef.current
    if (!owner.active || !root || !native) return false
    if (viewportOnly && (owner.kind !== "idle" || !readReadyRef.current
      || acceptedGeometryRef.current?.epoch !== owner.epoch
      || (acceptedGeometryRef.current.clientHeight === root.clientHeight
        && acceptedGeometryRef.current.clientWidth === root.clientWidth
        && acceptedGeometryRef.current.paddingEnd === (native.options.paddingEnd ?? 0)))) return false
    const total = native.getTotalSize()
    const gap = Math.max(0, root.clientHeight - (total - (native.options.paddingStart ?? 0)))
    if (Math.abs(gap - (native.options.paddingStart ?? 0)) > 1) {
      setShortGap(gap)
      return true
    }
    if (owner.kind !== "idle" || (!readReadyRef.current && !userInputRef.current.handover)) return false
    const next = readGeometry(viewportOnly)
    if (next) observeGeometry(next)
    const input = userInputRef.current
    const max = Math.max(0, root.scrollHeight - root.clientHeight)
    const previous = acceptedGeometryRef.current
    const viewportResized = !!next && previous?.epoch === owner.epoch
      && (previous.clientHeight !== next.clientHeight || previous.clientWidth !== next.clientWidth || previous.paddingEnd !== next.paddingEnd)
    const clampedByResize = viewportResized && !previous.isScrolling && previous.scrollTop > max
      && Math.abs(root.scrollTop - max) <= 1
    if (input.touch || input.pointers.size > 0 || (native.isScrolling && !clampedByResize)
      || root.scrollTop < 0 || root.scrollTop > max + 1
      || performance.now() - input.at < 180
      || (!clampedByResize && performance.now() - input.scrollAt < 180)) return true
    if (!next) return native.getVirtualItems().length > 0
    const virtualItems = native.getVirtualItems()
    const value = JSON.stringify(next)
    const sample = geometrySampleRef.current
    geometrySampleRef.current = { value, frames: sample?.value === value ? sample.frames + 1 : 1 }
    if (!viewportResized && geometrySampleRef.current.frames < 2) return true
    let offset = root.scrollTop
    let originHeld = false
    if (previous?.epoch === owner.epoch && readReadyRef.current) {
      originHeld = !previous.pinEligible && previous.scrollTop <= 1
        && previous.key === currentItemsRef.current[0]?.key && previous.itemStart <= 1
      const prefixDelta = previous.key === next.key && !previous.pinEligible && !originHeld ? next.prefix - previous.prefix : 0
      offset += prefixDelta
      if (originHeld) offset = previous.scrollTop
      else if (previous.clientHeight !== next.clientHeight || previous.clientWidth !== next.clientWidth || previous.paddingEnd !== next.paddingEnd) {
        const previousFold = virtualItems.find((candidate) => candidate.key === previous.key)
        if (previousFold) {
          const totalDelta = next.total - previous.total - (next.paddingEnd - previous.paddingEnd)
          const adjustedPreviousOffset = previous.scrollTop
            + (previous.pinEligible ? totalDelta : previousFold.start - previous.itemStart)
          const resized = resolveViewportResizeAnchor({
            previousClientHeight: previous.clientHeight,
            nextClientHeight: next.clientHeight,
            previousScrollHeight: previous.scrollHeight + totalDelta,
            nextScrollHeight: next.scrollHeight,
            previousScrollTop: adjustedPreviousOffset,
          })
          offset = resized.scrollTop + (resized.anchor === "start" ? prefixDelta : 0)
        }
      }
    }
    offset = Math.max(0, Math.min(offset, max))
    acceptedGeometryRef.current = {
      ...next, scrollTop: offset, pinEligible: !originHeld && next.pinEligible && max - offset <= 1,
      isScrolling: clampedByResize ? previous.isScrolling : next.isScrolling,
    }
    holdNativeOrigin(originHeld || (offset <= 1 && !acceptedGeometryRef.current.pinEligible) ? currentItemsRef.current[0]?.key ?? null : null)
    wasAtEndRef.current = max - offset <= NEAR_BOTTOM_PX
    if (input.handover) {
      input.handover = false
      readReadyRef.current = true
      setReadPositionReady(true)
    }
    if (viewportResized && previous.pinEligible && previous.clientWidth !== next.clientWidth) {
      owner.nativeIndex = true
      native.scrollToEnd({ behavior: "auto" })
      return true
    }
    if (Math.abs(offset - root.scrollTop) > 0.5) native.scrollToOffset(offset, { behavior: "auto" })
    return false
  }, [holdNativeOrigin, observeGeometry, readGeometry, setReadPositionReady, setShortGap])
  reconcileViewportRef.current = () => { reconcileGeometry(true) }

  const scheduleGeometry = useCallback(() => {
    if (geometryFrameRef.current !== null || !positionOwnerRef.current.active) return
    const accept = () => {
      geometryFrameRef.current = null
      if (reconcileGeometry()) geometryFrameRef.current = window.requestAnimationFrame(accept)
    }
    geometryFrameRef.current = window.requestAnimationFrame(accept)
  }, [reconcileGeometry])
  scheduleGeometryRef.current = scheduleGeometry
  useLayoutEffect(() => { scheduleGeometry() }, [items, ownerKind, readPositionReady, scheduleGeometry, shortGap, tailPaddingEnd])

  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onScroll = () => {
      const input = userInputRef.current
      const previous = acceptedGeometryRef.current
      const unchanged = previous?.epoch === positionOwnerRef.current.epoch
        && previous.clientHeight === root.clientHeight && previous.clientWidth === root.clientWidth
        && previous.scrollHeight === root.scrollHeight
        && virtualizerRef.current?.scrollOffset === previous.scrollTop
        && Math.abs(previous.scrollTop - root.scrollTop) <= 1
      if (!unchanged) input.scrollAt = performance.now()
      reconcileGeometry(true)
      const distance = Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop)
      wasAtEndRef.current = distance <= NEAR_BOTTOM_PX
      if (wasAtEndRef.current) userScrolledAwayRef.current = false
      const next = readGeometry()
      if (next) observeGeometry(next, true)
      scheduleGeometry()
    }
    const onUserIntent = () => {
      userInputRef.current.at = performance.now()
      userScrolledAwayRef.current = true
      releasePosition(true)
      userScrolledAwayRef.current = true
      if (root.scrollTop <= 1) holdNativeOrigin(currentItemsRef.current[0]?.key ?? null)
    }
    const onWheel = (event: WheelEvent) => { if (event.deltaY !== 0) onUserIntent() }
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) onUserIntent()
    }
    const onTouchStart = () => { userInputRef.current.touch = true; onUserIntent() }
    const onTouchMove = () => { userInputRef.current.at = performance.now() }
    const onTouchEnd = (event: TouchEvent) => {
      userInputRef.current.touch = event.touches.length > 0
      userInputRef.current.at = performance.now()
      scheduleGeometry()
    }
    const onPointerDown = (event: PointerEvent) => { userInputRef.current.pointers.add(event.pointerId); onUserIntent() }
    const onPointerUp = (event: PointerEvent) => {
      if (!userInputRef.current.pointers.delete(event.pointerId)) return
      userInputRef.current.at = performance.now()
      scheduleGeometry()
    }
    const onBlur = () => {
      userInputRef.current.touch = false
      userInputRef.current.pointers.clear()
      scheduleGeometry()
    }
    root.addEventListener("scroll", onScroll, { passive: true })
    root.addEventListener("wheel", onWheel, { passive: true })
    root.addEventListener("keydown", onKeyDown)
    root.addEventListener("touchstart", onTouchStart, { passive: true })
    root.addEventListener("touchmove", onTouchMove, { passive: true })
    root.addEventListener("touchend", onTouchEnd, { passive: true })
    root.addEventListener("touchcancel", onTouchEnd, { passive: true })
    root.addEventListener("pointerdown", onPointerDown)
    root.ownerDocument.addEventListener("pointerup", onPointerUp)
    root.ownerDocument.addEventListener("pointercancel", onPointerUp)
    root.ownerDocument.defaultView?.addEventListener("blur", onBlur)
    const ro = new ResizeObserver(() => { reconcileGeometry(true); scheduleGeometry() })
    ro.observe(root)
    const footer = root.closest<HTMLElement>('[data-slot="community-conversation-surface"]')
      ?.querySelector<HTMLElement>('[data-slot="community-conversation-footer"]')
    const mo = footer && typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => { reconcileGeometry(true); scheduleGeometry() }) : null
    mo?.observe(footer!, { attributes: true, characterData: true, childList: true, subtree: true })
    return () => {
      root.removeEventListener("scroll", onScroll)
      root.removeEventListener("wheel", onWheel)
      root.removeEventListener("keydown", onKeyDown)
      root.removeEventListener("touchstart", onTouchStart)
      root.removeEventListener("touchmove", onTouchMove)
      root.removeEventListener("touchend", onTouchEnd)
      root.removeEventListener("touchcancel", onTouchEnd)
      root.removeEventListener("pointerdown", onPointerDown)
      root.ownerDocument.removeEventListener("pointerup", onPointerUp)
      root.ownerDocument.removeEventListener("pointercancel", onPointerUp)
      root.ownerDocument.defaultView?.removeEventListener("blur", onBlur)
      ro.disconnect()
      mo?.disconnect()
      userInputRef.current.touch = false
      userInputRef.current.pointers.clear()
    }
  }, [holdNativeOrigin, observeGeometry, readGeometry, reconcileGeometry, releasePosition, scheduleGeometry])

  const capturePageAnchor = useCallback((direction: "older" | "newer") => {
    if (positionOwnerRef.current.kind === "idle" && readReadyRef.current) {
      const geometry = readGeometry()
      if (geometry) acceptedGeometryRef.current = geometry
    }
    paginationRef.current = { direction, observed: false }
    setPaginationDirection(direction)
  }, [readGeometry, setPaginationDirection])
  const captureOlderPageAnchor = useCallback(() => capturePageAnchor("older"), [capturePageAnchor])
  const captureNewerPageAnchor = useCallback(() => capturePageAnchor("newer"), [capturePageAnchor])
  useLayoutEffect(() => {
    const page = paginationRef.current
    if (!page) return
    const fetching = page.direction === "older" ? isFetchingOlder : isFetchingNewer
    if (fetching) { page.observed = true; return }
    if (!page.observed) return
    paginationRef.current = null
    setPaginationDirection(null)
    stateRef.current = { ...stateRef.current, lastTailId: tailId }
    tailKeyRef.current = items.at(-1)?.key ?? null
    scheduleInitialPositionSettled()
    scheduleGeometry()
  }, [isFetchingNewer, isFetchingOlder, items, scheduleGeometry, scheduleInitialPositionSettled, setPaginationDirection, tailId])

  useLayoutEffect(() => {
    if (!presentVersion || !tailId || hasMoreNewer || consumedPresentVersionRef.current === presentVersion) return
    consumedPresentVersionRef.current = presentVersion
    stateRef.current = { ...stateRef.current, lastTailId: tailId }
    tailKeyRef.current = items.at(-1)?.key ?? null
    const owner = positionOwnerRef.current
    if (!owner.active || owner.kind !== "present" || presentIntentEpochRef.current !== owner.epoch) return
    presentIntentEpochRef.current = null
    retireInitialPosition()
    userScrolledAwayRef.current = false
    startIntent("end", null)
  }, [hasMoreNewer, items, presentVersion, retireInitialPosition, startIntent, tailId])

  const virtualItems = virtualizer.getVirtualItems()
  useLayoutEffect(() => {
    const owner = positionOwnerRef.current
    const root = scrollRef.current
    const viewportReady = !!root && root.clientHeight > 0 && virtualItems.length > 0
      && !!root.querySelector("[data-index]")
    if (owner.kind === "target" || owner.kind === "present") {
      stateRef.current = { ...stateRef.current, lastTailId: tailId }
      tailKeyRef.current = items.at(-1)?.key ?? null
      return
    }
    if (owner.kind === "initial" && stateRef.current.didInitialScroll) {
      stateRef.current = { ...stateRef.current, lastTailId: tailId }
      tailKeyRef.current = items.at(-1)?.key ?? null
      if (!stateRef.current.didDividerConverge && initialScrollReady && viewportReady) {
        stateRef.current = { ...stateRef.current, didDividerConverge: true }
        startIntent(newDividerBefore ? "unread" : "end", newDividerBefore ?? null)
      } else scheduleInitialPositionSettled()
      return
    }
    const previousTailKey = tailKeyRef.current
    const nextTailKey = items.at(-1)?.key ?? null
    const { action, nextState } = decideScrollAction({
      state: stateRef.current,
      messages,
      newDividerBefore,
      initialScrollReady,
      viewportReady,
      hasMoreNewer,
      isPaginatingNewer: !!isFetchingNewer || paginationDirection === "newer",
      viewerUserId,
      isAtEnd: wasAtEndRef.current,
      userScrolledAway: userScrolledAwayRef.current,
    })
    stateRef.current = initialRetiredRef.current
      ? { ...nextState, didInitialScroll: true, didDividerConverge: true }
      : nextState
    tailKeyRef.current = nextTailKey
    if (action.type === "mount" && owner.kind === "initial") {
      startIntent(action.newDividerBefore ? "unread" : "end", action.newDividerBefore ?? null)
    } else if (action.type === "scrollToEnd") {
      if (owner.kind === "initial") startIntent("end", null)
      else if (readReadyRef.current && previousTailKey !== nextTailKey) {
        claimPosition("present")
        retireInitialPosition()
        userScrolledAwayRef.current = false
        startIntent("end", null)
      }
    } else if (semanticIntentRef.current) scheduleInitialPositionSettled()
  }, [claimPosition, hasMoreNewer, initialScrollReady, isFetchingNewer, items, messages, newDividerBefore, paginationDirection, retireInitialPosition, scheduleInitialPositionSettled, startIntent, tailId, viewerUserId, virtualItems, virtualizer])

  const requestPresentPosition = useCallback(() => {
    presentIntentEpochRef.current = claimPosition("present")
    retireInitialPosition()
    armBudget()
  }, [armBudget, claimPosition, retireInitialPosition])
  const scrollToBottom = useCallback(() => {
    claimPosition("present")
    retireInitialPosition()
    userScrolledAwayRef.current = false
    startIntent("end", null, "smooth")
  }, [claimPosition, retireInitialPosition, startIntent])
  const jumpTo = useCallback((messageId: string, behavior: ScrollBehavior = "smooth") => {
    if (findMessageIndex(currentItemsRef.current, messageId) === null) return
    claimPosition("target")
    retireInitialPosition()
    startIntent("target", messageId, behavior)
  }, [claimPosition, retireInitialPosition, startIntent])
  const visibleItems = virtualizer.getVirtualItems()
  const root = scrollRef.current
  const lastVisibleIndex = root
    ? visibleItems.filter((item) => item.start < root.scrollTop + root.clientHeight).at(-1)?.index ?? -1
    : -1
  const belowCount = root && root.scrollHeight - root.clientHeight - root.scrollTop <= NEAR_BOTTOM_PX
    ? 0 : computeBelowCount(items, lastVisibleIndex)
  return {
    scrollRef, virtualizer, readPositionReady, belowCount,
    scrollToBottom, requestPresentPosition, jumpTo,
    captureOlderPageAnchor, captureNewerPageAnchor,
    isOlderPageAnchorSettling: paginationDirection === "older",
    isNewerPageAnchorSettling: paginationDirection === "newer",
  }
}
