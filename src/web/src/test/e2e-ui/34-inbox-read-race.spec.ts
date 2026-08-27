import { expect, test, userId } from "./_fixtures/community-fixture"
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
  communityFrameEvents,
  proxyCommunityWebSockets,
} from "./_fixtures/community-ws-proxy"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function watchInboxRow(page: Parameters<typeof gotoAfterUserWsAuth>[0], testId: string) {
  const key = `__inboxRace_${testId}`
  await page.evaluate(({ key, testId }) => {
    const target = window as unknown as Record<
      string,
      { seen: boolean; observer: MutationObserver }
    >
    const record = {
      seen: false,
      observer: new MutationObserver(() => {
        if (document.querySelector(`[data-testid="${testId}"]`)) record.seen = true
      }),
    }
    if (document.querySelector(`[data-testid="${testId}"]`)) record.seen = true
    record.observer.observe(document.documentElement, { childList: true, subtree: true })
    target[key] = record
  }, { key, testId })
  return async () => await page.evaluate((key) => {
    const target = window as unknown as Record<
      string,
      { seen: boolean; observer: MutationObserver }
    >
    const seen = target[key]?.seen ?? false
    target[key]?.observer.disconnect()
    delete target[key]
    return seen
  }, key)
}

test.describe.serial("Inbox/read refresh ownership", () => {
  test.setTimeout(180_000)

  test("focused A never flashes while same-window B and DM remain unread", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Inbox race mixed ${stamp}`)
    const channelA = await seedChannel("alice", serverId, `focused-a-${stamp}`)
    const channelB = await seedChannel("alice", serverId, `unread-b-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const dmId = await seedDm("alice", userId("bob"))
    const { context, page } = await asUser("bob")
    const proxy = await proxyCommunityWebSockets(context)
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelA}`)
    const initialInbox = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/community/users/me/inbox/unreads"
    ))
    await page.getByRole("button", { name: "Inbox" }).click()
    expect((await initialInbox).status()).toBe(200)
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelA))).toHaveCount(0)

    const stopWatchingA = await watchInboxRow(page, tid.inboxUnreadChannel(channelA))
    const requests: Array<{ method: string; path: string; at: number }> = []
    page.on("request", (request) => requests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      at: Date.now(),
    }))
    const requestStart = requests.length
    const frameStart = proxy.frames.length
    const firstReadGate = deferred()
    const firstReadStarted = deferred()
    await page.route(`**/api/community/channels/${channelA}/read`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue()
      firstReadStarted.resolve()
      await firstReadGate.promise
      await route.continue()
    })
    const readResponse = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${channelA}/read`
    ))
    const bodyA = `focused live ${stamp}`
    const bodyB = `background channel ${stamp}`
    const bodyDm = `background dm ${stamp}`
    const messageA = await seedMessage("alice", channelA, bodyA)
    await expect(page.getByText(bodyA, { exact: true })).toBeVisible({ timeout: 20_000 })
    await firstReadStarted.promise
    const messageB = await seedMessage("alice", channelB, bodyB)
    const messageDm = await seedDmMessage("alice", dmId, bodyDm)
    firstReadGate.resolve()
    expect((await readResponse).status()).toBe(200)
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelB))).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelA))).toHaveCount(0)
    await page.waitForTimeout(1_000)
    expect(await stopWatchingA()).toBe(false)

    await expect.poll(() => proxy.frames.slice(frameStart).filter((frame) => (
      frame.type === "community:events.batch"
      && communityFrameEvents(frame).some((event) => (
        event.type === "community:message.create"
        && [messageA, messageB, messageDm].includes(event.message?.id ?? "")
      ))
    )).length, { timeout: 20_000 }).toBe(3)
    const journeyRequests = requests.slice(requestStart)
    const readIndex = journeyRequests.findIndex((request) => (
      request.method === "PUT"
      && request.path === `/api/community/channels/${channelA}/read`
    ))
    const inboxIndex = journeyRequests.findIndex((request) => (
      request.method === "GET"
      && request.path === "/api/community/users/me/inbox/unreads"
    ))
    expect(readIndex).toBeGreaterThanOrEqual(0)
    expect(inboxIndex).toBeGreaterThan(readIndex)

    const snapshot = await (await page.request.get(
      "/api/community/users/me/read-state",
    )).json() as { readStates: Array<{ channelId: string; lastReadSeq: number }> }
    const readSeq = (channelId: string) => (
      snapshot.readStates.find((row) => row.channelId === channelId)?.lastReadSeq ?? 0
    )
    expect(readSeq(channelA)).toBeGreaterThan(0)
    expect(readSeq(channelB)).toBe(0)
    expect(readSeq(dmId)).toBe(0)
  })

  test("a failed focused read falls back once, then retry converges", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Inbox race failure ${stamp}`)
    const channelId = await seedChannel("alice", serverId, `failure-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const { page } = await asUser("bob")
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
    const initialInbox = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/community/users/me/inbox/unreads"
    ))
    await page.getByRole("button", { name: "Inbox" }).click()
    expect((await initialInbox).status()).toBe(200)
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)

    const retryGate = deferred()
    let puts = 0
    await page.route(`**/api/community/channels/${channelId}/read`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue()
      puts += 1
      if (puts === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"retry"}',
        })
        return
      }
      await retryGate.promise
      await route.continue()
    })
    const body = `retryable focused ${stamp}`
    await seedMessage("alice", channelId, body)
    await expect(page.getByText(body, { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelId))).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => puts, { timeout: 20_000 }).toBe(2)
    retryGate.resolve()
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0, {
      timeout: 20_000,
    })
    expect(puts).toBe(2)
  })

  test("a later focused intent keeps its own 500ms generation", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Inbox race cutoff ${stamp}`)
    const channelId = await seedChannel("alice", serverId, `cutoff-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const { page } = await asUser("bob")
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
    const initialInbox = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/community/users/me/inbox/unreads"
    ))
    await page.getByRole("button", { name: "Inbox" }).click()
    expect((await initialInbox).status()).toBe(200)
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)
    const stopWatching = await watchInboxRow(page, tid.inboxUnreadChannel(channelId))

    const firstGate = deferred()
    const firstStarted = deferred()
    const putStarts: number[] = []
    await page.route(`**/api/community/channels/${channelId}/read`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue()
      putStarts.push(Date.now())
      if (putStarts.length === 1) {
        firstStarted.resolve()
        await firstGate.promise
      }
      await route.continue()
    })
    const firstBody = `cutoff first ${stamp}`
    await seedMessage("alice", channelId, firstBody)
    await expect(page.getByText(firstBody, { exact: true })).toBeVisible({ timeout: 20_000 })
    await firstStarted.promise

    const secondBody = `cutoff second ${stamp}`
    const secondAcceptedAt = Date.now()
    await seedMessage("alice", channelId, secondBody)
    await expect(page.getByText(secondBody, { exact: true })).toBeVisible({ timeout: 20_000 })
    firstGate.resolve()
    await page.waitForTimeout(250)
    expect(putStarts).toHaveLength(1)
    await expect.poll(() => putStarts.length, { timeout: 20_000 }).toBe(2)
    expect(putStarts[1]! - secondAcceptedAt).toBeGreaterThanOrEqual(400)
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)
    expect(await stopWatching()).toBe(false)
  })
})
