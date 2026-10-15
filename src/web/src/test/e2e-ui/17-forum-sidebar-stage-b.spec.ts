import type { Page } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import { sendMessage } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"

import type { CaseActors } from "./_fixtures/case-fixture"

async function prepareCase(_actors: CaseActors) {
  async function participantUserIds(page: Page, channelId: string): Promise<string[]> {
    const response = await page.request.get(`/api/community/channels/${channelId}/members`)
    expect(response.status()).toBe(200)
    const payload = await response.json() as {
      members: Array<{
        userId: string
      }>
    }
    return payload.members.map((member) => member.userId)
  }
  return { participantUserIds }
}

function isSidebarRequest(url: string, serverId: string): boolean {
  const parsed = new URL(url)
  return parsed.pathname === `/api/community/servers/${serverId}/channels`
    && parsed.searchParams.get("participating") === "true"
}

function isConversationEntryRequest(url: string, channelId: string): boolean {
  const parsed = new URL(url)
  return parsed.pathname === `/api/community/channels/${channelId}/messages` && parsed.searchParams.get("entry") === "1"
}

function isChannelMessagesRequest(url: string, channelId: string): boolean {
  return new URL(url).pathname === `/api/community/channels/${channelId}/messages`
}

async function installRouteStabilityProbe(page: Page): Promise<void> {
  await page.addInitScript((composerShellTestId) => {
    const target = window as typeof window & {
      __routeStability?: { mounts: number; losses: number; present: boolean }
    }
    target.__routeStability = { mounts: 0, losses: 0, present: false }
    const sample = () => {
      const state = target.__routeStability!
      const present = !!document.querySelector(`[data-testid="${composerShellTestId}"]`)
      if (present && !state.present) state.mounts += 1
      if (!present && state.present) state.losses += 1
      state.present = present
    }
    const observe = () => {
      if (!document.documentElement) {
        globalThis.setTimeout(observe, 0)
        return
      }
      new MutationObserver(sample).observe(document.documentElement, {
        childList: true,
        subtree: true,
      })
      sample()
    }
    observe()
  }, tid.channelComposerShell)
}

async function routeStability(page: Page) {
  return page.evaluate(() => (window as typeof window & {
    __routeStability: { mounts: number; losses: number; present: boolean }
  }).__routeStability)
}

function childPanel(page: Page) {
  return page.getByTestId(tid.threadSplitPanel)
}

async function strictSidebar(page: Page, serverId: string, retainId?: string) {
  const params = new URLSearchParams({
    type: "thread",
    parentType: "forum",
    participating: "true",
    activeWithin: "72h",
    limitPerParent: "5",
    include: "parentMessage",
  })
  if (retainId) params.set("retainId", retainId)
  const response = await page.request.get(
    `/api/community/servers/${serverId}/channels?${params.toString()}`,
  )
  expect(response.status()).toBe(200)
  return await response.json() as {
    canonicalChannels: Array<{ id: string }>
    retainedChannel: { id: string } | null
    retainedDisposition: "eligible" | "opener-archived" | "genuine-negative" | null
  }
}

async function setForumPostArchived(
  page: Page,
  serverId: string,
  forumId: string,
  threadId: string,
  currentlyArchived: boolean,
) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/c/channels/${serverId}/${forumId}`)
  await expect(page.getByTestId(tid.forumPostList)).toBeVisible({ timeout: 20_000 })
  if (currentlyArchived) {
    await expect(page.getByTestId(tid.forumTagChip("archived"))).toBeVisible({ timeout: 20_000 })
    await page.getByTestId(tid.forumTagChip("archived")).click()
  }
  const card = page.getByTestId(tid.forumThreadCard(threadId))
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.hover()
  const archiveButton = page.getByTestId(tid.forumThreadArchiveBtn(threadId))
  await expect(archiveButton).toHaveAttribute("aria-pressed", String(currentlyArchived))
  const put = page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && new URL(response.url()).pathname.endsWith("/tags"),
  )
  const sidebar = page.waitForResponse((response) =>
    response.ok() && isSidebarRequest(response.url(), serverId),
  )
  await archiveButton.click()
  expect((await put).status()).toBe(200)
  await sidebar
}

test.describe("forum sidebar Stage B request shape", () => {
  async function prepareCase1(actors: CaseActors) {
    const { participantUserIds } = await prepareCase(actors)
    const { seedCategory, seedChannel, seedForumThread, seedJoinServer, seedMessage, seedServer, seedThread } = actors.seed
    const serverId: string = await seedServer("alice", `Sidebar ${Date.now()}`)
    const categoryId = await seedCategory("alice", serverId, "Grouped")
    const forumId: string = await seedChannel("alice", serverId, "forum", "forum", categoryId)
    const textAId: string = await seedChannel("alice", serverId, "text-a", undefined, categoryId)
    const textBId: string = await seedChannel("alice", serverId, "text-b", undefined, categoryId)
    await seedJoinServer("alice", "bob", serverId)
    await seedJoinServer("alice", "carol", serverId)
    const forumTitle: string = `Retained ${Date.now()}`
    const threadId: string = await seedForumThread("alice", forumId, forumTitle, "post body")
    const parentMessageId = await seedMessage("alice", textAId, "ordinary thread opener")
    const ordinaryThreadId: string = await seedThread("alice", parentMessageId, "ordinary thread")
    return { participantUserIds, serverId, forumId, threadId, textAId, textBId, forumTitle, ordinaryThreadId }
  }

  test("a cold direct child and hard refresh use their RSC window without duplicate target reads", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, threadId, forumTitle } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    const requests: string[] = []
    const successfulResponses: string[] = []
    let releaseTargetReads!: () => void
    const targetGate = new Promise<void>(resolve => { releaseTargetReads = resolve })
    caseResources.own(releaseTargetReads, async captured => { captured() })
    const targetRead = (url: URL) => url.pathname === `/api/community/channels/${threadId}`
      || url.pathname === `/api/community/channels/${threadId}/read-state`
      || url.pathname === `/api/community/channels/${threadId}/messages`
    await page.route(targetRead, async route => { await targetGate; await route.continue() })
    page.on("request", request => { if (request.method() === "GET") requests.push(request.url()) })
    page.on("response", response => { if (response.request().method() === "GET" && response.ok()) successfulResponses.push(response.url()) })
    try {
      for (const refresh of [false, true]) {
        requests.length = 0
        successfulResponses.length = 0
        const combined = page.waitForResponse(response => response.ok() && isSidebarRequest(response.url(), serverId))
        if (refresh) await page.reload({ waitUntil: "commit" })
        else await page.goto(`/c/channels/${serverId}/${threadId}`)
        await combined
        await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}/${threadId}`)
        await expect(childPanel(page).getByRole("heading", { name: forumTitle })).toBeVisible({ timeout: 20_000 })
        await expect(childPanel(page).getByText("post body", { exact: true })).toBeVisible({ timeout: 20_000 })
        await expect(childPanel(page).getByTestId(tid.composerInput)).toBeVisible()
        await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
        await page.waitForTimeout(refresh ? 2_000 : 500)
        expect(requests.filter(url => targetRead(new URL(url)))).toEqual([])
        const sidebar = requests.filter(url => isSidebarRequest(url, serverId))
        expect(sidebar.length).toBeGreaterThanOrEqual(1)
        expect(sidebar.length).toBeLessThanOrEqual(2)
        expect(sidebar.every(url => { const retain = new URL(url).searchParams.get("retainId"); return retain === null || retain === threadId })).toBe(true)
      }
    } finally {
      releaseTargetReads()
      await page.unroute(targetRead)
    }
  })

  test("a flat child route preserves one settled message load", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, threadId, forumTitle } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    const successfulResponses: string[] = []
    page.on("response", (response) => {
      if (response.request().method() === "GET" && response.ok()) {
        successfulResponses.push(response.url())
      }
    })

    await page.goto(`/c/channels/${serverId}/${threadId}`)
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${threadId}`,
    )
    await expect(childPanel(page).getByRole("heading", { name: forumTitle })).toBeVisible({ timeout: 20_000 })
    await expect(childPanel(page).getByText("post body", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    await page.waitForTimeout(2_000) // late duplicate anchored/unanchored fetch exclusion window

    const messageResponses = successfulResponses.filter((url) =>
      isChannelMessagesRequest(url, threadId),
    )
    expect(messageResponses).toEqual([])
  })

  test("a non-participant keeps a grouped forum route after retained null arrives", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser, userId } = actors
    const { participantUserIds, serverId, threadId } = await prepareCase1(actors)

    const { page } = await asUser("bob")
    await installRouteStabilityProbe(page)
    const successfulResponses: string[] = []
    const sidebarResponses: Array<{ url: string; retainedChannel: unknown }> = []
    await page.route(`**/api/community/servers/${serverId}/channels?**`, async (route) => {
      if (!isSidebarRequest(route.request().url(), serverId)) {
        await route.continue()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 750))
      await route.continue()
    })
    page.on("response", async (response) => {
      if (response.request().method() !== "GET" || !response.ok()) return
      successfulResponses.push(response.url())
      if (!isSidebarRequest(response.url(), serverId)) return
      const payload = await response.json() as { retainedChannel: unknown }
      sidebarResponses.push({ url: response.url(), retainedChannel: payload.retainedChannel })
    })

    expect(await participantUserIds(page, threadId)).not.toContain(userId("bob"))
    await page.goto(`/c/channels/${serverId}/${threadId}`)
    await expect(childPanel(page).getByTestId(tid.channelComposerShell)).toBeVisible({ timeout: 20_000 })
    await expect(childPanel(page).getByText("post body", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => sidebarResponses.some(({ url }) =>
      new URL(url).searchParams.get("retainId") === threadId,
    )).toBe(true)
    await page.waitForTimeout(2_000)

    const retainedResponses = sidebarResponses.filter(({ url }) =>
      new URL(url).searchParams.get("retainId") === threadId
    )
    expect(retainedResponses).toHaveLength(1)
    expect(retainedResponses[0]?.retainedChannel).toBeNull()
    expect(successfulResponses.filter((url) => isConversationEntryRequest(url, threadId))).toHaveLength(0)
    expect(await routeStability(page)).toEqual({ mounts: 1, losses: 0, present: true })
    expect(await participantUserIds(page, threadId)).not.toContain(userId("bob"))

    const reply = `bob joins ${Date.now()}`
    await sendMessage(page, reply, childPanel(page))
    await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => participantUserIds(page, threadId)).toContain(userId("bob"))
  })

  test("a non-participant warm forum-card click settles one negative retained request", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser, userId } = actors
    const { participantUserIds, serverId, forumId, threadId } = await prepareCase1(actors)

    const { page } = await asUser("carol")
    await installRouteStabilityProbe(page)
    const successfulResponses: string[] = []
    const sidebarResponses: Array<{ url: string; retainedChannel: unknown }> = []
    page.on("response", async (response) => {
      if (response.request().method() !== "GET" || !response.ok()) return
      successfulResponses.push(response.url())
      if (!isSidebarRequest(response.url(), serverId)) return
      const payload = await response.json() as { retainedChannel: unknown }
      sidebarResponses.push({ url: response.url(), retainedChannel: payload.retainedChannel })
    })

    await page.goto(`/c/channels/${serverId}/${forumId}`)
    const card = page.getByTestId(tid.forumThreadCard(threadId))
    await expect(card).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(300)
    sidebarResponses.length = 0
    successfulResponses.length = 0

    await card.click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${threadId}`,
    )
    await expect(childPanel(page).getByTestId(tid.channelComposerShell)).toBeVisible({ timeout: 20_000 })
    await expect(childPanel(page).getByText("post body", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => sidebarResponses.filter(({ url }) =>
      new URL(url).searchParams.get("retainId") === threadId,
    ).length).toBe(1)
    await page.waitForTimeout(2_000)

    const retainedResponses = sidebarResponses.filter(({ url }) =>
      new URL(url).searchParams.get("retainId") === threadId
    )
    expect(retainedResponses).toHaveLength(1)
    expect(retainedResponses[0]?.retainedChannel).toBeNull()
    expect(successfulResponses.filter((url) => isConversationEntryRequest(url, threadId))).toHaveLength(1)
    expect(await routeStability(page)).toEqual({ mounts: 1, losses: 0, present: true })
    expect(await participantUserIds(page, threadId)).not.toContain(userId("carol"))
  })

  test("a grouped ordinary thread never asks the forum sidebar to retain it", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser, userId } = actors
    const { participantUserIds, serverId, ordinaryThreadId } = await prepareCase1(actors)

    const { page } = await asUser("bob")
    await installRouteStabilityProbe(page)
    const successfulResponses: string[] = []
    const requests: string[] = []
    page.on("request", (request) => {
      if (request.method() === "GET") requests.push(request.url())
    })
    page.on("response", (response) => {
      if (response.request().method() === "GET" && response.ok()) {
        successfulResponses.push(response.url())
      }
    })

    expect(await participantUserIds(page, ordinaryThreadId)).not.toContain(userId("bob"))
    await page.goto(`/c/channels/${serverId}/${ordinaryThreadId}`)
    await expect(childPanel(page).getByTestId(tid.channelComposerShell)).toBeVisible({ timeout: 20_000 })
    await expect(childPanel(page).getByText("ordinary thread opener", { exact: true })).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(2_000)

    expect(successfulResponses.filter((url) => isConversationEntryRequest(url, ordinaryThreadId)))
      .toHaveLength(0)
    expect(requests.filter((url) =>
      isSidebarRequest(url, serverId)
      && new URL(url).searchParams.get("retainId") === ordinaryThreadId
    )).toHaveLength(0)
    expect(await routeStability(page)).toEqual({ mounts: 1, losses: 0, present: true })
    expect(await participantUserIds(page, ordinaryThreadId)).not.toContain(userId("bob"))
  })

  test("sidebar top-level and child navigation reuse the warm flat base", async ({ caseActors, caseResources }, testInfo) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, threadId, textAId, textBId, forumTitle } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    const requests: string[] = []
    const successfulResponses: string[] = []
    const failedThreadMessages: string[] = []
    page.on("request", (request) => {
      if (request.method() === "GET") requests.push(request.url())
    })
    page.on("response", (response) => {
      if (response.request().method() === "GET" && response.ok()) {
        successfulResponses.push(response.url())
      }
    })
    page.on("requestfailed", (request) => {
      if (isChannelMessagesRequest(request.url(), threadId)) {
        failedThreadMessages.push(request.failure()?.errorText ?? "unknown")
      }
    })

    const initialCombined = page.waitForResponse((response) =>
      response.ok() && isSidebarRequest(response.url(), serverId),
    )
    await page.goto(`/c/channels/${serverId}/${textAId}`)
    await initialCombined
    await expect(page.getByTestId(tid.channelRow(textBId))).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(tid.forumSidebarThread(threadId))).toBeVisible({ timeout: 20_000 })

    requests.length = 0
    await page.getByTestId(tid.channelRow(textBId)).click()
    await page.waitForURL(new RegExp(`${textBId}(?:\\?|$)`), { timeout: 20_000, waitUntil: "commit" })
    await expect(page.getByTestId(tid.channelRow(textBId))).toBeVisible()
    await page.waitForTimeout(300) // post-switch sidebar refetch exclusion window

    expect(requests.filter((url) => isSidebarRequest(url, serverId))).toHaveLength(0)

    requests.length = 0
    successfulResponses.length = 0
    let releaseRetained!: () => void
    let retainedStarted!: () => void
    const retainedGate = new Promise<void>((resolve) => { releaseRetained = resolve })
    caseResources.own(releaseRetained, async (captured) => { captured() })
    const retainedRequestStarted = new Promise<void>((resolve) => { retainedStarted = resolve })
    caseResources.own(retainedStarted, async (captured) => { captured() })
    await page.route("**/api/community/servers/*/channels?*", async (route) => {
      const url = route.request().url()
      if (
        isSidebarRequest(url, serverId)
        && new URL(url).searchParams.get("retainId") === threadId
      ) {
        retainedStarted()
        await retainedGate
      }
      await route.continue()
    })
    const firstChildEntry = page.waitForResponse((response) => response.request().method() === "GET"
      && isConversationEntryRequest(response.url(), threadId) && response.ok())
    const clickStartedAt = Date.now()
    let warmVisibleMs: number
    try {
      await page.getByTestId(tid.forumSidebarThread(threadId)).click()
      await expect.poll(() => new URL(page.url()).pathname).toBe(
        `/c/channels/${serverId}/${threadId}`,
      )
      await retainedRequestStarted
      await expect(childPanel(page).getByRole("banner").getByText(forumTitle, { exact: true }))
        .toBeVisible({ timeout: 1_000 })
      await expect(childPanel(page).locator(`[data-channel-id="${threadId}"]`))
        .toBeVisible({ timeout: 1_000 })
      await expect(childPanel(page).getByTestId(tid.composerInput))
        .toBeVisible({ timeout: 1_000 })
      warmVisibleMs = Date.now() - clickStartedAt
      expect(requests.filter((url) => isConversationEntryRequest(url, threadId))).toHaveLength(1)
      const entryResponse = await firstChildEntry
      expect(entryResponse.headers()["x-alook-community-contract"]).toBe("3")
      expect(await entryResponse.json()).toMatchObject({
        channelId: threadId, channel: { id: threadId, serverId, archived: false },
        access: { channelId: threadId, canRead: true },
      })
      expect(requests.filter(url => new URL(url).pathname === `/api/community/channels/${threadId}/read-state`)).toEqual([])
      expect(successfulResponses.filter(url => isChannelMessagesRequest(url, threadId))).toHaveLength(1)
      await expect(childPanel(page).getByRole("heading", { name: forumTitle })).toBeVisible()
      await expect(childPanel(page).getByText("post body", { exact: true })).toBeVisible()
      expect(successfulResponses.filter((url) => isSidebarRequest(url, serverId)
        && new URL(url).searchParams.get("retainId") === threadId)).toHaveLength(0)
    } finally {
      releaseRetained()
    }
    await expect.poll(() => successfulResponses.filter((url) => (
      isSidebarRequest(url, serverId)
      && new URL(url).searchParams.get("retainId") === threadId
    )).length).toBe(1)
    const retainedSuccessMs = Date.now() - clickStartedAt
    await page.waitForTimeout(1_200)
    expect(requests.filter((url) => (
      isSidebarRequest(url, serverId)
      && new URL(url).searchParams.get("retainId") === threadId
    ))).toHaveLength(1)
    expect(requests.filter((url) => isConversationEntryRequest(url, threadId))).toHaveLength(1)
    expect(successfulResponses.filter((url) => isConversationEntryRequest(url, threadId))).toHaveLength(1)
    const threadMessageRequests = requests.filter((url) => (
      isChannelMessagesRequest(url, threadId)
    ))
    const successfulThreadMessages = successfulResponses.filter((url) => (
      isChannelMessagesRequest(url, threadId)
    ))
    expect(successfulThreadMessages).toHaveLength(1)
    await testInfo.attach("warm-forum-route-performance", {
      body: JSON.stringify({
        warmVisibleMs,
        retainedSuccessMs,
        retainedRequests: 1,
        threadMessageAttempts: threadMessageRequests.length,
        threadMessageUrls: threadMessageRequests,
        threadMessageFailures: failedThreadMessages,
        threadMessageSuccesses: successfulThreadMessages.length,
      }),
      contentType: "application/json",
    })
    await page.unroute("**/api/community/servers/*/channels?*")

    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${textBId}`,
    )
    await page.goForward()
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${threadId}`,
    )
    await page.waitForTimeout(300) // current read proof reuse: no additional metadata validation
    expect(requests.filter((url) => isConversationEntryRequest(url, threadId))).toHaveLength(1)
  })
})

test.describe("forum sidebar archived opener projection", () => {
  async function prepareCase2(actors: CaseActors) {
    const { participantUserIds } = await prepareCase(actors)
    return { participantUserIds }
  }

  test("local, remote, retained, and hard-refresh paths converge on a filled top five", async ({ caseActors }) => {
    test.setTimeout(180_000)

    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { seedCategory, seedChannel, seedForumThread, seedServer } = actors.seed
    await prepareCase2(actors)

    const serverId = await seedServer("alice", `Archived sidebar ${Date.now()}`)
    const categoryId = await seedCategory("alice", serverId, "Forum group")
    const forumId = await seedChannel("alice", serverId, "archive-ranking", "forum", categoryId)
    const textId = await seedChannel("alice", serverId, "side-view", undefined, categoryId)
    const titles = new Map<string, string>()
    const bodies = new Map<string, string>()
    const threadIds: string[] = []
    for (let index = 0; index < 6; index++) {
      const title = `Ranked post ${index + 1} ${Date.now()}`
      const body = `ranked body ${index + 1}`
      const threadId = await seedForumThread("alice", forumId, title, body)
      threadIds.push(threadId)
      titles.set(threadId, title)
      bodies.set(threadId, body)
    }

    const viewer = await asUser("alice")
    await viewer.page.goto(`/c/channels/${serverId}/${textId}`)
    const initial = await strictSidebar(viewer.page, serverId)
    const initialIds = initial.canonicalChannels.map(({ id }) => id)
    expect(initialIds).toHaveLength(5)
    const archivedId = initialIds[0]!
    const refillId = threadIds.find((id) => !initialIds.includes(id))!
    for (const id of initialIds) {
      await expect(viewer.page.getByTestId(tid.forumSidebarThread(id))).toBeVisible({
        timeout: 20_000,
      })
    }
    await expect(viewer.page.getByTestId(tid.forumSidebarThread(refillId))).toHaveCount(0)

    await setForumPostArchived(viewer.page, serverId, forumId, archivedId, false)
    await expect(viewer.page.getByTestId(tid.forumSidebarThread(archivedId))).toHaveCount(0)
    await expect(viewer.page.getByTestId(tid.forumSidebarThread(refillId))).toBeVisible({
      timeout: 20_000,
    })
    const archivedProjection = await strictSidebar(viewer.page, serverId, archivedId)
    expect(archivedProjection.retainedChannel).toBeNull()
    expect(archivedProjection.retainedDisposition).toBe("opener-archived")
    expect(archivedProjection.canonicalChannels.map(({ id }) => id)).toEqual(
      initialIds.filter((id) => id !== archivedId).concat(refillId),
    )
    const exact = await viewer.page.request.get(`/api/community/channels/${archivedId}`)
    expect(exact.status()).toBe(200)
    expect((await exact.json() as { archived: boolean | number }).archived).toBeFalsy()

    await viewer.page.goto(`/c/channels/${serverId}/${archivedId}`)
    await expect(childPanel(viewer.page).getByRole("heading", { name: titles.get(archivedId)! })).toBeVisible({
      timeout: 20_000,
    })
    await expect(childPanel(viewer.page).getByText(bodies.get(archivedId)!, { exact: true })).toBeVisible()
    await expect(childPanel(viewer.page).getByTestId(tid.channelComposerShell)).toBeVisible()
    await expect(viewer.page.getByTestId(tid.forumSidebarThread(archivedId))).toHaveCount(0)

    await viewer.page.goto(`/c/channels/${serverId}/${forumId}`)
    await viewer.page.getByTestId(tid.forumTagChip("archived")).click()
    await expect(viewer.page.getByTestId(tid.forumThreadCard(archivedId))).toBeVisible({
      timeout: 20_000,
    })

    await viewer.page.goto(`/c/channels/${serverId}/${textId}`)
    const editor = await asUser("alice")
    await setForumPostArchived(editor.page, serverId, forumId, archivedId, true)
    await expect(viewer.page.getByTestId(tid.forumSidebarThread(archivedId))).toBeVisible({
      timeout: 20_000,
    })
    await expect(viewer.page.getByTestId(tid.forumSidebarThread(refillId))).toHaveCount(0)
    expect((await strictSidebar(viewer.page, serverId)).canonicalChannels.map(({ id }) => id))
      .toEqual(initialIds)

    await setForumPostArchived(editor.page, serverId, forumId, archivedId, false)
    await expect(viewer.page.getByTestId(tid.forumSidebarThread(archivedId))).toHaveCount(0)
    await expect(viewer.page.getByTestId(tid.forumSidebarThread(refillId))).toBeVisible({
      timeout: 20_000,
    })
    await viewer.page.reload({ waitUntil: "commit" })
    for (const id of initialIds.filter((id) => id !== archivedId).concat(refillId)) {
      await expect(viewer.page.getByTestId(tid.forumSidebarThread(id))).toBeVisible({
        timeout: 20_000,
      })
    }
    await expect(viewer.page.getByTestId(tid.forumSidebarThread(archivedId))).toHaveCount(0)
  })
})
