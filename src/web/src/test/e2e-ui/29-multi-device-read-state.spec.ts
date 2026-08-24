import { test, expect, userId } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import {
  seedChannel,
  seedDm,
  seedDmMessage,
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
  advances: Array<{ channelId: string }>
  inboxChanged: boolean
}

function isCapturedReadStateEvent(event: CapturedCommunityFrame): event is CapturedReadStateEvent {
  return (
    (event.type === "community:read_state.advanced" || event.type === "community:inbox.changed")
    && typeof event.revision === "number"
    && Array.isArray(event.advances)
    && event.advances.every((advance) => (
      typeof advance === "object"
      && advance !== null
      && "channelId" in advance
      && typeof advance.channelId === "string"
    ))
    && typeof event.inboxChanged === "boolean"
  )
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
      && event.advances.some((advance) => advance.channelId === channelId))),
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
      && event.advances.some((advance) => advance.channelId === dmId))),
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
    expect(events.every((event) => event.advances.length > 0 && event.inboxChanged)).toBe(true)
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
