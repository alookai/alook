"use client"

import { useCallback, useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useUserWs,
  type UserWsConnectionPhase,
} from "@/lib/use-user-ws"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
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
  CommunityWsDispatchContext,
  Subscription,
  UseCommunityWsOptions,
} from "@/hooks/community/community-ws/handler-context"
import {
  decodeCommunityBrowserEvent,
  decodeCommunityBrowserEventBatch,
  isCommunityBrowserEventBatchCandidate,
  isCommunityEventType,
  TYPING_INDICATOR_THROTTLE_MS,
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
  useEffect(() => {
    viewerUserIdRef.current = options?.viewerUserId ?? null
  })

  // Debounced inbox invalidation. Grouping repeated invalidations into one
  // refetch cycle keeps the popover from re-rendering on every message tick.
  const inboxDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleInboxInvalidate = useCallback(() => {
    if (inboxDebounce.current) return
    inboxDebounce.current = setTimeout(() => {
      inboxDebounce.current = null
      runCommunityWsProjectionTransaction(queryClient, (projection) => {
        invalidateInbox(projection)
        // A DM is a channel now, so a DM message arrives as `message.create`
        // with no discriminator distinguishing it from a channel message. Fold
        // the old `dm.new_message` DM-sidebar refresh in here: invalidate the
        // DM list too so an unread DM's preview/unread flag updates live. Cheap
        // — `communityKeys.dms()` is only observed under the `/c/me` layout, so
        // this is a no-op (marks stale, no refetch) while viewing a server
        // channel where the DM sidebar isn't mounted.
        invalidateDms(projection)
      })
    }, INBOX_INVALIDATE_DEBOUNCE_MS)
  }, [queryClient])

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
      const context = (deliveryMode: "single" | "batch"): CommunityWsDispatchContext => ({
        deliveryMode,
        queryClient,
        communityStore,
        wsStore,
        sub,
        viewerUserIdRef,
        matchesFocus,
        scheduleInboxInvalidate,
      })
      const reconcileAfterBatchFailure = (reason: "digest-conflict" | "projection-failed") => {
        void reconcileCommunityWsReconnect(queryClient, 0).catch(() => {
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
          dispatchCommunityWsEvents(decoded.events, context("batch"))
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
    await reconcileCommunityWsReconnect(queryClient, reconnectDurationMs)
  }, [queryClient])
  const handleAuthenticated = useCallback(async () => {
    useCommunityWsStore.getState().markAccessConnected()
    await reconcileAccountReadState(queryClient)
  }, [queryClient])
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
      void reconcileAccountReadState(queryClient).catch(() => undefined)
    }
    document.addEventListener("visibilitychange", reconcileVisible)
    window.addEventListener("pageshow", reconcileVisible)
    return () => {
      document.removeEventListener("visibilitychange", reconcileVisible)
      window.removeEventListener("pageshow", reconcileVisible)
    }
  }, [queryClient])

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

  // Cleanup: flush the inbox debounce if the hook unmounts mid-window so the
  // parent surface doesn't leave a scheduled fetch dangling.
  useEffect(() => {
    return () => {
      if (inboxDebounce.current) {
        clearTimeout(inboxDebounce.current)
        inboxDebounce.current = null
      }
    }
  }, [])
}
