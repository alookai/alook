import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { resolveObservationBuild } from "./build"
import { cleanAttributes, type Attributes } from "./schema"

function requestTracing() {
  try { return getCloudflareContext().ctx.tracing } catch { return undefined }
}

export function annotateWorkerSpan(attributes: Attributes) {
  const span = requestTracing()?.getActiveSpan()
  if (span?.isTraced) for (const [key, value] of Object.entries(cleanAttributes(attributes))) span.setAttribute(key, value)
}

export function observeWorkerOperation<T>(name: string, attributes: Attributes, execute: () => T): T {
  const tracing = requestTracing()
  if (!tracing) return execute()
  return tracing.enterSpan(name, (span) => {
    for (const [key, value] of Object.entries(cleanAttributes(attributes))) span.setAttribute(key, value)
    return execute()
  })
}

export function workerRequestAttributes(request: Request, env: Pick<Env, "CF_VERSION_METADATA">, build: ReturnType<typeof resolveObservationBuild>): Attributes {
  const parent = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(request.headers.get("traceparent") ?? "")
  const valid = parent && !/^0+$/.test(parent[1]!) && !/^0+$/.test(parent[2]!)
  return { ...build,
    worker_version: env.CF_VERSION_METADATA?.id, worker_version_status: env.CF_VERSION_METADATA?.id ? "present" : "missing",
    upstream_trace_id: valid ? parent[1] : undefined, upstream_span_id: valid ? parent[2] : undefined,
    trace_context: valid ? "received" : "missing" }
}
