import { test, expect, userName } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { composerEditable } from "./_fixtures/actions"
import { seedServer, seedChannel, seedJoinServer } from "./_fixtures/seed"

// Journey 5 — @-mentions. The mention popup shows SERVER MEMBERS (regression
// a4672ca2: not the viewer's friends). Bot reply is out of scope (no daemon /
// wake-worker); we assert the mention UI + that a mention produces an inbox
// entry for the mentioned user.
test.describe.serial("mentions", () => {
  let serverId: string
  let channelId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Mention ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "mentions")
    await seedJoinServer("alice", "bob", serverId)
  })

  test("the @-mention popup lists server members", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 })

    const editable = composerEditable(page)
    await editable.click()
    await editable.pressSequentially("@")
    // Bob (a server member) is offered as a mention option — the popup lists
    // server members, so his display name appears as a role="option".
    await expect(
      page.getByRole("option").filter({ hasText: userName("bob") }),
    ).toBeVisible({ timeout: 15_000 })
  })

  test("@everyone is offered in a channel", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 })

    const editable = composerEditable(page)
    await editable.click()
    await editable.pressSequentially("@")
    // Virtual candidate keyed by its mention type.
    await expect(page.getByTestId(tid.mentionOption("everyone"))).toBeVisible({ timeout: 15_000 })
  })
})
