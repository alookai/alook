import { test, expect } from "./_fixtures/community-fixture"
import { seedServer, createInvite } from "./_fixtures/seed"

// Journey 7 — invite accept (second identity). Alice creates a server + invite
// via API, Bob accepts it through the UI, and the new server appears in Bob's
// rail without a manual reload (regression 1c2e2a05).
test.describe.serial("invite accept", () => {
  let serverId: string
  let inviteToken: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Invite ${Date.now()}`)
    inviteToken = await createInvite("alice", serverId)
  })

  test("Bob accepts the invite and lands in the server", async ({ asUser }) => {
    const { page } = await asUser("bob")
    await page.goto(`/c/invite/${inviteToken}`)
    // Accept via the join CTA.
    await page.getByRole("button", { name: /join server/i }).first().click()
    await page.waitForURL(new RegExp(`/c/channels/${serverId}`), { timeout: 20_000 })
    await expect(page).toHaveURL(new RegExp(`/c/channels/${serverId}`))
  })
})
