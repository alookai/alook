import { Store } from "@tanstack/store"
import type { CommunityConversationEntryRead, CommunityReadStateResource } from "@alook/shared"
import {
  flattenMessageItems,
  stabilizeFirstRowGrouping,
  type FirstMessageGrouping,
  type FlatItem,
} from "./message-list-items"
import {
  emptyMessageOverlay,
  materializeMessageStream,
  reduceMessageOverlay,
  type CanonicalMessage,
  type MessageOverlayEvent,
  type MessageOverlayIds,
  type MessageOverlayTransition,
  type NewOutboxIntent,
} from "./message-stream"
import type { Msg } from "./models/message"

type TimelineDisplayPhase = "skeleton" | "revealed"

type TimelineBoundaries = Readonly<{
  hasMoreOlder: boolean
  hasMoreNewer: boolean
  historyStartKnown: boolean
  olderCursor?: string
  newerCursor?: string
  latestSeq: number
  reconciling: boolean
}>

type TimelineNewBoundary = Readonly<{
  targetId?: string
  targetSeq: number | null
  afterSeq: number | null
  retiredTargetId?: string
}>

type TimelineReadQualification = Readonly<{
  readSnapshot: CommunityReadStateResource | null
  readPositionReady: boolean
  paginationEligible: boolean
  accessDenied: boolean
  revoked: boolean
  initialLoadError: Error | null
  silentRefreshError: Error | null
  targetLoadError: Error | null
}>

export type TimelineCanonicalPage = Readonly<{
  messages: readonly CanonicalMessage[]
  hasMoreOlder?: boolean
  hasMore?: boolean
  hasMoreNewer?: boolean
  olderCursor?: string | null
  cursor?: string | null
  newerCursor?: string | null
  latestSeq?: number
}>

type ConversationTimelineSnapshot = Readonly<{
  channelId: string
  viewerUserId: string | null
  tag: string | null
  messages: readonly Msg[]
  items: readonly FlatItem[]
  displayPhase: TimelineDisplayPhase
  showSkeleton: boolean
  contentVisible: boolean
  contentInteractive: boolean
  hasQualifiedCache: boolean
  authoritativeEmpty: boolean
  boundaries: TimelineBoundaries
  newBoundary: TimelineNewBoundary
  readQualification: TimelineReadQualification
  revision: number
}>

type ConversationTimelineState = Readonly<{
  channelId: string
  viewerUserId: string | null
  tag: string | null
  canonicalBase: readonly CanonicalMessage[]
  canonicalById: ReadonlyMap<string, CanonicalMessage>
  overlay: MessageOverlayIds
  hasQualifiedCache: boolean
  authoritativeEmpty: boolean
  accessQualified: boolean
  targetCovered: boolean
  reconcilingTarget: boolean
  showNewerLoading: boolean
  showLeading: boolean
  boundaries: TimelineBoundaries
  newBoundary: TimelineNewBoundary
  readSnapshot: CommunityReadStateResource | null
  accessDenied: boolean
  revoked: boolean
  initialLoadError: Error | null
  silentRefreshError: Error | null
  targetLoadError: Error | null
  firstMessageGrouping: FirstMessageGrouping | null
  revision: number
  snapshot: ConversationTimelineSnapshot
}>

type TimelineHydrateCachePayload = Readonly<{
  pages: readonly TimelineCanonicalPage[]
  relatedMessages?: readonly CanonicalMessage[]
  readSnapshot?: CommunityReadStateResource | null
  accessQualified?: boolean
  targetCovered?: boolean
  reconcilingTarget?: boolean
  newBoundary?: CommunityConversationEntryRead["newBoundary"]
  showNewerLoading?: boolean
  showLeading?: boolean
}>

type TimelineReconcileNetworkPayload = Readonly<{
  pages: readonly TimelineCanonicalPage[]
  relatedMessages?: readonly CanonicalMessage[]
  readSnapshot?: CommunityReadStateResource | null
  accessQualified?: boolean
  targetCovered?: boolean
  reconcilingTarget?: boolean
  newBoundary?: CommunityConversationEntryRead["newBoundary"]
  showNewerLoading?: boolean
  showLeading?: boolean
}>

type ConversationTimelineAction =
  | { type: "hydrateCache"; payload: TimelineHydrateCachePayload }
  | { type: "reconcileNetwork"; payload: TimelineReconcileNetworkPayload }
  | { type: "wsMessage"; message: CanonicalMessage; relatedMessages?: readonly CanonicalMessage[] }
  | { type: "submitOptimistic"; intent: NewOutboxIntent }
  | { type: "uploadSettled"; nonce: string; attachments: Msg["attachments"] }
  | { type: "uploadFailed"; nonce: string }
  | { type: "confirmSendAck"; nonce: string; message: CanonicalMessage; relatedMessages?: readonly CanonicalMessage[] }
  | { type: "postFail"; nonce: string }
  | { type: "terminalReject"; nonce: string }
  | { type: "retrySend"; nonce: string }
  | { type: "dismissFailedSend"; nonce: string }
  | { type: "removeMessage"; messageId: string }
  | { type: "recordNetworkError"; error: Error; targetOnly?: boolean }
  | { type: "clearErrors" }
  | { type: "retireNewBoundary"; targetId?: string }
  | { type: "revokeAccess"; accessDenied?: boolean }
  | { type: "updateViewer"; viewerUserId: string | null }
  | { type: "setTag"; tag: string | null }

type ConversationTimelineTransitionResult = Readonly<{
  state: ConversationTimelineState
  effects: MessageOverlayTransition["effects"]
}>

type ConversationTimelineInit = Readonly<{
  channelId: string
  viewerUserId?: string | null
  tag?: string | null
}>

export function mergeTimelinePages<T extends { id: string; seq?: number; createdAt?: string }>(
  pages: readonly { messages: readonly T[] }[],
): T[] {
  const merged: T[] = []
  for (const page of pages) {
    for (const message of page.messages) merged.push(message)
  }
  merged.sort((left, right) => {
    if (left.seq !== undefined && right.seq !== undefined && left.seq !== right.seq) {
      return left.seq - right.seq
    }
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0
    if (leftTime !== rightTime) return leftTime - rightTime
    if (left.id < right.id) return -1
    if (left.id > right.id) return 1
    return 0
  })
  const seen = new Set<string>()
  const unique: T[] = []
  for (const message of merged) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    unique.push(message)
  }
  return unique
}

function deriveBoundaries(
  pages: readonly TimelineCanonicalPage[],
  canonicalBase: readonly CanonicalMessage[],
  reconciling: boolean,
): TimelineBoundaries {
  if (pages.length === 0) {
    return {
      hasMoreOlder: false,
      hasMoreNewer: false,
      historyStartKnown: false,
      latestSeq: Math.max(0, ...canonicalBase.map((message) => message.seq)),
      reconciling,
    }
  }
  const firstPage = pages[0]!
  const lastPage = pages[pages.length - 1]!
  const hasMoreOlder = Boolean(lastPage.hasMoreOlder ?? lastPage.hasMore ?? false)
  const hasMoreNewer = Boolean(firstPage.hasMoreNewer ?? false)
  const olderCursor = (lastPage.olderCursor ?? lastPage.cursor) ?? undefined
  const newerCursor = firstPage.newerCursor ?? undefined
  const latestSeq = Math.max(
    0,
    ...pages.map((page) => page.latestSeq ?? 0),
    ...canonicalBase.map((message) => message.seq),
  )
  return {
    hasMoreOlder,
    hasMoreNewer,
    historyStartKnown: !hasMoreOlder,
    ...(olderCursor ? { olderCursor } : {}),
    ...(newerCursor ? { newerCursor } : {}),
    latestSeq,
    reconciling,
  }
}

function buildCanonicalLookup(
  previous: ReadonlyMap<string, CanonicalMessage>,
  canonicalBase: readonly CanonicalMessage[],
  relatedMessages?: readonly CanonicalMessage[],
  extra?: readonly CanonicalMessage[],
): ReadonlyMap<string, CanonicalMessage> {
  const next = new Map(previous)
  if (relatedMessages) {
    for (const message of relatedMessages) next.set(message.id, message)
  }
  for (const message of canonicalBase) next.set(message.id, message)
  if (extra) {
    for (const message of extra) next.set(message.id, message)
  }
  return next
}

export function selectTimelineNewDivider(
  messages: readonly Msg[],
  newBoundary: TimelineNewBoundary,
): string | undefined {
  if (newBoundary.targetId && newBoundary.targetId !== newBoundary.retiredTargetId) {
    if (messages.some((message) => message.id === newBoundary.targetId)) {
      return newBoundary.targetId
    }
  }
  if (newBoundary.afterSeq === null) return undefined
  const candidate = messages.find(
    (message) => typeof message.seq === "number" && message.seq > newBoundary.afterSeq!,
  )
  if (!candidate || candidate.id === newBoundary.retiredTargetId) return undefined
  return candidate.id
}

function matchesTag(message: Msg, tag: string | null): boolean {
  return !tag || message.thread?.tags?.includes(tag) === true
}

function deriveNextNewBoundary(
  current: TimelineNewBoundary,
  incoming?: CommunityConversationEntryRead["newBoundary"],
): TimelineNewBoundary {
  if (!incoming) return current
  const targetId = incoming.target?.id
  const targetSeq = incoming.target?.seq ?? null
  if (targetId && targetId === current.retiredTargetId) {
    return {
      targetSeq,
      afterSeq: incoming.afterSeq,
      retiredTargetId: current.retiredTargetId,
    }
  }
  return {
    ...(targetId ? { targetId } : {}),
    targetSeq,
    afterSeq: incoming.afterSeq,
    ...(current.retiredTargetId ? { retiredTargetId: current.retiredTargetId } : {}),
  }
}

function deriveConversationTimelineSnapshot(
  draft: Omit<ConversationTimelineState, "snapshot" | "firstMessageGrouping">,
  previousFirst: FirstMessageGrouping | null,
): {
  snapshot: ConversationTimelineSnapshot
  firstMessageGrouping: FirstMessageGrouping | null
} {
  const readable = !draft.revoked && !draft.accessDenied
  const messages = readable
    ? materializeMessageStream([...draft.canonicalBase], draft.overlay, draft.canonicalById)
        .filter((message) => matchesTag(message, draft.tag))
    : []
  const newDividerBefore = selectTimelineNewDivider(messages, draft.newBoundary)
  const rawItems = readable
    ? flattenMessageItems(
        messages,
        newDividerBefore,
        draft.boundaries.hasMoreOlder,
        draft.showNewerLoading,
        draft.showLeading,
        draft.viewerUserId,
      )
    : []
  const { items, firstMessageGrouping } = stabilizeFirstRowGrouping(rawItems, previousFirst, newDividerBefore)
  const hasVisibleRows = readable && messages.length > 0
  const hasDisplayableContent = hasVisibleRows || (readable && draft.authoritativeEmpty)
  const displayPhase: TimelineDisplayPhase =
    hasDisplayableContent || draft.accessDenied || draft.revoked || draft.initialLoadError !== null
      ? "revealed"
      : "skeleton"
  const readPositionReady =
    readable
    && draft.accessQualified
    && draft.readSnapshot !== null
    && draft.targetCovered
    && !draft.reconcilingTarget
    && !draft.boundaries.reconciling
  const paginationEligible = readPositionReady && !draft.accessDenied && !draft.revoked

  return {
    firstMessageGrouping,
    snapshot: {
      channelId: draft.channelId,
      viewerUserId: draft.viewerUserId,
      tag: draft.tag,
      messages,
      items,
      displayPhase,
      showSkeleton: displayPhase === "skeleton",
      contentVisible: displayPhase === "revealed",
      contentInteractive: displayPhase === "revealed",
      hasQualifiedCache: draft.hasQualifiedCache,
      authoritativeEmpty: draft.authoritativeEmpty,
      boundaries: draft.boundaries,
      newBoundary: draft.newBoundary,
      readQualification: {
        readSnapshot: draft.readSnapshot,
        readPositionReady,
        paginationEligible,
        accessDenied: draft.accessDenied,
        revoked: draft.revoked,
        initialLoadError: draft.initialLoadError,
        silentRefreshError: draft.silentRefreshError,
        targetLoadError: draft.targetLoadError,
      },
      revision: draft.revision,
    },
  }
}

function createInitialConversationTimelineState(
  init: ConversationTimelineInit,
): ConversationTimelineState {
  const baseDraft: Omit<ConversationTimelineState, "snapshot" | "firstMessageGrouping"> = {
    channelId: init.channelId,
    viewerUserId: init.viewerUserId ?? null,
    tag: init.tag ?? null,
    canonicalBase: [],
    canonicalById: new Map(),
    overlay: emptyMessageOverlay(),
    hasQualifiedCache: false,
    authoritativeEmpty: false,
    accessQualified: false,
    targetCovered: false,
    reconcilingTarget: false,
    showNewerLoading: false,
    showLeading: true,
    boundaries: {
      hasMoreOlder: false,
      hasMoreNewer: false,
      historyStartKnown: false,
      latestSeq: 0,
      reconciling: false,
    },
    newBoundary: {
      targetSeq: null,
      afterSeq: null,
    },
    readSnapshot: null,
    accessDenied: false,
    revoked: false,
    initialLoadError: null,
    silentRefreshError: null,
    targetLoadError: null,
    revision: 0,
  }
  const { snapshot, firstMessageGrouping } = deriveConversationTimelineSnapshot(baseDraft, null)
  return { ...baseDraft, firstMessageGrouping, snapshot }
}

function finalizeState(
  previous: ConversationTimelineState,
  nextDraft: Omit<ConversationTimelineState, "snapshot" | "firstMessageGrouping" | "revision">,
  effects: MessageOverlayTransition["effects"] = [],
  preserveFirstGrouping = true,
): ConversationTimelineTransitionResult {
  const revision = previous.revision + 1
  const draftWithRevision = { ...nextDraft, revision }
  const { snapshot, firstMessageGrouping } = deriveConversationTimelineSnapshot(
    draftWithRevision,
    preserveFirstGrouping ? previous.firstMessageGrouping : null,
  )
  return {
    state: {
      ...draftWithRevision,
      firstMessageGrouping,
      snapshot,
    },
    effects,
  }
}

function applyOverlayEvent(
  state: ConversationTimelineState,
  event: Exclude<MessageOverlayEvent, { type: "postAck" }>,
  nextCanonicalById: ReadonlyMap<string, CanonicalMessage> = state.canonicalById,
  extraDraft?: Partial<Omit<ConversationTimelineState, "snapshot" | "firstMessageGrouping" | "revision">>,
): ConversationTimelineTransitionResult {
  const transition = reduceMessageOverlay(state.overlay, event, nextCanonicalById)
  return finalizeState(
    state,
    {
      ...state,
      ...extraDraft,
      canonicalById: nextCanonicalById,
      overlay: transition.state,
    },
    transition.effects,
  )
}

function transitionConversationTimeline(
  state: ConversationTimelineState,
  action: ConversationTimelineAction,
): ConversationTimelineTransitionResult {
  switch (action.type) {
    case "hydrateCache": {
      const { payload } = action
      const canonicalBase = mergeTimelinePages(payload.pages)
      const canonicalById = buildCanonicalLookup(
        state.canonicalById,
        canonicalBase,
        payload.relatedMessages,
      )
      const overlayTransition = reduceMessageOverlay(
        state.overlay,
        { type: "baseChanged", messages: canonicalBase },
        canonicalById,
      )
      const hasRows = canonicalBase.length > 0
      const hasQualifiedCache = state.hasQualifiedCache || hasRows || payload.pages.length > 0
      const authoritativeEmpty =
        payload.pages.length > 0 && canonicalBase.length === 0 && payload.accessQualified === true
      const boundaries = deriveBoundaries(payload.pages, canonicalBase, true)
      return finalizeState(
        state,
        {
          ...state,
          canonicalBase,
          canonicalById,
          overlay: overlayTransition.state,
          hasQualifiedCache,
          authoritativeEmpty,
          accessQualified: payload.accessQualified ?? state.accessQualified,
          targetCovered: payload.targetCovered ?? state.targetCovered,
          reconcilingTarget: payload.reconcilingTarget ?? true,
          showNewerLoading: payload.showNewerLoading ?? state.showNewerLoading,
          showLeading: payload.showLeading ?? state.showLeading,
          boundaries,
          newBoundary: deriveNextNewBoundary(state.newBoundary, payload.newBoundary),
          readSnapshot: payload.readSnapshot !== undefined ? payload.readSnapshot : state.readSnapshot,
          accessDenied: false,
          revoked: false,
          initialLoadError: hasRows ? null : state.initialLoadError,
        },
        overlayTransition.effects,
      )
    }

    case "reconcileNetwork": {
      const { payload } = action
      const canonicalBase = mergeTimelinePages(payload.pages)
      const canonicalById = buildCanonicalLookup(
        state.canonicalById,
        canonicalBase,
        payload.relatedMessages,
      )
      const overlayTransition = reduceMessageOverlay(
        state.overlay,
        { type: "baseChanged", messages: canonicalBase },
        canonicalById,
      )
      const hasRows = canonicalBase.length > 0
      const boundaries = deriveBoundaries(payload.pages, canonicalBase, false)
      return finalizeState(
        state,
        {
          ...state,
          canonicalBase,
          canonicalById,
          overlay: overlayTransition.state,
          hasQualifiedCache: state.hasQualifiedCache || hasRows || payload.pages.length > 0,
          authoritativeEmpty: payload.pages.length > 0 && canonicalBase.length === 0,
          accessQualified: payload.accessQualified ?? true,
          targetCovered: payload.targetCovered ?? true,
          reconcilingTarget: payload.reconcilingTarget ?? false,
          showNewerLoading: payload.showNewerLoading ?? state.showNewerLoading,
          showLeading: payload.showLeading ?? state.showLeading,
          boundaries,
          newBoundary: deriveNextNewBoundary(state.newBoundary, payload.newBoundary),
          readSnapshot: payload.readSnapshot !== undefined ? payload.readSnapshot : state.readSnapshot,
          accessDenied: false,
          revoked: false,
          initialLoadError: null,
          silentRefreshError: null,
          targetLoadError: null,
        },
        overlayTransition.effects,
      )
    }

    case "wsMessage": {
      if (state.revoked || state.accessDenied) return { state, effects: [] }
      const canonicalById = buildCanonicalLookup(
        state.canonicalById,
        [],
        action.relatedMessages,
        [action.message],
      )
      const latestSeq = Math.max(state.boundaries.latestSeq, action.message.seq)
      return applyOverlayEvent(
        state,
        { type: "wsMessage", message: action.message },
        canonicalById,
        {
          hasQualifiedCache: true,
          authoritativeEmpty: false,
          boundaries: { ...state.boundaries, latestSeq },
        },
      )
    }

    case "submitOptimistic": {
      if (state.revoked || state.accessDenied) return { state, effects: [] }
      return applyOverlayEvent(
        state,
        { type: "submit", intent: action.intent },
        state.canonicalById,
        { authoritativeEmpty: false },
      )
    }

    case "uploadSettled":
      return applyOverlayEvent(state, {
        type: "uploadSettled",
        nonce: action.nonce,
        attachments: action.attachments,
      })

    case "uploadFailed":
      return applyOverlayEvent(state, { type: "uploadFailed", nonce: action.nonce })

    case "confirmSendAck": {
      const canonicalById = buildCanonicalLookup(
        state.canonicalById,
        [],
        action.relatedMessages,
        [action.message],
      )
      const latestSeq = Math.max(state.boundaries.latestSeq, action.message.seq)
      return applyOverlayEvent(
        state,
        { type: "wsMessage", message: action.message },
        canonicalById,
        {
          hasQualifiedCache: true,
          authoritativeEmpty: false,
          boundaries: { ...state.boundaries, latestSeq },
        },
      )
    }

    case "postFail":
      return applyOverlayEvent(state, { type: "postFail", nonce: action.nonce })

    case "terminalReject":
      return applyOverlayEvent(state, { type: "terminalReject", nonce: action.nonce })

    case "retrySend":
      return applyOverlayEvent(state, { type: "retry", nonce: action.nonce })

    case "dismissFailedSend":
      return applyOverlayEvent(state, { type: "dismissFailed", nonce: action.nonce })

    case "removeMessage": {
      const canonicalBase = state.canonicalBase.filter((message) => message.id !== action.messageId)
      const canonicalById = new Map(state.canonicalById)
      canonicalById.delete(action.messageId)
      return applyOverlayEvent(
        state,
        { type: "messageRemoved", messageId: action.messageId },
        canonicalById,
        { canonicalBase },
      )
    }

    case "recordNetworkError": {
      const hasReadableRows =
        !state.revoked && !state.accessDenied && state.snapshot.messages.length > 0
      if (action.targetOnly) {
        return finalizeState(state, {
          ...state,
          reconcilingTarget: false,
          targetLoadError: action.error,
          boundaries: { ...state.boundaries, reconciling: false },
        })
      }
      if (hasReadableRows) {
        return finalizeState(state, {
          ...state,
          reconcilingTarget: false,
          silentRefreshError: action.error,
          initialLoadError: null,
          boundaries: { ...state.boundaries, reconciling: false },
        })
      }
      return finalizeState(state, {
        ...state,
        reconcilingTarget: false,
        initialLoadError: action.error,
        boundaries: { ...state.boundaries, reconciling: false },
      })
    }

    case "clearErrors":
      return finalizeState(state, {
        ...state,
        initialLoadError: null,
        silentRefreshError: null,
        targetLoadError: null,
      })

    case "retireNewBoundary": {
      const retiredTargetId = action.targetId ?? state.newBoundary.targetId
      if (!retiredTargetId && state.newBoundary.afterSeq === null) return { state, effects: [] }
      return finalizeState(state, {
        ...state,
        newBoundary: {
          targetSeq: null,
          afterSeq: null,
          ...(retiredTargetId ? { retiredTargetId } : {}),
        },
      })
    }

    case "revokeAccess": {
      const clearOverlay = reduceMessageOverlay(state.overlay, { type: "clear" }, state.canonicalById)
      return finalizeState(
        state,
        {
          ...state,
          canonicalBase: [],
          canonicalById: new Map(),
          overlay: clearOverlay.state,
          hasQualifiedCache: false,
          authoritativeEmpty: false,
          accessQualified: false,
          targetCovered: false,
          reconcilingTarget: false,
          accessDenied: action.accessDenied ?? true,
          revoked: true,
          boundaries: {
            hasMoreOlder: false,
            hasMoreNewer: false,
            historyStartKnown: false,
            latestSeq: 0,
            reconciling: false,
          },
        },
        clearOverlay.effects,
        false,
      )
    }

    case "updateViewer":
      if (state.viewerUserId === action.viewerUserId) return { state, effects: [] }
      return finalizeState(
        state,
        { ...state, viewerUserId: action.viewerUserId },
        [],
        false,
      )

    case "setTag":
      if (state.tag === action.tag) return { state, effects: [] }
      return finalizeState(
        state,
        { ...state, tag: action.tag },
        [],
        false,
      )
  }
}

export type ConversationTimelineStore = Readonly<{
  store: Store<ConversationTimelineState>
  getSnapshot: () => ConversationTimelineSnapshot
  dispatch: (action: ConversationTimelineAction) => MessageOverlayTransition["effects"]
}>

export function createConversationTimelineStore(
  init: ConversationTimelineInit,
  onEffects?: (effects: MessageOverlayTransition["effects"]) => void,
): ConversationTimelineStore {
  const store = new Store<ConversationTimelineState>(createInitialConversationTimelineState(init))
  return {
    store,
    getSnapshot: () => store.state.snapshot,
    dispatch: (action) => {
      const result = transitionConversationTimeline(store.state, action)
      if (result.state !== store.state) {
        store.setState(() => result.state)
      }
      if (result.effects.length > 0) {
        onEffects?.(result.effects)
      }
      return result.effects
    },
  }
}
