import { CommunityConversationEntryReadSchema, CommunityMessagesReadSchema } from "@alook/shared"
import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { tid } from "./_fixtures/testids"
import { VIEWPORT, seedProfile, establishExactPinnedPrecondition, waitForStableTail, messageCreateCount, seedScrollServer } from "./_fixtures/message-scroll-characterization"

test.describe("message scroll characterization", () => {
test("jumping to present lets the next peer message follow the tail", async ({ caseActors }) => {
    test.setTimeout(180_000)
    const actors = await caseActors(["alice", "bob", "carol"])
    const serverId = await seedScrollServer(actors)
    const channelId = await actors.seed.seedChannel("alice", serverId, `scroll-upward-${Date.now()}`)
    const profile = await seedProfile(actors, channelId, 121, false, "rotate", 23)
    const alice = await actors.asUser("alice")
    await alice.page.setViewportSize(VIEWPORT)
    const proxy = await proxyCommunityWebSockets(alice.context)
    const entryResponse = alice.page.waitForResponse(response => {
      const url = new URL(response.url())
      return response.request().method() === "GET" && url.pathname === `/api/community/channels/${channelId}/messages`
        && url.searchParams.get("entry") === "1"
    })
    const neighborResponse = alice.page.waitForResponse(response => {
      const url = new URL(response.url())
      return response.request().method() === "GET" && url.pathname === `/api/community/channels/${channelId}/messages`
        && url.searchParams.has("since")
    })
    void entryResponse.catch(() => undefined)
    void neighborResponse.catch(() => undefined)
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}?msg=${profile.ids[23]}`)
    const scroller = alice.page.getByTestId(tid.messageScroller)
    await expect(scroller).toBeVisible({ timeout: 30_000 })
    const entryRead = await entryResponse, neighborRead = await neighborResponse
    expect(entryRead.status()).toBe(200)
    expect(neighborRead.status()).toBe(200)
    const entry = CommunityConversationEntryReadSchema.parse(await entryRead.json())
    const neighbor = CommunityMessagesReadSchema.parse(await neighborRead.json())
    expect(new URL(neighborRead.url()).searchParams.get("since")).toBe(entry.page.newerCursor)
    expect(neighbor.page.hasMoreNewer).toBe(true)
    expect([...entry.messages, ...neighbor.messages].some(message => message.id === profile.ids.at(-1))).toBe(false)
    const present = alice.page.getByTestId(tid.scrollToPresent)
    await expect(present).toBeVisible({ timeout: 30_000 })
    await present.click()
    await expect(alice.page.getByTestId(tid.message(profile.ids.at(-1)!)))
      .toBeVisible({ timeout: 30_000 })
    await expect(present).toHaveCount(0)
    await waitForStableTail(scroller, "remote-fixture-tail")
    await establishExactPinnedPrecondition(scroller, "remote-pinned", 0)
    const pinnedBody = `remote pinned ${Date.now()}`
    const pinnedId = await actors.seed.seedMessage("bob", channelId, pinnedBody)
    await expect.poll(() => messageCreateCount(proxy.frames, channelId, pinnedBody)).toBe(1)
    await expect(alice.page.getByTestId(tid.message(pinnedId))).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => scroller.evaluate((element) =>
      Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
  })
})
