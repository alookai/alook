import { CURRENT_COMMUNITY_FIXTURE_HEADERS, communityFixtureFetch, confirmCommunityFixtureApiResponse, currentCommunityFixtureError } from "./_fixtures/business-contract"
import { type CaseActors, expect, test } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"
import { composerEditable, openChannel } from "./_fixtures/actions"
import type { Locator, Page } from "@playwright/test"
import type { z } from "zod"
import { CommunityServerMemberReadSchema, CommunityServerMemberSearchReadSchema, CommunityServerMembersReadSchema } from "@alook/shared"

// Journey 13 — mandatory mention discriminator. Every member mention serializes
// as `@Name#dddd`, which lets a name with spaces render as one pill AND makes a
// same-name mention resolve to the EXACT person on click (regression for the
// sanitize allowlist case-mismatch that stripped the discriminator — bugfix
// 4044fd6c). A hand-typed bare `@name` is not a mention.
//
// Fixture: Bob and Carol are both renamed "John Doe" (spaced name), each keeping
// its own auto-assigned discriminator — so the same journey exercises the
// spaced-name pill and the same-name disambiguation.
test.describe("mentions — mandatory discriminator", () => {
  async function prepareCase1(actors: CaseActors) {
    const { userId, userName } = actors
    const { seedServer, seedChannel, seedJoinServer, renameUser, memberInfo } = actors.seed
    const cleanupState: { serverId?: string } = {}
    actors.onCleanup(async () => {
      const restorations = await Promise.allSettled(identityKeys.map(async (key) => {
        await renameUser(key, userName(key))
        return key
      }))
      const serverId = cleanupState.serverId!
      const verifiedMembers = await Promise.allSettled(identityKeys.map(async (key) => {
        const member = await memberInfo("alice", serverId, userId(key))
        return { key, name: member.name }
      }))
      expect(restorations).toEqual(identityKeys.map((key) => ({
        status: "fulfilled",
        value: key,
      })))
      expect(verifiedMembers).toEqual(identityKeys.map((key) => ({
        status: "fulfilled",
        value: { key, name: userName(key) },
      })))
    })
    await renameUser("bob", "John Doe")
    await renameUser("carol", "John Doe")
    const serverId: string = await seedServer("alice", `Mentions ${Date.now()}`)
    cleanupState.serverId = serverId
    const channelId: string = await seedChannel("alice", serverId, "mentions")
    await seedJoinServer("alice", "bob", serverId)
    await seedJoinServer("alice", "carol", serverId)
    const bob: {
      id: string
      discriminator: string
    } = await memberInfo("alice", serverId, userId("bob"))
    const carol: {
      id: string
      discriminator: string
    } = await memberInfo("alice", serverId, userId("carol"))
    // Distinct discriminators are what the disambiguation hinges on — if the
    // two happened to collide the journey couldn't prove per-user resolution.
    expect(bob.discriminator).not.toBe(carol.discriminator)
    return { serverId, channelId, bob, carol }
  }

  const identityKeys = ["alice", "bob", "carol"] as const

  test("whole-body Markdown keeps literal mentions inert through composer, display and consumption", async ({ caseActors }, testInfo) => {
    test.setTimeout(120_000)
    const actors = await caseActors(["alice", "bob", "carol"])
    const { serverId, channelId, bob } = await prepareCase1(actors)
    const opener = await actors.seed.seedMessage("alice", channelId, "native mention protection")
    const threadId = await actors.seed.seedThread("alice", opener, "native mention protection")
    const { page } = await actors.asUser("alice")
    await page.goto(`/c/channels/${serverId}/${threadId}`)
    const threadSurface = page.getByTestId(tid.threadSplitPanel)
    await expect(threadSurface).toHaveCount(1)
    await expect(threadSurface).toBeVisible()
    const handle = `@John Doe#${bob.discriminator}`
    const sent: Array<{ id: string; content: string; mentionType?: string }> = []

    async function participants(): Promise<string[]> {
      const response = await confirmCommunityFixtureApiResponse(page.request.get(`/api/community/channels/${threadId}/members?relation=notify`, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
      expect(response.status()).toBe(200)
      const payload = await response.json() as { members: Array<{ userId: string }> }
      return payload.members.map((member) => member.userId).sort()
    }

    async function attention(role: "bob" | "carol") {
      const response = await communityFixtureFetch(new URL("/api/community/users/me/attention?limit=200", page.url()), {
        headers: { Cookie: actors.sessionCookie(role) },
      })
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        stale?: boolean
        truncated: boolean
        items: Array<{ kind: string; messageId?: string; scopeId?: string }>
      }
      expect(payload.stale).not.toBe(true)
      expect(payload.truncated).toBe(false)
      return payload.items.filter((item) => item.kind === "mention" && item.scopeId === threadId)
        .map((item) => item.messageId)
    }

    async function send(content: string, mentionType?: "everyone") {
      const editable = composerEditable(page, threadSurface)
      await expect(editable).toHaveCount(1)
      if (content.includes("\n")) {
        await editable.click()
        await editable.press("ControlOrMeta+A")
        await editable.press("Backspace")
        await editable.evaluate((element, text) => {
          const transfer = new DataTransfer()
          transfer.setData("text/plain", text)
          element.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: transfer,
          }))
        }, content)
      } else {
        await editable.fill(content)
      }
      if (content === "@everyone") {
        const popup = page.getByTestId(tid.mentionPopup)
        await expect(popup).toBeVisible()
        await editable.press("Escape")
        await expect(popup).toBeHidden()
        await expect(editable).toHaveText(content)
        await expect(editable.locator('[data-type="mention"]')).toHaveCount(0)
      }
      const [response] = await Promise.all([
        page.waitForResponse((response) => response.request().method() === "POST"
          && new URL(response.url()).pathname === `/api/community/channels/${threadId}/messages`),
        editable.press("Enter"),
      ])
      expect(response.status()).toBe(201)
      const outgoing = response.request().postDataJSON() as { content: string; mentionType?: string }
      expect(outgoing.content).toBe(content)
      expect(outgoing.mentionType).toBe(mentionType)
      const created = await response.json() as { message: { id: string; content: string } }
      expect(created.message.content).toBe(content)
      const persisted = await confirmCommunityFixtureApiResponse(page.request.get(`/api/community/messages/${created.message.id}`, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
      expect(persisted.status()).toBe(200)
      expect((await persisted.json()).message).toMatchObject({ id: created.message.id, content, channelId: threadId })
      const body = threadSurface.getByTestId(tid.message(created.message.id)).locator("[data-community-message-body]")
      await expect(body).toBeVisible()
      await expect(editable).toHaveText("")
      sent.push({ id: created.message.id, content, mentionType: outgoing.mentionType })
      return { id: created.message.id, body }
    }

    expect(await attention("bob")).toEqual([])
    expect(await attention("carol")).toEqual([])
    const negativeBodies = [
      `𠮷${handle} 𠀀${handle} 𝟙${handle} ${handle}𠮷 ${handle}𝟙`,
      `\\${handle} \\@everyone &#64;John Doe#${bob.discriminator} &#64;everyone`,
      `\`${handle} @everyone\``,
      `\`\`\`txt\n${handle} @everyone\n\`\`\``,
      `[${handle} @everyone][protected]\n\n[protected]: https://example.com/@everyone`,
      "[label](https://example.com/@everyone)",
    ]
    for (const content of negativeBodies) {
      const { body } = await send(content)
      await expect(body.locator('[title="@John Doe"], [title="@everyone"]')).toHaveCount(0)
      if (content === negativeBodies[0]) await expect(body).toHaveText(content)
    }
    expect(await participants()).toEqual([actors.userId("alice")])
    expect(await attention("bob")).toEqual([])
    expect(await attention("carol")).toEqual([])

    const positive = await send(`🎉${handle}`)
    await expect(positive.body.getByRole("button", { name: "@John Doe", exact: true })).toHaveCount(1)
    expect(await participants()).toEqual([actors.userId("alice"), actors.userId("bob")].sort())
    expect(await attention("bob")).toEqual([positive.id])
    expect(await attention("carol")).toEqual([])

    const broadcast = await send("@everyone", "everyone")
    await expect(broadcast.body.locator('[title="@everyone"]')).toHaveCount(1)
    expect(await attention("bob")).toEqual(expect.arrayContaining([positive.id, broadcast.id]))
    expect(await attention("carol")).toEqual([broadcast.id])
    expect(await participants()).toEqual([actors.userId("alice"), actors.userId("bob")].sort())

    const explicit = await confirmCommunityFixtureApiResponse(page.request.post(`/api/community/channels/${threadId}/messages`, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
      data: { content: "explicit API broadcast without body token", mentionType: "everyone" },
    }))
    expect(explicit.status()).toBe(201)
    const explicitBody = await explicit.json() as { message: { id: string } }
    expect(await attention("carol")).toEqual(expect.arrayContaining([broadcast.id, explicitBody.message.id]))
    expect(await participants()).toEqual([actors.userId("alice"), actors.userId("bob")].sort())
    const negativeIds = sent.slice(0, negativeBodies.length).map((message) => message.id)
    for (const role of ["bob", "carol"] as const) {
      const delivered = await attention(role)
      expect(delivered.filter((id) => negativeIds.includes(id!))).toEqual([])
    }
    await testInfo.attach("native-markdown-consumption.json", {
      body: JSON.stringify({ serverId, threadId, sent, explicitMessageId: explicitBody.message.id,
        participants: await participants(), bobMentions: await attention("bob"), carolMentions: await attention("carol") }, null, 2),
      contentType: "application/json",
    })
  })

  // Types `@John`, waits for the popup, and picks the member whose row id is
  // `memberId` (the popup option testid keys off the row id — labels are
  // identical for two "John Doe"s, so text can't disambiguate). Verifies the
  // send actually landed (marker message visible) before returning, so a
  // following call starts from a clean, settled composer — otherwise the second
  // mention races the first send and only one pill renders.
  async function mentionAndSend(page: import("@playwright/test").Page, memberId: string, marker: string) {
    const editable = composerEditable(page)
    await editable.click()
    await editable.pressSequentially("@John")
    const option = page.getByTestId(tid.mentionOption(memberId))
    await expect(option).toBeVisible({ timeout: 15_000 })
    await option.click()
    // The picked mention becomes a pill node in the composer — wait for it
    // before typing the trailing marker, so the text isn't swallowed by the
    // still-open suggestion popup.
    await expect(editable.locator("[data-type='mention'], .mention-highlight").first()).toBeVisible({ timeout: 10_000 })
    await editable.pressSequentially(` ${marker}`)
    await page.keyboard.press("Enter")
    // Confirm the message posted before returning.
    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 15_000 })
    // AND that the composer fully cleared — otherwise the NEXT mentionAndSend
    // types `@John` into a composer with residual state, the suggestion popup
    // doesn't open, and no second pill renders (the `.nth(1)` wait then hangs to
    // a 60s timeout). Asserting the empty composer here makes the second call
    // start from a settled surface.
    await expect(editable).toHaveText("", { timeout: 10_000 })
  }

  test("same-name mentions each resolve to the exact user on pill click (spaced name, no leaked #dddd)", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser, userId } = actors
    const { serverId, channelId, bob, carol } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })

    await mentionAndSend(page, bob.id, "msgBob")
    await mentionAndSend(page, carol.id, "msgCarol")

    // Both messages render a single `@John Doe` pill with NO visible tag.
    const bobMsg = page.locator("[data-msg-id]").filter({ hasText: "msgBob" }).first()
    const carolMsg = page.locator("[data-msg-id]").filter({ hasText: "msgCarol" }).first()
    await expect(bobMsg).toBeVisible({ timeout: 15_000 })
    await expect(carolMsg).toBeVisible({ timeout: 15_000 })
    // Bind each pill to its marker-bearing message row. The canonical GET can
    // reorder rows while a profile is loading, so a global live `nth` locator
    // can otherwise retarget from Carol's pill back to Bob's.
    const bobPill = bobMsg.getByRole("button", { name: "@John Doe", exact: true })
    const carolPill = carolMsg.getByRole("button", { name: "@John Doe", exact: true })
    await expect(bobPill).toHaveCount(1)
    await expect(carolPill).toHaveCount(1)
    await expect(bobPill).toBeVisible()
    await expect(bobPill).not.toContainText("#")

    // Click Bob's pill → the profile card shows Bob's discriminator, not Carol's.
    const card = page.getByTestId(tid.profileCard)
    const bobProfilePromise = page.waitForResponse((response) => {
      return response.request().method() === "GET"
        && new URL(response.url()).pathname === `/api/community/users/${userId("bob")}/profile`
    })
    await expect(async () => {
      await bobPill.click({ timeout: 5_000 })
      await expect(card).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 30_000 })
    // The card renders fallback member data before its exact user profile is
    // enriched. Gate the discriminator oracle on that observable boundary.
    const bobProfile = await bobProfilePromise
    expect(bobProfile.status()).toBe(200)
    await expect(card).toContainText(`#${bob.discriminator}`)
    await expect(card).not.toContainText(`#${carol.discriminator}`)
    // Dismiss the first card, then open the second pill's. The popover renders
    // a portalled overlay that lingers during its exit animation and intercepts
    // pointer events; under full-run load `toBeHidden` on the card doesn't
    // guarantee the overlay has detached. Retry the whole dismiss→click so a
    // transient interception (or a stray still-open card) re-presses Escape and
    // tries again, instead of hanging the bare click to the 60s test timeout.
    const carolProfilePromise = page.waitForResponse((response) => {
      return response.request().method() === "GET"
        && new URL(response.url()).pathname === `/api/community/users/${userId("carol")}/profile`
    })
    await expect(async () => {
      if (await card.isVisible()) {
        await page.keyboard.press("Escape")
        await expect(card).toBeHidden({ timeout: 5_000 })
      }
      await carolPill.click({ timeout: 5_000 })
      await expect(card).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 30_000 })
    const carolProfile = await carolProfilePromise
    expect(carolProfile.status()).toBe(200)
    await expect(card).toContainText(`#${carol.discriminator}`)
  })

  test("a hand-typed bare @name (not picked from the popup) is inert — plain text, no pill", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })

    const marker = `bareMention ${Date.now()}`
    const editable = composerEditable(page)
    await editable.click()
    // Type the bare handle and dismiss the popup so it never becomes a node.
    await editable.pressSequentially("@John")
    await page.keyboard.press("Escape")
    await editable.pressSequentially(` ${marker}`)
    await page.keyboard.press("Enter")

    const msg = page.getByText(marker, { exact: false }).first()
    await expect(msg).toBeVisible({ timeout: 15_000 })
    // The `@John` in this message is literal text — no mention pill button.
    await expect(msg.locator("xpath=ancestor-or-self::*[1]").locator("button", { hasText: "@John" })).toHaveCount(0)
  })

  test("@everyone renders with the distinct primary styling (its flag survives sanitize)", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { seedMessage } = actors.seed
    const { serverId, channelId } = await prepareCase1(actors)

    const { page } = await asUser("alice")

    const marker = `everyoneMsg ${Date.now()}`
    // Seed via API (the composer's own @everyone popup path is covered by unit
    // tests) — this journey is specifically about how the sent pill renders.
    // Seed BEFORE navigating so the message is in the channel's initial fetch:
    // navigating first and relying on WS delivery races the page's channel
    // subscription (if the seed lands in the gap before subscribe, the message
    // never arrives without a reload — a real flake, not the pill logic).
    await seedMessage("alice", channelId, `@everyone ${marker}`)

    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })

    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 15_000 })
    const everyonePill = page.locator("span", { hasText: "@everyone" }).first()
    await expect(everyonePill).toBeVisible()
    // everyone/here use the primary tint, not the member accent tint.
    await expect(everyonePill).toHaveClass(/text-primary/)
  })

  test("setting a display name with # / @ / newline is rejected (400)", async ({ caseActors }) => {
    const actors = await caseActors(["alice"])
    const originalName = actors.userName("alice")
    const { page } = await actors.asUser("alice")
    actors.onCleanup(async () => {
      await actors.seed.renameUser("alice", originalName)
      const restored = await confirmCommunityFixtureApiResponse(page.request.get("/api/community/users/me/profile", {
        headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
      }))
      expect(restored.status()).toBe(200)
      expect(await restored.json()).toMatchObject({ name: originalName })
    })
    for (const bad of ["Ann#1234", "bad@name", "line\nbreak"]) {
      const res = await confirmCommunityFixtureApiResponse(page.request.patch("/api/community/users/me/profile", {
        headers: { "Content-Type": "application/json", ...CURRENT_COMMUNITY_FIXTURE_HEADERS },
        data: { name: bad },
      }))
      expect(res.status()).toBe(400)
    }
    // A valid spaced name still saves.
    const ok = await confirmCommunityFixtureApiResponse(page.request.patch("/api/community/users/me/profile", {
      headers: { "Content-Type": "application/json", ...CURRENT_COMMUNITY_FIXTURE_HEADERS },
      data: { name: "Jane Roe" },
    }))
    expect(ok.status()).toBe(200)
  })
})

test.describe("mention scope", () => {
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
      const { asUser, userName } = actors
      const { serverId, publicChannelId, alice, openMentionPopup } = await prepareCase1(actors)

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
      await expect(page.getByRole("option").filter({ hasText: userName("bob") }).and(opt.bob))
        .toBeVisible({ timeout: 15_000 })
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
      const { serverId, privateChannelId, openMentionPopup } = await prepareCase1(actors)

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
      const { serverId, threadId, openMentionPopup } = await prepareCase1(actors)

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
        if (failAccess) return route.fulfill(currentCommunityFixtureError("controlled access read failure", 500))
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
      const { serverId, privatePostId, openMentionPopup } = await prepareCase1(actors)

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
})

test.describe("mention candidate pagination", () => {
  type Candidate = z.infer<typeof CommunityServerMemberReadSchema>

  function candidate(prefix: string, index: number): Candidate {
    const tag = String(index).padStart(4, "0")
    return {
      id: `${prefix}-member-${tag}`,
      userId: `${prefix}-user-${tag}`,
      name: `${prefix}${tag}`,
      discriminator: tag,
      avatar: null,
      avatarVersion: 0,
      statusEmoji: null,
      statusText: null,
      status: "offline",
      sub: "",
      role: "member",
    }
  }

  test("@ candidates page to completion and shared popups stay anchored through viewport resize signals", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["alice"])
    const { asUser, userId } = actors
    const { seedChannel, seedServer } = actors.seed

    const serverId = await seedServer("alice", `Mention pages ${Date.now()}`)
    const channelId = await seedChannel("alice", serverId, "mention-pages")
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(() => {
      const geometry = {
        offsetTop: 0,
        offsetLeft: 0,
        width: 390,
        height: 844,
      }
      const viewport = new EventTarget()
      for (const property of ["offsetTop", "offsetLeft", "width", "height"] as const) {
        Object.defineProperty(viewport, property, {
          configurable: true,
          get: () => geometry[property],
        })
      }
      Object.defineProperty(viewport, "scale", { configurable: true, value: 1 })
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: viewport,
      })
      Object.defineProperty(window, "__setSuggestionTestViewportSize", {
        configurable: true,
        value: (next: Partial<typeof geometry>) => {
          Object.assign(geometry, next)
          viewport.dispatchEvent(new Event("resize"))
          viewport.dispatchEvent(new Event("scroll"))
        },
      })
    })

    const pageScope = { viewerId: userId("alice"), serverId }
    const browse = Array.from({ length: 12 }, (_, index) => candidate("Browse", index + 1))
    const matches = Array.from({ length: 205 }, (_, index) => candidate("CapMatch", index + 1))
    const browseCursors: Array<string | null> = []
    const searchReads = new Map<string, number>()
    const searchCursors = new Map<string, Array<string | null>>()
    let releaseSearchTail!: () => void
    const searchTailReleased = new Promise<void>((resolve) => {
      releaseSearchTail = resolve
    })
    caseResources.own(releaseSearchTail, async (captured) => { captured() })
    let markSearchTailRequested!: () => void
    const searchTailRequested = new Promise<void>((resolve) => {
      markSearchTailRequested = resolve
    })
    caseResources.own(markSearchTailRequested, async (captured) => { captured() })

    await page.route(`**/api/community/servers/${serverId}/members**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith("/members/search")) {
        const query = url.searchParams.get("q") ?? ""
        searchReads.set(query, (searchReads.get(query) ?? 0) + 1)
        const cursor = url.searchParams.get("cursor")
        searchCursors.set(query, [...(searchCursors.get(query) ?? []), cursor])
        if (query === "Fail") {
          await route.fulfill(currentCommunityFixtureError("forced failure", 500))
          return
        }
        if (query === "NoMatch") {
          await route.fulfill({ headers: CURRENT_COMMUNITY_FIXTURE_HEADERS, json: CommunityServerMemberSearchReadSchema.parse({ ...pageScope, members: [], limit: 200, hasMore: false }) })
          return
        }
        if (query === "CapMatch" && cursor) {
          markSearchTailRequested()
          await searchTailReleased
          await route.fulfill({ headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
            json: CommunityServerMemberSearchReadSchema.parse({ ...pageScope, members: matches.slice(200), limit: 200, hasMore: false }),
          })
          return
        }
        if (query === "CapMatch") {
          await route.fulfill({ headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
            json: CommunityServerMemberSearchReadSchema.parse({
              ...pageScope,
              members: matches.slice(0, 200),
              limit: 200,
              hasMore: true,
              cursor: "search-page-2",
            }),
          })
          return
        }
      }

      const cursor = url.searchParams.get("cursor")
      browseCursors.push(cursor)
      await route.fulfill({ headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
        json: CommunityServerMembersReadSchema.parse(cursor
          ? { ...pageScope, members: browse.slice(8), limit: 8, total: 12, hasMore: false }
          : {
              ...pageScope,
              members: browse.slice(0, 8),
              limit: 8,
              total: 12,
              hasMore: true,
              cursor: "browse-page-2",
            }),
      })
    })

    await page.goto(`/c/channels/${serverId}/${channelId}`)
    const editable = composerEditable(page)
    await expect(editable).toBeVisible({ timeout: 20_000 })
    await editable.click()
    const wrappedPrefix = Array.from(
      { length: 6 },
      (_, index) => `wrapped composer line ${index + 1} keeps the terminal caret moving`,
    ).join(" ")
    await editable.fill(wrappedPrefix)
    await editable.pressSequentially(" @")
    const mentionPopup = page.getByTestId(tid.mentionPopup)
    const mentionOptions = mentionPopup.getByRole("option")
    await expect(page.getByTestId(tid.mentionOption(browse[7]!.id))).toHaveCount(1)
    await expect(page.getByTestId(tid.mentionStatus)).toHaveCount(0)
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    expect(browseCursors).toEqual([null])
    await expect(page.getByTestId(tid.mentionOption(browse[11]!.id))).toHaveCount(0)
    const popupBounds = await mentionPopup.boundingBox()
    expect(popupBounds).not.toBeNull()
    await page.mouse.move(popupBounds!.x + popupBounds!.width / 2, popupBounds!.y + popupBounds!.height / 2)
    await page.mouse.wheel(0, 800)
    await expect(page.getByTestId(tid.mentionOption(browse[11]!.id))).toHaveCount(1)
    expect(browseCursors).toEqual([null, "browse-page-2"])

    await editable.pressSequentially("CapMatch")
    await expect(page.getByTestId(tid.mentionOption(matches[0]!.id))).toBeVisible()
    await expect(mentionOptions).toHaveCount(200)
    await expect(page.getByTestId(tid.mentionStatus)).toHaveCount(0)
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    expect(searchCursors.get("CapMatch")).toEqual([null])
    await expect(page.getByTestId(tid.mentionOption(matches[0]!.id))).toHaveAttribute("aria-selected", "true")
    await editable.press("ArrowUp")
    await expect(page.getByTestId(tid.mentionOption(matches[199]!.id))).toHaveAttribute("aria-selected", "true")
    await expect(page.getByTestId(tid.mentionOption(matches[199]!.id))).toBeVisible()
    await searchTailRequested
    expect(searchCursors.get("CapMatch")).toEqual([null, "search-page-2"])
    await expect(page.getByTestId(tid.mentionStatus)).toHaveAttribute("data-state", "loading-more")
    releaseSearchTail()
    await expect(page.getByTestId(tid.mentionOption(matches[204]!.id))).toHaveCount(1)
    await expect(mentionOptions).toHaveCount(205)
    await expect(page.getByTestId(tid.mentionStatus)).toHaveCount(0)

    const readBounds = (popupTestId: string) => page.getByTestId(popupTestId).evaluate((element) => {
      const popup = element.getBoundingClientRect()
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) throw new Error("Missing composer caret")
      const caret = selection.getRangeAt(0).getBoundingClientRect()
      const viewport = window.visualViewport
      return {
        popup: {
          top: popup.top,
          bottom: popup.bottom,
          left: popup.left,
          right: popup.right,
        },
        caret: { top: caret.top, bottom: caret.bottom },
        viewport: {
          top: viewport?.offsetTop ?? 0,
          bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
          left: viewport?.offsetLeft ?? 0,
          right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
        },
      }
    })

    const expectAnchoredToCaret = (bounds: Awaited<ReturnType<typeof readBounds>>) => {
      const margin = 8
      expect(bounds.caret.top).toBeGreaterThanOrEqual(bounds.viewport.top)
      expect(bounds.caret.bottom).toBeLessThanOrEqual(bounds.viewport.bottom)
      expect(bounds.popup.top).toBeGreaterThanOrEqual(bounds.viewport.top + margin - 0.5)
      expect(bounds.popup.bottom).toBeLessThanOrEqual(bounds.viewport.bottom - margin + 0.5)
      expect(bounds.popup.left).toBeGreaterThanOrEqual(bounds.viewport.left + margin - 0.5)
      expect(bounds.popup.right).toBeLessThanOrEqual(bounds.viewport.right - margin + 0.5)
      const nearestEdgeGaps = [
        bounds.caret.top - bounds.popup.bottom,
        bounds.popup.top - bounds.caret.bottom,
      ]
      expect(
        nearestEdgeGaps.some((gap) => gap >= 3 && gap <= 5),
        `popup did not stay 4px from terminal caret: ${JSON.stringify(bounds)}`,
      ).toBe(true)
    }

    expectAnchoredToCaret(await readBounds(tid.mentionPopup))
    await page.evaluate(() => {
      const setViewport = Reflect.get(window, "__setSuggestionTestViewportSize") as
        | ((geometry: { height: number }) => void)
        | undefined
      if (!setViewport) throw new Error("Missing controlled visual viewport")
      // Chromium does not reproduce iOS Safari's fixed/layout viewport split.
      // Keep this automated journey to resize/scroll refresh and containment,
      // using a height that still contains Chromium's unpanned caret. Non-zero
      // offset projection is locked by the geometry unit contract and verified
      // with the real software keyboard in device QA.
      setViewport({ height: 820 })
    })
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    expectAnchoredToCaret(await readBounds(tid.mentionPopup))
    await page.waitForTimeout(250)
    expectAnchoredToCaret(await readBounds(tid.mentionPopup))

    await page.keyboard.press("Escape")
    await editable.press("ControlOrMeta+A")
    await editable.press("Backspace")
    await editable.fill(wrappedPrefix)
    await editable.pressSequentially(" /")
    await expect(page.getByTestId(tid.channelRefPopup)).toBeVisible()
    expectAnchoredToCaret(await readBounds(tid.channelRefPopup))
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    expectAnchoredToCaret(await readBounds(tid.channelRefPopup))

    await page.keyboard.press("Escape")
    await editable.press("ControlOrMeta+A")
    await editable.press("Backspace")
    await editable.pressSequentially("@CapMatch")
    await expect(page.getByTestId(tid.mentionOption(matches[204]!.id))).toHaveCount(1)
    await expect(page.getByTestId(tid.mentionPopup).getByRole("option")).toHaveCount(205)
    expect(searchReads.get("CapMatch")).toBe(2)

    await page.keyboard.press("Escape")
    await editable.press("ControlOrMeta+A")
    await editable.press("Backspace")
    await editable.pressSequentially("@NoMatch")
    await expect(page.getByTestId(tid.mentionStatus)).toHaveAttribute("data-state", "empty")

    await page.keyboard.press("Escape")
    await editable.press("ControlOrMeta+A")
    await editable.press("Backspace")
    await editable.pressSequentially("@Fail")
    await expect(page.getByTestId(tid.mentionStatus)).toHaveAttribute("data-state", "error")

    await page.keyboard.press("Escape")
    await editable.press("ControlOrMeta+A")
    await editable.press("Backspace")
    await editable.pressSequentially("@CapMatch")
    await expect(page.getByTestId(tid.mentionOption(matches[204]!.id))).toHaveCount(1)
    await expect(page.getByTestId(tid.mentionPopup).getByRole("option")).toHaveCount(205)
    await expect(page.getByTestId(tid.mentionStatus)).toHaveCount(0)
    expect(searchReads.get("CapMatch")).toBe(2)
    await editable.press("ArrowUp")
    const lastOption = page.getByTestId(tid.mentionOption(matches[204]!.id))
    await expect(lastOption).toHaveAttribute("aria-selected", "true")
    await expect(lastOption).toBeVisible()
    await expect(lastOption).toHaveAttribute("title", `${matches[204]!.name}#${matches[204]!.discriminator}`)
    await editable.press("Enter")
    const insertedMention = editable.locator('[data-type="mention"]')
    await expect(insertedMention).toHaveCount(1)
    await expect(insertedMention).toHaveAttribute("data-id", matches[204]!.userId)
    await expect(insertedMention).toHaveAttribute("data-label", `${matches[204]!.name}#${matches[204]!.discriminator}`)
  })
})
