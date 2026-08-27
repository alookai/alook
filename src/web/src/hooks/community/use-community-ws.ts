"use client"

import { useCallback, useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useUserWs,
  type UserWsConnectionPhase,
} from "@/lib/use-user-ws"
import { useCommunityStore } from "@/stores/community"
import {
  SEEN_DELIVERY_OPERATION_MAX,
  SEEN_DELIVERY_OPERATION_TRIM_TO,
  useCommunityWsStore,
} from "@/stores/community/ws"
import { reconcileCommunityWsReconnect } from "@/hooks/community/community-ws/reconnect"
import {
  dispatchCommunityWsEvent,
  dispatchCommunityWsEvents,
} from "@/hooks/community/community-ws/registry"
import { reconcileAccountReadState } from "@/hooks/community/community-ws/read-state-reconciliation"
import { runCommunityWsProjectionTransaction } from "@/hooks/community/community-ws/projection-transaction"
import {
  invalidateDms,
  invalidateInbox,
} from "@/hooks/community/community-ws/invalidation-projections"
import type {
  CommunityInboxRefreshRequest,
  CommunityWsDispatchContext,
  Subscription,
  UseCommunityWsOptions,
} from "@/hooks/community/community-ws/handler-context"
import { flushPendingReadIntents } from "@/hooks/community/read-coordinator"
import {
  decodeCommunityBrowserEvent,
  decodeCommunityBrowserEventBatch,
  isCommunityBrowserEventBatchCandidate,
  isCommunityEventType,
  TYPING_INDICATOR_THROTTLE_MS,
  type CommunityWsEvent,
} from "@alook/shared"
import { trackCommunityWsFrameDropped } from "@/lib/analytics"
import {
  createCommunityWsConnectionStatusController,
  type CommunityWsConnectionStatusController,
} from "@/hooks/community/community-ws/connection-status"

export type {
  Subscription,
  UseCommunityWsOptions,
} from "@/hooks/community/community-ws/handler-context"

/**
 * Community WebSocket handler.
 *
 * Every event either patches the TanStack Query cache directly (fast — no
 * refetch) or invalidates a query key (slow — triggers refetch). The choice
 * is driven by the reconciliation table in `plans/21-community-tech-debt-pass-2.md`.
 *
 * State this hook owns *outside* the query cache:
 * - `useCommunityWsStore.onlineUserIds` — presence set, WS-only.
 * - `useCommunityWsStore.seenMessageIds` — dedup for `message.create`.
 * - `useCommunityStore.typingByScope` + `typingTimers` — typing indicator,
 *   keyed by conversation scope with per-(scope, user) auto-expire timers.
 * - `useCommunityStore.lastTypingSent` — outbound typing.start rate limit.
 *
 * The subscription (which channel/DM is focused) is read from
 * `useCommunityStore.subscription`, not from local component state — that
 * way any consumer can call `useCommunityStore.getState().subscribe(...)`
 * and the WS handler picks it up on the next event.
 */

// ── Constants ─────────────────────────────────────────────────────────────

// Debounce inbox invalidation so a busy channel doesn't fire one refetch per
// message. 500ms matches the mark-channel-read debounce so both fire once per
// message burst.
const INBOX_INVALIDATE_DEBOUNCE_MS = 500

type InboxRefreshGeneration = CommunityInboxRefreshRequest & {
  id: number
  dueAt: number
}

type InboxRefreshOwner = {
  current: InboxRefreshGeneration | null
  next: InboxRefreshGeneration | null
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  nextGenerationId: number
  epoch: number
  claimedOperationKeys: Set<string>
  claimedOperationOrder: string[]
  disposed: boolean
}

function mergeInboxRefresh(
  target: CommunityInboxRefreshRequest,
  incoming: CommunityInboxRefreshRequest,
) {
  target.dms ||= incoming.dms
}

function deliveryInboxRefresh(
  events: readonly CommunityWsEvent[],
  viewerId: string | null,
): CommunityInboxRefreshRequest | null {
  let inbox = false
  let dms = false
  for (const event of events) {
    if (
      event.type === "community:message.create"
      && event.message.authorId !== viewerId
    ) {
      inbox = true
      dms = true
    }
    if (event.type === "community:mention.create") inbox = true
  }
  return inbox ? { inbox: true, dms } : null
}

function claimInboxRefreshOperation(owner: InboxRefreshOwner, key: string) {
  if (owner.claimedOperationKeys.has(key)) return false
  owner.claimedOperationKeys.add(key)
  owner.claimedOperationOrder.push(key)
  if (owner.claimedOperationOrder.length > SEEN_DELIVERY_OPERATION_MAX) {
    const retained = owner.claimedOperationOrder.slice(-SEEN_DELIVERY_OPERATION_TRIM_TO)
    owner.claimedOperationOrder = retained
    owner.claimedOperationKeys = new Set(retained)
  }
  return true
}

function armInboxRefreshGeneration(
  owner: InboxRefreshOwner,
  generation: InboxRefreshGeneration,
  run: (generation: InboxRefreshGeneration, epoch: number) => Promise<void>,
) {
  if (owner.disposed) return
  owner.timer = setTimeout(() => {
    if (owner.disposed) return
    owner.timer = null
    owner.running = true
    void run(generation, owner.epoch)
  }, Math.max(0, generation.dueAt - Date.now()))
}

// ── Public hook ────────────────────────────────────────────────────────────

// Module-level slot for the currently-active WS `send`. The root-mounted
// `useCommunityWs` writes into this on connect so free helpers below can
// dispatch typing events without needing to re-mount the hook (which would
// open a second WebSocket per consumer). Cleared on unmount.
let activeSend: ((msg: object) => void) | null = null

/** Testing hook — clears the module-scoped `activeSend` binding. */
export function _resetActiveSend_forTesting() {
  activeSend = null
}

/**
 * Subscribe to a channel/thread/DM. Free helper so any component can update
 * the focused subscription without holding a reference to `useCommunityWs`.
 */
export function communityWsSubscribe(target: Subscription) {
  useCommunityStore.getState().subscribe(target)
}

export function communityWsUnsubscribe() {
  useCommunityStore.getState().unsubscribe()
}

/**
 * Send a typing indicator. Client-side debounced at 8s per channelId (a DM is
 * a channel now, so its id is a channelId too). If no WS is connected, the
 * call is a no-op — subsequent connections don't retroactively fire missed
 * typings.
 */
export function communityWsSendTyping(target: { channelId: string }) {
  const key = target.channelId
  if (!key) return
  const send = activeSend
  if (!send) return

  const now = Date.now()
  const map = useCommunityStore.getState().lastTypingSent
  const lastSent = map.get(key) || 0
  if (now - lastSent < TYPING_INDICATOR_THROTTLE_MS) return

  map.set(key, now)
  send({ type: "community:typing.start", channelId: key })
}

/**
 * Reset the outbound typing.start throttle for a channel. Sending a message
 * ends the current typing burst; the very next keystroke should re-emit
 * typing.start immediately, not wait out the 8s dedup window.
 */
export function communityWsResetTypingThrottle(target: { channelId: string }) {
  const key = target.channelId
  if (!key) return
  useCommunityStore.getState().lastTypingSent.delete(key)
}

export function useCommunityWs(options?: UseCommunityWsOptions): void {
  const queryClient = useQueryClient()
  const reconnectTransportRef = useRef<() => void>(() => undefined)
  const connectionControllerRef = useRef<CommunityWsConnectionStatusController | null>(null)
  const getConnectionController = useCallback(() => {
    if (connectionControllerRef.current === null) {
      connectionControllerRef.current = createCommunityWsConnectionStatusController({
        publish: useCommunityWsStore.getState().setConnectionStatus,
        reconnectTransport: () => reconnectTransportRef.current(),
      })
    }
    return connectionControllerRef.current
  }, [])
  const handleConnectionStateChange = useCallback((phase: UserWsConnectionPhase) => {
    getConnectionController().handlePhase(phase)
  }, [getConnectionController])
  const viewerUserIdRef = useRef<string | null>(options?.viewerUserId ?? null)
  const hasAuthenticatedRef = useRef(false)
  useEffect(() => {
    viewerUserIdRef.current = options?.viewerUserId ?? null
  })

  const inboxRefreshOwner = useRef<InboxRefreshOwner | null>(null)
  if (inboxRefreshOwner.current === null) {
    inboxRefreshOwner.current = {
      current: null,
      next: null,
      timer: null,
      running: false,
      nextGenerationId: 0,
      epoch: 0,
      claimedOperationKeys: new Set(),
      claimedOperationOrder: [],
      disposed: false,
    }
  }
  const runInboxGeneration = useCallback(async function runInboxGeneration(
    generation: InboxRefreshGeneration,
    epoch: number,
  ) {
    const owner = inboxRefreshOwner.current
    if (
      !owner
      || owner.disposed
      || owner.epoch !== epoch
      || owner.current?.id !== generation.id
    ) return
    let consumed = false
    let deferred = false
    try {
      const outcome = await flushPendingReadIntents(queryClient, {
        deferInboxDms: () => {
          const latest = inboxRefreshOwner.current
          return latest?.epoch === epoch
            && latest.current?.id === generation.id
            && latest.next !== null
        },
      })
      consumed = outcome.consumed
      deferred = outcome.deferred === true
    } catch {
      consumed = false
      deferred = false
    }
    const current = inboxRefreshOwner.current
    if (
      !current
      || current.disposed
      || current.epoch !== epoch
      || current.current?.id !== generation.id
    ) return
    if (deferred && current.next) mergeInboxRefresh(current.next, generation)
    if (!consumed && !deferred) {
      runCommunityWsProjectionTransaction(queryClient, (projection) => {
        if (generation.inbox) invalidateInbox(projection)
        if (generation.dms) invalidateDms(projection)
      })
    }
    current.current = current.next
    current.next = null
    current.running = false
    if (current.current) {
      armInboxRefreshGeneration(current, current.current, runInboxGeneration)
    }
  }, [queryClient])
  const scheduleInboxInvalidate = useCallback((
    request: CommunityInboxRefreshRequest,
    operationKey?: string,
  ) => {
    const owner = inboxRefreshOwner.current
    if (!owner || owner.disposed) return
    if (operationKey && !claimInboxRefreshOperation(owner, operationKey)) return
    if (owner.current === null) {
      owner.current = {
        ...request,
        id: ++owner.nextGenerationId,
        dueAt: Date.now() + INBOX_INVALIDATE_DEBOUNCE_MS,
      }
      armInboxRefreshGeneration(owner, owner.current, runInboxGeneration)
      return
    }
    if (!owner.running) {
      mergeInboxRefresh(owner.current, request)
      return
    }
    if (owner.next === null) {
      owner.next = {
        ...request,
        id: ++owner.nextGenerationId,
        dueAt: Date.now() + INBOX_INVALIDATE_DEBOUNCE_MS,
      }
      return
    }
    mergeInboxRefresh(owner.next, request)
  }, [runInboxGeneration])

  const handleMessage = useCallback(
    (msg: { type: string;[key: string]: unknown }) => {
      if (!msg.type.startsWith("community:")) return
      const communityStore = useCommunityStore.getState()
      const sub = communityStore.subscription
      const wsStore = useCommunityWsStore.getState()
      // A DM is a channel now — every message/typing/reaction event carries a
      // single `channelId`. The subscription still tracks two slots so the
      // handler can route a DM channel's events into the `dmMessages` cache vs
      // a regular channel's into `channelMessages` (`sub.dmConversationId`
      // holds the focused DM's channel id). An event is "focused" if its
      // channelId matches either slot.
      const matchesFocus = (e: { channelId?: string }): boolean => {
        if (!e.channelId) return false
        return e.channelId === sub.channelId || e.channelId === sub.dmConversationId
      }
      const context = (
        deliveryMode: "single" | "batch",
        requestInboxRefresh = scheduleInboxInvalidate,
      ): CommunityWsDispatchContext => ({
        deliveryMode,
        queryClient,
        communityStore,
        wsStore,
        sub,
        viewerUserIdRef,
        matchesFocus,
        scheduleInboxInvalidate: requestInboxRefresh,
      })
      const reconcileAfterBatchFailure = (
        reason: "digest-conflict" | "projection-failed",
        inboxOwned: boolean,
      ) => {
        void reconcileCommunityWsReconnect(
          queryClient,
          0,
          inboxOwned ? { excludePolicies: ["inbox-dms"] } : undefined,
        ).catch(() => {
          console.warn("[ws] batch reconciliation failed", {
            event: "community_ws_batch_reconciliation_failed",
            reason,
          })
        })
      }

      if (isCommunityBrowserEventBatchCandidate(msg)) {
        const decoded = decodeCommunityBrowserEventBatch(msg)
        if (!decoded.ok) {
          const reason = decoded.reason === "oversized" ? "oversized" : "invalid-payload"
          const metadata = {
            reason,
            type: msg.type,
            ...(decoded.byteLength === undefined ? {} : { byteCount: decoded.byteLength }),
          } as const
          console.warn("[ws] frame dropped", {
            event: "community_ws_frame_dropped",
            ...metadata,
          })
          trackCommunityWsFrameDropped(metadata)
          return
        }
        const operationStatus = wsStore.observeDeliveryOperation(
          decoded.batch.operationId,
          decoded.batch.operationDigest,
        )
        const batchRefresh = deliveryInboxRefresh(
          decoded.events,
          viewerUserIdRef.current,
        )
        const operationKey = `delivery:${decoded.batch.operationId}:${decoded.batch.operationDigest}`
        if (operationStatus === "duplicate") return
        if (operationStatus === "conflict") {
          console.warn("[ws] delivery operation digest conflict", {
            event: "community_ws_delivery_operation_conflict",
            operationId: decoded.batch.operationId,
            operationDigest: decoded.batch.operationDigest,
            eventCount: decoded.events.length,
          })
          if (batchRefresh) {
            scheduleInboxInvalidate(
              batchRefresh,
              `conflict:${decoded.batch.operationId}:${decoded.batch.operationDigest}`,
            )
          }
          reconcileAfterBatchFailure("digest-conflict", batchRefresh !== null)
          return
        }
        let collectedRefresh: CommunityInboxRefreshRequest | null = null
        const collectInboxRefresh = (request: CommunityInboxRefreshRequest) => {
          if (collectedRefresh === null) {
            collectedRefresh = { ...request }
          } else {
            mergeInboxRefresh(collectedRefresh, request)
          }
        }
        try {
          dispatchCommunityWsEvents(
            decoded.events,
            context("batch", collectInboxRefresh),
          )
        } catch {
          console.warn("[ws] delivery operation projection failed", {
            event: "community_ws_delivery_operation_projection_failed",
            operationId: decoded.batch.operationId,
            operationDigest: decoded.batch.operationDigest,
            eventCount: decoded.events.length,
          })
          if (batchRefresh) scheduleInboxInvalidate(batchRefresh, operationKey)
          reconcileAfterBatchFailure("projection-failed", batchRefresh !== null)
          return
        }
        // Complete dedup only after every child projected successfully. The
        // first valid frame already locked operationId -> digest above, so a
        // conflicting digest fails closed even while this operation remains
        // observed but incomplete/retryable after a projection failure.
        // Browser projections are not rollback-capable: a later child can
        // throw after an earlier child updated a Zustand/query-cache overlay.
        // Keeping the failed operation locked but incomplete lets the
        // identical bundle retry, so idempotent child projections can finish
        // converging even when authoritative reconnect reconciliation fails.
        if (collectedRefresh) scheduleInboxInvalidate(collectedRefresh, operationKey)
        wsStore.completeDeliveryOperation(
          decoded.batch.operationId,
          decoded.batch.operationDigest,
        )
        return
      }

      const decoded = decodeCommunityBrowserEvent(msg)
      if (!decoded.ok) {
        const metadata = {
          reason: decoded.reason,
          type: isCommunityEventType(msg.type) ? msg.type : "unknown",
        } as const
        console.warn("[ws] frame dropped", {
          event: "community_ws_frame_dropped",
          ...metadata,
        })
        trackCommunityWsFrameDropped(metadata)
        return
      }
      dispatchCommunityWsEvent(decoded.event, context("single"))
    },
    [queryClient, scheduleInboxInvalidate],
  )

  const handleReconnect = useCallback(async ({ reconnectDurationMs }: { reconnectDurationMs: number }) => {
    try {
      await reconcileCommunityWsReconnect(queryClient, reconnectDurationMs, {
        excludePolicies: ["inbox-dms"],
      })
    } finally {
      scheduleInboxInvalidate({ inbox: true, dms: true })
    }
  }, [queryClient, scheduleInboxInvalidate])
  const handleAuthenticated = useCallback(async () => {
    useCommunityWsStore.getState().markAccessConnected()
    const firstAuthentication = !hasAuthenticatedRef.current
    hasAuthenticatedRef.current = true
    if (firstAuthentication) {
      scheduleInboxInvalidate({ inbox: true, dms: true })
    }
    await reconcileAccountReadState(queryClient, { surfaceMode: "non-inbox" })
  }, [queryClient, scheduleInboxInvalidate])
  const { send, reconnectNow } = useUserWs(handleMessage, {
    onReconnect: handleReconnect,
    onDisconnect: useCommunityWsStore.getState().markAccessDisconnected,
    onAuthenticated: handleAuthenticated,
    onConnectionStateChange: handleConnectionStateChange,
    requestDaemonStatusOnAuth: false,
  })
  useEffect(() => {
    reconnectTransportRef.current = reconnectNow
  }, [reconnectNow])

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return
    const reconcileVisible = () => {
      if (document.visibilityState !== "visible") return
      if (useCommunityWsStore.getState().accessConnected) {
        scheduleInboxInvalidate({ inbox: true, dms: true })
      }
      void reconcileAccountReadState(queryClient, {
        surfaceMode: "non-inbox",
      }).catch(() => undefined)
    }
    document.addEventListener("visibilitychange", reconcileVisible)
    window.addEventListener("pageshow", reconcileVisible)
    return () => {
      document.removeEventListener("visibilitychange", reconcileVisible)
      window.removeEventListener("pageshow", reconcileVisible)
    }
  }, [queryClient, scheduleInboxInvalidate])

  // Publish the send binding so free helpers (`communityWsSendTyping`) can
  // dispatch without holding a hook reference. Single-instance assumption
  // matches the "mount at tree root" contract; if a second call site invoked
  // the hook, the last one would win. Cleared on unmount.
  useEffect(() => {
    // #15: warn if a second hook instance has mounted while another is still
    // active. Two live subscribers would each publish their own `send` into
    // this module slot — the second mount overwrites the first, and the
    // first's cleanup then clears the slot mid-flight (see the `activeSend
    // === send` check below). Whoever added the second mount site should
    // co-locate them under a single root-level `useCommunityWs()` call.
    if (activeSend !== null && activeSend !== send) {
      console.warn(
        "[useCommunityWs] Multiple instances detected — mount this hook once at the tree root.",
      )
    }
    activeSend = send
    return () => {
      if (activeSend === send) activeSend = null
    }
  }, [send])

  useEffect(() => {
    const controller = getConnectionController()
    const retry = () => controller.reconnectNow()
    useCommunityWsStore.getState().bindReconnectNow(retry)
    return () => {
      controller.dispose()
      if (connectionControllerRef.current === controller) {
        connectionControllerRef.current = null
      }
      const store = useCommunityWsStore.getState()
      if (store.reconnectNow === retry) {
        store.bindReconnectNow(() => undefined)
        store.setConnectionStatus("connected")
      }
    }
  }, [getConnectionController])

  useEffect(() => {
    const owner = inboxRefreshOwner.current
    if (owner) owner.disposed = false
    return () => {
      const current = inboxRefreshOwner.current
      if (!current) return
      current.disposed = true
      current.epoch += 1
      if (current.timer !== null) clearTimeout(current.timer)
      current.timer = null
      current.current = null
      current.next = null
      current.running = false
    }
  }, [])
}
