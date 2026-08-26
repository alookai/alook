import type { Frame } from "@playwright/test"
import { test, expect, userId, userName } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { sendMessage } from "./_fixtures/actions"
import { seedDm, seedBlock, seedDmMessage } from "./_fixtures/seed"

const DM_ROUTE_AUTHORITY_HEADER = "x-alook-dm-route-verification"

// Journey 4 — DMs. human↔human needs only not-blocked (no friendship). Covers
// the new-conversation-appears-live path and the blocked-composer regression.
test.describe.serial("direct messages", () => {
  test("an Inbox first-DM click commits immediately and stays on the conversation", async ({ asUser }) => {
    const bob = await asUser("bob")
    const initialDms = bob.page.waitForResponse((response) =>
      response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/community/users/me/dms",
    )
    await bob.page.goto("/c/me")
    expect((await initialDms).status()).toBe(200)

    let postClickAuthorityGets = 0
    const dmsPattern = "**/api/community/users/me/dms"
    await bob.page.route(dmsPattern, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue()
        return
      }
      if (route.request().headers()[DM_ROUTE_AUTHORITY_HEADER] !== "1") {
        await route.continue()
        return
      }
      postClickAuthorityGets += 1
      await route.continue()
    })

    const dmId = await seedDm("alice", userId("bob"))
    const body = `first inbox DM ${Date.now()}`
    const messageId = await seedDmMessage("alice", dmId, body)
    const routeHistory: string[] = []
    const recordRoute = (frame: Frame) => {
      if (frame === bob.page.mainFrame()) routeHistory.push(new URL(frame.url()).pathname)
    }
    bob.page.on("framenavigated", recordRoute)

    try {
      await bob.page.getByRole("button", { name: "Inbox" }).click()
      const inboxRow = bob.page.getByTestId(tid.inboxUnreadDm(dmId))
      await expect(inboxRow).toBeVisible({ timeout: 20_000 })
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
      expect(postClickAuthorityGets).toBe(0)
    } finally {
      bob.page.off("framenavigated", recordRoute)
      await bob.page.unroute(dmsPattern)
    }
  })

  test("a canonical DM skips authority and keeps known chrome while read-state and messages load", async ({ asUser }) => {
    const dmId = await seedDm("alice", userId("bob"))
    const body = `held DM message ${Date.now()}`
    const messageId = await seedDmMessage("bob", dmId, body)
    const alice = await asUser("alice")
    let canonicalDmsGets = 0
    let authorityGets = 0
    const interactiveMutations: string[] = []
    alice.page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname
      if (request.method() === "GET" && pathname === "/api/community/users/me/dms") {
        if (request.headers()[DM_ROUTE_AUTHORITY_HEADER] === "1") authorityGets += 1
        else canonicalDmsGets += 1
      }
      if (request.method() !== "GET" && pathname.startsWith(`/api/community/channels/${dmId}`)) {
        interactiveMutations.push(`${request.method()} ${pathname}`)
      }
    })

    let releaseRead!: () => void
    let readFinished!: () => void
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    const readSettled = new Promise<void>((resolve) => { readFinished = resolve })
    const readPattern = `**/api/community/channels/${dmId}/read-state`
    await alice.page.route(readPattern, async (route) => {
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
      await expect(alice.page.getByRole("heading", {
        level: 1,
        name: new RegExp(userName("bob")),
      })).toBeVisible({ timeout: 20_000 })
      await expect(alice.page.getByTestId(tid.composerInput)).toBeVisible()
      await expect(alice.page.getByTestId(tid.messageScroller).locator('[data-slot="skeleton"]')).not.toHaveCount(0)

      releaseRead()
      await readSettled
      await messagesRequest
      await expect(alice.page.getByRole("heading", {
        level: 1,
        name: new RegExp(userName("bob")),
      })).toBeVisible()
      await expect(alice.page.getByTestId(tid.composerInput)).toBeVisible()
      await expect(alice.page.getByTestId(tid.messageScroller).locator('[data-slot="skeleton"]')).not.toHaveCount(0)
      expect(canonicalDmsGets).toBeGreaterThanOrEqual(1)
      expect(authorityGets).toBe(0)
      expect(interactiveMutations).toEqual([])

      releaseMessages()
      await messagesSettled
      await expect(alice.page.getByTestId(tid.message(messageId))).toHaveCount(1)
      await expect(alice.page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
    } finally {
      releaseRead()
      releaseMessages()
      await readSettled
      await messagesSettled
      await alice.page.unroute(readPattern)
      await alice.page.unroute(messagesPattern)
    }
  })

  test("an absent DM verifies once per attempt and exposes transient Retry locally", async ({ asUser }) => {
    const alice = await asUser("alice")
    const missingDmId = `dm-missing-${Date.now()}`
    let canonicalDmsGets = 0
    let authorityGets = 0
    const dmsPattern = "**/api/community/users/me/dms"
    await alice.page.route(dmsPattern, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue()
        return
      }
      if (route.request().headers()[DM_ROUTE_AUTHORITY_HEADER] !== "1") {
        canonicalDmsGets += 1
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: [] }) })
        return
      }
      authorityGets += 1
      if (authorityGets === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary" }) })
        return
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: [] }) })
    })

    try {
      await alice.page.goto(`/c/me/${missingDmId}`)
      await expect(alice.page.getByRole("alert").filter({
        hasText: "Couldn\'t verify this conversation",
      })).toBeVisible()
      await expect(alice.page).toHaveURL(new RegExp(`/c/me/${missingDmId}$`))
      expect(canonicalDmsGets).toBeGreaterThanOrEqual(1)
      expect(authorityGets).toBe(1)

      await alice.page.getByRole("button", { name: "Retry" }).click()
      await expect.poll(() => authorityGets).toBe(2)
      await expect.poll(() => new URL(alice.page.url()).pathname).toBe("/c/me/friends")
    } finally {
      await alice.page.unroute(dmsPattern)
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
    // Carol blocks Bob, then opens a DM with him: composer is replaced.
    const dmId = await seedDm("carol", userId("bob"))
    await seedBlock("carol", userId("bob"))

    const carol = await asUser("carol")
    await carol.page.goto(`/c/me/${dmId}`)
    await carol.page.waitForURL(new RegExp(dmId), { timeout: 20_000 , waitUntil: "commit" })

    await expect(carol.page.getByTestId(tid.dmBlockedNotice)).toBeVisible()
    await expect(carol.page.getByTestId(tid.composerInput)).toHaveCount(0)
  })
})
