import type { Page, Request, Route, TestInfo } from "@playwright/test"
import { expect, test, userId } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth, waitForElementMotion } from "./_fixtures/actions"
import {
  memberInfo,
  seedCancelFriendRequest,
  seedChannel,
  seedJoinServer,
  seedMark,
  seedMessage,
  seedPendingFriendRequest,
  seedServer,
} from "./_fixtures/seed"
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
  viewportWidth: number
  desktopVisible: boolean
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

type DesktopResizeSample = ShellGeometry & {
  viewportWidth: number
  documentClientWidth: number
  documentScrollWidth: number
  documentHorizontalOverflow: number
}

type ComposerGeometry = {
  shellLeft: number
  shellRight: number
  baseLeft: number
  baseRight: number
  leftInset: number
  rightInset: number
  outerPaddingLeft: number
  outerPaddingRight: number
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
    const storageWrites: string[] = []
    Reflect.set(window, "__desktopWidthSamples", samples)
    Reflect.set(window, "__desktopLayoutWrites", storageWrites)
    const originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function setItem(storageKey, value) {
      if (storageKey === key) storageWrites.push(value)
      return originalSetItem.call(this, storageKey, value)
    }
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
          viewportWidth: window.innerWidth,
          desktopVisible: getComputedStyle(sidebar).display !== "none"
            && getComputedStyle(overlay).display !== "none",
        })
      }
      requestAnimationFrame(capture)
    }
    requestAnimationFrame(capture)
  }, { key: layoutStorageKey, savedLayout: layout, sidebarTestId: "sidebar" })
}

async function holdApplicationScripts(page: Page) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let hits = 0
  let sessionRequests = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/get-session") sessionRequests += 1
  })
  const handler = async (route: Route) => {
    if (!/\/_next\/.*\.js(?:\?|$)/.test(route.request().url())) {
      await route.continue()
      return
    }
    hits += 1
    await gate
    await route.continue()
  }
  await page.route("**/_next/**", handler)
  return { hits: () => hits, sessionRequests: () => sessionRequests, release }
}

async function holdCommunityReads(page: Page) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let hits = 0
  await page.route("**/api/community/**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue()
      return
    }
    hits += 1
    await gate
    await route.continue()
  })
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

async function readDesktopResizeSample(
  page: Page,
  viewportWidth: number,
): Promise<DesktopResizeSample> {
  const [geometry, documentGeometry] = await Promise.all([
    readShellGeometry(page),
    page.evaluate(() => {
      const documentClientWidth = document.documentElement.clientWidth
      const documentScrollWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      )
      return {
        documentClientWidth,
        documentScrollWidth,
        documentHorizontalOverflow: Math.max(
          0,
          documentScrollWidth - documentClientWidth,
        ),
      }
    }),
  ])
  return { viewportWidth, ...geometry, ...documentGeometry }
}

function expectMainAbsorbsViewportDelta(samples: DesktopResizeSample[]) {
  expect(samples.map(({ viewportWidth }) => viewportWidth)).toEqual([1280, 1024, 640])
  const initial = samples[0]
  for (const sample of samples) {
    expect(sample.documentClientWidth).toBe(sample.viewportWidth)
    expect(sample.documentHorizontalOverflow).toBe(0)
    expect(Math.abs(
      (sample.main - initial.main)
      - (sample.viewportWidth - initial.viewportWidth),
    )).toBeLessThanOrEqual(geometryEpsilon)
  }
}

function expectNoTransientDesktopWidth(
  samples: LayoutSample[],
  sidebarWidth: number,
) {
  const visibleSamples = samples.filter(({ desktopVisible, sidebar, overlay }) => (
    desktopVisible && sidebar > 0 && overlay > 0
  ))
  expect(visibleSamples.length).toBeGreaterThan(0)
  const transientSamples = visibleSamples.filter((sample) => (
    Math.abs(sample.sidebar - sidebarWidth) > geometryEpsilon
    || Math.abs(sample.overlay - (sidebarWidth + 58)) > geometryEpsilon
  ))
  expect(transientSamples).toEqual([])
}

async function readComposerGeometry(page: Page): Promise<ComposerGeometry> {
  return page.getByTestId(tid.channelComposerShell).evaluate((shell) => {
    const base = shell.querySelector<HTMLElement>(
      '[data-slot="community-composer-base"]',
    )
    const outer = base?.parentElement
    if (!base || !outer) throw new Error("missing channel Composer geometry")
    const shellRect = shell.getBoundingClientRect()
    const baseRect = base.getBoundingClientRect()
    const outerStyle = getComputedStyle(outer)
    return {
      shellLeft: shellRect.left,
      shellRight: shellRect.right,
      baseLeft: baseRect.left,
      baseRight: baseRect.right,
      leftInset: baseRect.left - shellRect.left,
      rightInset: shellRect.right - baseRect.right,
      outerPaddingLeft: Number.parseFloat(outerStyle.paddingLeft),
      outerPaddingRight: Number.parseFloat(outerStyle.paddingRight),
    }
  })
}

async function expectExtensionGeometry(page: Page) {
  const extension = page.getByTestId(tid.userBarExtension)
  await expect.poll(async () => (await extension.boundingBox())?.width ?? 0).toBeCloseTo(320, 0)
  const base = page.getByTestId(tid.userBar).locator(
    '[data-slot="community-user-bar-base"]',
  )
  const [extensionBox, baseBox] = await Promise.all([
    extension.boundingBox(),
    base.boundingBox(),
  ])
  expect(extensionBox).not.toBeNull()
  expect(baseBox).not.toBeNull()
  expect(Math.abs(extensionBox!.width - 320)).toBeLessThanOrEqual(
    geometryEpsilon,
  )
  expect(Math.abs(baseBox!.width - expectedVisibleWidth)).toBeLessThanOrEqual(
    geometryEpsilon,
  )
  expect(Math.abs(extensionBox!.x - baseBox!.x)).toBeLessThanOrEqual(geometryEpsilon)
  expect(extensionBox!.y + extensionBox!.height).toBeLessThan(baseBox!.y)
  await expect(extension).toHaveAttribute("data-presentation", "popup")
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
    const unsavedResizeSequence = [
      await readDesktopResizeSample(fresh.page, 1280),
    ]
    const composerGeometry = await readComposerGeometry(fresh.page)
    expect(Math.abs(composerGeometry.leftInset - 12)).toBeLessThanOrEqual(
      geometryEpsilon,
    )
    expect(Math.abs(composerGeometry.rightInset - 12)).toBeLessThanOrEqual(
      geometryEpsilon,
    )
    expect(composerGeometry.outerPaddingLeft).toBe(12)
    expect(composerGeometry.outerPaddingRight).toBe(12)
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
      unsavedResizeSequence.push(
        await readDesktopResizeSample(fresh.page, width),
      )
    }
    expectMainAbsorbsViewportDelta(unsavedResizeSequence)
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
    expect(restoredWidth).toBeGreaterThanOrEqual(100)
    expect(restoredWidth).toBeLessThanOrEqual(360)
    await expectDesktopGeometry(saved.page, restoredWidth)
    const savedResizeSequence = [
      await readDesktopResizeSample(saved.page, 1280),
    ]
    for (const width of [1024, 640]) {
      await saved.page.setViewportSize({ width, height: 768 })
      await expectDesktopGeometry(saved.page, restoredWidth)
      savedResizeSequence.push(
        await readDesktopResizeSample(saved.page, width),
      )
    }
    expectMainAbsorbsViewportDelta(savedResizeSequence)
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
    expect(resizedWidth).toBeGreaterThanOrEqual(100)
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
      unsaved: {
        storage: null,
        resizeSequence: unsavedResizeSequence,
      },
      composerGeometry,
      saved: {
        initialStorage: seededStorage,
        finalStorage: await saved.page.evaluate(
          (key) => localStorage.getItem(key),
          layoutStorageKey,
        ),
        restoredWidth,
        resizeSequence: savedResizeSequence,
      },
      resized: {
        storage: storedLayout,
        resizedWidth,
        reloadedWidth: (await readShellGeometry(interaction.page)).sidebar,
      },
    })
  })

  test("keeps a populated Inbox free of horizontal overflow at the 100px floor", async ({
    asUser,
  }, testInfo) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const longServerName = `Inbox width with a deliberately long server title ${stamp}`
    const longChannelName = `inbox-width-with-a-deliberately-long-channel-name-${stamp}`
    const floorServerId = await seedServer("alice", longServerName)
    const floorChannelId = await seedChannel(
      "alice",
      floorServerId,
      longChannelName,
    )
    await seedJoinServer("alice", "bob", floorServerId)
    const bobMember = await memberInfo("alice", floorServerId, userId("bob"))
    const friendRequestId = await seedPendingFriendRequest(
      "carol",
      "bob",
      userId("bob"),
    )

    try {
      const markedMessageId = await seedMessage(
        "alice",
        floorChannelId,
        `Marked ${stamp} ${"very-long-row-content ".repeat(12)}`,
      )
      await seedMessage(
        "alice",
        floorChannelId,
        `@${bobMember.name}#${bobMember.discriminator} Mention ${stamp} ${"very-long-mention-content ".repeat(12)}`,
      )
      await seedMark("bob", floorChannelId, markedMessageId)

      const bob = await asUser("bob")
      await bob.page.setViewportSize({ width: 1280, height: 900 })
      await gotoAfterUserWsAuth(bob.page, "/c/me/friends")
      const sidebarPanel = shellPanel(bob.page, "sidebar")
      const handle = bob.page.locator('[data-slot="resizable-handle"]')
      await handle.focus()
      await bob.page.keyboard.press("Home")
      await expect.poll(async () => (
        (await sidebarPanel.boundingBox())?.width ?? 0
      )).toBeCloseTo(100, 0)
      await expectDesktopGeometry(bob.page, 100)

      await bob.page.getByTestId(tid.inboxTrigger).click()
      const extension = bob.page.getByTestId(tid.userBarExtension)
      await expect(extension).toHaveAttribute("data-extension", "inbox")
      await waitForElementMotion(extension)
      expect((await extension.boundingBox())!.width).toBeCloseTo(320, 0)

      const evidence: Array<Record<string, unknown>> = []
      for (const tab of ["Unreads", "Mentions", "Marked"] as const) {
        await bob.page.getByRole("tab", { name: tab }).click()
        const tabKey = tab.toLowerCase() as "unreads" | "mentions" | "marked"
        const activeBody = bob.page.getByTestId(tid.inboxTabScroll(tabKey))
        await expect(activeBody).toBeVisible()
        if (tab === "Unreads") {
          const requestRow = bob.page.getByTestId(tid.inboxFriendRequest(friendRequestId))
          await expect(requestRow).toBeVisible()
          await expect(bob.page.getByTestId(tid.inboxUnreadChannel(floorChannelId))).toBeVisible()
          await requestRow.hover()
          await expect(bob.page.getByTestId(tid.inboxFriendRequestAccept(friendRequestId))).toBeVisible()
          await expect(bob.page.getByTestId(tid.inboxFriendRequestReject(friendRequestId))).toBeVisible()
        } else {
          await expect(activeBody).toContainText(
            tab === "Mentions" ? `Mention ${stamp}` : `Marked ${stamp}`,
          )
          await activeBody.getByRole("button").first().hover()
          await expect(activeBody.getByRole("button", { name: "More" })).toBeVisible()
        }

        const sample = await extension.evaluate((element, ids) => {
          const width = (target: HTMLElement) => ({
            clientWidth: target.clientWidth,
            scrollWidth: target.scrollWidth,
            overflow: Math.max(0, target.scrollWidth - target.clientWidth),
          })
          const tabList = element.querySelector<HTMLElement>(
            `[data-testid="${ids.tabList}"]`,
          )
          const scrollBody = element.querySelector<HTMLElement>(
            `[data-testid="${ids.scrollBody}"]`,
          )
          if (!tabList || !scrollBody) throw new Error("missing active Inbox geometry")
          return {
            extension: width(element as HTMLElement),
            tabList: width(tabList),
            scrollBody: width(scrollBody),
            document: {
              clientWidth: document.documentElement.clientWidth,
              scrollWidth: document.documentElement.scrollWidth,
              overflow: Math.max(
                0,
                document.documentElement.scrollWidth - document.documentElement.clientWidth,
              ),
            },
          }
        }, {
          tabList: tid.inboxTabList,
          scrollBody: tid.inboxTabScroll(tabKey),
        })
        expect(sample.extension.overflow).toBe(0)
        expect(sample.tabList.overflow).toBe(0)
        expect(sample.scrollBody.overflow).toBe(0)
        expect(sample.document.overflow).toBe(0)
        evidence.push({ tab, ...sample })
        await attachScreenshot(
          bob.page,
          testInfo,
          `inbox-100-${tabKey}-no-horizontal-overflow`,
        )
      }
      await attachJson(testInfo, "inbox-100-no-horizontal-overflow", evidence)
    } finally {
      await seedCancelFriendRequest("carol", friendRequestId)
    }
  })

  test("restores fresh and saved mobile-first desktop entries before paint", async ({
    asUser,
  }, testInfo) => {
    test.setTimeout(240_000)

    const runFreshSequence = async (widths: number[]) => {
      const session = await asUser("alice")
      const page = session.page
      await page.setViewportSize({ width: widths[0], height: 844 })
      await installLayoutState(page, null)
      await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
      await expect(page.getByTestId(tid.channelComposerShell)).toBeVisible()
      const desktopPoints: Array<Record<string, unknown>> = []
      let previousWidth = widths[0]

      for (const width of widths.slice(1)) {
        const sampleCursor = await page.evaluate(() => (
          Reflect.get(window, "__desktopWidthSamples") as LayoutSample[]
        ).length)
        await page.setViewportSize({ width, height: 844 })
        if (width < 640) {
          await expect(shellPanel(page, "sidebar")).toBeHidden()
          previousWidth = width
          continue
        }

        await expectDesktopGeometry(page, expectedDefaultSidebarWidth)
        const [shell, composer, samples, storage, storageWrites] = await Promise.all([
          readDesktopResizeSample(page, width),
          readComposerGeometry(page),
          page.evaluate((cursor) => (
            Reflect.get(window, "__desktopWidthSamples") as LayoutSample[]
          ).slice(cursor), sampleCursor),
          page.evaluate((key) => localStorage.getItem(key), layoutStorageKey),
          page.evaluate(() => (
            Reflect.get(window, "__desktopLayoutWrites") as string[]
          )),
        ])
        if (previousWidth < 640) {
          expectNoTransientDesktopWidth(samples, expectedDefaultSidebarWidth)
        }
        expect(shell.documentHorizontalOverflow).toBe(0)
        expect(storage).toBeNull()
        expect(storageWrites).toEqual([])
        desktopPoints.push({
          shell,
          composer,
          composerCenter: (composer.shellLeft + composer.shellRight) / 2,
          samples,
          storage,
          storageWrites,
        })
        previousWidth = width
      }

      await session.context.close()
      return { widths, desktopPoints }
    }

    const longFresh = await runFreshSequence([320, 390, 639, 640, 1280])
    const shortFresh = await runFreshSequence([390, 639, 1280])
    const longFresh1280 = longFresh.desktopPoints.find(({ shell }) => (
      (shell as DesktopResizeSample).viewportWidth === 1280
    ))!
    const shortFresh1280 = shortFresh.desktopPoints.find(({ shell }) => (
      (shell as DesktopResizeSample).viewportWidth === 1280
    ))!
    expect(shortFresh1280.composerCenter).toBe(longFresh1280.composerCenter)

    const seededLayout = { sidebar: 25, main: 75 }
    const seededStorage = JSON.stringify(seededLayout)
    const saved = await asUser("alice")
    await saved.page.setViewportSize({ width: 390, height: 844 })
    await installLayoutState(saved.page, seededLayout)
    await gotoAfterUserWsAuth(saved.page, `/c/channels/${serverId}/${channelId}`)
    await expect(saved.page.getByTestId(tid.channelComposerShell)).toBeVisible()
    await saved.page.setViewportSize({ width: 639, height: 844 })
    await expect(shellPanel(saved.page, "sidebar")).toBeHidden()
    const firstSampleCursor = await saved.page.evaluate(() => (
      Reflect.get(window, "__desktopWidthSamples") as LayoutSample[]
    ).length)
    await saved.page.setViewportSize({ width: 1280, height: 900 })
    await expect(shellPanel(saved.page, "sidebar")).toBeVisible()
    await expect.poll(async () => (
      Math.abs((await readShellGeometry(saved.page)).sidebar - expectedDefaultSidebarWidth)
    )).toBeGreaterThan(1)
    const firstAppliedWidth = (await readShellGeometry(saved.page)).sidebar
    await expectDesktopGeometry(saved.page, firstAppliedWidth)
    const firstDesktopSamples = await saved.page.evaluate((cursor) => (
      Reflect.get(window, "__desktopWidthSamples") as LayoutSample[]
    ).slice(cursor), firstSampleCursor)
    expectNoTransientDesktopWidth(firstDesktopSamples, firstAppliedWidth)
    expect(await saved.page.evaluate(
      (key) => localStorage.getItem(key),
      layoutStorageKey,
    )).toBe(seededStorage)
    expect(await saved.page.evaluate(() => (
      Reflect.get(window, "__desktopLayoutWrites") as string[]
    ))).toEqual([])

    await saved.page.setViewportSize({ width: 639, height: 844 })
    await expect(shellPanel(saved.page, "sidebar")).toBeHidden()
    const secondSampleCursor = await saved.page.evaluate(() => (
      Reflect.get(window, "__desktopWidthSamples") as LayoutSample[]
    ).length)
    await saved.page.setViewportSize({ width: 1280, height: 900 })
    await expectDesktopGeometry(saved.page, firstAppliedWidth)
    const secondAppliedWidth = (await readShellGeometry(saved.page)).sidebar
    expect(secondAppliedWidth).toBe(firstAppliedWidth)
    const secondDesktopSamples = await saved.page.evaluate((cursor) => (
      Reflect.get(window, "__desktopWidthSamples") as LayoutSample[]
    ).slice(cursor), secondSampleCursor)
    expectNoTransientDesktopWidth(secondDesktopSamples, firstAppliedWidth)
    const finalStorage = await saved.page.evaluate(
      (key) => localStorage.getItem(key),
      layoutStorageKey,
    )
    const savedStorageWrites = await saved.page.evaluate(() => (
      Reflect.get(window, "__desktopLayoutWrites") as string[]
    ))
    expect(finalStorage).toBe(seededStorage)
    expect(savedStorageWrites).toEqual([])

    await attachJson(testInfo, "mobile-first-desktop-entry-evidence", {
      fresh: { long: longFresh, short: shortFresh },
      saved: {
        seededStorage,
        firstAppliedWidth,
        firstDesktopSamples,
        secondAppliedWidth,
        secondDesktopSamples,
        finalStorage,
        storageWrites: savedStorageWrites,
      },
    })
    await saved.context.close()
  })

  test("captures closed, Inbox, Profile, update, and cold restore parity", async ({
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
        const scripts = await holdApplicationScripts(pending.page)
        const communityReads = await holdCommunityReads(pending.page)
        await pending.page.goto(`/c/channels/${serverId}`, { waitUntil: "commit" })
        await expect.poll(scripts.hits).toBeGreaterThan(0)
        expect(scripts.sessionRequests()).toBe(0)
        const pendingFrame = pending.page.getByTestId(tid.initialFrame)
        await expect(pendingFrame).toBeVisible()
        await expect(pendingFrame).toHaveAttribute("aria-busy", "true")
        await expect(pendingFrame).toHaveAttribute("data-community-route-kind", "server-root")
        await expect(pending.page.locator('[data-slot="community-restore-bootstrap"]')).toHaveCount(0)
        await expect(pendingFrame.locator('[data-slot="skeleton"]')).not.toHaveCount(0)
        scripts.release()
        await expect.poll(communityReads.hits).toBeGreaterThan(0)
        await expect(pending.page.locator('[data-slot="community-shell-root"]')).toBeVisible()
        const pendingSidebar = shellPanel(pending.page, "sidebar")
        const pendingOverlay = pending.page.locator('[data-slot="community-user-bar-overlay"]')
        const pendingBase = pending.page.locator('[data-slot="community-user-bar-base"]')
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
          `user-bar-${width}-${theme}-cold-restore`,
        )
        expect(await pending.page.evaluate((key) => localStorage.getItem(key), layoutStorageKey))
          .toBeNull()
        communityReads.release()
        await pending.context.close()
      }
    }
    await attachJson(testInfo, "user-bar-focus-records", focusRecords)
  })
})
