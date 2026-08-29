import type { Page } from "@playwright/test"
import { expect, test, userId } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import {
  communityFrameEvents,
  proxyCommunityWebSockets,
  type CapturedCommunityFrame,
} from "./_fixtures/community-ws-proxy"
import {
  seedChannel,
  seedDm,
  seedDmMessage,
  seedForumThread,
  seedJoinServer,
  seedMessage,
  seedServer,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

async function installReadObserverGate(page: Page) {
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
    ;(window as unknown as Record<string, unknown>).__accountUnreadObserverGate = {
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
    await page.getByRole("button", { name: "Inbox" }).click()
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
    await page.getByRole("button", { name: "Inbox" }).click()
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

  test("mark all settles three domains and rolls back only the failed domain", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Projection mark all ${stamp}`)
    const channelId = await seedChannel("alice", serverId, `mark-all-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    await seedMessage("alice", channelId, `Channel mark all ${stamp}`)
    const dmId = await seedDm("alice", userId("bob"))
    await seedDmMessage("alice", dmId, `DM mark all ${stamp}`)

    const { page } = await asUser("bob")
    await gotoAfterUserWsAuth(page, "/c/me")
    await page.getByRole("button", { name: "Inbox" }).click()
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
