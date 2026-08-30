import { test, expect } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { seedChannel, seedMessage, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

async function observeNextContextMenu(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const state = window as typeof window & {
      __contextMenuProbe?: { defaultPrevented: boolean | null; bubbled: boolean }
    }
    state.__contextMenuProbe = { defaultPrevented: null, bubbled: false }
    document.addEventListener("contextmenu", (event) => {
      setTimeout(() => {
        if (state.__contextMenuProbe) {
          state.__contextMenuProbe.defaultPrevented = event.defaultPrevented
        }
      })
    }, { capture: true, once: true })
    document.addEventListener("contextmenu", () => {
      if (state.__contextMenuProbe) state.__contextMenuProbe.bubbled = true
    }, { once: true })
  })
}

async function contextMenuProbe(page: import("@playwright/test").Page) {
  return page.evaluate(() => (
    window as typeof window & {
      __contextMenuProbe?: { defaultPrevented: boolean | null; bubbled: boolean }
    }
  ).__contextMenuProbe)
}

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
  const trigger = row.locator('[data-slot="context-menu-trigger"]')
  await expect(trigger).toHaveCount(1)

  const points = await messageBody.evaluate((element) => {
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
    const bodyRect = element.getBoundingClientRect()
    return {
      selection: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      outsideSelection: {
        x: Math.min(bodyRect.right - 2, rect.right + Math.max(4, (bodyRect.right - rect.right) / 2)),
        y: rect.top + rect.height / 2,
      },
    }
  })
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("copy only this phrase")

  await observeNextContextMenu(page)
  await page.mouse.click(points.selection.x, points.selection.y, { button: "right" })

  await expect.poll(() => contextMenuProbe(page)).toEqual({
    defaultPrevented: false,
    bubbled: true,
  })
  await expect(page.locator('[data-slot="context-menu-content"]')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("copy only this phrase")

  await observeNextContextMenu(page)
  await page.mouse.click(points.outsideSelection.x, points.outsideSelection.y, { button: "right" })
  const openContextMenu = page.locator('[data-slot="context-menu-content"][data-open]')
  await expect(openContextMenu).toBeVisible()
  await expect.poll(() => contextMenuProbe(page).then((probe) => probe?.defaultPrevented)).toBe(true)
  await page.keyboard.press("Escape")
  await expect(openContextMenu).toHaveCount(0)
  await page.waitForTimeout(150)

  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await trigger.evaluate((element) => {
    element.setAttribute("tabindex", "0")
    element.focus()
  })
  await page.keyboard.press("Shift+F10")
  await expect(openContextMenu).toBeVisible()
})
