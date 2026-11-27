import { createDb, queries, readOrStale } from "@alook/shared"
import type { RouterContext } from "../router-context"
import { checkBatchPresenceTargetsWithRelay } from "../ws-durable/scope-room"

const presenceBatchSize = 40
const MAX_PRESENCE_IDS = 1000

export async function handleBatchPresence({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  if (url.pathname !== "/presence/users" || request.method !== "POST") return null

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response("invalid json", { status: 400 })
  }
  const ids = (body as { ids?: unknown })?.ids
  if (!Array.isArray(ids)) return new Response("ids must be an array", { status: 400 })
  if (ids.length > MAX_PRESENCE_IDS) return new Response("too many ids", { status: 400 })
  if (!ids.every((id): id is string => typeof id === "string")) {
    return new Response("ids must be strings", { status: 400 })
  }

  const uniqueIds = [...new Set(ids)]
  const reqLog = log.child({ traceId, count: uniqueIds.length })
  reqLog.debug("bulk presence check")

  const startedAt = Date.now()
  const botLookup = env.DB
    ? await readOrStale(
        () => queries.communityMachine.getBotPresenceStates(createDb(env.DB), uniqueIds),
        { botUserIds: new Set<string>(), onlineBotUserIds: new Set<string>() },
        { route: "ws-do/batch-presence-bots" },
      )
    : { value: { botUserIds: new Set<string>(), onlineBotUserIds: new Set<string>() }, stale: false }

  const online: string[] = []
  const offline: string[] = []
  const humanIds: string[] = []

  for (const id of uniqueIds) {
    if (botLookup.value.botUserIds.has(id)) {
      if (botLookup.value.onlineBotUserIds.has(id)) online.push(id)
      else offline.push(id)
    } else {
      humanIds.push(id)
    }
  }

  const humanCheck = await checkBatchPresenceTargetsWithRelay(env, humanIds, {
    batchSize: presenceBatchSize,
    onTargetFailure: (userId, failureKind, status) => {
      reqLog.warn("bulk_presence_target_failed", {
        userId,
        failureKind,
        ...(status === undefined ? {} : { status }),
      })
    },
  })

  online.push(...humanCheck.online)
  let staleCount = humanCheck.staleCount
  if (botLookup.stale) {
    // When D1 bot presence lookup degraded, any ID absent from user WS DOs may
    // be an online bot rather than an offline human; omit it from `offline`.
    staleCount += humanCheck.offline.length
  } else {
    offline.push(...humanCheck.offline)
  }

  const offlineCount = offline.length

  reqLog.info("bulk_presence_check_complete", {
    targetCount: uniqueIds.length,
    botCount: uniqueIds.length - humanIds.length,
    humanCount: humanIds.length,
    resultCount: humanCheck.resultCount,
    successCount: online.length + offlineCount,
    onlineCount: online.length,
    offlineCount,
    staleCount,
    failureCount: humanCheck.failureCount,
    failureCounts: humanCheck.failureCounts,
    maxActive: humanCheck.maxActive,
    batchSize: presenceBatchSize,
    batchCount: humanCheck.batchCount,
    durationMs: Date.now() - startedAt,
  })
  return Response.json({ online, offline })
}

export async function handleSinglePresence({ request, env, url }: RouterContext): Promise<Response | null> {
  const presenceCheck = url.pathname.match(/^\/presence\/user\/(.+)$/)
  if (!presenceCheck || request.method !== "GET") return null

  const uid = presenceCheck[1]!
  if (env.DB) {
    const { value, stale } = await readOrStale(
      () => queries.communityMachine.getBotPresenceStates(createDb(env.DB), [uid]),
      { botUserIds: new Set<string>(), onlineBotUserIds: new Set<string>() },
      { route: "ws-do/single-presence-bot" },
    )
    if (stale) return Response.json({ online: false, stale: true })
    if (value.botUserIds.has(uid)) {
      return Response.json({ online: value.onlineBotUserIds.has(uid) })
    }
  }

  const doId = env.WS_DO.idFromName("user:" + uid)
  const stub = env.WS_DO.get(doId)
  return stub.fetch(
    new Request(`http://internal/check-user-online?userId=${encodeURIComponent(uid)}`),
  )
}
