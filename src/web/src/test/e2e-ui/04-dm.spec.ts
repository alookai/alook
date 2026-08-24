import type { Frame } from "@playwright/test"
import { test, expect, userId, userName } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { sendMessage } from "./_fixtures/actions"
import { seedDm, seedBlock, seedDmMessage } from "./_fixtures/seed"

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

    let releaseAuthority!: () => void
    let authorityStarted!: () => void
    let authorityFinished!: () => void
    const authorityGate = new Promise<void>((resolve) => { releaseAuthority = resolve })
    const authorityRequest = new Promise<void>((resolve) => { authorityStarted = resolve })
    const authoritySettled = new Promise<void>((resolve) => { authorityFinished = resolve })
    let held = false
    const dmsPattern = "**/api/community/users/me/dms"
    await bob.page.route(dmsPattern, async (route) => {
      if (held || route.request().method() !== "GET") {
        await route.continue()
        return
      }
      held = true
      authorityStarted()
      try {
        await authorityGate
        await route.continue()
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("already handled"))) throw error
      } finally {
        authorityFinished()
      }
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
      await authorityRequest

      await bob.page.waitForURL(new RegExp(`/c/me/${dmId}$`), {
        timeout: 20_000,
        waitUntil: "commit",
      })
      await expect(bob.page.getByRole("heading", {
        level: 1,
        name: new RegExp(userName("alice")),
      })).toBeVisible()
      expect(routeHistory).not.toContain("/c/me")

      const authorityResponse = bob.page.waitForResponse((response) =>
        response.request().method() === "GET"
        && new URL(response.url()).pathname === "/api/community/users/me/dms",
      )
      releaseAuthority()
      expect((await authorityResponse).status()).toBe(200)
      await expect(bob.page.getByTestId(tid.message(messageId))).toHaveCount(1)
      await expect(bob.page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
      await expect(bob.page).toHaveURL(new RegExp(`/c/me/${dmId}$`))
      expect(routeHistory).not.toContain("/c/me")
    } finally {
      releaseAuthority()
      await authoritySettled
      bob.page.off("framenavigated", recordRoute)
      await bob.page.unroute(dmsPattern)
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
