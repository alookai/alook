import { test, expect } from "./_fixtures/community-fixture"
import { sendMessage } from "./_fixtures/actions"
import { seedServer, seedChannel, seedMessage } from "./_fixtures/seed"

// Journey 9 — threads. Creating a thread from a message surfaces a thread
// indicator on the parent message (regression ab572e3e).
test.describe.serial("threads", () => {
  let serverId: string
  let channelId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Thread ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "threads")
    // Seed the parent message via API so it's already persisted with a real
    // id before the UI opens. Sending the FIRST message through the UI in a
    // cold, directly-navigated channel races the list's initial fetch (the
    // empty pre-send snapshot can land last and clobber the row) — that's a
    // test-harness timing issue, not a product bug (spec 02/03 cover the send
    // UI). Seeding sidesteps the race so this journey can focus on threads.
    await seedMessage("alice", channelId, `thread parent ${Date.now()}`)
  })

  test("creating a thread from a message shows a thread indicator on the parent", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 })

    // The seeded parent message renders (real id, not a racy optimistic row).
    const row = page.getByText("thread parent", { exact: false }).first()
    await expect(row).toBeVisible({ timeout: 20_000 })

    // Open the message's more-menu → Create Thread. Retry the open since the
    // hover toolbar can close between the hover and the menu click.
    await expect(async () => {
      await row.hover()
      await page.getByRole("button", { name: "More actions" }).first().click()
      await page.getByRole("menuitem", { name: "Create Thread" }).click({ timeout: 3_000 })
    }).toPass({ timeout: 20_000 })

    // Thread creation navigates off the parent channel into the thread child.
    await page.waitForURL((url) => !url.pathname.endsWith(`/${channelId}`), { timeout: 20_000 })

    // The thread is usable: a reply posts and appears in the thread view.
    const reply = `first reply ${Date.now()}`
    await sendMessage(page, reply)
    await expect(page.getByText(reply, { exact: false }).first()).toBeVisible({ timeout: 15_000 })

    // Back on the parent channel, the message now carries a thread indicator.
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(`[data-testid^="community-thread-indicator-"]`).first()).toBeVisible({ timeout: 15_000 })
  })
})
