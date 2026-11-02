import { communityFixtureFetch } from "./_fixtures/business-contract"
import type { CommunityConversationEntryRead } from "@alook/shared"
import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import { communityFrameEvents, proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { beginScrollTraceAnalysis, endScrollTraceAnalysis, installScrollTrace, markScrollTrace, startScrollTrace, startAnalyzedScrollTrace } from "./_fixtures/scroll-trace"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import { expectPublicCommunityDocument } from "./_fixtures/community-ssr-frame"
import { VIEWPORT, holdNextRequest, seedProfile, identity, finishAndAttach, establishScrollDistancePrecondition, waitForCommittedGeometry, waitForStableTail, messageCreateCount, type PostedMessageIdentity, expectMessageCreateIdentity, seedScrollServer, tracedAsUser } from "./_fixtures/message-scroll-characterization"

test.describe("message scroll characterization", () => {
test("local history submission and passive remote append use distinct owners", async ({ caseActors }, testInfo) => {
    test.setTimeout(120_000)
    const actors = await caseActors(["alice", "bob", "carol"])
    const asUser = tracedAsUser(actors)
    const { userId, sessionCookie } = actors
    const serverId = await seedScrollServer(actors)
    const { seedChannel } = actors.seed
    const channelId = await seedChannel("alice", serverId, `scroll-passive-threshold-${Date.now()}`)
    await seedProfile(actors, channelId, 130, false, "rotate", 18)
    const alice = await asUser("alice")
    await alice.page.setViewportSize(VIEWPORT)
    await installScrollTrace(alice.page)
    const proxy = await proxyCommunityWebSockets(alice.context)
    let composerPosts = 0
    alice.page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === `/api/community/channels/${channelId}/messages`) composerPosts += 1
    })
    const documentResponse = alice.page.waitForResponse(response => response.request().isNavigationRequest()
      && new URL(response.url()).pathname === `/c/channels/${serverId}/${channelId}`)
    const anchorResponse = alice.page.waitForResponse(response => {
      const url = new URL(response.url())
      return response.request().method() === "GET" && url.pathname === `/api/community/channels/${channelId}/messages` && url.searchParams.get("entry") === "1"
    })
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    const scroller = alice.page.getByTestId(tid.messageScroller)
    await expect(scroller.locator('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
    const anchored = await anchorResponse
    expect(anchored.status()).toBe(200)
    expectPublicCommunityDocument(await (await documentResponse).text())
    const anchorPage = await anchored.json() as CommunityConversationEntryRead
    expect(anchorPage.selection.reason).toBe("read_pointer")
    expect(anchorPage.page.hasMoreNewer).toBe(true)
    let newestGets = 0
    alice.page.on("request", request => {
      const url = new URL(request.url())
      if (request.method() === "GET" && url.pathname === `/api/community/channels/${channelId}/messages` && url.search === "") newestGets += 1
    })
    const newest = await holdNextRequest(actors, alice.page, `**/api/community/channels/${channelId}/messages**`, url => url.search === "")
    await startScrollTrace(alice.page, {
      scenario: "local-history-submission",
      identity: identity(channelId),
    })
    await beginScrollTraceAnalysis(alice.page, "local-history-submission", {
      dataTransitionSource: "optimistic-send",
      commandDirection: "forward",
    })
    let localTracePending = true
    const attachLocalTrace = async () => {
      if (!localTracePending) return
      localTracePending = false
      await endScrollTraceAnalysis(alice.page, "local-history-submission")
      await finishAndAttach(alice.page, testInfo)
    }
    // The case owner preserves the body error and captures before page teardown.
    actors.onCleanup(attachLocalTrace)
    const localContent = `local history submission ${Date.now()}`
    const localPost = alice.page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
      && response.request().postDataJSON().content === localContent)
    try {
      await sendMessage(alice.page, localContent)
      await newest.matched
      newest.release()
      const response = await localPost
      expect(response.status()).toBe(201)
      const nonce = response.request().postDataJSON().nonce as string
      expect(nonce.length).toBeGreaterThan(0)
      const result = await response.json() as { message: PostedMessageIdentity }
      expect(result.message).toMatchObject({ authorId: userId("alice"), channelId, content: localContent })
      await expect.poll(() => messageCreateCount(proxy.frames, channelId, localContent)).toBe(1)
      await expectMessageCreateIdentity(proxy.frames, channelId, result.message, nonce)
      await expect(alice.page.getByTestId(tid.message(result.message.id))).toBeVisible()
      await expect(alice.page.getByText(localContent, { exact: true })).toHaveCount(1)
      await waitForStableTail(scroller, "local-history-submission-ack")
      expect(newestGets).toBe(1)
      expect(composerPosts).toBe(1)
    } finally {
      await newest.dispose()
    }
    await attachLocalTrace()
    const finishPassiveTrace = await startAnalyzedScrollTrace(alice.page, {
      scenario: "passive-append-position-admission",
      identity: identity(channelId),
      dataTransitionSource: "overlay-ws",
    })
    const attachPassiveTrace = async () => {
      await finishPassiveTrace(testInfo)
    }
    actors.onCleanup(attachPassiveTrace)
    for (const author of ["bob", "alice"] as const) {
      for (const distance of [0, 1, 2, 20, 100, 101]) {
        await markScrollTrace(alice.page, `${author}-${distance}-admission-start`)
        await establishScrollDistancePrecondition(scroller, `${author}-${distance}`, distance, 0.01)
        const before = await waitForCommittedGeometry(scroller)
        expect(before.firstVisibleId).not.toBeNull()
        expect(Math.abs(before.distanceToEnd - distance)).toBeLessThanOrEqual(0.01)
        await markScrollTrace(alice.page, `${author}-${distance}-precondition`, { detail: before })
        const nonce = `scroll186_${author}_${distance}_${Date.now()}`
        const content = `passive ${author} at ${distance} ${nonce}`
        const response = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channelId}/messages`, {
          method: "POST",
          headers: { Cookie: sessionCookie(author), "Content-Type": "application/json", Origin: WEB_URL },
          body: JSON.stringify({ content, nonce }),
        })
        expect(response.status).toBe(201)
        const result = await response.json() as { message: PostedMessageIdentity }
        expect(result.message).toMatchObject({ authorId: userId(author), channelId, content })
        await expect.poll(() => proxy.frames.filter(frame => communityFrameEvents(frame).some(event =>
          event.type === "community:message.create" && event.channelId === channelId && event.message?.id === result.message.id,
        )).length).toBe(1)
        await expectMessageCreateIdentity(proxy.frames, channelId, result.message, nonce)
        if (distance <= 1) {
          await expect(alice.page.getByTestId(tid.message(result.message.id))).toBeVisible()
          await waitForStableTail(scroller, `${author}-${distance}-received`)
        } else {
          await alice.page.waitForTimeout(250)
          const bodyOffset = await scroller.locator(`[data-msg-id="${before.firstVisibleId}"]`).evaluate((element, scrollerTestId) => {
            const root = element.closest<HTMLElement>(`[data-testid="${scrollerTestId}"]`)!
            return element.getBoundingClientRect().top - root.getBoundingClientRect().top
          }, tid.messageScroller)
          expect(Math.abs(bodyOffset - before.firstVisibleOffset!)).toBeLessThanOrEqual(1)
          const after = await waitForCommittedGeometry(scroller)
          expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
          expect(after.distanceToEnd).toBeGreaterThan(distance)
        }
        expect(composerPosts).toBe(1)
      }
    }
    expect(newestGets).toBe(1)
    await attachPassiveTrace()
  })
})
