import { test, expect } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { sendMessage, expectMessageVisible, composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
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
    const messagesPath = `/api/community/channels/${channelId}/messages`
    const bobInitialMessagesPromise = bob.page.waitForResponse((response) => {
      return response.request().method() === "GET"
        && new URL(response.url()).pathname === messagesPath
    })
    await bob.page.goto(`/c/channels/${serverId}/${channelId}`)
    await alice.page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })
    await bob.page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })

    // A committed channel URL can still be rendering its initial skeleton.
    // Wait for Bob's message query and composer surface before Alice sends, so
    // the final assertion proves realtime delivery rather than initial fetch.
    const bobInitialMessages = await bobInitialMessagesPromise
    expect(bobInitialMessages.status()).toBe(200)
    await expect(composerEditable(bob.page)).toBeVisible()

    const body = `live from alice ${Date.now()}`
    const aliceMessagePromise = alice.page.waitForResponse((response) => {
      return response.request().method() === "POST"
        && new URL(response.url()).pathname === messagesPath
    })
    await sendMessage(alice.page, body)
    const aliceMessage = await aliceMessagePromise
    expect(aliceMessage.status()).toBe(201)
    // Bob sees it without reloading.
    await expectMessageVisible(bob.page, body)
  })

  test("Bob sees Alice's typing indicator, which clears after her message", async ({ asUser }) => {
    const alice = await asUser("alice")
    const bob = await asUser("bob")
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${channelId}`)
    await bob.page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })

    // Gate on Bob's WS subscription being LIVE before testing the typing
    // indicator — otherwise Alice's one-shot `typing.start` can fire into the
    // gap before Bob's channel subscription is established and be missed
    // forever (the indicator self-clears after 8s and never re-fires). Prove
    // liveness with a real message round-trip: Alice sends, Bob receives it via
    // WS. Only then is Bob guaranteed subscribed.
    const ping = `ws-ready ${Date.now()}`
    await sendMessage(alice.page, ping)
    await expectMessageVisible(bob.page, ping)

    // `typing.start` is throttled to one emit per 3s per channel, so a single
    // keystroke that races the subscription is lost. Poll: re-type in short
    // bursts (clearing the throttle each burst is unnecessary — a fresh burst
    // after 3s re-emits) until Bob sees the pill, within the 8s self-clear.
    const aliceEditable = composerEditable(alice.page)
    await expect(async () => {
      await aliceEditable.click()
      // Clear any text a prior burst left so a stray Enter can't send noise and
      // the composer stays a clean typing surface.
      await alice.page.keyboard.press("ControlOrMeta+A")
      await alice.page.keyboard.press("Backspace")
      await alice.page.keyboard.type("typing…")
      await expect(bob.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 4_000 })
    }).toPass({ timeout: 20_000 })

    // Alice sends; her typing indicator clears on Bob's side (assert
    // presence→absence, not an exact duration).
    const finalMessagePromise = alice.page.waitForResponse((response) => {
      return response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
    })
    await alice.page.keyboard.press("Enter")
    const finalMessage = await finalMessagePromise
    expect(finalMessage.status()).toBe(201)
    await expectMessageVisible(bob.page, "typing…")
    await expect(bob.page.getByTestId(tid.typingIndicator)).toBeHidden({ timeout: 15_000 })
  })
})
