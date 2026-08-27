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
      const spinner = element.querySelector<SVGElement>("svg")
      return {
        ariaHidden: content?.getAttribute("aria-hidden"),
        inert: content?.hasAttribute("inert"),
        animationName: spinner ? getComputedStyle(spinner).animationName : null,
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
