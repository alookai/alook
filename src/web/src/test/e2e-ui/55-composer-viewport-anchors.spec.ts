import { CONVERSATION_TAIL_SPACE_PX } from "@/lib/community/conversation-layout"
import { CommunityConversationEntryReadSchema } from "@alook/shared"
import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth, ignoreNextDevToolsPointerCapture, installInputCapability, sendMessage } from "./_fixtures/actions"
import { DEFAULT_KEYBOARD_OPEN_HEIGHT, DEFAULT_MOBILE_VIEWPORT, installMobileKeyboard } from "./_fixtures/mobile-keyboard"
import { communityFrameEvents, proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import {
  beginScrollTraceAnalysis,
  endScrollTraceAnalysis,
  installScrollTrace,
  markScrollTrace,
  startScrollTrace,
  summarizeScrollTrace,
} from "./_fixtures/scroll-trace"
import { tid } from "./_fixtures/testids"
import { expectUniqueSsrCommunityFrame } from "./_fixtures/community-ssr-frame"
import {
  VIEWPORT,
  advanceScrollTraceFrame,
  establishExactPinnedPrecondition,
  establishScrollDistancePrecondition,
  establishTailMessageBelowViewportPrecondition,
  expectComposerOverlayGeometry,
  expectContinuousResizeAnchorPreserved,
  expectMessageCreateIdentity,
  expectResizeAnchorPreserved,
  expectViewportAnchorPreserved,
  finishAndAttach,
  identity,
  messageCreateCount,
  seedDmProfile,
  seedProfile,
  seedScrollCase,
  tracedAsUser,
  waitForCommittedGeometry,
  waitForStableTail,
  type PostedMessageIdentity,
} from "./_fixtures/message-scroll-characterization"

test.describe("composer and viewport scroll anchors", () => {
  test("overlay composer resizes, optimistic sends, and split threads preserve semantic anchors", async ({ caseActors }, testInfo) => {
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

    await editable.click()
    await alice.page.keyboard.press("ControlOrMeta+A")
    await alice.page.keyboard.press("Backspace")
    await expect(editable).toHaveText("")

    await establishScrollDistancePrecondition(scroller, "optimistic-send-pinned", 0)
    const pinnedSend = `optimistic pinned ${Date.now()}`
    await sendMessage(alice.page, pinnedSend)
    await expect(alice.page.getByText(pinnedSend, { exact: true })).toHaveCount(1)
    await expect.poll(() => messageCreateCount(proxy.frames, composerChannelId, pinnedSend)).toBe(1)
    await expect(editable).toHaveText("")

    await establishScrollDistancePrecondition(scroller, "optimistic-send-away", 300)
    const awaySend = `optimistic away ${Date.now()}`
    await sendMessage(alice.page, awaySend)
    await expect(alice.page.getByText(awaySend, { exact: true })).toHaveCount(1)
    await expect.poll(() => messageCreateCount(proxy.frames, composerChannelId, awaySend)).toBe(1)
    await expect.poll(() => scroller.evaluate((element) =>
      Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
    expect(mutationPosts).toBe(2)

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
    expect(mutationPosts).toBe(2)

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

  test("DM composer clear preserves pinned and away viewport geometry", async ({ caseActors }, testInfo) => {
    test.setTimeout(180_000)
    const actors = await caseActors(["alice", "bob", "carol"])
    const asUser = tracedAsUser(actors)
    const { userId } = actors
    const composerDmId = await actors.seed.seedDm("alice", userId("bob"))
    const composerDmProfile = await seedDmProfile(actors, composerDmId, 36)

    const alice = await asUser("alice")
    await alice.page.setViewportSize(VIEWPORT)
    await installScrollTrace(alice.page)
    const proxy = await proxyCommunityWebSockets(alice.context)
    let messagePosts = 0
    alice.page.on("request", (request) => {
      if (
        request.method() === "POST"
        && new URL(request.url()).pathname === `/api/community/channels/${composerDmId}/messages`
      ) messagePosts += 1
    })
    const entryResponse = alice.page.waitForResponse(response => {
      const url = new URL(response.url())
      return response.request().method() === "GET" && url.pathname === `/api/community/channels/${composerDmId}/messages`
        && url.searchParams.get("entry") === "1"
    })
    void entryResponse.catch(() => undefined)
    await gotoAfterUserWsAuth(alice.page, `/c/me/${composerDmId}`)
    const entryRead = await entryResponse
    expect(entryRead.status()).toBe(200)
    const entry = CommunityConversationEntryReadSchema.parse(await entryRead.json())
    expect(entry.page.hasMoreNewer).toBe(false)
    const scroller = alice.page.getByTestId(tid.messageScroller)
    const editable = composerEditable(alice.page)
    await expect(editable).toBeVisible()
    await expect(alice.page.getByTestId(tid.message(composerDmProfile.ids.at(-1)!)))
      .toBeVisible({ timeout: 30_000 })
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event("scroll"))
    })
    const tailGeometry = await alice.page.evaluate(({ scrollerId, messageId }) => {
      const scrollerElement = document.querySelector<HTMLElement>(
        `[data-testid="${scrollerId}"]`,
      )!
      const content = scrollerElement.querySelector<HTMLElement>("[data-message-list-content]")!
      const finalMessage = document.querySelector<HTMLElement>(`[data-testid="${messageId}"]`)!
      const composer = document.querySelector<HTMLElement>('[data-onboarding-target="dm-composer"]')!
      return {
        paddingBottom: Number.parseFloat(getComputedStyle(content).paddingBottom),
        tailGap: composer.getBoundingClientRect().top
          - finalMessage.getBoundingClientRect().bottom,
        scrollerBottom: scrollerElement.getBoundingClientRect().bottom,
        composerBottom: composer.getBoundingClientRect().bottom,
        composerTop: composer.getBoundingClientRect().top,
      }
    }, {
      scrollerId: tid.messageScroller,
      messageId: tid.message(composerDmProfile.ids.at(-1)!),
    })
    expect(tailGeometry.paddingBottom).toBe(0)
    expect(tailGeometry.tailGap).toBeGreaterThanOrEqual(39)
    expect(tailGeometry.tailGap).toBeLessThanOrEqual(41)
    expect(Math.abs(tailGeometry.scrollerBottom - tailGeometry.composerTop)).toBeLessThanOrEqual(1)
    await startScrollTrace(alice.page, {
      scenario: "dm-composer-clear-viewport",
      identity: identity(composerDmId),
      estimatedSizes: composerDmProfile.estimates,
    })

    const composerLines = (prefix: string) => Array.from(
      { length: 6 },
      (_, line) => `${prefix} line ${line} ${"content ".repeat(8)}`,
    ).join("\n")

    for (const distance of [0, 2, CONVERSATION_TAIL_SPACE_PX, CONVERSATION_TAIL_SPACE_PX + 1, 100, 300]) {
      await editable.fill(composerLines(`dm-${distance}`))
      const precondition = distance === 0
        ? await establishExactPinnedPrecondition(scroller, `dm-composer-${distance}`, 0)
        : await establishScrollDistancePrecondition(scroller, `dm-composer-${distance}`, distance)
      await markScrollTrace(alice.page, `dm-composer-${distance}-precondition`, {
        detail: precondition,
      })
      const before = await waitForCommittedGeometry(scroller)
      expectComposerOverlayGeometry(before, `dm-${distance}-before`)
      expect(before.surfaceChannelId).toBe(composerDmId)

      await beginScrollTraceAnalysis(alice.page, `dm-composer-shrink-${distance}`)
      await editable.click()
      await alice.page.keyboard.press("ControlOrMeta+A")
      await alice.page.keyboard.press("Backspace")
      await expect(editable).toHaveText("")
      await expect.poll(() => scroller.evaluate((element) => element.clientHeight - Number((element as HTMLElement).dataset.composerOcclusion ?? 0)))
        .toBeGreaterThan(before.readableHeight)
      const after = await waitForCommittedGeometry(scroller)
      expectComposerOverlayGeometry(after, `dm-${distance}-after`)
      expectResizeAnchorPreserved(before, after, distance <= CONVERSATION_TAIL_SPACE_PX ? "tail" : "reading", `dm-${distance}-after`)
      await endScrollTraceAnalysis(alice.page, `dm-composer-shrink-${distance}`)
      await advanceScrollTraceFrame(scroller)
    }

    const trace = await finishAndAttach(alice.page, testInfo)
    const segments = new Map(
      summarizeScrollTrace(trace).analysisSegments.map((segment) => [segment.name, segment]),
    )
    for (const distance of [0, 2, CONVERSATION_TAIL_SPACE_PX, CONVERSATION_TAIL_SPACE_PX + 1, 100, 300]) {
      const segmentName = `dm-composer-shrink-${distance}`
      expect(segments.get(segmentName)).toBeDefined()
      expectContinuousResizeAnchorPreserved(trace, segmentName, distance <= CONVERSATION_TAIL_SPACE_PX ? "tail" : "reading")
    }
    expect(messagePosts).toBe(0)
    expect(proxy.frames.flatMap(communityFrameEvents).filter((event) =>
      event.type === "community:message.create" && event.channelId === composerDmId)).toHaveLength(0)

    for (const [index, mode] of ["away", "reduced-viewport-tail"].entries()) {
      if (mode === "away") await establishScrollDistancePrecondition(scroller, "dm-local-submit-away", 300)
      else {
        await establishExactPinnedPrecondition(scroller, "dm-before-keyboard-viewport", 0)
        await editable.click()
        const beforeKeyboard = await waitForCommittedGeometry(scroller)
        await alice.page.setViewportSize({ ...VIEWPORT, height: VIEWPORT.height - 180 })
        await expect.poll(() => scroller.evaluate(element => element.clientHeight)).toBeLessThan(beforeKeyboard.clientHeight)
        await waitForStableTail(scroller, "dm-keyboard-profile-open-at-tail")
        await establishScrollDistancePrecondition(scroller, "dm-keyboard-profile-before-last-message", 300)
        await alice.page.getByTestId(tid.scrollToPresent).click()
        await waitForStableTail(scroller, "dm-keyboard-profile-after-last-message")
        await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeHidden()
      }
      const content = mode === "away" ? `dm local acceptance ${Date.now()}` : `dm keyboard-profile acceptance ${Date.now()} ${"content ".repeat(80)}`.trim()
      if (mode !== "away") {
        await editable.fill(content)
        await waitForStableTail(scroller, "dm-keyboard-profile-before-send")
      }
      const beforeSend = mode === "away" ? null : await waitForCommittedGeometry(scroller)
      const post = alice.page.waitForResponse(response => response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/community/channels/${composerDmId}/messages`
        && response.request().postDataJSON().content === content)
      if (mode === "away") await sendMessage(alice.page, content)
      else {
        await expect(editable).toHaveAttribute("enterkeyhint", "send")
        await expect(editable).toBeFocused()
        await alice.page.keyboard.press("Enter")
      }
      const response = await post
      expect(response.status()).toBe(201)
      const nonce = response.request().postDataJSON().nonce as string
      expect(nonce.length).toBeGreaterThan(0)
      const result = await response.json() as { message: PostedMessageIdentity }
      expect(result.message).toMatchObject({ authorId: userId("alice"), channelId: composerDmId, content })
      await expect.poll(() => messageCreateCount(proxy.frames, composerDmId, content)).toBe(1)
      await expectMessageCreateIdentity(proxy.frames, composerDmId, result.message, nonce)
      await expect(alice.page.getByTestId(tid.message(result.message.id))).toBeVisible()
      await expect(alice.page.getByText(content, { exact: true })).toHaveCount(1)
      await expect(editable).toHaveText("")
      await waitForStableTail(scroller, `dm-local-submit-${mode}-ack`)
      if (beforeSend) expect((await waitForCommittedGeometry(scroller)).clientHeight).toBeGreaterThan(beforeSend.clientHeight)
      expect(messagePosts).toBe(index + 1)
    }
    await alice.page.setViewportSize(VIEWPORT)
    await waitForStableTail(scroller, "dm-keyboard-profile-closed-after-send")
  })

  test("mobile 390x844 virtual keyboard dismissal on Send keeps post-submit scroll pinned to bottom without pill flash", async ({ caseActors }) => {
    test.setTimeout(120_000)
    const actors = await caseActors(["alice", "bob", "carol"])
    const { serverId, composerChannelId } = await seedScrollCase(actors)
    const alice = await actors.asUser("alice")

    await installInputCapability(alice.page, false)
    const keyboard = await installMobileKeyboard(alice.page, {
      mode: "viewport",
      width: DEFAULT_MOBILE_VIEWPORT.width,
      closedHeight: DEFAULT_MOBILE_VIEWPORT.height,
      openHeight: DEFAULT_KEYBOARD_OPEN_HEIGHT,
      steps: 5,
      stepDelayMs: 16,
      initialDelayMs: 16,
    })

    try {
      await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${composerChannelId}`)
      const scroller = alice.page.getByTestId(tid.messageScroller)
      const editable = composerEditable(alice.page)
      const sendButton = alice.page.getByTestId(tid.composerSend)
      await expect(editable).toBeVisible()
      await waitForStableTail(scroller, "mobile-kb-initial-tail")
      await ignoreNextDevToolsPointerCapture(alice.page)

      const startPillWatch = async (testId: string) => {
        await alice.page.evaluate((pillTestId) => {
          const win = window as unknown as {
            __pillWatch?: {
              stop: () => { visibleCount: number; sawHidden: boolean; reappearedAfterHide: boolean }
            }
          }
          win.__pillWatch?.stop()
          let active = true
          let visibleCount = 0
          let sawHidden = false
          let reappearedAfterHide = false
          const isVisible = () => {
            const el = document.querySelector<HTMLElement>(`[data-testid="${pillTestId}"]`)
            if (!el) return false
            const style = window.getComputedStyle(el)
            const rect = el.getBoundingClientRect()
            return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.height > 0 && rect.width > 0
          }
          const sample = () => {
            if (!active) return
            if (isVisible()) {
              visibleCount += 1
              if (sawHidden) reappearedAfterHide = true
            } else {
              sawHidden = true
            }
          }
          const observer = new MutationObserver(sample)
          observer.observe(document.body, { childList: true, subtree: true, attributes: true })
          const tick = () => {
            if (!active) return
            sample()
            window.requestAnimationFrame(tick)
          }
          window.requestAnimationFrame(tick)
          win.__pillWatch = {
            stop: () => {
              active = false
              observer.disconnect()
              sample()
              return { visibleCount, sawHidden, reappearedAfterHide }
            },
          }
        }, testId)
      }

      const stopPillWatch = async () => (
        alice.page.evaluate(() => {
          const win = window as unknown as {
            __pillWatch?: {
              stop: () => { visibleCount: number; sawHidden: boolean; reappearedAfterHide: boolean }
            }
          }
          return win.__pillWatch?.stop() ?? { visibleCount: 0, sawHidden: true, reappearedAfterHide: false }
        })
      )

      const expectMessageVisibleAtTail = async (messageId: string, label: string) => {
        await waitForStableTail(scroller, label)
        const geometry = await scroller.evaluate((element, id) => {
          const scrollerRect = element.getBoundingClientRect()
          const msg = element.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)
          const msgRect = msg?.getBoundingClientRect() ?? null
          const occlusion = Number((element as HTMLElement).dataset.composerOcclusion ?? 0)
          return {
            tailGap: element.scrollHeight - element.clientHeight - element.scrollTop,
            clientHeight: element.clientHeight,
            msgFound: !!msgRect,
            msgBottom: msgRect?.bottom ?? null,
            readableBottom: scrollerRect.bottom - occlusion,
          }
        }, messageId)
        expect(geometry.tailGap, `${label} tailGap`).toBeLessThanOrEqual(1)
        expect(geometry.msgFound, `${label} msgFound`).toBe(true)
        expect(geometry.msgBottom!, `${label} msgBottom`).toBeLessThanOrEqual(geometry.readableBottom + 2)
      }

      await editable.click()
      await keyboard.waitForState("open")
      expect(alice.page.viewportSize()).toEqual({
        width: DEFAULT_MOBILE_VIEWPORT.width,
        height: DEFAULT_KEYBOARD_OPEN_HEIGHT,
      })
      await waitForStableTail(scroller, "mobile-kb-open-at-bottom")

      const bottomContent = [
        `mobile bottom submit ${Date.now()}`,
        "line two ensures message height exceeds CONVERSATION_TAIL_SPACE_PX",
        "line three verifies keyboard dismiss resize never locks above the new message",
        "line four confirms full bottom visibility",
      ].join("\n")
      await editable.fill(bottomContent)
      await expect(sendButton).toBeVisible()
      await expect(sendButton).toBeEnabled()
      await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeHidden()

      await startPillWatch(tid.scrollToPresent)
      const bottomPost = alice.page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/community/channels/${composerChannelId}/messages`
      ))
      await sendButton.click()
      const bottomResponse = await bottomPost
      expect(bottomResponse.status()).toBe(201)
      const bottomResult = await bottomResponse.json() as { message: PostedMessageIdentity }
      await keyboard.waitForState("closed")
      expect(alice.page.viewportSize()).toEqual(DEFAULT_MOBILE_VIEWPORT)
      await expectMessageVisibleAtTail(bottomResult.message.id, "mobile-kb-bottom-after-close")
      const bottomPill = await stopPillWatch()
      expect(bottomPill.visibleCount).toBe(0)
      await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeHidden()

      await establishScrollDistancePrecondition(scroller, "mobile-kb-history", 360)
      await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeVisible()
      await editable.click()
      await keyboard.waitForState("open")
      await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeVisible()

      const historyContent = [
        `mobile history submit ${Date.now()}`,
        "line two verifies jumping-to-target/present survives concurrent keyboard dismissal",
        "line three ensures new message lands fully at bottom without pill re-flash",
      ].join("\n")
      await editable.fill(historyContent)
      await expect(sendButton).toBeEnabled()

      await startPillWatch(tid.scrollToPresent)
      const historyPost = alice.page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/community/channels/${composerChannelId}/messages`
      ))
      await sendButton.click()
      const historyResponse = await historyPost
      expect(historyResponse.status()).toBe(201)
      const historyResult = await historyResponse.json() as { message: PostedMessageIdentity }
      await keyboard.waitForState("closed")
      expect(alice.page.viewportSize()).toEqual(DEFAULT_MOBILE_VIEWPORT)
      await expectMessageVisibleAtTail(historyResult.message.id, "mobile-kb-history-after-close")
      const historyPill = await stopPillWatch()
      expect(historyPill.sawHidden).toBe(true)
      expect(historyPill.reappearedAfterHide).toBe(false)
      await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeHidden()
    } finally {
      await keyboard.dispose()
    }
  })

  test("mobile keyboard inset mode drives alook:keyboard-change CSS variables across focus and Send", async ({ caseActors }) => {
    test.setTimeout(90_000)
    const actors = await caseActors(["alice", "bob", "carol"])
    const { serverId, composerChannelId } = await seedScrollCase(actors)
    const alice = await actors.asUser("alice")

    await installInputCapability(alice.page, false)
    const keyboard = await installMobileKeyboard(alice.page, {
      mode: "inset",
      width: DEFAULT_MOBILE_VIEWPORT.width,
      closedHeight: DEFAULT_MOBILE_VIEWPORT.height,
      insetHeight: 324,
      steps: 4,
      initialDelayMs: 16,
    })

    try {
      await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${composerChannelId}`)
      const scroller = alice.page.getByTestId(tid.messageScroller)
      const editable = composerEditable(alice.page)
      const sendButton = alice.page.getByTestId(tid.composerSend)
      await expect(editable).toBeVisible()
      await waitForStableTail(scroller, "mobile-inset-initial-tail")
      await ignoreNextDevToolsPointerCapture(alice.page)

      await editable.click()
      await keyboard.waitForState("open")
      const openVars = await alice.page.evaluate(() => ({
        bottom: document.documentElement.style.getPropertyValue("--alook-keyboard-bottom"),
        progress: document.documentElement.style.getPropertyValue("--alook-keyboard-progress"),
      }))
      expect(openVars.bottom).toMatch(/vw$/)
      expect(openVars.bottom).not.toBe("0vw")
      expect(openVars.progress).toContain("calc(")

      const content = `mobile inset submit ${Date.now()}\nsecond line for inset close verification`
      await editable.fill(content)
      const post = alice.page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/community/channels/${composerChannelId}/messages`
      ))
      await sendButton.click()
      const response = await post
      expect(response.status()).toBe(201)
      const result = await response.json() as { message: PostedMessageIdentity }
      await keyboard.waitForState("closed")
      const closedVars = await alice.page.evaluate(() => ({
        bottom: document.documentElement.style.getPropertyValue("--alook-keyboard-bottom"),
        progress: document.documentElement.style.getPropertyValue("--alook-keyboard-progress"),
      }))
      expect(closedVars.bottom).toBe("0vw")
      expect(closedVars.progress).toBe("")
      await waitForStableTail(scroller, "mobile-inset-after-close")
      await expect(alice.page.getByTestId(tid.message(result.message.id))).toBeVisible()
      await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeHidden()
    } finally {
      await keyboard.dispose()
    }
  })
})
