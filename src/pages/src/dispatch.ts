import { effectiveLimits, settings } from "./config"
import { errorResponse, PageError } from "./contracts"
import { hostPrefix } from "./prefix"
import { Registry } from "./registry"

export async function dispatch(request: Request, env: Env): Promise<Response> {
  try {
    const config = settings(env)
    const prefix = hostPrefix(new URL(request.url), config.domain)
    const row = await new Registry(env.REGISTRY, config.namespace, config.account).byPrefix(prefix)
    if (!row) throw new PageError("page_not_found", 404)
    if (!row.active || row.phase === "deleting") throw new PageError("page_unavailable", 503)
    const worker = env.DISPATCHER.get(row.active.target, {}, { limits: effectiveLimits(row.limits, config.limits) })
    return await worker.fetch(request)
  } catch (error) {
    return errorResponse(error instanceof PageError ? error : new PageError("application_unavailable", 502))
  }
}
