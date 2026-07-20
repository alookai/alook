import { test, expect, userId } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { composerEditable } from "./_fixtures/actions"
import {
  seedServer,
  seedChannel,
  seedJoinServer,
  seedMessage,
  renameUser,
  memberInfo,
} from "./_fixtures/seed"

// Journey 13 — mandatory mention discriminator. Every member mention serializes
// as `@Name#dddd`, which lets a name with spaces render as one pill AND makes a
// same-name mention resolve to the EXACT person on click (regression for the
// sanitize allowlist case-mismatch that stripped the discriminator — bugfix
// 4044fd6c). A hand-typed bare `@name` is not a mention. See
// plans/mandatory-mention-discriminator.md.
//
// Fixture: Bob and Carol are both renamed "John Doe" (spaced name), each keeping
// its own auto-assigned discriminator — so the same journey exercises the
// spaced-name pill and the same-name disambiguation.
test.describe.serial("mentions — mandatory discriminator", () => {
  let serverId: string
  let channelId: string
  let bob: { id: string; discriminator: string }
  let carol: { id: string; discriminator: string }

  test.beforeAll(async () => {
    await renameUser("bob", "John Doe")
    await renameUser("carol", "John Doe")
    serverId = await seedServer("alice", `Mentions ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "mentions")
    await seedJoinServer("alice", "bob", serverId)
    await seedJoinServer("alice", "carol", serverId)
    bob = await memberInfo("alice", serverId, userId("bob"))
    carol = await memberInfo("alice", serverId, userId("carol"))
    // Distinct discriminators are what the disambiguation hinges on — if the
    // two happened to collide the journey couldn't prove per-user resolution.
    expect(bob.discriminator).not.toBe(carol.discriminator)
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

  test("same-name mentions each resolve to the exact user on pill click (spaced name, no leaked #dddd)", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })

    await mentionAndSend(page, bob.id, "msgBob")
    await mentionAndSend(page, carol.id, "msgCarol")

    // Both messages render a single `@John Doe` pill with NO visible tag.
    const bobMsg = page.getByText("msgBob", { exact: false }).first()
    const carolMsg = page.getByText("msgCarol", { exact: false }).first()
    await expect(bobMsg).toBeVisible({ timeout: 15_000 })
    await expect(carolMsg).toBeVisible({ timeout: 15_000 })
    // Wait for BOTH pills to exist before touching either — a bare `.nth(1)`
    // click would otherwise hang to the 60s test timeout if the second pill
    // hasn't rendered yet (the observed flake).
    const pills = page.locator("button", { hasText: "@John Doe" })
    await expect(pills).toHaveCount(2, { timeout: 15_000 })
    const bobPill = pills.first()
    await expect(bobPill).toBeVisible()
    await expect(bobPill).not.toContainText("#")

    // Click Bob's pill → the profile card shows Bob's discriminator, not Carol's.
    const card = page.getByTestId(tid.profileCard)
    await expect(async () => {
      await bobPill.click({ timeout: 5_000 })
      await expect(card).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 30_000 })
    await expect(card).toContainText(`#${bob.discriminator}`)
    await expect(card).not.toContainText(`#${carol.discriminator}`)
    // Dismiss the first card, then open the second pill's. The popover renders
    // a portalled overlay that lingers during its exit animation and intercepts
    // pointer events; under full-run load `toBeHidden` on the card doesn't
    // guarantee the overlay has detached. Retry the whole dismiss→click so a
    // transient interception (or a stray still-open card) re-presses Escape and
    // tries again, instead of hanging the bare click to the 60s test timeout.
    const carolPill = pills.nth(1)
    await expect(async () => {
      if (await card.isVisible()) {
        await page.keyboard.press("Escape")
        await expect(card).toBeHidden({ timeout: 5_000 })
      }
      await carolPill.click({ timeout: 5_000 })
      await expect(card).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 30_000 })
    await expect(card).toContainText(`#${carol.discriminator}`)
  })

  test("a hand-typed bare @name (not picked from the popup) is inert — plain text, no pill", async ({ asUser }) => {
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

  test("@everyone renders with the distinct primary styling (its flag survives sanitize)", async ({ asUser }) => {
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

  test("setting a display name with # / @ / newline is rejected (400)", async ({ asUser }) => {
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
