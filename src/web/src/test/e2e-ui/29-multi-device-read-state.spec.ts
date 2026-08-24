import { test, expect, userId } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import {
  seedChannel,
  seedDm,
  seedDmMessage,
  seedForumThread,
  seedJoinServer,
  seedMessage,
  seedServer,
} from "./_fixtures/seed"
import {
  type CapturedCommunityFrame,
  communityFrameEvents,
  proxyCommunityWebSockets,
} from "./_fixtures/community-ws-proxy"

type CapturedReadStateEvent = CapturedCommunityFrame & {
  type: "community:read_state.advanced" | "community:inbox.changed"
  revision: number
  readStates: Array<{
    channelId: string
    lastReadMessageId: string | null
    lastReadAt: string
    lastReadSeq: number
  }>
  inboxChanged: boolean
}

function isCapturedReadStateEvent(event: CapturedCommunityFrame): event is CapturedReadStateEvent {
  return (
    (event.type === "community:read_state.advanced" || event.type === "community:inbox.changed")
    && typeof event.revision === "number"
    && Array.isArray(event.readStates)
    && event.readStates.every((state) => (
      typeof state === "object"
      && state !== null
      && "channelId" in state
      && typeof state.channelId === "string"
      && "lastReadMessageId" in state
      && (state.lastReadMessageId === null || typeof state.lastReadMessageId === "string")
      && "lastReadAt" in state
      && typeof state.lastReadAt === "string"
      && "lastReadSeq" in state
      && typeof state.lastReadSeq === "number"
    ))
    && typeof event.inboxChanged === "boolean"
  )
}

function readStateEventsSince(
  frames: CapturedCommunityFrame[],
  start: number,
): CapturedReadStateEvent[] {
  return frames
    .slice(start)
    .flatMap((frame) => communityFrameEvents(frame))
    .filter((event): event is CapturedReadStateEvent => (
      isCapturedReadStateEvent(event)
      && event.type === "community:read_state.advanced"
    ))
}

test("one human account converges read state across two browser profiles", async ({ asUser }) => {
  test.setTimeout(180_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Multi-device ${stamp}`)
  const channelName = `read-sync-${stamp}`
  const channelId = await seedChannel("alice", serverId, channelName)
  const siblingId = await seedChannel("alice", serverId, `sync-sibling-${stamp}`)
  await seedJoinServer("alice", "bob", serverId)
  await seedMessage("alice", channelId, `channel unread ${stamp}`)
  const dmId = await seedDm("alice", userId("bob"))
  await seedDmMessage("alice", dmId, `dm unread ${stamp}`)

  const deviceA = await asUser("bob")
  const deviceB = await asUser("bob")
  const proxyA = await proxyCommunityWebSockets(deviceA.context)
  const proxyB = await proxyCommunityWebSockets(deviceB.context)
  await gotoAfterUserWsAuth(deviceA.page, "/c/me")
  await gotoAfterUserWsAuth(deviceB.page, `/c/channels/${serverId}/${siblingId}`)

  await deviceB.page.getByRole("button", { name: "Inbox" }).click()
  await expect(deviceB.page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible({ timeout: 20_000 })
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toBeVisible({ timeout: 20_000 })

  const channelRead = deviceA.page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/read`,
  )
  await gotoAfterUserWsAuth(deviceA.page, `/c/channels/${serverId}/${channelId}`)
  expect((await channelRead).status()).toBe(200)
  await expect.poll(() => proxyB.frames.some((frame) =>
    communityFrameEvents(frame).some((event) =>
      isCapturedReadStateEvent(event)
      && event.type === "community:read_state.advanced"
      && event.readStates.some((advance) => advance.channelId === channelId))),
  { timeout: 20_000 }).toBe(true)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()

  const dmRead = deviceA.page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${dmId}/read`,
  )
  await gotoAfterUserWsAuth(deviceA.page, `/c/me/${dmId}`)
  expect((await dmRead).status()).toBe(200)
  await expect.poll(() => proxyB.frames.some((frame) =>
    communityFrameEvents(frame).some((event) =>
      isCapturedReadStateEvent(event)
      && event.type === "community:read_state.advanced"
      && event.readStates.some((advance) => advance.channelId === dmId))),
  { timeout: 20_000 }).toBe(true)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadDm(dmId))).toHaveCount(0)
  await expect(deviceB.page.getByText("Caught up", { exact: true })).toBeVisible()

  const orderedReadFrames = proxyB.frames.filter((frame) =>
    communityFrameEvents(frame).some((event) => event.type === "community:read_state.advanced"))
  const firstReadFrame = orderedReadFrames[0]
  expect(firstReadFrame).toBeTruthy()
  proxyB.replay(firstReadFrame!)
  await expect(deviceB.page.getByText("Caught up", { exact: true })).toBeVisible()

  await seedMessage("alice", channelId, `offline channel ${stamp}`)
  await seedDmMessage("alice", dmId, `offline dm ${stamp}`)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toBeVisible({ timeout: 20_000 })
  await expect(deviceB.page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible({ timeout: 20_000 })

  await deviceB.context.setOffline(true)
  await proxyB.disconnect()
  const offlineChannelRead = deviceA.page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/read`,
  )
  await gotoAfterUserWsAuth(deviceA.page, `/c/channels/${serverId}/${channelId}`)
  expect((await offlineChannelRead).status()).toBe(200)
  const offlineDmRead = deviceA.page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${dmId}/read`,
  )
  await gotoAfterUserWsAuth(deviceA.page, `/c/me/${dmId}`)
  expect((await offlineDmRead).status()).toBe(200)
  const snapshotResponse = deviceB.page.waitForResponse((response) =>
    response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/community/users/me/read-state",
  )
  await deviceB.context.setOffline(false)
  expect((await snapshotResponse).status()).toBe(200)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadDm(dmId))).toHaveCount(0)

  await seedMessage("alice", channelId, `read-all channel ${stamp}`)
  await seedDmMessage("alice", dmId, `read-all dm ${stamp}`)
  await gotoAfterUserWsAuth(deviceA.page, "/c/me")
  await gotoAfterUserWsAuth(deviceB.page, "/c/me")
  await deviceA.page.getByRole("button", { name: "Inbox" }).click()
  await deviceB.page.getByRole("button", { name: "Inbox" }).click()
  await expect(deviceA.page.getByRole("button", { name: "Mark all read" })).toBeEnabled()
  await expect(deviceB.page.getByRole("button", { name: "Mark all read" })).toBeEnabled()
  const readAllFrameStarts = [proxyA.frames.length, proxyB.frames.length]

  const readAllResponses = [deviceA.page, deviceB.page].flatMap((page) => [
    page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/community/users/me/inbox/unreads/read-all"),
    page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/community/users/me/inbox/dms/read-all"),
  ])
  await Promise.all([
    deviceA.page.getByRole("button", { name: "Mark all read" }).click(),
    deviceB.page.getByRole("button", { name: "Mark all read" }).click(),
  ])
  expect((await Promise.all(readAllResponses)).every((response) => response.status() === 200)).toBe(true)
  await expect(deviceA.page.getByText("Caught up", { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(deviceB.page.getByText("Caught up", { exact: true })).toBeVisible({ timeout: 20_000 })

  const readAllEvents = (frames: typeof proxyA.frames, start: number) => frames
    .slice(start)
    .flatMap((frame) => communityFrameEvents(frame))
    .filter((event): event is CapturedReadStateEvent => (
      isCapturedReadStateEvent(event) && event.type === "community:inbox.changed"
    ))
  await expect.poll(() => readAllEvents(proxyA.frames, readAllFrameStarts[0]!).length, {
    timeout: 20_000,
  }).toBe(4)
  await expect.poll(() => readAllEvents(proxyB.frames, readAllFrameStarts[1]!).length, {
    timeout: 20_000,
  }).toBe(4)
  for (const events of [
    readAllEvents(proxyA.frames, readAllFrameStarts[0]!),
    readAllEvents(proxyB.frames, readAllFrameStarts[1]!),
  ]) {
    expect(new Set(events.map((event) => event.revision)).size).toBe(events.length)
    expect(events.every((event) => event.readStates.length > 0 && event.inboxChanged)).toBe(true)
  }

  const snapshot = await (await deviceB.page.request.get(
    "/api/community/users/me/read-state",
  )).json() as {
    revision: number
    readStates: Array<{ channelId: string; lastReadSeq: number }>
  }
  const scoped = snapshot.readStates.filter((row) => row.channelId === channelId || row.channelId === dmId)
  expect(snapshot.revision).toBeGreaterThanOrEqual(6)
  expect(scoped).toHaveLength(2)
  expect(new Set(scoped.map((row) => row.channelId)).size).toBe(2)
  expect(scoped.every((row) => row.lastReadSeq > 0)).toBe(true)
})

test("human author-send and notification writers replace both active profiles", async ({ asUser }) => {
  test.setTimeout(150_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Writer sync ${stamp}`)
  const authorChannelId = await seedChannel("alice", serverId, `author-sync-${stamp}`)
  const notificationChannelId = await seedChannel("alice", serverId, `notify-sync-${stamp}`)
  await seedJoinServer("alice", "bob", serverId)
  await seedMessage("alice", authorChannelId, `author unread ${stamp}`)
  await seedMessage("alice", notificationChannelId, `notification unread ${stamp}`)

  const deviceA = await asUser("bob")
  const deviceB = await asUser("bob")
  const proxyA = await proxyCommunityWebSockets(deviceA.context)
  const proxyB = await proxyCommunityWebSockets(deviceB.context)
  await gotoAfterUserWsAuth(deviceA.page, "/c/me")
  await gotoAfterUserWsAuth(deviceB.page, "/c/me")
  await deviceB.page.getByRole("button", { name: "Inbox" }).click()
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(authorChannelId))).toBeVisible()
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(notificationChannelId))).toBeVisible()

  const authorStarts = [proxyA.frames.length, proxyB.frames.length]
  const authorStatus = await deviceA.page.evaluate(async ({ channelId, content }) => {
    const response = await fetch(`/api/community/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    })
    return response.status
  }, { channelId: authorChannelId, content: `bob author send ${stamp}` })
  expect(authorStatus).toBe(201)

  for (const [proxy, start] of [[proxyA, authorStarts[0]], [proxyB, authorStarts[1]]] as const) {
    await expect.poll(() => readStateEventsSince(proxy.frames, start!).length, {
      timeout: 20_000,
    }).toBe(1)
    const event = readStateEventsSince(proxy.frames, start!)[0]!
    expect(event.readStates.find((state) => state.channelId === authorChannelId)?.lastReadSeq)
      .toBeGreaterThan(0)
  }
  const authorEvents = [
    readStateEventsSince(proxyA.frames, authorStarts[0]!)[0]!,
    readStateEventsSince(proxyB.frames, authorStarts[1]!)[0]!,
  ]
  expect(authorEvents[0].revision).toBe(authorEvents[1].revision)
  expect(authorEvents[0].readStates).toEqual(authorEvents[1].readStates)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(authorChannelId))).toHaveCount(0)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(notificationChannelId))).toBeVisible()

  const notificationStarts = [proxyA.frames.length, proxyB.frames.length]
  const notificationStatus = await deviceA.page.evaluate(async (channelId) => {
    const response = await fetch(`/api/community/users/me/notifications/channel/${channelId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "mentions" }),
    })
    return response.status
  }, notificationChannelId)
  expect(notificationStatus).toBe(200)

  for (const [proxy, start] of [[proxyA, notificationStarts[0]], [proxyB, notificationStarts[1]]] as const) {
    await expect.poll(() => readStateEventsSince(proxy.frames, start!).length, {
      timeout: 20_000,
    }).toBe(1)
    const event = readStateEventsSince(proxy.frames, start!)[0]!
    expect(event.revision).toBeGreaterThan(authorEvents[0].revision)
    expect(event.readStates.find((state) => state.channelId === notificationChannelId)?.lastReadSeq)
      .toBeGreaterThan(0)
  }
  const notificationEvents = [
    readStateEventsSince(proxyA.frames, notificationStarts[0]!)[0]!,
    readStateEventsSince(proxyB.frames, notificationStarts[1]!)[0]!,
  ]
  expect(notificationEvents[0].revision).toBe(notificationEvents[1].revision)
  expect(notificationEvents[0].readStates).toEqual(notificationEvents[1].readStates)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(notificationChannelId))).toHaveCount(0)
})

test("forum delete broadcasts replacement and removal to both active profiles", async ({ asUser }) => {
  test.setTimeout(150_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Forum read sync ${stamp}`)
  const forumId = await seedChannel("alice", serverId, `forum-read-sync-${stamp}`, "forum")
  await seedJoinServer("alice", "bob", serverId)
  const priorChildId = await seedForumThread("alice", forumId, "Prior post", "prior body")
  const deletedChildId = await seedForumThread("bob", forumId, "Delete my post", "delete body")

  const deviceA = await asUser("bob")
  const deviceB = await asUser("bob")
  const proxyA = await proxyCommunityWebSockets(deviceA.context)
  const proxyB = await proxyCommunityWebSockets(deviceB.context)
  await gotoAfterUserWsAuth(deviceA.page, `/c/channels/${serverId}/${deletedChildId}`)
  await gotoAfterUserWsAuth(deviceB.page, `/c/channels/${serverId}/${forumId}`)
  await expect(deviceB.page.getByTestId(tid.forumThreadCard(deletedChildId))).toBeVisible()

  const threadsResponse = await deviceB.page.request.get(
    `/api/community/channels/${forumId}/threads?order=createdAt&limit=50`,
  )
  expect(threadsResponse.status()).toBe(200)
  const threads = (await threadsResponse.json()) as {
    threads: Array<{ id: string; parentMessageId: string | null }>
  }
  const priorOpenerId = threads.threads.find((thread) => thread.id === priorChildId)?.parentMessageId
  const deletedOpenerId = threads.threads.find((thread) => thread.id === deletedChildId)?.parentMessageId
  expect(priorOpenerId).toBeTruthy()
  expect(deletedOpenerId).toBeTruthy()

  const starts = [proxyA.frames.length, proxyB.frames.length]
  const deleteStatus = await deviceA.page.evaluate(async (messageId) => {
    const response = await fetch(`/api/community/messages/${messageId}`, { method: "DELETE" })
    return response.status
  }, deletedOpenerId!)
  expect(deleteStatus).toBe(204)

  for (const [proxy, start] of [[proxyA, starts[0]], [proxyB, starts[1]]] as const) {
    await expect.poll(() => readStateEventsSince(proxy.frames, start!).length, {
      timeout: 20_000,
    }).toBe(1)
    const event = readStateEventsSince(proxy.frames, start!)[0]!
    expect(event.readStates.some((state) => state.channelId === deletedChildId)).toBe(false)
    expect(event.readStates.find((state) => state.channelId === forumId)?.lastReadMessageId)
      .toBe(priorOpenerId)
  }
  const events = [
    readStateEventsSince(proxyA.frames, starts[0]!)[0]!,
    readStateEventsSince(proxyB.frames, starts[1]!)[0]!,
  ]
  expect(events[0].revision).toBe(events[1].revision)
  expect(events[0].readStates).toEqual(events[1].readStates)
  await expect(deviceB.page.getByTestId(tid.forumThreadCard(deletedChildId))).toHaveCount(0)
})
