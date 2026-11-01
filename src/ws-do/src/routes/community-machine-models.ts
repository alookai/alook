import { createDb, queries, RuntimeModelDiscoveryRequestSchema, RuntimeModelDiscoveryResultSchema, RUNTIME_MODEL_CATALOG_FINGERPRINT_HEADER } from "@alook/shared"
import { readBoundedJsonRequest } from "../community-browser-event-ingress"
import type { RouterContext } from "../router-context"

export async function handleMachineModels({ request, env, url }: RouterContext): Promise<Response | null> {
  const match = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/discover-models$/)
  if (!match || request.method !== "POST") return null
  const input = await readBoundedJsonRequest(request, 4096)
  const payload = RuntimeModelDiscoveryRequestSchema.safeParse(input.ok ? input.value : null)
  if (!payload.success) return Response.json({ error: "invalid request" }, { status: 400 })
  try {
    const machineId = decodeURIComponent(match[1])
    const doNames = await queries.communityMachine.getActiveDoNamesForMachine(createDb(env.DB), machineId)
    const wait = url.searchParams.get("wait") === "1"
    const catalogFingerprint = request.headers.get(RUNTIME_MODEL_CATALOG_FINGERPRINT_HEADER)
    let sent = 0
    let unsupported = 0
    for (const name of doNames) {
      const stub = env.WS_DO.get(env.WS_DO.idFromName("community-machine:" + name))
      const response = await stub.fetch(new Request(`http://internal/discover-models${wait ? `?wait=1${url.searchParams.get("cache") === "1" ? "&cache=1" : ""}` : ""}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(catalogFingerprint ? { [RUNTIME_MODEL_CATALOG_FINGERPRINT_HEADER]: catalogFingerprint } : {}) },
        body: JSON.stringify({ type: "runtime:discover_models", ...payload.data }),
      }))
      if (!response.ok) throw new Error("dispatch failed")
      const receipt = await response.json() as { sent?: unknown; unsupported?: unknown; result?: unknown; cached?: unknown; observedAt?: unknown; catalogFingerprint?: unknown }
      if (!Number.isSafeInteger(receipt.sent) || (receipt.sent as number) < 0
        || !Number.isSafeInteger(receipt.unsupported) || (receipt.unsupported as number) < 0) throw new Error("invalid receipt")
      if (wait && ((receipt.sent as number) > 0 || receipt.cached === true)) {
        if (receipt.cached === true) {
          if (!catalogFingerprint || receipt.catalogFingerprint !== catalogFingerprint || typeof receipt.observedAt !== "string" || !Number.isFinite(Date.parse(receipt.observedAt))) throw new Error("invalid cached report")
          return Response.json({ sent: 0, unsupported: 0, cached: true, observedAt: receipt.observedAt, catalogFingerprint })
        }
        const result = RuntimeModelDiscoveryResultSchema.safeParse(receipt.result)
        if (!result.success || (result.data.status === "complete" && (typeof receipt.observedAt !== "string" || !Number.isFinite(Date.parse(receipt.observedAt)))) || (receipt.cached === true && result.data.status !== "complete")) throw new Error("invalid discovery result")
        return Response.json({ sent: receipt.sent, unsupported: receipt.unsupported, result: result.data, cached: receipt.cached === true, observedAt: receipt.observedAt })
      }
      sent += receipt.sent as number
      unsupported += receipt.unsupported as number
    }
    return Response.json({ sent, unsupported })
  } catch {
    return Response.json({ error: "model discovery dispatch unavailable" }, { status: 503 })
  }
}
