import type { Page, Request } from "@playwright/test"
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

async function expectMobileBack(page: Page) {
  const control = page.getByRole("banner").getByRole("button", { name: "Back" })
  await expect(control).toBeVisible()
  const controlBox = await control.boundingBox()
  expect(controlBox).toMatchObject({ width: 44, height: 44 })
  return control
}

function observeColdBootServerReconciliation(page: Page, serverId: string) {
  const readStatePath = "/api/community/users/me/read-state"
  const expectedPaths = new Set([
    `/api/community/servers/${serverId}/categories`,
    `/api/community/servers/${serverId}/channels`,
    `/api/community/servers/${serverId}/unreads`,
  ])
  const reconciliationPaths = new Set(["/api/community/servers", ...expectedPaths])
  const observedPaths = new Set<string>()
  const pending = new Set<Request>()
  let readStateSettled = false

  const onRequest = (request: Request) => {
    const pathname = new URL(request.url()).pathname
    if (!readStateSettled || !reconciliationPaths.has(pathname)) return
    if (expectedPaths.has(pathname)) observedPaths.add(pathname)
    pending.add(request)
  }
  const onSettled = (request: Request) => {
    if (new URL(request.url()).pathname === readStatePath) readStateSettled = true
    pending.delete(request)
  }
  page.on("request", onRequest)
  page.on("requestfinished", onSettled)
  page.on("requestfailed", onSettled)

  return {
    done: () => observedPaths.size === expectedPaths.size && pending.size === 0,
    dispose: () => {
      page.off("request", onRequest)
      page.off("requestfinished", onSettled)
      page.off("requestfailed", onSettled)
    },
  }
}

test.describe.serial("mobile server header direct hierarchy", () => {
  let serverId: string
  let textId: string
  let forumId: string
  let threadId: string
  let postId: string
  let threadName: string
  let postTitle: string

  test.beforeAll(async () => {
    const stamp = Date.now()
    serverId = await seedServer("alice", `header-hierarchy-${stamp}`)
    textId = await seedChannel("alice", serverId, `text-${stamp}`)
    forumId = await seedChannel("alice", serverId, `forum-${stamp}`, "forum")
    const openerId = await seedMessage("alice", textId, `thread opener ${stamp}`)
    threadName = `thread-${stamp}`
    postTitle = `post-${stamp}`
    threadId = await seedThread("alice", openerId, threadName)
    postId = await seedForumThread("alice", forumId, postTitle, "post body")
  })

  test("top-level text and forum replace directly to the canonical server root", async ({ asUser }) => {
    const { page } = await asUser("alice")
    for (const channelId of [textId, forumId]) {
      await page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
      const control = await expectMobileBack(page)
      const historyLength = await page.evaluate(() => history.length)
      await control.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
      expect(await page.evaluate(() => history.length)).toBe(historyLength)
    }
  })

  test("thread and forum post expose direct parent Back and inert current labels", async ({ asUser }) => {
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

  test("639↔640 preserves the header and composer owners without resize requests", async ({ asUser }) => {
    const { page } = await asUser("alice")
    const coldBootReconciliation = observeColdBootServerReconciliation(page, serverId)
    await page.setViewportSize({ width: 639, height: 844 })
    await page.goto(`/c/channels/${serverId}/${threadId}`, { waitUntil: "commit" })
    await expect(page.getByTestId(tid.composerInput)).toBeVisible({ timeout: 20_000 })
    await expectMobileBack(page)
    await expect.poll(coldBootReconciliation.done, {
      message: "cold-boot read-state server reconciliation to settle",
      timeout: 10_000,
    }).toBe(true)
    coldBootReconciliation.dispose()

    await page.evaluate(({ composerTestId }) => {
      const backControl = document.querySelector('button[aria-label="Back"]')
      Reflect.set(window, "__headerHierarchyBanner", backControl?.closest("header[role=banner]"))
      Reflect.set(window, "__headerHierarchyComposer", document.querySelector(`[data-testid="${composerTestId}"]`))
    }, {
      composerTestId: tid.channelComposerShell,
    })
    let communityRequests = 0
    let newSockets = 0
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/community/")) communityRequests += 1
    })
    page.on("websocket", () => { newSockets += 1 })
    const pathname = new URL(page.url()).pathname

    await page.setViewportSize({ width: 640, height: 844 })
    await expect(page.getByRole("button", { name: "Back" })).toBeHidden()
    await expect(page.getByTestId(tid.channelComposerShell)).toBeVisible()
    expect(await page.evaluate(({ composerTestId }) => ({
      banner: Reflect.get(window, "__headerHierarchyBanner") === document.querySelector('button[aria-label="Back"]')?.closest("header[role=banner]"),
      composer: Reflect.get(window, "__headerHierarchyComposer") === document.querySelector(`[data-testid="${composerTestId}"]`),
    }), {
      composerTestId: tid.channelComposerShell,
    })).toEqual({ banner: true, composer: true })

    await page.setViewportSize({ width: 639, height: 844 })
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible()
    expect(await page.evaluate(({ composerTestId }) => ({
      banner: Reflect.get(window, "__headerHierarchyBanner") === document.querySelector('button[aria-label="Back"]')?.closest("header[role=banner]"),
      composer: Reflect.get(window, "__headerHierarchyComposer") === document.querySelector(`[data-testid="${composerTestId}"]`),
    }), {
      composerTestId: tid.channelComposerShell,
    })).toEqual({ banner: true, composer: true })
    expect(new URL(page.url()).pathname).toBe(pathname)
    expect(communityRequests).toBe(0)
    expect(newSockets).toBe(0)
  })
})
