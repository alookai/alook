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
  communityFrameEvents,
  frozenF1090ebeDecoderAccepts,
  proxyCommunityWebSockets,
  type CapturedCommunityFrame,
} from "./_fixtures/community-ws-proxy"

function messageFrame(frame: CapturedCommunityFrame, channelId: string, content: string): boolean {
  return communityFrameEvents(frame).some((event) =>
    event.type === "community:message.create"
    && event.channelId === channelId
    && event.message?.content?.includes(content))
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
    const carolProxy = await proxyCommunityWebSockets(carol.context)
    await gotoAfterUserWsAuth(carol.page, `/c/channels/${serverId}/${forumId}`)
    await expect(carol.page.getByTestId(`community-forum-post-${threadId}`)).toBeVisible({ timeout: 20_000 })
    armed = true

    const bob = await asUser("bob")
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${threadId}`)
    await expect(composerEditable(bob.page)).toBeVisible()
    const body = `participant reply ${Date.now()}`
    await sendMessage(bob.page, body)

    await expect.poll(() => carolProxy.frames.some((frame) => armed
      && communityFrameEvents(frame).some((event) =>
        event.type === "community:channel.child_update"
        && event.parentChannelId === forumId
        && event.channelId === threadId)), { timeout: 20_000 }).toBe(true)
    expect(carolProxy.frames.some((frame) => messageFrame(frame, threadId, body))).toBe(false)
    await expect(carol.page.getByText(body, { exact: false })).toHaveCount(0)
  })

  test("Q7 channel: a held mention bundle is repaired before late release", async ({ asUser }) => {
    const serverId = await seedServer("alice", `Gap channel ${Date.now()}`)
    const channelId = await seedChannel("alice", serverId, "gap-channel")
    await seedJoinServer("alice", "bob", serverId)
    await seedMessage("alice", channelId, "gap baseline")
    const bobInfo = await memberInfo("alice", serverId, userId("bob"))

    const bob = await asUser("bob")
    let armed = false
    let dropped = false
    const missing = `missing channel ${Date.now()}`
    const later = `later channel ${Date.now()}`
    const proxy = await proxyCommunityWebSockets(bob.context, { decide: (frame) => {
      if (armed && !dropped && frame.type === "community:message.create" && frame.channelId === channelId) {
        dropped = true
        return "hold"
      }
      if (armed && !dropped && messageFrame(frame, channelId, missing)) {
        dropped = true
        return "hold"
      }
      return "forward"
    } })
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
    armed = true
    const editable = composerEditable(alice.page)
    await editable.click()
    await editable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
    await alice.page.getByTestId(`community-mention-option-${bobInfo.id}`).click()
    await editable.pressSequentially(` ${missing}`)
    await alice.page.keyboard.press("Enter")
    await expect.poll(() => dropped, { timeout: 20_000 }).toBe(true)
    await sendMessage(alice.page, later)

    await expectMessageVisible(bob.page, missing)
    await expectMessageVisible(bob.page, later)
    expect(gapRequests.length).toBeGreaterThan(0)
    expect(proxy.heldCount()).toBe(1)
    const heldBatch = proxy.frames.find((frame) => messageFrame(frame, channelId, missing))
    expect(heldBatch?.type).toBe("community:events.batch")
    expect(communityFrameEvents(heldBatch!).some((event) =>
      event.type === "community:mention.create")).toBe(true)
    expect(proxy.releaseHeld((frame) => messageFrame(frame, channelId, missing))).toBe(1)
    await bob.page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    await expect(bob.page.getByText(missing, { exact: false })).toHaveCount(1)
    expect(proxy.frames.filter((frame) => messageFrame(frame, channelId, missing))).toHaveLength(1)
    await expect.poll(async () => {
      const response = await bob.page.request.get("/api/community/servers")
      const data = await response.json() as { servers: Array<{ id: string; mentions: number }> }
      const authoritative = data.servers.find((server) => server.id === serverId)?.mentions ?? 0
      const badge = bob.page.getByTestId(`community-rail-unread-badge-${serverId}`)
      const displayed = await badge.count() === 0
        ? 0
        : Number((await badge.textContent())?.trim())
      return displayed === authoritative
    }, { timeout: 20_000 }).toBe(true)
  })

  test("Q7 DM: a dropped message frame is repaired when a later seq arrives", async ({ asUser }) => {
    const dmId = await seedDm("alice", userId("bob"))
    await seedDmMessage("alice", dmId, "dm gap baseline")
    const bob = await asUser("bob")
    let armed = false
    let dropped = false
    const missing = `missing dm ${Date.now()}`
    const later = `later dm ${Date.now()}`
    await proxyCommunityWebSockets(bob.context, { decide: (frame) => {
      if (armed && !dropped && frame.type === "community:message.create" && frame.channelId === dmId) {
        dropped = true
        return "drop"
      }
      if (armed && !dropped && messageFrame(frame, dmId, missing)) {
        dropped = true
        return "drop"
      }
      return "forward"
    } })
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
    armed = true
    await sendMessage(alice.page, missing)
    await expect.poll(() => dropped, { timeout: 20_000 }).toBe(true)
    await sendMessage(alice.page, later)

    await expectMessageVisible(bob.page, missing)
    await expectMessageVisible(bob.page, later)
    expect(gapRequests.length).toBeGreaterThan(0)
  })

  test("Q8: capable duplicate suppression ends safely at full reload", async ({ asUser }) => {
    const serverId = await seedServer("alice", `Atomic batch ${Date.now()}`)
    const channelId = await seedChannel("alice", serverId, "atomic-batch")
    await seedJoinServer("alice", "bob", serverId)
    const bobInfo = await memberInfo("alice", serverId, userId("bob"))

    const bob = await asUser("bob")
    let armed = false
    let duplicated = false
    const body = `atomic duplicate ${Date.now()}`
    const serverRequests: string[] = []
    bob.page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/community/servers") {
        serverRequests.push(request.url())
      }
    })
    const proxy = await proxyCommunityWebSockets(bob.context, { decide: (frame) => {
      if (
        armed
        && !duplicated
        && frame.type === "community:events.batch"
        && messageFrame(frame, channelId, body)
      ) {
        duplicated = true
        return "duplicate"
      }
      return "forward"
    } })
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${channelId}`)
    await expect(composerEditable(bob.page)).toBeVisible()

    const alice = await asUser("alice")
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    armed = true
    const editable = composerEditable(alice.page)
    await editable.click()
    await editable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
    await alice.page.getByTestId(`community-mention-option-${bobInfo.id}`).click()
    await editable.pressSequentially(` ${body}`)
    await alice.page.keyboard.press("Enter")
    await expect.poll(() => duplicated, { timeout: 20_000 }).toBe(true)

    const batches = proxy.frames.filter((frame) =>
      frame.type === "community:events.batch" && messageFrame(frame, channelId, body))
    expect(batches).toHaveLength(1)
    const batch = batches[0]!
    expect(batch.operationId).toMatch(/^message:[A-Za-z0-9_-]{43}$/)
    expect(batch.operationDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(communityFrameEvents(batch).map((event) => event.type)).toEqual([
      "community:message.create",
      "community:unread.bump",
      "community:mention.create",
    ])
    const messageId = communityFrameEvents(batch)[0]?.message?.id
    expect(messageId).toBeTruthy()
    await expect(bob.page.getByTestId(`community-message-${messageId}`)).toHaveCount(1)

    const requestsBeforeReload = serverRequests.length
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${channelId}`)
    await expect(bob.page.getByTestId(`community-message-${messageId}`)).toHaveCount(1)
    await expect.poll(() => serverRequests.length, { timeout: 20_000 })
      .toBeGreaterThan(requestsBeforeReload)
    const requestsBeforeReplay = serverRequests.length
    proxy.replay(batch)
    await expect.poll(() => serverRequests.length, { timeout: 20_000 })
      .toBeGreaterThan(requestsBeforeReplay)
    await expect(bob.page.getByTestId(`community-message-${messageId}`)).toHaveCount(1)
  })

  test("Q9: capable and frozen receivers converge through batch and legacy frames", async ({ asUser }) => {
    const serverId = await seedServer("alice", `Old decoder ${Date.now()}`)
    const channelId = await seedChannel("alice", serverId, "old-decoder")
    await seedJoinServer("alice", "bob", serverId)
    const dmId = await seedDm("alice", userId("bob"))
    const bobInfo = await memberInfo("alice", serverId, userId("bob"))

    const capableBob = await asUser("bob")
    const frozenBob = await asUser("bob")
    const droppedDiagnostics: string[] = []
    frozenBob.page.on("console", (message) => {
      if (message.text().includes("community_ws_frame_dropped")) droppedDiagnostics.push(message.text())
    })
    const capableProxy = await proxyCommunityWebSockets(capableBob.context)
    const frozenProxy = await proxyCommunityWebSockets(frozenBob.context, {
      stripCommunityBatchCapability: true,
    })
    await gotoAfterUserWsAuth(capableBob.page, `/c/channels/${serverId}/${channelId}`)
    await gotoAfterUserWsAuth(frozenBob.page, `/c/channels/${serverId}/${channelId}`)
    await expect(composerEditable(capableBob.page)).toBeVisible()
    await expect(composerEditable(frozenBob.page)).toBeVisible()

    const alice = await asUser("alice")
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    const capableChannelStart = capableProxy.frames.length
    const frozenChannelStart = frozenProxy.frames.length
    const editable = composerEditable(alice.page)
    await editable.click()
    await editable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
    await alice.page.getByTestId(`community-mention-option-${bobInfo.id}`).click()
    await editable.pressSequentially(" compatibility channel")
    await alice.page.keyboard.press("Enter")
    await expect.poll(() => capableProxy.frames.slice(capableChannelStart).some((frame) =>
      frame.type === "community:events.batch"
      && communityFrameEvents(frame).some((event) => event.type === "community:mention.create")), {
      timeout: 20_000,
    }).toBe(true)
    await expect.poll(() => frozenProxy.frames.slice(frozenChannelStart).some((frame) =>
      frame.type === "community:mention.create"), {
      timeout: 20_000,
    }).toBe(true)
    await expectMessageVisible(capableBob.page, "compatibility channel")
    await expectMessageVisible(frozenBob.page, "compatibility channel")

    await gotoAfterUserWsAuth(capableBob.page, `/c/me/${dmId}`)
    await gotoAfterUserWsAuth(frozenBob.page, `/c/me/${dmId}`)
    await gotoAfterUserWsAuth(alice.page, `/c/me/${dmId}`)
    const capableDmStart = capableProxy.frames.length
    const frozenDmStart = frozenProxy.frames.length
    const dmBody = `compatibility dm ${Date.now()}`
    await sendMessage(alice.page, dmBody)
    await expectMessageVisible(capableBob.page, dmBody)
    await expectMessageVisible(frozenBob.page, dmBody)

    expect(capableProxy.frames.slice(capableDmStart).filter((frame) =>
      frame.type === "community:events.batch" && messageFrame(frame, dmId, dmBody))).toHaveLength(1)
    expect(frozenProxy.frames.slice(frozenDmStart).filter((frame) =>
      messageFrame(frame, dmId, dmBody))).toHaveLength(1)

    const relevant = frozenProxy.frames.filter((frame) => [
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
    expect(frozenProxy.frames.some((frame) => frame.type === "community:events.batch")).toBe(false)
    expect(droppedDiagnostics).toEqual([])
  })
})
