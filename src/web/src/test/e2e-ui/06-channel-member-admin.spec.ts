import { test, expect, userId } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { seedServer, seedChannel, seedJoinServer } from "./_fixtures/seed"

// Journey 6 — channel / member administration + the eject branch (needs a
// second identity). Focuses on member list presence and non-member ejection.
test.describe.serial("channel & member admin", () => {
  let serverId: string
  let channelId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Admin ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "admin-chan")
    await seedJoinServer("alice", "bob", serverId)
  })

  test("a non-member is ejected when hitting the server URL directly", async ({ asUser }) => {
    // Carol is not a member of Alice's server.
    const { page } = await asUser("carol")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    // She's redirected away from the server she can't access.
    await expect(page).not.toHaveURL(new RegExp(`/channels/${serverId}/${channelId}$`), { timeout: 20_000 })
  })

  test("the member list shows server members", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 })
    // Open the members panel via the channel header.
    await page.getByRole("button", { name: /member/i }).first().click()
    await expect(page.getByTestId(tid.memberRow(userId("bob")))).toBeVisible({ timeout: 15_000 })
  })
})
