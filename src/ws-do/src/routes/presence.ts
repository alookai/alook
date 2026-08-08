import type { RouterContext } from "../router-context"

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

  if (ids.length === 0) return Response.json({ online: [] })

  const results = await Promise.allSettled(
    ids.map((id) => {
      const doId = env.WS_DO.idFromName("user:" + id)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(
        new Request(`http://internal/check-user-online?userId=${encodeURIComponent(id)}`),
      )
    }),
  )
  const online: string[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status !== "fulfilled" || !r.value.ok) continue
    try {
      const data = await r.value.json() as { online?: boolean; stale?: boolean }
      // Skip stale responses — a fail-closed `online:false` from D1 must
      // not be surfaced as authoritative offline to fan-out callers.
      if (data.stale) continue
      if (data.online) online.push(ids[i])
    } catch { /* skip */ }
  }
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
