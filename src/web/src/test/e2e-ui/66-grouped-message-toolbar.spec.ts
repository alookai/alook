import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { CURRENT_COMMUNITY_FIXTURE_HEADERS, confirmCommunityFixtureApiResponse } from "./_fixtures/business-contract"
import { solidPngFixture } from "../fixtures/media"
import type { Locator } from "@playwright/test"

async function bodyGeometry(message: Locator) {
  return message.evaluate((element) => {
    const row = element.querySelector<HTMLElement>("[data-page-swipe-reply-row]")!
    const body = row.querySelector<HTMLElement>("[data-community-message-body]")!
    const r = row.getBoundingClientRect(), b = body.getBoundingClientRect()
    return { x: b.x - r.x, y: b.y - r.y, width: b.width, height: b.height, rowHeight: r.height }
  })
}

function expectSameBody(actual: Awaited<ReturnType<typeof bodyGeometry>>, before: Awaited<ReturnType<typeof bodyGeometry>>) {
  for (const key of ["x", "y", "width", "height", "rowHeight"] as const) {
    expect(Math.abs(actual[key] - before[key]), key).toBeLessThanOrEqual(1)
  }
}

test("grouped message toolbar stays above text and remains reachable", async ({ caseActors }, testInfo) => {
  const actors = await caseActors(["alice"])
  const serverId = await actors.seed.seedServer("alice", `Toolbar geometry ${Date.now()}`)
  const channelId = await actors.seed.seedChannel("alice", serverId, "toolbar")
  const firstId = await actors.seed.seedMessage("alice", channelId, "First message keeps its existing header toolbar. " + "Ungrouped text must keep the same wrapping in selection. ".repeat(8))
  const body = "Grouped message starts here.\n\n" + "Long text must remain readable while the action toolbar is visible. ".repeat(12)
  const groupedId = await actors.seed.seedMessage("alice", channelId, body)
  await actors.seed.seedReaction("alice", groupedId, "👍")
  const { page } = await actors.asUser("alice", { permissions: ["clipboard-read", "clipboard-write"], reducedMotion: "reduce" })
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const uploadPending = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/attachments`)
  const portraitPending = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`)
  const editable = composerEditable(page)
  await editable.click()
  await editable.pressSequentially("Portrait row geometry")
  await page.getByTestId(tid.composerFileInput).setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: solidPngFixture(396, 702, [91, 110, 225]) })
  await expect(page.getByText("portrait.png", { exact: true })).toBeVisible()
  await expect.poll(() => editable.evaluate(element => document.activeElement === element)).toBe(true)
  await page.keyboard.press("Enter")
  const upload = await confirmCommunityFixtureApiResponse(uploadPending)
  expect(upload.status()).toBe(200)
  const attachment = await upload.json() as { id: string; hasThumbnail: boolean }
  expect(attachment.hasThumbnail).toBe(true)
  const portraitMessage = await confirmCommunityFixtureApiResponse(portraitPending)
  expect(portraitMessage.status()).toBe(201)
  expect(portraitMessage.request().postDataJSON().attachments).toEqual([attachment.id])
  const portraitId = (await portraitMessage.json() as { message: { id: string } }).message.id
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
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.evaluate(() => document.fonts.ready)
    const original = await Promise.all([first, grouped].map(bodyGeometry))
    expect(original[0].width).toBeGreaterThan(100)
    expect(original[1].height).toBeGreaterThan(40)
    await first.hover()
    await page.getByTestId(tid.messageShare(firstId)).click()
    await expect(page.getByRole("button", { name: "Share 1 selected messages as image", exact: true })).toBeEnabled()
    for (const [index, message] of [first, grouped].entries()) {
      await expect(message.locator("[data-message-selection-checkbox]")).toHaveCount(1)
      expectSameBody(await bodyGeometry(message), original[index])
    }
    await first.locator("[data-community-message-body] p").first().click()
    await expect(page.getByRole("button", { name: "Share 0 selected messages as image", exact: true })).toBeDisabled()
    await page.getByRole("button", { name: "Cancel message selection", exact: true }).click()
    for (const [index, message] of [first, grouped].entries()) expectSameBody(await bodyGeometry(message), original[index])

    const text = first.locator("[data-community-message-body] p").first()
    await text.scrollIntoViewIfNeeded()
    const points = await text.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const node = walker.nextNode()!
      const start = document.createRange(), end = document.createRange()
      start.setStart(node, 0); start.setEnd(node, 1)
      end.setStart(node, 19); end.setEnd(node, 20)
      const a = start.getBoundingClientRect(), b = end.getBoundingClientRect()
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2, userSelect: getComputedStyle(element).userSelect }
    })
    expect(points.userSelect).toBe("text")
    await page.mouse.move(points.x1, points.y1)
    await page.mouse.down()
    await page.mouse.move(points.x2, points.y2, { steps: 12 })
    await page.mouse.up()
    const selection = await text.evaluate((element) => {
      const selection = window.getSelection()
      return { length: selection?.toString().length ?? 0, anchor: element.contains(selection?.anchorNode ?? null), focus: element.contains(selection?.focusNode ?? null) }
    })
    expect(selection.length).toBeGreaterThanOrEqual(5)
    expect(selection.anchor).toBe(true)
    expect(selection.focus).toBe(true)
    await page.evaluate(() => window.getSelection()?.removeAllRanges())

    const image = page.getByTestId(tid.messageImage(portraitId, 0))
    await image.scrollIntoViewIfNeeded()
    await expect(image).toHaveAttribute("data-remote-image-state", "ready")
    const portrait = await image.evaluate((image: HTMLImageElement) => {
      const element = image.closest<HTMLElement>("[data-remote-image-frame]")!
      const rect = element.getBoundingClientRect(), parent = element.parentElement!.getBoundingClientRect()
      let opacity = 1
      for (let node: Element | null = image; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
      return { width: rect.width, height: rect.height, parentWidth: parent.width, left: rect.left, right: rect.right, parentLeft: parent.left, parentRight: parent.right, opacity, decoded: image.complete && image.naturalWidth > 0 && image.naturalHeight > 0 }
    })
    const expectedWidth = Math.min(396, portrait.parentWidth, (viewport.width < 640 ? 200 : 240) * 396 / 702)
    expect(portrait.width).toBeCloseTo(expectedWidth, 0)
    expect(portrait.width / portrait.height).toBeCloseTo(396 / 702, 2)
    expect(portrait.height).toBeLessThanOrEqual((viewport.width < 640 ? 200 : 240) + 1)
    expect(portrait.left).toBeGreaterThanOrEqual(portrait.parentLeft - 1)
    expect(portrait.right).toBeLessThanOrEqual(portrait.parentRight + 1)
    expect(portrait.opacity).toBe(1)
    expect(portrait.decoded).toBe(true)
    await testInfo.attach(`message-consequences-${viewport.width}`, { body: JSON.stringify({ original, selection, portrait }), contentType: "application/json" })
  }
  expect(messageWrites).toEqual([])

  const mobile = await actors.asUser("alice", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] })
  mobile.page.on("request", (request) => {
    if (request.method() !== "GET" && /\/api\/community\/channels\/[^/]+\/messages/.test(new URL(request.url()).pathname)) messageWrites.push(request.url())
  })
  await gotoAfterUserWsAuth(mobile.page, `/c/channels/${serverId}/${channelId}`)
  const mobileBody = mobile.page.getByTestId(tid.message(groupedId)).locator("[data-community-message-body]")
  await expect(mobileBody).toBeVisible()
  const mobileRow = mobile.page.getByTestId(tid.message(groupedId))
  await expect(mobileRow.getByRole("button", { name: "More actions", exact: true })).toHaveCount(0)
  const anchor = mobileRow.locator('button[data-slot="dropdown-menu-trigger"][aria-hidden="true"]')
  await expect(anchor).toHaveCount(1)
  await expect(anchor).toHaveAttribute("tabindex", "-1")
  expect(await anchor.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, hit: document.elementFromPoint(element.getBoundingClientRect().x, element.getBoundingClientRect().y) === element })))
    .toEqual({ width: 0, height: 0, hit: false })
  await mobileBody.locator("p").first().tap()
  await expect(mobile.page.getByRole("menuitem", { name: "Copy Text", exact: true })).toBeVisible()
  await testInfo.attach("mobile-touch-menu", { body: await mobile.page.screenshot(), contentType: "image/png" })
  await mobile.page.keyboard.press("Escape")
  const chip = mobile.page.getByTestId(tid.reactionChip(groupedId, "👍"))
  await expect(chip).toBeVisible()
  const group = mobile.page.getByTestId(tid.reactionGroup(groupedId))
  const originalGroup = await group.elementHandle()
  expect(originalGroup).not.toBeNull()
  const reactionHeight = (await bodyGeometry(mobileRow)).rowHeight
  const reactionPath = `/api/community/messages/${groupedId}/reactions/${encodeURIComponent("👍")}`
  const removed = await confirmCommunityFixtureApiResponse(mobile.page.request.delete(reactionPath, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
  expect(removed.status()).toBe(204)
  await expect(chip).toHaveCount(0)
  expect(await originalGroup!.evaluate(element => element.isConnected)).toBe(true)
  await expect.poll(() => mobileRow.evaluate((element) => {
    const row = element.querySelector<HTMLElement>("[data-page-swipe-reply-row]")!
    const body = row.querySelector<HTMLElement>("[data-community-message-body]")!
    return row.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom - parseFloat(getComputedStyle(row).paddingBottom)
  })).toBeLessThanOrEqual(1)
  expect((await bodyGeometry(mobileRow)).rowHeight).toBeLessThan(reactionHeight - 1)
  const restored = await confirmCommunityFixtureApiResponse(mobile.page.request.put(reactionPath, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
  expect(restored.ok()).toBe(true)
  await expect(chip).toBeVisible()
  await expect.poll(async () => Math.abs((await bodyGeometry(mobileRow)).rowHeight - reactionHeight)).toBeLessThanOrEqual(1)
  await originalGroup!.dispose()

  const paragraph = mobileBody.locator("p").last()
  await paragraph.scrollIntoViewIfNeeded()
  const point = await paragraph.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const x = box.x + Math.min(60, box.width / 2), y = box.y + box.height / 2
    return { x, y, owned: element.contains(document.elementFromPoint(x, y)) }
  })
  expect(point.owned).toBe(true)
  await mobile.page.touchscreen.tap(point.x, point.y)
  const menu = mobile.page.getByRole("menu")
  await expect(menu).toBeVisible()
  const menuBox = await menu.boundingBox()
  expect(menuBox).not.toBeNull()
  expect(menuBox!.x).toBeGreaterThanOrEqual(0)
  expect(menuBox!.y).toBeGreaterThanOrEqual(0)
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390)
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(844)
  expect(point.x).toBeGreaterThanOrEqual(menuBox!.x - 1)
  expect(point.x).toBeLessThanOrEqual(menuBox!.x + menuBox!.width + 1)
  expect(Math.min(Math.abs(menuBox!.y - point.y), Math.abs(menuBox!.y + menuBox!.height - point.y))).toBeLessThanOrEqual(8)
  await mobile.page.evaluate(() => navigator.clipboard.writeText("point-menu-sentinel"))
  await menu.getByRole("menuitem", { name: "Copy Text", exact: true }).click()
  await expect.poll(() => mobile.page.evaluate(() => navigator.clipboard.readText())).toBe(body)
  await expect(menu).toBeHidden()
  const linkHref = "https://example.com/second?from=message-menu"
  const linkMessageId = await actors.seed.seedMessage("alice", channelId,
    "First link: https://example.com/first\n\n" + "A long link message keeps its top above the tapped link. ".repeat(24) + `\n\nSecond link: ${linkHref}`)
  await gotoAfterUserWsAuth(mobile.page, `/c/channels/${serverId}/${channelId}`)
  const mobileLink = mobile.page.getByTestId(tid.message(linkMessageId)).getByRole("link", { name: `Link: ${linkHref}`, exact: true })
  await mobileLink.scrollIntoViewIfNeeded()
  const linkPoint = await mobileLink.evaluate((element) => {
    const box = Array.from(element.getClientRects()).find(rect => rect.width > 0 && rect.height > 0)!
    const x = box.right - Math.min(4, box.width / 2), y = box.top + box.height / 2
    return { x, y, width: box.width, height: box.height, owned: element.contains(document.elementFromPoint(x, y)) }
  })
  expect(linkPoint.width).toBeGreaterThan(0)
  expect(linkPoint.height).toBeGreaterThan(0)
  expect(linkPoint.owned).toBe(true)
  const beforeLinkUrl = mobile.page.url()
  const beforeLinkPageCount = mobile.page.context().pages().length
  let linkPopups = 0
  const onLinkPopup = () => { linkPopups += 1 }
  mobile.page.on("popup", onLinkPopup)
  let linkMenuBox: Awaited<ReturnType<Locator["boundingBox"]>> = null
  try {
    await mobile.page.touchscreen.tap(linkPoint.x, linkPoint.y)
    await expect(menu.getByRole("menuitem", { name: "Copy Link", exact: true })).toBeVisible()
    linkMenuBox = await menu.boundingBox()
    expect(linkMenuBox).not.toBeNull()
    expect(linkMenuBox!.x).toBeGreaterThanOrEqual(0)
    expect(linkMenuBox!.y).toBeGreaterThanOrEqual(0)
    expect(linkMenuBox!.x + linkMenuBox!.width).toBeLessThanOrEqual(390)
    expect(linkMenuBox!.y + linkMenuBox!.height).toBeLessThanOrEqual(844)
    expect(linkPoint.x).toBeGreaterThanOrEqual(linkMenuBox!.x - 1)
    expect(linkPoint.x).toBeLessThanOrEqual(linkMenuBox!.x + linkMenuBox!.width + 1)
    expect(Math.min(Math.abs(linkMenuBox!.y - linkPoint.y), Math.abs(linkMenuBox!.y + linkMenuBox!.height - linkPoint.y))).toBeLessThanOrEqual(8)
    await mobile.page.evaluate(() => navigator.clipboard.writeText("link-menu-sentinel"))
    await menu.getByRole("menuitem", { name: "Copy Link", exact: true }).click()
    await expect.poll(() => mobile.page.evaluate(() => navigator.clipboard.readText())).toBe(linkHref)
    expect(mobile.page.url()).toBe(beforeLinkUrl)
    expect(mobile.page.context().pages()).toHaveLength(beforeLinkPageCount)
    expect(linkPopups).toBe(0)
  } finally {
    mobile.page.off("popup", onLinkPopup)
  }
  await testInfo.attach("mobile-link-menu-consequences", { body: JSON.stringify({ linkHref, linkPoint, linkMenuBox, beforeLinkUrl, linkPopups }), contentType: "application/json" })
  expect(messageWrites).toEqual([])
  await testInfo.attach("mobile-message-consequences", { body: JSON.stringify({ reactionHeight, point, menuBox }), contentType: "application/json" })
})
