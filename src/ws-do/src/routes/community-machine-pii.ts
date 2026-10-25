import { createDb, PII_REQUEST_MAX_BYTES, PiiCommandSchema, queries } from "@alook/shared"
import { readBoundedJsonRequest } from "../community-browser-event-ingress"
import type { RouterContext } from "../router-context"

export async function handleMachinePii({ request, env, url }: RouterContext): Promise<Response | null> {
  const match = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/pii$/)
  if (!match || request.method !== "POST") return null
  const input = await readBoundedJsonRequest(request, PII_REQUEST_MAX_BYTES)
  const payload = PiiCommandSchema.safeParse(input.ok ? input.value : null)
  if (!payload.success) return Response.json({ error: "invalid request" }, { status: 400 })
  try {
    const doNames = await queries.communityMachine.getActiveDoNamesForMachine(createDb(env.DB), decodeURIComponent(match[1]))
    let sent = 0
    let unsupported = 0
    for (const name of doNames) {
      const stub = env.WS_DO.get(env.WS_DO.idFromName("community-machine:" + name))
      const response = await stub.fetch(new Request("http://internal/pii", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload.data),
      }))
      if (!response.ok) throw 0
      const receipt = await response.json() as { sent?: unknown; unsupported?: unknown }
      if (!Number.isSafeInteger(receipt.sent) || (receipt.sent as number) < 0
        || !Number.isSafeInteger(receipt.unsupported) || (receipt.unsupported as number) < 0) throw 0
      sent += receipt.sent as number
      unsupported += receipt.unsupported as number
    }
    return Response.json({ sent, unsupported })
  } catch { return Response.json({ error: "PII dispatch unavailable" }, { status: 503 }) }
}
