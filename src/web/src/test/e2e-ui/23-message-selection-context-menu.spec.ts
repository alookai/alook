import { test, expect } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { seedChannel, seedMessage, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

test("selected message text keeps the native context menu", async ({ asUser }) => {
  const serverId = await seedServer("alice", `Selection Menu ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "selection-menu")
  const body = `copy only this phrase ${Date.now()}`
  const messageId = await seedMessage("alice", channelId, body)
  const { page } = await asUser("alice")

  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const row = page.getByTestId(tid.message(messageId))
  const messageBody = row.locator("[data-community-message-body]")
  await expect(messageBody).toContainText(body)

  // Message action overlays (including Base UI's context-menu trigger) mount
  // lazily after hover. Reproduce the real pointer path before selecting text.
  await row.hover()
  await expect(row.locator('[data-slot="context-menu-trigger"]')).toHaveCount(1)

  const selectionPoint = await messageBody.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const textNode = walker.nextNode()
    if (!textNode) throw new Error("message body has no text node")
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, "copy only this phrase".length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const rect = range.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("copy only this phrase")

  await page.evaluate(() => {
    const state = window as typeof window & { __contextMenuDefaultPrevented?: boolean }
    delete state.__contextMenuDefaultPrevented
    document.addEventListener("contextmenu", (event) => {
      setTimeout(() => {
        state.__contextMenuDefaultPrevented = event.defaultPrevented
      })
    }, { capture: true, once: true })
  })
  await page.mouse.click(selectionPoint.x, selectionPoint.y, { button: "right" })

  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __contextMenuDefaultPrevented?: boolean }
  ).__contextMenuDefaultPrevented)).toBe(false)
  await expect(page.locator('[data-slot="context-menu-content"]')).toHaveCount(0)

  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await messageBody.click({ button: "right" })
  await expect(page.locator('[data-slot="context-menu-content"]')).toBeVisible()
})
