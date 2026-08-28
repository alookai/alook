import type { Page } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import {
  seedChannel,
  seedForumThread,
  seedMessage,
  seedServer,
  seedThread,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

test.use({ viewport: { width: 390, height: 844 } })

async function expectServerControl(page: Page, serverId: string) {
  const control = page.getByTestId(tid.channelHeaderServer(serverId))
  await expect(control).toBeVisible()
  await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0)
  const [controlBox, visualBox] = await Promise.all([
    control.boundingBox(),
    control.locator(":scope > span").boundingBox(),
  ])
  expect(controlBox).toMatchObject({ width: 44, height: 44 })
  expect(visualBox).toMatchObject({ width: 24, height: 24 })
  return control
}

test.describe.serial("mobile server header direct hierarchy", () => {
  let serverId: string
  let textId: string
  let forumId: string
  let threadId: string
  let postId: string

  test.beforeAll(async () => {
    const stamp = Date.now()
    serverId = await seedServer("alice", `header-hierarchy-${stamp}`)
    textId = await seedChannel("alice", serverId, `text-${stamp}`)
    forumId = await seedChannel("alice", serverId, `forum-${stamp}`, "forum")
    const openerId = await seedMessage("alice", textId, `thread opener ${stamp}`)
    threadId = await seedThread("alice", openerId, `thread-${stamp}`)
    postId = await seedForumThread("alice", forumId, `post-${stamp}`, "post body")
  })

  test("top-level text and forum replace directly to the canonical server root", async ({ asUser }) => {
    const { page } = await asUser("alice")
    for (const channelId of [textId, forumId]) {
      await page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
      const control = await expectServerControl(page, serverId)
      const historyLength = await page.evaluate(() => history.length)
      await control.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
      expect(await page.evaluate(() => history.length)).toBe(historyLength)
    }
  })

  test("thread and forum post expose direct parent, direct root, and inert current labels", async ({ asUser }) => {
    const { page } = await asUser("alice")
    for (const child of [
      { id: threadId, parentId: textId },
      { id: postId, parentId: forumId },
    ]) {
      await page.goto(`/c/channels/${serverId}/${child.id}`, { waitUntil: "commit" })
      await expectServerControl(page, serverId)
      const parent = page.getByTestId(tid.channelHeaderParent(child.parentId))
      await expect(parent).toBeVisible()
      const current = page.getByRole("banner").locator("span[title]").first()
      await expect(current).toBeVisible()
      expect(await current.evaluate((element) => element.tagName)).toBe("SPAN")

      const parentHistoryLength = await page.evaluate(() => history.length)
      await parent.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe(
        `/c/channels/${serverId}/${child.parentId}`,
      )
      expect(await page.evaluate(() => history.length)).toBe(parentHistoryLength)

      await page.goto(`/c/channels/${serverId}/${child.id}`, { waitUntil: "commit" })
      const rootHistoryLength = await page.evaluate(() => history.length)
      await page.getByTestId(tid.channelHeaderServer(serverId)).click()
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
      expect(await page.evaluate(() => history.length)).toBe(rootHistoryLength)
    }
  })

  test("639↔640 preserves the header and composer owners without resize requests", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 639, height: 844 })
    await page.goto(`/c/channels/${serverId}/${threadId}`, { waitUntil: "commit" })
    await expect(page.getByTestId(tid.composerInput)).toBeVisible({ timeout: 20_000 })
    await expectServerControl(page, serverId)
    await page.waitForTimeout(200)

    await page.evaluate(({ composerTestId, serverTestId }) => {
      const serverControl = document.querySelector(`[data-testid="${serverTestId}"]`)
      Reflect.set(window, "__headerHierarchyBanner", serverControl?.closest("header[role=banner]"))
      Reflect.set(window, "__headerHierarchyComposer", document.querySelector(`[data-testid="${composerTestId}"]`))
    }, {
      composerTestId: tid.channelComposerShell,
      serverTestId: tid.channelHeaderServer(serverId),
    })
    let communityRequests = 0
    let newSockets = 0
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/community/")) communityRequests += 1
    })
    page.on("websocket", () => { newSockets += 1 })
    const pathname = new URL(page.url()).pathname

    await page.setViewportSize({ width: 640, height: 844 })
    await expect(page.getByTestId(tid.channelHeaderServer(serverId))).toBeHidden()
    await expect(page.getByTestId(tid.channelComposerShell)).toBeVisible()
    expect(await page.evaluate(({ composerTestId, serverTestId }) => ({
      banner: Reflect.get(window, "__headerHierarchyBanner") === document.querySelector(`[data-testid="${serverTestId}"]`)?.closest("header[role=banner]"),
      composer: Reflect.get(window, "__headerHierarchyComposer") === document.querySelector(`[data-testid="${composerTestId}"]`),
    }), {
      composerTestId: tid.channelComposerShell,
      serverTestId: tid.channelHeaderServer(serverId),
    })).toEqual({ banner: true, composer: true })

    await page.setViewportSize({ width: 639, height: 844 })
    await expect(page.getByTestId(tid.channelHeaderServer(serverId))).toBeVisible()
    expect(await page.evaluate(({ composerTestId, serverTestId }) => ({
      banner: Reflect.get(window, "__headerHierarchyBanner") === document.querySelector(`[data-testid="${serverTestId}"]`)?.closest("header[role=banner]"),
      composer: Reflect.get(window, "__headerHierarchyComposer") === document.querySelector(`[data-testid="${composerTestId}"]`),
    }), {
      composerTestId: tid.channelComposerShell,
      serverTestId: tid.channelHeaderServer(serverId),
    })).toEqual({ banner: true, composer: true })
    expect(new URL(page.url()).pathname).toBe(pathname)
    expect(communityRequests).toBe(0)
    expect(newSockets).toBe(0)
  })
})
