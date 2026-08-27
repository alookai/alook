import type { WebSocketRoute } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

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
  await alice.page.emulateMedia({ reducedMotion: "reduce" })
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
      return {
        ariaHidden: content?.getAttribute("aria-hidden"),
        inert: content?.hasAttribute("inert"),
        animationName: connectingMotion
          ? getComputedStyle(connectingMotion, "::after").animationName
          : null,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: { width: innerWidth, height: innerHeight },
      }
    })
    expect(reconnectingEvidence).toMatchObject({
      ariaHidden: "true",
      inert: true,
      animationName: "none",
      rect: { x: 0, y: 0, width: 390, height: 844 },
      viewport: { width: 390, height: 844 },
    })
    await alice.page.keyboard.press("Tab")
    expect(await alice.page.evaluate(() => {
      const inertRoot = document.querySelector("[inert]")
      return inertRoot?.contains(document.activeElement) ?? false
    })).toBe(false)
    const mobileReconnectPath = testInfo.outputPath("390-reconnecting-reduced-motion.png")
    await alice.page.screenshot({ path: mobileReconnectPath })
    await testInfo.attach("390-reconnecting-reduced-motion.png", {
      path: mobileReconnectPath,
      contentType: "image/png",
    })

    await alice.page.setViewportSize({ width: 1280, height: 900 })
    expect(await overlay.boundingBox()).toMatchObject({ x: 0, y: 0, width: 1280, height: 900 })
    const desktopReconnectPath = testInfo.outputPath("1280-reconnecting-reduced-motion.png")
    await alice.page.screenshot({ path: desktopReconnectPath })
    await testInfo.attach("1280-reconnecting-reduced-motion.png", {
      path: desktopReconnectPath,
      contentType: "image/png",
    })
    await alice.page.setViewportSize({ width: 390, height: 844 })

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

test("an active onboarding guide yields visual and focus priority during outage, then resumes", async ({ browser }, testInfo) => {
  test.setTimeout(90_000)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  let userWs: WebSocketRoute | null = null
  await page.routeWebSocket((url) => url.pathname.endsWith("/user"), (ws) => {
    userWs = ws
    ws.connectToServer()
  })

  try {
    await page.goto("/sign-in")
    await page.getByRole("textbox", { name: "Email" }).fill(
      `guide-reconnect-${process.pid}-${Date.now()}@example.com`,
    )
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await page.waitForURL("**/c/me/machines", { waitUntil: "commit" })
    await expect(page.getByRole("heading", { name: "No machines yet" })).toBeVisible()
    await page.getByRole("button", { name: "Guide me" }).click()

    const guide = page.locator(".driver-popover.community-onboarding-popover")
    await expect(guide).toBeVisible()
    await expect(guide.getByRole("heading", { name: "Give your bot a place to run" })).toBeVisible()
    await expect(page.locator("body")).toHaveClass(/community-onboarding-active/)

    await context.setOffline(true)
    expect(userWs).not.toBeNull()
    await userWs!.close({ code: 1012, reason: "active onboarding reconnect e2e outage" })

    const overlay = page.getByTestId(tid.wsReconnectOverlay)
    await expect(overlay).toBeVisible({ timeout: 10_000 })
    await expect(overlay).toBeFocused()
    const stacking = await page.evaluate((overlayId) => {
      const reconnect = document.querySelector<HTMLElement>(`[data-testid='${overlayId}']`)
      const popover = document.querySelector<HTMLElement>(".driver-popover")
      const activeTarget = document.querySelector<HTMLElement>(".driver-active-element")
      if (!reconnect || !popover || !activeTarget) throw new Error("stacking targets are missing")
      const reconnectRect = reconnect.getBoundingClientRect()
      const topAtCenter = document.elementFromPoint(
        reconnectRect.left + reconnectRect.width / 2,
        reconnectRect.top + reconnectRect.height / 2,
      )
      return {
        reconnect: Number.parseInt(getComputedStyle(reconnect).zIndex, 10),
        popover: Number.parseInt(getComputedStyle(popover).zIndex, 10),
        activeTarget: Number.parseInt(getComputedStyle(activeTarget).zIndex, 10),
        topBelongsToReconnect: reconnect.contains(topAtCenter),
      }
    }, tid.wsReconnectOverlay)
    expect(stacking.reconnect).toBeGreaterThan(stacking.popover)
    expect(stacking.reconnect).toBeGreaterThan(stacking.activeTarget)
    expect(stacking.topBelongsToReconnect).toBe(true)

    await guide.getByRole("button", { name: "Skip guide" }).evaluate((element) => {
      (element as HTMLElement).focus()
    })
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

    await context.setOffline(false)
    await expect(overlay).toHaveCount(0, { timeout: 20_000 })
    await expect(guide).toBeVisible()
    await expect(page.locator("body")).toHaveClass(/community-onboarding-active/)
    await guide.getByRole("button", { name: "Skip guide" }).evaluate((element) => {
      (element as HTMLElement).click()
    })
    await expect(guide).toHaveCount(0)
    await expect(page.locator("body")).not.toHaveClass(/community-onboarding-active/)
  } finally {
    if (!page.isClosed()) {
      await context.setOffline(false)
      await context.close()
    }
  }
})
