import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"

test("grouped message toolbar stays above text and remains reachable", async ({ caseActors }, testInfo) => {
  const actors = await caseActors(["alice"])
  const serverId = await actors.seed.seedServer("alice", `Toolbar geometry ${Date.now()}`)
  const channelId = await actors.seed.seedChannel("alice", serverId, "toolbar")
  const firstId = await actors.seed.seedMessage("alice", channelId, "First message keeps its existing header toolbar.")
  const body = "Grouped message starts here.\n\n" + "Long text must remain readable while the action toolbar is visible. ".repeat(12)
  const groupedId = await actors.seed.seedMessage("alice", channelId, body)
  const { page } = await actors.asUser("alice", { permissions: ["clipboard-read", "clipboard-write"], reducedMotion: "reduce" })
  const messageWrites: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "GET" && /\/api\/community\/channels\/[^/]+\/messages/.test(new URL(request.url()).pathname)) messageWrites.push(request.url())
  })
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const first = page.getByTestId(tid.message(firstId))
  const grouped = page.getByTestId(tid.message(groupedId))
  await expect(grouped.locator("[data-community-message-body]")).toContainText("Grouped message starts here.")
  await expect(first.getByRole("button", { name: actors.userName("alice"), exact: true })).toHaveCount(1)
  await expect(grouped.getByRole("button", { name: actors.userName("alice"), exact: true })).toHaveCount(0)

  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { localStorage.setItem("theme", value) }, theme)
    await page.reload({ waitUntil: "commit" })
    await expect(grouped.locator("[data-community-message-body]")).toBeVisible()
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()
    await grouped.hover()
    const more = grouped.getByRole("button", { name: "More actions", exact: true })
    const toolbar = more.locator("..")
    await expect(toolbar).toHaveCSS("opacity", "1")
    const bounds = await grouped.evaluate((row) => {
      const body = row.querySelector("[data-community-message-body]")!
      const button = row.querySelector('[aria-label="More actions"]')!
      const toolbar = button.parentElement!
      const r = toolbar.getBoundingClientRect(), b = body.getBoundingClientRect()
      return { toolbarBottom: r.bottom, toolbarTop: r.top, bodyTop: b.top, bodyHeight: b.height }
    })
    await testInfo.attach(`grouped-${theme}-geometry`, { body: JSON.stringify(bounds), contentType: "application/json" })
    expect(bounds.bodyHeight).toBeGreaterThan(40)
    expect(bounds.toolbarBottom).toBeLessThanOrEqual(bounds.bodyTop + 1)
    await testInfo.attach(`grouped-${theme}`, { body: await page.screenshot(), contentType: "image/png" })
    const button = await more.boundingBox()
    if (!button) throw new Error("More actions has no geometry")
    await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2, { steps: 12 })
    await expect(toolbar).toHaveCSS("opacity", "1")
    await more.click()
    const copy = page.getByRole("menuitem", { name: "Copy Text", exact: true })
    await expect(copy).toBeVisible()
    await page.evaluate(() => navigator.clipboard.writeText("toolbar-copy-sentinel"))
    await copy.click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(body)

    await first.hover()
    const firstMore = first.getByRole("button", { name: "More actions", exact: true })
    await expect(firstMore.locator("..")).toHaveCSS("opacity", "1")
    const firstBounds = await first.evaluate((row) => {
      const trigger = row.querySelector('[data-slot="context-menu-trigger"]')!
      const toolbar = row.querySelector('[aria-label="More actions"]')!.parentElement!
      return { rowTop: trigger.getBoundingClientRect().top, toolbarTop: toolbar.getBoundingClientRect().top }
    })
    expect(firstBounds.toolbarTop - firstBounds.rowTop).toBeCloseTo(-8, 0)
  }
  expect(messageWrites).toEqual([])

  const mobile = await actors.asUser("alice", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" })
  await gotoAfterUserWsAuth(mobile.page, `/c/channels/${serverId}/${channelId}`)
  const mobileBody = mobile.page.getByTestId(tid.message(groupedId)).locator("[data-community-message-body]")
  await expect(mobileBody).toBeVisible()
  await mobileBody.locator("p").first().tap()
  await expect(mobile.page.getByRole("menuitem", { name: "Copy Text", exact: true })).toBeVisible()
  await testInfo.attach("mobile-touch-menu", { body: await mobile.page.screenshot(), contentType: "image/png" })
  await mobile.page.keyboard.press("Escape")

})
