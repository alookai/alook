import type { Locator, Page } from "@playwright/test"
import { expect, test, userId } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import {
  seedChannel,
  seedDm,
  seedDmMessage,
  seedJoinServer,
  seedMessage,
  seedReaction,
  seedServer,
  seedThread,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

const HOVER_QUERY = "(hover: hover) and (pointer: fine)"
const OVERFLOW_EMOJIS = ["👍", "🔥", "🎉", "✅", "🚀", "👀", "❤️", "😂", "🤔"] as const

async function installInputCapability(page: Page, hoverCapable: boolean) {
  await page.addInitScript(({ query, matches }) => {
    const nativeMatchMedia = window.matchMedia.bind(window)
    window.matchMedia = (candidate: string) => candidate === query
      ? {
          matches,
          media: candidate,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        } as MediaQueryList
      : nativeMatchMedia(candidate)
  }, { query: HOVER_QUERY, matches: hoverCapable })
}

async function holdReaction(page: Page, chip: Locator, pointerId = 41) {
  const box = await chip.boundingBox()
  if (!box) throw new Error("reaction chip has no box")
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const pointer = { pointerType: "touch", pointerId, isPrimary: true, button: 0 }
  await chip.dispatchEvent("pointerdown", { ...pointer, clientX: point.x, clientY: point.y })
  await page.waitForTimeout(500)
  await chip.dispatchEvent("pointerup", { ...pointer, clientX: point.x, clientY: point.y })
  await chip.dispatchEvent("click", point)
}

async function expectDialogInsideViewport(page: Page, messageId: string) {
  const dialog = page.getByTestId(tid.reactionDialog(messageId))
  await expect(dialog).toBeVisible()
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: window.innerWidth,
      height: window.innerHeight,
    }
  })
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.top).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.width)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height)
}

test.describe.serial("mobile reaction details", () => {
  let serverId: string
  let channelId: string
  let messageId: string
  let messageContent: string
  let emptyMessageId: string
  let threadId: string
  let threadOpenerId: string
  let dmId: string
  let dmMessageId: string

  test.beforeAll(async () => {
    const stamp = Date.now()
    serverId = await seedServer("alice", `Reaction details ${stamp}`)
    channelId = await seedChannel("alice", serverId, `reactions-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    await seedJoinServer("alice", "carol", serverId)
    messageContent = `Hold a reaction ${stamp} — ${"long message preview ".repeat(8).trim()}`
    messageId = await seedMessage("alice", channelId, messageContent)
    await seedReaction("alice", messageId, "👍")
    await seedReaction("bob", messageId, "👍")
    await seedReaction("bob", messageId, "🔥")
    await seedReaction("carol", messageId, "🎉")
    for (const emoji of OVERFLOW_EMOJIS.slice(3)) await seedReaction("alice", messageId, emoji)
    emptyMessageId = await seedMessage("alice", channelId, `Empty reactions ${stamp}`)
    await seedReaction("alice", emptyMessageId, "✅")
    threadOpenerId = await seedMessage("alice", channelId, `Thread opener reactions ${stamp}`)
    await seedReaction("bob", threadOpenerId, "👍")
    threadId = await seedThread("alice", threadOpenerId, `Reaction thread ${stamp}`)
    dmId = await seedDm("alice", userId("bob"))
    dmMessageId = await seedDmMessage("alice", dmId, `DM reactions ${stamp}`)
    await seedReaction("bob", dmMessageId, "👍")
  })

  test("hold opens one authorized batch dialog while tap keeps the canonical toggle", async ({ asUser }, testInfo) => {
    const alice = await asUser("alice")
    await alice.page.setViewportSize({ width: 390, height: 844 })
    await alice.page.emulateMedia({ colorScheme: "light" })
    await installInputCapability(alice.page, false)
    const detailsPath = `/api/community/messages/${messageId}/reactions`
    const mutationPath = `/api/community/messages/${messageId}/reactions/${encodeURIComponent("👍")}`
    const detailsRequests: string[] = []
    const mutationRequests: string[] = []
    alice.page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname
      if (request.method() === "GET" && pathname === detailsPath) detailsRequests.push(pathname)
      if (request.method() !== "GET" && pathname === mutationPath) mutationRequests.push(request.method())
    })
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    const fire = alice.page.getByTestId(tid.reactionChip(messageId, "🔥"))
    await expect(fire).toBeVisible()
    await holdReaction(alice.page, fire)
    await expectDialogInsideViewport(alice.page, messageId)
    const dialog = alice.page.getByTestId(tid.reactionDialog(messageId))
    await expect(dialog.locator('[data-slot="dialog-title"]')).toContainText("e2e-alice-")
    await expect(dialog.locator('[data-slot="dialog-description"]')).toHaveText(messageContent)
    await expect(dialog.locator('[data-slot="dialog-description"]')).toHaveCSS("white-space", "nowrap")
    await expect(dialog.locator('[data-slot="dialog-description"]')).toHaveCSS("text-overflow", "ellipsis")
    await expect.poll(() => dialog.locator('[data-slot="dialog-description"]').evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    )).toBe(true)
    await expect(alice.page.getByTestId(tid.reactionTab("🔥"))).toHaveAttribute("data-active", "")
    await expect(alice.page.getByTestId(tid.reactionMember(userId("bob")))).toBeVisible()
    await testInfo.attach("390-mobile-reaction-details.png", {
      body: await alice.page.screenshot(),
      contentType: "image/png",
    })
    await alice.page.emulateMedia({ colorScheme: "dark" })
    await expect(alice.page.locator("html")).toHaveClass(/dark/)
    await testInfo.attach("390-mobile-reaction-details-dark.png", {
      body: await alice.page.screenshot(),
      contentType: "image/png",
    })
    await alice.page.emulateMedia({ colorScheme: "light" })
    expect(detailsRequests).toHaveLength(1)
    expect(mutationRequests).toHaveLength(0)
    await alice.page.getByRole("button", { name: "Close" }).click()
    await expect(fire).toBeFocused()

    const thumb = alice.page.getByTestId(tid.reactionChip(messageId, "👍"))
    const toggleResponse = alice.page.waitForResponse((response) => (
      new URL(response.url()).pathname === mutationPath
      && response.request().method() === "DELETE"
    ))
    await thumb.click()
    expect((await toggleResponse).status()).toBe(204)
    expect(mutationRequests).toEqual(["DELETE"])

    await holdReaction(alice.page, fire, 42)
    await expectDialogInsideViewport(alice.page, messageId)
    expect(detailsRequests).toHaveLength(1)
  })

  test("coarse input follows the 320, 639, 640, and 1280 cross-capability geometry", async ({ asUser }) => {
    for (const width of [320, 639, 640, 1280]) {
      const session = await asUser("alice")
      await session.page.setViewportSize({ width, height: width === 320 ? 568 : 844 })
      await installInputCapability(session.page, false)
      await gotoAfterUserWsAuth(session.page, `/c/channels/${serverId}/${channelId}`)
      const chip = session.page.getByTestId(tid.reactionChip(messageId, "👍"))
      await holdReaction(session.page, chip, 50 + width)
      await expectDialogInsideViewport(session.page, messageId)
      const tabs = session.page.getByTestId(tid.reactionDialog(messageId)).getByRole("tab")
      await expect.poll(async () => Math.min(...await tabs.evaluateAll(
        (items) => items.map((item) => item.getBoundingClientRect().height),
      ))).toBeGreaterThanOrEqual(44)
      await session.context.close()
    }
  })

  test("the emoji rail switches displayed reactors without mutating reactions", async ({ asUser }, testInfo) => {
    const alice = await asUser("alice")
    await alice.page.setViewportSize({ width: 320, height: 568 })
    await alice.page.emulateMedia({ colorScheme: "light" })
    await installInputCapability(alice.page, false)
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    await holdReaction(alice.page, alice.page.getByTestId(tid.reactionChip(messageId, OVERFLOW_EMOJIS[0])))
    await expectDialogInsideViewport(alice.page, messageId)

    const rail = alice.page.getByTestId(tid.reactionScroller(messageId))
    const panel = alice.page.getByRole("tabpanel")
    const dialogMutations: string[] = []
    alice.page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname
      if (request.method() !== "GET" && pathname.includes(`/api/community/messages/${messageId}/reactions/`)) {
        dialogMutations.push(`${request.method()} ${pathname}`)
      }
    })
    await expect(rail).toHaveRole("tablist")
    await expect(rail).toHaveAttribute("aria-label", "Reaction types")
    await expect(panel).toHaveAttribute("aria-labelledby", tid.reactionTab(OVERFLOW_EMOJIS[0]))
    const initial = await rail.evaluate((element) => {
      const style = getComputedStyle(element)
      element.scrollLeft = 0
      element.dispatchEvent(new Event("scroll"))
      return {
        backgroundColor: style.backgroundColor,
        flexWrap: style.flexWrap,
        overflowX: style.overflowX,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }
    })
    expect(initial.backgroundColor).toBe("rgba(0, 0, 0, 0)")
    expect(initial.flexWrap).toBe("nowrap")
    expect(initial.overflowX).toBe("auto")
    expect(initial.scrollWidth).toBeGreaterThan(initial.clientWidth)
    await expect(alice.page.getByTestId(tid.reactionFadeLeft(messageId))).toHaveCount(0)
    await expect(alice.page.getByTestId(tid.reactionFadeRight(messageId))).toBeVisible()

    const first = alice.page.getByTestId(tid.reactionTab(OVERFLOW_EMOJIS[0]))
    const last = alice.page.getByTestId(tid.reactionTab(OVERFLOW_EMOJIS.at(-1)!))
    await first.focus()
    await first.press("End")
    await expect.poll(() => rail.evaluate((element) => ({
      left: element.scrollLeft,
      max: element.scrollWidth - element.clientWidth,
    }))).toEqual(expect.objectContaining({ left: initial.scrollWidth - initial.clientWidth }))
    await expect(alice.page.getByTestId(tid.reactionFadeLeft(messageId))).toBeVisible()
    await expect(alice.page.getByTestId(tid.reactionFadeRight(messageId))).toHaveCount(0)

    await rail.evaluate((element) => {
      element.scrollLeft = 0
      element.dispatchEvent(new Event("scroll"))
    })
    await last.click()
    await expect(last).toHaveAttribute("data-active", "")
    await expect.poll(() => rail.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    expect(dialogMutations).toEqual([])

    await rail.evaluate((element) => {
      element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2
      element.dispatchEvent(new Event("scroll"))
    })
    await expect(alice.page.getByTestId(tid.reactionFadeLeft(messageId))).toBeVisible()
    await expect(alice.page.getByTestId(tid.reactionFadeRight(messageId))).toBeVisible()

    await last.focus()
    await last.press("Home")
    await expect.poll(() => rail.evaluate((element) => element.scrollLeft)).toBe(0)
    await expect(alice.page.getByTestId(tid.reactionFadeLeft(messageId))).toHaveCount(0)
    await expect(alice.page.getByTestId(tid.reactionFadeRight(messageId))).toBeVisible()
    await first.click()
    await expect(first).toHaveAttribute("data-active", "")
    await expect(alice.page.getByTestId(tid.reactionMember(userId("bob")))).toBeVisible()
    expect(dialogMutations).toEqual([])
    await testInfo.attach("320-reaction-rail-overflow-light.png", {
      body: await alice.page.screenshot(),
      contentType: "image/png",
    })
    await alice.page.emulateMedia({ colorScheme: "dark" })
    await expect(alice.page.locator("html")).toHaveClass(/dark/)
    const themeSurface = await alice.page.getByTestId(tid.reactionDialog(messageId)).evaluate((element, fadeTestId) => {
      const fade = element.querySelector(`[data-testid="${fadeTestId}"]`)
      const fadeStyle = fade ? getComputedStyle(fade) : null
      return {
        background: getComputedStyle(element).backgroundColor,
        fadeEndpoint: fadeStyle?.getPropertyValue("--tw-gradient-from").trim() ?? "",
        fade: fadeStyle?.backgroundImage ?? "",
        transitionProperty: getComputedStyle(element).transitionProperty,
      }
    }, tid.reactionFadeRight(messageId))
    expect(themeSurface.background).toBe(themeSurface.fadeEndpoint)
    expect(themeSurface.fade).toContain(themeSurface.fadeEndpoint)
    expect(themeSurface.transitionProperty).toBe("none")
    await testInfo.attach("320-reaction-rail-overflow-dark.png", {
      body: await alice.page.screenshot(),
      contentType: "image/png",
    })
  })

  test("hover-capable desktop keeps compact click and tooltip behavior", async ({ asUser }, testInfo) => {
    const alice = await asUser("alice")
    await alice.page.setViewportSize({ width: 1280, height: 900 })
    await installInputCapability(alice.page, true)
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    const chip = alice.page.getByTestId(tid.reactionChip(messageId, "👍"))
    await alice.page.getByTestId(tid.message(messageId))
      .locator("[data-community-message-body]")
      .hover()
    await expect(chip).toHaveAttribute("data-slot", "tooltip-trigger")
    await chip.hover()
    await expect(alice.page.getByText(/Reacted by/)).toBeVisible()
    await testInfo.attach("1280-desktop-reaction-tooltip.png", {
      body: await alice.page.screenshot(),
      contentType: "image/png",
    })
    const height = await chip.evaluate((element) => element.getBoundingClientRect().height)
    expect(height).toBeLessThan(44)
  })

  test("the shared thread opener opens the same mobile dialog", async ({ asUser }, testInfo) => {
    const alice = await asUser("alice")
    await alice.page.setViewportSize({ width: 390, height: 844 })
    await alice.page.emulateMedia({ colorScheme: "light" })
    await installInputCapability(alice.page, false)
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${threadId}`)
    const chip = alice.page.getByTestId(tid.reactionChip(threadOpenerId, "👍"))
    await expect(chip).toBeVisible()
    await holdReaction(alice.page, chip)
    await expectDialogInsideViewport(alice.page, threadOpenerId)
    await testInfo.attach("390-thread-opener-reaction-details.png", {
      body: await alice.page.screenshot(),
      contentType: "image/png",
    })
  })

  test("DM and message-context rows open the same authorized reaction dialog", async ({ asUser }) => {
    const dm = await asUser("alice")
    await dm.page.setViewportSize({ width: 390, height: 844 })
    await installInputCapability(dm.page, false)
    await gotoAfterUserWsAuth(dm.page, `/c/me/${dmId}`)
    await holdReaction(dm.page, dm.page.getByTestId(tid.reactionChip(dmMessageId, "👍")))
    await expectDialogInsideViewport(dm.page, dmMessageId)
    await expect(dm.page.getByTestId(tid.reactionMember(userId("bob")))).toBeVisible()
    await dm.page.getByRole("button", { name: "Close" }).click()
    await dm.context.close()

    const context = await asUser("alice")
    await context.page.setViewportSize({ width: 390, height: 844 })
    await installInputCapability(context.page, false)
    await gotoAfterUserWsAuth(context.page, `/c/channels/${serverId}/${channelId}?seq=1`)
    const sheet = context.page.locator('[data-slot="sheet-content"]')
    await expect(sheet).toBeVisible()
    await holdReaction(context.page, sheet.getByTestId(tid.reactionChip(messageId, OVERFLOW_EMOJIS[0])))
    await expectDialogInsideViewport(context.page, messageId)
  })

  test("removing the last reaction keeps the dialog open on its empty state", async ({ asUser }, testInfo) => {
    const alice = await asUser("alice")
    await alice.page.setViewportSize({ width: 390, height: 844 })
    await alice.page.emulateMedia({ colorScheme: "light" })
    await installInputCapability(alice.page, false)
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    const chip = alice.page.getByTestId(tid.reactionChip(emptyMessageId, "✅"))
    await holdReaction(alice.page, chip)
    await expectDialogInsideViewport(alice.page, emptyMessageId)
    const status = await alice.page.evaluate(async ({ id, emoji }) => {
      const response = await fetch(`/api/community/messages/${id}/reactions/${encodeURIComponent(emoji)}`, {
        method: "DELETE",
      })
      return response.status
    }, { id: emptyMessageId, emoji: "✅" })
    expect(status).toBe(204)
    await expect(alice.page.getByTestId(tid.reactionEmpty(emptyMessageId))).toBeVisible()
    await expect(alice.page.getByTestId(tid.reactionDialog(emptyMessageId))).toBeVisible()
    await testInfo.attach("390-mobile-reaction-details-empty.png", {
      body: await alice.page.screenshot(),
      contentType: "image/png",
    })
  })
})
