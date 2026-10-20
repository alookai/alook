import type { Page, Response } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"

import { tid } from "./_fixtures/testids"
import type { CaseActors } from "./_fixtures/case-fixture"

test.use({ viewport: { width: 390, height: 844 } })

async function expectMobileBack(page: Page) {
  const control = page.getByRole("banner").getByRole("button", { name: "Back" })
  await expect(control).toBeVisible()
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

  test("639↔640 preserves the header and composer owners without resize requests", async ({ caseActors }) => {
    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId, threadId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    const startupAttentionPaths = [
      "/api/community/users/me/attention",
    ] as const
    const startupAttentionGenerations = new Map<string, number>(
      startupAttentionPaths.map((pathname) => [pathname, 0]),
    )
    const observeStartupAttention = (response: Response) => {
      const pathname = new URL(response.url()).pathname
      if (response.request().method() !== "GET" || !response.ok()) return
      if (!startupAttentionGenerations.has(pathname)) return
      startupAttentionGenerations.set(pathname, (startupAttentionGenerations.get(pathname) ?? 0) + 1)
    }
    page.on("response", observeStartupAttention)
    await page.setViewportSize({ width: 639, height: 844 })
    await page.goto(`/c/channels/${serverId}/${threadId}`, { waitUntil: "commit" })
    await expect(page.getByTestId(tid.threadSplitPanel).getByTestId(tid.composerInput)).toBeVisible({ timeout: 20_000 })
    await expectMobileBack(page)
    // The shell-owned attention query settles once on cold mount. Keep that
    // generation outside the resize measurement window.
    await expect.poll(() => startupAttentionPaths.every(
      (pathname) => (startupAttentionGenerations.get(pathname) ?? 0) >= 1,
    )).toBe(true)
    page.off("response", observeStartupAttention)
    await page.waitForLoadState("networkidle")

    await page.evaluate(({ composerTestId, threadPanelTestId }) => {
      const backControl = document.querySelector(`[data-testid="${threadPanelTestId}"]`)?.querySelector('button[aria-label="Back"]')
      Reflect.set(window, "__headerHierarchyBanner", backControl?.closest("header[role=banner]"))
      Reflect.set(window, "__headerHierarchyComposer", document.querySelector(`[data-testid="${threadPanelTestId}"]`)?.querySelector(`[data-testid="${composerTestId}"]`))
    }, {
      composerTestId: tid.channelComposerShell,
      threadPanelTestId: tid.threadSplitPanel,
    })
    let communityRequests = 0
    let newSockets = 0
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
  })
})
