export type DesktopSystemNotificationTarget =
  | {
    kind: "server"
    serverId: string
    channelId: string
    messageId: string
    seq: number
  }
  | {
    kind: "dm"
    channelId: string
    messageId: string
    seq: number
  }

export type DesktopSystemNotificationActivation = {
  notificationId: string
  target: DesktopSystemNotificationTarget
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const NOTIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value)
}

function safeSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export function parseDesktopSystemNotificationActivation(
  value: unknown,
): DesktopSystemNotificationActivation | null {
  if (!isObject(value) || !exactKeys(value, ["notificationId", "target"])) return null
  if (typeof value.notificationId !== "string" || !NOTIFICATION_ID.test(value.notificationId)) return null
  if (!isObject(value.target) || typeof value.target.kind !== "string") return null

  const target = value.target
  if (target.kind === "server") {
    if (!exactKeys(target, ["kind", "serverId", "channelId", "messageId", "seq"])) return null
    if (!safeId(target.serverId) || !safeId(target.channelId) || !safeId(target.messageId) || !safeSeq(target.seq)) return null
    return {
      notificationId: value.notificationId,
      target: {
        kind: "server",
        serverId: target.serverId,
        channelId: target.channelId,
        messageId: target.messageId,
        seq: target.seq,
      },
    }
  }

  if (target.kind === "dm") {
    if (!exactKeys(target, ["kind", "channelId", "messageId", "seq"])) return null
    if (!safeId(target.channelId) || !safeId(target.messageId) || !safeSeq(target.seq)) return null
    return {
      notificationId: value.notificationId,
      target: {
        kind: "dm",
        channelId: target.channelId,
        messageId: target.messageId,
        seq: target.seq,
      },
    }
  }

  return null
}

export function desktopSystemNotificationHref(target: DesktopSystemNotificationTarget): string {
  if (target.kind === "dm") {
    return `/c/me/${encodeURIComponent(target.channelId)}?seq=${target.seq}`
  }
  return `/c/channels/${encodeURIComponent(target.serverId)}/${encodeURIComponent(target.channelId)}?msg=${encodeURIComponent(target.messageId)}`
}

export async function revalidateDesktopSystemNotificationTarget(
  target: DesktopSystemNotificationTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`/api/community/messages/${encodeURIComponent(target.messageId)}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    })
    if (!response.ok) return false
    const payload: unknown = await response.json()
    return isObject(payload) && payload.id === target.messageId
  } catch {
    return false
  }
}
