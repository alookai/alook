import type { Page, Request, Route, TestInfo } from "@playwright/test"
import { expect, test } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth, waitForElementMotion } from "./_fixtures/actions"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

const layoutStorageKey = "react-resizable-panels:community-shell"
const expectedDefaultSidebarWidth = 317
const expectedOuterWidth = 375
const expectedVisibleWidth = 359
const geometryEpsilon = 1

const shellPanel = (page: Page, id: "sidebar" | "main") => (
  page.locator(`[data-slot="resizable-panel"][data-testid="${id}"]`)
)

type LayoutSample = {
  sidebar: number
  overlay: number
}

type ShellGeometry = {
  sidebar: number
  main: number
  overlay: number
  wrapper: number
  base: number
  paddingLeft: number
  paddingRight: number
}

const outdatedMachine = {
  id: "machine_desktop_width",
  hostname: "studio-mac",
  displayName: "Studio Mac",
  platform: "darwin",
  arch: "arm64",
  osRelease: "26.0",
  daemonVersion: "0.1.7",
  lastSeenAt: null,
  status: "online",
  availableRuntimes: [],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  quota: [],
}

async function installLayoutState(
  page: Page,
  layout: { sidebar: number; main: number } | null,
) {
  await page.addInitScript(({ key, savedLayout, sidebarTestId }) => {
    const initializedKey = `${key}:test-initialized`
    if (!sessionStorage.getItem(initializedKey)) {
      if (savedLayout) localStorage.setItem(key, JSON.stringify(savedLayout))
      else localStorage.removeItem(key)
      sessionStorage.setItem(initializedKey, "true")
    }

    const samples: LayoutSample[] = []
    Reflect.set(window, "__desktopWidthSamples", samples)
    const capture = () => {
      const sidebar = document.querySelector<HTMLElement>(
        `[data-slot="resizable-panel"][data-testid="${sidebarTestId}"]`,
      )
      const overlay = document.querySelector<HTMLElement>(
        '[data-slot="community-user-bar-overlay"]',
      )
      if (sidebar && overlay && samples.length < 240) {
        samples.push({
          sidebar: sidebar.getBoundingClientRect().width,
          overlay: overlay.getBoundingClientRect().width,
        })
      }
      requestAnimationFrame(capture)
    }
    requestAnimationFrame(capture)
  }, { key: layoutStorageKey, savedLayout: layout, sidebarTestId: "sidebar" })
}

async function holdSession(page: Page) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let hits = 0
  const handler = async (route: Route) => {
    hits += 1
    await gate
    await route.continue()
  }
  await page.route("**/api/auth/get-session**", handler)
  return { hits: () => hits, release }
}

async function serveOutdatedMachine(page: Page) {
  await page.route("**/api/community/machines", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ machines: [outdatedMachine] }),
    })
  })
}

function captureWrites(page: Page) {
  const writes: string[] = []
  const listener = (request: Request) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    }
  }
  page.on("request", listener)
  return { writes, stop: () => page.off("request", listener) }
}

async function readShellGeometry(page: Page): Promise<ShellGeometry> {
  return page.locator('[data-slot="community-user-bar-overlay"]').evaluate((overlay, ids) => {
    const sidebar = document.querySelector<HTMLElement>(
      `[data-slot="resizable-panel"][data-testid="${ids.sidebar}"]`,
    )
    const main = document.querySelector<HTMLElement>(
      `[data-slot="resizable-panel"][data-testid="${ids.main}"]`,
    )
    const wrapper = document.querySelector<HTMLElement>(
      `[data-testid="${ids.userBar}"]`,
    )
    const base = wrapper?.querySelector<HTMLElement>(
      '[data-slot="community-user-bar-base"]',
    )
    if (!sidebar || !main || !wrapper || !base) {
      throw new Error("missing desktop shell geometry")
    }
    const wrapperStyle = getComputedStyle(wrapper)
    return {
      sidebar: sidebar.getBoundingClientRect().width,
      main: main.getBoundingClientRect().width,
      overlay: overlay.getBoundingClientRect().width,
      wrapper: wrapper.getBoundingClientRect().width,
      base: base.getBoundingClientRect().width,
      paddingLeft: Number.parseFloat(wrapperStyle.paddingLeft),
      paddingRight: Number.parseFloat(wrapperStyle.paddingRight),
    }
  }, { sidebar: "sidebar", main: "main", userBar: tid.userBar })
}

async function expectDesktopGeometry(page: Page, sidebarWidth: number) {
  await expect(page.getByTestId(tid.userBar)).toBeVisible()
  await expect(shellPanel(page, "sidebar")).toBeVisible()
  await expect(page.locator('[data-slot="community-user-bar-overlay"]')).toBeVisible()
  await expect.poll(async () => {
    const geometry = await readShellGeometry(page)
    return {
      sidebar: Math.abs(geometry.sidebar - sidebarWidth) <= geometryEpsilon,
      overlay: Math.abs(geometry.overlay - (sidebarWidth + 58)) <= geometryEpsilon,
      wrapper: Math.abs(geometry.wrapper - (sidebarWidth + 58)) <= geometryEpsilon,
      base: Math.abs(geometry.base - (sidebarWidth + 42)) <= geometryEpsilon,
      paddingLeft: geometry.paddingLeft,
      paddingRight: geometry.paddingRight,
    }
  }).toEqual({
    sidebar: true,
    overlay: true,
    wrapper: true,
    base: true,
    paddingLeft: 8,
    paddingRight: 8,
  })
}

async function expectExtensionGeometry(page: Page) {
  const extension = page.getByTestId(tid.userBarExtension)
  const base = page.getByTestId(tid.userBar).locator(
    '[data-slot="community-user-bar-base"]',
  )
  const [extensionBox, baseBox] = await Promise.all([
    extension.boundingBox(),
    base.boundingBox(),
  ])
  expect(extensionBox).not.toBeNull()
  expect(baseBox).not.toBeNull()
  expect(Math.abs(extensionBox!.width - expectedVisibleWidth)).toBeLessThanOrEqual(
    geometryEpsilon,
  )
  expect(Math.abs(baseBox!.width - expectedVisibleWidth)).toBeLessThanOrEqual(
    geometryEpsilon,
  )
  expect(Math.abs(extensionBox!.x - baseBox!.x)).toBeLessThanOrEqual(geometryEpsilon)
  expect(Math.abs(extensionBox!.x + extensionBox!.width - baseBox!.x - baseBox!.width))
    .toBeLessThanOrEqual(geometryEpsilon)
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot(),
    contentType: "image/png",
  })
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    contentType: "application/json",
  })
}

test.describe.serial("desktop default User Bar width", () => {
  let serverId: string
  let channelId: string

  test.beforeAll(async () => {
    const stamp = Date.now()
    serverId = await seedServer("alice", `Desktop width ${stamp}`)
    channelId = await seedChannel("alice", serverId, `desktop-width-${stamp}`)
  })

  test("keeps unsaved, saved, and user-resized layouts pixel-stable", async ({
    asUser,
  }, testInfo) => {
    test.setTimeout(180_000)

    const fresh = await asUser("alice")
    await fresh.page.setViewportSize({ width: 1280, height: 900 })
    await installLayoutState(fresh.page, null)
    await gotoAfterUserWsAuth(
      fresh.page,
      `/c/channels/${serverId}/${channelId}`,
    )
    await expectDesktopGeometry(fresh.page, expectedDefaultSidebarWidth)
    await fresh.page.waitForTimeout(250)
    expect(await fresh.page.evaluate((key) => localStorage.getItem(key), layoutStorageKey))
      .toBeNull()

    const hydrationSamples = await fresh.page.evaluate(() => (
      Reflect.get(window, "__desktopWidthSamples") as LayoutSample[]
    ))
    const completeSamples = hydrationSamples.filter(({ sidebar, overlay }) => (
      sidebar > 0 && overlay > 0
    ))
    expect(completeSamples.length).toBeGreaterThan(0)
    for (const sample of completeSamples) {
      expect(Math.abs(sample.sidebar - expectedDefaultSidebarWidth)).toBeLessThanOrEqual(
        geometryEpsilon,
      )
      expect(Math.abs(sample.overlay - expectedOuterWidth)).toBeLessThanOrEqual(
        geometryEpsilon,
      )
    }

    for (const width of [1024, 640]) {
      await fresh.page.setViewportSize({ width, height: 768 })
      await expectDesktopGeometry(fresh.page, expectedDefaultSidebarWidth)
    }
    await fresh.page.setViewportSize({ width: 639, height: 768 })
    await expect(shellPanel(fresh.page, "sidebar")).toBeHidden()
    await expect(shellPanel(fresh.page, "main")).toBeVisible()
    await fresh.page.setViewportSize({ width: 640, height: 768 })
    await expectDesktopGeometry(fresh.page, expectedDefaultSidebarWidth)
    expect(await fresh.page.evaluate((key) => localStorage.getItem(key), layoutStorageKey))
      .toBeNull()
    await fresh.context.close()

    const mobileGeometry: Array<Record<string, unknown>> = []
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
    ]) {
      const mobile = await asUser("alice")
      await mobile.page.setViewportSize(viewport)
      await installLayoutState(mobile.page, null)
      await gotoAfterUserWsAuth(mobile.page, `/c/channels/${serverId}`)
      await expect(mobile.page.locator(
        '[data-community-mobile-surface="list"]',
      )).toBeVisible()
      const wrapper = mobile.page.getByTestId(tid.userBar)
      await expect(wrapper).toBeVisible()
      await mobile.page.evaluate(() => {
        document.documentElement.style.setProperty("--app-safe-area-left", "20px")
        document.documentElement.style.setProperty("--app-safe-area-right", "18px")
        document.documentElement.style.setProperty("--app-safe-area-bottom", "16px")
      })
      const geometry = await wrapper.evaluate((element) => {
        const style = getComputedStyle(element)
        const base = element.querySelector<HTMLElement>(
          '[data-slot="community-user-bar-base"]',
        )
        if (!base) throw new Error("missing mobile User Bar base")
        return {
          wrapperWidth: element.getBoundingClientRect().width,
          baseWidth: base.getBoundingClientRect().width,
          baseHeight: base.getBoundingClientRect().height,
          paddingLeft: Number.parseFloat(style.paddingLeft),
          paddingRight: Number.parseFloat(style.paddingRight),
          paddingBottom: Number.parseFloat(style.paddingBottom),
        }
      })
      expect(geometry).toEqual({
        wrapperWidth: viewport.width,
        baseWidth: viewport.width - 38,
        baseHeight: 48,
        paddingLeft: 20,
        paddingRight: 18,
        paddingBottom: 28,
      })
      expect(await mobile.page.evaluate(
        (key) => localStorage.getItem(key),
        layoutStorageKey,
      )).toBeNull()
      mobileGeometry.push({ viewport, ...geometry })
      await mobile.context.close()
    }

    const seededLayout = { sidebar: 25, main: 75 }
    const seededStorage = JSON.stringify(seededLayout)
    const saved = await asUser("alice")
    await saved.page.setViewportSize({ width: 1280, height: 900 })
    await installLayoutState(saved.page, seededLayout)
    await gotoAfterUserWsAuth(saved.page, `/c/channels/${serverId}/${channelId}`)
    await expect(shellPanel(saved.page, "sidebar")).toBeVisible()
    await expect.poll(async () => (
      Math.abs((await readShellGeometry(saved.page)).sidebar - expectedDefaultSidebarWidth)
    )).toBeGreaterThan(1)
    const restoredWidth = (await readShellGeometry(saved.page)).sidebar
    expect(restoredWidth).toBeGreaterThanOrEqual(160)
    expect(restoredWidth).toBeLessThanOrEqual(360)
    for (const width of [1024, 640]) {
      await saved.page.setViewportSize({ width, height: 768 })
      await expectDesktopGeometry(saved.page, restoredWidth)
    }
    await saved.page.setViewportSize({ width: 639, height: 768 })
    await expect(shellPanel(saved.page, "sidebar")).toBeHidden()
    await saved.page.setViewportSize({ width: 640, height: 768 })
    await expectDesktopGeometry(saved.page, restoredWidth)
    expect(await saved.page.evaluate((key) => localStorage.getItem(key), layoutStorageKey))
      .toBe(seededStorage)

    const interaction = await asUser("alice")
    await interaction.page.setViewportSize({ width: 1280, height: 900 })
    await installLayoutState(interaction.page, null)
    await gotoAfterUserWsAuth(
      interaction.page,
      `/c/channels/${serverId}/${channelId}`,
    )
    await expectDesktopGeometry(interaction.page, expectedDefaultSidebarWidth)
    const handle = interaction.page.locator('[data-slot="resizable-handle"]')
    await handle.focus()
    await interaction.page.keyboard.press("ArrowLeft")
    await expect.poll(() => interaction.page.evaluate(
      (key) => localStorage.getItem(key),
      layoutStorageKey,
    )).not.toBeNull()
    const resizedWidth = (await readShellGeometry(interaction.page)).sidebar
    expect(Math.abs(resizedWidth - expectedDefaultSidebarWidth)).toBeGreaterThan(1)
    expect(resizedWidth).toBeGreaterThanOrEqual(160)
    expect(resizedWidth).toBeLessThanOrEqual(360)
    const storedLayout = JSON.parse(await interaction.page.evaluate(
      (key) => localStorage.getItem(key)!,
      layoutStorageKey,
    )) as Record<string, unknown>
    expect(storedLayout).toEqual({
      sidebar: expect.any(Number),
      main: expect.any(Number),
    })
    await interaction.page.reload({ waitUntil: "commit" })
    await expectDesktopGeometry(interaction.page, resizedWidth)
    await attachJson(testInfo, "desktop-width-layout-evidence", {
      hydrationSamples,
      mobileGeometry,
      unsavedStorage: null,
      saved: {
        initialStorage: seededStorage,
        finalStorage: await saved.page.evaluate(
          (key) => localStorage.getItem(key),
          layoutStorageKey,
        ),
        restoredWidth,
      },
      resized: {
        storage: storedLayout,
        resizedWidth,
        reloadedWidth: (await readShellGeometry(interaction.page)).sidebar,
      },
    })
  })

  test("captures closed, Inbox, Profile, update, and cold Skeleton parity", async ({
    asUser,
  }, testInfo) => {
    test.setTimeout(240_000)
    const focusRecords: Array<Record<string, unknown>> = []

    for (const width of [1024, 1280] as const) {
      for (const theme of ["light", "dark"] as const) {
        const authenticated = await asUser("alice")
        await authenticated.page.setViewportSize({ width, height: width === 1024 ? 768 : 900 })
        await authenticated.page.emulateMedia({ colorScheme: theme })
        await installLayoutState(authenticated.page, null)
        await serveOutdatedMachine(authenticated.page)
        await gotoAfterUserWsAuth(authenticated.page, "/c/me/friends")
        const writes = captureWrites(authenticated.page)

        await expectDesktopGeometry(authenticated.page, expectedDefaultSidebarWidth)
        const extension = authenticated.page.getByTestId(tid.userBarExtension)
        await expect(extension).toHaveAttribute("data-extension", "update")
        await extension.focus()
        await expect(extension).toBeFocused()
        await waitForElementMotion(extension)
        await expectExtensionGeometry(authenticated.page)
        expect(await extension.evaluate((element) => (
          element.scrollWidth <= element.clientWidth
        ))).toBe(true)
        const updateNotice = authenticated.page.getByTestId(tid.daemonUpdateNotice)
        const updateAction = authenticated.page.getByTestId(tid.daemonUpdateAction)
        const [noticeBox, actionBox] = await Promise.all([
          updateNotice.boundingBox(),
          updateAction.boundingBox(),
        ])
        expect(noticeBox).not.toBeNull()
        expect(actionBox).not.toBeNull()
        expect(actionBox!.x).toBeGreaterThanOrEqual(noticeBox!.x)
        expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(
          noticeBox!.x + noticeBox!.width,
        )
        await attachJson(
          testInfo,
          `user-bar-${width}-${theme}-machine-update-geometry`,
          {
            shell: await readShellGeometry(authenticated.page),
            notice: noticeBox,
            action: actionBox,
            extensionFocused: await extension.evaluate(
              (element) => element === document.activeElement,
            ),
          },
        )
        await attachScreenshot(
          authenticated.page,
          testInfo,
          `user-bar-${width}-${theme}-machine-update`,
        )

        await authenticated.page.keyboard.press("Escape")
        await expect(extension).toHaveCount(0)
        const base = authenticated.page.getByTestId(tid.userBar).locator(
          '[data-slot="community-user-bar-base"]',
        )
        await expect(base).toHaveCSS("height", "48px")
        expect(Math.abs((await base.boundingBox())!.width - expectedVisibleWidth))
          .toBeLessThanOrEqual(geometryEpsilon)
        await attachScreenshot(
          authenticated.page,
          testInfo,
          `user-bar-${width}-${theme}-closed`,
        )

        const inboxTrigger = authenticated.page.getByTestId(tid.inboxTrigger)
        await inboxTrigger.focus()
        await authenticated.page.keyboard.press("Enter")
        await expect(extension).toHaveAttribute("data-extension", "inbox")
        await expect(extension).toBeFocused()
        await waitForElementMotion(extension)
        await expectExtensionGeometry(authenticated.page)
        await attachScreenshot(
          authenticated.page,
          testInfo,
          `user-bar-${width}-${theme}-inbox`,
        )
        await authenticated.page.keyboard.press("Escape")
        await expect(inboxTrigger).toBeFocused()
        const inboxRestored = await inboxTrigger.evaluate(
          (element) => element === document.activeElement,
        )

        const profileTrigger = authenticated.page.getByTestId(tid.userBarName).locator("..")
        await profileTrigger.focus()
        await authenticated.page.keyboard.press("Enter")
        await expect(extension).toHaveAttribute("data-extension", "profile")
        await expect(extension).toBeFocused()
        await expect(authenticated.page.getByTestId(tid.profileCard)).toBeVisible()
        await waitForElementMotion(extension)
        await expectExtensionGeometry(authenticated.page)
        await attachScreenshot(
          authenticated.page,
          testInfo,
          `user-bar-${width}-${theme}-profile`,
        )
        await authenticated.page.keyboard.press("Escape")
        await expect(profileTrigger).toBeFocused()
        focusRecords.push({
          width,
          theme,
          inboxRestored,
          profileRestored: await profileTrigger.evaluate(
            (element) => element === document.activeElement,
          ),
        })
        expect(writes.writes).toEqual([])
        writes.stop()
        await authenticated.context.close()

        const pending = await asUser("alice")
        await pending.page.setViewportSize({ width, height: width === 1024 ? 768 : 900 })
        await pending.page.emulateMedia({ colorScheme: theme })
        await installLayoutState(pending.page, null)
        const session = await holdSession(pending.page)
        await pending.page.goto(`/c/channels/${serverId}`, { waitUntil: "commit" })
        await expect.poll(session.hits).toBeGreaterThan(0)
        await expect(pending.page.getByTestId(tid.initialFrame)).toBeVisible()
        await expect(pending.page.getByTestId(tid.initialUserBarPending)).toBeVisible()
        const pendingSidebar = shellPanel(pending.page, "sidebar")
        const pendingOverlay = pending.page.locator('[data-slot="community-user-bar-overlay"]')
        const pendingBase = pending.page.getByTestId(tid.initialUserBarPending).locator(
          ":scope > div",
        )
        await expect.poll(async () => Math.abs(
          ((await pendingSidebar.boundingBox())?.width ?? 0) - expectedDefaultSidebarWidth,
        )).toBeLessThanOrEqual(geometryEpsilon)
        await expect.poll(async () => Math.abs(
          ((await pendingOverlay.boundingBox())?.width ?? 0) - expectedOuterWidth,
        )).toBeLessThanOrEqual(geometryEpsilon)
        expect(Math.abs((await pendingBase.boundingBox())!.width - expectedVisibleWidth))
          .toBeLessThanOrEqual(geometryEpsilon)
        await expect(pendingBase).toHaveCSS("height", "48px")
        await attachScreenshot(
          pending.page,
          testInfo,
          `user-bar-${width}-${theme}-cold-skeleton`,
        )
        expect(await pending.page.evaluate((key) => localStorage.getItem(key), layoutStorageKey))
          .toBeNull()
        session.release()
        await pending.context.close()
      }
    }
    await attachJson(testInfo, "user-bar-focus-records", focusRecords)
  })
})
