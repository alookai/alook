import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"

const WIDE_TABLE = [
  `| ${Array.from({ length: 8 }, (_, column) => `Column_${column}_long_unbroken_heading`).join(" | ")} |`,
  `| ${Array.from({ length: 8 }, () => "---").join(" | ")} |`,
  ...Array.from({ length: 30 }, (_, row) => `| ${Array.from({ length: 8 }, (_, column) => (
    row === 0 && column === 0 ? "FIRST_TABLE" : row === 29 && column === 7 ? "LAST_TABLE" : `${row}-${column}`
  )).join(" | ")} |`),
].join("\n")
const FIT_TABLE = "| Name | Value |\n| --- | --- |\n| Small | Fits |"

async function cellGeometry(cell: Locator) {
  return cell.evaluate((element) => {
    const table = element.closest("table")
    const owner = table?.parentElement
    if (!table || !owner) throw new Error("Table scroll owner is missing")
    const rect = element.getBoundingClientRect()
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight
    for (let ancestor: HTMLElement | null = owner; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      const box = ancestor.getBoundingClientRect()
      if (style.overflowX !== "visible") {
        left = Math.max(left, box.left + ancestor.clientLeft)
        right = Math.min(right, box.left + ancestor.clientLeft + ancestor.clientWidth)
      }
      if (style.overflowY !== "visible") {
        top = Math.max(top, box.top + ancestor.clientTop)
        bottom = Math.min(bottom, box.top + ancestor.clientTop + ancestor.clientHeight)
      }
    }
    return {
      cell: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      clip: { left, right, top, bottom },
      scrollLeft: owner.scrollLeft, scrollTop: owner.scrollTop,
      maxLeft: owner.scrollWidth - owner.clientWidth, maxTop: owner.scrollHeight - owner.clientHeight,
      visible: rect.width > 0 && rect.height > 0 && rect.left >= left - 1 && rect.right <= right + 1
        && rect.top >= top - 1 && rect.bottom <= bottom + 1,
    }
  })
}

async function wheelToEnd(page: Page, table: Locator, trailing: boolean) {
  const owner = table.locator("..")
  await owner.hover()
  await page.mouse.wheel(trailing ? 100_000 : -100_000, trailing ? 100_000 : -100_000)
  const cell = table.getByRole("cell", { name: trailing ? "LAST_TABLE" : "FIRST_TABLE", exact: true })
  await expect.poll(async () => {
    const geometry = await cellGeometry(cell)
    return geometry.visible && (trailing
      ? Math.abs(geometry.scrollLeft - geometry.maxLeft) <= 1 && Math.abs(geometry.scrollTop - geometry.maxTop) <= 1
      : geometry.scrollLeft === 0 && geometry.scrollTop === 0)
  }).toBe(true)
  return cellGeometry(cell)
}

for (const viewport of [{ width: 390, height: 844 }, { width: 834, height: 1112 }, { width: 1280, height: 900 }]) {
  test(`table fullscreen keeps both scroll ends reachable at ${viewport.width}px`, async ({ caseActors }, testInfo) => {
    test.setTimeout(120_000)
    const actors = await caseActors(["alice"])
    const serverId = await actors.seed.seedServer("alice", `Table scroll ${Date.now()}`)
    const channelId = await actors.seed.seedChannel("alice", serverId, "table-scroll")
    const wideId = await actors.seed.seedMessage("alice", channelId, WIDE_TABLE)
    const fitId = await actors.seed.seedMessage("alice", channelId, FIT_TABLE)
    const { page } = await actors.asUser("alice", {
      viewport, hasTouch: viewport.width < 1280, isMobile: viewport.width === 390, reducedMotion: "reduce",
    })
    const messageWrites: string[] = []
    page.on("request", (request) => {
      if (request.method() !== "GET" && /\/api\/community\/(?:channels\/[^/]+\/messages|messages\/[^/]+)$/.test(new URL(request.url()).pathname)) {
        messageWrites.push(`${request.method()} ${new URL(request.url()).pathname}`)
      }
    })
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
    const wideMessage = page.getByTestId(tid.message(wideId))
    const inline = wideMessage.locator('[data-streamdown="table"]')
    await expect(inline).toHaveCount(1)
    const inlineLeading = await wheelToEnd(page, inline, false)
    const inlineTrailing = await wheelToEnd(page, inline, true)
    await wideMessage.getByRole("button", { name: "View fullscreen", exact: true }).click()
    const fullscreen = page.locator('[data-streamdown="table-fullscreen"]')
    await expect(fullscreen).toHaveCount(1)
    const table = fullscreen.locator('[data-streamdown="table"]')
    const leading = await wheelToEnd(page, table, false)
    expect(leading.maxLeft).toBeGreaterThan(0)
    if (viewport.height < 1000) expect(leading.maxTop).toBeGreaterThan(0)
    const trailing = await wheelToEnd(page, table, true)
    const returned = await wheelToEnd(page, table, false)
    await testInfo.attach("table-scroll-geometry", {
      body: JSON.stringify({ viewport, input: "mouse click and wheel", inlineLeading, inlineTrailing, leading, trailing, returned,
        media: await page.evaluate(() => ({ coarse: matchMedia("(pointer: coarse)").matches, hover: matchMedia("(hover: hover)").matches })) }),
      contentType: "application/json",
    })
    await fullscreen.getByRole("button", { name: "Exit fullscreen", exact: true }).click()
    await expect(fullscreen).toHaveCount(0)
    await expect(inline.getByRole("cell", { name: "LAST_TABLE", exact: true })).toHaveCount(1)
    expect(await wideMessage.locator("[data-community-message-body]").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    const fitMessage = page.getByTestId(tid.message(fitId))
    await fitMessage.hover()
    await fitMessage.getByRole("button", { name: "View fullscreen", exact: true }).click()
    const fitTable = fullscreen.locator('[data-streamdown="table"]')
    await expect(fitTable).toBeVisible()
    const fit = await fitTable.evaluate((element) => {
      const table = element.getBoundingClientRect()
      const owner = element.parentElement!.getBoundingClientRect()
      return { top: table.top, bottom: table.bottom, left: table.left, right: table.right,
        ownerTop: owner.top, ownerBottom: owner.bottom, ownerLeft: owner.left, ownerRight: owner.right }
    })
    expect(Math.abs((fit.top + fit.bottom) - (fit.ownerTop + fit.ownerBottom))).toBeLessThanOrEqual(2)
    expect(fit.left).toBeGreaterThanOrEqual(fit.ownerLeft - 1)
    expect(fit.right).toBeLessThanOrEqual(fit.ownerRight + 1)
    await testInfo.attach("fitting-table-geometry", { body: JSON.stringify(fit), contentType: "application/json" })
    await fullscreen.getByRole("button", { name: "Exit fullscreen", exact: true }).click()
    await expect(fullscreen).toHaveCount(0)
    await expect(fitMessage.getByRole("cell", { name: "Fits", exact: true })).toBeVisible()
    expect(messageWrites).toEqual([])
  })
}
