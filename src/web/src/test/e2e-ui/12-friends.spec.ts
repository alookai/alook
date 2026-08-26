import { test, expect, userId, userName } from "./_fixtures/community-fixture"
import { seedChannel, seedFriendship, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

// Journey 12 — friends. A seeded friendship (Alice↔Bob) shows on the friends
// page; the row opens a DM on click. Friendship handshake uses the two-cookie
// helper (accept is addressee-only).
test.describe.serial("friends", () => {
  let serverId: string
  let channelId: string

  test.beforeAll(async () => {
    await seedFriendship("alice", "bob", userId("bob"))
    serverId = await seedServer("alice", `Friends Home ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "friends-home")
  })

  test("a friend shows in the friends list and opens a DM", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto("/c/me")
    await page.waitForURL(/\/c\/me\/friends$/, { timeout: 20_000 , waitUntil: "commit" })
    await expect(page.getByLabel("Loading conversation")).toHaveCount(0)

    // Bob appears in the friends list (his dev display name = email local-part).
    const bobRow = page.getByText(userName("bob"), { exact: false }).first()
    await expect(bobRow).toBeVisible({ timeout: 15_000 })

    // Left-click opens the DM with Bob.
    await bobRow.click()
    await expect.poll(() => new URL(page.url()).pathname).not.toBe("/c/me/friends")
    await expect(page.getByTestId(tid.composerInput)).toBeVisible({ timeout: 20_000 })
    expect(new URL(page.url()).pathname).toMatch(/^\/c\/me\/[^/]+$/)

    const rememberedDmPath = new URL(page.url()).pathname
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    await page.evaluate(() => {
      const state = window as typeof window & { __meRouteCommits?: string[] }
      state.__meRouteCommits = []
      const push = history.pushState.bind(history)
      const replace = history.replaceState.bind(history)
      history.pushState = (...args) => {
        push(...args)
        state.__meRouteCommits!.push(location.pathname)
      }
      history.replaceState = (...args) => {
        replace(...args)
        state.__meRouteCommits!.push(location.pathname)
      }
    })

    await page.getByTestId(tid.homeButton).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(rememberedDmPath)
    const commits = await page.evaluate(() => (
      window as typeof window & { __meRouteCommits?: string[] }
    ).__meRouteCommits ?? [])
    expect(commits).not.toContain("/c/me")
    expect(commits.at(-1)).toBe(rememberedDmPath)
  })
})
