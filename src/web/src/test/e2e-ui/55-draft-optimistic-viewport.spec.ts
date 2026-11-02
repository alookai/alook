import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import { communityFrameEvents, proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { beginScrollTraceAnalysis, endScrollTraceAnalysis, installScrollTrace, markScrollTrace, startScrollTrace } from "./_fixtures/scroll-trace"
import { tid } from "./_fixtures/testids"
import { VIEWPORT, identity, finishAndAttach, establishScrollDistancePrecondition, messageCreateCount, seedScrollCase, tracedAsUser } from "./_fixtures/message-scroll-characterization"

test.describe("message scroll characterization", () => {
test("manual draft clear and optimistic send stay distinct through viewport changes", async ({ caseActors }, testInfo) => {
    test.setTimeout(180_000)
    const actors = await caseActors(["alice", "bob", "carol"])
    const asUser = tracedAsUser(actors)
    const { serverId, composerChannelId, composerProfile } = await seedScrollCase(actors)

    const alice = await asUser("alice")
    await alice.page.setViewportSize(VIEWPORT)
    await installScrollTrace(alice.page)
    const proxy = await proxyCommunityWebSockets(alice.context)
    let messagePosts = 0
    alice.page.on("request", (request) => {
      if (
        request.method() === "POST"
        && new URL(request.url()).pathname === `/api/community/channels/${composerChannelId}/messages`
      ) messagePosts += 1
    })
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${composerChannelId}`)
    const scroller = alice.page.getByTestId(tid.messageScroller)
    const editable = composerEditable(alice.page)
    await expect(editable).toBeVisible()
    await startScrollTrace(alice.page, {
      scenario: "composer-clear-send-and-viewport",
      identity: identity(composerChannelId),
      estimatedSizes: composerProfile.estimates,
    })

    const typeSixLines = async (prefix: string) => {
      await editable.click()
      for (let line = 0; line < 6; line += 1) {
        await editable.pressSequentially(`${prefix} line ${line} ${"content ".repeat(8)}`)
        if (line < 5) await alice.page.keyboard.press("Shift+Enter")
      }
    }
    await markScrollTrace(alice.page, "stimulus:prepare-pinned-draft")
    await typeSixLines("pinned")
    const pinnedDraftPrecondition = await establishScrollDistancePrecondition(
      scroller,
      "manual-delete-pinned",
      0,
    )
    await markScrollTrace(alice.page, "manual-delete-pinned-precondition", {
      detail: pinnedDraftPrecondition,
    })
    await beginScrollTraceAnalysis(alice.page, "manual-delete-pinned")
    await markScrollTrace(alice.page, "manual-delete-pinned")
    await alice.page.keyboard.press("ControlOrMeta+A")
    await alice.page.keyboard.press("Backspace")
    await expect(alice.page.getByTestId(tid.composerInput)).toHaveText("")
    expect(messagePosts).toBe(0)
    expect(proxy.frames.flatMap(communityFrameEvents).filter((event) =>
      event.type === "community:message.create" && event.channelId === composerChannelId)).toHaveLength(0)
    await endScrollTraceAnalysis(alice.page, "manual-delete-pinned")

    await markScrollTrace(alice.page, "stimulus:prepare-away-draft")
    await typeSixLines("away")
    const awayDraftPrecondition = await establishScrollDistancePrecondition(
      scroller,
      "manual-delete-away",
      300,
    )
    await markScrollTrace(alice.page, "manual-delete-away-precondition", {
      detail: awayDraftPrecondition,
    })
    await beginScrollTraceAnalysis(alice.page, "manual-delete-away")
    await markScrollTrace(alice.page, "manual-delete-away")
    await alice.page.keyboard.press("ControlOrMeta+A")
    await alice.page.keyboard.press("Backspace")
    await expect(alice.page.getByTestId(tid.composerInput)).toHaveText("")
    expect(messagePosts).toBe(0)
    await endScrollTraceAnalysis(alice.page, "manual-delete-away")

    await markScrollTrace(alice.page, "stimulus:pin-for-send")
    const pinnedSendPrecondition = await establishScrollDistancePrecondition(
      scroller,
      "optimistic-send-pinned",
      0,
    )
    await markScrollTrace(alice.page, "optimistic-send-pinned-precondition", {
      detail: pinnedSendPrecondition,
    })
    await beginScrollTraceAnalysis(alice.page, "optimistic-send-pinned", {
      dataTransitionSource: "optimistic-send",
    })
    const pinnedSend = `optimistic pinned ${Date.now()}`
    await markScrollTrace(alice.page, "optimistic-pinned", { dataTransitionSource: "optimistic-send" })
    await sendMessage(alice.page, pinnedSend)
    await expect(alice.page.getByText(pinnedSend, { exact: true })).toHaveCount(1)
    await markScrollTrace(alice.page, "post-ack-pinned", { dataTransitionSource: "post-ack" })
    await expect.poll(() => messageCreateCount(proxy.frames, composerChannelId, pinnedSend)).toBe(1)
    await markScrollTrace(alice.page, "ws-dedupe-pinned", { dataTransitionSource: "ws-dedupe" })
    await endScrollTraceAnalysis(alice.page, "optimistic-send-pinned")

    await markScrollTrace(alice.page, "stimulus:send-away")
    const awaySendPrecondition = await establishScrollDistancePrecondition(
      scroller,
      "optimistic-send-away",
      300,
    )
    await markScrollTrace(alice.page, "optimistic-send-away-precondition", {
      detail: awaySendPrecondition,
    })
    await beginScrollTraceAnalysis(alice.page, "optimistic-send-away", {
      dataTransitionSource: "optimistic-send",
    })
    const awaySend = `optimistic away ${Date.now()}`
    await markScrollTrace(alice.page, "optimistic-away", { dataTransitionSource: "optimistic-send" })
    await sendMessage(alice.page, awaySend)
    await expect(alice.page.getByText(awaySend, { exact: true })).toHaveCount(1)
    await markScrollTrace(alice.page, "post-ack-away", { dataTransitionSource: "post-ack" })
    await expect.poll(() => messageCreateCount(proxy.frames, composerChannelId, awaySend)).toBe(1)
    await markScrollTrace(alice.page, "ws-dedupe-away", { dataTransitionSource: "ws-dedupe" })
    await expect.poll(() => scroller.evaluate((element) =>
      Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
    expect(messagePosts).toBe(2)
    await endScrollTraceAnalysis(alice.page, "optimistic-send-away")

    await beginScrollTraceAnalysis(alice.page, "viewport-keyboard-profile")
    await markScrollTrace(alice.page, "stimulus:viewport-keyboard-profile")
    await alice.page.setViewportSize({ width: 1280, height: 560 })
    await alice.page.setViewportSize(VIEWPORT)
    await endScrollTraceAnalysis(alice.page, "viewport-keyboard-profile")
    const trace = await finishAndAttach(alice.page, testInfo)
    expect(trace.marks.filter((mark) =>
      ["optimistic-pinned", "optimistic-away"].includes(mark.name)
      && mark.dataTransitionSource === "optimistic-send")).toHaveLength(2)
    expect(trace.marks.filter((mark) => mark.dataTransitionSource === "post-ack")).toHaveLength(2)
    expect(trace.marks.filter((mark) => mark.dataTransitionSource === "ws-dedupe")).toHaveLength(2)
    expect(messageCreateCount(proxy.frames, composerChannelId, pinnedSend)).toBe(1)
    expect(messageCreateCount(proxy.frames, composerChannelId, awaySend)).toBe(1)
  })
})
