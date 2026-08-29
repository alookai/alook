import { test, expect, userId, userName } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import {
  communityFrameEvents,
  proxyCommunityWebSockets,
} from "./_fixtures/community-ws-proxy"
import {
  seedChannel,
  seedFriendship,
  seedServer,
  createInvite,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

test("an offline friend comes online through reconnect and receives the invite DM", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Friend invite ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "invite-friend")
  await seedFriendship("alice", "bob", userId("bob"))

  const alice = await asUser("alice")
  const aliceWs = await proxyCommunityWebSockets(alice.context)
  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
  await expect(alice.page.getByRole("button", { name: "Invite to server" })).toBeVisible()
  await alice.page.getByRole("button", { name: "Invite to server" }).click()

  const dialog = alice.page.getByRole("dialog")
  const bobRow = dialog.getByText(userName("bob"), { exact: true }).locator("..").locator("..")
  await expect(bobRow.getByRole("button", { name: "Invite" })).toBeVisible({ timeout: 20_000 })
  await expect(bobRow.locator('[data-presence="offline"]')).toHaveCount(1)
  const inviteInput = dialog.locator("input[readonly]")
  await expect(inviteInput).not.toHaveValue("")
  const inviteUrl = await inviteInput.inputValue()
  expect(new URL(inviteUrl).pathname).toMatch(/^\/c\/invite\/[^/]+$/)

  const bob = await asUser("bob")
  const bobWs = await proxyCommunityWebSockets(bob.context)
  const alicePresenceStart = aliceWs.frames.length
  await gotoAfterUserWsAuth(bob.page, "/c/me")
  await expect(bob.page).toHaveURL(/\/c\/me\/friends$/)
  await expect(bobRow.locator('[data-presence="online"]')).toHaveCount(1, { timeout: 20_000 })
  await expect.poll(() => aliceWs.frames.slice(alicePresenceStart)
    .flatMap(communityFrameEvents)
    .some((frame) => frame.type === "community:presence.update"
      && frame.userId === userId("bob")
      && frame.online === true)).toBe(true)

  const connectionBaseline = bobWs.connectionCount()
  await bobWs.disconnect()
  await expect.poll(() => bobWs.connectionCount(), { timeout: 30_000 })
    .toBeGreaterThan(connectionBaseline)
  await expect.poll(() => bobWs.connectionFrames.some((frame) =>
    frame.connectionId > connectionBaseline
    && frame.direction === "server-to-client"
    && frame.type === "auth.ok",
  )).toBe(true)
  await expect(bobRow.locator('[data-presence="online"]')).toHaveCount(1, { timeout: 20_000 })

  const inviteMessagePosts: string[] = []
  alice.page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname
    if (
      request.method() !== "POST"
      || !/^\/api\/community\/channels\/[^/]+\/messages$/.test(pathname)
    ) return
    const body = request.postDataJSON() as { content?: string } | null
    if (body?.content === inviteUrl) inviteMessagePosts.push(pathname)
  })
  const dmResponsePromise = alice.page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/community/channels",
  )
  const messageResponsePromise = alice.page.waitForResponse((response) =>
    response.request().method() === "POST"
    && /^\/api\/community\/channels\/[^/]+\/messages$/.test(new URL(response.url()).pathname),
  )
  await bobRow.getByRole("button", { name: "Invite" }).click()
  const [dmResponse, messageResponse] = await Promise.all([
    dmResponsePromise,
    messageResponsePromise,
  ])
  expect(dmResponse.status()).toBe(201)
  expect(messageResponse.status()).toBe(201)
  const dmPayload = await dmResponse.json() as { conversation: { id: string } }
  const messagePayload = await messageResponse.json() as { message: { id: string } }
  await expect(bobRow.getByRole("button", { name: "Invited" })).toBeDisabled()

  await expect(bob.page.getByTestId(tid.dmRow(dmPayload.conversation.id))).toBeVisible({ timeout: 20_000 })
  await bob.page.getByTestId(tid.dmRow(dmPayload.conversation.id)).click()
  await bob.page.waitForURL(new RegExp(`/c/me/${dmPayload.conversation.id}$`), {
    timeout: 20_000,
    waitUntil: "commit",
  })
  await expect(bob.page.getByTestId(tid.message(messagePayload.message.id))).toHaveCount(1)
  await expect(bob.page.getByText(inviteUrl, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await bob.page.waitForTimeout(500)
  expect(inviteMessagePosts).toHaveLength(1)
  await expect(bob.page.locator("[data-msg-id]").filter({ hasText: inviteUrl }))
    .toHaveCount(1)
})

// Journey 7 — invite accept (second identity). Alice creates a server + invite
// via API, Bob accepts it through the UI, and the new server appears in Bob's
// rail without a manual reload (regression 1c2e2a05).
test.describe.serial("invite accept", () => {
  let serverId: string
  let inviteToken: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Invite ${Date.now()}`)
    inviteToken = await createInvite("alice", serverId)
  })

  test("Bob accepts the invite and lands in the server", async ({ asUser }) => {
    const { page } = await asUser("bob")
    await page.goto(`/c/invite/${inviteToken}`)
    // Accept via the join CTA.
    await page.getByRole("button", { name: /join server/i }).first().click()
    await page.waitForURL(new RegExp(`/c/channels/${serverId}`), { timeout: 20_000, waitUntil: "commit" })
    await expect(page).toHaveURL(new RegExp(`/c/channels/${serverId}`))
  })
})
