import { test, expect, userId } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { sendMessage } from "./_fixtures/actions"
import { seedDm, seedBlock } from "./_fixtures/seed"

// Journey 4 — DMs. human↔human needs only not-blocked (no friendship). Covers
// the new-conversation-appears-live path and the blocked-composer regression.
test.describe.serial("direct messages", () => {
  test("a DM message reaches the peer live and the conversation appears without reload", async ({ asUser }) => {
    // Alice opens a DM to Bob via API (precondition), then both drive the UI.
    const dmId = await seedDm("alice", userId("bob"))

    const alice = await asUser("alice")
    const bob = await asUser("bob")
    await alice.page.goto(`/c/me/${dmId}`)
    await bob.page.goto("/c/me")
    await alice.page.waitForURL(new RegExp(dmId), { timeout: 20_000 })

    const body = `dm hello ${Date.now()}`
    await sendMessage(alice.page, body)

    // Bob's DM sidebar row shows the new conversation without a manual reload.
    await expect(bob.page.getByTestId(tid.dmRow(dmId))).toBeVisible({ timeout: 15_000 })
    await bob.page.getByTestId(tid.dmRow(dmId)).click()
    // Bob lands in the DM; the message list fetch on a freshly-opened DM can
    // lag, so give the body a generous window rather than the default.
    await bob.page.waitForURL(new RegExp(dmId), { timeout: 20_000 })
    await expect(bob.page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  })

  test("blocking replaces the composer with a blocked notice", async ({ asUser }) => {
    // Carol blocks Bob, then opens a DM with him: composer is replaced.
    const dmId = await seedDm("carol", userId("bob"))
    await seedBlock("carol", userId("bob"))

    const carol = await asUser("carol")
    await carol.page.goto(`/c/me/${dmId}`)
    await carol.page.waitForURL(new RegExp(dmId), { timeout: 20_000 })

    await expect(carol.page.getByTestId(tid.dmBlockedNotice)).toBeVisible()
    await expect(carol.page.getByTestId(tid.composerInput)).toHaveCount(0)
  })
})
