import { communityFixtureFetch } from "./_fixtures/business-contract"
import { devices } from "@playwright/test"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER, DEFAULT_MESSAGE_PAGE_SIZE, type CommunityConversationEntryRead } from "@alook/shared"
import { expect, test } from "./_fixtures/case-fixture"
import { composerEditable } from "./_fixtures/actions"
import { expectPublicCommunityDocument } from "./_fixtures/community-ssr-frame"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import { prepareCase1 } from "./_fixtures/mobile-notification-activation"

test.describe("mobile notification chat routes (native bridge simulation)", () => {
test("ordinary channel msg permalink retains its message anchor", async ({ caseActors }, testInfo) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId, channelMessageId } = await prepareCase1(actors)
    const laterIds: string[] = []
    for (let index = 0; index < DEFAULT_MESSAGE_PAGE_SIZE + 8; index += 1) {
      laterIds.push(await actors.seed.seedMessage("alice", channelId, `Later window message ${index}`))
    }
    const readPointer = laterIds[DEFAULT_MESSAGE_PAGE_SIZE]
    const checkpoint = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
      method: "PUT",
      headers: { Cookie: actors.sessionCookie("bob"), Origin: WEB_URL, "Content-Type": "application/json" },
      body: JSON.stringify({ lastReadMessageId: readPointer }),
    })
    expect(checkpoint.ok).toBe(true)
    const defaultResponse = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channelId}/messages?entry=1`, { headers: { Cookie: actors.sessionCookie("bob"), [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })
    expect(defaultResponse.ok, `entry precondition status ${defaultResponse.status}`).toBe(true)
    const defaultEntry = await defaultResponse.json() as CommunityConversationEntryRead
    expect(defaultEntry.selection).toEqual({ reason: "read_pointer", anchorMessageId: readPointer })
    expect(defaultEntry.messages.some(message => message.id === channelMessageId)).toBe(false)
    expect(readPointer).not.toBe(laterIds.at(-1))

    const { page } = await asUser("bob", devices["iPhone 13"])
    const entryResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return response.request().method() === "GET" && url.pathname === `/api/community/channels/${channelId}/messages`
        && url.searchParams.get("entry") === "1" && url.searchParams.get("anchor") === channelMessageId
    })
    const response = await page.goto(`/c/channels/${serverId}/${channelId}?msg=${channelMessageId}`)
    expect(response?.ok()).toBe(true)
    const html = await response!.text()
    expectPublicCommunityDocument(html)
    const explicitResponse = await entryResponse
    expect(explicitResponse.ok()).toBe(true)
    const explicitEntry = await explicitResponse.json() as CommunityConversationEntryRead
    expect(explicitEntry.selection).toEqual({ reason: "explicit_anchor", anchorMessageId: channelMessageId })
    expect(explicitEntry.surfaceReceipt).toEqual({ channelId, surfaceKind: "channel" })
    expect(explicitEntry.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: channelMessageId })]))
    expect(explicitEntry.messages.some(message => message.id === readPointer)).toBe(false)
    const target = page.getByTestId(tid.message(channelMessageId))
    await expect(target).toBeVisible()
    await expect(target.locator(".group").first()).toHaveClass(/bg-primary\/10/)
    const position = () => target.evaluate((node, scrollerId) => {
      const root = node.closest(`[data-testid="${scrollerId}"]`) as HTMLElement
      const rect = node.getBoundingClientRect()
      const viewport = root.getBoundingClientRect()
      return { inView: rect.top >= viewport.top && rect.bottom <= viewport.bottom, scrollTop: root.scrollTop, ready: root.querySelector("[data-read-position-ready]")?.getAttribute("data-read-position-ready") }
    }, tid.messageScroller)
    await expect.poll(position).toMatchObject({ inView: true, ready: "true" })
    await expect(page).toHaveURL(`${WEB_URL}/c/channels/${serverId}/${channelId}`)
    await expect(composerEditable(page)).toBeVisible({ timeout: 30_000 })
    await testInfo.attach("msg-anchor-evidence", { body: JSON.stringify({ status: response!.status(), htmlBytes: Buffer.byteLength(html), selection: explicitEntry.selection, surfaceReceipt: explicitEntry.surfaceReceipt, anchorId: channelMessageId, readPointer, latestId: laterIds.at(-1), defaultWindowIds: defaultEntry.messages.map(message => message.id), explicitWindowIds: explicitEntry.messages.map(message => message.id), position: await position(), url: page.url() }), contentType: "application/json" })
  })
})
