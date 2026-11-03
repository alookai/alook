import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { beginScrollTraceAnalysis, endScrollTraceAnalysis, installScrollTraceInCurrentDocument, markScrollTrace, startScrollTrace } from "./_fixtures/scroll-trace"
import { tid } from "./_fixtures/testids"
import { VIEWPORT, seedResizableHtmlPreview, seedProfile, identity, finishAndAttach, establishScrollDistancePrecondition, advanceScrollTraceFrame, tracedAsUser } from "./_fixtures/message-scroll-characterization"

test.describe("message scroll characterization", () => {
test("controlled upward release before native movement prevents HTML tail resize follow", async ({ caseActors }, testInfo) => {
    test.setTimeout(120_000)
    const actors = await caseActors(["alice"])
    const serverId = await actors.seed.seedServer("alice", `Released HTML ${Date.now()}`)
    const channelId = await actors.seed.seedChannel("alice", serverId, "released-html")
    const { page } = await tracedAsUser(actors)("alice")
    await page.setViewportSize(VIEWPORT)
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
    await seedProfile(actors, channelId, 24, false, "alice")
    const { attachmentId } = await seedResizableHtmlPreview(page, channelId)
    const scroller = page.getByTestId(tid.messageScroller)
    const iframe = page.getByTestId(tid.htmlPreviewFrame(attachmentId))
    await expect(page.getByTestId(tid.htmlPreview(attachmentId))).toHaveAttribute("data-html-preview-status", "ready")
    await expect(iframe).toHaveCSS("height", "160px")
    await installScrollTraceInCurrentDocument(page)
    await startScrollTrace(page, { scenario: "released-html-tail-growth", identity: identity(channelId) })
    try {
      for (const distance of [0, 1, 2]) {
        await iframe.evaluate(element => (element as HTMLIFrameElement).contentWindow?.postMessage({ type: "scroll-fixture-height", height: 160 }, "*"))
        await expect(iframe).toHaveCSS("height", "160px")
        await establishScrollDistancePrecondition(scroller, `released-tail-${distance}`, distance, 0.05)
        await beginScrollTraceAnalysis(page, `released-tail-${distance}`)
        try {
          const before = await scroller.evaluate((element, frameId) => {
            const frame = element.querySelector<HTMLIFrameElement>(`[data-testid="${frameId}"]`)
            if (!frame?.contentWindow) throw new Error("A real mounted HTML preview is required")
            const wheel = new WheelEvent("wheel", { deltaY: -20, bubbles: true })
            element.dispatchEvent(wheel)
            const result = { top: element.scrollTop, distance: element.scrollHeight - element.clientHeight - element.scrollTop,
              trusted: wheel.isTrusted }
            frame.contentWindow.postMessage({ type: "scroll-fixture-height", height: 260 }, "*")
            return result
          }, tid.htmlPreviewFrame(attachmentId))
          await markScrollTrace(page, `stimulus:released-tail-${distance}`, { detail: before })
          await expect(iframe).toHaveCSS("height", "260px")
          await advanceScrollTraceFrame(scroller)
          const after = await scroller.evaluate(element => element.scrollTop)
          await markScrollTrace(page, `observed:released-tail-${distance}`, { detail: { before, after } })
          expect.soft(Math.abs(after - before.top), `Released reader movement at ${distance}px`).toBeLessThanOrEqual(1)
        } finally {
          await endScrollTraceAnalysis(page, `released-tail-${distance}`)
        }
      }
    } finally {
      await finishAndAttach(page, testInfo)
    }
  })
})
