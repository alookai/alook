import { test, expect } from "./_fixtures/case-fixture"

import { tid } from "./_fixtures/testids"
import type { CaseActors } from "./_fixtures/case-fixture"

// Journey 12 — friends. A seeded friendship (Alice↔Bob) shows on the friends
// page; the row opens a DM on click. Friendship handshake uses the two-cookie
// helper (accept is addressee-only).
test.describe("friends", () => {
  async function prepareCase1(actors: CaseActors) {
    const { userId } = actors
    const { seedChannel, seedFriendship, seedServer } = actors.seed
    await seedFriendship("alice", "bob", userId("bob"))
    const serverId: string = await seedServer("alice", `Friends Home ${Date.now()}`)
    const channelId: string = await seedChannel("alice", serverId, "friends-home")
    return { serverId, channelId }
  }

  test("a friend shows in the friends list and opens a DM", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser, userName } = actors
    const { serverId, channelId } = await prepareCase1(actors)

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
