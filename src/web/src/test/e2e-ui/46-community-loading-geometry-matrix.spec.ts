import type { Locator, Page, Route } from "@playwright/test"
import { expect, test, userId } from "./_fixtures/community-fixture"
import {
  seedChannel,
  seedDm,
  seedForumThread,
  seedMessage,
  seedServer,
  seedThread,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

type Theme = "light" | "dark"
type Geometry = Record<string, { x: number; y: number; width: number; height: number }>
type MatrixCase = {
  name: string
  pathname: string
  width: 390 | 1280
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

async function visibleGeometry(page: Page): Promise<Geometry> {
  const landmarks = {
    shell: page.locator('[data-slot="community-shell-root"]'),
    surface: page.locator('[data-slot="community-app-surface"]'),
    rail: page.getByTestId(tid.serverRailScroll),
    sidebar: page.locator('[data-slot="community-sidebar-panel"]'),
    main: page.locator('[data-slot="community-main-panel"]'),
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

test.describe.serial("community pending-to-loaded geometry matrix", () => {
  let routes!: Omit<MatrixCase, "width">[]

  test.beforeAll(async () => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Geometry ${stamp}`)
    const textId = await seedChannel("alice", serverId, `geometry-text-${stamp}`)
    const forumId = await seedChannel("alice", serverId, `geometry-forum-${stamp}`, "forum")
    const textMessage = `geometry opener ${stamp}`
    const threadMessage = `geometry reply ${stamp}`
    const forumTitle = `Geometry forum post ${stamp}`
    const forumMessage = `geometry forum reply ${stamp}`
    const dmMessage = `geometry dm ${stamp}`
    const openerId = await seedMessage("alice", textId, textMessage)
    const threadId = await seedThread("alice", openerId, `geometry-thread-${stamp}`)
    await seedMessage("alice", threadId, threadMessage)
    const forumPostId = await seedForumThread(
      "alice",
      forumId,
      forumTitle,
      forumMessage,
    )
    const dmId = await seedDm("alice", userId("bob"))
    await seedMessage("alice", dmId, dmMessage)

    const main = (page: Page) => page.locator('[data-slot="community-main-panel"]')
    const messageReady = (content: string) => (page: Page) =>
      main(page).getByText(content, { exact: true }).first()
    const threadComposerReady = (page: Page) => page
      .getByTestId(tid.threadSplitPanel)
      .getByTestId(tid.composerInput)
    routes = [
      { name: "root-machines", pathname: "/c", ready: (page) => page.getByTestId(tid.machinePairOpen) },
      { name: "me-list", pathname: "/c/me", ready: (page) => page.getByRole("button", { name: "Friends", exact: true }) },
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
  })

  for (const theme of ["light", "dark"] as const satisfies readonly Theme[]) {
    test(`${theme}: 20 route × viewport pending→loaded pairs keep shell CLS at zero`, async ({ asUser }, testInfo) => {
      test.setTimeout(600_000)
      const cases: MatrixCase[] = routes.flatMap((route) => ([
        { ...route, width: 390 },
        { ...route, width: 1280 },
      ]))
      expect(cases).toHaveLength(20)

      for (const entry of cases) {
        const { context, page } = await asUser("alice")
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
    })
  }
})
