import { admitCommunityBrowserEventBatch, decodeCommunityBrowserEvent, isCommunityBrowserEventBatchCandidate, type CommunityWsEvent } from "@alook/shared"
import { expect, type BrowserContext, type Page, type Request } from "@playwright/test"
import { proxyCommunityWebSockets } from "./community-ws-proxy"

export const notificationPaths = [
  "/api/community/users/me/attention",
  "/api/community/users/me/dms",
]
const accountStartupPaths = [...notificationPaths, "/api/community/users/me/read-state"]

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
  const rawFrames: string[] = []
  let frameAdmission = Promise.resolve()
  const requests: string[] = []
  const pendingNotifications = new Set<Request>()
  const requestIds = new Map<Request, number>()
  const timeline: Array<Record<string, unknown>> = []
  let phase = "initial"
  const record = (data: Record<string, unknown>) => timeline.push({ at: Date.now(), phase, ...data })
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const raw = payload.toString()
      const received = { at: Date.now(), phase }
      rawFrames.push(raw)
      frameAdmission = frameAdmission.then(async () => {
        try {
          const frame: unknown = JSON.parse(raw)
          record({ ...received, kind: "frame", type: typeof frame === "object" && frame !== null && "type" in frame ? frame.type : undefined })
          const admitted = isCommunityBrowserEventBatchCandidate(frame)
            ? await admitCommunityBrowserEventBatch(frame)
            : decodeCommunityBrowserEvent(frame)
          if (!admitted.ok) return
          for (const event of "events" in admitted ? admitted.events : [admitted.event]) {
            events.push(event)
            record({ ...received, admittedAt: Date.now(), kind: "event", type: event.type,
              channelId: "channelId" in event ? event.channelId : undefined,
              messageId: event.type === "community:message.create" ? event.message.id : undefined })
          }
        } catch {}
      })
    })
  })
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    requestIds.set(request, requestIds.size + 1)
    requests.push(path)
    record({ kind: "request-start", id: requestIds.get(request), path, method: request.method() })
    if (accountStartupPaths.includes(path)) pendingNotifications.add(request)
  })
  page.on("requestfinished", (request) => {
    pendingNotifications.delete(request)
    record({ kind: "request-finished", id: requestIds.get(request), path: new URL(request.url()).pathname })
  })
  page.on("requestfailed", (request) => {
    pendingNotifications.delete(request)
    record({ kind: "request-failed", id: requestIds.get(request), path: new URL(request.url()).pathname })
  })
  return { events, rawFrames, requests, pendingNotifications, timeline,
    framesSettled: () => frameAdmission,
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
  const initial = notificationResponsesFinished(page, accountStartupPaths)
  await page.goto("/c/me", { waitUntil: "commit" })
  await initial
  await expect.poll(() => proxy.heldConnectionCount()).toBe(1)
  trace.phase("auth-release")
  const authenticatedRefresh = notificationResponsesFinished(
    page,
    accountStartupPaths.filter((path) => !path.endsWith("/dms")),
  )
  holdAuthentication = false
  expect(proxy.releaseHeldConnections((frame) => frame.type === "auth.ok")).toBe(1)
  await authenticatedRefresh
  await expect.poll(() => trace.pendingNotifications.size).toBe(0)
  return proxy
}
