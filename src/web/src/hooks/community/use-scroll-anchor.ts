import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { measureElement, useVirtualizer, type ReactVirtualizer } from "@tanstack/react-virtual"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS } from "./virtualizer-react-options"
import { estimateRowHeight, computeBelowCount, type FlatItem } from "@/lib/community/message-list-items"
import { MESSAGE_RAIL_TAIL_PADDING_END_PX } from "@/lib/community/conversation-layout"

const INITIAL_POSITION_TIMEOUT_MS = 2_000
export const MESSAGE_LIST_DISPLAY_END_THRESHOLD_PX = 100
const VIEWPORT_RESIZE_TAIL_DISTANCE_PX = 100
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
    VIEWPORT_RESIZE_TAIL_DISTANCE_PX,
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
export function findMessageIndex(items: FlatItem[], messageId: string): number | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === "message" && item.m.id === messageId) return i
  }
  return null
}

export function findMountScrollTargetIndex(items: FlatItem[], newDividerBefore: string): number | null {
  const divider = items.findIndex((item) => item.kind === "divider" && item.newDivider && item.messageId === newDividerBefore)
  return divider >= 0 ? divider : findMessageIndex(items, newDividerBefore)
}

export function useScrollAnchor({
  items,
  newDividerBefore,
  initialScrollReady,
  scrollToMessageId,
  initialPositionMessageId,
  positionEntry,
  onScrollTargetPositioned,
  onScrollTargetCancelled,
  hasMoreOlder,
  hasMoreNewer,
  isFetchingOlder,
  isFetchingNewer,
  presentVersion,
  localSubmitVersion,
  tailPaddingEnd = MESSAGE_RAIL_TAIL_PADDING_END_PX,
  onInitialPositionSettled,
}: {
  items: FlatItem[]
  newDividerBefore?: string
  initialScrollReady: boolean
  scrollToMessageId?: string | null
  initialPositionMessageId?: string | null
  positionEntry?: object | null
  onScrollTargetPositioned?: (id: string) => void
  onScrollTargetCancelled?: (id: string) => void
  hasMoreOlder?: boolean
  hasMoreNewer?: boolean
  isFetchingOlder?: boolean
  isFetchingNewer?: boolean
  presentVersion?: number
  localSubmitVersion?: number
  tailPaddingEnd?: number
  onInitialPositionSettled?: () => void
}) {
  type Kind = "initial" | "target" | "present" | "idle"
  type Intent = {
    epoch: number
    type: "unread" | "target" | "end"
    id: string | null
    index: number | null
    behavior: ScrollBehavior
    notifyTarget: boolean
    loadedTailPresent: boolean
    viewport: { width: number; height: number }
  }
  type Geometry = {
    epoch: number
    key: string | number | bigint
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
  const positionOwnerRef = useRef({ epoch: 0, active: true })
  const [committedEntry, setCommittedEntry] = useState(positionEntry)
  const entryChanged = committedEntry !== positionEntry
  const positionKind = useCreateAtom<Kind>("initial")
  const [ownerKind, setOwnerKind] = useAtom(positionKind)
  const nativeOrigin = useCreateAtom<string | number | bigint | null>(null)
  const [nativeOriginKey, setNativeOriginKey] = useAtom(nativeOrigin)
  const readReady = useCreateAtom(false)
  const [readPositionReady, setReadPositionReady] = useAtom(readReady)
  const [shortGap, setShortGap] = useAtom(useCreateAtom(0))
  const [paginationDirection, setPaginationDirection] = useAtom(useCreateAtom<"older" | "newer" | null>(null))
  const paginationRef = useRef<{
    direction: "older" | "newer"
    phase: "pending" | "fetching" | "settling"
    anchor?: { key: string; viewportOffset: number; bodyInset: number; header: boolean; firstKey: string; epoch: number }
  } | null>(null)
  const scrollPaddingStartRef = useRef(0)
  const olderMeasurementAnchorRef = useRef<{ key: string; epoch: number } | null>(null)
  const entryResolvedRef = useRef(false)
  const initialRetiredRef = useRef(false)
  const initialPositionSettledRef = useRef(false)
  const initialDeadlineRef = useRef<{ handle: number; at: number } | null>(null)
  const initialSettleFrameRef = useRef<number | null>(null)
  const semanticIntentRef = useRef<Intent | null>(null)
  const targetIntentRef = useRef<string | null>(null)
  const positionedTargetRef = useRef<string | null>(null)
  const presentIntentRef = useRef<{ epoch: number; allowAttachedTail: boolean; fetching: boolean } | null>(null)
  const consumedPresentVersionRef = useRef(presentVersion ?? 0)
  const consumedLocalSubmitVersionRef = useRef(localSubmitVersion ?? 0)
  const currentItemsRef = useRef(items)
  const initialScrollReadyRef = useRef(initialScrollReady)
  const onTargetPositionedRef = useRef(onScrollTargetPositioned)
  const onTargetCancelledRef = useRef(onScrollTargetCancelled)
  const settleCallbackRef = useRef(onInitialPositionSettled)
  useLayoutEffect(() => {
    currentItemsRef.current = items
    initialScrollReadyRef.current = initialScrollReady
    onTargetPositionedRef.current = onScrollTargetPositioned
    onTargetCancelledRef.current = onScrollTargetCancelled
    settleCallbackRef.current = onInitialPositionSettled
  }, [items, initialScrollReady, onScrollTargetPositioned, onScrollTargetCancelled, onInitialPositionSettled])
  const followSuspension = useCreateAtom(false)
  const [followSuspended, setFollowSuspended] = useAtom(followSuspension)
  const acceptedGeometryRef = useRef<Geometry | null>(null)
  const geometryFrameRef = useRef<number | null>(null)
  const scheduleGeometryRef = useRef<() => void>(() => {})
  const reconcileViewportRef = useRef<() => void>(() => {})
  const userInputRef = useRef({ touch: false, pointers: new Set<number>(), handover: false })
  const hasMessages = items.some(item => item.kind === "message")
  const hadMessagesRef = useRef(false)
  const pendingLocalSubmit = (localSubmitVersion ?? 0) > consumedLocalSubmitVersionRef.current
  const holdNativeOrigin = useCallback((key: string | number | bigint | null) => {
    setNativeOriginKey(key)
    const native = virtualizerRef.current
    if (key !== null && native && !paginationRef.current) native.setOptions({ ...native.options, anchorTo: "start" })
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
    if (initialDeadlineRef.current !== null) window.clearTimeout(initialDeadlineRef.current.handle)
    initialDeadlineRef.current = null
  }, [])
  const clearOlderMeasurementAnchor = useCallback(() => {
    olderMeasurementAnchorRef.current = null
    if (virtualizerRef.current) virtualizerRef.current.shouldAdjustScrollPositionOnItemSizeChange = undefined
  }, [])
  const adjustOlderMeasurement = useCallback<NonNullable<ReactVirtualizer<HTMLDivElement, Element>["shouldAdjustScrollPositionOnItemSizeChange"]>>((item) => {
    const anchor = olderMeasurementAnchorRef.current
    const owner = positionOwnerRef.current
    const index = anchor && anchor.epoch === owner.epoch && owner.active && positionKind.get() === "idle"
      ? currentItemsRef.current.findIndex(row => row.key === anchor.key) : -1
    return item.index < index
  }, [positionKind])
  const claimPosition = useCallback((kind: Kind) => {
    const owner = positionOwnerRef.current
    virtualizerRef.current?.cancelScroll()
    clearOlderMeasurementAnchor()
    scrollPaddingStartRef.current = 0
    paginationRef.current = null
    setPaginationDirection(null)
    owner.epoch += 1
    setOwnerKind(kind)
    cancelFrame()
    clearBudget()
    semanticIntentRef.current = null
    acceptedGeometryRef.current = null
    holdNativeOrigin(null)
    presentIntentRef.current = null
    setReadPositionReady(false)
    return owner.epoch
  }, [cancelFrame, clearBudget, clearOlderMeasurementAnchor, holdNativeOrigin, setOwnerKind, setPaginationDirection, setReadPositionReady])
  const retireInitialPosition = useCallback(() => {
    initialRetiredRef.current = true
    entryResolvedRef.current = true
  }, [])
  const releasePosition = useCallback((userHandover = false) => {
    const intent = semanticIntentRef.current
    const cancelledTarget = positionKind.get() === "target"
      ? intent?.notifyTarget ? intent.id
        : !intent && positionedTargetRef.current !== targetIntentRef.current ? targetIntentRef.current : null
      : null
    const wasReadable = positionKind.get() === "idle" && readReady.get()
    claimPosition("idle")
    if (userHandover && wasReadable) setReadPositionReady(true)
    retireInitialPosition()
    positionedTargetRef.current = targetIntentRef.current
    if (cancelledTarget) onTargetCancelledRef.current?.(cancelledTarget)
    if (userHandover) userInputRef.current.handover = true
    settlePresentation()
    scheduleGeometryRef.current()
  }, [claimPosition, positionKind, readReady, retireInitialPosition, setReadPositionReady, settlePresentation])
  const armBudget = useCallback(() => {
    if (initialDeadlineRef.current !== null) return
    const epoch = positionOwnerRef.current.epoch
    const at = Date.now() + INITIAL_POSITION_TIMEOUT_MS
    const handle = window.setTimeout(() => {
      if (!positionOwnerRef.current.active || positionOwnerRef.current.epoch !== epoch) return
      releasePosition()
    }, INITIAL_POSITION_TIMEOUT_MS)
    initialDeadlineRef.current = { handle, at }
  }, [releasePosition])


  const readPageMessageGeometry = useCallback((key: string): { viewportOffset: number; bodyInset: number } | null => {
    const root = scrollRef.current
    const native = virtualizerRef.current
    if (!root || !native || Math.abs((native.scrollOffset ?? 0) - root.scrollTop) > 1) return null
    const row = native.getVirtualItems().find(item => item.key === key)
    if (!row) return null
    const item = currentItemsRef.current[row.index]
    const wrapper = root.querySelector<HTMLElement>(`[data-index="${row.index}"]`)
    const body = wrapper?.querySelector<HTMLElement>("[data-msg-id]")
    if (item?.kind !== "message" || item.key !== key
      || !wrapper || !body || body.dataset.msgId !== item.m.id) return null
    const rect = wrapper.getBoundingClientRect()
    const offset = rect.top - root.getBoundingClientRect().top
    if (rect.height <= 0 || Math.abs(offset + root.scrollTop - row.start) > 1) return null
    const bodyInset = body.getBoundingClientRect().top - rect.top
    return { viewportOffset: offset + bodyInset, bodyInset }
  }, [])
  const refreshPendingPageAnchor = useCallback(() => {
    const page = paginationRef.current
    const anchor = page?.anchor
    if (!page || page.phase === "settling" || !anchor
      || !positionOwnerRef.current.active || anchor.epoch !== positionOwnerRef.current.epoch
      || positionKind.get() !== "idle"
      || currentItemsRef.current.find(item => item.kind === "message")?.key !== anchor.firstKey) return
    const native = virtualizerRef.current
    const fold = native?.getVirtualItemForOffset(native.scrollOffset ?? 0)
    if (fold && currentItemsRef.current[fold.index]?.kind === "message") {
      if (String(fold.key) !== anchor.firstKey) {
        page.anchor = undefined
        return
      }
    }
    if (fold) anchor.header = currentItemsRef.current[fold.index]?.kind !== "message"
    const offset = readPageMessageGeometry(anchor.key)
    if (offset !== null) Object.assign(anchor, offset)
  }, [positionKind, readPageMessageGeometry])
  const awaitingTarget = !!scrollToMessageId && positionedTargetRef.current !== scrollToMessageId
  const getItemKey = useCallback((index: number) => items[index].key, [items])
  const estimateSize = useCallback((index: number) => estimateRowHeight(items[index], !!hasMoreOlder), [items, hasMoreOlder])
  // eslint-disable-next-line react-hooks/incompatible-library -- supported TanStack Virtual imperative adapter
  const virtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    directDomUpdates: false,
    useFlushSync: true,
    initialRect: { width: 0, height: items.reduce((size, item) => size + estimateRowHeight(item, !!hasMoreOlder), shortGap + tailPaddingEnd) },
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    measureElement: (element, entry, instance) => element.querySelector("[data-msg-id]")
      ? measureMessageRow(element)
      : measureElement(element, entry, instance),
    getItemKey,
    scrollPaddingStart: scrollPaddingStartRef.current,
    anchorTo: !entryChanged && ownerKind === "idle" && !awaitingTarget && !pendingLocalSubmit
      && (paginationDirection !== null || (readPositionReady && (nativeOriginKey === null || nativeOriginKey !== items[0]?.key))) ? "end" : "start",
    followOnAppend: !entryChanged && ownerKind === "idle" && readPositionReady && !awaitingTarget && hasMessages && hadMessagesRef.current
      && !pendingLocalSubmit && !followSuspended && !hasMoreNewer
      && !isFetchingOlder && !isFetchingNewer && paginationDirection === null
      && (nativeOriginKey === null || nativeOriginKey !== items[0]?.key) ? "auto" : false,
    scrollEndThreshold: 1,
    scrollMargin: 0,
    paddingStart: shortGap,
    paddingEnd: tailPaddingEnd,
    overscan: 8,
    onChange: () => { refreshPendingPageAnchor(); reconcileViewportRef.current(); scheduleGeometryRef.current() },
  })
  virtualizerRef.current = virtualizer
  useLayoutEffect(() => { refreshPendingPageAnchor() })
  useLayoutEffect(() => { hadMessagesRef.current = hasMessages }, [hasMessages])
  useLayoutEffect(() => {
    const anchor = olderMeasurementAnchorRef.current
    if (anchor && !items.some(item => item.key === anchor.key)) clearOlderMeasurementAnchor()
  }, [clearOlderMeasurementAnchor, items])

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
    const fold = native.getVirtualItemForOffset(root.scrollTop + 1)
    if (!fold) return null
    const item = currentItemsRef.current[fold.index]
    const wrapper = root.querySelector<HTMLElement>(`[data-index="${fold.index}"]`)
    const body = wrapper?.querySelector<HTMLElement>("[data-msg-id]")
    if (!item || !wrapper || fold.key !== item.key) return null
    if (item.kind === "message" ? body?.dataset.msgId !== item.m.id
      : wrapper.querySelector<HTMLElement>("[data-message-row-key]")?.dataset.messageRowKey !== item.key) return null
    const wrapperRect = wrapper.getBoundingClientRect()
    const viewport = root.getBoundingClientRect()
    if (wrapperRect.height <= 0
      || Math.abs(wrapperRect.height - fold.size) > 1
      || Math.abs(wrapperRect.top - viewport.top + root.scrollTop - fold.start) > 1) return null
    return {
      epoch: owner.epoch, key: fold.key,
      itemStart: fold.start, clientHeight: root.clientHeight, clientWidth: root.clientWidth,
      scrollHeight: root.scrollHeight, scrollTop: root.scrollTop,
      total, paddingEnd: native.options.paddingEnd ?? 0,
      pinEligible: native.isAtEnd(1) && !followSuspension.get()
        && nativeOrigin.get() !== currentItemsRef.current[0]?.key,
      isScrolling: native.isScrolling,
    }
  }, [followSuspension, nativeOrigin])
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
      if (root.clientHeight <= 0 || viewport.height <= 0) return
      let landed = false
      if (intent.type === "end") {
        const tail = currentItemsRef.current.findLast(item => item.kind === "message")
        const body = tail?.kind === "message" ? Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
          .find(element => element.dataset.msgId === tail.m.id) : undefined
        const rect = body?.getBoundingClientRect()
        const wrapper = body?.closest("[data-index]")?.getBoundingClientRect()
        landed = native.isAtEnd(1)
          && Math.abs(Math.max(0, root.scrollHeight - root.clientHeight) - root.scrollTop) <= 1
          && !!rect && rect.height > 0 && !!wrapper && wrapper.height > 0
          && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
      } else if (intent.id) {
        const index = intent.type === "unread"
          ? findMountScrollTargetIndex(currentItemsRef.current, intent.id)
          : findMessageIndex(currentItemsRef.current, intent.id)
        if (index !== null && index !== intent.index) {
          intent.index = index
          native.scrollToIndex(index, { align: "center", behavior: intent.behavior })
        }
        const row = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
          .find((element) => element.dataset.msgId === intent.id)
        const boundary = intent.type === "unread"
          ? Array.from(root.querySelectorAll<HTMLElement>("[data-message-divider-for]"))
            .find((element) => element.dataset.messageDividerFor === intent.id)?.querySelector<HTMLElement>("[data-new-divider]") ?? row
          : row
        const rect = boundary?.getBoundingClientRect()
        const body = row?.getBoundingClientRect()
        const wrapper = row?.closest("[data-index]")?.getBoundingClientRect()
        if (rect && body && wrapper && wrapper.height > 0 && rect.height > 0 && body.height > 0) {
          const targetOffset = index === null ? undefined : native.getOffsetForIndex(index, "center")?.[0]
          landed = targetOffset !== undefined && Math.abs(root.scrollTop - targetOffset) <= 1
            && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
            && body.bottom > viewport.top + 1 && body.top < viewport.bottom - 1
        }
      }
      if (landed) {
        const geometry = readGeometry()
        if (intent.type !== "end" && root.scrollTop <= 1) holdNativeOrigin(currentItemsRef.current[0]?.key ?? null)
        settlePresentation()
        if (positionKind.get() === "initial" && !initialScrollReadyRef.current) return
        acceptedGeometryRef.current = geometry
        semanticIntentRef.current = null
        setOwnerKind("idle")
        setReadPositionReady(true)
        retireInitialPosition()
        clearBudget()
        if (intent.notifyTarget && intent.id) {
          positionedTargetRef.current = intent.id
          onTargetPositionedRef.current?.(intent.id)
        }
        scheduleGeometryRef.current()
        return
      }
      if (!intent.loadedTailPresent) {
        initialSettleFrameRef.current = window.requestAnimationFrame(settle)
      }
    }
    initialSettleFrameRef.current = window.requestAnimationFrame(settle)
  }, [clearBudget, holdNativeOrigin, positionKind, readGeometry, retireInitialPosition, setOwnerKind, setReadPositionReady, settlePresentation])

  const startIntent = useCallback((type: Intent["type"], id: string | null, behavior: ScrollBehavior = "auto", notifyTarget = false, loadedTailPresent = false) => {
    const owner = positionOwnerRef.current
    const index = type === "end" ? currentItemsRef.current.length - 1
      : id ? type === "unread" ? findMountScrollTargetIndex(currentItemsRef.current, id)
        : findMessageIndex(currentItemsRef.current, id) : null
    semanticIntentRef.current = {
      epoch: owner.epoch, type, id, index, behavior, notifyTarget, loadedTailPresent,
      viewport: { width: scrollRef.current?.clientWidth ?? 0, height: scrollRef.current?.clientHeight ?? 0 },
    }
    if (type === "end") {
      virtualizerRef.current?.scrollToEnd({ behavior })
    }
    else if (index !== null) {
      virtualizerRef.current?.scrollToIndex(index, { align: "center", behavior })
    }
    if (!loadedTailPresent) armBudget()
    scheduleInitialPositionSettled()
  }, [armBudget, scheduleInitialPositionSettled])

  useLayoutEffect(() => {
    const owner = positionOwnerRef.current
    owner.active = true
    const intent = semanticIntentRef.current
    if (intent && intent.epoch !== owner.epoch) {
      startIntent(intent.type, intent.id, intent.behavior, intent.notifyTarget, intent.loadedTailPresent)
    } else if (positionKind.get() === "present" && presentIntentRef.current !== null) {
      presentIntentRef.current.epoch = owner.epoch
      armBudget()
    }
    return () => {
      owner.active = false
      owner.epoch += 1
      virtualizerRef.current?.cancelScroll()
      clearOlderMeasurementAnchor()
      paginationRef.current = null
      cancelFrame()
      clearBudget()
      if (geometryFrameRef.current !== null) window.cancelAnimationFrame(geometryFrameRef.current)
      geometryFrameRef.current = null
    }
  }, [armBudget, cancelFrame, clearBudget, clearOlderMeasurementAnchor, positionKind, releasePosition, startIntent])

  useLayoutEffect(() => {
    if (committedEntry === positionEntry) return
    setCommittedEntry(() => positionEntry)
    claimPosition("initial")
    entryResolvedRef.current = false
    initialRetiredRef.current = false
    initialPositionSettledRef.current = false
    targetIntentRef.current = null
    positionedTargetRef.current = null
    consumedPresentVersionRef.current = presentVersion ?? 0
    consumedLocalSubmitVersionRef.current = localSubmitVersion ?? 0
    userInputRef.current.handover = false
    setFollowSuspended(false)
  }, [claimPosition, committedEntry, localSubmitVersion, positionEntry, presentVersion, setFollowSuspended])

  useLayoutEffect(() => {
    const target = scrollToMessageId ?? null
    if (targetIntentRef.current === target) return
    targetIntentRef.current = target
    if (!target) {
      if (positionKind.get() === "target") releasePosition()
      positionedTargetRef.current = null
      return
    }
    claimPosition("target")
    retireInitialPosition()
    positionedTargetRef.current = null
    if (items.length > 0) startIntent("target", target, "auto", true)
  }, [claimPosition, items.length, positionEntry, positionKind, releasePosition, retireInitialPosition, scrollToMessageId, startIntent])

  useLayoutEffect(() => {
    if (items.length === 0) return
    if (positionKind.get() === "target") {
      if (!semanticIntentRef.current && targetIntentRef.current) startIntent("target", targetIntentRef.current, "auto", true)
      else scheduleInitialPositionSettled()
    } else if (positionKind.get() === "initial") armBudget()
  }, [armBudget, items, positionKind, scheduleInitialPositionSettled, startIntent])

  const observeGeometry = useCallback((next: Geometry, scrollEvent = false) => {
    const previous = acceptedGeometryRef.current
    const scrolledAfterResize = scrollEvent && previous?.epoch === next.epoch
      && previous.clientWidth === next.clientWidth
      && (previous.clientHeight !== next.clientHeight || previous.paddingEnd !== next.paddingEnd)
      && previous.scrollTop <= Math.max(0, next.scrollHeight - next.clientHeight) + 1
      && previous.scrollTop !== next.scrollTop
    if (positionKind.get() === "idle"
      && (!previous || scrolledAfterResize || (previous.epoch === next.epoch
        && previous.clientHeight === next.clientHeight && previous.clientWidth === next.clientWidth
        && previous.paddingEnd === next.paddingEnd
        ))) {
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
  }, [holdNativeOrigin, positionKind])

  const reconcileGeometry = useCallback((viewportOnly = false) => {
    const root = scrollRef.current
    const native = virtualizerRef.current
    const owner = positionOwnerRef.current
    if (!owner.active || !root || !native) return false
    if (viewportOnly && (positionKind.get() !== "idle"
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
    if (positionKind.get() !== "idle") return false
    const next = readGeometry(viewportOnly)
    const input = userInputRef.current
    const max = Math.max(0, root.scrollHeight - root.clientHeight)
    const previous = acceptedGeometryRef.current
    const viewportResized = previous?.epoch === owner.epoch
      && (previous.clientHeight !== root.clientHeight || previous.clientWidth !== root.clientWidth
        || previous.paddingEnd !== (native.options.paddingEnd ?? 0))
    if (!viewportResized && !input.handover) {
      if (!next) return false
      observeGeometry(next)
    } else {
      const clampedByResize = viewportResized && !previous.isScrolling && previous.scrollTop > max
        && Math.abs(root.scrollTop - max) <= 1
      if (!readReady.get() && !input.handover
        && (!next || (native.isScrolling && !clampedByResize))) return false
      if (input.touch || input.pointers.size > 0 || (native.isScrolling && !clampedByResize)
        || root.scrollTop < 0 || root.scrollTop > max + 1
        ) return true
      if (previous?.epoch === owner.epoch && readReady.get() && previous.pinEligible
        && previous.clientWidth !== root.clientWidth && !isFetchingOlder && !isFetchingNewer) {
        claimPosition("present")
        retireInitialPosition()
        startIntent("end", null, "auto", false, true)
        return false
      }
      if (!next) return native.getVirtualItems().length > 0
      const virtualItems = native.getVirtualItems()
      let offset = root.scrollTop
      let originHeld = false
      if (viewportResized && previous?.epoch === owner.epoch) {
        originHeld = !previous.pinEligible && previous.scrollTop <= 1
          && previous.key === currentItemsRef.current[0]?.key && previous.itemStart <= 1
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
            offset = resized.scrollTop
          }
        }
      }
      offset = Math.max(0, Math.min(offset, max))
      acceptedGeometryRef.current = {
        ...next, scrollTop: offset, pinEligible: !originHeld && next.pinEligible && max - offset <= 1,
        isScrolling: clampedByResize ? previous.isScrolling : next.isScrolling,
      }
      holdNativeOrigin(originHeld || (offset <= 1 && !acceptedGeometryRef.current.pinEligible) ? currentItemsRef.current[0]?.key ?? null : null)
      if (input.handover) {
        input.handover = false
        setReadPositionReady(true)
      }
      if (Math.abs(offset - root.scrollTop) > 0.5) native.scrollToOffset(offset, { behavior: "auto" })
    }
    if (paginationRef.current?.phase === "settling") {
      paginationRef.current = null
      setPaginationDirection(null)
      clearOlderMeasurementAnchor()
    }

    return false
  }, [claimPosition, clearOlderMeasurementAnchor, holdNativeOrigin, isFetchingOlder, isFetchingNewer, observeGeometry, positionKind, readGeometry, readReady, retireInitialPosition, setPaginationDirection, setReadPositionReady, setShortGap, startIntent])
  reconcileViewportRef.current = () => {
    const intent = semanticIntentRef.current
    const root = scrollRef.current
    const native = virtualizerRef.current
    if (intent && root && native && intent.epoch === positionOwnerRef.current.epoch
      && (intent.viewport.width !== root.clientWidth || intent.viewport.height !== root.clientHeight)) {
      intent.viewport = { width: root.clientWidth, height: root.clientHeight }
      if (intent.type !== "end" && intent.index !== null && root.clientHeight > 0) {
        native.scrollToIndex(intent.index, { align: "center", behavior: intent.behavior })
      }
      scheduleInitialPositionSettled()
    }
    if (intent?.loadedTailPresent) scheduleInitialPositionSettled()
    reconcileGeometry(true)
  }

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
    const inputOwner = userInputRef.current
    const onScroll = () => {
      const previous = acceptedGeometryRef.current
      const native = virtualizerRef.current
      if (positionKind.get() === "idle" && readReady.get()
        && previous?.epoch === positionOwnerRef.current.epoch && previous.scrollTop > 1
        && root.scrollTop <= 1 && root.scrollHeight - root.clientHeight > 1
        && Math.abs((native?.scrollOffset ?? 0) - root.scrollTop) <= 1) {
        acceptedGeometryRef.current = null
        holdNativeOrigin(currentItemsRef.current[0]?.key ?? null)
      } else if (positionKind.get() === "idle" && readReady.get()
        && previous?.epoch === positionOwnerRef.current.epoch && previous.scrollTop <= 1
        && nativeOrigin.get() === currentItemsRef.current[0]?.key && root.scrollTop > 1
        && native?.isAtEnd(1)
        && previous.clientHeight === root.clientHeight && previous.clientWidth === root.clientWidth
        && previous.scrollHeight === root.scrollHeight && previous.total === native?.getTotalSize()
        && previous.paddingEnd === (native?.options.paddingEnd ?? 0)
        && Math.abs((native?.scrollOffset ?? 0) - root.scrollTop) <= 1) {
        acceptedGeometryRef.current = null
        holdNativeOrigin(null)
      }
      reconcileGeometry(true)
      if (semanticIntentRef.current?.loadedTailPresent) scheduleInitialPositionSettled()
      const next = readGeometry()
      if (next && native?.isAtEnd(1) && Math.abs(Math.max(0, next.scrollHeight - next.clientHeight) - next.scrollTop) <= 1
        && !userInputRef.current.touch && userInputRef.current.pointers.size === 0
        && positionKind.get() === "idle" && readReady.get()
        && nativeOrigin.get() !== currentItemsRef.current[0]?.key) setFollowSuspended(false)
      if (next) observeGeometry(next, true)
      else if (positionKind.get() === "idle" && readReady.get()
        && previous?.epoch === positionOwnerRef.current.epoch && previous.scrollTop !== root.scrollTop
        && previous.clientHeight === root.clientHeight && previous.clientWidth === root.clientWidth
        && previous.paddingEnd === (native?.options.paddingEnd ?? 0)) {
        acceptedGeometryRef.current = null
        holdNativeOrigin(root.scrollTop <= 1 ? currentItemsRef.current[0]?.key ?? null : null)
      }
      scheduleGeometry()
    }
    const restoreEndEligibility = () => {
      const input = userInputRef.current
      const native = virtualizerRef.current
      if (input.touch || input.pointers.size > 0 || positionKind.get() !== "idle" || !readReady.get()
        || nativeOrigin.get() === currentItemsRef.current[0]?.key) return
      const geometry = readGeometry()
      if (!geometry || geometry.isScrolling || !native?.isAtEnd(1)
        || Math.abs(Math.max(0, geometry.scrollHeight - geometry.clientHeight) - geometry.scrollTop) > 1) return
      setFollowSuspended(false)
    }
    const onUserIntent = (towardEnd = false) => {
      releasePosition(true)
      setFollowSuspended(true)
      if (root.scrollTop <= 1) holdNativeOrigin(currentItemsRef.current[0]?.key ?? null)
      if (towardEnd) restoreEndEligibility()
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) onUserIntent(event.deltaY > 0)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        onUserIntent(["ArrowDown", "PageDown", "End"].includes(event.key) || (event.key === " " && !event.shiftKey))
      }
    }
    const onTouchStart = () => { userInputRef.current.touch = true; onUserIntent() }
    const onTouchEnd = (event: TouchEvent) => {
      const registered = userInputRef.current.touch
      userInputRef.current.touch = event.touches.length > 0
      if (registered) restoreEndEligibility()
      scheduleGeometry()
    }
    const onPointerDown = (event: PointerEvent) => { userInputRef.current.pointers.add(event.pointerId); onUserIntent() }
    const onPointerUp = (event: PointerEvent) => {
      if (!userInputRef.current.pointers.delete(event.pointerId)) return
      restoreEndEligibility()
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
    root.addEventListener("touchend", onTouchEnd, { passive: true })
    root.addEventListener("touchcancel", onTouchEnd, { passive: true })
    root.addEventListener("pointerdown", onPointerDown)
    root.ownerDocument.addEventListener("pointerup", onPointerUp)
    root.ownerDocument.addEventListener("pointercancel", onPointerUp)
    root.ownerDocument.defaultView?.addEventListener("blur", onBlur)
    const ro = new ResizeObserver(() => { reconcileViewportRef.current(); scheduleGeometry() })
    ro.observe(root)
    const footer = root.closest<HTMLElement>('[data-slot="community-conversation-surface"]')
      ?.querySelector<HTMLElement>('[data-slot="community-conversation-footer"]')
    const mo = footer && typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => { reconcileViewportRef.current(); scheduleGeometry() }) : null
    mo?.observe(footer!, { attributes: true, characterData: true, childList: true, subtree: true })
    return () => {
      root.removeEventListener("scroll", onScroll)
      root.removeEventListener("wheel", onWheel)
      root.removeEventListener("keydown", onKeyDown)
      root.removeEventListener("touchstart", onTouchStart)
      root.removeEventListener("touchend", onTouchEnd)
      root.removeEventListener("touchcancel", onTouchEnd)
      root.removeEventListener("pointerdown", onPointerDown)
      root.ownerDocument.removeEventListener("pointerup", onPointerUp)
      root.ownerDocument.removeEventListener("pointercancel", onPointerUp)
      root.ownerDocument.defaultView?.removeEventListener("blur", onBlur)
      ro.disconnect()
      mo?.disconnect()
      inputOwner.touch = false
      inputOwner.pointers.clear()
    }
  }, [holdNativeOrigin, nativeOrigin, observeGeometry, positionKind, readGeometry, readReady, reconcileGeometry, releasePosition, scheduleGeometry, scheduleInitialPositionSettled, setFollowSuspended])

  const capturePageAnchor = useCallback((direction: "older" | "newer") => {
    clearOlderMeasurementAnchor()
    let anchor: NonNullable<typeof paginationRef.current>["anchor"]
    if (positionKind.get() === "idle") {
      const geometry = readGeometry()
      if (geometry) acceptedGeometryRef.current = geometry
      const native = virtualizerRef.current
      const offset = native?.scrollOffset ?? 0
      const fold = native?.getVirtualItemForOffset(offset)
      const first = currentItemsRef.current.find(item => item.kind === "message")
      const header = !!fold && currentItemsRef.current[fold.index]?.kind !== "message"
      if (direction === "older" && fold && (header || String(fold.key) === first?.key)) {
        const message = native?.getVirtualItems().find(item => currentItemsRef.current[item.index]?.kind === "message" && item.end > offset)
        const viewportOffset = message && readPageMessageGeometry(String(message.key))
        if (message && first && viewportOffset !== null && viewportOffset !== undefined) anchor = {
          key: String(message.key), ...viewportOffset, header,
          firstKey: first.key, epoch: positionOwnerRef.current.epoch,
        }
      }
    }
    paginationRef.current = { direction, phase: "pending", anchor }
    setPaginationDirection(direction)
  }, [clearOlderMeasurementAnchor, positionKind, readGeometry, readPageMessageGeometry, setPaginationDirection])
  const captureOlderPageAnchor = useCallback(() => capturePageAnchor("older"), [capturePageAnchor])
  const captureNewerPageAnchor = useCallback(() => capturePageAnchor("newer"), [capturePageAnchor])
  useLayoutEffect(() => {
    const page = paginationRef.current
    if (!page || page.phase === "settling") return
    const fetching = page.direction === "older" ? isFetchingOlder : isFetchingNewer
    if (fetching) { page.phase = "fetching"; return }
    if (page.phase !== "fetching") return
    page.phase = "settling"
    let restoringBody = false
    if (page.anchor && page.anchor.epoch === positionOwnerRef.current.epoch
      && positionKind.get() === "idle"
      && items.find(item => item.kind === "message")?.key !== page.anchor.firstKey) {
      const index = items.findIndex(item => item.key === page.anchor?.key)
      const item = items[index]
      const native = virtualizerRef.current
      const bodyInset = item?.kind === "message" ? item.paddingTop ?? page.anchor.bodyInset : page.anchor.bodyInset
      if (index >= 0 && native && (page.anchor.header || bodyInset !== page.anchor.bodyInset)) {
        olderMeasurementAnchorRef.current = { key: page.anchor.key, epoch: page.anchor.epoch }
        native.shouldAdjustScrollPositionOnItemSizeChange = adjustOlderMeasurement
        scrollPaddingStartRef.current = page.anchor.viewportOffset - bodyInset
        native.setOptions({ ...native.options, scrollPaddingStart: scrollPaddingStartRef.current })
        acceptedGeometryRef.current = null
        holdNativeOrigin(null)
        native.scrollToIndex(index, { align: "start" })
        restoringBody = true
      }
    }
    if (!restoringBody) {
      paginationRef.current = null
      setPaginationDirection(null)
    }
    scheduleInitialPositionSettled()
    scheduleGeometry()
  }, [adjustOlderMeasurement, holdNativeOrigin, isFetchingNewer, isFetchingOlder, items, positionKind, scheduleGeometry, scheduleInitialPositionSettled, setPaginationDirection])

  useLayoutEffect(() => {
    const version = localSubmitVersion ?? 0
    if (version === consumedLocalSubmitVersionRef.current) return
    const accepted = version > consumedLocalSubmitVersionRef.current
    consumedLocalSubmitVersionRef.current = version
    if (!accepted) return
    if (positionKind.get() === "target") releasePosition()
    const epoch = claimPosition("present")
    retireInitialPosition()
    setFollowSuspended(false)
    if (hasMessages && !hasMoreNewer && !isFetchingNewer) startIntent("end", null)
    else {
      presentIntentRef.current = { epoch, allowAttachedTail: !hasMoreNewer && !isFetchingNewer, fetching: isFetchingNewer === true }
      armBudget()
    }
  }, [armBudget, claimPosition, hasMessages, hasMoreNewer, isFetchingNewer, localSubmitVersion, positionKind, releasePosition, retireInitialPosition, setFollowSuspended, startIntent])

  useLayoutEffect(() => {
    const completedWindow = hasMessages && !hasMoreNewer && !isFetchingNewer
      && !!presentVersion && consumedPresentVersionRef.current !== presentVersion
    if (completedWindow) consumedPresentVersionRef.current = presentVersion
    const owner = positionOwnerRef.current
    const intent = presentIntentRef.current
    if (!owner.active || positionKind.get() !== "present" || intent?.epoch !== owner.epoch) return
    if (isFetchingNewer) {
      intent.fetching = true
      clearBudget()
      return
    }
    if (intent.fetching) armBudget()
    if (intent.fetching && hasMoreNewer) {
      releasePosition()
      return
    }
    if (!hasMessages || hasMoreNewer) return
    if (!completedWindow && !intent.allowAttachedTail) return
    presentIntentRef.current = null
    retireInitialPosition()
    setFollowSuspended(false)
    startIntent("end", null)
  }, [armBudget, clearBudget, hasMessages, hasMoreNewer, isFetchingNewer, positionKind, presentVersion, releasePosition, retireInitialPosition, setFollowSuspended, startIntent])

  const virtualItems = virtualizer.getVirtualItems()
  useLayoutEffect(() => {
    const root = scrollRef.current
    const viewportReady = !!root && root.clientHeight > 0 && virtualItems.length > 0
      && !!root.querySelector("[data-index]")
    if (positionKind.get() !== "initial" || initialRetiredRef.current || !hasMessages || !viewportReady) return
    if (initialScrollReady && !entryResolvedRef.current) {
      entryResolvedRef.current = true
      startIntent(initialPositionMessageId ? "target" : newDividerBefore ? "unread" : "end", initialPositionMessageId ?? newDividerBefore ?? null)
    } else if (!initialScrollReady && !hasMoreNewer && !semanticIntentRef.current) startIntent("end", null)
    else scheduleInitialPositionSettled()
  }, [cancelFrame, hasMessages, hasMoreNewer, initialScrollReady, initialPositionMessageId, items, newDividerBefore, positionEntry, positionKind, releasePosition, scheduleInitialPositionSettled, startIntent, virtualItems])

  const requestPresentPosition = useCallback(() => {
    presentIntentRef.current = { epoch: claimPosition("present"), allowAttachedTail: false, fetching: false }
    retireInitialPosition()
    armBudget()
  }, [armBudget, claimPosition, retireInitialPosition])
  const scrollToBottom = useCallback(() => {
    claimPosition("present")
    retireInitialPosition()
    setFollowSuspended(false)
    startIntent("end", null, "auto", false, true)
  }, [claimPosition, retireInitialPosition, setFollowSuspended, startIntent])
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
  const belowCount = root && virtualizer.isAtEnd(MESSAGE_LIST_DISPLAY_END_THRESHOLD_PX)
    ? 0 : computeBelowCount(items, lastVisibleIndex)
  return {
    scrollRef, virtualizer, readPositionReady: !entryChanged && readPositionReady, paginationEnabled: !entryChanged && ownerKind === "idle" && !awaitingTarget, belowCount,
    scrollToBottom, requestPresentPosition, jumpTo,
    captureOlderPageAnchor, captureNewerPageAnchor,
  }
}
