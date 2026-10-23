import type { Page, Request, Response } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import { proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"

import { tid } from "./_fixtures/testids"
import type { CaseActors } from "./_fixtures/case-fixture"

test.use({ viewport: { width: 390, height: 844 } })

async function expectMobileBack(page: Page) {
  const control = page.getByRole("banner").getByRole("button", { name: "Back" })
  await expect(async () => {
    expect(await control.count()).toBe(1)
    expect(await control.isVisible()).toBe(true)
  }).toPass({ timeout: 10_000 })
  const controlBox = await control.boundingBox()
  expect(controlBox).toMatchObject({ width: 44, height: 44 })
  return control
}

async function expectRootListDuringCancelledSwipe(page: Page, channelId: string) {
  const pathname = new URL(page.url()).pathname
  const popup = page.locator('[data-slot="mobile-page"][data-open]')
  await expect(popup).toHaveCount(1)
  await expect(popup).not.toHaveAttribute("data-starting-style")
  const session = await page.context().newCDPSession(page)
  try {
    const point = (x: number) => [{ x, y: 220, radiusX: 1, radiusY: 1, force: 1, id: 1 }]
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(80) })
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(150) })
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(280) })
    await expect(popup).toHaveAttribute("data-swiping")
    await expect.poll(async () => (await popup.boundingBox())?.x ?? 0).toBeGreaterThan(100)
    const sidebar = page.getByTestId(tid.channelSidebarScroll)
    await expect(sidebar).toBeVisible()
    expect((await sidebar.boundingBox())?.width).toBeGreaterThan(200)
    const row = page.getByTestId(tid.channelRow(channelId))
    await expect(row).toBeVisible()
    await expect(row).toContainText("swipe-root-text")
    expect((await row.boundingBox())?.width).toBeGreaterThan(200)
    const mainLayer = page.locator('[data-slot="resizable-panel"][id="main"]')
    await expect(mainLayer).toHaveCSS("position", "fixed")
    expect(await mainLayer.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
    const foregroundLeft = (await popup.boundingBox())!.x
    expect(await row.evaluate((element, edge) => {
      let { left, right } = element.getBoundingClientRect()
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(parent).overflowX)) {
          const box = parent.getBoundingClientRect()
          left = Math.max(left, box.left)
          right = Math.min(right, box.right)
        }
      }
      return Math.max(0, Math.min(right, edge) - Math.max(left, 0))
    }, foregroundLeft)).toBeGreaterThan(40)
    await expect(page.locator('[data-slot="community-sidebar-panel-content"]')).toHaveAttribute("inert")
    const presentation = page.locator('[data-slot="community-main-panel-content"]').locator("..")
    await expect(presentation).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await expect(presentation).toHaveCSS("background-image", "none")
    expect(new URL(page.url()).pathname).toBe(pathname)
    await test.info().attach("root-list-during-swipe", { body: await page.screenshot(), contentType: "image/png" })
  } finally {
    try {
      await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
    } finally {
      await session.detach()
    }
  }
  await expect(popup).not.toHaveAttribute("data-swiping")
  await expect.poll(async () => (await popup.boundingBox())?.x ?? Infinity).toBeLessThan(1)
  expect(new URL(page.url()).pathname).toBe(pathname)
}

test.describe("mobile server header direct hierarchy", () => {
  async function prepareCase1(actors: CaseActors) {
    const { seedChannel, seedForumThread, seedMessage, seedServer, seedThread } = actors.seed
    const stamp = Date.now()
    const serverId: string = await seedServer("alice", `header-hierarchy-${stamp}`)
    const textId: string = await seedChannel("alice", serverId, `text-${stamp}`)
    const forumId: string = await seedChannel("alice", serverId, `forum-${stamp}`, "forum")
    const openerId = await seedMessage("alice", textId, `thread opener ${stamp}`)
    const threadName: string = `thread-${stamp}`
    const postTitle: string = `post-${stamp}`
    const threadId: string = await seedThread("alice", openerId, threadName)
    const postId: string = await seedForumThread("alice", forumId, postTitle, "post body")
    return { serverId, textId, forumId, threadId, postId, threadName, postTitle }
  }

  test("top-level text and forum replace directly to the canonical server root", async ({ caseActors }) => {
    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId, textId, forumId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    for (const channelId of [textId, forumId]) {
      await page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
      const control = await expectMobileBack(page)
      const historyLength = await page.evaluate(() => history.length)
      await control.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
      expect(await page.evaluate(() => history.length)).toBe(historyLength)
      await expect(page.locator('[data-slot="community-main-panel-content"]').locator("..")).toBeHidden()
      const sidebar = page.getByTestId(tid.channelSidebarScroll)
      await expect(sidebar).toBeVisible()
      expect(await sidebar.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 100))
        return hit !== null && element.contains(hit)
      })).toBe(true)
    }
  })

  test("reveals the retained channel list during a partial swipe and cancels without navigation", async ({ caseActors }) => {
    const actors = await caseActors(["alice"])
    const serverId = await actors.seed.seedServer("alice", `swipe-root-${Date.now()}`)
    const channelId = await actors.seed.seedChannel("alice", serverId, "swipe-root-text")
    await actors.seed.seedMessage("alice", channelId, "Root list reveal control")
    const { page } = await actors.asUser("alice", { viewport: { width: 390, height: 844 }, hasTouch: true })
    await page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
    const back = await expectMobileBack(page)
    await expect(back).toBeEnabled()
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    await expectRootListDuringCancelledSwipe(page, channelId)
    const historyLength = await page.evaluate(() => history.length)
    await back.click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
    await expect(page.locator('[data-slot="community-main-panel-content"]').locator("..")).toBeHidden()
    await expect(page.getByTestId(tid.channelSidebarScroll)).toBeVisible()
  })

  test("thread and forum post expose direct parent Back and inert current labels", async ({ caseActors }) => {
    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId, textId, forumId, threadId, postId, threadName, postTitle } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    for (const child of [
      { id: threadId, parentId: textId, name: threadName },
      { id: postId, parentId: forumId, name: postTitle },
    ]) {
      await page.goto(`/c/channels/${serverId}/${child.id}`, { waitUntil: "commit" })
      const back = await expectMobileBack(page)
      const current = page.getByRole("banner").locator("span[title]").first()
      await expect(current).toBeVisible()
      await expect(current).toHaveText(child.name)
      expect(await current.evaluate((element) => element.tagName)).toBe("SPAN")

      const backHistoryLength = await page.evaluate(() => history.length)
      await back.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe(
        `/c/channels/${serverId}/${child.parentId}`,
      )
      expect(await page.evaluate(() => history.length)).toBe(backHistoryLength)
    }
  })

  test("639↔640 preserves the header and composer owners without resize requests", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId, threadId } = await prepareCase1(actors)

    const { context, page } = await asUser("alice")
    let holdAuthentication = true
    const proxy = await proxyCommunityWebSockets(context, {
      decideConnectionFrame: (frame) => frame.type === "auth.ok" && holdAuthentication ? "hold" : "forward",
    })
    type StartupPhase = "initial" | "authenticated"
    let phase: StartupPhase | "resize" = "initial"
    const startupRequests = new Map<Request, {
      phase: StartupPhase | "resize"
      pathname: string
      method: string
      status?: number
      terminal: "pending" | "finished" | "failed"
      failure?: string
    }>()
    const observeRequest = (request: Request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname.startsWith("/api/community/")) {
        startupRequests.set(request, { phase, pathname, method: request.method(), terminal: "pending" })
      }
    }
    const observeResponse = (response: Response) => {
      const record = startupRequests.get(response.request())
      if (record) record.status = response.status()
    }
    const observeFinished = (request: Request) => {
      const record = startupRequests.get(request)
      if (record) record.terminal = "finished"
    }
    const observeFailed = (request: Request) => {
      const record = startupRequests.get(request)
      if (record) {
        record.terminal = "failed"
        record.failure = request.failure()?.errorText
      }
    }
    caseResources.own(proxy, async (captured) => {
      holdAuthentication = false
      page.off("request", observeRequest)
      page.off("response", observeResponse)
      page.off("requestfinished", observeFinished)
      page.off("requestfailed", observeFailed)
      try {
        captured.releaseHeldConnections()
      } finally {
        await caseResources.closeContext(context)
      }
      await test.info().attach("header-hierarchy-startup", {
        body: JSON.stringify({
          connections: captured.connectionFrames,
          requests: [...startupRequests].map(([request, record]) => ({ ...record, timing: request.timing() })),
        }),
        contentType: "application/json",
      })
    })
    page.on("request", observeRequest)
    page.on("response", observeResponse)
    page.on("requestfinished", observeFinished)
    page.on("requestfailed", observeFailed)
    const directoryPaths = [
      "/api/community/servers",
      `/api/community/servers/${serverId}/categories`,
      `/api/community/servers/${serverId}/channels`,
    ]
    const readStatePath = "/api/community/users/me/read-state"
    const expectStartupFinished = async (generation: StartupPhase, paths: string[]) => {
      await expect.poll(() => {
        const records = [...startupRequests].map(([request, record]) => ({ ...record, timing: request.timing() }))
        const readStateEnd = Math.max(-1, ...records.filter((record) => record.phase === "authenticated"
          && record.pathname === readStatePath && record.method === "GET"
          && record.terminal === "finished" && record.status === 200 && record.timing.responseEnd >= 0)
          .map((record) => record.timing.startTime + record.timing.responseEnd))
        return {
          failed: records.filter((record) => record.terminal === "failed"
            || (record.status !== undefined && (record.status < 200 || record.status >= 300))),
          pending: records.filter((record) => record.terminal === "pending"),
          missing: paths.filter((pathname) => !records.some((record) => record.phase === generation
            && record.pathname === pathname && record.method === "GET"
            && record.terminal === "finished" && record.status === 200
            && (generation === "initial" || !directoryPaths.includes(pathname)
              || (readStateEnd >= 0 && record.timing.startTime >= readStateEnd)))),
        }
      }).toEqual({ failed: [], pending: [], missing: [] })
    }
    await page.setViewportSize({ width: 639, height: 844 })
    await page.goto(`/c/channels/${serverId}/${threadId}`, { waitUntil: "commit" })
    const threadComposer = page.getByTestId(tid.threadSplitPanel).getByTestId(tid.composerInput)
    await expect(async () => {
      expect(await threadComposer.count()).toBe(1)
      expect(await threadComposer.isVisible()).toBe(true)
    }).toPass({ timeout: 20_000 })
    await expectMobileBack(page)
    // RULE: Cold HTTP reads and first-auth read-state/directory reconciliation
    // must finish before the all-community resize measurement begins.
    await expectStartupFinished("initial", ["/api/community/users/me/attention", ...directoryPaths])
    await expect.poll(() => proxy.heldConnectionCount()).toBe(1)
    expect(proxy.connectionCount()).toBe(1)
    phase = "authenticated"
    holdAuthentication = false
    expect(proxy.releaseHeldConnections((frame) => frame.type === "auth.ok")).toBe(1)
    await expectStartupFinished("authenticated", [readStatePath, ...directoryPaths])
    await page.waitForLoadState("networkidle")
    await expectStartupFinished("authenticated", [readStatePath, ...directoryPaths])
    expect(proxy.connectionCount()).toBe(1)

    await page.evaluate(({ composerTestId, threadPanelTestId }) => {
      const backControl = document.querySelector(`[data-testid="${threadPanelTestId}"]`)?.querySelector('button[aria-label="Back"]')
      Reflect.set(window, "__headerHierarchyBanner", backControl?.closest("header[role=banner]"))
      Reflect.set(window, "__headerHierarchyComposer", document.querySelector(`[data-testid="${threadPanelTestId}"]`)?.querySelector(`[data-testid="${composerTestId}"]`))
    }, {
      composerTestId: tid.channelComposerShell,
      threadPanelTestId: tid.threadSplitPanel,
    })
    phase = "resize"
    let communityRequests = 0
    let newSockets = 0
    const connectionCount = proxy.connectionCount()
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/community/")) communityRequests += 1
    })
    page.on("websocket", () => { newSockets += 1 })
    const pathname = new URL(page.url()).pathname

    await page.setViewportSize({ width: 640, height: 844 })
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible()
    await expect(page.getByTestId(tid.threadSplitPanel).getByTestId(tid.channelComposerShell)).toBeVisible()
    expect(await page.evaluate(({ composerTestId, threadPanelTestId }) => ({
      banner: Reflect.get(window, "__headerHierarchyBanner") === document.querySelector(`[data-testid="${threadPanelTestId}"]`)?.querySelector('button[aria-label="Back"]')?.closest("header[role=banner]"),
      composer: Reflect.get(window, "__headerHierarchyComposer") === document.querySelector(`[data-testid="${threadPanelTestId}"]`)?.querySelector(`[data-testid="${composerTestId}"]`),
    }), {
      composerTestId: tid.channelComposerShell,
      threadPanelTestId: tid.threadSplitPanel,
    })).toEqual({ banner: true, composer: true })

    await page.setViewportSize({ width: 639, height: 844 })
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible()
    expect(await page.evaluate(({ composerTestId, threadPanelTestId }) => ({
      banner: Reflect.get(window, "__headerHierarchyBanner") === document.querySelector(`[data-testid="${threadPanelTestId}"]`)?.querySelector('button[aria-label="Back"]')?.closest("header[role=banner]"),
      composer: Reflect.get(window, "__headerHierarchyComposer") === document.querySelector(`[data-testid="${threadPanelTestId}"]`)?.querySelector(`[data-testid="${composerTestId}"]`),
    }), {
      composerTestId: tid.channelComposerShell,
      threadPanelTestId: tid.threadSplitPanel,
    })).toEqual({ banner: true, composer: true })
    expect(new URL(page.url()).pathname).toBe(pathname)
    expect(communityRequests).toBe(0)
    expect(newSockets).toBe(0)
    expect(proxy.connectionCount() - connectionCount).toBe(0)
  })
})
