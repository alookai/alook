import type { Frame } from "@playwright/test"
import { test, expect, userId, userName } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { sendMessage } from "./_fixtures/actions"
import { proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { seedDm, seedDmMessage } from "./_fixtures/seed"
import { captureNotificationRequests, gotoAfterNotificationStartup, notificationPaths, notificationResponsesFinished } from "./_fixtures/community-notification-requests"
import { lastMeLocationKey } from "@/lib/community/last-me-location"

// Journey 4 — DMs. human↔human needs only not-blocked (no friendship). Covers
// the new-conversation-appears-live path and the blocked-composer regression.
test.describe.serial("direct messages", () => {
  test("an Inbox first-DM click commits immediately and stays on the conversation", async ({ asUser }, testInfo) => {
    const bob = await asUser("bob")
    const trace = captureNotificationRequests(bob.page)
    const proxy = await gotoAfterNotificationStartup(bob.page, bob.context, trace)
    trace.phase("notification")

    let dmsGets = 0
    const dmsPattern = "**/api/community/users/me/dms"
    await bob.page.route(dmsPattern, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue()
        return
      }
      dmsGets += 1
      await route.continue()
    })

    const notificationRefresh = notificationResponsesFinished(
      bob.page,
      notificationPaths.filter((path) => path.endsWith("/attention")),
    )
    const dmId = await seedDm("alice", userId("bob"))
    const body = `first inbox DM ${Date.now()}`
    const messageId = await seedDmMessage("alice", dmId, body)
    await expect.poll(() => trace.events.some((event) =>
      event.type === "community:unread.bump" && event.channelId === dmId && event.userId === userId("bob"))).toBe(true)
    await notificationRefresh
    expect(dmsGets).toBe(0)
    const routeHistory: string[] = []
    const recordRoute = (frame: Frame) => {
      if (frame === bob.page.mainFrame()) routeHistory.push(new URL(frame.url()).pathname)
    }
    bob.page.on("framenavigated", recordRoute)

    try {
      await bob.page.getByRole("button", { name: "Inbox" }).click()
      const inboxRow = bob.page.getByTestId(tid.inboxUnreadDm(dmId))
      await expect(inboxRow).toBeVisible({ timeout: 20_000 })
      trace.phase("click")
      const dmsGetsBeforeClick = dmsGets
      expect(dmsGetsBeforeClick).toBe(0)
      await inboxRow.click()

      await bob.page.waitForURL(new RegExp(`/c/me/${dmId}$`), {
        timeout: 20_000,
        waitUntil: "commit",
      })
      await expect(bob.page.getByRole("heading", {
        level: 1,
        name: new RegExp(userName("alice")),
      })).toBeVisible()
      expect(routeHistory).not.toContain("/c/me")

      await expect(bob.page.getByTestId(tid.message(messageId))).toHaveCount(1)
      await expect(bob.page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
      await expect(bob.page).toHaveURL(new RegExp(`/c/me/${dmId}$`))
      expect(routeHistory).not.toContain("/c/me")
      trace.phase("click-complete")
      expect(dmsGets - dmsGetsBeforeClick).toBe(0)
    } finally {
      bob.page.off("framenavigated", recordRoute)
      await bob.page.unroute(dmsPattern)
      await testInfo.attach("community-request-timeline", {
        body: JSON.stringify({ connectionFrames: proxy.connectionFrames, timeline: trace.timeline, dmsGets }, null, 2),
        contentType: "application/json",
      })
    }
  })

  test("a canonical DM keeps its title while history permission gates body and composer", async ({ asUser }) => {
    const dmId = await seedDm("alice", userId("bob"))
    const body = `held DM message ${Date.now()}`
    const messageId = await seedDmMessage("bob", dmId, body)
    const alice = await asUser("alice")
    const wsProxy = await proxyCommunityWebSockets(alice.context, {
      decideConnectionFrame: (frame) => frame.type === "auth.ok" ? "hold" : "forward",
    })
    let dmsGets = 0
    const interactiveMutations: string[] = []
    alice.page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname
      if (request.method() === "GET" && pathname === "/api/community/users/me/dms") {
        dmsGets += 1
      }
      if (request.method() !== "GET" && pathname.startsWith(`/api/community/channels/${dmId}`)) {
        interactiveMutations.push(`${request.method()} ${pathname}`)
      }
    })

    let releaseMetadata!: () => void
    let metadataStarted!: () => void
    let metadataFinished!: () => void
    const metadataGate = new Promise<void>(resolve => { releaseMetadata = resolve })
    const metadataRequest = new Promise<void>(resolve => { metadataStarted = resolve })
    const metadataSettled = new Promise<void>(resolve => { metadataFinished = resolve })
    const metadataPattern = (url: URL) => url.pathname === `/api/community/channels/${dmId}`
    await alice.page.route(metadataPattern, async route => {
      if (route.request().method() !== "GET") { await route.continue(); return }
      metadataStarted()
      try {
        await metadataGate
        await route.continue()
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("already handled"))) throw error
      } finally { metadataFinished() }
    })

    let releaseRead!: () => void
    let readStarted!: () => void
    let readFinished!: () => void
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    const readRequest = new Promise<void>((resolve) => { readStarted = resolve })
    const readSettled = new Promise<void>((resolve) => { readFinished = resolve })
    const readPattern = `**/api/community/channels/${dmId}/read-state`
    await alice.page.route(readPattern, async (route) => {
      readStarted()
      try {
        await readGate
        await route.continue()
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("already handled"))) throw error
      } finally {
        readFinished()
      }
    })

    let releaseMessages!: () => void
    let messagesStarted!: () => void
    let messagesFinished!: () => void
    const messagesGate = new Promise<void>((resolve) => { releaseMessages = resolve })
    const messagesRequest = new Promise<void>((resolve) => { messagesStarted = resolve })
    const messagesSettled = new Promise<void>((resolve) => { messagesFinished = resolve })
    let heldMessages = false
    const messagesPattern = `**/api/community/channels/${dmId}/messages*`
    await alice.page.route(messagesPattern, async (route) => {
      if (route.request().method() !== "GET" || heldMessages) {
        await route.continue()
        return
      }
      heldMessages = true
      messagesStarted()
      try {
        await messagesGate
        await route.continue()
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("already handled"))) throw error
      } finally {
        messagesFinished()
      }
    })

    try {
      await alice.page.goto(`/c/me/${dmId}`)
      const dmHeader = alice.page.getByTestId(tid.dmHeader)
      const dmTitle = alice.page.getByTestId(tid.dmHeaderTitle)
      await expect(dmHeader).toHaveCount(1, { timeout: 20_000 })
      await expect(dmTitle).toContainText(userName("bob"))
      await metadataRequest
      await readRequest
      await expect(alice.page.locator('[data-onboarding-target="dm-composer"] [data-slot="skeleton"]').first()).toBeVisible()
      await expect(alice.page.getByTestId(tid.composerInput)).toHaveCount(0)
      await expect(alice.page.getByTestId(tid.message(messageId))).toHaveCount(0)
      await expect(alice.page.getByTestId(tid.messageScroller).locator('[data-slot="skeleton"]')).not.toHaveCount(0)

      const metadataResponse = alice.page.waitForResponse(response => response.request().method() === "GET" && metadataPattern(new URL(response.url())))
      releaseMetadata()
      await metadataSettled
      const permission = await metadataResponse
      expect(permission.status()).toBe(200)
      expect(permission.headers()["x-alook-community-contract"]).toBe("2")
      const resource = await permission.json()
      expect(resource.channel.id).toBe(dmId)
      expect(resource.access).toMatchObject({ channelId: dmId, canRead: true })
      await expect(alice.page.getByTestId(tid.composerInput)).toBeVisible()
      await expect(alice.page.getByTestId(tid.message(messageId))).toHaveCount(0)
      await expect(alice.page.getByTestId(tid.messageScroller).locator('[data-slot="skeleton"]')).not.toHaveCount(0)

      releaseRead()
      await readSettled
      await messagesRequest
      await expect(dmHeader).toHaveCount(1)
      await expect(dmTitle).toContainText(userName("bob"))
      await expect(alice.page.getByTestId(tid.composerInput)).toBeVisible()
      await expect(alice.page.getByTestId(tid.messageScroller).locator('[data-slot="skeleton"]')).not.toHaveCount(0)
      await expect.poll(() => wsProxy.heldConnectionCount()).toBe(1)
      expect(dmsGets).toBe(1)
      expect(interactiveMutations).toEqual([])

      releaseMessages()
      await messagesSettled
      await expect(alice.page.getByTestId(tid.composerInput)).toBeVisible()
      await expect(alice.page.getByTestId(tid.message(messageId))).toHaveCount(1)
      await expect(alice.page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
    } finally {
      releaseMetadata()
      releaseRead()
      releaseMessages()
      await metadataSettled
      await readSettled
      await messagesSettled
      await alice.page.unroute(metadataPattern)
      await alice.page.unroute(readPattern)
      await alice.page.unroute(messagesPattern)
    }
  })

  test("an absent DM verifies once per attempt and exposes transient Retry locally", async ({ asUser }) => {
    const alice = await asUser("alice")
    const wsProxy = await proxyCommunityWebSockets(alice.context, {
      decideConnectionFrame: (frame) => frame.type === "auth.ok" ? "hold" : "forward",
    })
    await alice.page.addInitScript((storageKey) => localStorage.removeItem(storageKey), lastMeLocationKey())
    const missingDmId = `dm-missing-${Date.now()}`
    let canonicalDmsGets = 0
    let metadataGets = 0
    const dmsPattern = "**/api/community/users/me/dms"
    const metadataPattern = `**/api/community/channels/${missingDmId}`
    await alice.page.route(dmsPattern, async (route) => {
      canonicalDmsGets += 1
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: [] }) })
    })
    await alice.page.route(metadataPattern, async (route) => {
      metadataGets += 1
      await route.fulfill({ status: metadataGets === 1 ? 503 : 404,
        contentType: "application/json", body: JSON.stringify({ error: metadataGets === 1 ? "temporary" : "missing" }) })
    })

    try {
      await alice.page.goto(`/c/me/${missingDmId}`)
      await expect.poll(() => wsProxy.heldConnectionCount()).toBe(1)
      expect(wsProxy.releaseHeldConnections((frame) => frame.type === "auth.ok")).toBe(1)
      await expect(alice.page.getByTestId(tid.wsReconnectOverlay)).toHaveCount(0)

      const verificationAlert = alice.page.getByRole("alert").filter({
        hasText: "Couldn\'t verify this conversation",
      })
      await expect(verificationAlert).toBeVisible()
      await expect(alice.page).toHaveURL(new RegExp(`/c/me/${missingDmId}$`))
      await expect.poll(() => canonicalDmsGets).toBe(1)
      await expect(verificationAlert).toBeVisible()
      await expect(alice.page).toHaveURL(new RegExp(`/c/me/${missingDmId}$`))
      expect(metadataGets).toBe(1)

      await verificationAlert.getByRole("button", { name: "Retry" }).click()
      await expect.poll(() => metadataGets).toBe(2)
      expect(canonicalDmsGets).toBe(1)
      await expect.poll(() => new URL(alice.page.url()).pathname).toBe("/c/me/friends")
    } finally {
      wsProxy.releaseHeldConnections()
      await alice.page.unroute(dmsPattern)
      await alice.page.unroute(metadataPattern)
    }
  })

  test("a DM message reaches the peer live and the conversation appears without reload", async ({ asUser }) => {
    // Alice opens a DM to Bob via API (precondition), then both drive the UI.
    const dmId = await seedDm("alice", userId("bob"))

    const alice = await asUser("alice")
    const bob = await asUser("bob")
    await alice.page.goto(`/c/me/${dmId}`)
    await bob.page.goto("/c/me")
    await alice.page.waitForURL(new RegExp(dmId), { timeout: 20_000 , waitUntil: "commit" })

    const body = `dm hello ${Date.now()}`
    const responsePromise = alice.page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname
      return response.request().method() === "POST"
        && pathname === `/api/community/channels/${dmId}/messages`
    })
    await sendMessage(alice.page, body)
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const payload = await response.json() as { message: { id: string; seq: number } }
    expect(payload.message.seq).toBeGreaterThan(0)
    await expect(alice.page.getByTestId(tid.message(payload.message.id))).toHaveCount(1)
    await expect(alice.page.getByTestId(tid.composerInput)).toHaveText("")

    // Revisit through the DM index. The accepted row must remain canonical
    // exactly once while the base query catches up to the session overlay.
    await alice.page.goto("/c/me", { waitUntil: "commit" })
    await alice.page.goto(`/c/me/${dmId}`, { waitUntil: "commit" })
    await expect(alice.page.getByTestId(tid.message(payload.message.id))).toHaveCount(1)

    // Bob's DM sidebar row shows the new conversation without a manual reload.
    await expect(bob.page.getByTestId(tid.dmRow(dmId))).toBeVisible({ timeout: 15_000 })
    await bob.page.getByTestId(tid.dmRow(dmId)).click()
    // Bob lands in the DM; the message list fetch on a freshly-opened DM can
    // lag, so give the body a generous window rather than the default.
    await bob.page.waitForURL(new RegExp(dmId), { timeout: 20_000 , waitUntil: "commit" })
    await expect(bob.page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
    await expect(bob.page.getByTestId(tid.message(payload.message.id))).toHaveCount(1)
  })

  test("blocking replaces the composer with a blocked notice", async ({ asUser }) => {
    const dmId = await seedDm("carol", userId("bob"))
    const body = `visible before block ${Date.now()}`
    const messageId = await seedDmMessage("carol", dmId, body)
    const carol = await asUser("carol")
    const bob = await asUser("bob")
    const bobProxy = await proxyCommunityWebSockets(bob.context)
    await carol.page.goto(`/c/me/${dmId}`)
    await bob.page.goto(`/c/me/${dmId}`)
    for (const page of [carol.page, bob.page]) {
      await expect(page.getByTestId(tid.message(messageId))).toBeVisible()
      await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    }
    await expect.poll(() => bobProxy.connectionFrames.some((frame) => frame.type === "auth.ok")).toBe(true)
    await carol.page.goto("/c/me/friends")
    const bobRow = carol.page.getByRole("button").filter({ hasText: userName("bob") })
    await expect(bobRow).toHaveCount(1)
    await bobRow.click({ button: "right" })
    const blockResponse = carol.page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/community/users/${userId("bob")}/block`)
    await carol.page.getByRole("menuitem", { name: "Block", exact: true }).click()
    expect((await blockResponse).status()).toBe(200)
    await expect(bob.page.getByTestId(tid.message(messageId))).toHaveCount(0)
    await expect(bob.page.getByTestId(tid.composerInput)).toHaveCount(0)
    await expect(bob.page.getByRole("alert").filter({ hasText: "You can no longer read this conversation." })).toBeVisible()
    await expect(bob.page.getByTestId(tid.dmBlockedNotice)).toHaveCount(0)
    await expect(bob.page).toHaveURL(new RegExp(`/c/me/${dmId}$`))

    await carol.page.getByTestId(tid.dmRow(dmId)).click()
    await expect(carol.page.getByTestId(tid.dmBlockedNotice)).toBeVisible()
    await expect(carol.page.getByTestId(tid.composerInput)).toHaveCount(0)
    await expect(carol.page.getByTestId(tid.message(messageId))).toHaveCount(0)
  })
})
