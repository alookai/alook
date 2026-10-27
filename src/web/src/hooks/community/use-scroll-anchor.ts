import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { measureElement, useVirtualizer, type ReactVirtualizer } from "@tanstack/react-virtual"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS, type VirtualRowsLayoutSnapshot } from "./virtualizer-react-options"
import { estimateRowHeight, computeBelowCount, type FlatItem } from "@/lib/community/message-list-items"
import { MESSAGE_RAIL_TAIL_PADDING_END_PX } from "@/lib/community/conversation-layout"
import type { MessagePositionState, MessageRequest, MessageRequestResult } from "@/lib/community/message-position"
import { readVirtualListPosition, saveVirtualListPosition, virtualListLayoutFingerprint, type VirtualListPositionScope } from "@/lib/community/virtual-list-position"

export const MESSAGE_LIST_DISPLAY_END_THRESHOLD_PX = 100
const VIEWPORT_RESIZE_TAIL_DISTANCE_PX = 100
type PositionOutcome = "pending" | "success" | "user-cancelled" | "cancelled" | "empty" | "error"
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
  positionDataState,
  messageWindow,
  active = true,
  positioningActive = active,
  scrollToMessageId,
  initialPositionMessageId,
  positionEntry,
  positionScope,
  onScrollTargetPositioned,
  onScrollTargetCancelled,
  hasMoreOlder,
  hasMoreNewer,
  isFetchingOlder,
  isFetchingNewer,
  presentVersion,
  presentRequest,
  localSubmitVersion,
  tailPaddingEnd = MESSAGE_RAIL_TAIL_PADDING_END_PX,
  onInitialPositionSettled,
}: {
  items: FlatItem[]
  newDividerBefore?: string
  initialScrollReady: boolean
  positionDataState?: MessagePositionState
  messageWindow?: object
  active?: boolean
  positioningActive?: boolean
  scrollToMessageId?: string | null
  initialPositionMessageId?: string | null
  positionEntry?: object | null
  positionScope?: VirtualListPositionScope
  onScrollTargetPositioned?: (id: string) => void
  onScrollTargetCancelled?: (id: string) => void
  hasMoreOlder?: boolean
  hasMoreNewer?: boolean
  isFetchingOlder?: boolean
  isFetchingNewer?: boolean
  presentVersion?: number
  presentRequest?: MessageRequest | null
  localSubmitVersion?: number
  tailPaddingEnd?: number
  onInitialPositionSettled?: (outcome: PositionOutcome) => void
}) {
  type Kind = "initial" | "late-new" | "target" | "present" | "idle"
  type Intent = {
    epoch: number
    type: "unread" | "target" | "end" | "restore"
    id: string | null
    index: number | null
    behavior: ScrollBehavior
    notifyTarget: boolean
    loadedTailPresent: boolean
    awaitingData: boolean
    viewport: { width: number; height: number }
    issued: boolean
    origin: { root: HTMLDivElement | null; offset: number } | null
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
  const fingerprint = useMemo(() => virtualListLayoutFingerprint(items), [items])
  const [initialSnapshot] = useState(() => scrollToMessageId ? null : readVirtualListPosition(positionScope, fingerprint))
  const restorationRef = useRef(initialSnapshot)
  const snapshotContextRef = useRef({ scope: positionScope, fingerprint })
  const virtualizerRef = useRef<ReactVirtualizer<HTMLDivElement, Element> | null>(null)
  const positionOwnerRef = useRef({ epoch: 0, active: true })
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden")
  const visible = positioningActive && documentVisible
  const entryActivationRef = useRef({ entry: positionEntry, seen: visible })
  const dataState = positionDataState ?? (initialScrollReady ? items.some(item => item.kind === "message") ? "ready" : "empty" : "pending")
  const contextRef = useRef({ dataState, initialScrollReady, messageWindow, isFetchingOlder, isFetchingNewer, visible, newDividerBefore })
  const [requestRevision, setRequestRevision] = useState(0)
  const [committedEntry, setCommittedEntry] = useState(positionEntry)
  const entryChanged = committedEntry !== positionEntry
  const positionKind = useCreateAtom<Kind>("initial")
  const [ownerKind, setOwnerKind] = useAtom(positionKind)
  const nativeOrigin = useCreateAtom<string | number | bigint | null>(null)
  const [nativeOriginKey, setNativeOriginKey] = useAtom(nativeOrigin)
  const readReady = useCreateAtom(false)
  const [readPositionReady, setReadPositionReady] = useAtom(readReady)
  const [resumeValidated, setResumeValidated] = useState(true)
  const [shortGap, setShortGap] = useAtom(useCreateAtom(initialSnapshot?.paddingStart ?? 0))
  const presentation = useCreateAtom<PositionOutcome>("pending")
  const [positionOutcome, setPositionOutcome] = useAtom(presentation)
  const [paginationDirection, setPaginationDirection] = useAtom(useCreateAtom<"older" | "newer" | null>(null))
  const paginationRef = useRef<{
    direction: "older" | "newer"
    phase: "pending" | "fetching" | "settling"
    receipt?: { result?: MessageRequestResult; before?: object }
    anchor?: { key: string; viewportOffset: number; bodyInset: number; header: boolean; firstKey: string; epoch: number }
  } | null>(null)
  const scrollPaddingStartRef = useRef(0)
  const olderMeasurementAnchorRef = useRef<{ key: string; epoch: number } | null>(null)
  const entryResolvedRef = useRef(false)
  const initialRetiredRef = useRef(false)
  const lateNewRef = useRef({ allowed: true, consumed: false })
  const initialSettleFrameRef = useRef<number | null>(null)
  const semanticIntentRef = useRef<Intent | null>(null)
  const committedRowsRef = useRef<{
    layout: VirtualRowsLayoutSnapshot
    native: ReactVirtualizer<HTMLDivElement, Element>
    entry: typeof positionEntry
    items: FlatItem[]
  } | null>(null)
  const targetIntentRef = useRef<string | null>(null)
  const positionedTargetRef = useRef<string | null>(null)
  const presentIntentRef = useRef<{ epoch: number; allowAttachedTail: boolean; fetching: boolean; receipt?: { result?: MessageRequestResult; before?: object } } | null>(null)
  const consumedPresentVersionRef = useRef(presentVersion ?? 0)
  const consumedLocalSubmitVersionRef = useRef(localSubmitVersion ?? 0)
  const currentItemsRef = useRef(items)
  const positionEntryRef = useRef(positionEntry)
  const onTargetPositionedRef = useRef(onScrollTargetPositioned)
  const onTargetCancelledRef = useRef(onScrollTargetCancelled)
  const settleCallbackRef = useRef(onInitialPositionSettled)
  useLayoutEffect(() => {
    if (entryActivationRef.current.entry !== positionEntry) entryActivationRef.current = { entry: positionEntry, seen: visible }
    else if (visible) entryActivationRef.current.seen = true
    currentItemsRef.current = items
    positionEntryRef.current = positionEntry
    onTargetPositionedRef.current = onScrollTargetPositioned
    onTargetCancelledRef.current = onScrollTargetCancelled
    settleCallbackRef.current = onInitialPositionSettled
    contextRef.current = { dataState, initialScrollReady, messageWindow, isFetchingOlder, isFetchingNewer, visible, newDividerBefore }
    snapshotContextRef.current = { scope: positionScope, fingerprint }
  }, [items, positionEntry, positionScope, fingerprint, initialScrollReady, newDividerBefore, onScrollTargetPositioned, onScrollTargetCancelled, onInitialPositionSettled, dataState, messageWindow, isFetchingOlder, isFetchingNewer, visible])
  const followSuspension = useCreateAtom(false)
  const [followSuspended, setFollowSuspended] = useAtom(followSuspension)
  const acceptedGeometryRef = useRef<Geometry | null>(null)
  const savedPositionRef = useRef<{ scope: VirtualListPositionScope; fingerprint: string; geometry: Geometry } | null>(null)
  const geometryFrameRef = useRef<number | null>(null)
  const scheduleGeometryRef = useRef<() => void>(() => {})
  const reconcileViewportRef = useRef<() => void>(() => {})
  const userInputRef = useRef({ touch: false, pointers: new Set<number>(), handover: false })
  const hasMessages = items.some(item => item.kind === "message")
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
  const settlePresentation = useCallback((outcome: PositionOutcome = "success") => {
    if (!positionOwnerRef.current.active || presentation.get() !== "pending") return
    setPositionOutcome(outcome)
    settleCallbackRef.current?.(outcome)
  }, [presentation, setPositionOutcome])
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
    if (kind === "target" || kind === "present") lateNewRef.current.allowed = false
    const owner = positionOwnerRef.current
    virtualizerRef.current?.cancelScroll()
    clearOlderMeasurementAnchor()
    scrollPaddingStartRef.current = 0
    paginationRef.current = null
    setPaginationDirection(null)
    owner.epoch += 1
    setOwnerKind(kind)
    cancelFrame()
    semanticIntentRef.current = null
    acceptedGeometryRef.current = null
    holdNativeOrigin(null)
    presentIntentRef.current = null
    setReadPositionReady(false)
    return owner.epoch
  }, [cancelFrame, clearOlderMeasurementAnchor, holdNativeOrigin, setOwnerKind, setPaginationDirection, setReadPositionReady])
  const retireInitialPosition = useCallback(() => {
    initialRetiredRef.current = true
    entryResolvedRef.current = true
  }, [])
  const releasePosition = useCallback((userHandover = false, outcome: PositionOutcome = userHandover ? "user-cancelled" : "cancelled") => {
    lateNewRef.current.allowed = false
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
    settlePresentation(outcome)
    scheduleGeometryRef.current()
  }, [claimPosition, positionKind, readReady, retireInitialPosition, setReadPositionReady, settlePresentation])
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
  const pendingLateNew = visible && initialScrollReady && !!newDividerBefore && entryResolvedRef.current
    && lateNewRef.current.allowed && !lateNewRef.current.consumed && (ownerKind === "idle" || ownerKind === "initial")
  const getItemKey = useCallback((index: number) => items[index].key, [items])
  const estimateSize = useCallback((index: number) => estimateRowHeight(items[index], !!hasMoreOlder), [items, hasMoreOlder])
  // eslint-disable-next-line react-hooks/incompatible-library -- supported TanStack Virtual imperative adapter
  const virtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    directDomUpdates: false,
    useFlushSync: true,
    initialRect: initialSnapshot ? { width: initialSnapshot.width, height: initialSnapshot.height }
      : { width: 0, height: items.reduce((size, item) => size + estimateRowHeight(item, !!hasMoreOlder), shortGap + tailPaddingEnd) },
    initialOffset: initialSnapshot?.offset ?? 0,
    initialMeasurementsCache: initialSnapshot?.measurements ?? [],
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    useCachedMeasurements: !visible,
    measureElement: (element, entry, instance) => {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return measureElement(element, entry, instance)
      return element.querySelector("[data-msg-id]") ? measureMessageRow(element)
        : Math.round(entry?.borderBoxSize?.[0]?.blockSize ?? rect.height)
    },
    getItemKey,
    scrollPaddingStart: scrollPaddingStartRef.current,
    anchorTo: !entryChanged && ownerKind === "idle" && !awaitingTarget && !pendingLocalSubmit && !pendingLateNew
      && (paginationDirection !== null || (readPositionReady && (nativeOriginKey === null || nativeOriginKey !== items[0]?.key))) ? "end" : "start",
    followOnAppend: visible && !entryChanged && ownerKind === "idle" && readPositionReady && dataState === "ready" && !awaitingTarget
      && !pendingLocalSubmit && !pendingLateNew && !followSuspended && !hasMoreNewer
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
    if (!owner.active || !root || !root.isConnected || !native || root.clientHeight <= 0 || root.clientWidth <= 0
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
  const savePosition = useCallback((geometry: Geometry) => {
    const { scope, fingerprint: currentFingerprint } = snapshotContextRef.current
    const native = virtualizerRef.current
    const committed = committedRowsRef.current
    if (!scope || !native || !positionOwnerRef.current.active || !contextRef.current.visible
      || positionKind.get() !== "idle" || geometry.epoch !== positionOwnerRef.current.epoch
      || geometry.isScrolling || paginationRef.current || contextRef.current.dataState === "error"
      || committed?.items !== currentItemsRef.current || committed.layout.totalSize !== native.getTotalSize()
      || native.options.count !== currentItemsRef.current.length
      || currentItemsRef.current.some((item, index) => native.options.getItemKey(index) !== item.key)) return
    const previous = savedPositionRef.current
    if (previous?.scope === scope && previous.fingerprint === currentFingerprint
      && previous.geometry.scrollTop === geometry.scrollTop && previous.geometry.total === geometry.total
      && previous.geometry.clientWidth === geometry.clientWidth && previous.geometry.clientHeight === geometry.clientHeight) return
    saveVirtualListPosition(scope, {
      version: 1, fingerprint: currentFingerprint, offset: geometry.scrollTop,
      width: geometry.clientWidth, height: geometry.clientHeight,
      paddingStart: native.options.paddingStart ?? 0, paddingEnd: geometry.paddingEnd,
      anchorKey: geometry.key, anchorOffset: geometry.itemStart - geometry.scrollTop,
      measurements: native.takeSnapshot(), at: Date.now(),
    })
    savedPositionRef.current = { scope, fingerprint: currentFingerprint, geometry }
  }, [positionKind])
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
      if (intent.type === "unread" && contextRef.current.newDividerBefore !== intent.id) {
        releasePosition()
        return
      }
      const index = intent.type === "end" ? currentItemsRef.current.length - 1
        : intent.type === "restore" ? currentItemsRef.current.findIndex(item => item.key === intent.id)
          : intent.id ? intent.type === "unread" ? findMountScrollTargetIndex(currentItemsRef.current, intent.id)
            : findMessageIndex(currentItemsRef.current, intent.id) : null
      if (index === null || index < 0) {
        if (intent.type !== "end" && contextRef.current.dataState === "ready") releasePosition()
        return
      }
      if ((positionKind.get() === "initial" || positionKind.get() === "late-new") && !contextRef.current.initialScrollReady) return
      const committed = committedRowsRef.current
      if (!intent.issued) {
        if (intent.origin && (intent.origin.root !== root || Math.abs(root.scrollTop - intent.origin.offset) > 1)) {
          releasePosition(true)
          return
        }
        const layout = committed?.layout
        const rect = native.scrollRect
        const rows = native.getVirtualItems()
        const matches = committed?.native === native && committed.entry === positionEntryRef.current
          && committed.items === currentItemsRef.current && native.scrollElement === root && root.isConnected
          && layout && rect && root.clientHeight > 0 && root.clientWidth > 0
          && rect.width === root.clientWidth && rect.height === root.clientHeight
          && layout.totalSize === native.getTotalSize() && layout.scrollMargin === native.options.scrollMargin
          && layout.rows.length === rows.length && rows.length > 0
          && layout.rows.every((row, index) => {
            const current = rows[index]
            return row.key === current.key && row.index === current.index
              && row.start === current.start && row.size === current.size
              && row.end === current.end && row.lane === current.lane
          })
        if (!matches) return
        if (intent.type === "end") native.scrollToEnd({ behavior: intent.behavior })
        else {
          intent.index = index
          native.scrollToIndex(index, { align: intent.type === "restore" ? "start" : "center", behavior: intent.behavior })
        }
        intent.issued = true
        intent.origin = null
      }
      const viewport = root.getBoundingClientRect()
      if (root.clientHeight <= 0 || root.clientWidth <= 0 || viewport.height <= 0 || viewport.width <= 0) return
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
      } else if (intent.type === "restore") {
        if (index !== intent.index) {
          intent.index = index
          native.scrollToIndex(index, { align: "start", behavior: intent.behavior })
        }
        const targetOffset = native.getOffsetForIndex(index, "start")?.[0]
        landed = targetOffset !== undefined && Math.abs(root.scrollTop - targetOffset) <= 1 && readGeometry() !== null
      } else if (intent.id) {
        if (index !== intent.index) {
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
          const targetOffset = native.getOffsetForIndex(index, "center")?.[0]
          landed = targetOffset !== undefined && Math.abs(root.scrollTop - targetOffset) <= 1
            && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
            && body.bottom > viewport.top + 1 && body.top < viewport.bottom - 1
        }
      }
      if (landed) {
        const initial = positionKind.get() === "initial" || positionKind.get() === "late-new"
        if (initial && contextRef.current.dataState === "pending") setFollowSuspended(true)
        const geometry = readGeometry()
        if (!geometry) return
        if (intent.type !== "end" && root.scrollTop <= 1) holdNativeOrigin(currentItemsRef.current[0]?.key ?? null)
        settlePresentation()
        if (!initial && contextRef.current.dataState === "pending") return
        acceptedGeometryRef.current = geometry
        if (intent.type === "restore") {
          native.cancelScroll()
          scrollPaddingStartRef.current = 0
          native.setOptions({ ...native.options, scrollPaddingStart: 0 })
        }
        semanticIntentRef.current = null
        setOwnerKind("idle")
        setReadPositionReady(true)
        setResumeValidated(true)
        retireInitialPosition()
        if (intent.notifyTarget && intent.id) {
          positionedTargetRef.current = intent.id
          onTargetPositionedRef.current?.(intent.id)
        }
        scheduleGeometryRef.current()
        return
      }
    }
    initialSettleFrameRef.current = window.requestAnimationFrame(settle)
  }, [holdNativeOrigin, positionKind, readGeometry, releasePosition, retireInitialPosition, setFollowSuspended, setOwnerKind, setReadPositionReady, settlePresentation])

  const onRowsLayoutCommit = useCallback((layout: VirtualRowsLayoutSnapshot | null) => {
    committedRowsRef.current = layout ? { layout, native: virtualizer, entry: positionEntry, items } : null
    if (layout && positionOwnerRef.current.active && semanticIntentRef.current) scheduleInitialPositionSettled()
  }, [items, positionEntry, scheduleInitialPositionSettled, virtualizer])

  const startIntent = useCallback((type: Intent["type"], id: string | null, behavior: ScrollBehavior = "auto", notifyTarget = false, loadedTailPresent = false) => {
    const owner = positionOwnerRef.current
    if (!owner.active || !contextRef.current.visible) return
    const index = type === "restore" ? currentItemsRef.current.findIndex(item => item.key === id)
      : type === "end" ? currentItemsRef.current.length - 1
      : id ? type === "unread" ? findMountScrollTargetIndex(currentItemsRef.current, id)
        : findMessageIndex(currentItemsRef.current, id) : null
    semanticIntentRef.current = {
      epoch: owner.epoch, type, id, index, behavior, notifyTarget, loadedTailPresent,
      awaitingData: positionKind.get() === "initial" || positionKind.get() === "late-new" ? !contextRef.current.initialScrollReady : contextRef.current.dataState === "pending",
      viewport: { width: scrollRef.current?.clientWidth ?? 0, height: scrollRef.current?.clientHeight ?? 0 },
      issued: false,
      origin: positionKind.get() === "initial" && type !== "restore" && !initialSnapshot ? { root: scrollRef.current, offset: scrollRef.current?.scrollTop ?? 0 } : null,
    }
    if (semanticIntentRef.current.awaitingData) return
    if (type === "end" && loadedTailPresent) {
      virtualizerRef.current?.scrollToEnd({ behavior })
      semanticIntentRef.current.issued = true
    }
    if (type === "restore" && restorationRef.current) {
      scrollPaddingStartRef.current = restorationRef.current.anchorOffset
      const native = virtualizerRef.current
      if (native) native.setOptions({ ...native.options, scrollPaddingStart: scrollPaddingStartRef.current })
    }
    scheduleInitialPositionSettled()
  }, [initialSnapshot, positionKind, scheduleInitialPositionSettled])

  useLayoutEffect(() => {
    const owner = positionOwnerRef.current
    owner.active = true
    const intent = semanticIntentRef.current
    if (intent && intent.epoch !== owner.epoch) {
      intent.epoch = owner.epoch
      startIntent(intent.type, intent.id, intent.behavior, intent.notifyTarget, intent.loadedTailPresent)
    } else if (positionKind.get() === "present" && presentIntentRef.current !== null) {
      presentIntentRef.current.epoch = owner.epoch
    }
    if (acceptedGeometryRef.current) acceptedGeometryRef.current.epoch = owner.epoch
    return () => {
      owner.active = false
      owner.epoch += 1
      virtualizerRef.current?.cancelScroll()
      clearOlderMeasurementAnchor()
      paginationRef.current = null
      cancelFrame()
      if (geometryFrameRef.current !== null) window.cancelAnimationFrame(geometryFrameRef.current)
      geometryFrameRef.current = null
    }
  }, [cancelFrame, clearOlderMeasurementAnchor, positionKind, scheduleInitialPositionSettled, startIntent])

  useLayoutEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== "hidden")
    update()
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])

  useLayoutEffect(() => {
    if (!visible) {
      if (entryActivationRef.current.seen) lateNewRef.current.allowed = false
      setResumeValidated(false)
      if (entryActivationRef.current.seen && positionKind.get() !== "idle") releasePosition()
      positionOwnerRef.current.active = false
      virtualizerRef.current?.cancelScroll()
      cancelFrame()
      paginationRef.current = null
      setPaginationDirection(null)
      if (geometryFrameRef.current !== null) window.cancelAnimationFrame(geometryFrameRef.current)
      geometryFrameRef.current = null
    } else {
      positionOwnerRef.current.active = true
      if (!readReady.get() || readGeometry()) setResumeValidated(true)
      scheduleGeometryRef.current()
    }
  }, [cancelFrame, positionKind, readGeometry, readReady, releasePosition, setPaginationDirection, visible])

  useLayoutEffect(() => {
    if (committedEntry === positionEntry) return
    setCommittedEntry(() => positionEntry)
    claimPosition("initial")
    entryResolvedRef.current = false
    initialRetiredRef.current = false
    setPositionOutcome("pending")
    restorationRef.current = null
    lateNewRef.current = { allowed: true, consumed: false }
    targetIntentRef.current = null
    positionedTargetRef.current = null
    consumedPresentVersionRef.current = presentVersion ?? 0
    consumedLocalSubmitVersionRef.current = localSubmitVersion ?? 0
    userInputRef.current.handover = false
    setFollowSuspended(false)
  }, [claimPosition, committedEntry, localSubmitVersion, positionEntry, presentVersion, setFollowSuspended, setPositionOutcome])

  useLayoutEffect(() => {
    const target = scrollToMessageId ?? null
    if (!visible && target) return
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
    if (dataState === "ready" && visible) startIntent("target", target, "auto", true)
  }, [claimPosition, dataState, items.length, positionEntry, positionKind, releasePosition, retireInitialPosition, scrollToMessageId, startIntent, visible])

  useLayoutEffect(() => {
    const intent = semanticIntentRef.current
    if (visible && intent?.awaitingData && (positionKind.get() === "initial" || positionKind.get() === "late-new" ? initialScrollReady : dataState === "ready")) {
      startIntent(intent.type, intent.id, intent.behavior, intent.notifyTarget, intent.loadedTailPresent)
    }
  }, [dataState, initialScrollReady, positionKind, startIntent, visible])

  useLayoutEffect(() => {
    if (!visible || dataState !== "ready") return
    if (positionKind.get() === "target") {
      if (!semanticIntentRef.current && targetIntentRef.current) startIntent("target", targetIntentRef.current, "auto", true)
      else scheduleInitialPositionSettled()
    }
  }, [dataState, items, positionKind, scheduleInitialPositionSettled, startIntent, visible])

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
      savePosition(acceptedGeometryRef.current)
      if (readReady.get()) setResumeValidated(true)
      holdNativeOrigin(next.scrollTop <= 1 && !next.pinEligible ? currentItemsRef.current[0]?.key ?? null : null)
    }
  }, [holdNativeOrigin, positionKind, readReady, savePosition])

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
        && previous.clientWidth !== root.clientWidth && !contextRef.current.isFetchingOlder && !contextRef.current.isFetchingNewer && !paginationRef.current) {
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
      else if (readReady.get()) setResumeValidated(true)
    }
    if (paginationRef.current?.phase === "settling") {
      paginationRef.current = null
      setPaginationDirection(null)
      clearOlderMeasurementAnchor()
    }

    return false
  }, [claimPosition, clearOlderMeasurementAnchor, holdNativeOrigin, observeGeometry, positionKind, readGeometry, readReady, retireInitialPosition, setPaginationDirection, setReadPositionReady, setShortGap, startIntent])
  const reconcileViewport = useCallback(() => {
    const intent = semanticIntentRef.current
    const root = scrollRef.current
    const native = virtualizerRef.current
    if (intent && root && native && intent.epoch === positionOwnerRef.current.epoch
      && (intent.viewport.width !== root.clientWidth || intent.viewport.height !== root.clientHeight)) {
      intent.viewport = { width: root.clientWidth, height: root.clientHeight }
      intent.issued = false
      scheduleInitialPositionSettled()
    }
    if (intent) scheduleInitialPositionSettled()
    if (positionKind.get() === "idle") {
      const geometry = readGeometry()
      if (geometry) savePosition(geometry)
    }
    reconcileGeometry(true)
  }, [positionKind, readGeometry, reconcileGeometry, savePosition, scheduleInitialPositionSettled])
  const reconcileGeometryRef = useRef(reconcileGeometry)
  useLayoutEffect(() => {
    reconcileGeometryRef.current = reconcileGeometry
    reconcileViewportRef.current = reconcileViewport
  }, [reconcileGeometry, reconcileViewport])

  const scheduleGeometry = useCallback(() => {
    if (geometryFrameRef.current !== null || !positionOwnerRef.current.active) return
    const accept = () => {
      geometryFrameRef.current = null
      if (reconcileGeometryRef.current()) geometryFrameRef.current = window.requestAnimationFrame(accept)
    }
    geometryFrameRef.current = window.requestAnimationFrame(accept)
  }, [])
  useLayoutEffect(() => { scheduleGeometryRef.current = scheduleGeometry }, [scheduleGeometry])
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
      if (semanticIntentRef.current) scheduleInitialPositionSettled()
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
    const page = paginationRef.current
    setPaginationDirection(direction)
    return (request: MessageRequest | void) => {
      if (paginationRef.current !== page || !request) return
      if (!request.accepted) {
        paginationRef.current = null
        setPaginationDirection(null)
        return
      }
      const receipt: NonNullable<typeof page.receipt> = { before: contextRef.current.messageWindow }
      page.receipt = receipt
      const complete = (result: MessageRequestResult) => {
        if (!positionOwnerRef.current.active || paginationRef.current !== page) return
        receipt.result = result
        setRequestRevision(value => value + 1)
      }
      void request.completed.then(complete, () => complete({ status: "error" }))
    }
  }, [clearOlderMeasurementAnchor, positionKind, readGeometry, readPageMessageGeometry, setPaginationDirection])
  const captureOlderPageAnchor = useCallback(() => capturePageAnchor("older"), [capturePageAnchor])
  const captureNewerPageAnchor = useCallback(() => capturePageAnchor("newer"), [capturePageAnchor])
  useLayoutEffect(() => {
    const page = paginationRef.current
    if (!page || page.phase === "settling") return
    if (page.receipt) {
      const result = page.receipt.result
      if (!result) return
      if (dataState === "error" || result.status !== "success" || result.window === page.receipt.before
        || messageWindow !== result.window && messageWindow !== page.receipt.before) {
        paginationRef.current = null
        setPaginationDirection(null)
        return
      }
      if (messageWindow !== result.window || dataState === "pending") return
    } else {
      const fetching = page.direction === "older" ? isFetchingOlder : isFetchingNewer
      if (fetching) { page.phase = "fetching"; return }
      if (page.phase !== "fetching") return
    }
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
  }, [adjustOlderMeasurement, dataState, holdNativeOrigin, isFetchingNewer, isFetchingOlder, items, messageWindow, positionKind, requestRevision, scheduleGeometry, scheduleInitialPositionSettled, setPaginationDirection])

  const requestPresentPosition = useCallback((request?: MessageRequest | void) => {
    if (!positionOwnerRef.current.active || !contextRef.current.visible) return
    if (request && !request.accepted) return
    const intent: NonNullable<typeof presentIntentRef.current> = { epoch: claimPosition("present"), allowAttachedTail: false, fetching: false }
    presentIntentRef.current = intent
    retireInitialPosition()
    if (request?.accepted) {
      const receipt: NonNullable<typeof intent.receipt> = { before: contextRef.current.messageWindow }
      intent.receipt = receipt
      const complete = (result: MessageRequestResult) => {
        if (!positionOwnerRef.current.active || presentIntentRef.current !== intent || positionOwnerRef.current.epoch !== intent.epoch) return
        receipt.result = result
        setRequestRevision(value => value + 1)
      }
      void request.completed.then(complete, () => complete({ status: "error" }))
    }
  }, [claimPosition, retireInitialPosition])

  useLayoutEffect(() => {
    const version = localSubmitVersion ?? 0
    if (version === consumedLocalSubmitVersionRef.current) return
    const accepted = version > consumedLocalSubmitVersionRef.current
    consumedLocalSubmitVersionRef.current = version
    if (!accepted || !visible) return
    if ((hasMoreNewer || isFetchingNewer) && presentRequest !== undefined) {
      if (presentRequest) requestPresentPosition(presentRequest)
      else releasePosition()
      return
    }
    if (positionKind.get() === "target") releasePosition()
    const epoch = claimPosition("present")
    retireInitialPosition()
    setFollowSuspended(false)
    if (hasMessages && !hasMoreNewer && !isFetchingNewer) startIntent("end", null)
    else {
      presentIntentRef.current = { epoch, allowAttachedTail: !hasMoreNewer && !isFetchingNewer, fetching: isFetchingNewer === true }
    }
  }, [claimPosition, hasMessages, hasMoreNewer, isFetchingNewer, localSubmitVersion, positionKind, presentRequest, releasePosition, requestPresentPosition, retireInitialPosition, setFollowSuspended, startIntent, visible])

  useLayoutEffect(() => {
    const completedWindow = hasMessages && !hasMoreNewer && !isFetchingNewer
      && !!presentVersion && consumedPresentVersionRef.current !== presentVersion
    if (completedWindow) consumedPresentVersionRef.current = presentVersion
    const owner = positionOwnerRef.current
    const intent = presentIntentRef.current
    if (!owner.active || positionKind.get() !== "present" || intent?.epoch !== owner.epoch) return
    if (intent.receipt) {
      const result = intent.receipt.result
      if (!result) return
      if (result.status !== "success" || dataState === "error") { releasePosition(); return }
      if (messageWindow !== result.window && messageWindow !== intent.receipt.before) { releasePosition(); return }
      if (messageWindow !== result.window || dataState === "pending") return
      presentIntentRef.current = null
      if (dataState === "empty") {
        releasePosition()
        setReadPositionReady(true)
      } else {
        setFollowSuspended(false)
        startIntent("end", null)
      }
      return
    }
    if (dataState === "pending") return
    if (isFetchingNewer) {
      intent.fetching = true
      return
    }
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
  }, [dataState, hasMessages, hasMoreNewer, isFetchingNewer, messageWindow, positionKind, presentVersion, releasePosition, requestRevision, retireInitialPosition, setFollowSuspended, setReadPositionReady, startIntent])

  const virtualItems = virtualizer.getVirtualItems()
  useLayoutEffect(() => {
    const late = lateNewRef.current
    if (!late.allowed || late.consumed || !newDividerBefore || !entryResolvedRef.current
      || !visible || !initialScrollReady || !hasMessages
      || positionKind.get() !== "idle" && positionKind.get() !== "initial"
      || findMountScrollTargetIndex(items, newDividerBefore) === null) return
    late.consumed = true
    claimPosition("late-new")
    startIntent("unread", newDividerBefore)
  }, [claimPosition, hasMessages, initialScrollReady, items, newDividerBefore, positionEntry, positionKind, startIntent, visible])
  useLayoutEffect(() => {
    if (!visible) return
    if (dataState === "error" || dataState === "empty") {
      lateNewRef.current.allowed = false
      if (positionKind.get() === "idle") return
      releasePosition(false, dataState)
      if (dataState === "empty") setReadPositionReady(true)
      return
    }
    if (positionKind.get() === "idle") return
    if (dataState === "pending" && !initialScrollReady) return
    if (positionKind.get() !== "initial" || initialRetiredRef.current || !hasMessages) return
    if (!entryResolvedRef.current) {
      const snapshot = restorationRef.current
      const root = scrollRef.current
      if (snapshot && (!root || root.clientWidth <= 0 || root.clientHeight <= 0)) return
      entryResolvedRef.current = true
      if (newDividerBefore) lateNewRef.current.consumed = true
      if (snapshot && snapshot.fingerprint === fingerprint && snapshot.width === root?.clientWidth
        && snapshot.height === root.clientHeight && snapshot.paddingEnd === tailPaddingEnd
        && items.some(item => item.key === snapshot.anchorKey)) startIntent("restore", String(snapshot.anchorKey))
      else {
        if (snapshot) {
          restorationRef.current = null
          virtualizer.setOptions({ ...virtualizer.options, initialMeasurementsCache: [] })
          virtualizer.measure()
          scrollRef.current?.querySelectorAll<HTMLElement>("[data-index]").forEach(element => virtualizer.measureElement(element))
        }
        startIntent(initialPositionMessageId ? "target" : newDividerBefore ? "unread" : "end", initialPositionMessageId ?? newDividerBefore ?? null)
      }
    } else scheduleInitialPositionSettled()
  }, [dataState, fingerprint, hasMessages, initialPositionMessageId, initialScrollReady, items, newDividerBefore, positionEntry, positionKind, releasePosition, scheduleInitialPositionSettled, setReadPositionReady, startIntent, tailPaddingEnd, virtualItems, virtualizer, visible])

  const scrollToBottom = useCallback(() => {
    if (!positionOwnerRef.current.active || !contextRef.current.visible) return
    claimPosition("present")
    retireInitialPosition()
    setFollowSuspended(false)
    startIntent("end", null, "auto", false, true)
  }, [claimPosition, retireInitialPosition, setFollowSuspended, startIntent])
  const jumpTo = useCallback((messageId: string, behavior: ScrollBehavior = "smooth") => {
    if (!positionOwnerRef.current.active || !contextRef.current.visible) return
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
  const pageReceipt = paginationRef.current?.receipt
  const paginationRequestPending = !!pageReceipt && (!pageReceipt.result || pageReceipt.result.status === "success" && messageWindow !== pageReceipt.result.window)
  return {
    scrollRef, virtualizer, onRowsLayoutCommit, readPositionReady: active && visible && dataState !== "pending" && dataState !== "error" && resumeValidated && !entryChanged && readPositionReady, paginationEnabled: active && visible && dataState !== "pending" && dataState !== "error" && !entryChanged && ownerKind === "idle" && !awaitingTarget, belowCount,
    paginationRequestPending,
    positionOutcome,
    scrollToBottom, requestPresentPosition, jumpTo,
    captureOlderPageAnchor, captureNewerPageAnchor,
  }
}
