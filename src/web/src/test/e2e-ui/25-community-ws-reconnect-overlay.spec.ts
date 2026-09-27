import type { Page, WebSocketRoute } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import {
  composerEditable,
  gotoAfterUserWsAuth,
} from "./_fixtures/actions"
import { seedChannel, seedServer } from "./_fixtures/seed"
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

test("slow auth and an initial retry never block a cold Community page", async ({ asUser }) => {
  test.setTimeout(90_000)
  const serverId = await seedServer("alice", `Reconnect cold start ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "reconnect-cold-start")
  const alice = await asUser("alice")
  let tokenRequests = 0
  let releaseTokens!: () => void
  let holdTokens = true
  const tokenGate = new Promise<void>((resolve) => {
    releaseTokens = resolve
  })
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

test("a real WebSocket outage keeps cached content interactive and Retry reconnects", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Reconnect status ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "reconnect-status")
  const alice = await asUser("alice")
  let authenticatedConnections = 0
  alice.page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      try {
        if (JSON.parse(payload.toString()).type === "auth.ok") authenticatedConnections += 1
      } catch {}
    })
  })
  let aliceWs: WebSocketRoute | null = null
  await alice.page.routeWebSocket((url) => url.pathname.endsWith("/user"), (ws) => {
    aliceWs = ws
    ws.connectToServer()
  })
  await alice.page.setViewportSize({ width: 390, height: 844 })
  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
  const composer = composerEditable(alice.page)
  await expect(composer).toBeVisible()

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

    await alice.context.setOffline(false)
    await retry.focus()
    await expect(retry).toBeFocused()
    await alice.page.keyboard.press("Enter")
    await expect(status).toHaveCount(0, { timeout: 20_000 })
    await expect(composer).toBeVisible()
    await expect.poll(() => composer.evaluate((element) => element.closest("[inert]") !== null))
      .toBe(false)
    await expect.poll(() => authenticatedConnections, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2)
  } finally {
    await alice.context.setOffline(false).catch(() => {})
  }
})

test("an active onboarding form keeps focus priority during a reconnect", async ({ browser }) => {
  test.setTimeout(90_000)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
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
  } finally {
    blockUserWs = false
    await context.close().catch(() => {})
  }
})
