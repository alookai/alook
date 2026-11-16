import { CONVERSATION_TAIL_SPACE_PX } from "@/lib/community/conversation-layout"
import { CommunityConversationEntryReadSchema } from "@alook/shared"
import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import { communityFrameEvents, proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { beginScrollTraceAnalysis, endScrollTraceAnalysis, installScrollTrace, markScrollTrace, startScrollTrace, summarizeScrollTrace } from "./_fixtures/scroll-trace"
import { tid } from "./_fixtures/testids"
import { VIEWPORT, seedDmProfile, identity, finishAndAttach, establishScrollDistancePrecondition, establishExactPinnedPrecondition, waitForCommittedGeometry, waitForStableTail, advanceScrollTraceFrame, expectResizeAnchorPreserved, expectContinuousResizeAnchorPreserved, expectComposerOverlayGeometry, messageCreateCount, type PostedMessageIdentity, expectMessageCreateIdentity, tracedAsUser } from "./_fixtures/message-scroll-characterization"

test.describe("message scroll characterization", () => {
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
})
