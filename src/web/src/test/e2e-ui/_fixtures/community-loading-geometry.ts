import type {
  BrowserContext,
  BrowserContextOptions,
  Locator,
  Page,
  Route,
  TestInfo,
} from "@playwright/test"
import { expect, sessionCookie, userId } from "./community-fixture"
import {
  COMMUNITY_RAIL_WIDTH,
  COMMUNITY_SEPARATOR_WIDTH,
  COMMUNITY_SURFACE_BORDER_WIDTH,
} from "@/components/community/shell/shell-frame-geometry"
import {
  seedChannel,
  seedDm,
  seedForumThread,
  seedMessage,
  seedServer,
  seedThread,
} from "./seed"
import { tid } from "./testids"
import { WEB_URL } from "../_setup/paths"
import type { UserKey } from "../_setup/users"

type Theme = "light" | "dark"
type CommunityAsUser = (
  key: UserKey,
  options?: Omit<BrowserContextOptions, "storageState">,
) => Promise<{ context: BrowserContext; page: Page }>
type MobileWidth = 320 | 390 | 639
type DesktopWidth = 640 | 768 | 1024 | 1280
type PersistedSidebarWidth = 160 | 240 | 350 | 360
const RAIL_OVERFLOW_SERVER_COUNT = 20
const ISOLATED_GEOMETRY_USER: UserKey = "dave"
const DESKTOP_DENSITY_SCALES = [1, 1.25] as const
const ANDROID_USER_AGENTS = {
  chrome: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  webview: "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.240905.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36",
} as const
type Geometry = Record<string, { x: number; y: number; width: number; height: number }>
type MatrixCase = {
  name: string
  pathname: string
  width: 390 | 1280
  mobileRail?: boolean
  ready: (page: Page) => Locator
  intermediate?: {
    requestPattern: string
    ready: (page: Page) => Locator
  }
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

async function holdRequest(page: Page, pattern: string) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let hits = 0
  await page.route(pattern, async (route) => {
    hits += 1
    await gate
    await route.continue()
  })
  return { hits: () => hits, release }
}

async function pairMachine() {
  const pair = await fetch(`${WEB_URL}/api/community/machines/pair`, {
    method: "POST",
    headers: { Cookie: sessionCookie("alice"), Origin: WEB_URL },
  })
  expect(pair.status).toBe(200)
  const { tokenId } = await pair.json() as { tokenId: string }
  const activate = await fetch(`${WEB_URL}/api/community/daemon/activate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenId}`,
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({
      hostname: `geometry-mobile-${Date.now()}`,
      platform: "android",
      arch: "arm64",
      runtimeReport: [{ id: "codex", status: "healthy" }],
    }),
  })
  expect(activate.status).toBe(200)
}

const shellPanel = (page: Page, id: "sidebar" | "main") => (
  page.locator(`[data-slot="resizable-panel"][data-testid="${id}"]`)
)

async function visibleGeometry(page: Page): Promise<Geometry> {
  const landmarks = {
    shell: page.locator('[data-slot="community-shell-root"]'),
    surface: page.locator('[data-slot="community-app-surface"]'),
    rail: page.locator('[data-slot="community-server-rail-viewport"]'),
    sidebar: shellPanel(page, "sidebar"),
    main: shellPanel(page, "main"),
    userBar: page.locator('[data-slot="community-user-bar-overlay"]'),
  }
  const result: Geometry = {}
  for (const [name, locator] of Object.entries(landmarks)) {
    if (await locator.count() !== 1 || !await locator.isVisible()) continue
    const box = await locator.boundingBox()
    if (box) result[name] = box
  }
  return result
}

function expectSameGeometry(before: Geometry, after: Geometry) {
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  for (const name of Object.keys(before)) {
    const pending = before[name]!
    const loaded = after[name]!
    for (const coordinate of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(pending[coordinate] - loaded[coordinate]),
        `${name}.${coordinate}`,
      ).toBeLessThanOrEqual(1)
    }
  }
}

async function startClsObserver(page: Page) {
  await page.addInitScript(() => {
    Reflect.set(window, "__communityLoadingCls", 0)
    Reflect.set(window, "__communityLoadingClsSources", [])
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number }
        if (!shift.hadRecentInput) {
          Reflect.set(
            window,
            "__communityLoadingCls",
            (Reflect.get(window, "__communityLoadingCls") as number) + (shift.value ?? 0),
          )
          const sources = (entry as PerformanceEntry & {
            sources?: Array<{
              node?: Node
              previousRect?: DOMRectReadOnly
              currentRect?: DOMRectReadOnly
            }>
          }).sources ?? []
          const recorded = Reflect.get(window, "__communityLoadingClsSources") as unknown[]
          recorded.push(...sources.map((source) => ({
            node: source.node instanceof Element
              ? `${source.node.tagName.toLowerCase()}${source.node.getAttribute("data-slot") ? `[data-slot=${source.node.getAttribute("data-slot")}]` : ""}`
              : "unknown",
            previous: source.previousRect,
            current: source.currentRect,
          })))
        }
      }
    }).observe({ type: "layout-shift", buffered: true })
  })
}

async function resetCls(page: Page) {
  await page.evaluate(() => {
    Reflect.set(window, "__communityLoadingCls", 0)
    Reflect.set(window, "__communityLoadingClsSources", [])
  })
}

async function readCls(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  return page.evaluate(() => ({
    value: Reflect.get(window, "__communityLoadingCls") as number,
    sources: Reflect.get(window, "__communityLoadingClsSources") as unknown[],
  }))
}

type FirstFrameSample = {
  overflow: number
  geometry: Geometry
}

type DesktopPendingFrameSample = {
  overflow: number
  sidebarWidth: number
  sidebarRight: number
  mainLeft: number
  userBarRight: number
}

async function installFirstFrameProbe(page: Page, surface: "list" | "detail") {
  await page.addInitScript((expectedSurface) => {
    const samples: FirstFrameSample[] = []
    Reflect.set(window, "__communityFirstFrameSamples", samples)

    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element || getComputedStyle(element).display === "none") return null
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return null
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    }
    const sample = () => {
      if (document.querySelector('[data-slot="community-shell-root"]')) {
        const activePanel = '[data-slot="resizable-panel"][data-mobile-active="true"]'
        const hiddenPanel = '[data-slot="resizable-panel"][data-mobile-hidden="true"]'
        const geometry = Object.fromEntries(Object.entries({
          shell: rect('[data-slot="community-shell-root"]'),
          surface: rect('[data-slot="community-app-surface"]'),
          rail: rect('[data-slot="community-server-rail-viewport"]'),
          sidebar: rect(expectedSurface === "list" ? activePanel : hiddenPanel),
          main: rect(expectedSurface === "detail" ? activePanel : hiddenPanel),
          userBar: rect('[data-slot="community-user-bar-overlay"]'),
        }).filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== null))
        samples.push({
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          geometry,
        })
      }
      if (performance.now() < 5_000) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }, surface)
}

async function firstFrameSamples(page: Page): Promise<FirstFrameSample[]> {
  return page.evaluate(() => (
    Reflect.get(window, "__communityFirstFrameSamples") as FirstFrameSample[]
  ))
}

function desktopPanelTrackWidth(viewportWidth: DesktopWidth) {
  return viewportWidth
    - COMMUNITY_RAIL_WIDTH
    - COMMUNITY_SURFACE_BORDER_WIDTH
    - COMMUNITY_SEPARATOR_WIDTH
}

async function installDesktopPendingFrameProbe(
  page: Page,
  viewportWidth: DesktopWidth,
  sidebarWidth: PersistedSidebarWidth | null,
) {
  const panelTrackWidth = desktopPanelTrackWidth(viewportWidth)
  await page.addInitScript(({ initialFrameTestId, layoutStorageKey, persistedLayout }) => {
    if (persistedLayout) {
      localStorage.setItem(layoutStorageKey, JSON.stringify(persistedLayout))
    } else {
      localStorage.removeItem(layoutStorageKey)
    }
    const samples: DesktopPendingFrameSample[] = []
    Reflect.set(window, "__communityDesktopPendingFrameSamples", samples)

    const sample = () => {
      const frame = document.querySelector(`[data-testid="${initialFrameTestId}"]`)
      const panels = frame?.querySelectorAll<HTMLElement>('[data-slot="resizable-panel"]')
      const sidebar = panels?.[0]
      const main = panels?.[1]
      const userBar = document.querySelector<HTMLElement>(
        '[data-slot="community-user-bar-overlay"]',
      )
      if (frame && sidebar && main && userBar) {
        const sidebarRect = sidebar.getBoundingClientRect()
        const mainRect = main.getBoundingClientRect()
        const userBarRect = userBar.getBoundingClientRect()
        samples.push({
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          sidebarWidth: sidebarRect.width,
          sidebarRight: sidebarRect.right,
          mainLeft: mainRect.left,
          userBarRight: userBarRect.right,
        })
      }
      if (performance.now() < 5_000) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }, {
    initialFrameTestId: tid.initialFrame,
    layoutStorageKey: "react-resizable-panels:community-shell",
    persistedLayout: sidebarWidth === null
      ? null
      : {
          sidebar: sidebarWidth / panelTrackWidth * 100,
          main: 100 - sidebarWidth / panelTrackWidth * 100,
        },
  })
}

async function desktopPendingFrameSamples(page: Page): Promise<DesktopPendingFrameSample[]> {
  return page.evaluate(() => Reflect.get(
    window,
    "__communityDesktopPendingFrameSamples",
  ) as DesktopPendingFrameSample[])
}

function expectMobileGeometry(
  samples: FirstFrameSample[],
  width: MobileWidth,
  surface: "list" | "detail",
) {
  expect(samples.length).toBeGreaterThan(0)
  const first = samples[0]!
  const geometryDrift: string[] = []
  for (const [index, sample] of samples.entries()) {
    expect(sample.overflow, `frame ${index} horizontal overflow`).toBe(0)
    expect(
      Object.keys(sample.geometry).sort(),
      `frame ${index} visible modules: ${JSON.stringify(sample)}`,
    ).toEqual(
      surface === "list"
        ? ["rail", "shell", "sidebar", "surface", "userBar"]
        : ["main", "shell", "surface"],
    )
    expect(sample.geometry.shell?.width, `frame ${index} shell width`).toBeCloseTo(width, 0)
    expect(sample.geometry.surface?.width, `frame ${index} surface width`).toBeCloseTo(
      surface === "list" ? width - 56 : width,
      0,
    )
    if (surface === "list") {
      expect(sample.geometry.sidebar?.width, `frame ${index} sidebar width`).toBeCloseTo(width - 57, 0)
      expect(sample.geometry.userBar?.width, `frame ${index} UserBar width`).toBeCloseTo(width, 0)
    } else {
      expect(sample.geometry.main?.width, `frame ${index} main width`).toBeCloseTo(width, 0)
    }
    for (const name of Object.keys(first.geometry)) {
      for (const coordinate of ["x", "y", "width", "height"] as const) {
        if (Math.abs(first.geometry[name]![coordinate] - sample.geometry[name]![coordinate]) > 1) {
          geometryDrift.push(`frame ${index} ${name}.${coordinate}`)
        }
      }
    }
  }
  expect(geometryDrift, "mobile landmark geometry drift").toEqual([])
}

async function expectMachinesHeadingSpacing(page: Page) {
  const heading = page.locator('[data-slot="community-machines-heading"]')
  await expect(heading).toBeVisible()
  const geometry = await heading.evaluate((element) => {
    const copy = element.querySelector<HTMLElement>('[data-slot="community-machines-heading-copy"]')!
    const action = element.querySelector<HTMLElement>('[data-slot="community-machines-heading-action"]')!
    const copyBox = copy.getBoundingClientRect()
    const actionBox = action.getBoundingClientRect()
    const headingBox = element.getBoundingClientRect()
    return {
      fits: element.scrollWidth <= element.clientWidth,
      gap: actionBox.top - copyBox.bottom,
      heading: {
        x: headingBox.x,
        y: headingBox.y,
        width: headingBox.width,
        height: headingBox.height,
      },
      headingWidth: headingBox.width,
      actionWidth: actionBox.width,
      actionHeight: actionBox.height,
    }
  })
  expect(geometry.fits).toBe(true)
  expect(geometry.gap).toBeGreaterThanOrEqual(15)
  expect(geometry.actionWidth).toBeCloseTo(geometry.headingWidth, 0)
  expect(geometry.actionHeight).toBeGreaterThanOrEqual(44)
  return geometry.heading
}

async function visibleSkeletonAnimationProperties(page: Page) {
  return page.locator('[data-slot="skeleton"]').evaluateAll((elements) => Array.from(new Set(
    elements
      .filter((element) => {
        const box = element.getBoundingClientRect()
        return getComputedStyle(element).display !== "none" && box.width > 0 && box.height > 0
      })
      .flatMap((element) => element.getAnimations())
      .flatMap((animation) => animation.effect instanceof KeyframeEffect
        ? animation.effect.getKeyframes()
        : [])
      .flatMap((frame) => Object.keys(frame))
      .filter((property) => ![
        "composite",
        "computedOffset",
        "easing",
        "offset",
      ].includes(property)),
  )).sort())
}

export async function seedGeometryRoutes(): Promise<Omit<MatrixCase, "width">[]> {
  const stamp = Date.now()
    const serverId = await seedServer(ISOLATED_GEOMETRY_USER, `Geometry ${stamp}`)
    for (let index = 1; index < RAIL_OVERFLOW_SERVER_COUNT; index += 1) {
      await seedServer(ISOLATED_GEOMETRY_USER, `Geometry rail ${stamp}-${index}`)
    }
    const textId = await seedChannel(ISOLATED_GEOMETRY_USER, serverId, `geometry-text-${stamp}`)
    const forumId = await seedChannel(
      ISOLATED_GEOMETRY_USER,
      serverId,
      `geometry-forum-${stamp}`,
      "forum",
    )
    const textMessage = `geometry opener ${stamp}`
    const threadMessage = `geometry reply ${stamp}`
    const forumTitle = `Geometry forum post ${stamp}`
    const forumMessage = `geometry forum reply ${stamp}`
    const dmMessage = `geometry dm ${stamp}`
    const openerId = await seedMessage(ISOLATED_GEOMETRY_USER, textId, textMessage)
    const threadId = await seedThread(
      ISOLATED_GEOMETRY_USER,
      openerId,
      `geometry-thread-${stamp}`,
    )
    await seedMessage(ISOLATED_GEOMETRY_USER, threadId, threadMessage)
    const forumPostId = await seedForumThread(
      ISOLATED_GEOMETRY_USER,
      forumId,
      forumTitle,
      forumMessage,
    )
    const dmId = await seedDm(ISOLATED_GEOMETRY_USER, userId("bob"))
    await seedMessage(ISOLATED_GEOMETRY_USER, dmId, dmMessage)

    const main = (page: Page) => shellPanel(page, "main")
    const messageReady = (content: string) => (page: Page) =>
      main(page).getByText(content, { exact: true }).first()
    const threadComposerReady = (page: Page) => page
      .getByTestId(tid.threadSplitPanel)
      .getByTestId(tid.composerInput)
  return [
      { name: "me-list", pathname: "/c/me", mobileRail: true, ready: (page) => page.getByRole("button", { name: "Friends", exact: true }) },
      { name: "friends", pathname: "/c/me/friends", ready: (page) => page.getByPlaceholder("Search friends") },
      { name: "machines", pathname: "/c/me/machines", ready: (page) => page.getByTestId(tid.machinePairOpen) },
      { name: "bots", pathname: "/c/me/bots", ready: (page) => page.getByRole("button", { name: /Create a bot|Connect a machine/ }) },
      { name: "dm", pathname: `/c/me/${dmId}`, ready: messageReady(dmMessage) },
      { name: "text", pathname: `/c/channels/${serverId}/${textId}`, ready: messageReady(textMessage) },
      {
        name: "forum",
        pathname: `/c/channels/${serverId}/${forumId}`,
        ready: messageReady(forumTitle),
        intermediate: {
          requestPattern: `**/api/community/channels/${forumId}/threads?**`,
          ready: (page) => page.getByTestId(tid.forumFilterBar),
        },
      },
      {
        name: "thread",
        pathname: `/c/channels/${serverId}/${threadId}`,
        ready: messageReady(threadMessage),
        intermediate: {
          requestPattern: `**/api/community/channels/${threadId}/messages**`,
          ready: threadComposerReady,
        },
      },
      {
        name: "forum-post",
        pathname: `/c/channels/${serverId}/${forumPostId}`,
        ready: messageReady(forumMessage),
        intermediate: {
          requestPattern: `**/api/community/channels/${forumPostId}/messages**`,
          ready: threadComposerReady,
        },
      },
  ]
}

export async function runAndroidLoadingGeometry(asUser: CommunityAsUser) {
    await pairMachine()
    for (const userAgent of Object.values(ANDROID_USER_AGENTS)) {
      for (const width of [320, 390, 639] as const) {
        for (const [pathname, surface] of [
          ["/c/me", "list"],
          ["/c/me/machines", "detail"],
        ] as const) {
          const { context, page } = await asUser("alice", { userAgent })
          await page.setViewportSize({ width, height: width === 320 ? 720 : 900 })
          await installFirstFrameProbe(page, surface)
          const session = await holdSession(page)
          await page.goto(pathname, { waitUntil: "commit" })
          await expect.poll(session.hits).toBeGreaterThan(0)
          await expect(page.getByTestId(tid.initialFrame)).toBeVisible()
          await page.waitForTimeout(250)

          expectMobileGeometry(await firstFrameSamples(page), width, surface)
          const pendingHeading = pathname === "/c/me/machines"
            ? await expectMachinesHeadingSpacing(page)
            : null

          session.release()
          await expect(page.getByTestId(tid.initialFrame)).toHaveCount(0, { timeout: 30_000 })
          await expect(
            pathname === "/c/me"
              ? page.getByRole("button", { name: "Friends", exact: true })
              : page.getByTestId(tid.machinePairOpen),
          ).toBeVisible({ timeout: 30_000 })
          if (pendingHeading) {
            const loadedHeading = await expectMachinesHeadingSpacing(page)
            expectSameGeometry({ heading: pendingHeading }, { heading: loadedHeading })
          }
          await page.waitForTimeout(250)
          expectMobileGeometry(await firstFrameSamples(page), width, surface)
          await context.close()
        }
      }
    }
}

export async function runDesktopPersistedPendingGeometry(
  theme: Theme,
  asUser: CommunityAsUser,
) {
  for (const viewportWidth of [640, 768, 1024, 1280] as const) {
    for (const sidebarWidth of [null, 160, 240, 350, 360] as const) {
      for (const deviceScaleFactor of DESKTOP_DENSITY_SCALES) {
        const caseLabel = `${viewportWidth}px @${deviceScaleFactor}x, sidebar ${sidebarWidth ?? "default"}`
        const { context, page } = await asUser(ISOLATED_GEOMETRY_USER, {
          deviceScaleFactor,
        })
        await page.setViewportSize({ width: viewportWidth, height: 900 })
        await page.emulateMedia({ colorScheme: theme })
        await installDesktopPendingFrameProbe(page, viewportWidth, sidebarWidth)
        const session = await holdSession(page)
        await page.goto("/c/me/machines", { waitUntil: "commit" })
        await expect.poll(session.hits).toBeGreaterThan(0)
        await expect(page.getByTestId(tid.initialFrame)).toBeVisible()
        await page.waitForTimeout(250)

        const samples = await desktopPendingFrameSamples(page)
        expect(samples.length, caseLabel).toBeGreaterThan(0)
        for (const [index, sample] of samples.entries()) {
          expect(sample.overflow, `${caseLabel}, frame ${index} horizontal overflow`).toBe(0)
          expect(
            Math.abs(sample.userBarRight - sample.mainLeft),
            `${caseLabel}, frame ${index} User bar/main boundary: ${JSON.stringify(sample)}`,
          ).toBeLessThanOrEqual(1)
          const separatorWidth = sample.mainLeft - sample.sidebarRight
          expect(
            separatorWidth,
            `${caseLabel}, frame ${index} separator width: ${JSON.stringify(sample)}`,
          ).toBeGreaterThanOrEqual(0)
          expect(
            separatorWidth,
            `${caseLabel}, frame ${index} separator width: ${JSON.stringify(sample)}`,
          ).toBeLessThanOrEqual(1)
        }
        const expectedSidebarWidth = sidebarWidth ?? Math.min(
          360,
          Math.max(160, desktopPanelTrackWidth(viewportWidth) * 0.24),
        )
        expect(
          Math.abs(samples.at(-1)!.sidebarWidth - expectedSidebarWidth),
          `${caseLabel}, final sidebar width: ${JSON.stringify(samples.at(-1))}`,
        ).toBeLessThanOrEqual(1)

        session.release()
        await context.close()
      }
    }
  }
}

export async function runSkeletonLoadingMotion(asUser: CommunityAsUser) {
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      const { context, page } = await asUser("alice", {
        userAgent: ANDROID_USER_AGENTS.webview,
      })
      await page.setViewportSize({ width: 320, height: 720 })
      await page.emulateMedia({ reducedMotion })
      const session = await holdSession(page)
      await page.goto("/c/me/machines", { waitUntil: "commit" })
      await expect.poll(session.hits).toBeGreaterThan(0)
      await expect(page.getByTestId(tid.initialFrame)).toBeVisible()

      const animationProperties = await visibleSkeletonAnimationProperties(page)
      expect(animationProperties).toEqual(reducedMotion === "reduce" ? [] : ["opacity"])

      session.release()
      await context.close()
    }
}

export async function runNeutralRootGeometry(
  theme: Theme,
  asUser: CommunityAsUser,
  testInfo: TestInfo,
) {
      for (const width of [390, 1280] as const) {
        const { context, page } = await asUser(ISOLATED_GEOMETRY_USER)
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme })
        await page.addInitScript((storageKey) => {
          localStorage.removeItem(storageKey)
        }, `community:lastRoute:${encodeURIComponent(userId(ISOLATED_GEOMETRY_USER))}`)
        const session = await holdSession(page)
        await page.goto("/c", { waitUntil: "commit" })
        await expect.poll(session.hits).toBeGreaterThan(0)

        const frame = page.getByTestId(tid.initialFrame)
        await expect(frame).toBeVisible()
        await expect(frame).toHaveAttribute(
          "data-community-route-kind",
          "community-root-redirect",
        )
        await expect(page.getByTestId(tid.pendingMain("route-resolution"))).toBeVisible()
        await expect(page.getByTestId(tid.pendingMain("machines"))).toHaveCount(0)
        await expect(page.locator('[data-slot="community-shell-root"]')).toHaveCount(0)
        await expect(page.getByTestId(tid.initialRailPending)).toHaveCount(0)
        await expect(page.getByTestId(tid.dmSidebarPending)).toHaveCount(0)
        await expect(page.locator(
          `[data-testid^="${tid.channelSidebarPending("")}"]`,
        ))
          .toHaveCount(0)
        await expect(page.getByTestId(tid.initialUserBarPending)).toHaveCount(0)
        await expect(frame.getByRole("button")).toHaveCount(0)
        await expect(frame.locator("a")).toHaveCount(0)
        await expect(frame).not.toContainText("Machines")
        expect(await page.evaluate(() => (
          document.documentElement.scrollWidth <= document.documentElement.clientWidth
        ))).toBe(true)

        const pendingPath = testInfo.outputPath(`${theme}-${width}-root-neutral-pending.png`)
        await page.screenshot({ path: pendingPath })
        await testInfo.attach(`${theme}-${width}-root-neutral-pending`, {
          path: pendingPath,
          contentType: "image/png",
        })

        session.release()
        await expect(page.getByTestId(tid.initialFrame)).toHaveCount(0, { timeout: 30_000 })
        await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me/machines")
        await expect(page.getByTestId(tid.machinePairOpen)).toBeVisible({ timeout: 30_000 })
        expect(await page.evaluate(() => (
          document.documentElement.scrollWidth <= document.documentElement.clientWidth
        ))).toBe(true)
        await context.close()
      }
}

export async function runRouteLoadingGeometry(
  theme: Theme,
  routes: Omit<MatrixCase, "width">[],
  asUser: CommunityAsUser,
  testInfo: TestInfo,
) {
      const cases: MatrixCase[] = routes.flatMap((route) => ([
        { ...route, width: 390 },
        { ...route, width: 1280 },
      ]))
      expect(cases).toHaveLength(18)

      for (const entry of cases) {
        const { context, page } = await asUser(ISOLATED_GEOMETRY_USER)
        await page.setViewportSize({ width: entry.width, height: entry.width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme })
        await startClsObserver(page)
        const session = await holdSession(page)
        const intermediate = entry.intermediate
          ? await holdRequest(page, entry.intermediate.requestPattern)
          : null
        await page.goto(entry.pathname, { waitUntil: "commit" })
        await expect.poll(session.hits).toBeGreaterThan(0)
        await expect(page.getByTestId(tid.initialFrame)).toBeVisible()
        await expect(page.locator('[data-slot="community-shell-root"]')).toHaveCount(1)
        await expect(page.locator('[data-slot="community-shell-root"] button')).toHaveCount(0)
        const pendingAdd = page.locator('[data-slot="community-server-rail-add"]')
        await expect(pendingAdd).toHaveCount(0)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
          .toBe(true)
        const pendingGeometry = await visibleGeometry(page)
        const pendingPath = testInfo.outputPath(`${theme}-${entry.width}-${entry.name}-pending.png`)
        await page.screenshot({ path: pendingPath })
        await testInfo.attach(`${theme}-${entry.width}-${entry.name}-pending`, {
          path: pendingPath,
          contentType: "image/png",
        })

        await resetCls(page)
        session.release()
        await expect(page.getByTestId(tid.initialFrame)).toHaveCount(0, { timeout: 30_000 })
        if (entry.intermediate && intermediate) {
          await expect.poll(intermediate.hits).toBeGreaterThan(0)
          await expect(entry.intermediate.ready(page)).toBeVisible({ timeout: 30_000 })
          const intermediatePath = testInfo.outputPath(
            `${theme}-${entry.width}-${entry.name}-intermediate.png`,
          )
          await page.screenshot({ path: intermediatePath })
          await testInfo.attach(`${theme}-${entry.width}-${entry.name}-intermediate`, {
            path: intermediatePath,
            contentType: "image/png",
          })
          intermediate.release()
        }
        await expect(entry.ready(page)).toBeVisible({ timeout: 30_000 })
        await expect(page.locator('[data-slot="community-shell-root"]')).toHaveCount(1)
        const loadedAdd = page.getByTestId(tid.serverAdd)
        if (entry.width === 1280 || entry.mobileRail) {
          await expect(loadedAdd).toBeVisible()
          const railScroll = page.getByTestId(tid.serverRailScroll)
          await expect(railScroll).toBeVisible()
          expect(await railScroll.evaluate((element) => element.scrollHeight > element.clientHeight))
            .toBe(true)
        } else {
          await expect(loadedAdd).toHaveCount(0)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
          .toBe(true)
        const loadedGeometry = await visibleGeometry(page)
        expectSameGeometry(pendingGeometry, loadedGeometry)
        const cls = await readCls(page)
        expect(cls.value, JSON.stringify(cls.sources)).toBe(0)

        const loadedPath = testInfo.outputPath(`${theme}-${entry.width}-${entry.name}-loaded.png`)
        await page.screenshot({ path: loadedPath })
        await testInfo.attach(`${theme}-${entry.width}-${entry.name}-loaded`, {
          path: loadedPath,
          contentType: "image/png",
        })
        await context.close()
      }
}
