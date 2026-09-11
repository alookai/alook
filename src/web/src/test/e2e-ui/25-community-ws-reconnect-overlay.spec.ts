import type { Locator, Page, TestInfo, WebSocketRoute } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import {
  composerEditable,
  gotoAfterUserWsAuth,
} from "./_fixtures/actions"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

const USER_WS_AUTH_CONSUMED_ATTRIBUTE = "data-e2e-user-ws-auth-consumed"

type AppEdgeEvidence = {
  token: string
  ariaHidden: string | null
  pointerEvents: string
  focusableCount: number
  appBackground: string
  surfaceBackground: string
  surface: { top: number; bottom: number; height: number }
  top: { top: number; bottom: number; height: number; backgroundImage: string }
  bottom: { top: number; bottom: number; height: number; backgroundImage: string }
  rootOverflowX: number
  rootOverflowY: number
}

async function appEdgeEvidence(surface: Locator): Promise<AppEdgeEvidence> {
  return surface.evaluate((element) => {
    const fade = element.querySelector<HTMLElement>('[data-slot="app-edge-fade"]')
    const top = fade?.querySelector<HTMLElement>('[data-app-edge="top"]')
    const bottom = fade?.querySelector<HTMLElement>('[data-app-edge="bottom"]')
    if (!fade || !top || !bottom) throw new Error("missing app edge fade")
    const probe = document.createElement("div")
    probe.style.background = "var(--app-bg)"
    probe.style.position = "fixed"
    probe.style.visibility = "hidden"
    document.body.appendChild(probe)
    const appBackground = getComputedStyle(probe).backgroundColor
    probe.remove()
    const surfaceRect = element.getBoundingClientRect()
    const topRect = top.getBoundingClientRect()
    const bottomRect = bottom.getBoundingClientRect()
    const root = document.documentElement
    return {
      token: getComputedStyle(root).getPropertyValue("--app-edge-fade-size").trim(),
      ariaHidden: fade.getAttribute("aria-hidden"),
      pointerEvents: getComputedStyle(fade).pointerEvents,
      focusableCount: fade.querySelectorAll("button, a, input, select, textarea, [tabindex]").length,
      appBackground,
      surfaceBackground: getComputedStyle(element).backgroundColor,
      surface: { top: surfaceRect.top, bottom: surfaceRect.bottom, height: surfaceRect.height },
      top: {
        top: topRect.top,
        bottom: topRect.bottom,
        height: topRect.height,
        backgroundImage: getComputedStyle(top).backgroundImage,
      },
      bottom: {
        top: bottomRect.top,
        bottom: bottomRect.bottom,
        height: bottomRect.height,
        backgroundImage: getComputedStyle(bottom).backgroundImage,
      },
      rootOverflowX: root.scrollWidth - root.clientWidth,
      rootOverflowY: root.scrollHeight - root.clientHeight,
    }
  })
}

function expectAppEdgeEvidence(evidence: AppEdgeEvidence) {
  expect(evidence.token).toBe("60px")
  expect(evidence.ariaHidden).toBe("true")
  expect(evidence.pointerEvents).toBe("none")
  expect(evidence.focusableCount).toBe(0)
  expect(evidence.top.height).toBeCloseTo(60, 1)
  expect(evidence.bottom.height).toBeCloseTo(60, 1)
  expect(evidence.top.top).toBeCloseTo(evidence.surface.top, 1)
  expect(evidence.top.bottom).toBeCloseTo(evidence.surface.top + 60, 1)
  expect(evidence.bottom.top).toBeCloseTo(evidence.surface.bottom - 60, 1)
  expect(evidence.bottom.bottom).toBeCloseTo(evidence.surface.bottom, 1)
  expect(evidence.top.backgroundImage).toContain("linear-gradient")
  expect(evidence.bottom.backgroundImage).toContain("linear-gradient")
  expect(evidence.top.backgroundImage).toContain(evidence.appBackground)
  expect(evidence.bottom.backgroundImage).toContain(evidence.appBackground)
  expect(evidence.rootOverflowX).toBe(0)
  expect(evidence.rootOverflowY).toBe(0)
}

async function attachEvidence(
  testInfo: TestInfo,
  page: Page,
  name: string,
  evidence: unknown,
) {
  await testInfo.attach(`${name}.json`, {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: "application/json",
  })
  await testInfo.attach(`${name}.png`, {
    body: await page.screenshot(),
    contentType: "image/png",
  })
}

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

test("app edge fade keeps the unresolved main surface native-aligned across theme, size, and motion", async ({ asUser }, testInfo) => {
  test.setTimeout(90_000)
  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `Edge fade ${suffix}`)
  const channelId = await seedChannel("alice", serverId, `edge-fade-${suffix}`)
  const alice = await asUser("alice")

  let releaseServerDetail!: () => void
  const serverDetailGate = new Promise<void>((resolve) => {
    releaseServerDetail = resolve
  })
  const detailPattern = new RegExp(`/api/community/servers/${serverId}/(?:categories|channels|unreads)(?:\\?|$)`)
  await alice.page.route(detailPattern, async (route) => {
    await serverDetailGate
    await route.continue()
  })

  try {
    await alice.page.setViewportSize({ width: 1280, height: 900 })
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    const unresolved = alice.page.locator("[data-community-unresolved-main]").first()
    await expect(unresolved).toBeVisible({ timeout: 10_000 })
    const matrix = [
      { name: "skeleton-1280-light-motion", width: 1280, height: 900, colorScheme: "light", reducedMotion: "no-preference" },
      { name: "skeleton-390-dark-motion", width: 390, height: 844, colorScheme: "dark", reducedMotion: "no-preference" },
      { name: "skeleton-1280-dark-reduced", width: 1280, height: 900, colorScheme: "dark", reducedMotion: "reduce" },
      { name: "skeleton-390-light-reduced", width: 390, height: 844, colorScheme: "light", reducedMotion: "reduce" },
    ] as const

    for (const entry of matrix) {
      await alice.page.emulateMedia({
        colorScheme: entry.colorScheme,
        reducedMotion: entry.reducedMotion,
      })
      await alice.page.setViewportSize({ width: entry.width, height: entry.height })
      await expect.poll(() => alice.page.evaluate(() => document.documentElement.classList.contains("dark")))
        .toBe(entry.colorScheme === "dark")
      const edge = await appEdgeEvidence(unresolved)
      expectAppEdgeEvidence(edge)
      expect(edge.surfaceBackground).toBe(edge.appBackground)
      const pulse = await unresolved.locator('[data-slot="skeleton"]').evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          animationDuration: style.animationDuration,
          animationName: style.animationName,
          backgroundColor: style.backgroundColor,
        }
      })
      expect(pulse.animationName === "none").toBe(entry.reducedMotion === "reduce")
      if (entry.reducedMotion === "no-preference") {
        expect(pulse.animationDuration).toBe("2s")
      }
      expect(pulse.backgroundColor).not.toBe(edge.appBackground)
      await attachEvidence(testInfo, alice.page, entry.name, { edge, pulse, entry })
    }
  } finally {
    releaseServerDetail()
  }
})

test("app edge fade keeps a real WebSocket outage native-aligned and Retry restores it", async ({ asUser }, testInfo) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Reconnect overlay ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "reconnect-overlay")
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
    const reconnectingEdge = await appEdgeEvidence(overlay)
    expectAppEdgeEvidence(reconnectingEdge)
    expect(reconnectingEdge.surfaceBackground).not.toBe(reconnectingEdge.appBackground)
    const reconnectingEvidence = await overlay.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const content = element.previousElementSibling as HTMLElement | null
      const connectingMotion = element.querySelector<HTMLElement>("[data-connecting-motion]")
      const connectingLetter = element.querySelector<HTMLElement>(".community-ws-connecting-letter")
      const connectingStyle = connectingMotion ? getComputedStyle(connectingMotion) : null
      const loaderStyle = getComputedStyle(element.querySelector<HTMLElement>("[data-slot='text-loader']")!)
      const label = element.querySelector<HTMLElement>(".community-ws-connecting-text")!
      const artwork = connectingMotion!.firstElementChild!.getBoundingClientRect()
      const text = label.getBoundingClientRect()
      return {
        ariaHidden: content?.getAttribute("aria-hidden"),
        inert: content?.hasAttribute("inert"),
        iconAnimationName: connectingStyle?.animationName,
        letterAnimationName: connectingLetter ? getComputedStyle(connectingLetter).animationName : null,
        svgCount: connectingMotion?.querySelectorAll("svg").length,
        artworkWidth: artwork.width,
        artworkHeight: artwork.height,
        labelWidth: text.width,
        verticalGap: text.top - artwork.bottom,
        rowGap: loaderStyle.rowGap,
        fontFamily: getComputedStyle(label).fontFamily,
        flexDirection: loaderStyle.flexDirection,
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
      svgCount: 5,
      rowGap: "8px",
      flexDirection: "column",
      loaderDisplay: "flex",
      loaderElement: "div",
      rect: { x: 0, y: 0, width: 390, height: 844 },
      viewport: { width: 390, height: 844 },
    })
    expect(reconnectingEvidence.artworkWidth).toBeCloseTo(172.8, 1)
    expect(reconnectingEvidence.artworkHeight).toBeCloseTo(172.8, 1)
    expect(reconnectingEvidence.verticalGap).toBeCloseTo(-6.4, 1)
    expect(reconnectingEvidence.fontFamily).not.toMatch(/mono/i)
    expect(reconnectingEvidence.artworkWidth * 660 / 1080).toBeGreaterThan(reconnectingEvidence.labelWidth)
    const artwork = overlay.locator("[data-connecting-motion]")
    const staticMarkup = await artwork.innerHTML()
    await alice.page.waitForTimeout(120)
    expect(await artwork.innerHTML()).toBe(staticMarkup)
    await alice.page.emulateMedia({ reducedMotion: "no-preference" })
    await expect.poll(() => artwork.innerHTML()).not.toBe(staticMarkup)
    await alice.page.waitForTimeout(2600)
    await alice.page.screenshot({ path: testInfo.outputPath("390-logo.png") })
    await alice.page.setViewportSize({ width: 1280, height: 900 })
    expect((await artwork.locator("span").first().boundingBox())!.width).toBe(192)
    await alice.page.screenshot({ path: testInfo.outputPath("1280-logo.png") })
    await expect.poll(() => artwork.locator("div").evaluateAll((elements) => elements.some((element) => (element as HTMLElement).style.clipPath.startsWith("inset(-300px")))).toBe(true)
    await alice.page.screenshot({ path: testInfo.outputPath("1280-bots.png") })
    await alice.page.setViewportSize({ width: 390, height: 844 })
    await alice.page.screenshot({ path: testInfo.outputPath("390-bots.png") })
    await alice.page.emulateMedia({ reducedMotion: "reduce" })
    await expect.poll(() => artwork.innerHTML()).toBe(staticMarkup)
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
    await testInfo.attach("390-dark-reconnecting-reduced-motion-edge.json", {
      body: Buffer.from(JSON.stringify(reconnectingEdge, null, 2)),
      contentType: "application/json",
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
    const failedEdge = await appEdgeEvidence(overlay)
    expectAppEdgeEvidence(failedEdge)
    await testInfo.attach("failed-edge.json", {
      body: Buffer.from(JSON.stringify(failedEdge, null, 2)),
      contentType: "application/json",
    })
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
    expect(authenticatedConnections).toBeGreaterThanOrEqual(2)
    await testInfo.attach("ws-recovery-evidence", { body: JSON.stringify({ authenticatedConnections, status: "connected", overlayRemoved: true }), contentType: "application/json" })
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
    await page.waitForURL("**/c/me", { waitUntil: "commit" })
    await expect.poll(async () => {
      const cookies = await page.context().cookies()
      return cookies.some((cookie) => cookie.name === "is_new_signup")
    }).toBe(false)

    const onboarding = page.getByTestId(tid.onboardingHarnessDialog)
    await page.waitForTimeout(250)
    await expect(page).toHaveURL(/\/c\/me$/)
    await expect(onboarding).toHaveCount(0)

    await page.goto("/c/me/machines")
    const startOnboarding = page.getByTestId(tid.onboardingStart)
    await expect(startOnboarding).toBeVisible()
    await startOnboarding.click()
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
