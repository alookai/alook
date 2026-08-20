"use client"

import {
  COMMUNITY_BROWSER_EVENT_MAX_BYTES,
  isCommunityEventCandidate,
  isCommunityEventType,
  type WsMessage,
} from "@alook/shared"
import {
  useRealtimeTransport,
  type RealtimeFramePolicy,
} from "@/platform/client"
import {
  trackCommunityWsFrameDropped,
  type CommunityWsFrameDropReason,
} from "@/lib/analytics"

/**
 * Compatibility shape retained until the three legacy callers move to their
 * owning module transports in Phases 2D, 7C, and 8C.
 */
export type WsMessageIncoming = WsMessage & { [key: string]: unknown }

export type UseUserWsOptions = {
  onReconnect?: (info: { reconnectDurationMs: number }) => void | Promise<void>
  onDisconnect?: () => void | Promise<void>
  onAuthenticated?: () => void | Promise<void>
  requestDaemonStatusOnAuth?: boolean
}

function reportDroppedFrame({
  reason,
  frame,
  byteCount,
}: Readonly<{
  reason: CommunityWsFrameDropReason
  frame?: Record<string, unknown>
  byteCount?: number
}>) {
  const rawType = frame?.type
  const type = isCommunityEventType(rawType) ? rawType : "unknown"
  const rawVersion = frame?.contractVersion
  const contractVersion = typeof rawVersion === "number" && Number.isSafeInteger(rawVersion)
    ? rawVersion
    : undefined
  const metadata = {
    reason,
    type,
    ...(contractVersion === undefined ? {} : { contractVersion }),
    ...(byteCount === undefined ? {} : { byteCount }),
  }
  console.warn("[ws] frame dropped", {
    event: "community_ws_frame_dropped",
    ...metadata,
  })
  trackCommunityWsFrameDropped(metadata)
}

const applyCommunityFramePolicy: RealtimeFramePolicy<
  WsMessageIncoming,
  CommunityWsFrameDropReason
> = ({ frame, rawData }) => {
  if (isCommunityEventCandidate(frame)) {
    const byteCount = new TextEncoder().encode(rawData).byteLength
    if (byteCount > COMMUNITY_BROWSER_EVENT_MAX_BYTES) {
      return { accepted: false, reason: "oversized", byteCount }
    }
  }
  return { accepted: true, frame: frame as WsMessageIncoming }
}

/**
 * Temporary product adapter around the generic browser transport.
 *
 * Community-specific frame limits, event classification, drop analytics, and
 * the historical daemon-status request stay here. Socket lifecycle, auth,
 * liveness, generation fencing, reconnect, visibility, and URL mechanics are
 * owned by `platform/client/realtime`.
 */
export function useUserWs(
  onMessage: (msg: WsMessageIncoming) => void,
  options?: UseUserWsOptions,
): { send: (msg: object) => void } {
  return useRealtimeTransport<WsMessageIncoming, CommunityWsFrameDropReason>({
    onMessage,
    onReconnect: options?.onReconnect,
    onDisconnect: options?.onDisconnect,
    onAuthenticated: options?.onAuthenticated,
    authenticatedFrames: options?.requestDaemonStatusOnAuth === false
      ? []
      : [{ type: "check_daemon_status" }],
    framePolicy: applyCommunityFramePolicy,
    onFrameDropped: reportDroppedFrame,
  })
}
