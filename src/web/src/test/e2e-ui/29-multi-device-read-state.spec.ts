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
  inboxChanged: boolean
}

function isCapturedReadStateEvent(event: CapturedCommunityFrame): event is CapturedReadStateEvent {
  return (
    (event.type === "community:read_state.advanced" || event.type === "community:inbox.changed")
    && typeof event.revision === "number"
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

function unreadBumpsSince(
  frames: CapturedCommunityFrame[],
  start: number,
  channelId: string,
) {
  return frames
    .slice(start)
    .flatMap((frame) => communityFrameEvents(frame))
    .filter((event) => event.type === "community:unread.bump" && event.channelId === channelId)
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

  const accountSnapshot = async () => await (await deviceB.page.request.get(
    "/api/community/users/me/read-state",
  )).json() as {
    revision: number
    readStates: Array<{ channelId: string; lastReadSeq: number }>
  }
  const channelResponses: number[] = []
  const trackChannelResponse = (response: {
    request: () => { method: () => string }
    url: () => string
    status: () => number
  }) => {
    if (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${channelId}/read`
    ) channelResponses.push(response.status())
  }
  const beforeChannelRead = await accountSnapshot()
  deviceA.page.on("response", trackChannelResponse)

  const channelRead = deviceA.page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/read`,
  )
  const channelRepair = deviceB.page.waitForResponse((response) =>
    response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/community/users/me/read-state",
  )
  const channelFrameStart = proxyB.frames.length
  await gotoAfterUserWsAuth(deviceA.page, `/c/channels/${serverId}/${channelId}`)
  expect((await channelRead).status()).toBe(200)
  await expect.poll(() => readStateEventsSince(proxyB.frames, channelFrameStart).length,
    { timeout: 20_000 }).toBeGreaterThan(0)
  expect((await channelRepair).status()).toBe(200)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()
  await deviceA.page.waitForTimeout(1_200)
  expect(channelResponses).toEqual([200])
  const afterChannelRead = await accountSnapshot()
  expect(afterChannelRead.revision).toBe(beforeChannelRead.revision + 1)
  expect(afterChannelRead.readStates.find((row) => row.channelId === channelId)?.lastReadSeq)
    .toBeGreaterThan(0)
  deviceA.page.off("response", trackChannelResponse)

  const dmResponses: number[] = []
  const trackDmResponse = (response: {
    request: () => { method: () => string }
    url: () => string
    status: () => number
  }) => {
    if (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${dmId}/read`
    ) dmResponses.push(response.status())
  }
  const beforeDmRead = await accountSnapshot()
  deviceA.page.on("response", trackDmResponse)

  const dmRead = deviceA.page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${dmId}/read`,
  )
  const dmRepair = deviceB.page.waitForResponse((response) =>
    response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/community/users/me/read-state",
  )
  const dmFrameStart = proxyB.frames.length
  await gotoAfterUserWsAuth(deviceA.page, `/c/me/${dmId}`)
  expect((await dmRead).status()).toBe(200)
  await expect.poll(() => readStateEventsSince(proxyB.frames, dmFrameStart).length,
    { timeout: 20_000 }).toBeGreaterThan(0)
  expect((await dmRepair).status()).toBe(200)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadDm(dmId))).toHaveCount(0)
  await expect(deviceB.page.getByText("Caught up", { exact: true })).toBeVisible()
  await deviceA.page.waitForTimeout(1_200)
  expect(dmResponses).toEqual([200])
  const afterDmRead = await accountSnapshot()
  expect(afterDmRead.revision).toBe(beforeDmRead.revision + 1)
  expect(afterDmRead.readStates.find((row) => row.channelId === dmId)?.lastReadSeq)
    .toBeGreaterThan(0)
  deviceA.page.off("response", trackDmResponse)

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
  const completedReadAllResponses = await Promise.all(readAllResponses)
  expect(completedReadAllResponses.every((response) => response.status() === 200)).toBe(true)
  const readAllResults = await Promise.all(completedReadAllResponses.map(async (response) =>
    await response.json() as { changed: boolean; revision: number }))
  expect(readAllResults.filter((result) => result.changed)).toHaveLength(1)
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
  }).toBe(1)
  await expect.poll(() => readAllEvents(proxyB.frames, readAllFrameStarts[1]!).length, {
    timeout: 20_000,
  }).toBe(1)
  for (const events of [
    readAllEvents(proxyA.frames, readAllFrameStarts[0]!),
    readAllEvents(proxyB.frames, readAllFrameStarts[1]!),
  ]) {
    expect(events[0]?.revision).toBe(readAllResults.find((result) => result.changed)?.revision)
    expect(events.every((event) => event.inboxChanged && !("readStates" in event))).toBe(true)
  }

  const snapshot = await (await deviceB.page.request.get(
    "/api/community/users/me/read-state",
  )).json() as {
    revision: number
    readStates: Array<{ channelId: string; lastReadSeq: number }>
  }
  const scoped = snapshot.readStates.filter((row) => row.channelId === channelId || row.channelId === dmId)
  expect(snapshot.revision).toBeGreaterThanOrEqual(5)
  expect(scoped).toHaveLength(2)
  expect(new Set(scoped.map((row) => row.channelId)).size).toBe(2)
  expect(scoped.every((row) => row.lastReadSeq > 0)).toBe(true)
})

test("hidden eager channel and DM mounts defer cross-device reads until visible", async ({ asUser }) => {
  test.setTimeout(180_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Hidden eager sync ${stamp}`)
  const channelId = await seedChannel("alice", serverId, `hidden-eager-${stamp}`)
  await seedJoinServer("alice", "bob", serverId)
  const channelBody = `hidden eager channel ${stamp}`
  await seedMessage("alice", channelId, channelBody)
  const dmId = await seedDm("alice", userId("bob"))
  const dmBody = `hidden eager dm ${stamp}`
  await seedDmMessage("alice", dmId, dmBody)

  const deviceA = await asUser("bob")
  const deviceB = await asUser("bob")
  await gotoAfterUserWsAuth(deviceA.page, "/c/me")
  await gotoAfterUserWsAuth(deviceB.page, "/c/me")
  await deviceA.page.evaluate(() => {
    let qaVisibility: DocumentVisibilityState = "visible"
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => qaVisibility,
    })
    Object.defineProperty(window, "__alookQaSetVisibility", {
      configurable: true,
      value: (next: DocumentVisibilityState) => {
        qaVisibility = next
        document.dispatchEvent(new Event("visibilitychange"))
      },
    })
  })
  const setDeviceAVisibility = async (state: "hidden" | "visible") => {
    await deviceA.page.evaluate((nextState) => {
      const setter = (window as Window & {
        __alookQaSetVisibility?: (state: DocumentVisibilityState) => void
      }).__alookQaSetVisibility
      if (!setter) throw new Error("QA visibility setter missing")
      setter(nextState)
    }, state)
    await expect.poll(() => deviceA.page.evaluate(() => document.visibilityState))
      .toBe(state)
  }
  const accountSnapshot = async () => await (await deviceB.page.request.get(
    "/api/community/users/me/read-state",
  )).json() as {
    revision: number
    readStates: Array<{ channelId: string; lastReadSeq: number }>
  }
  const scopedSeq = (
    snapshot: Awaited<ReturnType<typeof accountSnapshot>>,
    targetChannelId: string,
  ) => snapshot.readStates.find((row) => row.channelId === targetChannelId)?.lastReadSeq ?? 0

  await deviceB.page.getByRole("button", { name: "Inbox" }).click()
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toBeVisible()
  await expect(deviceB.page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()

  const beforeChannel = await accountSnapshot()
  const channelReadResponses: number[] = []
  const trackChannelReads = (response: { request: () => { method: () => string }; url: () => string; status: () => number }) => {
    if (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${channelId}/read`
    ) channelReadResponses.push(response.status())
  }
  deviceA.page.on("response", trackChannelReads)
  await setDeviceAVisibility("hidden")
  await deviceA.page.getByTestId(tid.serverIcon(serverId)).click()
  await expect(deviceA.page.getByTestId(tid.channelRow(channelId))).toBeVisible()
  await deviceA.page.getByTestId(tid.channelRow(channelId)).evaluate((element) => {
    ;(element as HTMLElement).click()
  })
  await expect.poll(() => new URL(deviceA.page.url()).pathname, { timeout: 20_000 })
    .toBe(`/c/channels/${serverId}/${channelId}`)
  await expect.poll(() => deviceA.page.evaluate(() => document.visibilityState)).toBe("hidden")
  await expect(deviceA.page.getByText(channelBody, { exact: true })).toBeVisible()
  await deviceA.page.waitForTimeout(1_000)
  expect(channelReadResponses).toEqual([])
  const hiddenChannel = await accountSnapshot()
  expect(hiddenChannel.revision).toBe(beforeChannel.revision)
  expect(scopedSeq(hiddenChannel, channelId)).toBe(scopedSeq(beforeChannel, channelId))
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toBeVisible()

  const visibleChannelRead = deviceA.page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/read`,
  )
  await setDeviceAVisibility("visible")
  expect((await visibleChannelRead).status()).toBe(200)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)
  deviceA.page.off("response", trackChannelReads)

  await deviceA.page.getByTestId(tid.homeButton).click()
  await expect.poll(() => new URL(deviceA.page.url()).pathname).toMatch(/^\/c\/me(?:\/|$)/)
  await expect(deviceA.page.getByTestId(tid.dmRow(dmId))).toBeVisible()
  const beforeDm = await accountSnapshot()
  const dmReadResponses: number[] = []
  const trackDmReads = (response: { request: () => { method: () => string }; url: () => string; status: () => number }) => {
    if (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${dmId}/read`
    ) dmReadResponses.push(response.status())
  }
  deviceA.page.on("response", trackDmReads)
  await setDeviceAVisibility("hidden")
  await deviceA.page.getByTestId(tid.dmRow(dmId)).click()
  await expect.poll(() => new URL(deviceA.page.url()).pathname, { timeout: 20_000 })
    .toBe(`/c/me/${dmId}`)
  await expect.poll(() => deviceA.page.evaluate(() => document.visibilityState)).toBe("hidden")
  await expect(deviceA.page.getByText(dmBody, { exact: true })).toBeVisible()
  await deviceA.page.waitForTimeout(1_000)
  expect(dmReadResponses).toEqual([])
  const hiddenDm = await accountSnapshot()
  expect(hiddenDm.revision).toBe(beforeDm.revision)
  expect(scopedSeq(hiddenDm, dmId)).toBe(scopedSeq(beforeDm, dmId))
  await expect(deviceB.page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()

  const visibleDmRead = deviceA.page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${dmId}/read`,
  )
  await setDeviceAVisibility("visible")
  expect((await visibleDmRead).status()).toBe(200)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadDm(dmId))).toHaveCount(0)
  deviceA.page.off("response", trackDmReads)
})

test("a visible live tail clears both devices while an unseen tail stays unread", async ({ asUser }) => {
  test.setTimeout(180_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Visible read sync ${stamp}`)
  const channelId = await seedChannel("alice", serverId, `visible-sync-${stamp}`)
  const siblingId = await seedChannel("alice", serverId, `visible-sibling-${stamp}`)
  await seedJoinServer("alice", "bob", serverId)
  for (let index = 0; index < 28; index += 1) {
    await seedMessage("alice", channelId, `visible baseline ${index} ${stamp}`)
  }

  const deviceA = await asUser("bob")
  const deviceB = await asUser("bob")
  const proxyA = await proxyCommunityWebSockets(deviceA.context)
  const proxyB = await proxyCommunityWebSockets(deviceB.context)
  await gotoAfterUserWsAuth(deviceA.page, `/c/channels/${serverId}/${channelId}`)
  await gotoAfterUserWsAuth(deviceB.page, `/c/channels/${serverId}/${siblingId}`)
  await deviceB.page.getByRole("button", { name: "Inbox" }).click()
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)

  const scroller = deviceA.page
    .locator("[data-onboarding-target='channel-composer']")
    .locator("xpath=ancestor::main[1]")
    .locator(".thin-scrollbar")
    .first()
  await expect(deviceA.page.getByTestId(tid.scrollToPresent)).toBeVisible()
  await deviceA.page.getByTestId(tid.scrollToPresent).click()
  await expect(deviceA.page.getByTestId(tid.scrollToPresent)).toHaveCount(0)

  const visibleStarts = [proxyA.frames.length, proxyB.frames.length]
  const visibleRead = deviceA.page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/read`,
  )
  const visibleBody = `visible live tail ${stamp}`
  await seedMessage("alice", channelId, visibleBody)
  await expect(deviceA.page.getByText(visibleBody, { exact: true })).toBeVisible()
  for (const [proxy, start] of [[proxyA, visibleStarts[0]], [proxyB, visibleStarts[1]]] as const) {
    await expect.poll(() => unreadBumpsSince(proxy.frames, start!, channelId).length, {
      timeout: 20_000,
    }).toBeGreaterThan(0)
  }
  expect((await visibleRead).status()).toBe(200)
  await expect.poll(() => readStateEventsSince(proxyB.frames, visibleStarts[1]!).length, {
    timeout: 20_000,
  }).toBeGreaterThan(0)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)

  const setDeviceAVisibility = async (state: "hidden" | "visible") => {
    await deviceA.page.evaluate((nextState) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => nextState,
      })
      document.dispatchEvent(new Event("visibilitychange"))
    }, state)
    await expect.poll(() => deviceA.page.evaluate(() => document.visibilityState))
      .toBe(state)
  }
  const beforeHidden = await (await deviceA.page.request.get(
    "/api/community/users/me/read-state",
  )).json() as {
    revision: number
    readStates: Array<{ channelId: string; lastReadSeq: number }>
  }
  const beforeHiddenSeq = beforeHidden.readStates
    .find((row) => row.channelId === channelId)?.lastReadSeq
  expect(beforeHiddenSeq).toBeGreaterThan(0)

  const hiddenReadResponses: number[] = []
  const trackHiddenReads = (response: { request: () => { method: () => string }; url: () => string; status: () => number }) => {
    if (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${channelId}/read`
    ) hiddenReadResponses.push(response.status())
  }
  deviceA.page.on("response", trackHiddenReads)
  await setDeviceAVisibility("hidden")
  const hiddenStarts = [proxyA.frames.length, proxyB.frames.length]
  const hiddenBody = `hidden live tail ${stamp}`
  await seedMessage("alice", channelId, hiddenBody)
  await expect(deviceA.page.getByText(hiddenBody, { exact: true })).toBeVisible()
  for (const [proxy, start] of [[proxyA, hiddenStarts[0]], [proxyB, hiddenStarts[1]]] as const) {
    await expect.poll(() => unreadBumpsSince(proxy.frames, start!, channelId).length, {
      timeout: 20_000,
    }).toBeGreaterThan(0)
  }
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toBeVisible()
  await deviceA.page.waitForTimeout(1_000)
  expect(hiddenReadResponses).toEqual([])
  const afterHidden = await (await deviceA.page.request.get(
    "/api/community/users/me/read-state",
  )).json() as {
    revision: number
    readStates: Array<{ channelId: string; lastReadSeq: number }>
  }
  expect(afterHidden.revision).toBe(beforeHidden.revision)
  expect(afterHidden.readStates.find((row) => row.channelId === channelId)?.lastReadSeq)
    .toBe(beforeHiddenSeq)

  const foregroundRead = deviceA.page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/read`,
  )
  await setDeviceAVisibility("visible")
  expect((await foregroundRead).status()).toBe(200)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)
  deviceA.page.off("response", trackHiddenReads)

  const beforeUnseen = await (await deviceA.page.request.get(
    "/api/community/users/me/read-state",
  )).json() as {
    revision: number
    readStates: Array<{ channelId: string; lastReadSeq: number }>
  }
  const beforeUnseenSeq = beforeUnseen.readStates.find((row) => row.channelId === channelId)?.lastReadSeq
  expect(beforeUnseenSeq).toBeGreaterThan(0)

  await scroller.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(deviceA.page.getByTestId(tid.scrollToPresent)).toBeVisible()
  const unseenReadResponses: number[] = []
  const trackUnseenReads = (response: { request: () => { method: () => string }; url: () => string; status: () => number }) => {
    if (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${channelId}/read`
    ) unseenReadResponses.push(response.status())
  }
  deviceA.page.on("response", trackUnseenReads)
  const unseenStarts = [proxyA.frames.length, proxyB.frames.length]
  const unseenBody = `unseen live tail ${stamp}`
  await seedMessage("alice", channelId, unseenBody)
  for (const [proxy, start] of [[proxyA, unseenStarts[0]], [proxyB, unseenStarts[1]]] as const) {
    await expect.poll(() => unreadBumpsSince(proxy.frames, start!, channelId).length, {
      timeout: 20_000,
    }).toBeGreaterThan(0)
  }
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toBeVisible()
  await deviceA.page.waitForTimeout(1_000)
  expect(unseenReadResponses).toEqual([])
  const afterUnseen = await (await deviceA.page.request.get(
    "/api/community/users/me/read-state",
  )).json() as {
    revision: number
    readStates: Array<{ channelId: string; lastReadSeq: number }>
  }
  expect(afterUnseen.revision).toBe(beforeUnseen.revision)
  expect(afterUnseen.readStates.find((row) => row.channelId === channelId)?.lastReadSeq)
    .toBe(beforeUnseenSeq)

  const catchUpRead = deviceA.page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/read`,
  )
  await deviceA.page.getByTestId(tid.scrollToPresent).click()
  expect((await catchUpRead).status()).toBe(200)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)
  deviceA.page.off("response", trackUnseenReads)
})

test("forum opener reads are exact, sparse, idempotent, and pruned by Mark all", async ({ asUser }) => {
  test.setTimeout(180_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Sparse forum sync ${stamp}`)
  const forumId = await seedChannel("alice", serverId, `sparse-forum-${stamp}`, "forum")
  await seedJoinServer("alice", "bob", serverId)

  const alice = await asUser("alice")
  const createEmptyPost = async (label: string) => {
    const response = await alice.page.request.post(
      `/api/community/channels/${forumId}/messages`,
      { data: { content: label, nonce: `e2e:${crypto.randomUUID()}:opener` } },
    )
    expect(response.status()).toBe(201)
    return await response.json() as { threadId: string }
  }
  const first = await createEmptyPost(`Sparse first ${stamp}`)
  const second = await createEmptyPost(`Sparse second ${stamp}`)

  const deviceA = await asUser("bob")
  const deviceB = await asUser("bob")
  const proxyA = await proxyCommunityWebSockets(deviceA.context)
  const proxyB = await proxyCommunityWebSockets(deviceB.context)
  await gotoAfterUserWsAuth(deviceA.page, `/c/channels/${serverId}/${forumId}`)
  await gotoAfterUserWsAuth(deviceB.page, `/c/channels/${serverId}/${forumId}`)

  const threadsResponse = await deviceA.page.request.get(
    `/api/community/channels/${forumId}/threads?order=createdAt&limit=50`,
  )
  expect(threadsResponse.status()).toBe(200)
  const threads = await threadsResponse.json() as {
    threads: Array<{ id: string; parentMessageId: string | null }>
  }
  const firstOpener = threads.threads.find((thread) => thread.id === first.threadId)?.parentMessageId
  const secondOpener = threads.threads.find((thread) => thread.id === second.threadId)?.parentMessageId
  expect(firstOpener).toBeTruthy()
  expect(secondOpener).toBeTruthy()

  const accountSnapshot = async () => await (await deviceA.page.request.get(
    "/api/community/users/me/read-state",
  )).json() as {
    revision: number
    readStates: Array<{ channelId: string; lastReadSeq: number }>
    forumOpenerReads: Array<{ openerMessageId: string }>
  }
  const openerResponses: Array<{ openerId: string; status: number }> = []
  const trackOpenerResponse = (response: {
    request: () => { method: () => string }
    url: () => string
    status: () => number
  }) => {
    const url = new URL(response.url())
    const match = url.pathname.match(/^\/api\/community\/messages\/([^/]+)\/read$/)
    if (response.request().method() === "PUT" && match?.[1]) {
      openerResponses.push({ openerId: match[1], status: response.status() })
    }
  }
  deviceA.page.on("response", trackOpenerResponse)

  await deviceA.page.waitForTimeout(1_200)
  expect(openerResponses).toEqual([])
  const beforeFirst = await accountSnapshot()
  const firstFrameStarts = [proxyA.frames.length, proxyB.frames.length]
  await deviceA.page.getByTestId(tid.forumThreadCard(first.threadId)).evaluate((element) => {
    ;(element as HTMLElement).click()
  })
  await expect.poll(() => new URL(deviceA.page.url()).pathname)
    .toBe(`/c/channels/${serverId}/${first.threadId}`)
  await expect(deviceA.page.getByTestId("forum-opener-read-anchor")).toBeVisible()
  await expect.poll(() => openerResponses.filter((row) => row.openerId === firstOpener).length, {
    timeout: 20_000,
  }).toBe(1)
  await deviceA.page.waitForTimeout(1_200)
  expect(openerResponses.filter((row) => row.openerId === firstOpener)).toEqual([
    { openerId: firstOpener!, status: 200 },
  ])
  const afterFirst = await accountSnapshot()
  expect(afterFirst.revision).toBe(beforeFirst.revision + 1)
  expect(afterFirst.forumOpenerReads.map((row) => row.openerMessageId)).toEqual([firstOpener])
  for (const [proxy, start] of [[proxyA, firstFrameStarts[0]], [proxyB, firstFrameStarts[1]]] as const) {
    await expect.poll(() => proxy.frames.slice(start!).flatMap(communityFrameEvents)
      .filter((event) => event.type === "community:inbox.changed"
        && event.reason === "forum_opener_read").length, { timeout: 20_000 }).toBe(1)
  }

  await gotoAfterUserWsAuth(deviceA.page, `/c/channels/${serverId}/${forumId}`)
  await gotoAfterUserWsAuth(deviceA.page, `/c/channels/${serverId}/${first.threadId}`)
  await deviceA.page.waitForTimeout(1_200)
  expect(openerResponses.filter((row) => row.openerId === firstOpener)).toHaveLength(1)
  expect((await accountSnapshot()).revision).toBe(afterFirst.revision)

  const directForumRead = await deviceA.page.request.put(
    `/api/community/channels/${forumId}/read`,
    { data: { lastReadMessageId: firstOpener } },
  )
  expect(directForumRead.status()).toBe(400)

  await gotoAfterUserWsAuth(deviceA.page, `/c/channels/${serverId}/${second.threadId}`)
  await expect.poll(() => openerResponses.filter((row) => row.openerId === secondOpener).length, {
    timeout: 20_000,
  }).toBe(1)
  const afterSecond = await accountSnapshot()
  expect(afterSecond.revision).toBe(afterFirst.revision + 1)
  expect(new Set(afterSecond.forumOpenerReads.map((row) => row.openerMessageId))).toEqual(
    new Set([firstOpener, secondOpener]),
  )

  const snapshotRepair = deviceA.page.waitForResponse((response) =>
    response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/community/users/me/read-state",
  )
  const readAll = await deviceA.page.request.post(
    "/api/community/users/me/inbox/unreads/read-all",
  )
  expect(readAll.status()).toBe(200)
  expect((await readAll.json() as { changed: boolean }).changed).toBe(true)
  expect((await snapshotRepair).status()).toBe(200)
  const afterReadAll = await accountSnapshot()
  expect(afterReadAll.revision).toBe(afterSecond.revision + 1)
  expect(afterReadAll.forumOpenerReads).toEqual([])
  expect(afterReadAll.readStates.find((row) => row.channelId === forumId)?.lastReadSeq)
    .toBeGreaterThanOrEqual(2)

  const beforeCoveredReopenCount = openerResponses.length
  await gotoAfterUserWsAuth(deviceA.page, `/c/channels/${serverId}/${first.threadId}`)
  await deviceA.page.waitForTimeout(1_200)
  expect(openerResponses).toHaveLength(beforeCoveredReopenCount)
  expect((await accountSnapshot()).revision).toBe(afterReadAll.revision)
  deviceA.page.off("response", trackOpenerResponse)
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
    expect("readStates" in event).toBe(false)
  }
  const authorEvents = [
    readStateEventsSince(proxyA.frames, authorStarts[0]!)[0]!,
    readStateEventsSince(proxyB.frames, authorStarts[1]!)[0]!,
  ]
  expect(authorEvents[0].revision).toBe(authorEvents[1].revision)
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
    expect("readStates" in event).toBe(false)
  }
  const notificationEvents = [
    readStateEventsSince(proxyA.frames, notificationStarts[0]!)[0]!,
    readStateEventsSince(proxyB.frames, notificationStarts[1]!)[0]!,
  ]
  expect(notificationEvents[0].revision).toBe(notificationEvents[1].revision)
  await expect(deviceB.page.getByTestId(tid.inboxUnreadChannel(notificationChannelId))).toHaveCount(0)

  const writerSnapshot = await (await deviceB.page.request.get(
    "/api/community/users/me/read-state",
  )).json() as { readStates: Array<{ channelId: string; lastReadSeq: number }> }
  expect(writerSnapshot.readStates.find((state) => state.channelId === authorChannelId)?.lastReadSeq)
    .toBeGreaterThan(0)
  expect(writerSnapshot.readStates.find((state) => state.channelId === notificationChannelId)?.lastReadSeq)
    .toBeGreaterThan(0)
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

  const beforeDeleteSnapshot = await (await deviceB.page.request.get(
    "/api/community/users/me/read-state",
  )).json() as { revision: number }

  const starts = [proxyA.frames.length, proxyB.frames.length]
  const deleteStatus = await deviceA.page.evaluate(async (messageId) => {
    const response = await fetch(`/api/community/messages/${messageId}`, { method: "DELETE" })
    return response.status
  }, deletedOpenerId!)
  expect(deleteStatus).toBe(204)

  for (const [proxy, start] of [[proxyA, starts[0]], [proxyB, starts[1]]] as const) {
    await expect.poll(() => readStateEventsSince(proxy.frames, start!)
      .filter((event) => event.revision > beforeDeleteSnapshot.revision).length, {
      timeout: 20_000,
    }).toBeGreaterThan(0)
  }
  const eventsByProfile = [
    readStateEventsSince(proxyA.frames, starts[0]!)
      .filter((event) => event.revision > beforeDeleteSnapshot.revision),
    readStateEventsSince(proxyB.frames, starts[1]!)
      .filter((event) => event.revision > beforeDeleteSnapshot.revision),
  ]
  expect(eventsByProfile.flat().every((event) => !("readStates" in event))).toBe(true)
  const profileBRevisions = new Set(eventsByProfile[1].map((event) => event.revision))
  expect(eventsByProfile[0].some((event) => profileBRevisions.has(event.revision))).toBe(true)
  const deletedSnapshot = await (await deviceB.page.request.get(
    "/api/community/users/me/read-state",
  )).json() as {
    revision: number
    readStates: Array<{ channelId: string; lastReadMessageId: string | null }>
    forumOpenerReads: Array<{ openerMessageId: string }>
  }
  expect(deletedSnapshot.revision).toBeGreaterThan(beforeDeleteSnapshot.revision)
  await expect.poll(() => [proxyA, proxyB].every((proxy, index) =>
    readStateEventsSince(proxy.frames, starts[index]!)
      .some((event) => event.revision === deletedSnapshot.revision)), {
    timeout: 20_000,
  }).toBe(true)
  expect(deletedSnapshot.readStates.some((state) => state.channelId === deletedChildId)).toBe(false)
  expect(deletedSnapshot.readStates.some((state) => state.channelId === forumId)).toBe(false)
  expect(deletedSnapshot.forumOpenerReads.some((row) => row.openerMessageId === deletedOpenerId))
    .toBe(false)
  await expect(deviceB.page.getByTestId(tid.forumThreadCard(deletedChildId))).toHaveCount(0)
})
