import type { Page, WebSocketRoute } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"

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
