import { createDb, queries, RuntimeModelDiscoveryRequestSchema } from "@alook/shared"
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
    let sent = 0
    let unsupported = 0
    for (const name of doNames) {
      const stub = env.WS_DO.get(env.WS_DO.idFromName("community-machine:" + name))
      const response = await stub.fetch(new Request("http://internal/discover-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "runtime:discover_models", ...payload.data }),
      }))
      if (!response.ok) throw new Error("dispatch failed")
      const receipt = await response.json() as { sent?: unknown; unsupported?: unknown }
      if (!Number.isSafeInteger(receipt.sent) || (receipt.sent as number) < 0
        || !Number.isSafeInteger(receipt.unsupported) || (receipt.unsupported as number) < 0) throw new Error("invalid receipt")
      sent += receipt.sent as number
      unsupported += receipt.unsupported as number
    }
    return Response.json({ sent, unsupported })
  } catch {
    return Response.json({ error: "model discovery dispatch unavailable" }, { status: 503 })
  }
}
