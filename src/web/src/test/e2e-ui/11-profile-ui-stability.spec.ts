import { test, expect, userId } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { seedServer, seedChannel, seedJoinServer } from "./_fixtures/seed"

// Journey 11 — profile card UI stability. Opening a member's profile shows the
// card; closing detaches it (regression ab873738 — assert detach, not the
// transform-origin animation).
test.describe.serial("profile card stability", () => {
  let serverId: string
  let channelId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Profile ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "profiles")
    await seedJoinServer("alice", "bob", serverId)
  })

  test("opening a member profile shows the card; closing detaches it", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 })

    // Open the members panel and click Bob's row → profile card.
    await page.getByRole("button", { name: /member/i }).first().click()
    await page.getByTestId(tid.memberRow(userId("bob"))).click()
    await expect(page.getByTestId(tid.profileCard)).toBeVisible({ timeout: 15_000 })

    // Close by pressing Escape; the card detaches.
    await page.keyboard.press("Escape")
    await expect(page.getByTestId(tid.profileCard)).toHaveCount(0, { timeout: 15_000 })
  })
})
