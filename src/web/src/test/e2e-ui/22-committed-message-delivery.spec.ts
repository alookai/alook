import { test, expect, userId } from "./_fixtures/community-fixture"
import { composerEditable, expectMessageVisible, gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import {
  memberInfo,
  seedChannel,
  seedDm,
  seedDmMessage,
  seedForumThread,
  seedJoinServer,
  seedMessage,
  seedServer,
} from "./_fixtures/seed"
import {
  frozenF1090ebeDecoderAccepts,
  proxyCommunityWebSockets,
  type CapturedCommunityFrame,
} from "./_fixtures/community-ws-proxy"

function messageFrame(frame: CapturedCommunityFrame, channelId: string, content: string): boolean {
  return frame.type === "community:message.create"
    && frame.channelId === channelId
    && frame.message?.content === content
}

test.describe.serial("committed message delivery QA", () => {
  test("Q4: a parent-only forum viewer gets the parent projection and no child message", async ({ asUser }) => {
    const serverId = await seedServer("alice", `Parent projection ${Date.now()}`)
    const forumId = await seedChannel("alice", serverId, "parent-projection", "forum")
    await seedJoinServer("alice", "bob", serverId)
    await seedJoinServer("alice", "carol", serverId)
    const threadId = await seedForumThread("alice", forumId, `Projection ${Date.now()}`, "opener")

    const carol = await asUser("carol")
    let armed = false
    const carolFrames = await proxyCommunityWebSockets(carol.context)
    await gotoAfterUserWsAuth(carol.page, `/c/channels/${serverId}/${forumId}`)
    await expect(carol.page.getByTestId(`community-forum-post-${threadId}`)).toBeVisible({ timeout: 20_000 })
    armed = true

    const bob = await asUser("bob")
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${threadId}`)
    await expect(composerEditable(bob.page)).toBeVisible()
    const body = `participant reply ${Date.now()}`
    await sendMessage(bob.page, body)

    await expect.poll(() => carolFrames.some((frame) => armed
      && frame.type === "community:channel.child_update"
      && frame.parentChannelId === forumId
      && frame.channelId === threadId), { timeout: 20_000 }).toBe(true)
    expect(carolFrames.some((frame) => messageFrame(frame, threadId, body))).toBe(false)
    await expect(carol.page.getByText(body, { exact: false })).toHaveCount(0)
  })

  test("Q7 channel: a dropped message frame is repaired when a later seq arrives", async ({ asUser }) => {
    const serverId = await seedServer("alice", `Gap channel ${Date.now()}`)
    const channelId = await seedChannel("alice", serverId, "gap-channel")
    await seedJoinServer("alice", "bob", serverId)
    await seedMessage("alice", channelId, "gap baseline")

    const bob = await asUser("bob")
    let armed = false
    let dropped = false
    const frames = await proxyCommunityWebSockets(bob.context, (frame) => {
      if (armed && !dropped && frame.type === "community:message.create" && frame.channelId === channelId) {
        dropped = true
        return "drop"
      }
      return "forward"
    })
    const gapRequests: string[] = []
    bob.page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.pathname === `/api/community/channels/${channelId}/messages` && url.searchParams.has("since")) {
        gapRequests.push(url.toString())
      }
    })
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${channelId}`)
    await expect(composerEditable(bob.page)).toBeVisible()

    const alice = await asUser("alice")
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    const missing = `missing channel ${Date.now()}`
    const later = `later channel ${Date.now()}`
    armed = true
    await sendMessage(alice.page, missing)
    await expect.poll(() => dropped, { timeout: 20_000 }).toBe(true)
    await sendMessage(alice.page, later)

    await expectMessageVisible(bob.page, missing)
    await expectMessageVisible(bob.page, later)
    expect(gapRequests.length).toBeGreaterThan(0)
    expect(frames.filter((frame) => messageFrame(frame, channelId, missing))).toHaveLength(1)
  })

  test("Q7 DM: a dropped message frame is repaired when a later seq arrives", async ({ asUser }) => {
    const dmId = await seedDm("alice", userId("bob"))
    await seedDmMessage("alice", dmId, "dm gap baseline")
    const bob = await asUser("bob")
    let armed = false
    let dropped = false
    await proxyCommunityWebSockets(bob.context, (frame) => {
      if (armed && !dropped && frame.type === "community:message.create" && frame.channelId === dmId) {
        dropped = true
        return "drop"
      }
      return "forward"
    })
    const gapRequests: string[] = []
    bob.page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.pathname === `/api/community/channels/${dmId}/messages` && url.searchParams.has("since")) {
        gapRequests.push(url.toString())
      }
    })
    await gotoAfterUserWsAuth(bob.page, `/c/me/${dmId}`)
    await expect(composerEditable(bob.page)).toBeVisible()

    const alice = await asUser("alice")
    await gotoAfterUserWsAuth(alice.page, `/c/me/${dmId}`)
    const missing = `missing dm ${Date.now()}`
    const later = `later dm ${Date.now()}`
    armed = true
    await sendMessage(alice.page, missing)
    await expect.poll(() => dropped, { timeout: 20_000 }).toBe(true)
    await sendMessage(alice.page, later)

    await expectMessageVisible(bob.page, missing)
    await expectMessageVisible(bob.page, later)
    expect(gapRequests.length).toBeGreaterThan(0)
  })

  test("Q8: the frozen f1090ebe browser decoder accepts live channel, mention, and DM frames", async ({ asUser }) => {
    const serverId = await seedServer("alice", `Old decoder ${Date.now()}`)
    const channelId = await seedChannel("alice", serverId, "old-decoder")
    await seedJoinServer("alice", "bob", serverId)
    const dmId = await seedDm("alice", userId("bob"))
    const bobInfo = await memberInfo("alice", serverId, userId("bob"))

    const bob = await asUser("bob")
    const droppedDiagnostics: string[] = []
    bob.page.on("console", (message) => {
      if (message.text().includes("community_ws_frame_dropped")) droppedDiagnostics.push(message.text())
    })
    const frames = await proxyCommunityWebSockets(bob.context)
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${channelId}`)
    await expect(composerEditable(bob.page)).toBeVisible()

    const alice = await asUser("alice")
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    const editable = composerEditable(alice.page)
    await editable.click()
    await editable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
    await alice.page.getByTestId(`community-mention-option-${bobInfo.id}`).click()
    await editable.pressSequentially(" compatibility channel")
    await alice.page.keyboard.press("Enter")
    await expect.poll(() => frames.some((frame) => frame.type === "community:mention.create"), {
      timeout: 20_000,
    }).toBe(true)

    await gotoAfterUserWsAuth(bob.page, `/c/me/${dmId}`)
    await gotoAfterUserWsAuth(alice.page, `/c/me/${dmId}`)
    const dmBody = `compatibility dm ${Date.now()}`
    await sendMessage(alice.page, dmBody)
    await expectMessageVisible(bob.page, dmBody)

    const relevant = frames.filter((frame) => [
      "community:message.create",
      "community:unread.bump",
      "community:mention.create",
      "community:channel.member_add",
      "community:channel.child_update",
    ].includes(frame.type))
    expect(relevant.some((frame) => frame.type === "community:message.create" && frame.channelId === channelId)).toBe(true)
    expect(relevant.some((frame) => frame.type === "community:mention.create" && frame.channelId === channelId)).toBe(true)
    expect(relevant.some((frame) => frame.type === "community:message.create" && frame.channelId === dmId)).toBe(true)
    expect(relevant.every(frozenF1090ebeDecoderAccepts)).toBe(true)
    expect(droppedDiagnostics).toEqual([])
  })
})
