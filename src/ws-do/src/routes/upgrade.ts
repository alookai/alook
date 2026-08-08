import { queries } from "@alook/shared"
import type { RouterContext } from "../router-context"

export async function handleUpgrade({ request, env, url, traceId, log }: RouterContext): Promise<Response> {
  // Community-machine daemon WS upgrade — Bearer cmk_<credential> only.
  // Router names the DO from `sha256(bearer).slice(0,32)` without hitting
  // D1; the DO re-validates the full hash authoritatively on first accept.
  const authHeader = request.headers.get("Authorization")
  if (authHeader?.startsWith("Bearer cmk_")) {
    const bearer = authHeader.slice(7).trim()
    const hash = await queries.communityMachine.hashCredential(bearer)
    const doName = queries.communityMachine.doNameFromHash(hash)
    const reqLog = log.child({ traceId })
    reqLog.info("community machine websocket upgrade")
    const doId = env.WS_DO.idFromName("community-machine:" + doName)
    const stub = env.WS_DO.get(doId)
    return stub.fetch(request)
  }

  const daemonId = url.searchParams.get("daemonId")
  if (daemonId) {
    const reqLog = log.child({ traceId, daemonId })
    reqLog.info("daemon websocket upgrade")

    const doId = env.WS_DO.idFromName("daemon:" + daemonId)
    const stub = env.WS_DO.get(doId)
    return stub.fetch(request)
  }

  const userId = url.searchParams.get("userId")
  if (!userId) return new Response("userId required", { status: 400 })

  const reqLog = log.child({ traceId, userId })
  reqLog.info("websocket upgrade")

  const doId = env.WS_DO.idFromName("user:" + userId)
  const stub = env.WS_DO.get(doId)
  return stub.fetch(request)
}
