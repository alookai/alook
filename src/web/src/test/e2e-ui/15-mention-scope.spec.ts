import { test, expect, userId } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { composerEditable } from "./_fixtures/actions"
import {
  seedServer,
  seedChannel,
  seedCategory,
  seedChannelMember,
  seedJoinServer,
  seedMessage,
  seedThread,
  seedForumPost,
  seedDm,
  memberInfo,
} from "./_fixtures/seed"

// Journey 15 — @-mention CANDIDATE SCOPE (distinct from journey 13, which pins
// mention serialization/disambiguation). Scope is a 2-D cross:
//   privacy (category `private` flag — public == top-level, NO third state)
//   × channel type (top-level channel / thread / forum post)
// backed by `composerMembers` in c/channels/[serverId]/[channelId]/page.tsx.
//
//   public/top-level ANY type → whole server roster (servers/:id/members)
//   private channel/post       → that unit's audience (channels/:id/members)
//   private thread             → PARENT channel's audience
//   new forum post             → no @ (plain textarea)
//   1:1 DM                     → no @ popup at all
//
// Fixture: alice (owner) + bob + carol all join the server. The public channel
// sees everyone; the private channel's audience is alice+bob ONLY — carol is
// the negative probe (present in public, absent in private). See
// plans/e2e-mention-scope.md.
test.describe.serial("mentions — candidate scope", () => {
  let serverId: string
  let publicChannelId: string
  let privateChannelId: string
  let privateForumId: string
  let privatePostId: string
  let threadId: string
  let alice: { id: string; discriminator: string }
  let bob: { id: string; discriminator: string }
  let carol: { id: string; discriminator: string }

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Scope ${Date.now()}`)
    await seedJoinServer("alice", "bob", serverId)
    await seedJoinServer("alice", "carol", serverId)
    alice = await memberInfo("alice", serverId, userId("alice"))
    bob = await memberInfo("alice", serverId, userId("bob"))
    carol = await memberInfo("alice", serverId, userId("carol"))

    // Public/uncategorized text channel — audience is the whole server.
    publicChannelId = await seedChannel("alice", serverId, "public-scope")

    // Private category holding a private text channel (audience alice+bob) and
    // a private forum with one post (audience alice+bob). Carol is excluded from
    // BOTH — she stays a server member but is not in the private units.
    const privateCatId = await seedCategory("alice", serverId, `priv-${Date.now()}`, { private: true })
    privateChannelId = await seedChannel("alice", serverId, "private-scope", "text", privateCatId)
    await seedChannelMember("alice", privateChannelId, userId("bob"))

    privateForumId = await seedChannel("alice", serverId, "private-forum", "forum", privateCatId)
    privatePostId = await seedForumPost("alice", privateForumId, `Post ${Date.now()}`, "post body")
    await seedChannelMember("alice", privatePostId, userId("bob"))

    // A thread rooted on a message in the private channel — its scope is the
    // PARENT channel's audience (alice+bob), NOT its own participant set.
    const parentMsgId = await seedMessage("alice", privateChannelId, `thread parent ${Date.now()}`)
    threadId = await seedThread("alice", parentMsgId, `Thread ${Date.now()}`)
  })

  // Open the @-popup in the current composer and return the option locators. The
  // popup keys each row (members AND @everyone/@here) off its item id — a member
  // row id is the server-member row id (identical in server + channel lists), a
  // virtual row id is the literal "everyone"/"here".
  async function openMentionPopup(page: import("@playwright/test").Page) {
    const editable = composerEditable(page)
    await editable.click()
    await editable.pressSequentially("@")
    return {
      everyone: page.getByTestId(tid.mentionOption("everyone")),
      here: page.getByTestId(tid.mentionOption("here")),
      bob: page.getByTestId(tid.mentionOption(bob.id)),
      carol: page.getByTestId(tid.mentionOption(carol.id)),
      channelToken: page.getByTestId(tid.mentionOption("channel")),
    }
  }

  test("public top-level channel → whole server roster (bob AND carol), backed by servers/:id/members", async ({ asUser }) => {
    const { page } = await asUser("alice")
    // The channel-members endpoint must NOT be hit for a public channel — the
    // popup roster comes from the server list. Assert its absence by watching
    // requests for the whole journey.
    const channelMembersCalls: string[] = []
    page.on("request", (r) => {
      if (/\/api\/community\/channels\/[^/]+\/members(\?|$)/.test(r.url())) channelMembersCalls.push(r.url())
    })

    await page.goto(`/c/channels/${serverId}/${publicChannelId}`)
    await page.waitForURL(new RegExp(publicChannelId), { timeout: 20_000, waitUntil: "commit" })

    const opt = await openMentionPopup(page)
    // Assert a KNOWN-PRESENT row first (roster arrived), THEN the wider claim —
    // so a slow roster load can't false-pass an absence check.
    await expect(opt.bob).toBeVisible({ timeout: 15_000 })
    await expect(opt.carol).toBeVisible({ timeout: 15_000 })
    await expect(opt.everyone).toBeVisible()
    await expect(opt.here).toBeVisible()
    // Self (alice) is filtered out of the popup at the composer — keyed by her
    // server-member row id (the same id the popup options use), not her userId.
    await expect(page.getByTestId(tid.mentionOption(alice.id))).toHaveCount(0)
    // No @channel token exists in the model.
    await expect(opt.channelToken).toHaveCount(0)

    // The public roster came from servers/:id/members, never channels/:id/members.
    expect(channelMembersCalls).toHaveLength(0)
  })

  test("private channel → audience only (bob present, carol absent), backed by channels/:id/members", async ({ asUser }) => {
    const { page } = await asUser("alice")
    const channelMembersReq = page.waitForRequest(
      (r) => new RegExp(`/api/community/channels/${privateChannelId}/members`).test(r.url()),
      { timeout: 20_000 },
    )

    await page.goto(`/c/channels/${serverId}/${privateChannelId}`)
    await page.waitForURL(new RegExp(privateChannelId), { timeout: 20_000, waitUntil: "commit" })

    // Private scope is backed by the channel-members endpoint.
    await channelMembersReq

    const opt = await openMentionPopup(page)
    await expect(opt.bob).toBeVisible({ timeout: 15_000 })
    await expect(opt.everyone).toBeVisible()
    await expect(opt.here).toBeVisible()
    // Carol is a server member but NOT in this private channel's audience.
    await expect(opt.carol).toHaveCount(0)
  })

  test("thread in private channel → PARENT channel audience (bob mentionable though not a participant)", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${threadId}`)
    await page.waitForURL(new RegExp(threadId), { timeout: 20_000, waitUntil: "commit" })

    const opt = await openMentionPopup(page)
    // Bob is in the PARENT channel's audience; a thread has no roster of its own,
    // so bob is mentionable here even though he isn't a thread participant yet.
    await expect(opt.bob).toBeVisible({ timeout: 15_000 })
    await expect(opt.everyone).toBeVisible()
    // Carol is outside the parent channel's audience.
    await expect(opt.carol).toHaveCount(0)
  })

  test("forum post reply → post audience (bob present, carol absent)", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${privatePostId}`)
    await page.waitForURL(new RegExp(privatePostId), { timeout: 20_000, waitUntil: "commit" })

    const opt = await openMentionPopup(page)
    await expect(opt.bob).toBeVisible({ timeout: 15_000 })
    await expect(opt.everyone).toBeVisible()
    await expect(opt.carol).toHaveCount(0)
  })

  test("new forum post composer has no @ autocomplete (plain textarea)", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${privateForumId}`)
    await page.waitForURL(new RegExp(privateForumId), { timeout: 20_000, waitUntil: "commit" })

    // Open the create-post form.
    await page.getByRole("button", { name: "New Post" }).click()
    const body = page.getByPlaceholder("Enter a message…")
    await expect(body).toBeVisible({ timeout: 10_000 })
    // It's a real <textarea>, not a TipTap contenteditable.
    expect(await body.evaluate((el) => el.tagName)).toBe("TEXTAREA")

    // Typing @ yields no mention popup options at all.
    await body.click()
    await body.pressSequentially("@bob")
    await expect(page.getByTestId(tid.mentionOption(bob.id))).toHaveCount(0)
    await expect(page.getByTestId(tid.mentionOption("everyone"))).toHaveCount(0)
  })

  test("1:1 DM composer has no @ popup at all (no members, no everyone/here)", async ({ asUser }) => {
    const dmId = await seedDm("alice", userId("bob"))
    const { page } = await asUser("alice")
    await page.goto(`/c/me/${dmId}`)
    await page.waitForURL(new RegExp(dmId), { timeout: 20_000, waitUntil: "commit" })

    const editable = composerEditable(page)
    await editable.click()
    await editable.pressSequentially("@")
    // DM context short-circuits the ranker → zero options, and no virtual rows.
    await expect(page.getByTestId(tid.mentionOption(bob.id))).toHaveCount(0)
    await expect(page.getByTestId(tid.mentionOption("everyone"))).toHaveCount(0)
    await expect(page.getByTestId(tid.mentionOption("here"))).toHaveCount(0)
  })
})
