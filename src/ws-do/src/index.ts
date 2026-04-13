export { WebSocketDurableObject } from "./ws-durable"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    const userBroadcast = url.pathname.match(/^\/broadcast\/user\/(.+)$/)
    if (userBroadcast && request.method === "POST") {
      const userId = userBroadcast[1]
      const doId = env.WS_DO.idFromName("user:" + userId)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(new Request("http://internal/broadcast", { method: "POST", body: request.body, duplex: "half" } as RequestInit))
    }

    const userId = url.searchParams.get("userId")
    if (!userId) return new Response("userId required", { status: 400 })
    const doId = env.WS_DO.idFromName("user:" + userId)
    const stub = env.WS_DO.get(doId)
    return stub.fetch(request)
  },
}
