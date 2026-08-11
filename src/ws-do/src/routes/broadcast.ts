import type { RouterContext } from "../router-context"
import { createInternalUserBroadcastRequest } from "../internal-user-broadcast"
import { settleInBatches } from "../settle-in-batches"

const maxBulkUserIds = 1000
const bulkBatchSize = 40

type BulkBroadcastBody = {
  userIds: string[]
  message: Record<string, unknown> & { type: string }
  excludeUserId?: string
}

type BulkTargetResult =
  | { ok: true; sent: number }
  | { ok: false; failureKind: "non-ok" | "invalid-json" | "invalid-sent"; status: number }

type BulkFailureKind = "throw" | "non-ok" | "invalid-json" | "invalid-sent"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBulkBroadcastBody(value: unknown): value is BulkBroadcastBody {
  if (!isRecord(value) || !Array.isArray(value.userIds)) return false
  if (value.userIds.length > maxBulkUserIds) return false
  if (value.userIds.some((userId) => typeof userId !== "string" || userId.length === 0)) return false
  if (!isRecord(value.message) || typeof value.message.type !== "string" || value.message.type.length === 0) return false
  if (
    Object.prototype.hasOwnProperty.call(value, "excludeUserId")
    && (typeof value.excludeUserId !== "string" || value.excludeUserId.length === 0)
  ) return false
  return true
}

function invalidBulkRequest(): Response {
  return Response.json({ error: "Invalid bulk broadcast request" }, { status: 400 })
}

async function broadcastToBulkTarget(
  env: Env,
  userId: string,
  messageBody: string,
): Promise<BulkTargetResult> {
  const doId = env.WS_DO.idFromName("user:" + userId)
  const stub = env.WS_DO.get(doId)
  const response = await stub.fetch(createInternalUserBroadcastRequest(userId, messageBody))
  if (!response.ok) return { ok: false, failureKind: "non-ok", status: response.status }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, failureKind: "invalid-json", status: response.status }
  }
  if (
    !isRecord(payload)
    || typeof payload.sent !== "number"
    || !Number.isFinite(payload.sent)
    || !Number.isInteger(payload.sent)
    || payload.sent < 0
  ) {
    return { ok: false, failureKind: "invalid-sent", status: response.status }
  }
  return { ok: true, sent: payload.sent }
}

export async function handleDaemonBroadcast({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  const daemonBroadcast = url.pathname.match(/^\/broadcast\/daemon\/(.+)$/)
  if (!daemonBroadcast || request.method !== "POST") return null

  const daemonId = daemonBroadcast[1]
  const reqLog = log.child({ traceId, daemonId })
  reqLog.debug("broadcasting to daemon")

  const doId = env.WS_DO.idFromName("daemon:" + daemonId)
  const stub = env.WS_DO.get(doId)
  return stub.fetch(new Request("http://internal/broadcast", { method: "POST", body: request.body, duplex: "half" } as RequestInit))
}

export async function handleUserBroadcast({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  const userBroadcast = url.pathname.match(/^\/broadcast\/user\/(.+)$/)
  if (!userBroadcast || request.method !== "POST") return null

  const userId = userBroadcast[1]
  const reqLog = log.child({ traceId, userId })
  reqLog.debug("broadcasting to user")

  const doId = env.WS_DO.idFromName("user:" + userId)
  const stub = env.WS_DO.get(doId)
  return stub.fetch(
    createInternalUserBroadcastRequest(userId, request.body, request.headers, true),
  )
}

export async function handleUsersBroadcast({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  if (url.pathname !== "/broadcast/users" || request.method !== "POST") return null

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalidBulkRequest()
  }
  if (!isBulkBroadcastBody(body)) return invalidBulkRequest()

  const uniqueUserIds = [...new Set(body.userIds)]
  const targetUserIds = body.excludeUserId === undefined
    ? uniqueUserIds
    : uniqueUserIds.filter((userId) => userId !== body.excludeUserId)
  const reqLog = log.child({
    traceId,
    rawCount: body.userIds.length,
    uniqueCount: uniqueUserIds.length,
    targetCount: targetUserIds.length,
    excludedCount: uniqueUserIds.length - targetUserIds.length,
  })
  reqLog.debug("broadcasting to users")

  const messageBody = JSON.stringify(body.message)
  const startedAt = Date.now()
  let active = 0
  let maxActive = 0
  let successCount = 0
  let failureCount = 0
  let sent = 0
  const failureCounts: Record<BulkFailureKind, number> = {
    throw: 0,
    "non-ok": 0,
    "invalid-json": 0,
    "invalid-sent": 0,
  }

  const results = await settleInBatches(targetUserIds, async (userId) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      return await broadcastToBulkTarget(env, userId, messageBody)
    } finally {
      active -= 1
    }
  }, bulkBatchSize)

  for (const [index, result] of results.entries()) {
    const userId = targetUserIds[index]
    if (result.status === "rejected") {
      failureCount += 1
      failureCounts.throw += 1
      reqLog.warn("bulk user broadcast target failed", {
        userId,
        failureKind: "throw",
      })
    } else if (!result.value.ok) {
      failureCount += 1
      failureCounts[result.value.failureKind] += 1
      reqLog.warn("bulk user broadcast target failed", {
        userId,
        failureKind: result.value.failureKind,
        status: result.value.status,
      })
    } else {
      successCount += 1
      sent += result.value.sent
    }
  }

  reqLog.info("bulk user broadcast complete", {
    targetCount: targetUserIds.length,
    resultCount: results.length,
    successCount,
    failureCount,
    failureCounts,
    sent,
    maxActive,
    batchSize: bulkBatchSize,
    batchCount: Math.ceil(targetUserIds.length / bulkBatchSize),
    durationMs: Date.now() - startedAt,
  })
  return Response.json({ sent })
}
