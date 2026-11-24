import { type CaseActors, expect, test } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { CURRENT_COMMUNITY_FIXTURE_HEADERS, confirmCommunityFixtureApiResponse } from "./_fixtures/business-contract"

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

test.describe("text sidebar threads", () => {
  test("participating text threads share sidebar limits, retention and live membership with forums", async ({ caseActors }, testInfo) => {
    test.setTimeout(180_000)
    const actors = await caseActors(["alice", "bob"])
    const seed = actors.seed
    const serverId = await seed.seedServer("alice", `Thread sidebar ${Date.now()}`)
    const textId = await seed.seedChannel("alice", serverId, "engineering")
    const forumId = await seed.seedChannel("alice", serverId, "discussions", "forum")
    const restricted = await seed.seedCategory("alice", serverId, "Restricted QA", { private: true })
    const privateId = await seed.seedChannel("alice", serverId, "restricted", "text", restricted)
    await seed.seedJoinServer("alice", "bob", serverId)
    const owner = await actors.asUser("alice")
    const viewer = await actors.asUser("bob", { viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })
    const bobId = actors.userId("bob")
    const add = async (id: string) => {
      const response = await confirmCommunityFixtureApiResponse(owner.page.request.post(`/api/community/channels/${id}/participants`, { data: { userId: bobId }, headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
      expect(response.status()).toBe(201)
    }
    const threads: string[] = []
    const openers: string[] = []
    for (let index = 0; index < 7; index++) {
      const opener = await seed.seedMessage("alice", textId, `Engineering topic ${index + 1}`)
      openers.push(opener)
      const id = await seed.seedThread("alice", opener, `fallback-${index}`)
      await seed.seedMessage("alice", id, `Reply for topic ${index + 1}`)
      await add(id)
      threads.push(id)
    }
    const excludedId = await seed.seedThread("alice", await seed.seedMessage("alice", textId, "Not participating"), "excluded")
    const privateThread = await seed.seedThread("alice", await seed.seedMessage("alice", privateId, "Private opener"), "private")
    const forumThread = await seed.seedForumThread("alice", forumId, "Forum topic remains", "Forum body")
    await add(forumThread)
    const { page } = viewer
    const events: unknown[] = []
    page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
      try { const value = JSON.parse(String(payload)); if (String(value.type).startsWith("community:")) events.push(value) } catch {}
    }))
    const query = new URLSearchParams({ type: "thread", parentType: "forum,text", participating: "true", activeWithin: "72h", limitPerParent: "5", include: "parentMessage" })
    const endpoint = `/api/community/servers/${serverId}/channels?${query}`
    const canonicalResponse = await confirmCommunityFixtureApiResponse(page.request.get(endpoint, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
    expect(canonicalResponse.status()).toBe(200)
    const canonical = await canonicalResponse.json() as { canonicalChannels: Array<{ id: string; parentChannelId: string }> }
    expect(canonical.canonicalChannels.filter((row) => row.parentChannelId === textId)).toHaveLength(5)
    expect(canonical.canonicalChannels.map((row) => row.id)).not.toContain(excludedId)
    expect(canonical.canonicalChannels.map((row) => row.id)).not.toContain(privateThread)
    const legacyResponse = await confirmCommunityFixtureApiResponse(page.request.get(endpoint.replace("forum%2Ctext", "forum"), { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
    expect(legacyResponse.status()).toBe(200)
    const legacy = await legacyResponse.json() as { canonicalChannels: Array<{ id: string }> }
    expect(legacy.canonicalChannels.map((row) => row.id)).toEqual([forumThread])
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${textId}`)
    const sidebarRow = (id: string) => page.getByTestId(tid.forumSidebarThread(id))
    await expect(sidebarRow(threads[6])).toBeVisible()
    await expect(sidebarRow(threads[6])).toContainText("Engineering topic 7")
    await expect(sidebarRow(threads[0])).toHaveCount(0)
    await expect(sidebarRow(excludedId)).toHaveCount(0)
    await expect(page.getByTestId(tid.channelRow(privateId))).toHaveCount(0)
    await expect(sidebarRow(forumThread)).toBeVisible()
    await sidebarRow(threads[6]).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}/${threads[6]}`)
    await expect(sidebarRow(threads[6])).toHaveAttribute("aria-current", "page")
    await page.reload({ waitUntil: "commit" })
    await expect(sidebarRow(threads[6])).toHaveAttribute("aria-current", "page")
    await page.goto(`/c/channels/${serverId}/${threads[0]}`, { waitUntil: "commit" })
    await expect(sidebarRow(threads[0])).toBeVisible()
    await expect(sidebarRow(threads[0])).toHaveAttribute("aria-current", "page")
    const retainedResponse = await confirmCommunityFixtureApiResponse(page.request.get(`${endpoint}&retainId=${threads[0]}`, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
    expect(retainedResponse.status()).toBe(200)
    const retained = await retainedResponse.json() as { retainedChannel: { id: string } }
    expect(retained.retainedChannel.id).toBe(threads[0])

    await page.goto(`/c/channels/${serverId}/${textId}`, { waitUntil: "commit" })
    await expect(sidebarRow(threads[6])).toBeVisible()
    await add(excludedId)
    await expect(sidebarRow(excludedId)).toBeVisible()
    const remove = await confirmCommunityFixtureApiResponse(page.request.delete(`/api/community/channels/${excludedId}/participants/${bobId}`, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
    expect(remove.status()).toBe(204)
    await expect(sidebarRow(excludedId)).toHaveCount(0)
    await seed.seedMessage("alice", threads[0], "Live activity lifts the oldest thread")
    await expect(sidebarRow(threads[0])).toBeVisible()
    const ordered = await page.locator(`[data-testid^="${tid.forumSidebarThread("")}"]`).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")))
    expect(ordered.indexOf(tid.forumSidebarThread(threads[0]))).toBeLessThan(ordered.indexOf(tid.forumSidebarThread(threads[6])))
    await expect.poll(() => events.some((event) => JSON.stringify(event).includes(excludedId))).toBe(true)
    const membershipResponse = await confirmCommunityFixtureApiResponse(page.request.get(`/api/community/channels/${threads[0]}/members?relation=notify`, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
    expect(membershipResponse.status()).toBe(200)
    const membership = await membershipResponse.json() as { members: Array<{ userId: string }> }
    expect(membership.members.map((member) => member.userId)).toContain(bobId)

    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => localStorage.setItem("theme", value), theme)
      await page.reload({ waitUntil: "commit" })
      await expect(sidebarRow(threads[0])).toBeVisible()
      await expect(sidebarRow(forumThread)).toBeVisible()
      await expect(page.getByTestId(tid.message(openers[0]))).toBeVisible()
      await testInfo.attach(`text-sidebar-${theme}`, { body: await page.screenshot(), contentType: "image/png" })
    }
    const mobile = await actors.asUser("bob", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" })
    await mobile.page.goto(`/c/channels/${serverId}`, { waitUntil: "commit" })
    await expect(mobile.page.getByTestId(tid.forumSidebarThread(threads[0]))).toBeVisible()
    await expect(mobile.page.getByTestId(tid.forumSidebarThread(forumThread))).toBeVisible()
    await testInfo.attach("text-sidebar-mobile", { body: await mobile.page.screenshot(), contentType: "image/png" })
    await testInfo.attach("text-sidebar-api-ws", { body: JSON.stringify({ serverId, textId, forumId, threads, excludedId, privateThread, canonical, legacy, retained, membership, events }), contentType: "application/json" })
  })
})
