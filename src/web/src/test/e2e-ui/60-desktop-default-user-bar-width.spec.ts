import { CURRENT_COMMUNITY_FIXTURE_HEADERS } from "./_fixtures/business-contract"
import { expectInertBackground } from "./_fixtures/inert-background"
import type { Locator, Page, Request, Route, TestInfo } from "@playwright/test"
import { expect, test } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth, waitForElementMotion } from "./_fixtures/actions"
import { COMMUNITY_LAYOUT_STORAGE_KEY, COMMUNITY_SIDEBAR_MIN_WIDTH } from "@/components/community/shell/shell-frame-geometry"

import { tid } from "./_fixtures/testids"
import { expectUniqueSsrCommunityFrame } from "./_fixtures/community-ssr-frame"
import type { CaseActors, CaseResources } from "./_fixtures/case-fixture"

const layoutStorageKey = COMMUNITY_LAYOUT_STORAGE_KEY
const expectedDefaultSidebarWidth = 317
const expectedOuterWidth = 375
const expectedVisibleWidth = 359
const geometryEpsilon = 1

const shellPanel = (page: Page, id: "sidebar" | "main") => (
  page.locator(`[data-slot="resizable-panel"][data-testid="${id}"]`)
)

type LayoutSample = {
  frame: number
  sidebar: number
  overlay: number
  viewportWidth: number
  desktopVisible: boolean
  scriptsHeld: boolean
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
  sampleLimit = 240,
) {
  await page.addInitScript(({
    key,
    savedLayout,
    sidebarTestId,
    sampleLimit,
  }) => {
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
    let frame = 0
    const capture = () => {
      frame += 1
      const roots = Array.from(document.querySelectorAll('[data-slot="community-shell-root"]')).filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 })
      if (roots.length > 1) throw new Error("Multiple visible desktop width frames")
      const sidebar = roots[0]?.querySelector<HTMLElement>(`[data-slot="resizable-panel"][data-testid="${sidebarTestId}"]`)
      const overlay = roots[0]?.querySelector<HTMLElement>('[data-slot="community-user-bar-overlay"]')
      if (sidebar && overlay && samples.length < sampleLimit) {
        samples.push({
          frame,
          sidebar: sidebar.getBoundingClientRect().width,
          overlay: overlay.getBoundingClientRect().width,
          viewportWidth: window.innerWidth,
          desktopVisible: getComputedStyle(sidebar).display !== "none"
            && getComputedStyle(overlay).display !== "none",
          scriptsHeld: Reflect.get(window, "__desktopWidthScriptsHeld") === true,
        })
      }
      requestAnimationFrame(capture)
    }
    requestAnimationFrame(capture)
  }, {
    key: layoutStorageKey,
    savedLayout: layout,
    sidebarTestId: "sidebar",
    sampleLimit,
  })
}

async function holdApplicationScripts(page: Page, caseResources: CaseResources) {
  await page.addInitScript(() => Reflect.set(window, "__desktopWidthScriptsHeld", true))
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  caseResources.own(release, async (captured) => { captured() })
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
  return { hits: () => hits, sessionRequests: () => sessionRequests, release: async () => { await page.evaluate(() => Reflect.set(window, "__desktopWidthScriptsHeld", false)); release() } }
}

async function holdCommunityReads(page: Page, caseResources: CaseResources) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  caseResources.own(release, async (captured) => { captured() })
  let hits = 0
  await page.route("**/api/community/**", async (route) => {
    if (route.request().method() !== "GET" || new URL(route.request().url()).pathname === "/api/community/users/me/profile") {
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
  await page.route(url => url.pathname === "/api/community/machines", async (route) => {
    const optional = new URL(route.request().url()).searchParams.get("view") === "observations"
    await route.fulfill({ headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(optional ? { quotas: [{ machineId: outdatedMachine.id, quota: [] }] } : { machines: [(({ quota: _quota, ...identity }) => identity)(outdatedMachine)], complete: true }),
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

async function expectDesktopGeometry(page: Page, sidebarWidth: number, options: { coldEntry?: boolean } = {}) {
  if (options.coldEntry) {
    const userBar = page.getByTestId(tid.userBar)
    await expect(async () => {
      expect(await userBar.count()).toBe(1)
      expect(await userBar.isVisible()).toBe(true)
    }).toPass({ timeout: 10_000 })
    const sidebar = shellPanel(page, "sidebar")
    await expect(async () => {
      expect(await sidebar.count()).toBe(1)
      expect(await sidebar.isVisible()).toBe(true)
    }).toPass({ timeout: 10_000 })
    const overlay = page.locator('[data-slot="community-user-bar-overlay"]')
    await expect(async () => {
      expect(await overlay.count()).toBe(1)
      expect(await overlay.isVisible()).toBe(true)
    }).toPass({ timeout: 10_000 })
  } else {
    await expect(page.getByTestId(tid.userBar)).toBeVisible()
    await expect(shellPanel(page, "sidebar")).toBeVisible()
    await expect(page.locator('[data-slot="community-user-bar-overlay"]')).toBeVisible()
  }
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
  const desktopSamples = visibleSamples.filter(({ viewportWidth }) => viewportWidth >= 640)
  expect(desktopSamples.length).toBeGreaterThan(0)
  const transientSamples = desktopSamples.filter((sample) => (
    Math.abs(sample.sidebar - sidebarWidth) > geometryEpsilon
    || Math.abs(sample.overlay - (sidebarWidth + 58)) > geometryEpsilon
  ))
  expect(transientSamples).toEqual([])
}

function compactLayoutSamples(samples: LayoutSample[]) {
  const compact: LayoutSample[] = []
  for (const sample of samples) {
    const previous = compact.at(-1)
    if (
      previous
      && previous.sidebar === sample.sidebar
      && previous.overlay === sample.overlay
      && previous.desktopVisible === sample.desktopVisible
      && previous.scriptsHeld === sample.scriptsHeld
    ) continue
    compact.push(sample)
  }
  return compact
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

async function expectUserBarTargets(page: Page, size: 28 | 44) {
  const bar = page.getByTestId(tid.userBar)
  const profile = bar.getByRole("button", { name: /^Open profile/ })
  const targets = [profile, page.getByTestId(tid.inboxTrigger), page.getByTestId(tid.userSettingsOpen)]
  const update = page.getByTestId(tid.daemonUpdateBadge)
  if (await update.count()) targets.push(update)
  for (const target of targets) {
    await expect(target).toHaveCSS("width", `${size}px`)
    await expect(target).toHaveCSS("height", `${size}px`)
    if (target === profile) {
      const avatar = await target.locator(":scope > span").boundingBox()
      expect(avatar?.width).toBe(28)
      expect(avatar?.height).toBe(28)
    } else {
      expect(await target.evaluate((element) => {
        const visual = getComputedStyle(element, "::before")
        return {
          width: visual.width, height: visual.height,
          pointerEvents: visual.pointerEvents,
          targetBackground: getComputedStyle(element).backgroundColor,
        }
      })).toEqual({ width: "28px", height: "28px", pointerEvents: "none", targetBackground: "rgba(0, 0, 0, 0)" })
    }
  }
  await expect(page.getByTestId(tid.userBarName).locator("..")).toHaveCSS("height", `${size}px`)
  const layout = await bar.evaluate((element) => {
    const base = element.querySelector<HTMLElement>('[data-slot="community-user-bar-base"]')!.getBoundingClientRect()
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('[data-slot="community-user-bar-base"] button'))
      .map(button => button.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0)
    return { height: base.height, inside: buttons.every(box => box.top >= base.top && box.bottom <= base.bottom && box.left >= base.left && box.right <= base.right), overlap: buttons.some((box, index) => index > 0 && buttons[index - 1].right > box.left) }
  })
  expect(layout).toEqual({ height: 48, inside: true, overlap: false })
}

async function clickTargetEdge(page: Page, target: Locator, edge: "top" | "right" | "bottom" | "left") {
  const box = await target.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBe(44)
  expect(box!.height).toBe(44)
  const point = {
    x: box!.x + (edge === "left" ? 2 : edge === "right" ? 42 : 22),
    y: box!.y + (edge === "top" ? 2 : edge === "bottom" ? 42 : 22),
  }
  expect(await target.evaluate((element, position) => (
    document.elementFromPoint(position.x, position.y)?.closest("button") === element
  ), point)).toBe(true)
  await page.mouse.click(point.x, point.y)
  return point
}

async function expectSafeContentWithExtendedBackground(page: Page) {
  const mobileList = await page.locator('[data-community-mobile-surface="list"]').isVisible()
  const previous = await page.evaluate(() => {
    const style = document.documentElement.style
    return Object.entries({ top: 24, right: 16, bottom: 20, left: 18 }).map(([edge, value]) => {
      const name = `--app-safe-area-${edge}`
      const previous = { name, value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) }
      style.setProperty(name, `${value}px`)
      return previous
    })
  })
  const readPanel = (id: "sidebar" | "main") => shellPanel(page, id).evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const visual = element.firstElementChild
    if (!(visual instanceof HTMLElement)) throw new Error("panel visual surface not found")
    return { top: rect.top, left: rect.left, right: rect.right, backgroundColor: getComputedStyle(visual).backgroundColor }
  })
  try {
    await expect.poll(async () => {
      const side = await readPanel("sidebar")
      const main = mobileList ? null : await readPanel("main")
      return page.evaluate(({ side, main }) => {
        const root = document.querySelector<HTMLElement>('[data-slot="community-shell-root"]')!
        const frame = root.querySelector<HTMLElement>('[data-slot="community-frame-paint"]')!
        const sidePaint = root.querySelector<HTMLElement>('[data-slot="community-sidebar-background"]')!
        const mainPaint = root.querySelector<HTMLElement>('[data-slot="community-main-background"]')!
        const rootBounds = root.getBoundingClientRect()
        const frameBounds = frame.getBoundingClientRect()
        const sideBounds = sidePaint.getBoundingClientRect()
        const mainBounds = mainPaint.getBoundingClientRect()
        const near = (a: number, b: number) => Math.abs(a - b) <= 1
        const hitPoints = [[4, 4], [4, innerHeight / 2], [22, innerHeight - 5], [side.left + 4, innerHeight - 5], [innerWidth - 4, innerHeight / 2]]
        return {
          safeContents: near(rootBounds.top, 24) && near(rootBounds.left, 18)
            && near(rootBounds.right, innerWidth - 16) && near(rootBounds.bottom, innerHeight - 20)
            && near(main ? main.right : side.right, innerWidth - 16),
          frameFillsViewport: near(frameBounds.top, 0) && near(frameBounds.left, 0)
            && near(frameBounds.right, innerWidth) && near(frameBounds.bottom, innerHeight),
          frameOpaque: !["transparent", "rgba(0, 0, 0, 0)"].includes(getComputedStyle(frame).backgroundColor),
          sidebarAligned: near(sideBounds.top, side.top) && near(sideBounds.left, side.left)
            && near(sideBounds.right, main ? side.right : innerWidth),
          bottomExtended: near(sideBounds.bottom, innerHeight),
          sidebarColor: getComputedStyle(sidePaint).backgroundColor === side.backgroundColor,
          paintOwnsHit: hitPoints.some(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('[data-slot="community-frame-paint"], [data-slot="community-sidebar-background"], [data-slot="community-main-background"]'))),
          ...(main ? {
            mainExtended: near(mainBounds.top, main.top) && near(mainBounds.left, main.left)
              && near(mainBounds.right, innerWidth) && near(mainBounds.bottom, innerHeight),
            mainColor: getComputedStyle(mainPaint).backgroundColor === main.backgroundColor,
          } : {}),
        }
      }, { side, main })
    }).toEqual({ safeContents: true, frameFillsViewport: true, frameOpaque: true, sidebarAligned: true,
      bottomExtended: true, sidebarColor: true, paintOwnsHit: false,
      ...(mobileList ? {} : { mainExtended: true, mainColor: true }) })
  } finally {
    await page.evaluate((values) => {
      const style = document.documentElement.style
      for (const { name, value, priority } of values) {
        if (value) style.setProperty(name, value, priority)
        else style.removeProperty(name)
      }
    }, previous)
  }
}


type ReturnPaintRect = { top: number; right: number; bottom: number; left: number }
type ReturnPaintFrame = {
  width: number
  height: number
  popup: ReturnPaintRect | null
  content: ReturnPaintRect | null
  frame: ReturnPaintRect
  sidebar: ReturnPaintRect
  frameColor: string
  sidebarColor: string
  popupColor: string | null
}

async function expectPageOwnedReturn(page: Page, back: Locator, testInfo: TestInfo, action: () => Promise<void>) {
  const previous = await page.evaluate(() => Object.entries({ top: 24, right: 16, bottom: 20, left: 18 }).map(([edge, value]) => {
    const style = document.documentElement.style
    const name = `--app-safe-area-${edge}`
    const previous = { name, value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) }
    style.setProperty(name, `${value}px`)
    return previous
  }))
  let frames: ReturnPaintFrame[] = []
  try {
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await back.evaluate(button => {
      const popup = button.closest<HTMLElement>('[data-slot="mobile-page"]')!
      const content = popup.querySelector<HTMLElement>('[data-slot="mobile-page-content"]')!
      const frames: ReturnPaintFrame[] = []
      const rect = (element: HTMLElement): ReturnPaintRect => {
        const { top, right, bottom, left } = element.getBoundingClientRect()
        return { top, right, bottom, left }
      }
      let request = 0
      const sample = () => {
        const frame = document.querySelector<HTMLElement>('[data-slot="community-frame-paint"]')!
        const sidebar = document.querySelector<HTMLElement>('[data-slot="community-sidebar-background"]')!
        const visible = popup.isConnected && popup.getBoundingClientRect().width > 0
        frames.push({ width: innerWidth, height: innerHeight, popup: visible ? rect(popup) : null,
          content: visible ? rect(content) : null, frame: rect(frame), sidebar: rect(sidebar),
          frameColor: getComputedStyle(frame).backgroundColor, sidebarColor: getComputedStyle(sidebar).backgroundColor,
          popupColor: visible ? getComputedStyle(popup).backgroundColor : null })
        request = requestAnimationFrame(sample)
      }
      Reflect.set(window, "__communityReturnPaintFrames", { frames, stop: () => cancelAnimationFrame(request) })
      sample()
    })
    await action()
  } finally {
    frames = await page.evaluate((values) => {
      const record = Reflect.get(window, "__communityReturnPaintFrames") as { frames: ReturnPaintFrame[]; stop: () => void } | undefined
      record?.stop()
      Reflect.deleteProperty(window, "__communityReturnPaintFrames")
      const style = document.documentElement.style
      for (const { name, value, priority } of values) {
        if (value) style.setProperty(name, value, priority)
        else style.removeProperty(name)
      }
      return record?.frames ?? []
    }, previous)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await attachJson(testInfo, "page-owned-return-paint-frames", frames)
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= 1
  const first = frames[0]
  expect(first).toBeDefined()
  expect(frames.every(sample => near(sample.frame.top, 0) && near(sample.frame.left, 0)
    && near(sample.frame.right, sample.width) && near(sample.frame.bottom, sample.height)
    && sample.frameColor === first.frameColor && sample.sidebarColor === first.sidebarColor
    && Object.entries(sample.sidebar).every(([edge, value]) => near(value, first.sidebar[edge as keyof ReturnPaintRect])))).toBe(true)
  const painted = frames.filter(sample => sample.popup && sample.content)
  expect(painted.length).toBeGreaterThan(0)
  expect(painted.some(sample => sample.popup!.left > 1 && sample.popup!.left < sample.width - 1)).toBe(true)
  expect(painted.every(sample => {
    const popup = sample.popup!
    const content = sample.content!
    return near(popup.right - popup.left, sample.width) && near(popup.bottom - popup.top, sample.height)
      && near(content.top - popup.top, 24) && near(content.left - popup.left, 18)
      && near(popup.right - content.right, 16) && near(popup.bottom - content.bottom, 20)
      && sample.popupColor === painted[0].popupColor
      && ![null, "transparent", "rgba(0, 0, 0, 0)"].includes(sample.popupColor)
  })).toBe(true)
}

test.describe("desktop default User Bar width", () => {
  async function prepareCase1(actors: CaseActors) {
    const { seedChannel, seedServer } = actors.seed
    const stamp = Date.now()
    const serverId: string = await seedServer("alice", `Desktop width ${stamp}`)
    const channelId: string = await seedChannel("alice", serverId, `desktop-width-${stamp}`)
    return { serverId, channelId }
  }

  test("prepaints a public frame and preserves saved widths from the first authenticated shell", async ({ caseActors, caseResources }, testInfo) => {
    test.setTimeout(240_000)

    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

    const evidence: Array<{
      targetWidth: number
      requestedWidth: number
      savedLayout: { sidebar: number; main: number }
      sequence: LayoutSample[]
    }> = []

    for (const requestedWidth of [0, 100, COMMUNITY_SIDEBAR_MIN_WIDTH, 160, 240, 350, 360]) {
      const targetWidth = Math.max(COMMUNITY_SIDEBAR_MIN_WIDTH, requestedWidth)
      const session = await asUser("alice")
      const page = session.page
      await page.setViewportSize({ width: 1280, height: 900 })
      const availablePanelWidth = 1280 - 58
      const sidebar = requestedWidth === 0
        ? 0
        : requestedWidth === 360
          ? 100
          : requestedWidth / availablePanelWidth * 100
      const savedLayout = { sidebar, main: 100 - sidebar }
      await installLayoutState(page, savedLayout, 2_000)
      const scripts = await holdApplicationScripts(page, caseResources)
      const communityReads = await holdCommunityReads(page, caseResources)

      await page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
      await expect.poll(scripts.hits).toBeGreaterThan(0)
      const ssrFrame = await expectUniqueSsrCommunityFrame(page)
      await expect(ssrFrame).toBeVisible()
      await expect(ssrFrame).toHaveAttribute("data-community-route-kind", "community-root-redirect")
      await expect(page.locator('[data-slot="community-user-bar-base"]')).toHaveCount(0)
      expect(await page.evaluate(() => Reflect.get(window, "__desktopWidthSamples"))).toEqual([])
      await scripts.release()
      communityReads.release()
      await expect(page.getByTestId(tid.channelComposerShell)).toBeVisible()
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }))
      const sequence = compactLayoutSamples(await page.evaluate(() => (
        Reflect.get(window, "__desktopWidthSamples") as LayoutSample[]
      )))
      evidence.push({ targetWidth, requestedWidth, savedLayout, sequence })
      await caseResources.closeContext(session.context)
    }

    await attachJson(testInfo, "saved-ssr-shell-frame-sequences", evidence)
    for (const { targetWidth, sequence } of evidence) {
      expect(sequence.every(({ sidebar, overlay }) => (
        Math.abs(sidebar - targetWidth) <= geometryEpsilon
        && Math.abs(overlay - (targetWidth + 58)) <= geometryEpsilon
      ))).toBe(true)
      expect(sequence.length).toBeGreaterThan(0)
      expect(sequence.some(({ scriptsHeld }) => scriptsHeld)).toBe(false)
      expect(sequence.at(-1)?.scriptsHeld).toBe(false)
    }
  })

  test("keeps unsaved, saved, and user-resized layouts pixel-stable", async ({ caseActors, caseResources }, testInfo) => {
    test.setTimeout(180_000)

    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

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
    await expectInertBackground(shellPanel(fresh.page, "sidebar"))
    await expect(shellPanel(fresh.page, "main")).toBeVisible()
    await fresh.page.setViewportSize({ width: 640, height: 768 })
    await expectDesktopGeometry(fresh.page, expectedDefaultSidebarWidth)
    expect(await fresh.page.evaluate((key) => localStorage.getItem(key), layoutStorageKey))
      .toBeNull()
    await caseResources.closeContext(fresh.context)

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
        wrapperWidth: viewport.width - 20 - 18,
        baseWidth: viewport.width - 20 - 18 - 12 - 12,
        baseHeight: 48,
        paddingLeft: 12,
        paddingRight: 12,
        paddingBottom: 12,
      })
      expect(await mobile.page.evaluate(
        (key) => localStorage.getItem(key),
        layoutStorageKey,
      )).toBeNull()
      mobileGeometry.push({ viewport, ...geometry })
      await expectSafeContentWithExtendedBackground(mobile.page)
      await caseResources.closeContext(mobile.context)
    }

    const seededLayout = { sidebar: 25, main: 75 }
    const seededStorage = JSON.stringify(seededLayout)
    const saved = await asUser("alice")
    await saved.page.setViewportSize({ width: 1280, height: 900 })
    await installLayoutState(saved.page, seededLayout)
    await gotoAfterUserWsAuth(saved.page, `/c/channels/${serverId}/${channelId}`)
    await expect(shellPanel(saved.page, "sidebar")).toBeVisible()
    await expect(saved.page.getByTestId(tid.userBar).locator('[data-slot="community-user-bar-base"]')).toBeVisible()
    await expect.poll(async () => (
      Math.abs((await readShellGeometry(saved.page)).sidebar - expectedDefaultSidebarWidth)
    )).toBeGreaterThan(1)
    const restoredWidth = (await readShellGeometry(saved.page)).sidebar
    expect(restoredWidth).toBeGreaterThanOrEqual(COMMUNITY_SIDEBAR_MIN_WIDTH)
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
    await expectInertBackground(shellPanel(saved.page, "sidebar"))
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
    expect(resizedWidth).toBeGreaterThanOrEqual(COMMUNITY_SIDEBAR_MIN_WIDTH)
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
    await expectDesktopGeometry(interaction.page, resizedWidth, { coldEntry: true })
    await expectSafeContentWithExtendedBackground(interaction.page)
    const resetHandle = interaction.page.locator('[data-slot="resizable-handle"]')
    await resetHandle.dblclick({ force: true })
    await expectDesktopGeometry(interaction.page, expectedDefaultSidebarWidth)
    await expect.poll(() => interaction.page.evaluate(
      (key) => localStorage.getItem(key),
      layoutStorageKey,
    )).not.toBe(JSON.stringify(storedLayout))
    const resetStorage = JSON.parse(await interaction.page.evaluate(
      (key) => localStorage.getItem(key)!,
      layoutStorageKey,
    )) as Record<string, unknown>
    await interaction.page.reload({ waitUntil: "commit" })
    await expectDesktopGeometry(interaction.page, expectedDefaultSidebarWidth, { coldEntry: true })
    await expectSafeContentWithExtendedBackground(interaction.page)
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
        resetStorage,
        reloadedResetWidth: (await readShellGeometry(interaction.page)).sidebar,
      },
    })
  })

  test("keeps a populated Inbox free of horizontal overflow at the minimum sidebar width", async ({ caseActors }, testInfo) => {
    test.setTimeout(120_000)

    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser, userId } = actors
    const { memberInfo, seedCancelFriendRequest, seedChannel, seedJoinServer, seedMark, seedMessage, seedPendingFriendRequest, seedServer } = actors.seed
    await prepareCase1(actors)

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
      await expect(bob.page.getByPlaceholder("Search friends")).toBeVisible()
      await expect(bob.page.getByTestId(tid.initialFrame)).toHaveCount(0)
      const sidebarPanel = shellPanel(bob.page, "sidebar")
      const handle = bob.page.locator('[data-slot="resizable-handle"]')
      await expect(handle).toHaveAttribute("aria-controls", "sidebar")
      await expect(handle).not.toHaveAttribute("aria-disabled", "true")
      await handle.focus()
      await expect(handle).toBeFocused()
      await bob.page.keyboard.press("Home")
      await expect.poll(async () => (
        (await sidebarPanel.boundingBox())?.width ?? 0
      )).toBeCloseTo(COMMUNITY_SIDEBAR_MIN_WIDTH, 0)
      await expectDesktopGeometry(bob.page, COMMUNITY_SIDEBAR_MIN_WIDTH)

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
          const content = tab === "Mentions" ? `Mention ${stamp}` : `Marked ${stamp}`
          await expect(activeBody).toContainText(
            content,
          )
          const rowButton = activeBody.getByRole("button", { name: new RegExp(content) })
          const row = rowButton.locator("..")
          const action = row.getByRole("button", { name: tab === "Mentions" ? "Mark mention as read" : "More", exact: true })
          await expect(row).toHaveCount(1)
          await expect(action).toHaveCount(1)
          await row.hover()
          await expect(action).toBeVisible()
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
          `inbox-min-width-${tabKey}-no-horizontal-overflow`,
        )
      }
      await attachJson(testInfo, "inbox-min-width-no-horizontal-overflow", evidence)
    } finally {
      await seedCancelFriendRequest("carol", friendRequestId)
    }
  })

  test("restores fresh and saved mobile-first desktop entries before paint", async ({ caseActors, caseResources }, testInfo) => {
    test.setTimeout(240_000)

    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

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
          await expectInertBackground(shellPanel(page, "sidebar"))
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

      await caseResources.closeContext(session.context)
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
    const savedSidebarWidth = 0.25 * (1280 - 58)
    const saved = await asUser("alice")
    await saved.page.setViewportSize({ width: 390, height: 844 })
    await installLayoutState(saved.page, seededLayout)
    await gotoAfterUserWsAuth(saved.page, "/c/me")
    await expect(saved.page.getByRole("link", { name: "Friends", exact: true })).toBeVisible()
    await saved.page.setViewportSize({ width: 639, height: 844 })
    await expect(shellPanel(saved.page, "sidebar")).toBeVisible()
    const firstSampleCursor = await saved.page.evaluate(() => (
      Reflect.get(window, "__desktopWidthSamples") as LayoutSample[]
    ).length)
    await saved.page.setViewportSize({ width: 1280, height: 900 })
    await expect(shellPanel(saved.page, "sidebar")).toBeVisible()
    await expect.poll(() => saved.page.evaluate(() => (
      document.documentElement.hasAttribute("data-community-shell-layout")
    ))).toBe(false)
    await expectDesktopGeometry(saved.page, savedSidebarWidth)
    const firstAppliedWidth = (await readShellGeometry(saved.page)).sidebar
    const firstDesktopSamples = await saved.page.evaluate((cursor) => (
      Reflect.get(window, "__desktopWidthSamples") as LayoutSample[]
    ).slice(cursor), firstSampleCursor)
    expectNoTransientDesktopWidth(firstDesktopSamples, savedSidebarWidth)
    expect(await saved.page.evaluate(
      (key) => localStorage.getItem(key),
      layoutStorageKey,
    )).toBe(seededStorage)
    expect(await saved.page.evaluate(() => (
      Reflect.get(window, "__desktopLayoutWrites") as string[]
    ))).toEqual([])

    await saved.page.setViewportSize({ width: 639, height: 844 })
    await expectInertBackground(shellPanel(saved.page, "sidebar"))
    await saved.page.goto("/c/me")
    await expect(saved.page.getByRole("link", { name: "Friends", exact: true })).toBeVisible()
    await expect(shellPanel(saved.page, "sidebar")).toBeVisible()
    const secondSampleCursor = await saved.page.evaluate(() => (
      Reflect.get(window, "__desktopWidthSamples") as LayoutSample[]
    ).length)
    await saved.page.setViewportSize({ width: 1280, height: 900 })
    await expect.poll(() => saved.page.evaluate(() => (
      document.documentElement.hasAttribute("data-community-shell-layout")
    ))).toBe(false)
    await expectDesktopGeometry(saved.page, savedSidebarWidth)
    const secondAppliedWidth = (await readShellGeometry(saved.page)).sidebar
    expect(secondAppliedWidth).toBe(firstAppliedWidth)
    const secondDesktopSamples = await saved.page.evaluate((cursor) => (
      Reflect.get(window, "__desktopWidthSamples") as LayoutSample[]
    ).slice(cursor), secondSampleCursor)
    expectNoTransientDesktopWidth(secondDesktopSamples, savedSidebarWidth)
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
    await caseResources.closeContext(saved.context)
  })

  test("captures closed, Inbox, Profile, update, and cold restore parity", async ({ caseActors, caseResources }, testInfo) => {
    test.setTimeout(240_000)

    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId } = await prepareCase1(actors)

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
        await caseResources.closeContext(authenticated.context)

        const pending = await asUser("alice")
        await pending.page.setViewportSize({ width, height: width === 1024 ? 768 : 900 })
        await pending.page.emulateMedia({ colorScheme: theme })
        await installLayoutState(pending.page, null)
        const scripts = await holdApplicationScripts(pending.page, caseResources)
        const communityReads = await holdCommunityReads(pending.page, caseResources)
        await pending.page.goto(`/c/channels/${serverId}`, { waitUntil: "commit" })
        await expect.poll(scripts.hits).toBeGreaterThan(0)
        expect(scripts.sessionRequests()).toBe(0)
        const ssrFrame = await expectUniqueSsrCommunityFrame(pending.page)
        await expect(ssrFrame).toBeVisible()
        const ssrPhase = await ssrFrame.evaluate(root => ({ initial: root.getAttribute("data-testid"), busy: root.getAttribute("aria-busy"), route: root.getAttribute("data-community-route-kind"), slot: root.getAttribute("data-slot"), placeholders: root.querySelectorAll('[data-slot="skeleton"]').length }))
        if (ssrPhase.initial === tid.initialFrame) {
          expect(ssrPhase.busy).toBe("true")
          expect(ssrPhase.route).toBe("community-root-redirect")
          await expect(pending.page.locator('[data-slot="community-user-bar-base"]')).toHaveCount(0)
        } else expect(ssrPhase.slot).toBe("community-shell-root")
        await expect(pending.page.locator('[data-slot="community-restore-bootstrap"]')).toHaveCount(0)
        await scripts.release()
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
        await caseResources.closeContext(pending.context)
      }
    }
    await attachJson(testInfo, "user-bar-focus-records", focusRecords)
  })

  test("activates only the intended UserBar action outside each narrow visual surface", async ({ caseActors }, testInfo) => {
    test.setTimeout(180_000)
    const { asUser } = await caseActors(["alice"])
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await serveOutdatedMachine(page)
    await gotoAfterUserWsAuth(page, "/c/me")
    const extension = page.getByTestId(tid.userBarExtension)
    await expect(extension).toHaveAttribute("data-extension", "update")
    await page.keyboard.press("Escape")
    await expect(extension).toHaveCount(0)
    const writes = captureWrites(page)
    for (const width of [320, 390, 639, 640, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      await expectUserBarTargets(page, width < 640 ? 44 : 28)
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page).toHaveURL(/\/c\/me\/friends$/)
    const detailPath = new URL(page.url()).pathname
    const back = page.locator('[data-mobile-page-active="true"]')
      .getByRole("button", { name: "Back", exact: true })
    await expect(back).toHaveCount(1)
    await expect(back).toBeVisible()
    await expectPageOwnedReturn(page, back, testInfo, async () => {
      await back.click()
      await expect(page).toHaveURL(/\/c\/me$/)
      await expect(page.locator('[data-community-mobile-surface="list"]')).toBeVisible()
    })
    await attachJson(testInfo, "user-bar-mobile-list-return", { from: detailPath, to: new URL(page.url()).pathname })
    await expectUserBarTargets(page, 44)
    const bar = page.getByTestId(tid.userBar)
    const profile = bar.getByRole("button", { name: /^Open profile/ })
    const inbox = page.getByTestId(tid.inboxTrigger)
    const update = page.getByTestId(tid.daemonUpdateBadge)
    const settings = page.getByTestId(tid.userSettingsOpen)
    const records: Array<{ action: string; edge: string; point: { x: number; y: number } }> = []
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      for (const [action, trigger] of [["profile", profile], ["inbox", inbox], ["update", update]] as const) {
        const point = await clickTargetEdge(page, trigger, edge)
        await expect(extension).toHaveAttribute("data-extension", action)
        if (action === "profile") await expect(page.getByTestId(tid.profileCard)).toBeVisible()
        await page.keyboard.press("Escape")
        await expect(extension).toHaveCount(0)
        await expect(trigger).toBeFocused()
        records.push({ action, edge, point })
      }
      const point = await clickTargetEdge(page, settings, edge)
      await expect(page.getByTestId(tid.settingsShell)).toBeVisible()
      await expect(extension).toHaveCount(0)
      await page.getByTestId(tid.settingsClose).click()
      await expect(page.getByTestId(tid.settingsShell)).toHaveCount(0)
      records.push({ action: "settings", edge, point })
    }
    const name = page.getByTestId(tid.userBarName).locator("..")
    await name.click({ position: { x: 2, y: 2 } })
    await expect(extension).toHaveAttribute("data-extension", "profile")
    await page.keyboard.press("Escape")
    await expect(extension).toHaveCount(0)
    await expect(name).toBeFocused()
    expect(writes.writes).toEqual([])
    writes.stop()
    await attachJson(testInfo, "user-bar-narrow-edge-clicks", records)
    await attachScreenshot(page, testInfo, "user-bar-390-targets-closed")
  })
})
