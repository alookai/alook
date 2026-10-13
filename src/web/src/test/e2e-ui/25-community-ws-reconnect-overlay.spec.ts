import type { Page, WebSocketRoute } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import {
  composerEditable,
  gotoAfterUserWsAuth,
} from "./_fixtures/actions"

import { tid } from "./_fixtures/testids"
import "./community-cache-first-warm-reload.journey"

const USER_WS_AUTH_CONSUMED_ATTRIBUTE = "data-e2e-user-ws-auth-consumed"

async function installUserWsAuthConsumedBarrier(page: Page) {
  await page.addInitScript(({ attribute }) => {
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args)
        if (!new URL(this.url).pathname.endsWith("/user")) return
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return
          try {
            const message = JSON.parse(event.data) as { type?: string }
            if (message.type !== "auth.ok") return
            setTimeout(() => {
              document.documentElement.setAttribute(attribute, "true")
            }, 0)
          } catch {}
        })
      }
    }
  }, { attribute: USER_WS_AUTH_CONSUMED_ATTRIBUTE })
}

test("slow auth and an initial retry never block a cold Community page", async ({ caseActors, caseResources }) => {
  test.setTimeout(90_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { seedChannel, seedServer } = actors.seed

  const serverId = await seedServer("alice", `Reconnect cold start ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "reconnect-cold-start")
  const alice = await asUser("alice")
  let tokenRequests = 0
  let releaseTokens!: () => void
  let holdTokens = true
  const tokenGate = new Promise<void>((resolve) => {
    releaseTokens = resolve
  })
  caseResources.own(releaseTokens, async (captured) => { captured() })
  let socketAttempts = 0

  await alice.page.route("**/api/ws/token", async (route) => {
    tokenRequests += 1
    if (holdTokens) await tokenGate
    await route.continue()
  })
  await alice.page.routeWebSocket((url) => url.pathname.endsWith("/user"), (ws) => {
    socketAttempts += 1
    void ws.close({ code: 1012, reason: "cold start auth retry" })
  })
  await alice.page.setViewportSize({ width: 390, height: 844 })

  try {
    await alice.page.goto(`/c/channels/${serverId}/${channelId}`)
    const composer = composerEditable(alice.page)
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => tokenRequests).toBeGreaterThan(0)
    await alice.page.waitForTimeout(1_600)
    await expect(alice.page.getByTestId(tid.wsReconnectOverlay)).toHaveCount(0)
    await expect.poll(() => composer.evaluate((element) => element.closest("[inert]") !== null))
      .toBe(false)
    await composer.fill("Cold start stays usable")
    await expect(composer).toContainText("Cold start stays usable")

    holdTokens = false
    releaseTokens()
    await expect.poll(() => socketAttempts, { timeout: 20_000 }).toBeGreaterThan(1)
    await expect(composer).toContainText("Cold start stays usable")
  } finally {
    holdTokens = false
    releaseTokens()
  }
})

test("a real WebSocket outage keeps cached content interactive and Retry reconnects", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { seedChannel, seedServer } = actors.seed

  const serverId = await seedServer("alice", `Reconnect status ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "reconnect-status")
  const alice = await asUser("alice")
  let authenticatedConnections = 0
  let firstTarget: string | null = null
  let bootstrapStartedAt = 0
  let bootstrapAuthenticatedAt: number | null = null
  let recoveryStartedAt: number | null = null
  let retryStartedAt: number | null = null
  let recoveryAuthenticatedAt: number | null = null
  let holdReconnectAuth = false
  let heldAuthOkCount = 0
  const heldAuthOk = new Map<WebSocketRoute, string | Buffer>()
  const tokenTimings: Array<{ startMs: number; endMs: number | null; status: number | null }> = []
  const socketTimings: Array<{ connection: number; observedMs: number; authSentMs: number | null; authOkMs: number | null }> = []
  const tokenRequests = new WeakMap<object, typeof tokenTimings[number]>()
  alice.page.on("request", (request) => {
    if (new URL(request.url()).pathname !== "/api/ws/token") return
    const stage = { startMs: performance.now(), endMs: null, status: null }
    tokenTimings.push(stage)
    tokenRequests.set(request, stage)
  })
  alice.page.on("response", (response) => {
    const stage = tokenRequests.get(response.request())
    if (stage) { stage.endMs = performance.now(); stage.status = response.status() }
  })
  alice.page.on("websocket", (socket) => {
    const url = new URL(socket.url())
    if (!url.pathname.endsWith("/user")) return
    firstTarget ??= url.searchParams.get("userId")
    const stage: typeof socketTimings[number] = { connection: socketTimings.length + 1, observedMs: performance.now(), authSentMs: null, authOkMs: null }
    socketTimings.push(stage)
    socket.on("framesent", ({ payload }) => {
      try {
        if (JSON.parse(payload.toString()).type === "auth") stage.authSentMs ??= performance.now()
      } catch {}
    })
    socket.on("framereceived", ({ payload }) => {
      try {
        if (JSON.parse(payload.toString()).type === "auth.ok") {
          stage.authOkMs ??= performance.now()
          authenticatedConnections += 1
          if (bootstrapAuthenticatedAt === null) bootstrapAuthenticatedAt = performance.now()
          else recoveryAuthenticatedAt ??= performance.now()
        }
      } catch {}
    })
  })
  let aliceWs: WebSocketRoute | null = null
  await alice.page.routeWebSocket((url) => url.pathname.endsWith("/user"), (ws) => {
    aliceWs = ws
    const server = ws.connectToServer()
    server.onMessage((message) => {
      let authenticated = false
      try { authenticated = JSON.parse(message.toString()).type === "auth.ok" } catch {}
      if (holdReconnectAuth && authenticated) { heldAuthOkCount++; heldAuthOk.set(ws, message); return }
      ws.send(message)
    })
  })
  const releaseReconnectAuth = (retiredForRetry: WebSocketRoute | null = null) => {
    holdReconnectAuth = false
    for (const [ws, message] of heldAuthOk) {
      if (ws === aliceWs && ws !== retiredForRetry) ws.send(message)
    }
    heldAuthOk.clear()
  }
  await alice.page.setViewportSize({ width: 390, height: 844 })
  const sdkReady = alice.page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/get-session") && response.ok())
  bootstrapStartedAt = performance.now()
  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
  const sdk = await (await sdkReady).json() as { user: { id: string }; session: { token: string; expiresAt: string } }
  expect(sdk.user.id).toBe(firstTarget)
  expect(sdk.session.token.length).toBeGreaterThan(0)
  expect(Date.parse(sdk.session.expiresAt)).toBeGreaterThan(Date.now())
  const composer = composerEditable(alice.page)
  await expect(composer).toBeVisible()
  const bootstrapTokenCount = tokenTimings.length
  expect(bootstrapTokenCount).toBeGreaterThan(0)
  let holdReconnectTokens = true
  let releaseReconnectTokens!: () => void
  const reconnectTokenGate = new Promise<void>(resolve => { releaseReconnectTokens = resolve })
  caseResources.own(releaseReconnectTokens, async (captured) => { captured() })
  const gateReconnectToken: Parameters<Page["route"]>[1] = async (route) => {
    if (holdReconnectTokens) await reconnectTokenGate
    await route.continue()
  }
  await alice.page.route("**/api/ws/token**", gateReconnectToken)

  try {
    await alice.context.setOffline(true)
    expect(aliceWs).not.toBeNull()
    await aliceWs!.close({ code: 1012, reason: "non-blocking reconnect e2e outage" })

    await alice.page.waitForTimeout(1_600)
    await expect(alice.page.getByTestId(tid.wsReconnectOverlay)).toHaveCount(0)
    await expect(composer).toBeVisible()
    await expect.poll(() => composer.evaluate((element) => element.closest("[inert]") !== null))
      .toBe(false)
    await composer.focus()
    await expect(composer).toBeFocused()

    const status = alice.page.getByTestId(tid.wsReconnectOverlay)
    const retry = alice.page.getByTestId(tid.wsRetry)
    await expect(retry).toBeVisible({ timeout: 40_000 })
    await expect(status).toHaveAttribute("data-ws-status", "failed")
    await expect(status).not.toHaveAttribute("aria-modal")
    await expect(status).toContainText("Cached content is still available.")
    const rect = await status.boundingBox()
    expect(rect).not.toBeNull()
    expect(rect!.width).toBeLessThan(390)
    expect(rect!.height).toBeLessThan(844)
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44)

    holdReconnectAuth = true
    recoveryStartedAt = performance.now()
    await alice.context.setOffline(false)
    await retry.focus()
    await expect(retry).toBeFocused()
    retryStartedAt = performance.now()
    const retiredForRetry = aliceWs
    await alice.page.keyboard.press("Enter")
    releaseReconnectAuth(retiredForRetry)
    await expect(status).toHaveCount(0, { timeout: 20_000 })
    await expect(composer).toBeVisible()
    await expect.poll(() => composer.evaluate((element) => element.closest("[inert]") !== null))
      .toBe(false)
    await expect.poll(() => authenticatedConnections, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2)
    expect(tokenTimings).toHaveLength(bootstrapTokenCount)
    expect(recoveryAuthenticatedAt).not.toBeNull()
  } finally {
    releaseReconnectAuth()
    holdReconnectTokens = false
    releaseReconnectTokens()
    await alice.page.unroute("**/api/ws/token**", gateReconnectToken)
    await alice.context.setOffline(false).catch(() => {})
    await testInfo.attach("ws-sdk-reconnect-stages.json", {
      body: Buffer.from(JSON.stringify({
        clock: "test-runner performance.now(); browser event delivery timestamps",
        bootstrapStartedAt, bootstrapAuthenticatedAt,
        recoveryStartedAt, retryStartedAt, recoveryAuthenticatedAt,
        bootstrapActionToAuthMs: bootstrapAuthenticatedAt === null ? null : bootstrapAuthenticatedAt - bootstrapStartedAt,
        recoveryActionToAuthMs: recoveryAuthenticatedAt === null || recoveryStartedAt === null ? null : recoveryAuthenticatedAt - recoveryStartedAt,
        retryActionToAuthMs: recoveryAuthenticatedAt === null || retryStartedAt === null ? null : recoveryAuthenticatedAt - retryStartedAt,
        tokenTimings, bootstrapTokenCount, reconnectTokenCount: tokenTimings.length - bootstrapTokenCount,
        socketTimings: socketTimings.map(stage => ({
          ...stage,
          observedToAuthFrameMs: stage.authSentMs === null ? null : stage.authSentMs - stage.observedMs,
          authFrameToAckMs: stage.authOkMs === null || stage.authSentMs === null ? null : stage.authOkMs - stage.authSentMs,
        })),
        heldAuthOkCount,
        boundary: "Times are browser-event delivery observations, not exact network/open times. Recovery includes manual Retry and a test auth.ok gate; the current replacement's held server frame is released after Enter. No same-load latency comparison or fixed production saving.",
      })),
      contentType: "application/json",
    })
  }
})

test("an active onboarding form keeps focus priority during a reconnect", async ({ browser, caseResources }) => {
  test.setTimeout(90_000)
  const context = await caseResources.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  let userWs: WebSocketRoute | null = null
  let blockUserWs = false
  await page.routeWebSocket((url) => url.pathname.endsWith("/user"), (ws) => {
    userWs = ws
    if (blockUserWs) {
      ws.close({ code: 1012, reason: "active onboarding reconnect e2e outage" })
      return
    }
    ws.connectToServer()
  })

  let caseJourneyFailure1: unknown
let caseJourneyFailure1Present = false
  try {
    await installUserWsAuthConsumedBarrier(page)
    await page.goto("/sign-in")
    await page.getByRole("textbox", { name: "Email" }).fill(
      `guide-reconnect-${process.pid}-${Date.now()}@example.com`,
    )
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await page.waitForURL("**/c/me", { waitUntil: "commit" })
    await page.goto("/c/me/machines")
    await page.getByTestId(tid.onboardingStart).click()
    const onboarding = page.getByTestId(tid.onboardingHarnessDialog)
    await expect(onboarding).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute(
      USER_WS_AUTH_CONSUMED_ATTRIBUTE,
      "true",
      { timeout: 20_000 },
    )

    const onboardingAction = onboarding.getByRole("radio", { name: "Claude Code" })
    await onboardingAction.focus()
    blockUserWs = true
    expect(userWs).not.toBeNull()
    await userWs!.close({ code: 1012, reason: "active onboarding reconnect e2e outage" })

    await page.waitForTimeout(1_600)
    const failedStatus = page.getByTestId(tid.wsReconnectOverlay)
    if (await failedStatus.count()) {
      await expect(failedStatus).toHaveAttribute("data-ws-status", "failed")
      await expect(failedStatus).not.toHaveAttribute("aria-modal")
    }
    await expect(onboarding).toBeVisible()
    await expect(onboardingAction).toBeFocused()
    expect(await onboarding.evaluate((element) => element.closest("[inert]") !== null)).toBe(false)

    blockUserWs = false
    await expect(onboarding).toBeVisible()
  } catch (error) { caseJourneyFailure1 = error; caseJourneyFailure1Present = true; throw error } finally {
    try {

      blockUserWs = false
      await caseResources.closeContext(context)

    } catch (cleanupError) { if (caseJourneyFailure1Present) throw new AggregateError([caseJourneyFailure1, cleanupError], "Journey and resource exit both failed"); throw cleanupError }
  }
})
