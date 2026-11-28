import { createDb, ImCommandSchema, queries } from "@alook/shared"
import { readBoundedJsonRequest } from "../community-browser-event-ingress"
import { decodePathSegment, type RouterContext } from "../router-context"

const IM_COMMAND_MAX_BYTES = 16 * 1024

export async function handleMachineIm({ request, env, url }: RouterContext): Promise<Response | null> {
  const postMatch = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/im$/)
  if (postMatch && request.method === "POST") {
    const machineId = decodePathSegment(postMatch[1])
    if (!machineId) return Response.json({ error: "invalid machineId" }, { status: 400 })
    const input = await readBoundedJsonRequest(request, IM_COMMAND_MAX_BYTES)
    const payload = ImCommandSchema.safeParse(input.ok ? input.value : null)
    if (!payload.success) return Response.json({ error: "invalid request" }, { status: 400 })
    const wait = url.searchParams.get("wait") === "1"
    try {
      const doNames = await queries.communityMachine.getActiveDoNamesForMachine(createDb(env.DB), machineId)
      if (wait && payload.data.type === "im:qr_start") {
        let sawUnsupported = false
        for (const name of doNames) {
          const stub = env.WS_DO.get(env.WS_DO.idFromName("community-machine:" + name))
          const response = await stub.fetch(
            new Request("http://internal/im?wait=1", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload.data),
            }),
          )
          if (!response.ok) continue
          const result = (await response.json()) as {
            ok?: boolean
            code?: string
            frame?: unknown
          }
          if (result.ok) {
            return Response.json(result)
          }
          if (result.code === "unsupported") sawUnsupported = true
          if (result.code === "timeout") {
            return Response.json(result, { status: 504 })
          }
        }
        return Response.json(
          { ok: false, code: sawUnsupported ? "unsupported" : "machine_offline" },
          { status: sawUnsupported ? 409 : 409 },
        )
      }

      let sent = 0
      let unsupported = 0
      for (const name of doNames) {
        const stub = env.WS_DO.get(env.WS_DO.idFromName("community-machine:" + name))
        const response = await stub.fetch(
          new Request("http://internal/im", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload.data),
          }),
        )
        if (!response.ok) throw 0
        const receipt = (await response.json()) as { sent?: unknown; unsupported?: unknown }
        if (
          !Number.isSafeInteger(receipt.sent) ||
          (receipt.sent as number) < 0 ||
          !Number.isSafeInteger(receipt.unsupported) ||
          (receipt.unsupported as number) < 0
        ) {
          throw 0
        }
        sent += receipt.sent as number
        unsupported += receipt.unsupported as number
      }
      return Response.json({ sent, unsupported })
    } catch {
      return Response.json({ error: "IM dispatch unavailable" }, { status: 503 })
    }
  }

  const getMatch = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/im-qr-status$/)
  if (getMatch && request.method === "GET") {
    const machineId = decodePathSegment(getMatch[1])
    const triggerId = url.searchParams.get("triggerId")?.trim()
    if (!machineId || !triggerId) {
      return Response.json({ error: "invalid request" }, { status: 400 })
    }
    try {
      const doNames = await queries.communityMachine.getActiveDoNamesForMachine(createDb(env.DB), machineId)
      for (const name of doNames) {
        const stub = env.WS_DO.get(env.WS_DO.idFromName("community-machine:" + name))
        const response = await stub.fetch(
          new Request(`http://internal/im-qr-status?triggerId=${encodeURIComponent(triggerId)}`),
        )
        if (!response.ok) continue
        const body = (await response.json()) as { state: unknown }
        if (body.state) return Response.json(body)
      }
      return Response.json({ state: null })
    } catch {
      return Response.json({ error: "IM QR status unavailable" }, { status: 503 })
    }
  }

  return null
}
