import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { communityFrameEvents, proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { tid } from "./_fixtures/testids"
import { VIEWPORT, seedProfile, setReadCheckpoint, waitForCommittedGeometry, waitForStableTail, seedScrollServer, tracedAsUser } from "./_fixtures/message-scroll-characterization"

test.describe("message scroll characterization", () => {
test("peer receives follow after clamped bottom input without movement", async ({ caseActors }) => {
    test.setTimeout(120_000)
    const actors = await caseActors(["alice", "bob", "carol"])
    const asUser = tracedAsUser(actors)
    const serverId = await seedScrollServer(actors)
    const { seedChannel, seedMessage } = actors.seed

    const channelId = await seedChannel("alice", serverId, `scroll-bottom-input-${Date.now()}`)
    await seedProfile(actors, channelId, 18)
    let tailId = await seedMessage("bob", channelId, "bottom input start\n[keyboard target](https://example.com)")
    await setReadCheckpoint(actors, channelId, tailId)
    const alice = await asUser("alice")
    await alice.page.setViewportSize(VIEWPORT)
    const proxy = await proxyCommunityWebSockets(alice.context)
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    const scroller = alice.page.getByTestId(tid.messageScroller)
    await expect(scroller.locator('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
    for (const input of ["click", "wheel", "ArrowDown", "PageDown", "End", "Space"]) {
      await waitForStableTail(scroller, `bottom-${input}`)
      if (input !== "click" && input !== "wheel") {
        await alice.page.getByTestId(tid.message(tailId)).getByRole("link", { name: "Link: https://example.com/" }).focus()
      }
      const before = await waitForCommittedGeometry(scroller)
      expect(before.distanceToEnd).toBeLessThanOrEqual(1)
      const box = await scroller.boundingBox()
      expect(box).not.toBeNull()
      await alice.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 16)
      if (input === "click") await alice.page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 16)
      else if (input === "wheel") await alice.page.mouse.wheel(0, 120)
      else await alice.page.keyboard.press(input)
      const after = await waitForCommittedGeometry(scroller)
      expect(after.distanceToEnd).toBeLessThanOrEqual(1)
      expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
      const body = `bottom input ${input} ${Date.now()}\n[keyboard target](https://example.com)`
      tailId = await seedMessage("carol", channelId, body)
      await expect.poll(() => proxy.frames.filter(frame => communityFrameEvents(frame).some(event =>
        event.type === "community:message.create" && event.channelId === channelId && event.message?.id === tailId,
      )).length).toBe(1)
      await expect(alice.page.getByTestId(tid.message(tailId))).toBeVisible()
      await waitForStableTail(scroller, `received-${input}`)
      await expect(alice.page.getByTestId(tid.scrollToPresent)).toHaveCount(0)
    }
  })
})
