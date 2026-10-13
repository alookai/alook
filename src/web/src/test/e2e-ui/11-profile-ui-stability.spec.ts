import { test, expect } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"

import type { CaseActors } from "./_fixtures/case-fixture"

// Journey 11 — profile card UI stability. Opening a member's profile shows the
// card; closing detaches it (regression ab873738 — assert detach, not the
// transform-origin animation).
test.describe("profile card stability", () => {
  async function prepareCase1(actors: CaseActors) {
    const { seedServer, seedChannel, seedJoinServer } = actors.seed
    const serverId: string = await seedServer("alice", `Profile ${Date.now()}`)
    const channelId: string = await seedChannel("alice", serverId, "profiles")
    await seedJoinServer("alice", "bob", serverId)
    return { serverId, channelId }
  }

  for (const isFriend of [false, true]) {
    const name = isFriend
      ? "opening an accepted friend's profile focuses the textbox; closing detaches it"
      : "opening a member profile shows the card; closing detaches it"
    test(name, async ({ caseActors }) => {
      const actors = await caseActors(["alice", "bob"])
      const { asUser, userId } = actors
      const { seedFriendship, seedRemoveFriendship } = actors.seed
      const { serverId, channelId } = await prepareCase1(actors)

      const bobId = userId("bob")
      await seedFriendship("alice", "bob", bobId)
      if (!isFriend) await seedRemoveFriendship("alice", bobId)

      const { page } = await asUser("alice")
      const buckets = [
        ["accepted", "friends", isFriend],
        ["pending", "pending", false],
        ["blocked", "blocked", false],
      ] as const
      const responseWaits = buckets.map(([bucket]) => page.waitForResponse(
        (response) => response.request().method() === "GET"
          && new URL(response.url()).pathname === `/api/community/friends/${bucket}`,
        { timeout: 10_000 },
      ))
      const [responses] = await Promise.all([
        Promise.all(responseWaits),
        page.goto(`/c/channels/${serverId}/${channelId}`),
      ])
      for (const [index, [, field, expectedBob]] of buckets.entries()) {
        const response = responses[index]
        expect(response.status()).toBe(200)
        const body = await response.json() as {
          stale?: boolean
          friends?: Array<{ userId: string }>
          pending?: Array<{ userId: string }>
          blocked?: Array<{ userId: string }>
        }
        expect(body.stale).not.toBe(true)
        const peers = body[field]
        expect(Array.isArray(peers)).toBe(true)
        expect(peers!.some((peer) => peer.userId === bobId)).toBe(expectedBob)
      }
      await page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })

      // Open the members panel and click Bob's row → profile card.
      await page.getByRole("button", { name: /member/i }).first().click()
      await page.getByTestId(tid.memberRow(userId("bob"))).click()
      await expect(page.getByTestId(tid.profileCard)).toBeVisible({ timeout: 15_000 })
      const textbox = page.getByTestId(tid.profileCard).getByRole("textbox")
      if (isFriend) await expect(textbox).toBeFocused()
      else await expect(textbox).toHaveCount(0)

      // Close by pressing Escape; the card detaches.
      await page.keyboard.press("Escape")
      await expect(page.getByTestId(tid.profileCard)).toHaveCount(0, { timeout: 15_000 })
    })
  }
})
