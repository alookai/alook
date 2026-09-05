import type { CommunityWsEvent } from "@alook/shared"
import { expect, type BrowserContext, type Page, type Request } from "@playwright/test"
import { proxyCommunityWebSockets } from "./community-ws-proxy"

export const notificationPaths = [
  "/api/community/users/me/inbox/unreads",
  "/api/community/users/me/inbox/mentions",
  "/api/community/users/me/dms",
]

export async function notificationResponsesFinished(page: Page, paths = notificationPaths) {
  await Promise.all(paths.map(async (path) => {
    const response = await page.waitForResponse((candidate) =>
      candidate.request().method() === "GET" && new URL(candidate.url()).pathname === path,
    )
    expect(response.status()).toBe(200)
    expect(await response.finished()).toBeNull()
  }))
}

export function captureNotificationRequests(page: Page) {
  const events: CommunityWsEvent[] = []
  const requests: string[] = []
  const pendingNotifications = new Set<Request>()
  const requestIds = new Map<Request, number>()
  const timeline: Array<Record<string, unknown>> = []
  let phase = "initial"
  const record = (data: Record<string, unknown>) => timeline.push({ at: Date.now(), phase, ...data })
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString()) as CommunityWsEvent | { type: "community:events.batch"; events: CommunityWsEvent[] }
        record({ kind: "frame", type: frame.type })
        if (!frame.type.startsWith("community:")) return
        for (const event of frame.type === "community:events.batch" ? frame.events : [frame]) {
          events.push(event)
          record({ kind: "event", type: event.type,
            channelId: "channelId" in event ? event.channelId : undefined,
            messageId: event.type === "community:message.create" ? event.message.id : undefined })
        }
      } catch {}
    })
  })
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    requestIds.set(request, requestIds.size + 1)
    requests.push(path)
    record({ kind: "request-start", id: requestIds.get(request), path, method: request.method() })
    if (notificationPaths.includes(path)) pendingNotifications.add(request)
  })
  page.on("requestfinished", (request) => {
    pendingNotifications.delete(request)
    record({ kind: "request-finished", id: requestIds.get(request), path: new URL(request.url()).pathname })
  })
  page.on("requestfailed", (request) => {
    pendingNotifications.delete(request)
    record({ kind: "request-failed", id: requestIds.get(request), path: new URL(request.url()).pathname })
  })
  return { events, requests, pendingNotifications, timeline,
    phase: (next: string) => { phase = next; record({ kind: "phase" }) } }
}

export async function gotoAfterNotificationStartup(
  page: Page,
  context: BrowserContext,
  trace: ReturnType<typeof captureNotificationRequests>,
) {
  let holdAuthentication = true
  const proxy = await proxyCommunityWebSockets(context, {
    decideConnectionFrame: (frame) => frame.type === "auth.ok" && holdAuthentication ? "hold" : "forward",
  })
  const initial = notificationResponsesFinished(page)
  await page.goto("/c/me", { waitUntil: "commit" })
  await initial
  await expect.poll(() => proxy.heldConnectionCount()).toBe(1)
  trace.phase("auth-release")
  const authenticatedRefresh = notificationResponsesFinished(page)
  holdAuthentication = false
  expect(proxy.releaseHeldConnections((frame) => frame.type === "auth.ok")).toBe(1)
  await authenticatedRefresh
  await expect.poll(() => trace.pendingNotifications.size).toBe(0)
  return proxy
}
