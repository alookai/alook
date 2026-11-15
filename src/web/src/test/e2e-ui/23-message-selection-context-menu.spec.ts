import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"

import { tid } from "./_fixtures/testids"
import { focusEditorDuringContextMenuExit } from "./_fixtures/context-menu-exit-probe"

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

test("message context menu preserves and copies selected text", async ({ caseActors, caseResources }, testInfo) => {
  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { seedChannel, seedMessage, seedServer } = actors.seed

  const serverId = await seedServer("alice", `Selection Menu ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "selection-menu")
  const body = `copy only this phrase ${Date.now()}`
  const messageId = await seedMessage("alice", channelId, body)
  const { page } = await asUser("alice", { permissions: ["clipboard-read", "clipboard-write"] })

  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const row = page.getByTestId(tid.message(messageId))
  const messageBody = row.locator("[data-community-message-body]")
  await expect(messageBody).toContainText(body)

  await row.hover()
  const contextMenu = page.locator('[data-slot="context-menu-content"]')
  const openContextMenu = page.locator('[data-slot="context-menu-content"][data-open]')
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
    defaultPrevented: true,
    bubbled: true,
  })
  await expect(openContextMenu).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("copy only this phrase")

  await page.keyboard.press("Escape")
  await expect(contextMenu).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("copy only this phrase")
  await page.keyboard.press("Shift+F10")
  await expect(openContextMenu).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(contextMenu).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("copy only this phrase")

  await observeNextContextMenu(page)
  await page.mouse.click(points.outsideSelection.x, points.outsideSelection.y, { button: "right" })
  await expect(openContextMenu).toBeVisible()
  await expect.poll(() => contextMenuProbe(page).then((probe) => probe?.defaultPrevented)).toBe(true)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("copy only this phrase")
  await openContextMenu.getByRole("menuitem", { name: "Copy Text", exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("copy only this phrase")
  await expect(contextMenu).toHaveCount(0)

  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.mouse.click(points.selection.x, points.selection.y, { button: "right" })
  await expect(openContextMenu).toBeVisible()
  await openContextMenu.getByRole("menuitem", { name: "Copy Text", exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(body)
  await expect(contextMenu).toHaveCount(0)

  await page.evaluate(() => navigator.clipboard.writeText("keyboard-copy-sentinel"))
  await trigger.evaluate((element) => {
    element.focus()
  })
  await page.keyboard.press("Shift+F10")
  await expect(openContextMenu).toBeVisible()
  await openContextMenu.getByRole("menuitem", { name: "Copy Text", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(body)
  await expect(contextMenu).toHaveCount(0)
  await expect.poll(() => trigger.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press("Shift+F10")
  await expect(openContextMenu).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(contextMenu).toHaveCount(0)
  await expect.poll(() => trigger.evaluate((element) => element.contains(document.activeElement))).toBe(true)

  await page.mouse.click(points.selection.x, points.selection.y, { button: "right" })
  await expect(openContextMenu).toBeVisible()
  const editor = composerEditable(page)
  const editorBox = await editor.boundingBox()
  if (!editorBox) throw new Error("composer has no visible bounds")
  await page.mouse.click(editorBox.x + editorBox.width / 2, editorBox.y + editorBox.height / 2)
  const naturalAfterClick = await editor.evaluate((element) => {
    const popup = document.querySelector('[data-slot="context-menu-content"]')
    return { popupMounted: popup?.isConnected === true, popupClosing: popup?.hasAttribute("data-closed") === true,
      editorFocused: document.activeElement === element }
  })
  await expect(contextMenu).toHaveCount(0)

  const activeFocusDuringExits = []
  for (const holdMs of [0, 150]) {
    await page.mouse.click(points.selection.x, points.selection.y, { button: "right" })
    await expect(openContextMenu).toBeVisible()
    const activeExit = await focusEditorDuringContextMenuExit(page, editor)
    const ownedExit = caseResources.own(activeExit, probe => probe.dispose())
    const activeEditorBox = await editor.boundingBox()
    if (!activeEditorBox) throw new Error("composer has no visible bounds")
    const x = activeEditorBox.x + activeEditorBox.width / 2
    const y = activeEditorBox.y + activeEditorBox.height / 2
    if (holdMs) {
      await page.mouse.move(x, y)
      await page.mouse.down()
      try {
        await new Promise(resolve => setTimeout(resolve, holdMs))
      } finally {
        await page.mouse.up()
      }
    } else {
      await page.mouse.click(x, y)
    }
    await expect(contextMenu).toHaveCount(0)
    const sample = await activeExit.read()
    expect(sample).toEqual({ popupMountedAtAction: true, popupClosingAtAction: true, editorFocusedAfterAction: true })
    await expect(editor).toBeFocused()
    await ownedExit.close()
    activeFocusDuringExits.push({ holdMs, sample })
  }
  await testInfo.attach("context-menu-exit-focus.json", { body: JSON.stringify({ naturalAfterClick, activeFocusDuringExits,
    phaseRecordReadAfterUnmount: true, input: "native outside click without focus intervention; separate active focus at actual data-closed transition after outside pointerdown, including a 150ms held press" }), contentType: "application/json" })
})
