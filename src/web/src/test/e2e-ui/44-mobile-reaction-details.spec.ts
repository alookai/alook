import type { Locator, Page } from "@playwright/test"
import { expect, test, userId } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import {
  seedChannel,
  seedJoinServer,
  seedMessage,
  seedReaction,
  seedServer,
  seedThread,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

const HOVER_QUERY = "(hover: hover) and (pointer: fine)"

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
  let emptyMessageId: string
  let threadId: string
  let threadOpenerId: string

  test.beforeAll(async () => {
    const stamp = Date.now()
    serverId = await seedServer("alice", `Reaction details ${stamp}`)
    channelId = await seedChannel("alice", serverId, `reactions-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    await seedJoinServer("alice", "carol", serverId)
    messageId = await seedMessage("alice", channelId, `Hold a reaction ${stamp}`)
    await seedReaction("alice", messageId, "👍")
    await seedReaction("bob", messageId, "👍")
    await seedReaction("bob", messageId, "🔥")
    await seedReaction("carol", messageId, "🎉")
    emptyMessageId = await seedMessage("alice", channelId, `Empty reactions ${stamp}`)
    await seedReaction("alice", emptyMessageId, "✅")
    threadOpenerId = await seedMessage("alice", channelId, `Thread opener reactions ${stamp}`)
    await seedReaction("bob", threadOpenerId, "👍")
    threadId = await seedThread("alice", threadOpenerId, `Reaction thread ${stamp}`)
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

  test("coarse input follows the 320, 639, and 640 cross-capability geometry", async ({ asUser }) => {
    for (const width of [320, 639, 640]) {
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
