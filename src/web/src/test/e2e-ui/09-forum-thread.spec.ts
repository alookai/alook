import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable, sendMessage } from "./_fixtures/actions"

import { tid } from "./_fixtures/testids"
import type { CaseActors } from "./_fixtures/case-fixture"

// Journey 9 — threads. Creating a thread from a message surfaces a thread
// indicator on the parent message (regression ab572e3e).
test.describe("threads", () => {
  async function prepareCase1(actors: CaseActors) {
    const { seedServer, seedChannel, seedMessage } = actors.seed
    const serverId: string = await seedServer("alice", `Thread ${Date.now()}`)
    const channelId: string = await seedChannel("alice", serverId, "threads")
    // Seed the parent message via API so it's already persisted with a real
    // id before the UI opens. Sending the FIRST message through the UI in a
    // cold, directly-navigated channel races the list's initial fetch (the
    // empty pre-send snapshot can land last and clobber the row) — that's a
    // test-harness timing issue, not a product bug (spec 02/03 cover the send
    // UI). Seeding sidesteps the race so this journey can focus on threads.
    await seedMessage("alice", channelId, `thread parent ${Date.now()}`)
    return { serverId, channelId }
  }

  test("creating a thread from a message shows a thread indicator on the parent", async ({ caseActors }) => {
    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    const requests: string[] = []
    page.on("request", (request) => requests.push(request.url()))
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })

    // The seeded parent message renders (real id, not a racy optimistic row).
    const row = page.getByText("thread parent", { exact: false }).first()
    await expect(row).toBeVisible({ timeout: 20_000 })

    const threadMessagesLoaded = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === "GET" &&
        url.pathname.startsWith("/api/community/channels/") &&
        url.pathname.endsWith("/messages") &&
        url.pathname !== `/api/community/channels/${channelId}/messages` &&
        response.ok()
    })

    // Open the message's more-menu → Create Thread. Retry the open since the
    // hover toolbar can close between the hover and the menu click.
    await expect(async () => {
      await row.hover()
      await page.getByRole("button", { name: "More actions" }).first().click({ timeout: 3_000 })
      await page.getByRole("menuitem", { name: "Create Thread" }).click({ timeout: 3_000 })
    }).toPass({ timeout: 20_000 })

    // Thread creation navigates off the parent channel into the thread child.
    await page.waitForURL((url) => !url.pathname.endsWith(`/${channelId}`), { timeout: 20_000, waitUntil: "commit" })
    const threadId = new URL(page.url()).pathname.split("/").at(-1)!
    const threadMessagesResponse = await threadMessagesLoaded
    expect(new URL(threadMessagesResponse.url()).pathname).toBe(`/api/community/channels/${threadId}/messages`)
    const threadPanel = page.getByTestId(tid.threadSplitPanel)
    await expect(composerEditable(page, threadPanel)).toBeVisible()

    // The thread is usable: a reply posts and appears in the thread view.
    const reply = `first reply ${Date.now()}`
    await sendMessage(page, reply, threadPanel)
    await expect(page.getByText(reply, { exact: false }).first()).toBeVisible({ timeout: 15_000 })

    const exactChannelRequests = requests.filter((requestUrl) =>
      new URL(requestUrl).pathname === `/api/community/channels/${threadId}`
    ).length
    const retainedSidebarRequests = requests.filter((requestUrl) => {
      const url = new URL(requestUrl)
      return url.pathname === `/api/community/servers/${serverId}/channels` &&
        url.searchParams.get("retainId") === threadId
    }).length
    await test.info().attach("thread-route-request-counts", {
      body: JSON.stringify({ exactChannelRequests, retainedSidebarRequests }),
      contentType: "application/json",
    })
    console.log(`thread-route requests exact=${exactChannelRequests} retained=${retainedSidebarRequests}`)
    expect(exactChannelRequests).toBeLessThanOrEqual(3)
    expect(retainedSidebarRequests).toBeLessThanOrEqual(3)

    // Back on the parent channel, the message now carries a thread indicator.
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(`[data-testid^="${tid.threadIndicator("")}"]`).first()).toBeVisible({ timeout: 15_000 })
  })
})
