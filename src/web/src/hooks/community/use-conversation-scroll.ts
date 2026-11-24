import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import type { VirtualItem } from "@tanstack/react-virtual"
import { computeBelowCount, type FlatItem } from "@/lib/community/message-list-items"
import { CONVERSATION_TAIL_SPACE_PX, MESSAGE_RAIL_TAIL_PADDING_END_PX } from "@/lib/community/conversation-layout"
import type { MessagePositionState, MessageRequest, MessageRequestResult, NewPositionRequest, NewPositionResult } from "@/lib/community/message-position"
import type { ConversationListScope } from "@/lib/community/conversation-qualification"
import { withConversationReadDeadline } from "@/lib/community/conversation-read"
import { messageScrollBehavior } from "@/lib/community/message-scroll-behavior"

export type PositionOutcome = "pending" | "success" | "user-cancelled" | "cancelled" | "empty" | "error"
type ViewportResizeAnchor = "tail" | "start"
type NewDividerVisibility = "above" | "visible" | "below" | "pending"

export type ConversationScrollState =
  | { mode: "pinned-to-bottom" }
  | { mode: "reading-history"; anchorId: string | null; anchorKey: string | null; viewportOffset: number; firstMessageKey: string | null }
  | { mode: "jumping-to-target"; kind: "message" | "new" | "present"; targetId: string | null; align: "center" | "start" | "end"; behavior: ScrollBehavior; notifyTarget: boolean }

export interface ResolveViewportResizeAnchorInput {
  previousClientHeight: number
  nextClientHeight: number
  previousScrollHeight: number
  nextScrollHeight: number
  previousScrollTop: number
  atBottom?: boolean
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
  atBottom = false,
}: ResolveViewportResizeAnchorInput): ViewportResizeAnchorResult {
  const distanceToEnd = Math.max(0, previousScrollHeight - previousClientHeight - previousScrollTop)
  const viewportGrowth = Math.max(0, nextClientHeight - previousClientHeight)
  const anchor: ViewportResizeAnchor = atBottom || distanceToEnd <= Math.max(CONVERSATION_TAIL_SPACE_PX, viewportGrowth)
    ? "tail"
    : "start"
  const maxScrollTop = Math.max(0, nextScrollHeight - nextClientHeight)
  const requestedScrollTop = anchor === "tail" ? maxScrollTop - distanceToEnd : previousScrollTop
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

function firstMessageKeyOf(items: FlatItem[]): string | null {
  return items.find((item) => item.kind === "message")?.key ?? null
}

function clampScrollTop(root: HTMLElement, value: number): number {
  const max = Math.max(0, root.scrollHeight - root.clientHeight)
  return Math.max(0, Math.min(value, max))
}

function distanceFromEnd(root: HTMLElement): number {
  return Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop)
}

const EMPTY_VIRTUAL_ITEMS: VirtualItem[] = []

function escapeAttrValue(value: string): string {
  return value.replace(/["\\\n\r\f]/g, "\\$&")
}

function findMessageBody(root: HTMLElement, messageId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-msg-id="${escapeAttrValue(messageId)}"]`)
}

function findRowByKey(root: HTMLElement, key: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-message-row-key="${escapeAttrValue(key)}"]`)
}

function findNewDivider(root: HTMLElement, messageId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-message-divider-for="${escapeAttrValue(messageId)}"] [data-new-divider]`)
}

function findMessageRowsContainer(root: HTMLElement): HTMLElement | null {
  const content = root.firstElementChild as HTMLElement | null
  const rows = content?.firstElementChild as HTMLElement | null
  if (rows?.hasAttribute("data-message-rows")) return rows
  return root.querySelector<HTMLElement>("[data-message-rows]")
}

function rowMessageBody(wrapper: HTMLElement): HTMLElement | null {
  const row = wrapper.firstElementChild as HTMLElement | null
  if (!row) return null
  const candidate = row.firstElementChild as HTMLElement | null
  if (candidate?.hasAttribute("data-msg-id")) return candidate
  const key = row.dataset.messageRowKey
  if (key && (key.startsWith("rail:") || key.startsWith("date:") || key.startsWith("new:") || key.startsWith("divider:"))) {
    return null
  }
  return wrapper.querySelector<HTMLElement>("[data-msg-id]")
}

function messageContentBounds(element: HTMLElement | null) {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (rect.height <= 0) return null
  const overflow = window.getComputedStyle(element).overflowY
  const height = overflow === "visible" || overflow === "" ? measureMessageRow(element) : rect.height
  return { top: rect.top, bottom: rect.top + height, height }
}

function computeLoadedBelowCount(items: FlatItem[], root: HTMLDivElement | null, viewportInsetEnd: number): number {
  if (!root || root.clientHeight <= 0 || items.length === 0) return 0
  if (distanceFromEnd(root) <= CONVERSATION_TAIL_SPACE_PX) return 0
  const viewportBottom = root.getBoundingClientRect().bottom - viewportInsetEnd
  const rowsEl = findMessageRowsContainer(root)
  if (rowsEl && rowsEl.children.length > 0) {
    const children = rowsEl.children
    let itemCount = children.length
    while (itemCount > 0 && !(children[itemCount - 1] as HTMLElement).hasAttribute("data-index")) {
      itemCount -= 1
    }
    let lo = 0
    let hi = itemCount - 1
    let lastIndex = -1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const wrapper = children[mid] as HTMLElement
      const rect = wrapper.getBoundingClientRect()
      if (rect.top < viewportBottom - 0.5) {
        lastIndex = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    while (lastIndex >= 0) {
      const wrapper = children[lastIndex] as HTMLElement
      if (!wrapper.hasAttribute("data-index")) {
        lastIndex -= 1
        continue
      }
      const rect = wrapper.getBoundingClientRect()
      if (rect.height > 0 && rect.top < viewportBottom - 0.5) {
        const idx = Number(wrapper.dataset.index)
        return computeBelowCount(items, Number.isInteger(idx) ? idx : lastIndex)
      }
      lastIndex -= 1
    }
    return computeBelowCount(items, -1)
  }
  let lastVisibleIndex = -1
  for (const wrapper of root.querySelectorAll<HTMLElement>("[data-index]")) {
    const rect = wrapper.getBoundingClientRect()
    if (rect.height <= 0) continue
    if (rect.top < viewportBottom - 0.5) {
      const idx = Number(wrapper.dataset.index)
      if (Number.isInteger(idx) && idx > lastVisibleIndex) lastVisibleIndex = idx
    }
  }
  return computeBelowCount(items, lastVisibleIndex)
}

function captureVisibleAnchor(root: HTMLDivElement | null, items: FlatItem[], viewportInsetEnd: number) {
  if (!root || root.clientHeight <= 0) return null
  const viewport = root.getBoundingClientRect()
  const firstMessageKey = firstMessageKeyOf(items)
  const rowsEl = findMessageRowsContainer(root)
  if (rowsEl && rowsEl.children.length > 0) {
    const children = rowsEl.children
    let itemCount = children.length
    while (itemCount > 0 && !(children[itemCount - 1] as HTMLElement).hasAttribute("data-index")) {
      itemCount -= 1
    }
    let lo = 0
    let hi = itemCount - 1
    let firstCandidate = itemCount
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const wrapper = children[mid] as HTMLElement
      if (wrapper.getBoundingClientRect().bottom > viewport.top) {
        firstCandidate = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    const startIndex = Math.max(0, firstCandidate - 2)
    let fallback: {
      anchorId: string
      anchorKey: string | null
      viewportOffset: number
      firstMessageKey: string | null
    } | null = null
    for (let i = startIndex; i < itemCount; i++) {
      const wrapper = children[i] as HTMLElement
      const body = rowMessageBody(wrapper)
      const id = body?.dataset.msgId
      if (!id) continue
      const bounds = messageContentBounds(body)
      if (!bounds) continue
      const rawIdx = Number(wrapper.dataset.index)
      const idx = Number.isInteger(rawIdx) && items[rawIdx]?.kind === "message" && items[rawIdx].m.id === id
        ? rawIdx
        : findMessageIndex(items, id)
      if (bounds.bottom > viewport.top + 1 && bounds.top < viewport.bottom - viewportInsetEnd - 1) {
        return {
          anchorId: id,
          anchorKey: idx !== null ? items[idx].key : null,
          viewportOffset: bounds.top - viewport.top,
          firstMessageKey,
        }
      }
      if (!fallback && bounds.bottom > viewport.top) {
        fallback = {
          anchorId: id,
          anchorKey: idx !== null ? items[idx].key : null,
          viewportOffset: bounds.top - viewport.top,
          firstMessageKey,
        }
      }
      if (bounds.top >= viewport.bottom - viewportInsetEnd - 1) {
        break
      }
    }
    return fallback
  }
  for (const body of root.querySelectorAll<HTMLElement>("[data-msg-id]")) {
    const id = body.dataset.msgId
    if (!id) continue
    const bounds = messageContentBounds(body)
    if (!bounds) continue
    if (bounds.bottom > viewport.top + 1 && bounds.top < viewport.bottom - viewportInsetEnd - 1) {
      const idx = findMessageIndex(items, id)
      return {
        anchorId: id,
        anchorKey: idx !== null ? items[idx].key : null,
        viewportOffset: bounds.top - viewport.top,
        firstMessageKey,
      }
    }
  }
  for (const body of root.querySelectorAll<HTMLElement>("[data-msg-id]")) {
    const id = body.dataset.msgId
    if (!id) continue
    const bounds = messageContentBounds(body)
    if (!bounds) continue
    if (bounds.bottom > viewport.top) {
      const idx = findMessageIndex(items, id)
      return {
        anchorId: id,
        anchorKey: idx !== null ? items[idx].key : null,
        viewportOffset: bounds.top - viewport.top,
        firstMessageKey,
      }
    }
  }
  return null
}

function computeTargetScrollTop(
  root: HTMLDivElement,
  kind: "message" | "new" | "present",
  targetId: string | null,
  align: "center" | "start" | "end",
  viewportInsetEnd: number,
): { top: number; targetEl: HTMLElement | null } | null {
  if (kind === "present" || align === "end") {
    return { top: Math.max(0, root.scrollHeight - root.clientHeight), targetEl: null }
  }
  if (!targetId) return null
  const body = findMessageBody(root, targetId)
  const targetEl = kind === "new" ? (findNewDivider(root, targetId) ?? body) : body
  if (!targetEl) return null
  const rootRect = root.getBoundingClientRect()
  const rect = targetEl.getBoundingClientRect()
  if (rect.height <= 0 || root.clientHeight <= 0) return null
  const absTop = root.scrollTop + (rect.top - rootRect.top)
  if (align === "start") {
    return { top: clampScrollTop(root, absTop), targetEl }
  }
  const usableHeight = Math.max(1, root.clientHeight - viewportInsetEnd)
  const centered = absTop - (usableHeight - rect.height) / 2
  return { top: clampScrollTop(root, centered), targetEl }
}

type PaginationState = {
  direction: "older" | "newer"
  beforeRows: object
  fillingViewport?: boolean
  pinTail?: boolean
  fetchingSeen: boolean
  receipt?: { result?: MessageRequestResult; before?: object }
}

type NewOperation = {
  epoch: number
  id: string
  priorTarget: string | null
  loaded: boolean
  window?: object
  wasPinned: boolean
  wasFollowSuspended: boolean
  cancel?: () => void
  finish: (result: NewPositionResult) => void
}

type PresentOperation = {
  epoch: number
  userInitiated: boolean
  allowAttachedTail: boolean
  fetchingSeen: boolean
  receipt?: { result?: MessageRequestResult; before?: object }
}

type ScrollUiState = {
  committedEntry: object | null | undefined
  positionOutcome: PositionOutcome
  readReady: boolean
  resumeValidated: boolean
  paginationDirection: "older" | "newer" | null
  newDividerVisibility: NewDividerVisibility
  stateRevision: number
  requestRevision: number
  mode: ConversationScrollState["mode"]
  pendingReadReady: boolean
  positionedTarget: string | null
  followSuspended: boolean
  followingTail: boolean
  readingTail: boolean
  belowCount: number
}

function subscribeDocumentVisibility(onStoreChange: () => void) {
  if (typeof document === "undefined") return () => {}
  document.addEventListener("visibilitychange", onStoreChange)
  return () => document.removeEventListener("visibilitychange", onStoreChange)
}

function getDocumentVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden"
}

function getServerDocumentVisible() {
  return true
}

export function useConversationScroll({
  items,
  messageRows,
  newDividerBefore,
  newDividerSeq,
  initialScrollReady,
  preserveInitialPresentation = false,
  positionDataState,
  targetPositionDataState,
  messageWindow,
  active = true,
  positioningActive = active,
  scrollToMessageId,
  initialPositionMessageId,
  positionEntry,
  positionScope,
  onScrollTargetPositioned,
  onScrollTargetCancelled,
  hasMoreNewer,
  isFetchingOlder,
  isFetchingNewer,
  presentVersion,
  presentRequest,
  presentPending,
  onJumpToPresent,
  localSubmitVersion,
  tailPaddingEnd = MESSAGE_RAIL_TAIL_PADDING_END_PX,
  viewportInsetEnd = 0,
  onInitialPositionSettled,
  onUserTakeover,
  newBoundaryOwner,
  onNewBoundaryReached,
  onReadingMessage,
}: {
  items: FlatItem[]
  messageRows?: object
  newDividerBefore?: string
  newDividerSeq?: number
  initialScrollReady: boolean
  preserveInitialPresentation?: boolean
  positionDataState?: MessagePositionState
  targetPositionDataState?: MessagePositionState
  messageWindow?: object
  active?: boolean
  positioningActive?: boolean
  scrollToMessageId?: string | null
  initialPositionMessageId?: string | null
  positionEntry?: object | null
  positionScope?: ConversationListScope
  onScrollTargetPositioned?: (id: string) => void
  onScrollTargetCancelled?: (id: string) => void
  hasMoreOlder?: boolean
  hasMoreNewer?: boolean
  isFetchingOlder?: boolean
  isFetchingNewer?: boolean
  presentVersion?: number
  presentRequest?: MessageRequest | null
  presentPending?: boolean
  onJumpToPresent?: () => MessageRequest | void
  localSubmitVersion?: number
  tailPaddingEnd?: number
  viewportInsetEnd?: number
  onInitialPositionSettled?: (outcome: PositionOutcome) => void
  onUserTakeover?: () => void
  newBoundaryOwner?: object
  onNewBoundaryReached?: (boundary: { id: string; entry: object | null | undefined; owner: object | undefined; epoch: number }) => void
  onReadingMessage?: (messageId: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const documentVisible = useSyncExternalStore(subscribeDocumentVisibility, getDocumentVisible, getServerDocumentVisible)
  const visible = positioningActive && documentVisible

  const hasMessages = items.some((item) => item.kind === "message")
  const dataState: MessagePositionState = positionDataState ?? (initialScrollReady ? (hasMessages ? "ready" : "empty") : "pending")
  const targetDataState: MessagePositionState = targetPositionDataState ?? dataState
  const tailMessageKey = items.findLast((item) => item.kind === "message")?.key

  const [uiStore] = useState(() => createStore<ScrollUiState>({
    committedEntry: positionEntry,
    positionOutcome: "pending",
    readReady: false,
    resumeValidated: true,
    paginationDirection: null,
    newDividerVisibility: "pending",
    stateRevision: 0,
    requestRevision: 0,
    mode: "pinned-to-bottom",
    pendingReadReady: false,
    positionedTarget: null,
    followSuspended: false,
    followingTail: true,
    readingTail: true,
    belowCount: 0,
  }))
  const ui = useSelector(uiStore, (state) => state)
  const committedEntry = ui.committedEntry
  const entryChanged = committedEntry !== positionEntry
  const positionOutcome = ui.positionOutcome
  const readReady = ui.readReady
  const resumeValidated = ui.resumeValidated
  const paginationDirection = ui.paginationDirection
  const newDividerVisibility = ui.newDividerVisibility
  const stateRevision = ui.stateRevision
  const requestRevision = ui.requestRevision

  const stateRef = useRef<ConversationScrollState>({ mode: "pinned-to-bottom" })
  const epochRef = useRef(0)
  const manualOriginEpochRef = useRef<number | null>(null)
  const presentOriginEpochRef = useRef<number | null>(null)
  const initialSettledRef = useRef(false)
  const entryResolvedRef = useRef(false)
  const pendingReadReadyRef = useRef(false)
  const followSuspendedRef = useRef(false)
  const readingNewRef = useRef(false)
  const followingTailRef = useRef(true)
  const readingTailRef = useRef(true)
  const upwardIntentRef = useRef(false)
  const suspendedTailRef = useRef<{ epoch: number; entry: typeof positionEntry; root: HTMLDivElement } | null>(null)
  const targetIntentRef = useRef<string | null>(null)
  const positionedTargetRef = useRef<string | null>(null)
  const presentOpRef = useRef<PresentOperation | null>(null)
  const newOpRef = useRef<NewOperation | null>(null)
  const paginationRef = useRef<PaginationState | null>(null)
  const olderFillRetiredRef = useRef(false)
  const consumedPresentVersionRef = useRef(presentVersion ?? 0)
  const consumedLocalSubmitVersionRef = useRef(localSubmitVersion ?? 0)
  const prevTailKeyRef = useRef<string | undefined>(tailMessageKey)
  const prevDataStateRef = useRef<MessagePositionState>(dataState)
  const prevGeometryRef = useRef<{ clientHeight: number; clientWidth: number; scrollHeight: number; scrollTop: number; tailPaddingEnd: number } | null>(null)
  const programmaticScrollRef = useRef<{ target: number; smooth: boolean } | null>(null)
  const activeTouchRef = useRef(false)
  const activePointersRef = useRef(new Set<number>())
  const lastReportedReadingRef = useRef<{ entry: typeof positionEntry; scope: typeof positionScope; window: typeof messageWindow; messageId: string } | null>(null)
  const automaticReadingEpochRef = useRef<number | null>(null)
  const dividerVisibilityRef = useRef<NewDividerVisibility>("pending")
  const positionOutcomeRef = useRef<PositionOutcome>("pending")
  const readReadyRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const scheduleCheckRef = useRef<() => void>(() => {})

  const propsRef = useRef({
    items,
    messageRows: messageRows ?? items,
    dataState,
    targetDataState,
    initialScrollReady,
    preserveInitialPresentation,
    messageWindow,
    hasMoreNewer: !!hasMoreNewer,
    isFetchingOlder: !!isFetchingOlder,
    isFetchingNewer: !!isFetchingNewer,
    visible,
    active,
    entryChanged,
    positionEntry,
    positionScope,
    scrollToMessageId,
    newDividerBefore,
    newDividerSeq,
    newBoundaryOwner,
    viewportInsetEnd,
    tailPaddingEnd,
    onScrollTargetPositioned,
    onScrollTargetCancelled,
    onInitialPositionSettled,
    onUserTakeover,
    onNewBoundaryReached,
    onReadingMessage,
    onJumpToPresent,
    presentPending: !!presentPending,
    presentRequest,
  })
  useLayoutEffect(() => {
    propsRef.current = {
      items,
      messageRows: messageRows ?? items,
      dataState,
      targetDataState,
      initialScrollReady,
      preserveInitialPresentation,
      messageWindow,
      hasMoreNewer: !!hasMoreNewer,
      isFetchingOlder: !!isFetchingOlder,
      isFetchingNewer: !!isFetchingNewer,
      visible,
      active,
      entryChanged,
      positionEntry,
      positionScope,
      scrollToMessageId,
      newDividerBefore,
      newDividerSeq,
      newBoundaryOwner,
      viewportInsetEnd,
      tailPaddingEnd,
      onScrollTargetPositioned,
      onScrollTargetCancelled,
      onInitialPositionSettled,
      onUserTakeover,
      onNewBoundaryReached,
      onReadingMessage,
      onJumpToPresent,
      presentPending: !!presentPending,
      presentRequest,
    }
  }, [
    active,
    dataState,
    entryChanged,
    hasMoreNewer,
    initialScrollReady,
    isFetchingNewer,
    isFetchingOlder,
    items,
    messageRows,
    messageWindow,
    newBoundaryOwner,
    newDividerBefore,
    newDividerSeq,
    onInitialPositionSettled,
    onJumpToPresent,
    onNewBoundaryReached,
    onReadingMessage,
    onScrollTargetCancelled,
    onScrollTargetPositioned,
    onUserTakeover,
    positionEntry,
    positionScope,
    presentPending,
    presentRequest,
    preserveInitialPresentation,
    scrollToMessageId,
    tailPaddingEnd,
    targetDataState,
    viewportInsetEnd,
    visible,
  ])

  const syncUiSnapshot = useCallback((incrementRevision = false, knownBelowCount?: number) => {
    const ctx = propsRef.current
    const nextMode = stateRef.current.mode
    const nextPendingReadReady = pendingReadReadyRef.current
    const nextPositionedTarget = positionedTargetRef.current
    const nextFollowSuspended = followSuspendedRef.current
    const nextFollowingTail = followingTailRef.current
    const nextReadingTail = readingTailRef.current
    const nextBelowCount = knownBelowCount ?? computeLoadedBelowCount(ctx.items, scrollRef.current, ctx.viewportInsetEnd)
    uiStore.setState((current) => {
      if (
        !incrementRevision
        && current.mode === nextMode
        && current.pendingReadReady === nextPendingReadReady
        && current.positionedTarget === nextPositionedTarget
        && current.followSuspended === nextFollowSuspended
        && current.followingTail === nextFollowingTail
        && current.readingTail === nextReadingTail
        && current.belowCount === nextBelowCount
      ) {
        return current
      }
      return {
        ...current,
        stateRevision: incrementRevision ? current.stateRevision + 1 : current.stateRevision,
        mode: nextMode,
        pendingReadReady: nextPendingReadReady,
        positionedTarget: nextPositionedTarget,
        followSuspended: nextFollowSuspended,
        followingTail: nextFollowingTail,
        readingTail: nextReadingTail,
        belowCount: nextBelowCount,
      }
    })
  }, [uiStore])

  const bumpState = useCallback(() => syncUiSnapshot(true), [syncUiSnapshot])
  const setCommittedEntry = useCallback((entry: object | null | undefined) => {
    uiStore.setState((current) => (current.committedEntry === entry ? current : { ...current, committedEntry: entry }))
  }, [uiStore])
  const setPositionOutcome = useCallback((outcome: PositionOutcome) => {
    uiStore.setState((current) => (current.positionOutcome === outcome ? current : { ...current, positionOutcome: outcome }))
  }, [uiStore])
  const setReadReady = useCallback((ready: boolean) => {
    uiStore.setState((current) => (current.readReady === ready ? current : { ...current, readReady: ready }))
  }, [uiStore])
  const setResumeValidated = useCallback((validated: boolean) => {
    uiStore.setState((current) => (current.resumeValidated === validated ? current : { ...current, resumeValidated: validated }))
  }, [uiStore])
  const setPaginationDirection = useCallback((direction: "older" | "newer" | null) => {
    uiStore.setState((current) => (current.paginationDirection === direction ? current : { ...current, paginationDirection: direction }))
  }, [uiStore])
  const setNewDividerVisibility = useCallback((visibility: NewDividerVisibility) => {
    uiStore.setState((current) => (current.newDividerVisibility === visibility ? current : { ...current, newDividerVisibility: visibility }))
  }, [uiStore])
  const bumpRequestRevision = useCallback(() => {
    uiStore.setState((current) => ({ ...current, requestRevision: current.requestRevision + 1 }))
  }, [uiStore])

  const setOutcomeOnce = useCallback((outcome: PositionOutcome) => {
    if (positionOutcomeRef.current !== "pending") return
    positionOutcomeRef.current = outcome
    setPositionOutcome(outcome)
    propsRef.current.onInitialPositionSettled?.(outcome)
  }, [setPositionOutcome])

  const writeReadReady = useCallback((ready: boolean) => {
    if (readReadyRef.current === ready) return
    readReadyRef.current = ready
    setReadReady(ready)
  }, [setReadReady])

  const finishNewOp = useCallback((result: NewPositionResult) => {
    const op = newOpRef.current
    if (!op) return
    newOpRef.current = null
    if (result !== "success") {
      op.cancel?.()
      followSuspendedRef.current = op.wasFollowSuspended
      followingTailRef.current = !op.wasFollowSuspended
      if (op.wasPinned) stateRef.current = { mode: "pinned-to-bottom" }
    }
    op.finish(result)
  }, [])

  const writeScrollTopInstant = useCallback((root: HTMLDivElement, top: number) => {
    const clamped = clampScrollTop(root, top)
    if (Math.abs(root.scrollTop - clamped) > 0.5) {
      root.scrollTop = clamped
      programmaticScrollRef.current = { target: root.scrollTop, smooth: false }
    }
    prevGeometryRef.current = {
      clientHeight: root.clientHeight,
      clientWidth: root.clientWidth,
      scrollHeight: root.scrollHeight,
      scrollTop: root.scrollTop,
      tailPaddingEnd: propsRef.current.tailPaddingEnd,
    }
  }, [])

  const writeScrollTopSmooth = useCallback((root: HTMLDivElement, top: number, behavior: ScrollBehavior) => {
    const clamped = clampScrollTop(root, top)
    const effective = messageScrollBehavior(behavior)
    programmaticScrollRef.current = { target: clamped, smooth: effective === "smooth" }
    if (typeof root.scrollTo === "function") {
      root.scrollTo({ top: clamped, behavior: effective })
    } else {
      root.scrollTop = clamped
    }
    prevGeometryRef.current = {
      clientHeight: root.clientHeight,
      clientWidth: root.clientWidth,
      scrollHeight: root.scrollHeight,
      scrollTop: root.scrollTop,
      tailPaddingEnd: propsRef.current.tailPaddingEnd,
    }
  }, [])

  const reportReadingMessage = useCallback((automatic = false, knownAnchor?: ReturnType<typeof captureVisibleAnchor>) => {
    const ctx = propsRef.current
    const root = scrollRef.current
    if (!ctx.onReadingMessage || !root || !ctx.visible || !ctx.active
      || ctx.dataState !== "ready" || !readReadyRef.current || stateRef.current.mode === "jumping-to-target") return
    const content = root.querySelector<HTMLElement>("[data-message-list-content]")
    if (content && content.getAttribute("data-read-position-ready") === "false") return
    const anchor = knownAnchor !== undefined ? knownAnchor : captureVisibleAnchor(root, ctx.items, ctx.viewportInsetEnd)
    if (!anchor?.anchorId) return
    if (automatic) automaticReadingEpochRef.current = epochRef.current
    const last = lastReportedReadingRef.current
    if (last && last.entry === ctx.positionEntry && last.scope === ctx.positionScope && last.window === ctx.messageWindow && last.messageId === anchor.anchorId) return
    if (!automatic) olderFillRetiredRef.current = false
    lastReportedReadingRef.current = { entry: ctx.positionEntry, scope: ctx.positionScope, window: ctx.messageWindow, messageId: anchor.anchorId }
    ctx.onReadingMessage(anchor.anchorId)
  }, [])

  const updateNewDividerVisibility = useCallback((notifyBoundary = true) => {
    const ctx = propsRef.current
    const root = scrollRef.current
    const id = ctx.newDividerBefore
    let next: NewDividerVisibility = "pending"
    if (root && id && ctx.visible && ctx.dataState !== "pending" && ctx.dataState !== "error" && root.clientHeight > 0 && root.clientWidth > 0) {
      const divider = findNewDivider(root, id)
      const viewport = root.getBoundingClientRect()
      if (divider) {
        const rect = divider.getBoundingClientRect()
        if (rect.height > 0 && rect.width > 0 && viewport.height > 0 && viewport.width > 0) {
          if (rect.bottom <= viewport.top) next = "above"
          else if (rect.top >= viewport.bottom - ctx.viewportInsetEnd) next = "below"
          else if (rect.right > viewport.left && rect.left < viewport.right) next = "visible"
        }
      } else {
        const idx = findMountScrollTargetIndex(ctx.items, id)
        if (idx !== null) {
          const body = findMessageBody(root, id)
          if (body) {
            const rect = body.getBoundingClientRect()
            if (rect.bottom <= viewport.top) next = "above"
            else if (rect.top >= viewport.bottom - ctx.viewportInsetEnd) next = "below"
            else next = "visible"
          }
        } else if (ctx.newDividerSeq !== undefined) {
          const seqs = ctx.items.flatMap((item) => item.kind === "message" && item.m.seq !== undefined ? [item.m.seq] : [])
          if (seqs.length > 0) {
            if (ctx.newDividerSeq < Math.min(...seqs)) next = "above"
            else if (ctx.newDividerSeq > Math.max(...seqs)) next = "below"
          }
        }
      }
    }
    if (dividerVisibilityRef.current !== next) {
      dividerVisibilityRef.current = next
      setNewDividerVisibility(next)
    }
    const epoch = epochRef.current
    if (notifyBoundary && presentOriginEpochRef.current === epoch && stateRef.current.mode !== "jumping-to-target"
      && readReadyRef.current && (next === "above" || next === "below")) {
      presentOriginEpochRef.current = null
    }
    if (notifyBoundary && next === "visible" && id
      && (manualOriginEpochRef.current === epoch || presentOriginEpochRef.current === epoch)
      && stateRef.current.mode !== "jumping-to-target"
      && readReadyRef.current && ctx.active && !ctx.entryChanged
      && typeof document !== "undefined" && document.visibilityState === "visible") {
      presentOriginEpochRef.current = null
      ctx.onNewBoundaryReached?.({ id, entry: ctx.positionEntry, owner: ctx.newBoundaryOwner, epoch })
    }
  }, [setNewDividerVisibility])

  const syncTailFlags = useCallback((root: HTMLDivElement | null) => {
    const ctx = propsRef.current
    if (!root || root.clientHeight <= 0) return
    const dist = distanceFromEnd(root)
    const below = computeLoadedBelowCount(ctx.items, root, ctx.viewportInsetEnd)
    const pinned = stateRef.current.mode === "pinned-to-bottom" && !ctx.hasMoreNewer && !followSuspendedRef.current
    followingTailRef.current = pinned
    readingTailRef.current = pinned && dist <= CONVERSATION_TAIL_SPACE_PX && below === 0
    syncUiSnapshot(false, below)
  }, [syncUiSnapshot])

  const transitionToReadingHistory = useCallback((userHandover: boolean, outcome: PositionOutcome = userHandover ? "user-cancelled" : "cancelled") => {
    const root = scrollRef.current
    const ctx = propsRef.current
    const wasJumping = stateRef.current.mode === "jumping-to-target"
    const cancelledTarget = (wasJumping || userHandover) && targetIntentRef.current && positionedTargetRef.current !== targetIntentRef.current
      ? targetIntentRef.current
      : null
    const wasReadable = readReadyRef.current
    finishNewOp(outcome === "error" ? "error" : "cancelled")
    presentOpRef.current = null
    programmaticScrollRef.current = null
    suspendedTailRef.current = null
    epochRef.current += 1
    const anchor = captureVisibleAnchor(root, ctx.items, ctx.viewportInsetEnd)
    stateRef.current = {
      mode: "reading-history",
      anchorId: anchor?.anchorId ?? null,
      anchorKey: anchor?.anchorKey ?? null,
      viewportOffset: anchor?.viewportOffset ?? 0,
      firstMessageKey: anchor?.firstMessageKey ?? firstMessageKeyOf(ctx.items),
    }
    followSuspendedRef.current = true
    followingTailRef.current = false
    readingTailRef.current = false
    initialSettledRef.current = true
    entryResolvedRef.current = true
    positionedTargetRef.current = targetIntentRef.current
    if (userHandover && ctx.active) {
      manualOriginEpochRef.current = epochRef.current
      presentOriginEpochRef.current = null
      if (wasReadable) writeReadReady(true)
      ctx.onUserTakeover?.()
    }
    if (cancelledTarget) ctx.onScrollTargetCancelled?.(cancelledTarget)
    setOutcomeOnce(outcome)
    bumpState()
  }, [bumpState, finishNewOp, setOutcomeOnce, writeReadReady])

  const settleJumpIfLanded = useCallback((allowNotify = true) => {
    const root = scrollRef.current
    const ctx = propsRef.current
    const state = stateRef.current
    if (!root || !ctx.visible || state.mode !== "jumping-to-target") return false
    if (root.clientHeight <= 0 || root.clientWidth <= 0) return false
    const targetData = state.kind === "message" || state.kind === "new" ? ctx.targetDataState : ctx.dataState
    if (state.kind === "new" && ctx.newDividerBefore !== state.targetId) {
      finishNewOp("missing")
      transitionToReadingHistory(false, "cancelled")
      return false
    }
    if (targetData === "pending" && !(state.kind === "present" && !initialSettledRef.current && ctx.initialScrollReady)) {
      return false
    }
    if (state.kind !== "present" && state.targetId && findMessageIndex(ctx.items, state.targetId) === null) {
      if (targetData === "ready") {
        if (state.kind === "new") finishNewOp("missing")
        transitionToReadingHistory(false, "cancelled")
      }
      return false
    }
    if (state.notifyTarget && !allowNotify) return false
    const computed = computeTargetScrollTop(root, state.kind, state.targetId, state.align, ctx.viewportInsetEnd)
    if (!computed) return false
    const { top } = computed
    const needsMove = Math.abs(root.scrollTop - top) > 1
    if (needsMove) {
      if (state.behavior === "smooth") {
        const activeSmooth = programmaticScrollRef.current
        if (!activeSmooth?.smooth || Math.abs(activeSmooth.target - top) > 1) {
          writeScrollTopSmooth(root, top, "smooth")
        }
      } else {
        writeScrollTopInstant(root, top)
      }
    }
    const landed = Math.abs(root.scrollTop - top) <= 1
    if (!landed) return false
    if (programmaticScrollRef.current?.smooth) {
      root.scrollTop = clampScrollTop(root, top)
    }
    programmaticScrollRef.current = null
    const wasReadReady = readReadyRef.current
    initialSettledRef.current = true
    entryResolvedRef.current = true
    setOutcomeOnce("success")
    if (state.kind === "present") {
      stateRef.current = { mode: "pinned-to-bottom" }
      followSuspendedRef.current = false
      readingNewRef.current = false
      followingTailRef.current = !ctx.hasMoreNewer
      readingTailRef.current = !ctx.hasMoreNewer && distanceFromEnd(root) <= CONVERSATION_TAIL_SPACE_PX
    } else {
      const anchor = captureVisibleAnchor(root, ctx.items, ctx.viewportInsetEnd)
      stateRef.current = {
        mode: "reading-history",
        anchorId: anchor?.anchorId ?? state.targetId,
        anchorKey: anchor?.anchorKey ?? null,
        viewportOffset: anchor?.viewportOffset ?? 0,
        firstMessageKey: anchor?.firstMessageKey ?? firstMessageKeyOf(ctx.items),
      }
      followSuspendedRef.current = true
      if (state.kind === "new") readingNewRef.current = true
      followingTailRef.current = false
      readingTailRef.current = false
    }
    if (wasReadReady && !needsMove) {
      writeReadReady(true)
    } else {
      pendingReadReadyRef.current = true
      scheduleCheckRef.current()
    }
    setResumeValidated(true)
    if (state.notifyTarget && state.targetId) {
      positionedTargetRef.current = state.targetId
      ctx.onScrollTargetPositioned?.(state.targetId)
    }
    if (state.kind === "new" && newOpRef.current?.id === state.targetId) {
      finishNewOp("success")
    }
    automaticReadingEpochRef.current = null
    updateNewDividerVisibility(true)
    bumpState()
    return true
  }, [bumpState, finishNewOp, setOutcomeOnce, setResumeValidated, transitionToReadingHistory, updateNewDividerVisibility, writeReadReady, writeScrollTopInstant, writeScrollTopSmooth])

  const compensateAnchor = useCallback((_fromResize = false) => {
    const root = scrollRef.current
    const ctx = propsRef.current
    if (!root || !ctx.visible || root.clientHeight <= 0 || root.clientWidth <= 0) return
    const state = stateRef.current
    const prevGeo = prevGeometryRef.current
    const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight)

    if (state.mode === "jumping-to-target") {
      settleJumpIfLanded(true)
      return
    }

    if (state.mode === "pinned-to-bottom") {
      if (ctx.hasMoreNewer && ctx.dataState === "ready" && initialSettledRef.current) return
      const viewportChanged = !!prevGeo && (
        prevGeo.clientHeight !== root.clientHeight
        || prevGeo.clientWidth !== root.clientWidth
        || prevGeo.tailPaddingEnd !== ctx.tailPaddingEnd
      )
      if (!viewportChanged && programmaticScrollRef.current?.smooth) {
        if (Math.abs(programmaticScrollRef.current.target - maxScroll) > 1) {
          writeScrollTopSmooth(root, maxScroll, "smooth")
        }
        syncTailFlags(root)
        return
      }
      if (viewportChanged && prevGeo) {
        const resized = resolveViewportResizeAnchor({
          previousClientHeight: prevGeo.clientHeight,
          nextClientHeight: root.clientHeight,
          previousScrollHeight: prevGeo.scrollHeight,
          nextScrollHeight: root.scrollHeight,
          previousScrollTop: prevGeo.scrollTop,
          atBottom: true,
        })
        writeScrollTopInstant(root, resized.scrollTop)
      } else if (!initialSettledRef.current) {
        writeScrollTopInstant(root, maxScroll)
      } else if (prevGeo && prevGeo.scrollHeight !== root.scrollHeight && !followSuspendedRef.current) {
        writeScrollTopInstant(root, maxScroll)
      } else if (!prevGeo && distanceFromEnd(root) > 1 && !followSuspendedRef.current) {
        writeScrollTopInstant(root, maxScroll)
      }
      syncTailFlags(root)
      return
    }

    const userDragging = activeTouchRef.current || activePointersRef.current.size > 0
    if (userDragging) {
      if (!prevGeo || prevGeo.clientHeight !== root.clientHeight || prevGeo.clientWidth !== root.clientWidth) return
      const scrollHeightDelta = root.scrollHeight - prevGeo.scrollHeight
      if (Math.abs(scrollHeightDelta) <= 0.5) return
      const targetEl = (state.anchorId ? findMessageBody(root, state.anchorId) : null)
        ?? (state.anchorKey ? findRowByKey(root, state.anchorKey) : null)
      if (!targetEl) return
      const rootRect = root.getBoundingClientRect()
      const bounds = state.anchorId ? messageContentBounds(targetEl) : targetEl.getBoundingClientRect()
      if (!bounds || bounds.height <= 0) return
      const currentOffset = bounds.top - rootRect.top
      const userDelta = root.scrollTop - prevGeo.scrollTop
      const layoutDrift = (currentOffset - state.viewportOffset) + userDelta
      if (
        Math.abs(layoutDrift) > 0.5
        && layoutDrift * scrollHeightDelta > 0
        && Math.abs(layoutDrift) <= Math.abs(scrollHeightDelta) + 2
      ) {
        writeScrollTopInstant(root, root.scrollTop + layoutDrift)
        const refreshed = captureVisibleAnchor(root, ctx.items, ctx.viewportInsetEnd)
        if (refreshed) stateRef.current = { mode: "reading-history", ...refreshed }
      }
      return
    }
    const currentFirstKey = firstMessageKeyOf(ctx.items)
    const messagesPrepended = state.firstMessageKey !== null && currentFirstKey !== null && state.firstMessageKey !== currentFirstKey
    const pureVerticalViewportResize = !!prevGeo
      && (prevGeo.clientHeight !== root.clientHeight || prevGeo.tailPaddingEnd !== ctx.tailPaddingEnd)
      && prevGeo.clientWidth === root.clientWidth
      && Math.abs((root.scrollHeight - ctx.tailPaddingEnd) - (prevGeo.scrollHeight - prevGeo.tailPaddingEnd)) <= 1
      && !messagesPrepended
    if (pureVerticalViewportResize && prevGeo) {
      writeScrollTopInstant(root, prevGeo.scrollTop)
      const refreshed = captureVisibleAnchor(root, ctx.items, ctx.viewportInsetEnd)
      if (refreshed) stateRef.current = { mode: "reading-history", ...refreshed }
      return
    }
    const targetEl = (state.anchorId ? findMessageBody(root, state.anchorId) : null)
      ?? (state.anchorKey ? findRowByKey(root, state.anchorKey) : null)
    if (!targetEl) return
    const rootRect = root.getBoundingClientRect()
    const bounds = state.anchorId ? messageContentBounds(targetEl) : targetEl.getBoundingClientRect()
    if (!bounds || bounds.height <= 0) return
    const currentOffset = bounds.top - rootRect.top
    const drift = currentOffset - state.viewportOffset
    if (Math.abs(drift) > 0.5) {
      const desired = root.scrollTop + drift
      writeScrollTopInstant(root, desired)
      if (Math.abs(root.scrollTop - desired) > 0.5) {
        const refreshed = captureVisibleAnchor(root, ctx.items, ctx.viewportInsetEnd)
        if (refreshed) stateRef.current = { mode: "reading-history", ...refreshed }
      }
    } else {
      prevGeometryRef.current = {
        clientHeight: root.clientHeight,
        clientWidth: root.clientWidth,
        scrollHeight: root.scrollHeight,
        scrollTop: root.scrollTop,
        tailPaddingEnd: ctx.tailPaddingEnd,
      }
    }
    if (messagesPrepended) {
      state.firstMessageKey = currentFirstKey
    }
  }, [settleJumpIfLanded, syncTailFlags, writeScrollTopInstant, writeScrollTopSmooth])

  const scheduleCheck = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      const hadPendingReadReady = pendingReadReadyRef.current
      compensateAnchor(false)
      if (hadPendingReadReady && pendingReadReadyRef.current) {
        pendingReadReadyRef.current = false
        const ctx = propsRef.current
        if (ctx.dataState !== "error" && (!ctx.scrollToMessageId || positionedTargetRef.current === ctx.scrollToMessageId)) {
          writeReadReady(true)
        }
        syncUiSnapshot(false)
      } else if (pendingReadReadyRef.current && rafRef.current === null) {
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = null
          compensateAnchor(false)
          if (pendingReadReadyRef.current) {
            pendingReadReadyRef.current = false
            const ctx = propsRef.current
            if (ctx.dataState !== "error" && (!ctx.scrollToMessageId || positionedTargetRef.current === ctx.scrollToMessageId)) {
              writeReadReady(true)
            }
            syncUiSnapshot(false)
          }
          updateNewDividerVisibility(true)
        })
      }
      updateNewDividerVisibility(true)
    })
  }, [compensateAnchor, syncUiSnapshot, updateNewDividerVisibility, writeReadReady])
  useLayoutEffect(() => {
    scheduleCheckRef.current = scheduleCheck
  }, [scheduleCheck])

  useLayoutEffect(() => {
    if (committedEntry === positionEntry) return
    setCommittedEntry(positionEntry)
    olderFillRetiredRef.current = false
    paginationRef.current = null
    setPaginationDirection(null)
    finishNewOp("cancelled")
    presentOpRef.current = null
    suspendedTailRef.current = null
    manualOriginEpochRef.current = null
    presentOriginEpochRef.current = null
    upwardIntentRef.current = false
    targetIntentRef.current = null
    positionedTargetRef.current = null
    lastReportedReadingRef.current = null
    automaticReadingEpochRef.current = null
    consumedPresentVersionRef.current = presentVersion ?? 0
    consumedLocalSubmitVersionRef.current = localSubmitVersion ?? 0
    epochRef.current += 1
    const preserve = preserveInitialPresentation && positionOutcomeRef.current !== "pending"
    if (!preserve) {
      positionOutcomeRef.current = "pending"
      setPositionOutcome("pending")
      initialSettledRef.current = false
      entryResolvedRef.current = false
      pendingReadReadyRef.current = false
      writeReadReady(false)
      stateRef.current = { mode: "pinned-to-bottom" }
      followSuspendedRef.current = false
      readingNewRef.current = false
      followingTailRef.current = true
      readingTailRef.current = true
    } else {
      initialSettledRef.current = true
      entryResolvedRef.current = true
    }
    prevTailKeyRef.current = tailMessageKey
    bumpState()
  }, [bumpState, committedEntry, finishNewOp, localSubmitVersion, positionEntry, preserveInitialPresentation, presentVersion, setCommittedEntry, setPaginationDirection, setPositionOutcome, tailMessageKey, writeReadReady])

  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!visible) {
      if (readReadyRef.current && dataState !== "error" && dataState !== "empty"
        && stateRef.current.mode === "pinned-to-bottom" && followingTailRef.current && !hasMoreNewer && root) {
        suspendedTailRef.current = { epoch: epochRef.current, entry: positionEntry, root }
      } else if (dataState === "error" || dataState === "empty") {
        suspendedTailRef.current = null
      }
      manualOriginEpochRef.current = null
      presentOriginEpochRef.current = null
      setResumeValidated(false)
      paginationRef.current = null
      setPaginationDirection(null)
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      return
    }
    const suspended = suspendedTailRef.current
    if (suspended) {
      if (suspended.entry !== positionEntry || suspended.root !== root || entryChanged
        || dataState === "error" || dataState === "empty" || stateRef.current.mode !== "pinned-to-bottom") {
        suspendedTailRef.current = null
        setResumeValidated(true)
      } else if (hasMoreNewer || presentPending) {
        setResumeValidated(false)
      } else if (dataState === "ready" && initialScrollReady && hasMessages && !isFetchingNewer && !isFetchingOlder && root && root.clientHeight > 0) {
        suspendedTailRef.current = null
        writeScrollTopInstant(root, root.scrollHeight - root.clientHeight)
        syncTailFlags(root)
        setResumeValidated(true)
        writeReadReady(true)
        updateNewDividerVisibility(false)
      }
    } else {
      setResumeValidated(true)
    }
  }, [dataState, entryChanged, hasMessages, hasMoreNewer, initialScrollReady, isFetchingNewer, isFetchingOlder, positionEntry, presentPending, setPaginationDirection, setResumeValidated, syncTailFlags, updateNewDividerVisibility, visible, writeReadReady, writeScrollTopInstant])

  const requestPresentPosition = useCallback((request?: MessageRequest | void, userInitiated = true) => {
    const ctx = propsRef.current
    if (!ctx.visible) return
    if (request && !request.accepted) return
    finishNewOp("cancelled")
    epochRef.current += 1
    const epoch = epochRef.current
    if (userInitiated) presentOriginEpochRef.current = epoch
    suspendedTailRef.current = null
    initialSettledRef.current = true
    entryResolvedRef.current = true
    writeReadReady(false)
    const op: PresentOperation = { epoch, userInitiated, allowAttachedTail: false, fetchingSeen: false }
    if (request?.accepted) {
      const receipt: NonNullable<PresentOperation["receipt"]> = { before: ctx.messageWindow }
      op.receipt = receipt
      const complete = (result: MessageRequestResult) => {
        if (presentOpRef.current !== op || epochRef.current !== epoch) return
        receipt.result = result
        bumpRequestRevision()
      }
      void request.completed.then(complete, () => complete({ status: "error" }))
    }
    presentOpRef.current = op
    stateRef.current = {
      mode: "jumping-to-target",
      kind: "present",
      targetId: null,
      align: "end",
      behavior: userInitiated ? messageScrollBehavior() : "auto",
      notifyTarget: false,
    }
    bumpState()
  }, [bumpRequestRevision, bumpState, finishNewOp, writeReadReady])

  useEffect(() => {
    const suspended = suspendedTailRef.current
    if (!visible || !suspended || suspended.entry !== positionEntry || suspended.root !== scrollRef.current
      || stateRef.current.mode === "jumping-to-target" || !onJumpToPresent || !initialScrollReady
      || (!hasMoreNewer && !presentPending) || (dataState !== "ready" && !presentPending)) return
    const req = presentPending ? presentRequest : (!isFetchingNewer && !isFetchingOlder ? onJumpToPresent() : undefined)
    if (req?.accepted) requestPresentPosition(req, false)
  }, [dataState, hasMoreNewer, initialScrollReady, isFetchingNewer, isFetchingOlder, onJumpToPresent, positionEntry, presentPending, presentRequest, requestPresentPosition, visible])

  useLayoutEffect(() => {
    const target = scrollToMessageId ?? null
    if (newOpRef.current && newOpRef.current.priorTarget === target) return
    if (!visible && target) return
    const changed = targetIntentRef.current !== target
    if (!changed && (!target || positionedTargetRef.current === target
      || (stateRef.current.mode === "jumping-to-target" && stateRef.current.targetId === target && stateRef.current.notifyTarget))) return
    targetIntentRef.current = target
    if (!target) {
      if (stateRef.current.mode === "jumping-to-target" && stateRef.current.kind === "message") {
        transitionToReadingHistory(false, "cancelled")
      }
      positionedTargetRef.current = null
      return
    }
    if (changed) positionedTargetRef.current = null
    if (targetDataState === "pending") {
      if (changed && (entryResolvedRef.current || stateRef.current.mode !== "pinned-to-bottom")) {
        epochRef.current += 1
        writeReadReady(false)
        stateRef.current = { mode: "jumping-to-target", kind: "message", targetId: target, align: "center", behavior: "auto", notifyTarget: true }
        if (initialScrollReady) setOutcomeOnce("cancelled")
        bumpState()
      }
      return
    }
    if (targetDataState === "error" && initialScrollReady && positionOutcomeRef.current === "pending") {
      positionedTargetRef.current = target
      propsRef.current.onScrollTargetCancelled?.(target)
      return
    }
    epochRef.current += 1
    initialSettledRef.current = true
    entryResolvedRef.current = true
    writeReadReady(false)
    stateRef.current = { mode: "jumping-to-target", kind: "message", targetId: target, align: "center", behavior: "auto", notifyTarget: true }
    bumpState()
    scheduleCheck()
  }, [bumpState, initialScrollReady, scheduleCheck, scrollToMessageId, setOutcomeOnce, targetDataState, transitionToReadingHistory, visible, writeReadReady])

  useLayoutEffect(() => {
    const version = localSubmitVersion ?? 0
    if (version === consumedLocalSubmitVersionRef.current) return
    const accepted = version > consumedLocalSubmitVersionRef.current
    consumedLocalSubmitVersionRef.current = version
    if (!accepted || !visible) return
    if ((hasMoreNewer || isFetchingNewer) && presentRequest !== undefined) {
      if (presentRequest) requestPresentPosition(presentRequest, false)
      else transitionToReadingHistory(false, "cancelled")
      return
    }
    epochRef.current += 1
    initialSettledRef.current = true
    entryResolvedRef.current = true
    followSuspendedRef.current = false
    readingNewRef.current = false
    upwardIntentRef.current = false
    presentOriginEpochRef.current = null
    if (hasMessages && !hasMoreNewer && !isFetchingNewer) {
      stateRef.current = { mode: "jumping-to-target", kind: "present", targetId: null, align: "end", behavior: messageScrollBehavior(), notifyTarget: false }
      bumpState()
    } else {
      presentOpRef.current = { epoch: epochRef.current, userInitiated: false, allowAttachedTail: !hasMoreNewer && !isFetchingNewer, fetchingSeen: !!isFetchingNewer }
      stateRef.current = { mode: "jumping-to-target", kind: "present", targetId: null, align: "end", behavior: messageScrollBehavior(), notifyTarget: false }
      bumpState()
    }
  }, [bumpState, hasMessages, hasMoreNewer, isFetchingNewer, localSubmitVersion, presentRequest, requestPresentPosition, transitionToReadingHistory, visible])

  useLayoutEffect(() => {
    const completedWindow = hasMessages && !hasMoreNewer && !isFetchingNewer
      && !!presentVersion && consumedPresentVersionRef.current !== presentVersion
    if (completedWindow) consumedPresentVersionRef.current = presentVersion
    const op = presentOpRef.current
    if (!op || op.epoch !== epochRef.current) return
    if (op.receipt) {
      const result = op.receipt.result
      if (!result) return
      if (result.status !== "success" || dataState === "error") {
        presentOpRef.current = null
        transitionToReadingHistory(false, "error")
        return
      }
      const windowState = result.windowState?.(messageWindow)
        ?? (messageWindow === result.window ? "ready" : messageWindow === op.receipt.before ? "pending" : "retired")
      if (windowState === "retired") {
        presentOpRef.current = null
        transitionToReadingHistory(false, "cancelled")
        return
      }
      if (windowState === "pending" || dataState === "pending") return
      presentOpRef.current = null
      if (dataState === "empty") {
        transitionToReadingHistory(false, "empty")
        writeReadReady(true)
        return
      }
      settleJumpIfLanded(true)
      return
    }
    if (dataState === "pending") return
    if (isFetchingNewer) {
      op.fetchingSeen = true
      return
    }
    if (op.fetchingSeen && hasMoreNewer) {
      presentOpRef.current = null
      transitionToReadingHistory(false, "cancelled")
      return
    }
    if (!hasMessages || hasMoreNewer) return
    if (!completedWindow && !op.allowAttachedTail) return
    presentOpRef.current = null
    settleJumpIfLanded(true)
  }, [dataState, hasMessages, hasMoreNewer, isFetchingNewer, messageWindow, presentVersion, requestRevision, settleJumpIfLanded, transitionToReadingHistory, writeReadReady])

  useLayoutEffect(() => {
    const op = newOpRef.current
    if (!op || !op.loaded || targetDataState !== "ready") return
    if (op.id !== newDividerBefore) {
      finishNewOp("missing")
      transitionToReadingHistory(false, "cancelled")
      return
    }
    if (findMessageIndex(items, op.id) !== null) {
      paginationRef.current = null
      setPaginationDirection(null)
      if (stateRef.current.mode !== "jumping-to-target" || stateRef.current.targetId !== op.id) {
        stateRef.current = { mode: "jumping-to-target", kind: "new", targetId: op.id, align: "start", behavior: messageScrollBehavior(), notifyTarget: false }
      }
      settleJumpIfLanded(true)
    } else if (messageWindow === op.window) {
      finishNewOp("missing")
      transitionToReadingHistory(false, "cancelled")
    }
  }, [finishNewOp, items, messageWindow, newDividerBefore, requestRevision, setPaginationDirection, settleJumpIfLanded, targetDataState, transitionToReadingHistory])

  useLayoutEffect(() => {
    const page = paginationRef.current
    if (!page) return
    const finish = () => {
      paginationRef.current = null
      setPaginationDirection(null)
    }
    if (dataState === "empty" || dataState === "error") { finish(); return }
    const waitingForRows = dataState === "pending" && !(page.fillingViewport && initialScrollReady)
    if (page.receipt) {
      const result = page.receipt.result
      if (!result) return
      if (page.fillingViewport && result.status === "retired") olderFillRetiredRef.current = true
      if (result.status !== "success" || result.window === page.receipt.before
        || (messageWindow !== result.window && messageWindow !== page.receipt.before)) {
        finish()
        return
      }
      if (messageWindow !== result.window || waitingForRows || (messageRows ?? items) === page.beforeRows) return
      if (page.pinTail && scrollRef.current
        && ((stateRef.current.mode === "pinned-to-bottom" && !followSuspendedRef.current) || suspendedTailRef.current !== null)) {
        stateRef.current = { mode: "pinned-to-bottom" }
        followSuspendedRef.current = false
        writeScrollTopInstant(scrollRef.current, scrollRef.current.scrollHeight - scrollRef.current.clientHeight)
        syncTailFlags(scrollRef.current)
      }
      finish()
      return
    }
    const fetching = page.direction === "older" ? isFetchingOlder : isFetchingNewer
    if (fetching) {
      page.fetchingSeen = true
      return
    }
    if (page.fetchingSeen) finish()
  }, [dataState, initialScrollReady, isFetchingNewer, isFetchingOlder, items, messageRows, messageWindow, requestRevision, setPaginationDirection, syncTailFlags, writeScrollTopInstant])

  useLayoutEffect(() => {
    const root = scrollRef.current
    const prevTailKey = prevTailKeyRef.current
    const prevData = prevDataStateRef.current
    prevTailKeyRef.current = tailMessageKey
    prevDataStateRef.current = dataState

    if (!visible) return
    const effectiveState = stateRef.current.mode === "jumping-to-target" && (stateRef.current.kind === "message" || stateRef.current.kind === "new")
      ? targetDataState
      : dataState

    if (effectiveState === "error" || effectiveState === "empty") {
      if (effectiveState === "error") {
        pendingReadReadyRef.current = false
        writeReadReady(false)
      }
      if (!initialSettledRef.current || stateRef.current.mode === "jumping-to-target") {
        setOutcomeOnce(effectiveState)
        initialSettledRef.current = true
        entryResolvedRef.current = true
        if (effectiveState === "empty") writeReadReady(true)
        if (stateRef.current.mode === "jumping-to-target") {
          transitionToReadingHistory(false, effectiveState)
        }
      }
      return
    }

    if (!root || root.clientHeight <= 0 || root.clientWidth <= 0) {
      if (hasMessages && (initialScrollReady || dataState === "ready")) scheduleCheck()
      return
    }

    if (!entryResolvedRef.current) {
      if (!initialScrollReady && dataState === "pending") return
      if (!hasMessages) return
      entryResolvedRef.current = true
      if (initialPositionMessageId) {
        stateRef.current = {
          mode: "jumping-to-target",
          kind: "message",
          targetId: initialPositionMessageId,
          align: "center",
          behavior: "auto",
          notifyTarget: false,
        }
        settleJumpIfLanded(true)
        if (pendingReadReadyRef.current) scheduleCheck()
        return
      }
      stateRef.current = { mode: "pinned-to-bottom" }
      writeScrollTopInstant(root, root.scrollHeight - root.clientHeight)
      initialSettledRef.current = true
      followingTailRef.current = !hasMoreNewer
      readingTailRef.current = !hasMoreNewer && distanceFromEnd(root) <= CONVERSATION_TAIL_SPACE_PX
      setOutcomeOnce("success")
      if (!scrollToMessageId) {
        pendingReadReadyRef.current = true
        scheduleCheck()
      }
      updateNewDividerVisibility(false)
      return
    }

    if (stateRef.current.mode === "jumping-to-target") {
      if (!presentOpRef.current) {
        const settled = settleJumpIfLanded(false)
        if (!settled || pendingReadReadyRef.current) scheduleCheck()
      }
      return
    }

    if (stateRef.current.mode === "pinned-to-bottom") {
      const settledTailAppend = initialSettledRef.current
        && readReadyRef.current
        && dataState === "ready"
        && prevData === "ready"
        && tailMessageKey !== undefined
        && prevTailKey !== undefined
        && tailMessageKey !== prevTailKey
        && !hasMoreNewer
        && !isFetchingOlder
        && !isFetchingNewer
        && !paginationRef.current
      if (settledTailAppend) {
        writeScrollTopSmooth(root, root.scrollHeight - root.clientHeight, messageScrollBehavior())
        syncTailFlags(root)
      } else {
        compensateAnchor(false)
      }
      if (preserveInitialPresentation && !readReadyRef.current && dataState === "ready" && targetDataState === "ready") {
        writeReadReady(true)
      }
      updateNewDividerVisibility(false)
      return
    }

    compensateAnchor(false)
    if (preserveInitialPresentation && !readReadyRef.current && dataState === "ready" && targetDataState === "ready") {
      writeReadReady(true)
    }
    updateNewDividerVisibility(false)
  }, [
    compensateAnchor,
    dataState,
    hasMessages,
    hasMoreNewer,
    initialPositionMessageId,
    initialScrollReady,
    isFetchingNewer,
    isFetchingOlder,
    items,
    messageWindow,
    preserveInitialPresentation,
    scheduleCheck,
    scrollToMessageId,
    setOutcomeOnce,
    settleJumpIfLanded,
    stateRevision,
    syncTailFlags,
    tailMessageKey,
    tailPaddingEnd,
    targetDataState,
    transitionToReadingHistory,
    updateNewDividerVisibility,
    viewportInsetEnd,
    visible,
    writeReadReady,
    writeScrollTopInstant,
    writeScrollTopSmooth,
  ])

  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const activePointers = activePointersRef.current

    const captureCurrentAnchor = () => {
      const ctx = propsRef.current
      const anchor = captureVisibleAnchor(root, ctx.items, ctx.viewportInsetEnd)
      if (stateRef.current.mode === "reading-history" && anchor) {
        stateRef.current = { mode: "reading-history", ...anchor }
      }
      return anchor
    }

    const tryRestorePinnedOnDownward = (fromRelease = false) => {
      const ctx = propsRef.current
      if (activeTouchRef.current || activePointers.size > 0) return
      if (stateRef.current.mode !== "reading-history" || !readReadyRef.current || ctx.dataState !== "ready"
        || ctx.hasMoreNewer || ctx.isFetchingNewer || paginationRef.current?.direction === "newer") return
      if (readingNewRef.current) return
      const dist = distanceFromEnd(root)
      const nearPhysicalEnd = dist <= CONVERSATION_TAIL_SPACE_PX
      if (upwardIntentRef.current && !(fromRelease && nearPhysicalEnd)) return
      const below = computeLoadedBelowCount(ctx.items, root, ctx.viewportInsetEnd)
      if (nearPhysicalEnd || below === 0) {
        upwardIntentRef.current = false
        stateRef.current = { mode: "pinned-to-bottom" }
        followSuspendedRef.current = false
        followingTailRef.current = true
        readingTailRef.current = nearPhysicalEnd
        bumpState()
      }
    }

    const onUserIntent = (towardEnd: boolean) => {
      programmaticScrollRef.current = null
      upwardIntentRef.current = !towardEnd
      const wasReadingHistory = stateRef.current.mode === "reading-history"
      if (!wasReadingHistory) {
        transitionToReadingHistory(true)
      } else {
        manualOriginEpochRef.current = epochRef.current
        presentOriginEpochRef.current = null
        followSuspendedRef.current = true
        followingTailRef.current = false
        readingTailRef.current = false
        captureCurrentAnchor()
      }
      if (towardEnd) {
        tryRestorePinnedOnDownward(false)
      }
    }

    const onScroll = () => {
      const ctx = propsRef.current
      const prevGeo = prevGeometryRef.current
      const viewportChangedBeforeScroll = !!prevGeo && (
        prevGeo.clientHeight !== root.clientHeight
        || prevGeo.clientWidth !== root.clientWidth
        || prevGeo.tailPaddingEnd !== ctx.tailPaddingEnd
      )
      if (viewportChangedBeforeScroll && stateRef.current.mode !== "jumping-to-target") {
        compensateAnchor(true)
        syncTailFlags(root)
        updateNewDividerVisibility(true)
        return
      }
      const prevTop = prevGeo?.scrollTop ?? root.scrollTop
      const delta = root.scrollTop - prevTop
      const prog = programmaticScrollRef.current
      const landedProgrammaticScroll = !!prog && Math.abs(root.scrollTop - prog.target) <= (prog.smooth ? 1 : 0.25)
      const inFlightSmoothScroll = !!prog && prog.smooth && !landedProgrammaticScroll && (
        (prog.target >= prevTop && delta >= -0.5 && root.scrollTop <= prog.target + 1)
        || (prog.target <= prevTop && delta <= 0.5 && root.scrollTop >= prog.target - 1)
      )
      const isOwnProgrammaticScroll = landedProgrammaticScroll || inFlightSmoothScroll
      if (prog) {
        if (landedProgrammaticScroll) {
          programmaticScrollRef.current = null
          if (stateRef.current.mode === "jumping-to-target") settleJumpIfLanded(true)
        } else if (!prog.smooth || !inFlightSmoothScroll) {
          programmaticScrollRef.current = null
        }
      }

      const dist = distanceFromEnd(root)
      let capturedAnchor: ReturnType<typeof captureVisibleAnchor> | undefined

      if (stateRef.current.mode === "pinned-to-bottom" && !isOwnProgrammaticScroll) {
        if (dist > CONVERSATION_TAIL_SPACE_PX && (delta < -0.5 || !prevGeo || prevGeo.scrollHeight === root.scrollHeight)) {
          upwardIntentRef.current = true
          transitionToReadingHistory(true)
        }
      } else if (stateRef.current.mode === "reading-history") {
        if (delta > 0.5) {
          upwardIntentRef.current = false
          tryRestorePinnedOnDownward(false)
        } else if (delta < -0.5) {
          upwardIntentRef.current = true
        }
        capturedAnchor = captureCurrentAnchor()
      } else if (stateRef.current.mode === "jumping-to-target") {
        settleJumpIfLanded(true)
      }

      prevGeometryRef.current = {
        clientHeight: root.clientHeight,
        clientWidth: root.clientWidth,
        scrollHeight: root.scrollHeight,
        scrollTop: root.scrollTop,
        tailPaddingEnd: ctx.tailPaddingEnd,
      }
      syncTailFlags(root)
      updateNewDividerVisibility(true)
      if (!isOwnProgrammaticScroll) reportReadingMessage(false, capturedAnchor)
    }

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) onUserIntent(event.deltaY > 0)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        onUserIntent(["ArrowDown", "PageDown", "End"].includes(event.key) || (event.key === " " && !event.shiftKey))
      }
    }
    const onTouchStart = () => {
      activeTouchRef.current = true
      onUserIntent(false)
    }
    const onTouchEnd = (event: TouchEvent) => {
      const wasActive = activeTouchRef.current
      activeTouchRef.current = event.touches.length > 0
      if (wasActive && !activeTouchRef.current) tryRestorePinnedOnDownward(true)
    }
    const onPointerDown = (event: PointerEvent) => {
      activePointers.add(event.pointerId)
      onUserIntent(false)
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!activePointers.delete(event.pointerId)) return
      if (activePointers.size === 0) tryRestorePinnedOnDownward(true)
    }
    const onBlur = () => {
      activeTouchRef.current = false
      activePointers.clear()
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

    const ro = new ResizeObserver(() => {
      compensateAnchor(true)
      updateNewDividerVisibility(false)
      if (!entryResolvedRef.current || stateRef.current.mode === "jumping-to-target") {
        bumpState()
      } else {
        syncUiSnapshot(false)
      }
    })
    ro.observe(root)
    let observedRowsEl: HTMLElement | null = root.querySelector<HTMLElement>("[data-message-rows]")
    if (observedRowsEl) ro.observe(observedRowsEl)
    let observedContentEl: HTMLElement | null = root.querySelector<HTMLElement>("[data-message-list-content]")

    const mo = new MutationObserver(() => {
      const nextContent = root.querySelector<HTMLElement>("[data-message-list-content]")
      if (nextContent && nextContent !== observedContentEl) {
        observedContentEl = nextContent
        mo.observe(nextContent, { childList: true })
      }
      const nextRows = root.querySelector<HTMLElement>("[data-message-rows]")
      if (nextRows === observedRowsEl) return
      if (observedRowsEl) ro.unobserve(observedRowsEl)
      observedRowsEl = nextRows
      if (observedRowsEl) ro.observe(observedRowsEl)
    })
    mo.observe(root, { childList: true })
    if (observedContentEl) mo.observe(observedContentEl, { childList: true })

    const footer = root.closest<HTMLElement>('[data-slot="community-conversation-surface"]')
      ?.querySelector<HTMLElement>('[data-slot="community-conversation-footer"]')
    if (footer) ro.observe(footer)
    const footerMo = footer && typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
        const prevGeo = prevGeometryRef.current
        if (!prevGeo || prevGeo.clientHeight !== root.clientHeight
          || prevGeo.clientWidth !== root.clientWidth
          || prevGeo.tailPaddingEnd !== propsRef.current.tailPaddingEnd) {
          compensateAnchor(true)
          updateNewDividerVisibility(false)
          if (!entryResolvedRef.current || stateRef.current.mode === "jumping-to-target") {
            bumpState()
          } else {
            syncUiSnapshot(false)
          }
        }
      })
      : null
    footerMo?.observe(footer!, { childList: true, subtree: true })

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
      mo.disconnect()
      footerMo?.disconnect()
      activeTouchRef.current = false
      activePointers.clear()
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [bumpState, compensateAnchor, reportReadingMessage, settleJumpIfLanded, syncTailFlags, syncUiSnapshot, transitionToReadingHistory, updateNewDividerVisibility])

  useEffect(() => () => {
    finishNewOp("retired")
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [finishNewOp])

  const scrollToBottom = useCallback(() => {
    const ctx = propsRef.current
    if (!ctx.visible) return
    finishNewOp("cancelled")
    epochRef.current += 1
    presentOriginEpochRef.current = epochRef.current
    followSuspendedRef.current = false
    readingNewRef.current = false
    upwardIntentRef.current = false
    initialSettledRef.current = true
    entryResolvedRef.current = true
    stateRef.current = {
      mode: "jumping-to-target",
      kind: "present",
      targetId: null,
      align: "end",
      behavior: messageScrollBehavior(),
      notifyTarget: false,
    }
    settleJumpIfLanded(true)
    bumpState()
  }, [bumpState, finishNewOp, settleJumpIfLanded])

  const jumpTo = useCallback((messageId: string, behavior: ScrollBehavior = messageScrollBehavior()) => {
    const ctx = propsRef.current
    if (!ctx.visible || findMessageIndex(ctx.items, messageId) === null) return
    finishNewOp("cancelled")
    epochRef.current += 1
    presentOriginEpochRef.current = null
    initialSettledRef.current = true
    entryResolvedRef.current = true
    stateRef.current = {
      mode: "jumping-to-target",
      kind: "message",
      targetId: messageId,
      align: "center",
      behavior: messageScrollBehavior(behavior),
      notifyTarget: false,
    }
    settleJumpIfLanded(true)
    bumpState()
  }, [bumpState, finishNewOp, settleJumpIfLanded])

  const requestNewPosition = useCallback((id: string, load?: () => MessageRequest): NewPositionRequest => {
    const ctx = propsRef.current
    if (!ctx.visible || ctx.newDividerBefore !== id || newOpRef.current
      || (!load && findMessageIndex(ctx.items, id) === null)) {
      return { accepted: false }
    }
    const wasPinned = stateRef.current.mode === "pinned-to-bottom"
    const wasFollowSuspended = followSuspendedRef.current
    if (wasPinned) {
      const anchor = captureVisibleAnchor(scrollRef.current, ctx.items, ctx.viewportInsetEnd)
      if (anchor) stateRef.current = { mode: "reading-history", ...anchor }
    }
    epochRef.current += 1
    const epoch = epochRef.current
    initialSettledRef.current = true
    entryResolvedRef.current = true
    followSuspendedRef.current = true
    followingTailRef.current = false
    readingTailRef.current = false
    const timeout = new AbortController()
    let finish!: (result: NewPositionResult) => void
    const completed = new Promise<NewPositionResult>((resolve) => {
      finish = (result) => { resolve(result); timeout.abort() }
    })
    const op: NewOperation = {
      epoch,
      id,
      priorTarget: targetIntentRef.current,
      loaded: !load,
      wasPinned,
      wasFollowSuspended,
      finish,
    }
    newOpRef.current = op
    void withConversationReadDeadline(timeout.signal, () => completed).catch(() => {
      if (newOpRef.current === op) transitionToReadingHistory(false, "error")
    })
    try {
      const request = load?.()
      if (request && !request.accepted) {
        finishNewOp("cancelled")
        return { accepted: false }
      }
      if (request?.accepted) {
        op.cancel = request.cancel
        const complete = (result: MessageRequestResult) => {
          if (newOpRef.current !== op || epochRef.current !== epoch) return
          if (result.status === "success") {
            op.loaded = true
            op.window = result.window
            bumpRequestRevision()
          } else {
            finishNewOp(result.status)
            transitionToReadingHistory(false, result.status === "error" ? "error" : "cancelled")
          }
        }
        void request.completed.then(complete, () => complete({ status: "error" }))
      } else {
        bumpRequestRevision()
      }
    } catch {
      transitionToReadingHistory(false, "error")
    }
    return { accepted: true, completed }
  }, [bumpRequestRevision, finishNewOp, transitionToReadingHistory])

  const capturePageAnchor = useCallback((direction: "older" | "newer", fillingViewport?: boolean) => {
    const ctx = propsRef.current
    if (paginationRef.current || stateRef.current.mode === "jumping-to-target"
      || (direction === "older" && !fillingViewport && olderFillRetiredRef.current)) {
      return false as const
    }
    const root = scrollRef.current
    const resumingPinnedTail = direction === "newer" && suspendedTailRef.current !== null
    const pinTail = (direction === "older" && stateRef.current.mode === "pinned-to-bottom" && !followSuspendedRef.current)
      || (!!fillingViewport && readingTailRef.current)
      || resumingPinnedTail
    if (!pinTail) {
      const anchor = captureVisibleAnchor(root, ctx.items, ctx.viewportInsetEnd)
      if (anchor) {
        stateRef.current = { mode: "reading-history", ...anchor }
      }
      if (direction === "newer" && readReadyRef.current && !suspendedTailRef.current) {
        followSuspendedRef.current = true
        followingTailRef.current = false
        readingTailRef.current = false
      }
    }
    const page: PaginationState = {
      direction,
      beforeRows: ctx.messageRows,
      fillingViewport,
      pinTail,
      fetchingSeen: false,
    }
    paginationRef.current = page
    setPaginationDirection(direction)
    return (request: MessageRequest | void) => {
      if (paginationRef.current !== page || !request) return
      if (!request.accepted) {
        paginationRef.current = null
        setPaginationDirection(null)
        return
      }
      const receipt: NonNullable<PaginationState["receipt"]> = { before: ctx.messageWindow }
      page.receipt = receipt
      const complete = (result: MessageRequestResult) => {
        if (paginationRef.current !== page) return
        receipt.result = result
        bumpRequestRevision()
      }
      void request.completed.then(complete, () => complete({ status: "error" }))
    }
  }, [bumpRequestRevision, setPaginationDirection])

  const captureOlderPageAnchor = useCallback((fillingViewport?: boolean) => capturePageAnchor("older", fillingViewport), [capturePageAnchor])
  const captureNewerPageAnchor = useCallback(() => capturePageAnchor("newer"), [capturePageAnchor])

  const cachedVirtualItemsRef = useRef<{ items: FlatItem[]; virtual: VirtualItem[] } | null>(null)
  const paginationScroller = useMemo(() => ({
    getVirtualItems: (): VirtualItem[] => {
      const current = propsRef.current.items
      if (current.length === 0) return EMPTY_VIRTUAL_ITEMS
      const cached = cachedVirtualItemsRef.current
      if (cached && cached.items === current) return cached.virtual
      const virtual = current.map((item, index) => ({
        index,
        key: item.key,
        start: 0,
        end: 0,
        size: 0,
        lane: 0,
      }))
      cachedVirtualItemsRef.current = { items: current, virtual }
      return virtual
    },
    get scrollElement() {
      return scrollRef.current
    },
  }), [])

  useLayoutEffect(() => {
    syncUiSnapshot(false)
  }, [dataState, hasMoreNewer, items, scrollToMessageId, stateRevision, syncUiSnapshot, tailPaddingEnd, viewportInsetEnd, visible])

  const awaitingTarget = !!scrollToMessageId && ui.positionedTarget !== scrollToMessageId
  const isSteady = ui.mode !== "jumping-to-target" && positionOutcome !== "pending" && !ui.pendingReadReady
  const effectiveReadPositionReady = active && visible && dataState !== "pending" && dataState !== "error" && resumeValidated && !entryChanged && readReady
  const effectivePaginationEnabled = active && visible && dataState !== "pending" && dataState !== "error" && !entryChanged && isSteady && !awaitingTarget
  const effectiveUnderfillEnabled = active && visible && initialScrollReady && readReady && !entryChanged && isSteady && !awaitingTarget && dataState !== "error"
  const belowCount = ui.belowCount
  const paginationRequestPending = paginationDirection !== null

  useEffect(() => {
    if (!effectiveReadPositionReady || (newOpRef.current && !newOpRef.current.loaded)) return
    if (automaticReadingEpochRef.current === epochRef.current || manualOriginEpochRef.current === epochRef.current) return
    reportReadingMessage(true)
  }, [effectiveReadPositionReady, items, messageWindow, positionEntry, positionOutcome, reportReadingMessage, stateRevision, visible])

  return {
    scrollRef,
    paginationScroller,
    readPositionReady: effectiveReadPositionReady,
    paginationEnabled: effectivePaginationEnabled,
    underfillEnabled: effectiveUnderfillEnabled,
    paginationRequestPending,
    belowCount,
    positionOutcome,
    jumpToPresentVisible: !!hasMoreNewer && (dataState === "ready" || ui.followSuspended || !!scrollToMessageId || !!initialPositionMessageId),
    scrollToBottom,
    requestPresentPosition,
    requestNewPosition,
    jumpTo,
    newDividerVisibility,
    followingTail: !hasMoreNewer && !ui.followSuspended && ui.followingTail,
    readingTail: !hasMoreNewer && !ui.followSuspended && ui.readingTail,
    captureOlderPageAnchor,
    captureNewerPageAnchor,
  }
}
