import { test, expect } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { seedServer, seedChannel } from "./_fixtures/seed"

// Journey 8 — mobile layout. At <640px the community shell switches zones
// (nav ↔ messages). Opening a channel enters the messages zone; the header
// back button returns to the nav zone.
test.use({ viewport: { width: 390, height: 844 } })

test.describe.serial("mobile layout", () => {
  let serverId: string
  let channelId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Mobile ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "mobile-chan")
  })

  test("opening a channel shows the messages zone with a back button", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 })

    // Composer (messages zone) is present.
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    // Mobile header exposes a Back control.
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible()
  })
})
