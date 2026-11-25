import type { RouterContext } from "../router-context"

export async function handleOwnerSchedule({ request, env, url }: RouterContext): Promise<Response | null> {
  const match = url.pathname.match(/^\/owner-schedule\/([^/]+)(\/.*)$/)
  if (!match) return null

  const ownerUserId = decodeURIComponent(match[1]!)
  const innerPath = match[2]!
  if (!ownerUserId) return Response.json({ error: "invalid ownerUserId" }, { status: 400 })

  const doId = env.OWNER_SCHEDULE_DO.idFromName(`owner-schedule:${ownerUserId}`)
  const stub = env.OWNER_SCHEDULE_DO.get(doId)
  const targetUrl = new URL(`http://internal${innerPath}${url.search}`)
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text()
  }
  return stub.fetch(new Request(targetUrl.toString(), init))
}
