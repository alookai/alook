"use client"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { useCommunityRuntime, type CommunityRuntime } from "@/stores/community/runtime"


import { useCallback, useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useUserWs,
  type UserWsConnectionPhase,
} from "@/lib/use-user-ws"

import { SEEN_DELIVERY_OPERATION_MAX, SEEN_DELIVERY_OPERATION_TRIM_TO } from "@/stores/community/ws"
import {
  reconcileCommunityWsReconnect,
  reconcileFocusedCommunityMessages,
} from "@/hooks/community/community-ws/reconnect"
import {
  dispatchCommunityWsEvent,
  dispatchCommunityWsEvents,
} from "@/hooks/community/community-ws/registry"
import { reconcileAccountReadState } from "@/hooks/community/community-ws/read-state-reconciliation"
import { scheduleAccountAttentionReconcile } from "@/hooks/community/use-account-attention"
import { getAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
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
  communityBrowserEventBatchType,
  verifyCommunityBrowserEventBatchV2,
  isCommunityBrowserEventBatchCandidate,
  isCommunityEventType,
  TYPING_INDICATOR_THROTTLE_MS,
  type AgentInterruptRequest,
  type CommunityWsEvent,
} from "@alook/shared"
import { trackCommunityWsFrameDropped } from "@/lib/analytics"
import {
  createCommunityWsConnectionStatusController,
  type CommunityWsConnectionStatusController,
} from "@/hooks/community/community-ws/connection-status"
import { drainCommunityFunnelEvents } from "@/lib/community/funnel-analytics"

export type {
  Subscription,
  UseCommunityWsOptions,
} from "@/hooks/community/community-ws/handler-context"

/**
 * Community WebSocket handler.
 *
 * Every event either patches the TanStack Query cache directly (fast — no
 * refetch) or invalidates a query key (slow — triggers refetch). The choice
 * is driven by the reconciliation table in `the community reconciliation table`.
 *
 * State this hook owns *outside* the query cache:
 * - `useCommunityWsStore.presenceByUserId` — transient presence only; durable
 *   profile facts live in TanStack DB.
 * - `useCommunityWsStore.seenMessageIds` — dedup for `message.create`.
 * - `useCommunityStore.typingByScope` + `typingTimers` — typing indicator,
 *   keyed by conversation scope with per-(scope, user) auto-expire timers.
 * - `useCommunityStore.lastTypingSent` — outbound typing.start rate limit.
 *
 * The subscription (which channel/DM is focused) is read from
 * `useCommunityStore.subscription`, not from local component state — that
 * way any consumer can call `runtime.ui.actions.subscribe(...)`
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
    if (event.type === "community:unread.bump" && event.userId === viewerId) {
      inbox = true
      dms ||= !event.serverId
    }
    if (event.type === "community:mention.create" && event.userId === viewerId) inbox = true
  }
  return inbox ? { inbox: true, dms } : null
}

function hasCommunityFunnelTrigger(events: readonly CommunityWsEvent[]) {
  return events.some((event) => event.type === "community:machine.status"
    || event.type === "community:message.create"
    || event.type === "community:member.join")
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
/**
 * Subscribe to a channel/thread/DM. Free helper so any component can update
 * the focused subscription without holding a reference to `useCommunityWs`.
 */
export function communityWsSubscribe(
  runtime: CommunityRuntime,
  target: Pick<Subscription, "channelId" | "dmConversationId">,
) {
  runtime.ui.actions.subscribe(target)
}

export function communityWsUnsubscribe(runtime: CommunityRuntime) {
  runtime.ui.actions.unsubscribe()
}

export function communityWsClaimSecondaryChannel(runtime: CommunityRuntime, owner: symbol, channelId: string) {
  runtime.ui.actions.claimSecondaryChannel(owner, channelId)
}

export function communityWsReleaseSecondaryChannel(runtime: CommunityRuntime, owner: symbol) {
  runtime.ui.actions.releaseSecondaryChannel(owner)
}

export function communityWsInterruptAgent(runtime: CommunityRuntime, agentId: string) {
  if (!runtime.lifecycle.get().active || !runtime.transport.send || !agentId) return
  runtime.transport.send({
    type: "agent:interrupt",
    agentId,
  } satisfies AgentInterruptRequest)
}

/**
 * Send a typing indicator. Client-side debounced at 8s per channelId (a DM is
 * a channel now, so its id is a channelId too). If no WS is connected, the
 * call is a no-op — subsequent connections don't retroactively fire missed
 * typings.
 */
export function communityWsSendTyping(runtime: CommunityRuntime, target: { channelId: string }) {
  if (!runtime.lifecycle.get().active) return
  const key = target.channelId
  if (!key) return
  const send = runtime.transport.send
  if (!send) return

  const now = Date.now()
  const map = runtime.ui.get().lastTypingSent
  const lastSent = map.get(key) || 0
  if (now - lastSent < TYPING_INDICATOR_THROTTLE_MS) return

  map.set(key, now)
  send({ type: "community:typing.start", channelId: key })
}

export function communityWsEndTyping(runtime: CommunityRuntime, target: { channelId: string }) {
  if (!runtime.lifecycle.get().active) return
  const key = target.channelId
  if (!key) return
  const hadActiveBurst = runtime.ui.get().lastTypingSent.delete(key)
  if (hadActiveBurst) runtime.transport.send?.({ type: "community:typing.stop", channelId: key })
}

export function useCommunityWs(options?: UseCommunityWsOptions): void {
  const runtime = useCommunityRuntime()
  const queryClient = useQueryClient()
  const reconnectTransportRef = useRef<() => void>(() => undefined)
  const connectionControllerRef = useRef<CommunityWsConnectionStatusController | null>(null)
  const getConnectionController = useCallback(() => {
    if (connectionControllerRef.current === null) {
      connectionControllerRef.current = createCommunityWsConnectionStatusController({
        publish: runtime.ws.actions.setConnectionStatus,
        reconnectTransport: () => reconnectTransportRef.current(),
      })
    }
    return connectionControllerRef.current
  }, [runtime.ws.actions.setConnectionStatus])
  const handleConnectionStateChange = useCallback((phase: UserWsConnectionPhase) => {
    getConnectionController().handlePhase(phase)
  }, [getConnectionController])
  const viewerUserIdRef = useRef<string | null>(options?.viewerUserId ?? null)
  const hasAuthenticatedRef = useRef(false)
  const viewerUserId = options?.viewerUserId ?? null
  if (viewerUserId) getAccountUnreadProjection(queryClient, viewerUserId)
  viewerUserIdRef.current = viewerUserId
  useEffect(() => {
    if (!viewerUserId) return
    runtime.ws.actions.setPresence(viewerUserId, "online")
  }, [runtime.ws.actions, viewerUserId])

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
    ) {
      /* istanbul ignore next -- the sole timer caller validates and enters synchronously */
      return
    }
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
      /* istanbul ignore next -- the coordinator normalizes every real failure into an outcome */
      consumed = false
      /* istanbul ignore next -- the coordinator normalizes every real failure into an outcome */
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
    async (msg: { type: string;[key: string]: unknown }, assertAdmissionCurrent?: () => void) => {
      if (!msg.type.startsWith("community:")) return
      if (!runtime.lifecycle.get().active) return
      if (msg.type === communityBrowserEventBatchType()) {
        const token = captureCommunityLiveSnapshotToken(queryClient)
        if (!await verifyCommunityBrowserEventBatchV2(msg)) return
        try { assertAdmissionCurrent?.(); assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined) } catch { return }
        if (!runtime.lifecycle.get().active) return
      }
      const communityStore = runtime.ui
      const sub = communityStore.get().subscription
      const wsStore = runtime.ws
      // A DM is a channel now — every message/typing/reaction event carries a
      // single `channelId`. The subscription still tracks two slots so the
      // handler can route a DM channel's events into the `dmMessages` cache vs
      // a regular channel's into `channelMessages` (`sub.dmConversationId`
      // holds the focused DM's channel id). An event is "focused" if its
      // channelId matches either slot.
      const matchesFocus = (e: { channelId?: string }): boolean => {
        if (!e.channelId) return false
        return e.channelId === sub.channelId
          || e.channelId === sub.secondaryChannelId
          || e.channelId === sub.dmConversationId
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
        const operationStatus = runtime.ws.actions.observeDeliveryOperation(
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
        runtime.ws.actions.completeDeliveryOperation(
          decoded.batch.operationId,
          decoded.batch.operationDigest,
        )
        if (hasCommunityFunnelTrigger(decoded.events)) {
          void drainCommunityFunnelEvents()
        }
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
      if (hasCommunityFunnelTrigger([decoded.event])) {
        void drainCommunityFunnelEvents()
      }
    },
    [queryClient, runtime.lifecycle, runtime.ui, runtime.ws, scheduleInboxInvalidate],
  )

  const handleReconnect = useCallback(async ({ reconnectDurationMs }: { reconnectDurationMs: number }) => {
    try {
      await reconcileCommunityWsReconnect(queryClient, reconnectDurationMs, {
        excludePolicies: ["inbox-dms"],
        viewerUserId: viewerUserIdRef.current,
      })
    } finally {
      scheduleAccountAttentionReconcile(queryClient)
    }
  }, [queryClient])
  const handleAuthenticated = useCallback(async () => {
    runtime.ws.actions.markAccessConnected()
    const viewerId = viewerUserIdRef.current
    if (viewerId) {
      runtime.ws.actions.setPresence(viewerId, "online")
    }
    const firstAuthentication = !hasAuthenticatedRef.current
    hasAuthenticatedRef.current = true
    if (firstAuthentication) {
      scheduleAccountAttentionReconcile(queryClient)
    }
    await reconcileAccountReadState(queryClient, { surfaceMode: "non-inbox" })
  }, [queryClient, runtime.ws.actions])
  const handleForeground = useCallback(() => {
    if (inboxRefreshOwner.current?.disposed
      || viewerUserIdRef.current !== viewerUserId
      || (viewerUserId !== null && runtime.ws.get().profileViewerId !== viewerUserId)) return
    return reconcileFocusedCommunityMessages(queryClient)
  }, [queryClient, runtime.ws, viewerUserId])
  const { send, reconnectNow } = useUserWs(handleMessage, {
    onReconnect: handleReconnect,
    onDisconnect: runtime.ws.actions.markAccessDisconnected,
    onAuthenticated: handleAuthenticated,
    onForeground: handleForeground,
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
      if (runtime.ws.get().accessConnected) {
        scheduleAccountAttentionReconcile(queryClient)
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
  }, [queryClient, runtime.ws])

  useEffect(() => {
    if (runtime.transport.send !== null && runtime.transport.send !== send) {
      console.warn(
        "[useCommunityWs] Multiple instances detected — mount this hook once at the tree root.",
      )
    }
    runtime.transport.send = send
    return () => {
      if (runtime.transport.send === send) runtime.transport.send = null
    }
  }, [send, runtime])

  useEffect(() => {
    const controller = getConnectionController()
    const retry = () => controller.reconnectNow()
    runtime.ws.actions.bindReconnectNow(retry)
    return () => {
      controller.dispose()
      if (connectionControllerRef.current === controller) {
        connectionControllerRef.current = null
      }
      if (runtime.ws.get().reconnectNow === retry) {
        runtime.ws.actions.bindReconnectNow(() => undefined)
        runtime.ws.actions.setConnectionStatus("connected")
      }
    }
  }, [getConnectionController, runtime.ws, runtime.ws.actions])

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
