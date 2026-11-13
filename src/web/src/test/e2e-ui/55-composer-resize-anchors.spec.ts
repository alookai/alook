import { CONVERSATION_TAIL_SPACE_PX } from "@/lib/community/conversation-layout"
import { CommunityConversationEntryReadSchema } from "@alook/shared"
import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import { communityFrameEvents, proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { beginScrollTraceAnalysis, endScrollTraceAnalysis, installScrollTrace, markScrollTrace, startScrollTrace, summarizeScrollTrace } from "./_fixtures/scroll-trace"
import { tid } from "./_fixtures/testids"
import { expectUniqueSsrCommunityFrame } from "./_fixtures/community-ssr-frame"
import { VIEWPORT, seedProfile, identity, finishAndAttach, establishScrollDistancePrecondition, establishExactPinnedPrecondition, establishTailMessageBelowViewportPrecondition, waitForCommittedGeometry, waitForStableTail, advanceScrollTraceFrame, expectViewportAnchorPreserved, expectResizeAnchorPreserved, expectContinuousResizeAnchorPreserved, expectComposerOverlayGeometry, messageCreateCount, type PostedMessageIdentity, expectMessageCreateIdentity, seedScrollCase, tracedAsUser } from "./_fixtures/message-scroll-characterization"

test.describe("message scroll characterization", () => {
test("overlay composer resizes preserve semantic anchors and interaction boundaries", async ({ caseActors }, testInfo) => {
    test.setTimeout(180_000)
    const actors = await caseActors(["alice", "bob", "carol"])
    const asUser = tracedAsUser(actors)
    const { userId } = actors
    const { serverId, composerChannelId, composerProfile } = await seedScrollCase(actors)
    const { seedThread } = actors.seed

    const splitThreadId = await seedThread(
      "alice",
      composerProfile.ids.at(-1)!,
      `scroll split ${Date.now()}`,
    )
    const splitProfile = await seedProfile(actors, splitThreadId, 24, false, "alice")
    const alice = await asUser("alice")
    const bob = await asUser("bob")
    await alice.page.setViewportSize(VIEWPORT)
    await bob.page.setViewportSize(VIEWPORT)
    await installScrollTrace(alice.page)
    const proxy = await proxyCommunityWebSockets(alice.context)
    let mutationPosts = 0
    alice.page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname
      if (
        request.method() === "POST"
        && (pathname.endsWith("/messages") || pathname.includes("/attachments"))
      ) mutationPosts += 1
    })
    const entryResponse = alice.page.waitForResponse(response => {
      const url = new URL(response.url())
      return response.request().method() === "GET" && url.pathname === `/api/community/channels/${composerChannelId}/messages`
        && url.searchParams.get("entry") === "1"
    })
    void entryResponse.catch(() => undefined)
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${composerChannelId}`)
    const entryRead = await entryResponse
    expect(entryRead.status()).toBe(200)
    const entry = CommunityConversationEntryReadSchema.parse(await entryRead.json())
    expect(entry.page.hasMoreNewer).toBe(false)
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${composerChannelId}`)
    const scroller = alice.page.getByTestId(tid.messageScroller)
    const editable = composerEditable(alice.page)
    const bobEditable = composerEditable(bob.page)
    await expect(editable).toBeVisible()
    await expect(bobEditable).toBeVisible()
    await startScrollTrace(alice.page, {
      scenario: "composer-exact-pinned-resize-policy",
      identity: identity(composerChannelId),
      estimatedSizes: composerProfile.estimates,
    })

    const composerLines = (prefix: string, count: number) => Array.from(
      { length: count },
      (_, line) => `${prefix} line ${line} ${"content ".repeat(8)}`,
    ).join("\n")

    for (const distance of [0, 2, CONVERSATION_TAIL_SPACE_PX, CONVERSATION_TAIL_SPACE_PX + 1, 100, 300]) {
      await editable.fill(composerLines(`boundary-${distance}`, 8))
      const precondition = distance === 0
        ? await establishExactPinnedPrecondition(scroller, `composer-resize-${distance}`, 0)
        : await establishScrollDistancePrecondition(
          scroller,
          `composer-resize-${distance}`,
          distance,
        )
      await markScrollTrace(alice.page, `composer-resize-${distance}-precondition`, {
        detail: precondition,
      })
      const before = await waitForCommittedGeometry(scroller)
      expectComposerOverlayGeometry(before, `resize-${distance}-before`)

      // Match the user journey that exposed the regression: grow the composer,
      // establish the reading position, then delete the draft. Positioning the
      // scroller before growth misses the browser's shrink-time maxScrollTop clamp.
      await beginScrollTraceAnalysis(alice.page, `composer-shrink-${distance}`)
      await editable.click()
      await alice.page.keyboard.press("ControlOrMeta+A")
      await alice.page.keyboard.press("Backspace")
      await expect(editable).toHaveText("")
      await expect.poll(() => scroller.evaluate((element) => element.clientHeight - Number((element as HTMLElement).dataset.composerOcclusion ?? 0)))
        .toBeGreaterThan(before.readableHeight)
      const shrunk = await waitForCommittedGeometry(scroller)
      expectComposerOverlayGeometry(shrunk, `resize-${distance}-shrunk`)
      expectResizeAnchorPreserved(before, shrunk, distance <= CONVERSATION_TAIL_SPACE_PX ? "tail" : "reading", `resize-${distance}-shrunk`)
      await endScrollTraceAnalysis(alice.page, `composer-shrink-${distance}`)
      await advanceScrollTraceFrame(scroller)

      await beginScrollTraceAnalysis(alice.page, `composer-grow-${distance}`)
      await editable.fill(composerLines(`boundary-${distance}`, 8))
      await expect.poll(() => scroller.evaluate((element) => element.clientHeight - Number((element as HTMLElement).dataset.composerOcclusion ?? 0)))
        .toBe(before.readableHeight)
      const grown = await waitForCommittedGeometry(scroller)
      expectComposerOverlayGeometry(grown, `resize-${distance}-grown`)
      expectResizeAnchorPreserved(shrunk, grown, distance <= CONVERSATION_TAIL_SPACE_PX ? "tail" : "reading", `resize-${distance}-grown`)
      await endScrollTraceAnalysis(alice.page, `composer-grow-${distance}`)
      await advanceScrollTraceFrame(scroller)
    }

    await editable.fill("")
    await advanceScrollTraceFrame(scroller)

    const selectionDraft = composerLines("selection-draft", 8)
    await editable.fill(selectionDraft)
    await establishScrollDistancePrecondition(scroller, "selection-footer-away", 300)
    const selectionBase = await waitForCommittedGeometry(scroller)
    const selectionTargetId = selectionBase.firstVisibleId!
    const selectionTarget = alice.page.getByTestId(tid.message(selectionTargetId))
    await beginScrollTraceAnalysis(alice.page, "selection-footer-away")
    await selectionTarget.locator("div.group").first().dispatchEvent("pointerover", {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    })
    const selectionAction = alice.page.getByTestId(tid.messageShare(selectionTargetId))
    await expect(selectionAction).toBeVisible()
    await selectionAction.evaluate((button) => (button as HTMLButtonElement).click())
    await expect(alice.page.getByTestId(tid.messageSelectionToolbar)).toBeVisible()
    const conversationFooter = alice.page.locator('[data-slot="community-conversation-footer"]')
    await expect(conversationFooter).toHaveAttribute("data-selection-active", "true")
    await expect(editable).toBeHidden()
    const selectionOpen = await waitForCommittedGeometry(scroller)
    expect(selectionOpen.readableHeight).toBeGreaterThan(selectionBase.readableHeight)
    expect(selectionOpen.composerOcclusion).toBe(0)
    expect(Math.abs(selectionBase.scrollHeight - selectionOpen.scrollHeight - (40 - 8))).toBeLessThanOrEqual(1)
    expectViewportAnchorPreserved(selectionBase, selectionOpen, "selection-open-away")
    await expect(editable).toContainText("selection-draft line 0")
    await alice.page.getByRole("button", { name: "Cancel message selection" }).click()
    await expect(alice.page.getByTestId(tid.messageSelectionToolbar)).toHaveCount(0)
    await expect(conversationFooter).toHaveAttribute("data-selection-active", "false")
    await expect(editable).toBeVisible()
    const selectionClosed = await waitForCommittedGeometry(scroller)
    expect(selectionClosed.clientHeight).toBe(selectionBase.clientHeight)
    expect(selectionClosed.scrollHeight).toBe(selectionBase.scrollHeight)
    expectViewportAnchorPreserved(selectionBase, selectionClosed, "selection-closed-away")
    await expect(editable).toContainText("selection-draft line 7")
    await editable.fill("")
    await endScrollTraceAnalysis(alice.page, "selection-footer-away")
    await advanceScrollTraceFrame(scroller)

    await establishExactPinnedPrecondition(scroller, "reply-resize-pinned", 0)
    const replyBase = await waitForCommittedGeometry(scroller)
    await beginScrollTraceAnalysis(alice.page, "reply-banner-pinned")
    const replyTarget = alice.page.getByTestId(tid.message(composerProfile.ids.at(-1)!))
    await expect(replyTarget).toBeVisible()
    await replyTarget.locator("div.group").first().dispatchEvent("pointerover", {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    })
    const replyButton = replyTarget.getByRole("button", { name: "Reply", exact: true })
    await expect(replyButton).toBeVisible()
    await expect(replyButton).toBeInViewport()
    expect((await waitForCommittedGeometry(scroller)).distanceToEnd).toBeLessThanOrEqual(1)
    await replyButton.evaluate((button) => (button as HTMLButtonElement).click())
    await expect(alice.page.locator('[data-slot="composer-reply-preview"]')).toBeVisible()
    const replyOpen = await waitForCommittedGeometry(scroller)
    expect(replyOpen.readableHeight).toBeLessThan(replyBase.readableHeight)
    expect(replyOpen.distanceToEnd).toBeLessThanOrEqual(1)
    expectResizeAnchorPreserved(replyBase, replyOpen, "tail", "reply-open")
    expectComposerOverlayGeometry(replyOpen, "reply-open")
    await alice.page.getByRole("button", { name: "Cancel reply" }).click()
    await expect(alice.page.locator('[data-slot="composer-reply-preview"]')).toHaveCount(0)
    const replyClosed = await waitForCommittedGeometry(scroller)
    expect(replyClosed.readableHeight).toBe(replyBase.readableHeight)
    expect(replyClosed.distanceToEnd).toBeLessThanOrEqual(1)
    expectResizeAnchorPreserved(replyBase, replyClosed, "tail", "reply-closed")
    await endScrollTraceAnalysis(alice.page, "reply-banner-pinned")
    await advanceScrollTraceFrame(scroller)

    await establishTailMessageBelowViewportPrecondition(
      scroller,
      "attachment-resize-away",
      composerProfile.ids.at(-1)!,
    )
    const attachmentBase = await waitForCommittedGeometry(scroller)
    await beginScrollTraceAnalysis(alice.page, "attachment-chip-away")
    await alice.page.getByTestId(tid.composerFileInput).setInputFiles({
      name: "geometry-only.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("geometry only"),
    })
    await expect(alice.page.getByText("geometry-only.txt", { exact: true })).toBeVisible()
    const attachmentOpen = await waitForCommittedGeometry(scroller)
    expect(attachmentOpen.readableHeight).toBeLessThan(attachmentBase.readableHeight)
    expectViewportAnchorPreserved(attachmentBase, attachmentOpen, "attachment-open-away")
    expectComposerOverlayGeometry(attachmentOpen, "attachment-open-away")
    await alice.page.getByRole("button", { name: "Remove file" }).click()
    await expect(alice.page.getByText("geometry-only.txt", { exact: true })).toHaveCount(0)
    const attachmentClosed = await waitForCommittedGeometry(scroller)
    expect(attachmentClosed.readableHeight).toBe(attachmentBase.readableHeight)
    expectViewportAnchorPreserved(attachmentBase, attachmentClosed, "attachment-closed-away")
    await endScrollTraceAnalysis(alice.page, "attachment-chip-away")
    await advanceScrollTraceFrame(scroller)

    await establishScrollDistancePrecondition(scroller, "typing-rail-away", 101)
    const typingBase = await waitForCommittedGeometry(scroller)
    await beginScrollTraceAnalysis(alice.page, "typing-rail-away")
    await bobEditable.fill("typing rail geometry")
    await expect(alice.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 20_000 })
    const typingOpen = await waitForCommittedGeometry(scroller)
    expect(typingOpen.clientHeight).toBe(typingBase.clientHeight)
    expectViewportAnchorPreserved(typingBase, typingOpen, "typing-rail-away")
    expect(typingOpen.railRect, "typing-rail-away: scoped Footer rail exists").not.toBeNull()
    expectComposerOverlayGeometry(typingOpen, "typing-rail-away")
    await bobEditable.fill("")
    await endScrollTraceAnalysis(alice.page, "typing-rail-away")
    await advanceScrollTraceFrame(scroller)

    const trace = await finishAndAttach(alice.page, testInfo)
    const resizeSegments = new Map(
      summarizeScrollTrace(trace).analysisSegments.map((segment) => [segment.name, segment]),
    )
    for (const distance of [0, 2, CONVERSATION_TAIL_SPACE_PX, CONVERSATION_TAIL_SPACE_PX + 1, 100, 300]) {
      const grow = resizeSegments.get(`composer-grow-${distance}`)
      const shrink = resizeSegments.get(`composer-shrink-${distance}`)
      expect(grow, `missing composer-grow-${distance}`).toBeDefined()
      expect(shrink, `missing composer-shrink-${distance}`).toBeDefined()
      expectContinuousResizeAnchorPreserved(trace, `composer-grow-${distance}`, distance <= CONVERSATION_TAIL_SPACE_PX ? "tail" : "reading")
      expectContinuousResizeAnchorPreserved(trace, `composer-shrink-${distance}`, distance <= CONVERSATION_TAIL_SPACE_PX ? "tail" : "reading")
    }
    expect(resizeSegments.get("typing-rail-away")?.writerCount).toBe(0)
    expectContinuousResizeAnchorPreserved(trace, "selection-footer-away", "reading")
    expect(mutationPosts).toBe(0)
    expect(proxy.frames.flatMap(communityFrameEvents).filter((event) =>
      event.type === "community:message.create" && event.channelId === composerChannelId)).toHaveLength(0)

    await alice.page.goto(`/c/channels/${serverId}/${splitThreadId}`, { waitUntil: "commit" })
    const frame = await expectUniqueSsrCommunityFrame(alice.page)
    const split = frame.getByTestId(tid.threadSplit)
    await expect(split).toHaveCount(1)
    await expect(split).toHaveAttribute("data-layout", "split", { timeout: 30_000 })
    const parentPanel = split.getByTestId(tid.threadSplitParent)
    const threadPanel = split.getByTestId(tid.threadSplitPanel)
    const parentSurface = parentPanel.locator('[data-slot="community-conversation-surface"]')
    const threadSurface = threadPanel.locator('[data-slot="community-conversation-surface"]')
    await expect(parentSurface).toHaveAttribute("data-channel-id", composerChannelId)
    await expect(threadSurface).toHaveAttribute("data-channel-id", splitThreadId)
    await expect(parentSurface).toHaveCount(1)
    await expect(threadSurface).toHaveCount(1)

    const parentEditable = composerEditable(alice.page, parentPanel)
    const threadEditable = composerEditable(alice.page, threadPanel)
    await parentEditable.fill(composerLines("split-parent", 2))
    await threadEditable.fill(composerLines("split-thread", 6))
    const parentScroller = parentPanel.getByTestId(tid.messageScroller)
    const threadScroller = threadPanel.getByTestId(tid.messageScroller)
    await establishTailMessageBelowViewportPrecondition(
      parentScroller,
      "split-parent-away",
      composerProfile.ids.at(-1)!,
    )
    await establishTailMessageBelowViewportPrecondition(
      threadScroller,
      "split-thread-away",
      splitProfile.ids.at(-1)!,
    )
    const parentGeometry = await waitForCommittedGeometry(parentScroller)
    const threadGeometry = await waitForCommittedGeometry(threadScroller)
    const parentComposerBox = await parentSurface
      .locator('[data-slot="community-conversation-footer"]')
      .boundingBox()
    const threadComposerBox = await threadSurface
      .locator('[data-slot="community-conversation-footer"]')
      .boundingBox()
    expect(parentGeometry.surfaceChannelId).toBe(composerChannelId)
    expect(threadGeometry.surfaceChannelId).toBe(splitThreadId)
    expect(parentComposerBox).not.toBeNull()
    expect(threadComposerBox).not.toBeNull()
    expect(Math.abs(parentGeometry.composerRect!.top - parentComposerBox!.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(threadGeometry.composerRect!.top - threadComposerBox!.y)).toBeLessThanOrEqual(1)
    expect(threadGeometry.composerRect!.top).not.toBe(parentGeometry.composerRect!.top)
    expectComposerOverlayGeometry(parentGeometry, "split-parent")
    expectComposerOverlayGeometry(threadGeometry, "split-thread")
    expect(mutationPosts).toBe(0)

    await parentEditable.fill("")
    await threadEditable.fill("")
    const parentBefore = await waitForCommittedGeometry(parentScroller)
    const content = `thread local acceptance ${Date.now()}`
    const post = alice.page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/community/channels/${splitThreadId}/messages`
      && response.request().postDataJSON().content === content)
    await sendMessage(alice.page, content, threadPanel)
    const response = await post
    expect(response.status()).toBe(201)
    const nonce = response.request().postDataJSON().nonce as string
    expect(nonce.length).toBeGreaterThan(0)
    const result = await response.json() as { message: PostedMessageIdentity }
    expect(result.message).toMatchObject({ authorId: userId("alice"), channelId: splitThreadId, content })
    await expect.poll(() => messageCreateCount(proxy.frames, splitThreadId, content)).toBe(1)
    await expectMessageCreateIdentity(proxy.frames, splitThreadId, result.message, nonce)
    await expect(threadPanel.getByTestId(tid.message(result.message.id))).toBeVisible()
    await expect(threadPanel.getByText(content, { exact: true })).toHaveCount(1)
    await waitForStableTail(threadScroller, "thread-local-submit-ack")
    const parentAfter = await waitForCommittedGeometry(parentScroller)
    expectViewportAnchorPreserved(parentBefore, parentAfter, "thread-local-submit-parent")
  })
})
