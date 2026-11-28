import type {
  BotImQrStatus,
  BotImQrStatusResponse,
  BotTriggerConnectionStatus,
  BotWebhookSummary,
  CommunityBotImStatus,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import type { PresenceMachineEventContext } from "./handler-context"

function mapStatusToQrStatus(status: CommunityBotImStatus["status"]): BotImQrStatus {
  switch (status) {
    case "pending":
    case "scanned":
    case "confirmed":
    case "expired":
    case "error":
      return status
    case "connected":
      return "confirmed"
    case "session_expired":
      return "expired"
    case "scan_required":
      return "idle"
  }
}

function mapStatusToConnectionStatus(
  status: CommunityBotImStatus["status"],
  fallback: BotTriggerConnectionStatus = "scan_required",
): BotTriggerConnectionStatus {
  switch (status) {
    case "confirmed":
    case "connected":
      return "connected"
    case "session_expired":
      return "session_expired"
    case "error":
      return "error"
    case "scan_required":
    case "expired":
      return "scan_required"
    case "pending":
    case "scanned":
      return fallback
  }
}

export function handleBotImStatus(
  event: CommunityBotImStatus,
  { queryClient }: PresenceMachineEventContext,
) {
  const qrKey = communityKeys.botImQrStatus(event.botId, event.triggerId)
  const webhooksKey = communityKeys.botWebhooks(event.botId)
  const qrStatus = mapStatusToQrStatus(event.status)

  queryClient.setQueryData<BotImQrStatusResponse>(qrKey, (current) => {
    const connectionStatus = mapStatusToConnectionStatus(
      event.status,
      current?.connectionStatus ?? "scan_required",
    )
    return {
      triggerId: event.triggerId,
      connectionStatus,
      qrStatus,
      sessionId: event.sessionId !== undefined ? event.sessionId : (current?.sessionId ?? null),
      qrUrl: event.qrUrl !== undefined ? event.qrUrl : (current?.qrUrl ?? null),
      expiresAt: event.expiresAt !== undefined ? event.expiresAt : (current?.expiresAt ?? null),
      botAccountLabel:
        event.botAccountLabel !== undefined
          ? event.botAccountLabel
          : (current?.botAccountLabel ?? null),
      error: event.error !== undefined ? event.error : (event.status === "error" ? (current?.error ?? null) : null),
    }
  })

  queryClient.setQueryData<{ webhooks: BotWebhookSummary[] }>(webhooksKey, (current) => {
    if (!current) return current
    return {
      webhooks: current.webhooks.map((item) => {
        if (item.id !== event.triggerId) return item
        const nextConnectionStatus = item.enabled
          ? mapStatusToConnectionStatus(event.status, item.connectionStatus)
          : "paused"
        return {
          ...item,
          connectionStatus: nextConnectionStatus,
          ...(event.botAccountLabel !== undefined ? { botAccountLabel: event.botAccountLabel } : {}),
          ...(event.error !== undefined ? { daemonLastError: event.error } : {}),
          ...(event.status === "confirmed" || event.status === "connected"
            ? { daemonLastError: null }
            : {}),
        }
      }),
    }
  })

  if (
    event.status === "confirmed" ||
    event.status === "connected" ||
    event.status === "session_expired" ||
    event.status === "error"
  ) {
    void queryClient.invalidateQueries({ queryKey: webhooksKey, exact: true }).catch(() => undefined)
  }
}
