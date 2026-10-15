import { test, expect } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"
import { composerEditable } from "./_fixtures/actions"

import type { CaseActors } from "./_fixtures/case-fixture"

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
      const response = await page.request.get(`/api/community/channels/${threadId}/members`)
      expect(response.status()).toBe(200)
      const payload = await response.json() as { members: Array<{ userId: string }> }
      return payload.members.map((member) => member.userId).sort()
    }

    async function attention(role: "bob" | "carol") {
      const response = await fetch(new URL("/api/community/users/me/attention?limit=200", page.url()), {
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
        expect(await editable.evaluate((element) => Array.from(element.children).map((block) => ({
          tag: block.tagName,
          text: block.textContent,
          breaks: block.querySelectorAll("br").length,
        })))).toEqual(content.split("\n\n").map((block) => ({
          tag: "P",
          text: block.replaceAll("\n", ""),
          breaks: block.split("\n").length - 1,
        })))
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
      const persisted = await page.request.get(`/api/community/messages/${created.message.id}`)
      expect(persisted.status()).toBe(200)
      expect(await persisted.json()).toMatchObject({ id: created.message.id, content, channelId: threadId })
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

    const explicit = await page.request.post(`/api/community/channels/${threadId}/messages`, {
      data: { content: "explicit API broadcast without body token", mentionType: "everyone" },
    })
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
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    await prepareCase1(actors)

    const { page } = await asUser("alice")
    for (const bad of ["Ann#1234", "bad@name", "line\nbreak"]) {
      const res = await page.request.patch("/api/community/users/me/profile", {
        headers: { "Content-Type": "application/json" },
        data: { name: bad },
      })
      expect(res.status()).toBe(400)
    }
    // A valid spaced name still saves.
    const ok = await page.request.patch("/api/community/users/me/profile", {
      headers: { "Content-Type": "application/json" },
      data: { name: "Jane Roe" },
    })
    expect(ok.status()).toBe(200)
  })
})
