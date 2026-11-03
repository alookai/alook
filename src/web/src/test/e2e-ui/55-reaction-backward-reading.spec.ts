import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { communityFrameEvents, proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { beginScrollTraceAnalysis, endScrollTraceAnalysis, installScrollTraceInCurrentDocument, markScrollTrace, startScrollTrace, type ScrollTraceResult } from "./_fixtures/scroll-trace"
import { tid } from "./_fixtures/testids"
import { cancelControlledBackwardGrowth, controlledBackwardGrowth } from "./_fixtures/backward-growth"
import { seedProfile, identity, finishAndAttach, waitForCommittedGeometry, advanceScrollTraceFrame, tracedAsUser } from "./_fixtures/message-scroll-characterization"

test.describe("message scroll characterization", () => {
test("measured reaction updates above the fold preserve reading during repeated controlled backward input", async ({ caseActors }, testInfo) => {
    test.setTimeout(120_000)
    const actors = await caseActors(["alice"])
    const serverId = await actors.seed.seedServer("alice", `Measured reactions ${Date.now()}`)
    const channelId = await actors.seed.seedChannel("alice", serverId, "measured-reactions")
    const { page } = await tracedAsUser(actors)("alice")
    await page.setViewportSize({ width: 390, height: 800 })
    await seedProfile(actors, channelId, 4, false, "alice")
    const messageId = await actors.seed.seedMessage("alice", channelId, "A measured historical message")
    await seedProfile(actors, channelId, 24, false, "alice")
    const reactionFrame = (frame: Parameters<typeof communityFrameEvents>[0]) => communityFrameEvents(frame).some(event =>
      event.type === "community:reaction.add" && event.messageId === messageId)
    const proxy = await proxyCommunityWebSockets(page.context(), { decide: frame => reactionFrame(frame) ? "hold" : "forward" })
    const batches = [["👍", "❤️", "😂", "🎉", "👀"], ["🚀", "✅", "🔥", "💯", "🤔"]]
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
    const scroller = page.getByTestId(tid.messageScroller)
    await expect(scroller.locator('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
    await waitForCommittedGeometry(scroller)
    await scroller.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")) })
    await expect(page.getByTestId(tid.message(messageId))).toHaveCount(1)
    await waitForCommittedGeometry(scroller)
    await scroller.evaluate((element, id) => {
      const row = element.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)
      if (!row) throw new Error("The measured reaction message is required")
      element.scrollTop += row.getBoundingClientRect().bottom - element.getBoundingClientRect().top + 256
      element.dispatchEvent(new Event("scroll"))
    }, messageId)
    await waitForCommittedGeometry(scroller)
    await installScrollTraceInCurrentDocument(page)
    await startScrollTrace(page, { scenario: "measured-reactions-backward-growth", identity: identity(channelId, { width: 390, height: 800 }) })
    await beginScrollTraceAnalysis(page, "above-fold-repeated-growth", { commandDirection: "backward" })
    const samples: Array<{ at: number; rowHeight: number; lastInputAt: number }> = []
    let trace: ScrollTraceResult | undefined
    try {
      for (const [round, emojis] of batches.entries()) {
        for (const emoji of emojis) await actors.seed.seedReaction("alice", messageId, emoji)
        await expect.poll(() => proxy.frames.flatMap(communityFrameEvents).filter(event =>
          event.type === "community:reaction.add" && event.messageId === messageId).length).toBe((round + 1) * 5)
        await markScrollTrace(page, `stimulus:reactions-${round}`, { detail: { input: "controlled-wheel-and-scroll", emojis, messageId } })
        const before = await scroller.evaluate(controlledBackwardGrowth, { start: messageId })
        expect(before.growingBottom).toBeLessThan(0)
        expect(proxy.releaseHeld(reactionFrame)).toBeGreaterThan(0)
        await expect.poll(() => page.getByTestId(tid.message(messageId)).evaluate(element => element.closest("[data-index]")!.getBoundingClientRect().height))
          .toBeGreaterThan(before.rowHeight)
        const input = await scroller.evaluate(controlledBackwardGrowth, { finish: true as const })
        expect(input.measurement, "Native row growth must be measured during controlled input").not.toBeNull()
        expect(input.measurement!.direction).toBe("backward")
        expect(input.measurement!.at - input.measurement!.lastInputAt).toBeLessThan(150)
        expect(input.inputDelta).toBeLessThan(0)
        samples.push({ at: before.at, rowHeight: before.rowHeight, lastInputAt: input.measurement!.lastInputAt })
        await advanceScrollTraceFrame(scroller)
        const after = await page.getByTestId(tid.message(before.id)).evaluate(element => {
          const root = element.closest<HTMLElement>("[data-message-scroller-boundary]")?.querySelector<HTMLElement>("[data-pagination-enabled]")
          if (!root) throw new Error("The reading scroller is required")
          return element.getBoundingClientRect().top - root.getBoundingClientRect().top
        })
        await markScrollTrace(page, `observed:reactions-${round}`, { detail: { before, after, input } })
        expect.soft(Math.abs(after - before.top + input.inputDelta), `Reading drift after reaction batch ${round}`).toBeLessThanOrEqual(1)
      }
    } finally {
      await scroller.evaluate(cancelControlledBackwardGrowth)
      await endScrollTraceAnalysis(page, "above-fold-repeated-growth")
      trace = await finishAndAttach(page, testInfo)
    }
    if (!trace) throw new Error("The reaction-growth trace is required")
    for (const sample of samples) {
      const measurement = trace.measurements.find(row => row.id === messageId && row.timestamp >= sample.at && row.height > sample.rowHeight + 1)
      expect(measurement, "A real growing-row measurement must precede the 150ms backward reset").toBeDefined()
      expect(measurement!.timestamp - sample.lastInputAt).toBeLessThan(150)
    }
  })
})
