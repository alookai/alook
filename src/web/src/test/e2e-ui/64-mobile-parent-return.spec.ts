import type { Page, Request, Route } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import type { CaseResources } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"

async function holdReturnDocumentRoutes(page: Page, pathnames: string[], resources: CaseResources) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const pattern = (url: URL) => pathnames.includes(url.pathname)
  let held = 0
  const pending = new Set<Request>()
  const continuations: Promise<void>[] = []
  const settled = (request: Request) => { pending.delete(request) }
  page.on("requestfinished", settled)
  page.on("requestfailed", settled)
  const handler = (route: Route) => {
    held += 1
    const request = route.request()
    pending.add(request)
    const continuation = (async () => {
      await gate
      if (pending.has(request)) await route.continue()
    })()
    continuations.push(continuation)
    return continuation
  }
  await page.route(pattern, handler)
  let finishing: Promise<void> | undefined
  const finish = () => finishing ??= (async () => {
    release()
    await Promise.all(continuations)
    await page.unroute(pattern, handler)
    await expect.poll(() => pending.size).toBe(0)
    page.off("requestfinished", settled)
    page.off("requestfailed", settled)
  })()
  resources.own(finish, async cleanup => cleanup())
  return { held: () => held, release: finish }
}

for (const parentType of ["forum", "text"] as const) {
  for (const input of ["button", "system"] as const) {
    test(`mobile ${parentType} parent accepts consecutive ${input} Back without framework route reads`, async ({ caseActors, caseResources }, testInfo) => {
      const actors = await caseActors(["alice"])
      const { seedServer, seedChannel, seedMessage, seedThread, seedForumThread } = actors.seed
      const serverId = await seedServer("alice", `Parent return ${parentType} ${input}`)
      const parentId = await seedChannel("alice", serverId, "return-parent", parentType)
      const childId = parentType === "forum"
        ? await seedForumThread("alice", parentId, "Return child", "Child reply")
        : await seedThread("alice", await seedMessage("alice", parentId, "Thread opener"), "Return child")
      const rootPath = `/c/channels/${serverId}`
      const childPath = `${rootPath}/${childId}`
      const parentPath = `${rootPath}/${parentId}`
      const { page } = await actors.asUser("alice")
      await page.setViewportSize({ width: 390, height: 844 })
      await page.emulateMedia({ reducedMotion: "reduce" })

      if (parentType === "forum" && input === "button") {
        await page.goto(rootPath, { waitUntil: "commit" })
        await page.getByTestId(tid.forumSidebarThread(childId)).click()
      } else await page.goto(childPath, { waitUntil: "commit" })

      const foreground = page.locator('[data-mobile-page-active="true"]')
      const back = foreground.getByRole("banner").getByRole("button", { name: "Back", exact: true })
      await expect(back).toBeVisible()
      const [childResponse, parentResponse] = await Promise.all([
        page.request.get(new URL(`/api/community/channels/${childId}`, page.url()).href),
        page.request.get(new URL(`/api/community/channels/${parentId}`, page.url()).href),
      ])
      expect(childResponse.status()).toBe(200)
      expect(parentResponse.status()).toBe(200)
      const channel = await childResponse.json() as {
        id: string; serverId: string; parentChannelId: string
      }
      const parent = await parentResponse.json() as { id: string; type: string }
      expect(channel).toMatchObject({ id: childId, serverId, parentChannelId: parentId })
      expect(parent).toMatchObject({ id: parentId, type: parentType })

      const parentRoute = await holdReturnDocumentRoutes(page, [parentPath, rootPath], caseResources)
      await back.click({ noWaitAfter: true })
      await expect(foreground.locator(`[data-community-target-href="${parentPath}"]`)).toBeVisible()
      expect(new URL(page.url()).pathname).toBe(parentPath)

      if (input === "button") await back.click({ noWaitAfter: true })
      else await page.evaluate(() => window.dispatchEvent(new Event("alook:native-back", { cancelable: true })))

      const parentRow = page.getByTestId(tid.channelRow(parentId))
      await expect(parentRow).toBeVisible()
      await expect(page.locator(`[data-mobile-page-active="true"] [data-community-target-href="${childPath}"]`)).toBeHidden()
      const screenshot = testInfo.outputPath("list-before-parent-release.png")
      await page.screenshot({ path: screenshot })
      await testInfo.attach("list-before-parent-release", { path: screenshot, contentType: "image/png" })
      expect(parentRoute.held()).toBe(0)
      await parentRoute.release()
      await expect.poll(() => new URL(page.url()).pathname).toBe(rootPath)
      await expect(parentRow).toBeVisible()
      await expect(foreground).toBeHidden()
      await testInfo.attach("parent-return-result", {
        body: JSON.stringify({ parentType, input, metadataStatuses: [childResponse.status(), parentResponse.status()], heldParentRequests: parentRoute.held(), finalPath: rootPath,
          channel: { id: channel.id, serverId: channel.serverId, parentChannelId: channel.parentChannelId }, parent: { id: parent.id, type: parent.type } }),
        contentType: "application/json",
      })
    })
  }
}
