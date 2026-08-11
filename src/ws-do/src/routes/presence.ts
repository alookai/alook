import type { RouterContext } from "../router-context"
import { settleInBatches } from "../settle-in-batches"

const presenceBatchSize = 40

type BatchPresenceTargetResult =
  | { kind: "online" }
  | { kind: "offline" }
  | { kind: "stale" }
  | { kind: "non-ok"; status: number }
  | { kind: "invalid-json"; status: number }
  | { kind: "invalid-body"; status: number }

type BatchPresenceFailureKind = "throw" | "non-ok" | "invalid-json" | "invalid-body"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function checkBatchPresenceTarget(env: Env, userId: string): Promise<BatchPresenceTargetResult> {
  const doId = env.WS_DO.idFromName("user:" + userId)
  const stub = env.WS_DO.get(doId)
  const response = await stub.fetch(
    new Request(`http://internal/check-user-online?userId=${encodeURIComponent(userId)}`),
  )
  if (!response.ok) return { kind: "non-ok", status: response.status }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    return { kind: "invalid-json", status: response.status }
  }
  if (
    !isRecord(data)
    || typeof data.online !== "boolean"
    || (data.stale !== undefined && typeof data.stale !== "boolean")
  ) return { kind: "invalid-body", status: response.status }
  if (data.stale) return { kind: "stale" }
  return data.online ? { kind: "online" } : { kind: "offline" }
}

export async function handleBatchPresence({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  // Bulk presence: fan out one DO fetch per id and return the online subset.
  // Consolidates web-worker subrequest budget to a single call regardless of
  // membership size.
  if (url.pathname !== "/presence/users" || request.method !== "POST") return null

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response("invalid json", { status: 400 })
  }
  const ids = (body as { ids?: unknown })?.ids
  if (!Array.isArray(ids)) return new Response("ids must be an array", { status: 400 })
  if (ids.length > 1000) return new Response("too many ids", { status: 400 })
  if (!ids.every((id): id is string => typeof id === "string")) {
    return new Response("ids must be strings", { status: 400 })
  }

  const reqLog = log.child({ traceId, count: ids.length })
  reqLog.debug("bulk presence check")

  const startedAt = Date.now()
  let active = 0
  let maxActive = 0
  const results = await settleInBatches(ids, async (id) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      return await checkBatchPresenceTarget(env, id)
    } finally {
      active -= 1
    }
  }, presenceBatchSize)
  const online: string[] = []
  let offlineCount = 0
  let staleCount = 0
  let failureCount = 0
  const failureCounts: Record<BatchPresenceFailureKind, number> = {
    throw: 0,
    "non-ok": 0,
    "invalid-json": 0,
    "invalid-body": 0,
  }
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      failureCount += 1
      failureCounts.throw += 1
      reqLog.warn("bulk_presence_target_failed", {
        userId: ids[index],
        failureKind: "throw",
      })
      continue
    }

    if (result.value.kind === "online") {
      online.push(ids[index])
    } else if (result.value.kind === "offline") {
      offlineCount += 1
    } else if (result.value.kind === "stale") {
      staleCount += 1
    } else {
      failureCount += 1
      failureCounts[result.value.kind] += 1
      reqLog.warn("bulk_presence_target_failed", {
        userId: ids[index],
        failureKind: result.value.kind,
        status: result.value.status,
      })
    }
  }

  reqLog.info("bulk_presence_check_complete", {
    targetCount: ids.length,
    resultCount: results.length,
    successCount: online.length + offlineCount,
    onlineCount: online.length,
    offlineCount,
    staleCount,
    failureCount,
    failureCounts,
    maxActive,
    batchSize: presenceBatchSize,
    batchCount: Math.ceil(ids.length / presenceBatchSize),
    durationMs: Date.now() - startedAt,
  })
  return Response.json({ online })
}

export async function handleSinglePresence({ request, env, url }: RouterContext): Promise<Response | null> {
  // Per-user presence — dead in-tree, kept for rollout safety.
  const presenceCheck = url.pathname.match(/^\/presence\/user\/(.+)$/)
  if (!presenceCheck || request.method !== "GET") return null

  const uid = presenceCheck[1]
  const doId = env.WS_DO.idFromName("user:" + uid)
  const stub = env.WS_DO.get(doId)
  return stub.fetch(
    new Request(`http://internal/check-user-online?userId=${encodeURIComponent(uid)}`),
  )
}
