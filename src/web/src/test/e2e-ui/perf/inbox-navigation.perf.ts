import { test, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { DEV_PASSWORD } from "@alook/shared"
import { tid } from "../_fixtures/testids"

const BASE_URL = process.env.ALOOK_SERVER_URL || "http://localhost:3000"
const ARTIFACTS_DIR = resolve(__dirname, "..", "..", "..", "..", "perf-artifacts")
const MANIFEST_PATH = resolve(ARTIFACTS_DIR, "seed-manifest.json")
const TRACE_PATH = resolve(ARTIFACTS_DIR, "inbox-navigation-trace.json")

type Manifest = {
  owner: { email: string; userId: string }
  servers: Array<{ id: string; channels: Array<{ id: string }> }>
}

type Sample = {
  surface: "channel" | "dm"
  targetId: string
  cache: "cold" | "warm"
  clickToTargetMs: number
  nextFramePending: boolean
  forbiddenCachedTextVisibleBeforeProof: boolean
  requestStartsMs: Record<string, number>
}

async function authenticate(context: BrowserContext, email: string, name?: string) {
  let response = await context.request.post(`${BASE_URL}/api/auth/sign-in/email`, {
    data: { email, password: DEV_PASSWORD },
  })
  if (!response.ok()) {
    response = await context.request.post(`${BASE_URL}/api/auth/sign-up/email`, {
      data: { name: name ?? email.split("@")[0], email, password: DEV_PASSWORD },
    })
  }
  expect(response.ok(), `authenticate ${email}`).toBe(true)
}

async function postJson<T>(request: APIRequestContext, path: string, data?: unknown): Promise<T> {
  const response = await request.post(`${BASE_URL}${path}`, { data })
  expect(response.ok(), `POST ${path} (${response.status()})`).toBe(true)
  return response.json() as Promise<T>
}

async function measureInboxClick({
  page,
  rowTestId,
  targetText,
  cachedText,
  surface,
  cache,
  targetId,
}: {
  page: Page
  rowTestId: string
  targetText: string
  cachedText?: string
  surface: Sample["surface"]
  cache: Sample["cache"]
  targetId: string
}): Promise<Sample> {
  await page.getByTestId(tid.inboxTrigger).click()
  const row = page.getByTestId(rowTestId)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await page.evaluate(() => performance.clearResourceTimings())
  const clickTs = await row.evaluate((element, pendingTestId) => {
    const started = performance.now()
    performance.mark("inbox-navigation-click")
    ;(window as unknown as Record<string, Promise<boolean>>).__inboxPendingFrame = new Promise((resolvePending) => {
      requestAnimationFrame(() => resolvePending(
        document.querySelector(`[data-testid="${pendingTestId}"]`) !== null,
      ))
    })
    ;(element as HTMLElement).click()
    return started
  }, tid.pendingMain(surface === "channel" ? "server-conversation" : "dm"))
  const nextFramePending = await page.evaluate(() => (
    (window as unknown as Record<string, Promise<boolean>>).__inboxPendingFrame
  ))
  let forbiddenCachedTextVisibleBeforeProof = false
  if (cachedText) {
    await page.waitForTimeout(40)
    forbiddenCachedTextVisibleBeforeProof = await page.getByText(cachedText, { exact: true }).isVisible()
  }
  await expect(page.getByText(targetText, { exact: true })).toBeVisible({ timeout: 20_000 })
  const result = await page.evaluate(({ clickTs }) => {
    const requestStartsMs: Record<string, number> = {}
    for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
      const url = new URL(entry.name)
      if (!url.pathname.includes("/api/community/") && !url.searchParams.has("_rsc")) continue
      requestStartsMs[`${url.pathname}${url.searchParams.has("_rsc") ? "?_rsc" : ""}`] =
        Math.round((entry.startTime - clickTs) * 10) / 10
    }
    return {
      clickToTargetMs: Math.round((performance.now() - clickTs) * 10) / 10,
      requestStartsMs,
    }
  }, { clickTs })
  return {
    surface,
    targetId,
    cache,
    nextFramePending,
    forbiddenCachedTextVisibleBeforeProof,
    ...result,
  }
}

test.skip(process.env.PERF_INBOX_NAVIGATION !== "1", "run explicitly with PERF_INBOX_NAVIGATION=1")

test("Inbox Channel/DM navigation fixed trace", async ({ browser }) => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest
  expect(manifest.servers.length).toBeGreaterThan(1)
  const origin = manifest.servers[0]!.channels[0]!
  const targetServer = manifest.servers[1]!
  const targetChannel = targetServer.channels[0]!
  const owner = await browser.newContext()
  const peer = await browser.newContext()
  await authenticate(owner, manifest.owner.email)
  const stamp = `${Date.now()}-${process.pid}`
  await authenticate(peer, `perf-peer-${stamp}@alook.test`, `perf-peer-${stamp}`)

  const invite = await postJson<{ invite: { token: string } }>(
    owner.request,
    `/api/community/servers/${targetServer.id}/invites`,
    {},
  )
  await postJson(peer.request, `/api/community/invites/${invite.invite.token}/join`)
  const friendship = await postJson<{ id?: string; friendship?: { id: string } }>(
    peer.request,
    "/api/community/friends/request",
    { userId: manifest.owner.userId },
  )
  const friendshipId = friendship.id ?? friendship.friendship?.id
  expect(friendshipId).toBeTruthy()
  await postJson(owner.request, `/api/community/friends/${friendshipId}/accept`)
  const dm = await postJson<{ conversation: { id: string } }>(peer.request, "/api/community/channels", {
    type: "dm",
    userId: manifest.owner.userId,
  })

  const page = await owner.newPage()
  await page.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const isTargetRsc = url.searchParams.has("_rsc") && (
      url.pathname.includes(targetChannel.id) || url.pathname.includes(dm.conversation.id)
    )
    const isTargetMessages = request.method() === "GET" && (
      url.pathname === `/api/community/channels/${targetChannel.id}/messages` ||
      url.pathname === `/api/community/channels/${dm.conversation.id}/messages`
    )
    if (isTargetRsc || isTargetMessages) await new Promise((resolveDelay) => setTimeout(resolveDelay, 120))
    await route.continue()
  })
  await page.goto(`${BASE_URL}/c/channels/${manifest.servers[0]!.id}/${origin.id}`)
  await expect(page.getByTestId(tid.messageScroller)).toBeVisible({ timeout: 20_000 })

  const samples: Sample[] = []
  const channelColdText = `inbox channel cold ${stamp}`
  await postJson(peer.request, `/api/community/channels/${targetChannel.id}/messages`, { content: channelColdText })
  await page.reload()
  await expect(page.getByTestId(tid.messageScroller)).toBeVisible({ timeout: 20_000 })
  samples.push(await measureInboxClick({
    page,
    rowTestId: tid.inboxUnreadChannel(targetChannel.id),
    targetText: channelColdText,
    surface: "channel",
    cache: "cold",
    targetId: targetChannel.id,
  }))
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(origin.id))
  const channelWarmText = `inbox channel warm ${stamp}`
  await postJson(peer.request, `/api/community/channels/${targetChannel.id}/messages`, { content: channelWarmText })
  await page.reload()
  await expect(page.getByTestId(tid.messageScroller)).toBeVisible({ timeout: 20_000 })
  samples.push(await measureInboxClick({
    page,
    rowTestId: tid.inboxUnreadChannel(targetChannel.id),
    targetText: channelWarmText,
    cachedText: channelColdText,
    surface: "channel",
    cache: "warm",
    targetId: targetChannel.id,
  }))

  await page.goBack()
  await expect(page).toHaveURL(new RegExp(origin.id))
  const dmColdText = `inbox dm cold ${stamp}`
  await postJson(peer.request, `/api/community/channels/${dm.conversation.id}/messages`, { content: dmColdText })
  await page.reload()
  await expect(page.getByTestId(tid.messageScroller)).toBeVisible({ timeout: 20_000 })
  samples.push(await measureInboxClick({
    page,
    rowTestId: tid.inboxUnreadDm(dm.conversation.id),
    targetText: dmColdText,
    surface: "dm",
    cache: "cold",
    targetId: dm.conversation.id,
  }))
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(origin.id))
  const dmWarmText = `inbox dm warm ${stamp}`
  await postJson(peer.request, `/api/community/channels/${dm.conversation.id}/messages`, { content: dmWarmText })
  await page.reload()
  await expect(page.getByTestId(tid.messageScroller)).toBeVisible({ timeout: 20_000 })
  samples.push(await measureInboxClick({
    page,
    rowTestId: tid.inboxUnreadDm(dm.conversation.id),
    targetText: dmWarmText,
    cachedText: dmColdText,
    surface: "dm",
    cache: "warm",
    targetId: dm.conversation.id,
  }))

  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  writeFileSync(TRACE_PATH, JSON.stringify({ capturedAt: new Date().toISOString(), samples }, null, 2))

  for (const sample of samples) {
    expect(sample.nextFramePending, JSON.stringify(sample)).toBe(true)
    expect(sample.forbiddenCachedTextVisibleBeforeProof).toBe(false)
    if (sample.cache === "warm") expect(sample.clickToTargetMs).toBeLessThanOrEqual(1_500)
    const starts = Object.entries(sample.requestStartsMs)
      .filter(([path]) => path.includes(sample.targetId) && (
        path.includes("/messages") || path.includes("/read-state")
      ))
      .map(([, start]) => start)
    expect(starts.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(150)
  }

  await Promise.all([owner.close(), peer.close()])
})
