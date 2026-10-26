"use client"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { bindCommunityTransport, useCommunityRuntime, type CommunityRuntime } from "@/stores/community/runtime"


import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { cancelMessageRepairs } from "@/hooks/community/community-ws/reconnect-messages"
import {
  useUserWs,
  type UserWsConnectionPhase,
} from "@/lib/use-user-ws"

import {
  reconcileCommunityWsReconnect,
  reconcileFocusedCommunityMessages,
} from "@/hooks/community/community-ws/reconnect"
import {
  dispatchCommunityWsEvent,
  dispatchCommunityWsEvents,
} from "@/hooks/community/community-ws/registry"
import { reconcileAccountReadState } from "@/hooks/community/community-ws/read-state-reconciliation"
import type {
  CommunityWsDispatchContext,
  Subscription,
  UseCommunityWsOptions,
} from "@/hooks/community/community-ws/handler-context"
import {
  decodeCommunityBrowserEvent,
  communityBrowserEventBatchType,
  admitCommunityBrowserEventBatch,
  isCommunityBrowserEventBatchCandidate,
  isCommunityEventType,
  TYPING_INDICATOR_THROTTLE_MS,
  type AgentInterruptRequest,
  type CommunityWsEvent,
  type CommunityContract,
} from "@alook/shared"
import { trackCommunityWsFrameDropped } from "@/lib/analytics"
import {
  createCommunityWsConnectionStatusController,
  type CommunityWsConnectionStatusController,
} from "@/hooks/community/community-ws/connection-status"
import { ANALYTICS_CONSENT_CHANGE_EVENT } from "@/lib/analytics-consent"
import { drainCommunityFunnelEvents, drainInvitedHumanJoined } from "@/lib/community/funnel-analytics"

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

function hasCommunityFunnelTrigger(events: readonly CommunityWsEvent[]) {
  return events.some((event) => event.type === "community:machine.status"
    || event.type === "community:message.create"
    || event.type === "community:member.join")
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
    if (phase === "suspended") void cancelMessageRepairs(queryClient)
    getConnectionController().handlePhase(phase)
  }, [getConnectionController, queryClient])
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      void cancelMessageRepairs(queryClient, true)
    })
    return () => { unsubscribe(); void cancelMessageRepairs(queryClient) }
  }, [queryClient])
  const viewerUserIdRef = useRef<string | null>(options?.viewerUserId ?? null)
  const viewerUserId = options?.viewerUserId ?? null
  const viewToken = useMemo(() => ({ queryClient, runtime, viewerUserId }), [queryClient, runtime, viewerUserId])
  const activeViewRef = useRef<typeof viewToken | null>(null)

  useLayoutEffect(() => {
    viewerUserIdRef.current = viewerUserId
    activeViewRef.current = viewToken
    return () => { if (activeViewRef.current === viewToken) activeViewRef.current = null }
  }, [viewerUserId, viewToken])
  useEffect(() => {
    if (!viewerUserId) return
    runtime.ws.actions.setPresence(viewerUserId, "online")
  }, [runtime.ws.actions, viewerUserId])

  const handleMessage = useCallback(
    async (msg: { type: string;[key: string]: unknown }, assertAdmissionCurrent?: () => void, contract: CommunityContract = 2) => {
      if (!msg.type.startsWith("community:")) return
      if (activeViewRef.current !== viewToken || !runtime.lifecycle.get().active) return
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
      ): CommunityWsDispatchContext => ({
        contract,
        deliveryMode,
        queryClient,
        communityStore,
        wsStore,
        sub,
        viewerUserIdRef,
        matchesFocus,
      })
      const reconcileAfterBatchFailure = (
        reason: "digest-conflict" | "projection-failed",
      ) => {
        void reconcileCommunityWsReconnect(
          queryClient,
          0,
        ).catch(() => {
          console.warn("[ws] batch reconciliation failed", {
            event: "community_ws_batch_reconciliation_failed",
            reason,
          })
        })
      }

      if (isCommunityBrowserEventBatchCandidate(msg)) {
        if (msg.type !== communityBrowserEventBatchType(contract)
          && !(contract === 2 && msg.type === communityBrowserEventBatchType(1))) {
          trackCommunityWsFrameDropped({ reason: "invalid-payload", type: msg.type })
          return
        }
        const token = captureCommunityLiveSnapshotToken(queryClient)
        const admission = admitCommunityBrowserEventBatch(msg)
        const decoded = admission instanceof Promise ? await admission : admission
        try { assertAdmissionCurrent?.(); assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined) } catch { return }
        if (activeViewRef.current !== viewToken || !runtime.lifecycle.get().active) return
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
        if (operationStatus === "duplicate") return
        if (operationStatus === "conflict") {
          console.warn("[ws] delivery operation digest conflict", {
            event: "community_ws_delivery_operation_conflict",
            operationId: decoded.batch.operationId,
            operationDigest: decoded.batch.operationDigest,
            eventCount: decoded.events.length,
          })
          reconcileAfterBatchFailure("digest-conflict")
          return
        }
        try {
          const publication = dispatchCommunityWsEvents(
            decoded.events,
            context("batch"),
          )
          if (publication) await publication
        } catch {
          console.warn("[ws] delivery operation projection failed", {
            event: "community_ws_delivery_operation_projection_failed",
            operationId: decoded.batch.operationId,
            operationDigest: decoded.batch.operationDigest,
            eventCount: decoded.events.length,
          })
          reconcileAfterBatchFailure("projection-failed")
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
        runtime.ws.actions.completeDeliveryOperation(
          decoded.batch.operationId,
          decoded.batch.operationDigest,
        )
        if (hasCommunityFunnelTrigger(decoded.events)) {
          void drainCommunityFunnelEvents()
          void drainInvitedHumanJoined(runtime.lifecycle)
        }
        return
      }

      const decoded = decodeCommunityBrowserEvent(msg, contract)
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
      await dispatchCommunityWsEvent(decoded.event, context("single"))
      if (hasCommunityFunnelTrigger([decoded.event])) {
        void drainCommunityFunnelEvents()
        void drainInvitedHumanJoined(runtime.lifecycle)
      }
    },
    [queryClient, runtime.lifecycle, runtime.ui, runtime.ws, viewToken],
  )

  const handleReconnect = useCallback(async ({ reconnectDurationMs }: { reconnectDurationMs: number }) => {
    if (activeViewRef.current !== viewToken || !runtime.lifecycle.get().active) return
    await reconcileCommunityWsReconnect(queryClient, reconnectDurationMs, { viewerUserId: viewerUserIdRef.current })
  }, [queryClient, runtime.lifecycle, viewToken])
  const handleAuthenticated = useCallback(async () => {
    if (activeViewRef.current !== viewToken || !runtime.lifecycle.get().active) return
    void drainInvitedHumanJoined(runtime.lifecycle)
    runtime.ws.actions.markAccessConnected()
    const viewerId = viewerUserIdRef.current
    if (viewerId) {
      runtime.ws.actions.setPresence(viewerId, "online")
    }
    await reconcileAccountReadState(queryClient)
  }, [queryClient, runtime.ws.actions, runtime.lifecycle, viewToken])
  const handleForeground = useCallback(() => {
    if (activeViewRef.current !== viewToken || !runtime.lifecycle.get().active
      || viewerUserIdRef.current !== viewerUserId
      || (viewerUserId !== null && runtime.ws.get().profileViewerId !== viewerUserId)) return
    return reconcileFocusedCommunityMessages(queryClient)
  }, [queryClient, runtime.ws, runtime.lifecycle, viewerUserId, viewToken])
  const { send, reconnectNow } = useUserWs(handleMessage, {
    viewerUserId,
    communityContract: options?.communityContract,
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
    const drain = () => { void drainInvitedHumanJoined(runtime.lifecycle) }
    window.addEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, drain)
    return () => window.removeEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, drain)
  }, [runtime.lifecycle])

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return
    const reconcileVisible = () => {
      if (activeViewRef.current !== viewToken || !runtime.lifecycle.get().active || document.visibilityState !== "visible") return
      void reconcileAccountReadState(queryClient).catch(() => undefined)
    }
    document.addEventListener("visibilitychange", reconcileVisible)
    window.addEventListener("pageshow", reconcileVisible)
    return () => {
      document.removeEventListener("visibilitychange", reconcileVisible)
      window.removeEventListener("pageshow", reconcileVisible)
    }
  }, [queryClient, runtime.lifecycle, viewToken])

  useEffect(() => bindCommunityTransport(runtime, send), [send, runtime])

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

}
