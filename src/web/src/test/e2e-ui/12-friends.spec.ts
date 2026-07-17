import { test, expect, userId, userName } from "./_fixtures/community-fixture"
import { seedFriendship } from "./_fixtures/seed"

// Journey 12 — friends. A seeded friendship (Alice↔Bob) shows on the friends
// page; the row opens a DM on click. Friendship handshake uses the two-cookie
// helper (accept is addressee-only).
test.describe.serial("friends", () => {
  test.beforeAll(async () => {
    await seedFriendship("alice", "bob", userId("bob"))
  })

  test("a friend shows in the friends list and opens a DM", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto("/c/me")
    await page.waitForURL(/\/c\/me/, { timeout: 20_000 })

    // Bob appears in the friends list (his dev display name = email local-part).
    const bobRow = page.getByText(userName("bob"), { exact: false }).first()
    await expect(bobRow).toBeVisible({ timeout: 15_000 })

    // Left-click opens the DM with Bob.
    await bobRow.click()
    await page.waitForURL(/\/c\/me\/[^/]+/, { timeout: 20_000 })
    expect(page.url()).toMatch(/\/c\/me\/[^/]+/)
  })
})
