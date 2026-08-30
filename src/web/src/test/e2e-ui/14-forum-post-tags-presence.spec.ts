import { test, expect, userId } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import {
  seedServer,
  seedChannel,
  seedJoinServer,
  seedForumThread,
  seedMessage,
  seedDm,
  seedDmMessage,
} from "./_fixtures/seed"

// Journey 14 — forum-post notify scope, per-post tags, post-card participant
// avatars, and DM presence stability. Covers the batch that made forum posts
// notify only their participants (like threads), moved tag editing onto each
// post card, showed participant AvatarGroups, and fixed the DM presence flicker
// on refresh. See plans/community-machine-fixes-2026-07.md.

test.describe.serial("forum post tags + participant avatars", () => {
  let serverId: string
  let forumId: string
  let threadId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Forum ${Date.now()}`)
    forumId = await seedChannel("alice", serverId, "ideas", "forum")
    // Bob joins the server so he's a candidate participant / viewer.
    await seedJoinServer("alice", "bob", serverId)
    threadId = await seedForumThread("alice", forumId, `Bug ${Date.now()}`, "first post body")
  })

  test("creator edits a post's tags from the card; the filter bar derives the union", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/c/channels/${serverId}/${forumId}`)
    await page.waitForURL(new RegExp(forumId), { timeout: 20_000, waitUntil: "commit" })

    const card = page.getByTestId(tid.forumThreadCard(threadId))
    await expect(card).toBeVisible({ timeout: 20_000 })

    // No tags yet → no filter-bar chip for the post's future tags.
    await expect(page.getByTestId(tid.forumTagChip("alpha"))).toHaveCount(0)

    // Hover reveals the tag-edit icon; open the dialog and add two tags.
    await card.hover()
    await page.getByTestId(tid.forumThreadTagBtn(threadId)).click()
    await expect(page.getByTestId(tid.forumTagDialog)).toBeVisible({ timeout: 10_000 })
    for (const t of ["alpha", "beta"]) {
      await page.getByPlaceholder("Add a tag…").fill(t)
      await page.getByPlaceholder("Add a tag…").press("Enter")
    }
    await page.keyboard.press("Escape")
    await expect(page.getByTestId(tid.forumTagDialog)).toHaveCount(0)

    // The card now shows the tags AND the filter bar derives them as the union.
    await expect(page.getByTestId(tid.forumTagChip("alpha"))).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId(tid.forumTagChip("beta"))).toBeVisible()

    // Remove one tag → the filter bar's union drops it.
    await card.hover()
    await page.getByTestId(tid.forumThreadTagBtn(threadId)).click()
    await expect(page.getByTestId(tid.forumTagDialog)).toBeVisible({ timeout: 10_000 })
    // The active (selected) chips carry a remove affordance; click #beta to
    // deselect, then close to save.
    await page.getByTestId(tid.forumTagDialogChip("beta")).click()
    await page.keyboard.press("Escape")
    await expect(page.getByTestId(tid.forumTagDialog)).toHaveCount(0)

    await expect(page.getByTestId(tid.forumTagChip("beta"))).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByTestId(tid.forumTagChip("alpha"))).toBeVisible()
  })

  test("a non-creator non-manager sees no tag-edit icon on the post", async ({ asUser }) => {
    const { page } = await asUser("bob")
    await page.goto(`/c/channels/${serverId}/${forumId}`)
    await page.waitForURL(new RegExp(forumId), { timeout: 20_000, waitUntil: "commit" })

    const card = page.getByTestId(tid.forumThreadCard(threadId))
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.hover()
    // Bob is neither the post creator nor a server manager → no tag icon.
    await expect(page.getByTestId(tid.forumThreadTagBtn(threadId))).toHaveCount(0)
  })

  test("post card shows a participant AvatarGroup once a second person joins", async ({ asUser }) => {
    // Bob sends a message into the post → enrolled as a participant (source
    // spoke). Seeded via API (a forum post's own channel accepts messages at
    // the channel messages route); the enrollment path is the product code
    // under test, and the card render is what this journey asserts.
    await seedMessage("bob", threadId, `bob joins ${Date.now()}`)

    // Alice opens the forum list: the post now has >1 participant, so the card
    // renders the participant AvatarGroup (creator + Bob).
    const alice = await asUser("alice")
    await alice.page.goto(`/c/channels/${serverId}/${forumId}`)
    await alice.page.waitForURL(new RegExp(forumId), { timeout: 20_000, waitUntil: "commit" })
    await expect(alice.page.getByTestId(tid.forumThreadAvatars(threadId))).toBeVisible({ timeout: 20_000 })
  })
})

// DM presence stability: a co-member-but-not-friend peer who is online must
// stay online after the other side refreshes — the friends-presence re-seed
// used to destructively replace the online set and evict them (online→offline
// flicker). Alice and Bob share a server (co-members) but are not friends.
test.describe.serial("DM presence stability on refresh", () => {
  let serverId: string
  let dmId: string

  test.beforeAll(async () => {
    // Server + join makes Alice and Bob co-members (they are NOT friends —
    // that's the exact shape that reproduced the flicker). The server's default
    // channel is enough; no extra channel needed.
    serverId = await seedServer("alice", `Presence ${Date.now()}`)
    await seedJoinServer("alice", "bob", serverId)
    dmId = await seedDm("alice", userId("bob"))
    // A message so the DM row is populated in Bob's sidebar.
    await seedDmMessage("alice", dmId, "hi")
  })

  test("peer stays online after the viewer refreshes the DM view", async ({ asUser }) => {
    // Alice stays connected (her page holds a live WS connection → she's online).
    const alice = await asUser("alice")
    await gotoAfterUserWsAuth(alice.page, "/c/me")
    await alice.page.waitForURL(/\/c\/me/, { timeout: 20_000, waitUntil: "commit" })

    const bob = await asUser("bob")
    await expect.poll(async () => {
      const response = await bob.page.request.get(`/api/community/servers/${serverId}/presence`)
      if (!response.ok()) return false
      const body = await response.json() as { online?: string[] }
      return body.online?.includes(userId("alice")) ?? false
    }, { timeout: 20_000 }).toBe(true)

    await gotoAfterUserWsAuth(bob.page, `/c/me/${dmId}`)
    await bob.page.waitForURL(new RegExp(dmId), { timeout: 20_000, waitUntil: "commit" })

    const aliceDot = bob.page.getByTestId(tid.dmRow(dmId)).locator("[data-slot='avatar-badge']")
    // Alice shows online first (WS snapshot).
    await expect(aliceDot).toHaveAttribute("data-presence", "online", { timeout: 20_000 })

    // Refresh — the friends-presence fetch resolves ~1s later. With the merge
    // fix Alice must NOT flip to offline. Assert the dot stays online across a
    // window that comfortably covers the fetch round-trip.
    await bob.page.reload({ waitUntil: "commit" })
    await expect(aliceDot).toHaveAttribute("data-presence", "online", { timeout: 20_000 })
    // Hold the assertion for ~3s so a late destructive re-seed would be caught.
    for (let i = 0; i < 3; i++) {
      await bob.page.waitForTimeout(1000)
      await expect(aliceDot).toHaveAttribute("data-presence", "online")
    }
  })
})
