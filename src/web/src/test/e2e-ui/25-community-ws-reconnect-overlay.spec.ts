import type { Page, WebSocketRoute } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import {
  composerEditable,
  gotoAfterUserWsAuth,
} from "./_fixtures/actions"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

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
            // The next task runs after the current message event has finished
            // dispatching to the application's WebSocket listener.
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
    const overlay = alice.page.getByTestId(tid.wsReconnectOverlay)
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => tokenRequests).toBeGreaterThan(0)
    await alice.page.waitForTimeout(1_600)
    await expect(overlay).toHaveCount(0)
    await composer.fill("Cold start stays usable")
    await expect(composer).toContainText("Cold start stays usable")

    holdTokens = false
    releaseTokens()
    await expect.poll(() => socketAttempts, { timeout: 20_000 }).toBeGreaterThan(1)
    await alice.page.waitForTimeout(1_600)
    await expect(overlay).toHaveCount(0)
    await expect(composer).toContainText("Cold start stays usable")
  } finally {
    holdTokens = false
    releaseTokens()
  }
})

test("real WebSocket outage blocks the whole community surface and Retry restores it", async ({ asUser }, testInfo) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Reconnect overlay ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "reconnect-overlay")
  const alice = await asUser("alice")
  let aliceWs: WebSocketRoute | null = null
  await alice.page.routeWebSocket((url) => url.pathname.endsWith("/user"), (ws) => {
    aliceWs = ws
    ws.connectToServer()
  })
  await alice.page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" })
  await alice.page.setViewportSize({ width: 390, height: 844 })
  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
  const composer = composerEditable(alice.page)
  await expect(composer).toBeVisible()
  await expect(alice.page.getByTestId(tid.wsReconnectOverlay)).toHaveCount(0)

  try {
    await alice.context.setOffline(true)
    expect(aliceWs).not.toBeNull()
    await aliceWs!.close({ code: 1012, reason: "reconnect overlay e2e outage" })

    const overlay = alice.page.getByTestId(tid.wsReconnectOverlay)
    await expect(overlay).toBeVisible({ timeout: 10_000 })
    await expect(overlay).toHaveAttribute("data-ws-status", "reconnecting")
    await expect(overlay).toBeFocused()
    await expect(overlay.getByRole("status")).toContainText("Connecting…")
    const reconnectingEvidence = await overlay.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const content = element.previousElementSibling as HTMLElement | null
      const connectingMotion = element.querySelector<HTMLElement>("[data-connecting-motion]")
      const connectingLetter = element.querySelector<HTMLElement>(".community-ws-connecting-letter")
      const connectingStyle = connectingMotion ? getComputedStyle(connectingMotion) : null
      const loaderStyle = getComputedStyle(element.querySelector<HTMLElement>("[data-slot='text-loader']")!)
      return {
        ariaHidden: content?.getAttribute("aria-hidden"),
        inert: content?.hasAttribute("inert"),
        iconAnimationName: connectingStyle?.animationName,
        letterAnimationName: connectingLetter ? getComputedStyle(connectingLetter).animationName : null,
        loaderBackground: connectingStyle?.backgroundColor,
        loaderDisplay: loaderStyle.display,
        loaderElement: connectingMotion?.tagName.toLowerCase(),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: { width: innerWidth, height: innerHeight },
      }
    })
    expect(reconnectingEvidence).toMatchObject({
      ariaHidden: "true",
      inert: true,
      iconAnimationName: "none",
      letterAnimationName: "none",
      loaderBackground: "rgb(124, 9, 17)",
      loaderDisplay: "flex",
      loaderElement: "span",
      rect: { x: 0, y: 0, width: 390, height: 844 },
      viewport: { width: 390, height: 844 },
    })
    await alice.page.keyboard.press("Tab")
    expect(await alice.page.evaluate(() => {
      const inertRoot = document.querySelector("[inert]")
      return inertRoot?.contains(document.activeElement) ?? false
    })).toBe(false)
    const mobileReconnectPath = testInfo.outputPath("390-dark-reconnecting-reduced-motion.png")
    await alice.page.screenshot({ path: mobileReconnectPath })
    await testInfo.attach("390-dark-reconnecting-reduced-motion.png", {
      path: mobileReconnectPath,
      contentType: "image/png",
    })

    await alice.page.setViewportSize({ width: 1280, height: 900 })
    expect(await overlay.boundingBox()).toMatchObject({ x: 0, y: 0, width: 1280, height: 900 })
    const desktopReconnectPath = testInfo.outputPath("1280-dark-reconnecting-reduced-motion.png")
    await alice.page.screenshot({ path: desktopReconnectPath })
    await testInfo.attach("1280-dark-reconnecting-reduced-motion.png", {
      path: desktopReconnectPath,
      contentType: "image/png",
    })

    await alice.page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" })
    await expect.poll(() => alice.page.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(false)
    const desktopLightReconnectPath = testInfo.outputPath("1280-light-reconnecting-reduced-motion.png")
    await alice.page.screenshot({ path: desktopLightReconnectPath })
    await testInfo.attach("1280-light-reconnecting-reduced-motion.png", {
      path: desktopLightReconnectPath,
      contentType: "image/png",
    })

    await alice.page.setViewportSize({ width: 390, height: 844 })
    const mobileLightReconnectPath = testInfo.outputPath("390-light-reconnecting-reduced-motion.png")
    await alice.page.screenshot({ path: mobileLightReconnectPath })
    await testInfo.attach("390-light-reconnecting-reduced-motion.png", {
      path: mobileLightReconnectPath,
      contentType: "image/png",
    })

    const retry = alice.page.getByTestId(tid.wsRetry)
    await expect(retry).toBeVisible({ timeout: 40_000 })
    await expect(overlay).toHaveAttribute("data-ws-status", "failed")
    await expect(overlay.getByRole("alert")).toContainText("Connection lost")
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44)

    await alice.page.setViewportSize({ width: 1280, height: 900 })
    const desktopRect = await overlay.boundingBox()
    expect(desktopRect).toMatchObject({ x: 0, y: 0, width: 1280, height: 900 })
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(40)
    await testInfo.attach("1280-failed-retry.png", {
      body: await alice.page.screenshot(),
      contentType: "image/png",
    })

    await alice.context.setOffline(false)
    await retry.click()
    await expect(overlay).toHaveCount(0, { timeout: 20_000 })
    await expect(composer).toBeVisible()
    expect(await alice.page.locator("[inert]").count()).toBe(0)
  } finally {
    await alice.context.setOffline(false)
  }
})

test("an active onboarding form yields focus priority during outage, then resumes", async ({ browser }, testInfo) => {
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
    await page.waitForURL("**/c/me/machines", { waitUntil: "commit" })
    const onboarding = page.getByRole("dialog")
    await expect(onboarding).toBeVisible()
    await expect(onboarding.getByRole("heading", { name: "Which harness do you already use?" })).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute(
      USER_WS_AUTH_CONSUMED_ATTRIBUTE,
      "true",
      { timeout: 20_000 },
    )

    blockUserWs = true
    expect(userWs).not.toBeNull()
    await userWs!.close({ code: 1012, reason: "active onboarding reconnect e2e outage" })

    const overlay = page.getByTestId(tid.wsReconnectOverlay)
    await expect(overlay).toBeVisible({ timeout: 10_000 })
    await expect(overlay).toBeFocused()
    const stacking = await page.evaluate((overlayId) => {
      const reconnect = document.querySelector<HTMLElement>(`[data-testid='${overlayId}']`)
      const dialog = document.querySelector<HTMLElement>("[role='dialog']")
      if (!reconnect || !dialog) throw new Error("stacking targets are missing")
      const reconnectRect = reconnect.getBoundingClientRect()
      const topAtCenter = document.elementFromPoint(
        reconnectRect.left + reconnectRect.width / 2,
        reconnectRect.top + reconnectRect.height / 2,
      )
      return {
        reconnect: Number.parseInt(getComputedStyle(reconnect).zIndex, 10),
        dialog: Number.parseInt(getComputedStyle(dialog).zIndex, 10),
        topBelongsToReconnect: reconnect.contains(topAtCenter),
      }
    }, tid.wsReconnectOverlay)
    expect(stacking.reconnect).toBeGreaterThanOrEqual(stacking.dialog)
    expect(stacking.topBelongsToReconnect).toBe(true)

    await expect(overlay).toBeFocused()
    await page.keyboard.press("Tab")
    expect(await page.evaluate((overlayId) => {
      const reconnect = document.querySelector(`[data-testid='${overlayId}']`)
      return reconnect?.contains(document.activeElement) ?? false
    }, tid.wsReconnectOverlay)).toBe(true)
    await testInfo.attach("390-active-onboarding-reconnecting.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    })

    blockUserWs = false
    await expect(overlay).toHaveCount(0, { timeout: 20_000 })
    await expect(onboarding).toBeVisible()
    await expect(onboarding.getByRole("heading", { name: "Which harness do you already use?" })).toBeVisible()
  } finally {
    if (!page.isClosed()) {
      blockUserWs = false
      await context.close()
    }
  }
})
