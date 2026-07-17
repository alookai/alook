import { test, expect } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { sendMessage, expectMessageVisible } from "./_fixtures/actions"
import { seedServer, seedChannel, seedJoinServer } from "./_fixtures/seed"

// Journey 3 — multi-user realtime. Alice and Bob are both online in the same
// channel; a message/typing/reaction from one surfaces on the other WITHOUT a
// reload. Requires ws-do (global-setup fails fast if it's down).
test.describe.serial("multi-user realtime", () => {
  let serverId: string
  let channelId: string

  test.beforeAll(async () => {
    // Precondition (not the thing under test): Alice owns a server + channel,
    // Bob is a member. Seeded via API so the journey focuses on realtime UI.
    serverId = await seedServer("alice", `RT ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "realtime")
    await seedJoinServer("alice", "bob", serverId)
  })

  test("Alice's message reaches Bob live", async ({ asUser }) => {
    const alice = await asUser("alice")
    const bob = await asUser("bob")
    await alice.page.goto(`/c/channels/${serverId}/${channelId}`)
    await bob.page.goto(`/c/channels/${serverId}/${channelId}`)
    await alice.page.waitForURL(new RegExp(channelId), { timeout: 20_000 })
    await bob.page.waitForURL(new RegExp(channelId), { timeout: 20_000 })

    const body = `live from alice ${Date.now()}`
    await sendMessage(alice.page, body)
    // Bob sees it without reloading.
    await expectMessageVisible(bob.page, body)
  })

  test("Bob sees Alice's typing indicator, which clears after her message", async ({ asUser }) => {
    const alice = await asUser("alice")
    const bob = await asUser("bob")
    await alice.page.goto(`/c/channels/${serverId}/${channelId}`)
    await bob.page.goto(`/c/channels/${serverId}/${channelId}`)
    await bob.page.waitForURL(new RegExp(channelId), { timeout: 20_000 })

    await alice.page.getByTestId(tid.composerInput).click()
    await alice.page.keyboard.type("typing…")
    // Bob sees the floating typing pill.
    await expect(bob.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 15_000 })

    // Alice sends; her typing indicator clears on Bob's side (assert
    // presence→absence, not an exact duration).
    await alice.page.keyboard.press("Enter")
    await expect(bob.page.getByTestId(tid.typingIndicator)).toBeHidden({ timeout: 15_000 })
  })
})
