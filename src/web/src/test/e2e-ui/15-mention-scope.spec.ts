import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"
import { composerEditable, openChannel } from "./_fixtures/actions"

import type { CaseActors } from "./_fixtures/case-fixture"

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
// the negative probe: present in public, absent in private.
test.describe("mentions — candidate scope", () => {
  async function prepareCase1(actors: CaseActors) {
    const { userId } = actors
    const { seedServer, seedChannel, seedCategory, seedChannelMember, seedJoinServer, seedMessage, seedThread, seedForumThread, memberInfo } = actors.seed
    async function openMentionPopup(page: Page, root: Page | Locator = page) {
      const editable = composerEditable(page, root)
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
    const serverId: string = await seedServer("alice", `Scope ${Date.now()}`)
    await seedJoinServer("alice", "bob", serverId)
    await seedJoinServer("alice", "carol", serverId)
    const alice: {
      id: string
      name: string
      discriminator: string
    } = await memberInfo("alice", serverId, userId("alice"))
    const bob: {
      id: string
      name: string
      discriminator: string
    } = await memberInfo("alice", serverId, userId("bob"))
    const carol: {
      id: string
      name: string
      discriminator: string
    } = await memberInfo("alice", serverId, userId("carol"))
    // Public/uncategorized text channel — audience is the whole server.
    const publicChannelId: string = await seedChannel("alice", serverId, "public-scope")
    // Private category holding a private text channel (audience alice+bob) and
    // a private forum with one post (audience alice+bob). Carol is excluded from
    // BOTH — she stays a server member but is not in the private units.
    const privateCatId = await seedCategory("alice", serverId, `priv-${Date.now()}`, { private: true })
    const privateChannelId: string = await seedChannel("alice", serverId, "private-scope", "text", privateCatId)
    await seedChannelMember("alice", privateChannelId, userId("bob"))
    const privateForumId: string = await seedChannel("alice", serverId, "private-forum", "forum", privateCatId)
    // A forum owns its roster; a post inherits it (the notify dimension). Add bob
    // to the FORUM, not the post — posts reject access-member adds and derive
    // their mention pool from the parent forum's audience.
    await seedChannelMember("alice", privateForumId, userId("bob"))
    const privatePostId: string = await seedForumThread("alice", privateForumId, `Post ${Date.now()}`, "post body")
    // A thread rooted on a message in the private channel — its scope is the
    // PARENT channel's audience (alice+bob), NOT its own participant set.
    const parentMsgId = await seedMessage("alice", privateChannelId, `thread parent ${Date.now()}`)
    const threadId: string = await seedThread("alice", parentMsgId, `Thread ${Date.now()}`)
    return { serverId, publicChannelId, privateChannelId, privateForumId, privatePostId, threadId, alice, bob, carol, openMentionPopup }
  }

  // Open the @-popup in the current composer and return the option locators. The
  // popup keys each row (members AND @everyone) off its item id — a member
  // row id is the server-member row id (identical in server + channel lists), a
  // virtual row id is the literal "everyone". `here` is exposed here only to
  // assert that the removed @here row stays absent.

  test("public top-level channel → whole server roster (bob AND carol), backed by servers/:id/members", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, publicChannelId, alice, bob, carol, openMentionPopup } = await prepareCase1(actors)

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
    // @here was removed, so its popup row must not appear.
    await expect(opt.here).toHaveCount(0)
    // Self (alice) is filtered out of the popup at the composer — keyed by her
    // server-member row id (the same id the popup options use), not her userId.
    await expect(page.getByTestId(tid.mentionOption(alice.id))).toHaveCount(0)
    // No @channel token exists in the model.
    await expect(opt.channelToken).toHaveCount(0)

    // The public roster came from servers/:id/members, never channels/:id/members.
    expect(channelMembersCalls).toHaveLength(0)
  })

  test("private channel → audience only (bob present, carol absent), backed by channels/:id/members", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, privateChannelId, bob, carol, openMentionPopup } = await prepareCase1(actors)

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
    // @here was removed, so its popup row must not appear.
    await expect(opt.here).toHaveCount(0)
    // Carol is a server member but NOT in this private channel's audience.
    await expect(opt.carol).toHaveCount(0)
  })

  test("thread in private channel → PARENT channel audience (bob mentionable though not a participant)", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, threadId, bob, carol, openMentionPopup } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${threadId}`)
    await page.waitForURL(new RegExp(threadId), { timeout: 20_000, waitUntil: "commit" })

    const opt = await openMentionPopup(page, page.getByTestId(tid.threadSplitPanel))
    // Bob is in the PARENT channel's audience; a thread has no roster of its own,
    // so bob is mentionable here even though he isn't a thread participant yet.
    await expect(opt.bob).toBeVisible({ timeout: 15_000 })
    await expect(opt.everyone).toBeVisible()
    // Carol is outside the parent channel's audience.
    await expect(opt.carol).toHaveCount(0)
  })

  test("private local search reports a failed access read and recovers on warm channel re-entry", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, publicChannelId, privateChannelId, alice, bob, carol, openMentionPopup } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    let failAccess = true
    let accessReads = 0
    await page.route(`**/api/community/channels/${privateChannelId}/members?*`, async (route) => {
      if (new URL(route.request().url()).searchParams.get("relation") !== "access") return route.continue()
      accessReads += 1
      if (failAccess) return route.fulfill({ status: 500, json: { error: "controlled access read failure" } })
      return route.continue()
    })
    await page.goto(`/c/channels/${serverId}/${privateChannelId}`)
    await openMentionPopup(page)
    await expect(page.getByTestId(tid.mentionStatus)).toHaveAttribute("data-state", "error")
    await expect(page.getByTestId(tid.mentionOption(carol.id))).toHaveCount(0)
    expect(accessReads).toBeGreaterThan(0)
    const failedReads = accessReads
    failAccess = false
    await page.keyboard.press("Escape")
    await openChannel(page, publicChannelId)
    const recovered = page.waitForResponse((response) => response.status() === 200 && new URL(response.url()).pathname === `/api/community/channels/${privateChannelId}/members`)
    await openChannel(page, privateChannelId)
    await recovered
    const editable = composerEditable(page)
    await editable.fill("")
    await expect(editable).toHaveText("")
    const opt = await openMentionPopup(page)
    await expect(opt.bob).toBeVisible()
    await expect(opt.carol).toHaveCount(0)
    await expect(page.getByTestId(tid.mentionOption(alice.id))).toHaveCount(0)
    await expect(page.getByTestId(tid.mentionStatus)).toHaveCount(0)
    expect(accessReads).toBeGreaterThan(failedReads)
    await page.keyboard.press("Escape")
    await page.keyboard.press("Backspace")
    await editable.pressSequentially(`@${bob.name.slice(0, 3)}`)
    await expect(page.getByTestId(tid.mentionOption(bob.id))).toBeVisible()
    await expect(page.getByTestId(tid.mentionOption(carol.id))).toHaveCount(0)
    await expect(page.getByTestId(tid.mentionStatus)).toHaveCount(0)
  })

  test("forum post reply → post audience (bob present, carol absent)", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, privatePostId, bob, carol, openMentionPopup } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${privatePostId}`)
    await page.waitForURL(new RegExp(privatePostId), { timeout: 20_000, waitUntil: "commit" })

    const opt = await openMentionPopup(page, page.getByTestId(tid.threadSplitPanel))
    await expect(opt.bob).toBeVisible({ timeout: 15_000 })
    await expect(opt.everyone).toBeVisible()
    await expect(opt.carol).toHaveCount(0)
  })

  test("new forum post composer supports @-mentions like the chat composer", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, privateForumId, bob } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${privateForumId}`)
    await page.waitForURL(new RegExp(privateForumId), { timeout: 20_000, waitUntil: "commit" })

    // Open the create-post form.
    await page.getByRole("button", { name: "New Post" }).click()
    // Body is the shared community <Composer> — a ProseMirror contenteditable,
    // NOT a plain <textarea>. Locate via the composer's testid, since Tiptap
    // exposes its placeholder as `data-placeholder` (a ProseMirror decoration)
    // rather than the HTML `placeholder` attribute Playwright's
    // `getByPlaceholder` matches.
    const body = composerEditable(page)
    await expect(body).toBeVisible({ timeout: 10_000 })

    // Typing @<name-prefix> opens the same mention popup the chat composer uses.
    // Query by bob's ACTUAL display name — an earlier serial spec may have
    // renamed the shared account, so a hardcoded "@bob" would match nothing.
    await body.click()
    await body.pressSequentially(`@${bob.name.slice(0, 3)}`)
    await expect(page.getByTestId(tid.mentionOption(bob.id))).toBeVisible({ timeout: 15_000 })
  })

  test("1:1 DM keeps @abc as plain text, never starts mention suggestions, and sends with Enter", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser, userId } = actors
    const { seedDm } = actors.seed
    const { bob } = await prepareCase1(actors)

    const dmId = await seedDm("alice", userId("bob"))
    const { page } = await asUser("alice")
    const memberSearchRequests: string[] = []
    const messagePosts: string[] = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.pathname.endsWith("/members/search")) {
        memberSearchRequests.push(request.url())
      }
      if (
        request.method() === "POST"
        && url.pathname === `/api/community/channels/${dmId}/messages`
      ) {
        messagePosts.push(request.url())
      }
    })
    await page.goto(`/c/me/${dmId}`)
    await page.waitForURL(new RegExp(dmId), { timeout: 20_000, waitUntil: "commit" })

    const editable = composerEditable(page)
    await editable.click()
    await editable.pressSequentially("@abc")
    await expect(editable).toHaveText("@abc")
    await expect(editable.locator('[data-type="mention"]')).toHaveCount(0)
    await expect(page.getByTestId(tid.mentionPopup)).toHaveCount(0)
    await expect(page.getByTestId(tid.mentionStatus)).toHaveCount(0)
    await expect(page.getByTestId(tid.mentionOption(bob.id))).toHaveCount(0)
    await expect(page.getByTestId(tid.mentionOption("everyone"))).toHaveCount(0)
    await expect(page.getByTestId(tid.mentionOption("here"))).toHaveCount(0)

    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === "POST"
        && url.pathname === `/api/community/channels/${dmId}/messages`
    })
    await page.keyboard.press("Enter")
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const payload = await response.json() as { message: { id: string } }
    await expect(page.getByTestId(tid.message(payload.message.id))).toContainText("@abc")
    await expect(editable).toHaveText("")
    expect(memberSearchRequests).toHaveLength(0)
    expect(messagePosts).toHaveLength(1)
  })
})
