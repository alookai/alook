import type { WebSocketRoute } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { isClientMutationRequest } from "./_fixtures/client-request-policy"

test("real WebSocket outage keeps covered content and drafts usable while Retry restores realtime", async ({ asUser }, testInfo) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Reconnect overlay ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "reconnect-overlay")
  const alice = await asUser("alice")
  let aliceWs: WebSocketRoute | null = null
  let wsConnections = 0
  const businessMutations: string[] = []
  await alice.page.routeWebSocket((url) => url.pathname.endsWith("/user"), (ws) => {
    aliceWs = ws
    wsConnections += 1
    ws.connectToServer()
  })
  await alice.page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" })
  await alice.page.setViewportSize({ width: 390, height: 844 })
  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
  const composer = composerEditable(alice.page)
  await expect(composer).toBeVisible()
  await expect(alice.page.getByTestId(tid.wsReconnectOverlay)).toHaveCount(0)
  alice.page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname
    if (isClientMutationRequest(request.method(), pathname)) {
      businessMutations.push(`${request.method()} ${pathname}`)
    }
  })

  try {
    await alice.context.setOffline(true)
    expect(aliceWs).not.toBeNull()
    await aliceWs!.close({ code: 1012, reason: "reconnect overlay e2e outage" })

    const overlay = alice.page.getByTestId(tid.wsReconnectOverlay)
    await expect(overlay).toBeVisible({ timeout: 10_000 })
    await expect(overlay).toHaveAttribute("data-ws-status", "reconnecting")
    await expect(overlay).not.toBeFocused()
    await expect(overlay.getByRole("status")).toContainText("Reconnecting…")
    const reconnectingEvidence = await overlay.evaluate((element) => {
      const pill = element.firstElementChild as HTMLElement | null
      if (!pill) throw new Error("reconnect status pill is missing")
      const rect = pill.getBoundingClientRect()
      const content = element.previousElementSibling as HTMLElement | null
      return {
        ariaHidden: content?.getAttribute("aria-hidden"),
        inert: content?.hasAttribute("inert"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: { width: innerWidth, height: innerHeight },
      }
    })
    expect(reconnectingEvidence).toMatchObject({
      ariaHidden: null,
      inert: false,
      viewport: { width: 390, height: 844 },
    })
    expect(reconnectingEvidence.rect.width).toBeLessThan(390)
    expect(reconnectingEvidence.rect.height).toBeLessThanOrEqual(60)
    const draft = `offline draft ${Date.now()}`
    await composer.fill(draft)
    await expect(composer).toContainText(draft)
    await expect(composer).toBeFocused()
    expect(businessMutations).toEqual([])
    const mobileReconnectPath = testInfo.outputPath("390-dark-reconnecting-reduced-motion.png")
    await alice.page.screenshot({ path: mobileReconnectPath })
    await testInfo.attach("390-dark-reconnecting-reduced-motion.png", {
      path: mobileReconnectPath,
      contentType: "image/png",
    })

    await alice.page.setViewportSize({ width: 1280, height: 900 })
    const overlayPill = overlay.locator(":scope > *").first()
    expect((await overlayPill.boundingBox())!.width).toBeLessThan(1280)
    await expect(composer).toContainText(draft)
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
    await expect(overlay.getByRole("alert")).toContainText("Realtime unavailable")
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(32)
    await expect(composer).toContainText(draft)

    await alice.page.setViewportSize({ width: 1280, height: 900 })
    const desktopRect = await overlayPill.boundingBox()
    expect(desktopRect!.width).toBeLessThan(1280)
    expect(desktopRect!.height).toBeLessThanOrEqual(60)
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(32)
    await testInfo.attach("1280-failed-retry.png", {
      body: await alice.page.screenshot(),
      contentType: "image/png",
    })

    await alice.context.setOffline(false)
    await retry.click()
    await expect(overlay).toHaveCount(0, { timeout: 20_000 })
    await expect.poll(() => wsConnections).toBeGreaterThan(1)
    await expect(composer).toBeVisible()
    await expect(composer).toContainText(draft)
    expect(await alice.page.locator("[inert]").count()).toBe(0)
    expect(businessMutations).toEqual([])
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
    await page.goto("/sign-in")
    await page.getByRole("textbox", { name: "Email" }).fill(
      `guide-reconnect-${process.pid}-${Date.now()}@example.com`,
    )
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await page.waitForURL("**/c/me/machines", { waitUntil: "commit" })
    const onboarding = page.getByRole("dialog")
    await expect(onboarding).toBeVisible()
    await expect(onboarding.getByRole("heading", { name: "Which harness do you already use?" })).toBeVisible()
    const onboardingFocus = onboarding.getByRole("radio").first()
    await onboardingFocus.focus()
    await expect(onboardingFocus).toBeFocused()

    blockUserWs = true
    expect(userWs).not.toBeNull()
    await userWs!.close({ code: 1012, reason: "active onboarding reconnect e2e outage" })

    const overlay = page.getByTestId(tid.wsReconnectOverlay)
    await expect(overlay).toBeVisible({ timeout: 10_000 })
    await expect(overlay).not.toBeFocused()
    await expect(onboardingFocus).toBeFocused()
    const focusAndLayout = await page.evaluate((overlayId) => {
      const reconnect = document.querySelector<HTMLElement>(`[data-testid='${overlayId}']`)
      const dialog = document.querySelector<HTMLElement>("[role='dialog']")
      if (!reconnect || !dialog) throw new Error("reconnect/dialog targets are missing")
      const pill = reconnect.firstElementChild as HTMLElement | null
      if (!pill) throw new Error("reconnect status pill is missing")
      const reconnectRect = pill.getBoundingClientRect()
      return {
        dialogOwnsFocus: dialog.contains(document.activeElement),
        reconnectHeight: reconnectRect.height,
        inertCount: document.querySelectorAll("[inert]").length,
      }
    }, tid.wsReconnectOverlay)
    expect(focusAndLayout).toEqual({
      dialogOwnsFocus: true,
      reconnectHeight: expect.any(Number),
      inertCount: 0,
    })
    expect(focusAndLayout.reconnectHeight).toBeLessThanOrEqual(60)

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
