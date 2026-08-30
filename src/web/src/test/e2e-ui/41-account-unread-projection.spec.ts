import type { Page, Request } from "@playwright/test"
import { expect, test, userId } from "./_fixtures/community-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import {
  communityFrameEvents,
  proxyCommunityWebSockets,
  type CapturedCommunityFrame,
} from "./_fixtures/community-ws-proxy"
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
import { tid } from "./_fixtures/testids"

async function installReadObserverGate(page: Page, initiallyBlocked = false) {
  await page.addInitScript((blockInitially) => {
    const NativeIntersectionObserver = window.IntersectionObserver
    const queued: Array<() => void> = []
    let blocked = blockInitially
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
    ;(window as unknown as Record<string, unknown>).__accountUnreadObserverGate = {
      block: () => { blocked = true },
      pending: () => queued.length,
      release: () => {
        blocked = false
        for (const deliver of queued.splice(0)) deliver()
      },
    }
  }, initiallyBlocked)
  const invoke = async (method: "block" | "pending" | "release") => page.evaluate((name) => {
    const gate = (window as unknown as Record<string, {
      block: () => void
      pending: () => number
      release: () => void
    }>).__accountUnreadObserverGate
    return gate[name]()
  }, method)
  return {
    block: () => invoke("block"),
    pending: () => invoke("pending") as Promise<number>,
    release: () => invoke("release"),
  }
}

function hasCorrelatedBundle(
  frames: CapturedCommunityFrame[],
  messageId: string,
  channelId: string,
) {
  return frames.some((frame) => {
    if (frame.type !== "community:events.batch") return false
    const events = communityFrameEvents(frame)
    return events.some((event) => (
      event.type === "community:message.create"
      && event.message?.id === messageId
      && event.message?.seq !== undefined
    )) && events.some((event) => (
      event.type === "community:unread.bump"
      && event.channelId === channelId
    ))
  })
}

async function expectUnreadDot(row: ReturnType<Page["getByTestId"]>) {
  await expect(row.locator("span.rounded-full.bg-primary")).toHaveCount(1)
}

async function readSeq(page: Page, channelId: string): Promise<number> {
  const response = await page.request.get("/api/community/users/me/read-state")
  expect(response.ok()).toBe(true)
  const snapshot = await response.json() as {
    readStates: Array<{ channelId: string; lastReadSeq: number }>
  }
  return snapshot.readStates.find((row) => row.channelId === channelId)?.lastReadSeq ?? 0
}

async function expectRailReplacementDoesNotBlockMessages({
  page,
  observerGate,
  href,
  channelId,
  latestText,
  inboxRowTestId,
  triggerUnread,
}: {
  page: Page
  observerGate: Awaited<ReturnType<typeof installReadObserverGate>>
  href: string
  channelId: string
  latestText: string
  inboxRowTestId: string
  triggerUnread: () => Promise<string>
}) {
  const beforeReadSeq = await readSeq(page, channelId)
  let releaseRailGate!: () => void
  const railRelease = new Promise<void>((resolve) => { releaseRailGate = resolve })
  let markRailHeld!: () => void
  const railHeld = new Promise<void>((resolve) => { markRailHeld = resolve })
  let markRailSettled!: () => void
  const railSettled = new Promise<void>((resolve) => { markRailSettled = resolve })
  let railRequestHeld = false
  const releaseRail = async () => {
    releaseRailGate()
    if (railRequestHeld) await railSettled
  }
  let serverListRequests = 0
  let messagesRequests = 0

  await page.route("**/api/community/servers", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/community/servers") {
      await route.continue()
      return
    }
    serverListRequests += 1
    if (serverListRequests === 1) {
      railRequestHeld = true
      markRailHeld()
      await railRelease
      try {
        await route.continue()
      } finally {
        markRailSettled()
      }
      return
    }
    await route.continue()
  })
  const countMessagesRequest = (request: Request) => {
    if (
      request.method() === "GET"
      && new URL(request.url()).pathname === `/api/community/channels/${channelId}/messages`
    ) messagesRequests += 1
  }
  page.on("request", countMessagesRequest)

  try {
    const latestId = await triggerUnread()
    await railHeld
    await page.getByRole("button", { name: "Inbox", exact: true }).click()
    const inboxRow = page.getByTestId(inboxRowTestId)
    await expect(inboxRow).toBeVisible({ timeout: 30_000 })
    const messagesResponse = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
      && response.status() === 200
    ), { timeout: 30_000 })
    await inboxRow.click()

    const response = await messagesResponse
    expect(serverListRequests).toBeGreaterThanOrEqual(1)
    expect(messagesRequests).toBeGreaterThanOrEqual(1)
    expect(await readSeq(page, channelId)).toBe(beforeReadSeq)
    await releaseRail()

    const body = await response.json() as { messages: Array<{ id: string; seq: number }> }
    expect(body.messages.at(-1)?.id).toBe(latestId)
    await expect(page).toHaveURL(href)
    await expect(page.getByText(latestText, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(latestText, { exact: true })).toHaveCount(1)
    await expect.poll(observerGate.pending, { timeout: 20_000 }).toBeGreaterThan(0)
    expect(await readSeq(page, channelId)).toBe(beforeReadSeq)

    const readResponse = page.waitForResponse((candidate) => (
      candidate.request().method() === "PUT"
      && new URL(candidate.url()).pathname === `/api/community/channels/${channelId}/read`
    ))
    await observerGate.release()
    expect((await readResponse).status()).toBe(200)
    await expect.poll(() => readSeq(page, channelId), { timeout: 20_000 })
      .toBeGreaterThan(beforeReadSeq)
  } finally {
    await releaseRail()
    page.off("request", countMessagesRequest)
    await page.unroute("**/api/community/servers")
  }
}

test.describe.serial("account unread projection", () => {
  test.setTimeout(180_000)

  test("one committed bundle projects every surface and only a visible row clears it", async ({ asUser }, testInfo) => {
    const stamp = Date.now()
    const foregroundServer = await seedServer("alice", `Projection foreground ${stamp}`)
    const foregroundChannel = await seedChannel("alice", foregroundServer, `foreground-${stamp}`)
    const backgroundServer = await seedServer("alice", `Projection background ${stamp}`)
    const landingChannel = await seedChannel("alice", backgroundServer, `landing-${stamp}`)
    const unreadChannel = await seedChannel("alice", backgroundServer, `unread-${stamp}`)
    const forumId = await seedChannel("alice", backgroundServer, `forum-${stamp}`, "forum")
    await seedJoinServer("alice", "bob", foregroundServer)
    await seedJoinServer("alice", "bob", backgroundServer)
    const forumChild = await seedForumThread(
      "bob",
      forumId,
      `Projection post ${stamp}`,
      `Bob participation ${stamp}`,
    )
    const dmId = await seedDm("alice", userId("bob"))

    const { context, page } = await asUser("bob")
    await page.setViewportSize({ width: 1280, height: 900 })
    const observerGate = await installReadObserverGate(page)
    const proxy = await proxyCommunityWebSockets(context)
    await gotoAfterUserWsAuth(page, `/c/channels/${foregroundServer}/${foregroundChannel}`)
    await expect(page.getByTestId(tid.serverIcon(backgroundServer))).toBeVisible({ timeout: 30_000 })
    const beforeSnapshot = await (await page.request.get(
      "/api/community/users/me/read-state",
    )).json() as { readStates: Array<{ channelId: string; lastReadSeq: number }> }
    const beforeCursor = (channelId: string) => beforeSnapshot.readStates
      .find((row) => row.channelId === channelId)?.lastReadSeq ?? 0

    const frameStart = proxy.frames.length
    const channelMessage = await seedMessage("alice", unreadChannel, `Projected channel ${stamp}`)
    const childMessage = await seedMessage("alice", forumChild, `Projected forum child ${stamp}`)
    const dmMessage = await seedDmMessage("alice", dmId, `Projected DM ${stamp}`)
    for (const [messageId, channelId] of [
      [channelMessage, unreadChannel],
      [childMessage, forumChild],
      [dmMessage, dmId],
    ]) {
      await expect.poll(() => hasCorrelatedBundle(
        proxy.frames.slice(frameStart),
        messageId,
        channelId,
      ), { timeout: 20_000 }).toBe(true)
    }

    await expect.poll(async () => page
      .getByTestId(tid.serverRailIndicator(backgroundServer))
      .evaluate((element) => element.getBoundingClientRect().height), {
      timeout: 20_000,
    }).toBe(10)
    await gotoAfterUserWsAuth(
      page,
      `/c/channels/${backgroundServer}/${landingChannel}`,
    )
    await expect(page).toHaveURL(`/c/channels/${backgroundServer}/${landingChannel}`)
    await expectUnreadDot(page.getByTestId(tid.channelRow(unreadChannel)))

    await gotoAfterUserWsAuth(page, `/c/channels/${backgroundServer}/${forumId}`)
    await expect(page).toHaveURL(`/c/channels/${backgroundServer}/${forumId}`)
    await expectUnreadDot(page.getByTestId(tid.forumSidebarThread(forumChild)))
    await page.getByRole("button", { name: "Inbox", exact: true }).click()
    await expect(page.getByTestId(tid.inboxUnreadChannel(unreadChannel))).toBeVisible()
    await expect(page.getByTestId(tid.inboxUnreadChild(forumChild))).toBeVisible()
    await expect(page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({
      path: testInfo.outputPath("account-unread-projection-1280.png"),
      fullPage: true,
    })

    await observerGate.block()
    const targetPuts: string[] = []
    page.on("request", (request) => {
      if (
        request.method() === "PUT"
        && new URL(request.url()).pathname === `/api/community/channels/${unreadChannel}/read`
      ) targetPuts.push(request.url())
    })
    await page.getByTestId(tid.inboxUnreadChannel(unreadChannel)).click()
    await expect(page).toHaveURL(`/c/channels/${backgroundServer}/${unreadChannel}`)
    await expect(page.getByText(`Projected channel ${stamp}`, { exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await expect.poll(observerGate.pending).toBeGreaterThan(0)
    expect(targetPuts).toEqual([])

    const readResponse = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${unreadChannel}/read`
    ))
    await observerGate.release()
    expect((await readResponse).status()).toBe(200)
    expect(targetPuts).toHaveLength(1)

    await page.setViewportSize({ width: 390, height: 844 })
    await gotoAfterUserWsAuth(page, "/c/me")
    await page.getByRole("button", { name: "Inbox", exact: true }).click()
    await expect(page.getByTestId(tid.inboxUnreadChannel(unreadChannel))).toHaveCount(0)
    await expect(page.getByTestId(tid.inboxUnreadChild(forumChild))).toBeVisible()
    await expect(page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({
      path: testInfo.outputPath("account-unread-projection-390.png"),
      fullPage: true,
    })

    const snapshot = await (await page.request.get(
      "/api/community/users/me/read-state",
    )).json() as { readStates: Array<{ channelId: string; lastReadSeq: number }> }
    const cursor = (channelId: string) => snapshot.readStates
      .find((row) => row.channelId === channelId)?.lastReadSeq ?? 0
    expect(cursor(unreadChannel)).toBeGreaterThan(beforeCursor(unreadChannel))
    expect(cursor(forumChild)).toBe(beforeCursor(forumChild))
    expect(cursor(dmId)).toBe(beforeCursor(dmId))
  })

  test("a held rail server-list request does not block channel or child messages", async ({ asUser }) => {
    const stamp = Date.now()
    const foregroundServer = await seedServer("alice", `Rail foreground ${stamp}`)
    const foregroundChannel = await seedChannel("alice", foregroundServer, `foreground-${stamp}`)
    await seedJoinServer("alice", "bob", foregroundServer)

    const channelServer = await seedServer("alice", `Rail channel target ${stamp}`)
    const channelId = await seedChannel("alice", channelServer, `channel-${stamp}`)
    await seedJoinServer("alice", "bob", channelServer)
    const childServer = await seedServer("alice", `Rail child target ${stamp}`)
    const forumId = await seedChannel("alice", childServer, `forum-${stamp}`, "forum")
    await seedJoinServer("alice", "bob", childServer)
    const childId = await seedForumThread(
      "bob",
      forumId,
      `Child ${stamp}`,
      `Child participation ${stamp}`,
    )
    const railTriggerServer = await seedServer("alice", `Rail mention trigger ${stamp}`)
    const railTriggerChannel = await seedChannel(
      "alice",
      railTriggerServer,
      `mention-trigger-${stamp}`,
    )
    await seedJoinServer("alice", "bob", railTriggerServer)
    const bobInfo = await memberInfo("alice", railTriggerServer, userId("bob"))
    const channelText = `Rail-independent channel ${stamp}`
    const childText = `Rail-independent child ${stamp}`

    const { context, page } = await asUser("bob")
    await page.setViewportSize({ width: 1280, height: 900 })
    const channelObserverGate = await installReadObserverGate(page, true)
    const childPage = await context.newPage()
    await childPage.setViewportSize({ width: 390, height: 844 })
    const childObserverGate = await installReadObserverGate(childPage, true)
    await Promise.all([
      gotoAfterUserWsAuth(page, `/c/channels/${foregroundServer}/${foregroundChannel}`),
      gotoAfterUserWsAuth(childPage, `/c/channels/${foregroundServer}/${foregroundChannel}`),
    ])
    await Promise.all([
      expect(page.getByTestId(tid.serverIcon(channelServer))).toBeVisible({ timeout: 30_000 }),
      expect(page.getByTestId(tid.serverIcon(childServer))).toBeVisible({ timeout: 30_000 }),
      expect(page.getByTestId(tid.channelComposerShell)).toBeVisible({ timeout: 30_000 }),
      expect(childPage.getByTestId(tid.channelComposerShell)).toBeVisible({ timeout: 30_000 }),
    ])

    const alice = await asUser("alice")
    await gotoAfterUserWsAuth(
      alice.page,
      `/c/channels/${railTriggerServer}/${railTriggerChannel}`,
    )
    const triggerComposer = composerEditable(alice.page)
    await expect(triggerComposer).toBeVisible({ timeout: 30_000 })
    const sendRailMention = async (label: string) => {
      const response = alice.page.waitForResponse((candidate) => (
        candidate.request().method() === "POST"
        && new URL(candidate.url()).pathname
          === `/api/community/channels/${railTriggerChannel}/messages`
      ))
      await triggerComposer.click()
      await triggerComposer.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
      await alice.page.getByTestId(tid.mentionOption(bobInfo.id)).click()
      await triggerComposer.pressSequentially(` ${label}`)
      await alice.page.keyboard.press("Enter")
      expect((await response).status()).toBe(201)
    }

    await expectRailReplacementDoesNotBlockMessages({
      page,
      observerGate: channelObserverGate,
      href: `/c/channels/${channelServer}/${channelId}`,
      channelId,
      latestText: channelText,
      inboxRowTestId: tid.inboxUnreadChannel(channelId),
      triggerUnread: async () => {
        await sendRailMention(`channel rail ${stamp}`)
        return seedMessage("alice", channelId, channelText)
      },
    })

    await gotoAfterUserWsAuth(childPage, "/c/me")
    await expectRailReplacementDoesNotBlockMessages({
      page: childPage,
      observerGate: childObserverGate,
      href: `/c/channels/${childServer}/${childId}`,
      channelId: childId,
      latestText: childText,
      inboxRowTestId: tid.inboxUnreadChild(childId),
      triggerUnread: async () => {
        await sendRailMention(`child rail ${stamp}`)
        return seedMessage("alice", childId, childText)
      },
    })
    await childPage.close()
  })

  test("mark all settles three domains and rolls back only the failed domain", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Projection mark all ${stamp}`)
    const channelId = await seedChannel("alice", serverId, `mark-all-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    await seedMessage("alice", channelId, `Channel mark all ${stamp}`)
    const dmId = await seedDm("alice", userId("bob"))
    await seedDmMessage("alice", dmId, `DM mark all ${stamp}`)

    const { page } = await asUser("bob")
    await gotoAfterUserWsAuth(page, "/c/me/friends")
    await page.getByRole("button", { name: "Inbox", exact: true }).click()
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelId))).toBeVisible()
    await expect(page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()

    const paths: string[] = []
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === "POST" && path.endsWith("/read-all")) paths.push(path)
    })
    await page.route("**/api/community/users/me/inbox/dms/read-all", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"dm read-all unavailable"}',
      })
    })
    await page.getByRole("button", { name: "Mark all read" }).click()
    await expect.poll(() => paths.length, { timeout: 20_000 }).toBe(3)
    expect([...paths].sort()).toEqual([
      "/api/community/users/me/inbox/dms/read-all",
      "/api/community/users/me/inbox/mentions/read-all",
      "/api/community/users/me/inbox/unreads/read-all",
    ])
    await expect(page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)
    await expect(page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()

    await page.unroute("**/api/community/users/me/inbox/dms/read-all")
    await page.getByRole("button", { name: "Mark all read" }).click()
    await expect(page.getByText("Caught up", { exact: true })).toBeVisible({ timeout: 20_000 })
  })
})
