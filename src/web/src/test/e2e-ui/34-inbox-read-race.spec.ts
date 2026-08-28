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
  seedThread,
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

async function installReadObserverGate(
  page: Parameters<typeof gotoAfterUserWsAuth>[0],
) {
  await page.addInitScript(() => {
    const NativeIntersectionObserver = window.IntersectionObserver
    const queued: Array<() => void> = []
    let blocked = false
    class GatedIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null
      readonly rootMargin: string
      readonly scrollMargin: string
      readonly thresholds: readonly number[]
      private readonly observer: IntersectionObserver

      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.observer = new NativeIntersectionObserver((entries) => {
          const deliver = () => callback(entries, this)
          if (blocked && entries.some((entry) => (
            (entry.target as HTMLElement).hasAttribute("data-msg-id")
          ))) {
            queued.push(deliver)
            return
          }
          deliver()
        }, options)
        this.root = this.observer.root
        this.rootMargin = this.observer.rootMargin
        this.scrollMargin = this.observer.scrollMargin
        this.thresholds = this.observer.thresholds
      }

      disconnect() { this.observer.disconnect() }
      observe(target: Element) { this.observer.observe(target) }
      takeRecords() { return this.observer.takeRecords() }
      unobserve(target: Element) { this.observer.unobserve(target) }
    }
    window.IntersectionObserver = GatedIntersectionObserver
    ;(window as unknown as Record<string, unknown>).__inboxReadObserverGate = {
      block: () => { blocked = true },
      pending: () => queued.length,
      release: () => {
        blocked = false
        for (const deliver of queued.splice(0)) deliver()
      },
    }
  })
  const invoke = async (method: "block" | "pending" | "release") => page.evaluate((name) => {
    const gate = (window as unknown as Record<string, {
      block: () => void
      pending: () => number
      release: () => void
    }>).__inboxReadObserverGate
    return gate[name]()
  }, method)
  return {
    block: () => invoke("block"),
    pending: () => invoke("pending") as Promise<number>,
    release: () => invoke("release"),
  }
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

  test("an Inbox click closes, publishes, and hides only its exact row before read settles", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Inbox projection ${stamp}`)
    const channelAName = `project-a-${stamp}`
    const channelA = await seedChannel("alice", serverId, channelAName)
    const channelB = await seedChannel("alice", serverId, `project-b-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    await seedMessage("alice", channelA, `Projected A ${stamp}`)
    await seedMessage("alice", channelB, `Unrelated B ${stamp}`)

    const { page } = await asUser("bob")
    await gotoAfterUserWsAuth(page, "/c/me")
    await page.getByRole("button", { name: "Inbox" }).click()
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelA))).toBeVisible()
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelB))).toBeVisible()

    const readGate = deferred()
    const readStarted = deferred()
    const hrefsAtRead: string[] = []
    await page.route(`**/api/community/channels/${channelA}/read`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue()
      hrefsAtRead.push(page.url())
      readStarted.resolve()
      await readGate.promise
      await route.continue()
    })

    await page.getByTestId(tid.inboxUnreadChannel(channelA)).click()
    await expect(page).toHaveURL(`/c/channels/${serverId}/${channelA}`)
    await expect(page.getByRole("heading", { name: "Inbox" })).toHaveCount(0)
    await expect(page.getByRole("heading", { name: channelAName, exact: true })).toBeVisible({
      timeout: 20_000,
    })

    await page.getByRole("button", { name: "Inbox" }).click()
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelA))).toHaveCount(0)
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelB))).toBeVisible()
    await readStarted.promise
    expect(hrefsAtRead).toEqual([
      expect.stringContaining(`/c/channels/${serverId}/${channelA}`),
    ])

    const reconciledInbox = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/community/users/me/inbox/unreads"
    ))
    readGate.resolve()
    expect((await reconciledInbox).status()).toBe(200)
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelA))).toHaveCount(0)
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelB))).toBeVisible()
  })

  test("focused A never flashes while same-window B and DM remain unread", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Inbox race mixed ${stamp}`)
    const channelAName = `focused-a-${stamp}`
    const channelA = await seedChannel("alice", serverId, channelAName)
    const channelB = await seedChannel("alice", serverId, `unread-b-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const dmId = await seedDm("carol", userId("bob"))
    const { context, page } = await asUser("bob")
    const readObserverGate = await installReadObserverGate(page)
    const proxy = await proxyCommunityWebSockets(context)
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelA}`)
    const initialInbox = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/community/users/me/inbox/unreads"
    ))
    await expect(page.getByRole("heading", { name: channelAName, exact: true })).toBeVisible({
      timeout: 20_000,
    })
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
    await readObserverGate.block()
    const staleInboxResponse = page.waitForResponse(async (response) => {
      if (
        response.request().method() !== "GET"
        || new URL(response.url()).pathname !== "/api/community/users/me/inbox/unreads"
        || response.status() !== 200
      ) return false
      const payload = await response.json() as {
        servers: Array<{ channels: Array<{
          channelId: string
          children: Array<{ channelId: string }>
        }> }>
      }
      return payload.servers.some((server) => server.channels.some((channel) => (
        channel.channelId === channelA
        || channel.children.some((child) => child.channelId === channelA)
      )))
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
    const staleResponse = await staleInboxResponse
    expect(staleResponse.status()).toBe(200)
    const stalePayload = await staleResponse.json() as {
      servers: Array<{ channels: Array<{
        channelId: string
        children: Array<{ channelId: string }>
      }> }>
      dms: Array<{ channelId: string }>
    }
    expect(stalePayload.servers.some((server) => server.channels.some((channel) => (
      channel.channelId === channelA
      || channel.children.some((child) => child.channelId === channelA)
    )))).toBe(true)
    expect(await readObserverGate.pending()).toBeGreaterThan(0)
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelA))).toHaveCount(0)
    const messageB = await seedMessage("alice", channelB, bodyB)
    const messageDm = await seedDmMessage("carol", dmId, bodyDm)
    await readObserverGate.release()
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
    expect(inboxIndex).toBeLessThan(readIndex)

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
    const channelName = `failure-${stamp}`
    const channelId = await seedChannel("alice", serverId, channelName)
    await seedJoinServer("alice", "bob", serverId)
    const { page } = await asUser("bob")
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
    const initialInbox = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/community/users/me/inbox/unreads"
    ))
    await expect(page.getByRole("heading", { name: channelName, exact: true })).toBeVisible({
      timeout: 20_000,
    })
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

  test("an Inbox forum child claims only its exact opener and preserves a later opener", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Inbox opener handoff ${stamp}`)
    const forumId = await seedChannel("alice", serverId, `handoff-forum-${stamp}`, "forum")
    await seedJoinServer("alice", "bob", serverId)
    const alice = await asUser("alice")
    const createEmptyPost = async (label: string) => {
      const response = await alice.page.request.post(
        `/api/community/channels/${forumId}/messages`,
        { data: { content: label, nonce: `e2e:${crypto.randomUUID()}:opener` } },
      )
      expect(response.status()).toBe(201)
      return (await response.json() as { threadId: string }).threadId
    }
    const firstChildId = await createEmptyPost(`First opener ${stamp}`)
    const laterChildId = await createEmptyPost(`Later opener ${stamp}`)

    const { page } = await asUser("bob")
    await gotoAfterUserWsAuth(page, "/c/me")
    const unreadResponse = await page.request.get("/api/community/users/me/inbox/unreads")
    expect(unreadResponse.status()).toBe(200)
    const unread = await unreadResponse.json() as {
      servers: Array<{ channels: Array<{ channelId: string; children: Array<{
        channelId: string
        openerMessageId: string
        openerSeq: number
        openerUnread: boolean
      }> }> }>
    }
    const children = unread.servers
      .flatMap((server) => server.channels)
      .find((channel) => channel.channelId === forumId)?.children ?? []
    const first = children.find((child) => child.channelId === firstChildId)
    const later = children.find((child) => child.channelId === laterChildId)
    expect(first).toMatchObject({ openerUnread: true })
    expect(later).toMatchObject({ openerUnread: true })

    const parentTargets: string[] = []
    const childTargets: string[] = []
    page.on("request", (request) => {
      if (request.method() !== "PUT") return
      const path = new URL(request.url()).pathname
      const target = (request.postDataJSON() as { lastReadMessageId?: string } | null)
        ?.lastReadMessageId
      if (!target) return
      if (path === `/api/community/channels/${forumId}/read`) parentTargets.push(target)
      if (path === `/api/community/channels/${firstChildId}/read`) childTargets.push(target)
    })

    await page.getByRole("button", { name: "Inbox" }).click()
    await expect(page.getByTestId(tid.inboxUnreadChild(firstChildId))).toBeVisible()
    const parentRead = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${forumId}/read`
    ))
    await page.getByTestId(tid.inboxUnreadChild(firstChildId)).click()
    expect((await parentRead).status()).toBe(200)
    await expect.poll(() => new URL(page.url()).searchParams.has("inboxThreadOpener")).toBe(false)
    expect(parentTargets).toEqual([first!.openerMessageId])
    expect(childTargets).toEqual([])

    await page.getByRole("button", { name: "Inbox" }).click()
    await expect(page.getByTestId(tid.inboxUnreadChild(firstChildId))).toHaveCount(0)
    await expect(page.getByTestId(tid.inboxUnreadChild(laterChildId))).toBeVisible()
    const snapshot = await (await page.request.get(
      "/api/community/users/me/read-state",
    )).json() as { readStates: Array<{ channelId: string; lastReadSeq: number }> }
    expect(snapshot.readStates.find((row) => row.channelId === forumId)?.lastReadSeq)
      .toBe(first!.openerSeq)
    expect(snapshot.readStates.some((row) => row.channelId === firstChildId)).toBe(false)
  })

  test("eligible text children enrich opener state without widening participation", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Inbox text opener ${stamp}`)
    const parentId = await seedChannel("alice", serverId, `text-parent-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)

    const readOpenerId = await seedMessage("alice", parentId, `Already-read opener ${stamp}`)
    const readChildId = await seedThread("alice", readOpenerId, `Read opener thread ${stamp}`)
    await seedMessage("bob", readChildId, `Bob joins read child ${stamp}`)
    await seedMessage("alice", readChildId, `Unread reply under read opener ${stamp}`)

    const { page } = await asUser("bob")
    const markRead = await page.request.put(`/api/community/channels/${parentId}/read`, {
      data: { lastReadMessageId: readOpenerId },
    })
    expect(markRead.status()).toBe(200)

    const unreadOpenerId = await seedMessage("alice", parentId, `Unread opener ${stamp}`)
    const unreadChildId = await seedThread("alice", unreadOpenerId, `Unread opener thread ${stamp}`)
    await seedMessage("bob", unreadChildId, `Bob joins unread child ${stamp}`)
    await seedMessage("alice", unreadChildId, `Unread reply under unread opener ${stamp}`)

    const nonParticipantOpenerId = await seedMessage("alice", parentId, `Nonparticipant opener ${stamp}`)
    const nonParticipantChildId = await seedThread(
      "alice",
      nonParticipantOpenerId,
      `Nonparticipant thread ${stamp}`,
    )
    await seedMessage("alice", nonParticipantChildId, `Invisible child reply ${stamp}`)
    await seedMessage("alice", parentId, `Later parent message ${stamp}`)

    await gotoAfterUserWsAuth(page, "/c/me")
    const unreadResponse = await page.request.get("/api/community/users/me/inbox/unreads")
    expect(unreadResponse.status()).toBe(200)
    const unread = await unreadResponse.json() as {
      servers: Array<{ channels: Array<{ channelId: string; children: Array<{
        channelId: string
        openerMessageId?: string
        openerSeq?: number
        openerUnread?: boolean
      }> }> }>
    }
    const parent = unread.servers
      .flatMap((server) => server.channels)
      .find((channel) => channel.channelId === parentId)
    const readChild = parent?.children.find((child) => child.channelId === readChildId)
    const unreadChild = parent?.children.find((child) => child.channelId === unreadChildId)
    expect(readChild).toMatchObject({
      openerMessageId: readOpenerId,
      openerUnread: false,
    })
    expect(unreadChild).toMatchObject({
      openerMessageId: unreadOpenerId,
      openerUnread: true,
    })
    expect(parent?.children.some((child) => child.channelId === nonParticipantChildId)).toBe(false)

    const puts: Array<{ channelId: string; target: string }> = []
    page.on("request", (request) => {
      if (request.method() !== "PUT") return
      const match = new URL(request.url()).pathname.match(/^\/api\/community\/channels\/([^/]+)\/read$/)
      const target = (request.postDataJSON() as { lastReadMessageId?: string } | null)
        ?.lastReadMessageId
      if (match?.[1] && target) puts.push({ channelId: match[1], target })
    })

    await page.getByRole("button", { name: "Inbox" }).click()
    await expect(page.getByTestId(tid.inboxUnreadChild(readChildId))).toBeVisible()
    const readChildPut = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${readChildId}/read`
    ))
    await page.getByTestId(tid.inboxUnreadChild(readChildId)).click()
    expect((await readChildPut).status()).toBe(200)
    await page.waitForTimeout(700)
    expect(puts.filter((put) => put.channelId === parentId)).toEqual([])

    await page.getByRole("button", { name: "Inbox" }).click()
    await expect(page.getByTestId(tid.inboxUnreadChild(unreadChildId))).toBeVisible()
    const parentPut = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${parentId}/read`
    ))
    const unreadChildPut = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${unreadChildId}/read`
    ))
    await page.getByTestId(tid.inboxUnreadChild(unreadChildId)).click()
    expect((await parentPut).status()).toBe(200)
    expect((await unreadChildPut).status()).toBe(200)
    expect(puts.filter((put) => put.channelId === parentId)).toEqual([
      { channelId: parentId, target: unreadOpenerId },
    ])

    const snapshot = await (await page.request.get(
      "/api/community/users/me/read-state",
    )).json() as { readStates: Array<{ channelId: string; lastReadSeq: number }> }
    const cursor = (channelId: string) => snapshot.readStates
      .find((row) => row.channelId === channelId)?.lastReadSeq ?? 0
    expect(cursor(parentId)).toBe(unreadChild!.openerSeq)
    expect(cursor(readChildId)).toBeGreaterThan(0)
    expect(cursor(unreadChildId)).toBeGreaterThan(0)
    await page.getByRole("button", { name: "Inbox" }).click()
    await expect(page.getByTestId(tid.inboxUnreadChannel(parentId))).toBeVisible()
    await expect(page.getByTestId(tid.inboxUnreadChild(nonParticipantChildId))).toHaveCount(0)
  })

  test("a later focused intent keeps its own 500ms generation", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Inbox race cutoff ${stamp}`)
    const channelName = `cutoff-${stamp}`
    const channelId = await seedChannel("alice", serverId, channelName)
    await seedJoinServer("alice", "bob", serverId)
    const { page } = await asUser("bob")
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
    const initialInbox = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/community/users/me/inbox/unreads"
    ))
    await expect(page.getByRole("heading", { name: channelName, exact: true })).toBeVisible({
      timeout: 20_000,
    })
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
