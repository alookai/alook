import type { Page } from "@playwright/test"
import { test, expect, userId } from "./_fixtures/community-fixture"
import { sendMessage } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import {
  seedCategory,
  seedChannel,
  seedForumThread,
  seedJoinServer,
  seedMessage,
  seedServer,
  seedThread,
} from "./_fixtures/seed"

function isSidebarRequest(url: string, serverId: string): boolean {
  const parsed = new URL(url)
  return parsed.pathname === `/api/community/servers/${serverId}/channels`
    && parsed.searchParams.get("participating") === "true"
}

function isExactChannelRequest(url: string, channelId: string): boolean {
  return new URL(url).pathname === `/api/community/channels/${channelId}`
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

async function participantUserIds(page: Page, channelId: string): Promise<string[]> {
  const response = await page.request.get(`/api/community/channels/${channelId}/members`)
  expect(response.status()).toBe(200)
  const payload = await response.json() as { members: Array<{ userId: string }> }
  return payload.members.map((member) => member.userId)
}

test.describe.serial("forum sidebar Stage B request shape", () => {
  let serverId: string
  let forumId: string
  let threadId: string
  let textAId: string
  let textBId: string
  let forumTitle: string
  let ordinaryThreadId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Sidebar ${Date.now()}`)
    const categoryId = await seedCategory("alice", serverId, "Grouped")
    forumId = await seedChannel("alice", serverId, "forum", "forum", categoryId)
    textAId = await seedChannel("alice", serverId, "text-a", undefined, categoryId)
    textBId = await seedChannel("alice", serverId, "text-b", undefined, categoryId)
    await seedJoinServer("alice", "bob", serverId)
    await seedJoinServer("alice", "carol", serverId)
    forumTitle = `Retained ${Date.now()}`
    threadId = await seedForumThread("alice", forumId, forumTitle, "post body")
    const parentMessageId = await seedMessage("alice", textAId, "ordinary thread opener")
    ordinaryThreadId = await seedThread("alice", parentMessageId, "ordinary thread")
  })

  test("a cold direct child and hard refresh keep exact route metadata bounded", async ({ asUser }) => {
    const { page } = await asUser("alice")
    const requests: string[] = []
    const successfulResponses: string[] = []
    let releaseFirstAnchor!: () => void
    const firstAnchorGate = new Promise<void>((resolve) => { releaseFirstAnchor = resolve })
    let anchorRouteRequests = 0
    await page.route("**/api/community/channels/**/messages**", async (route) => {
      const url = route.request().url()
      if (
        route.request().method() !== "GET"
        || !isChannelMessagesRequest(url, threadId)
        || !new URL(url).searchParams.has("anchor")
      ) {
        await route.continue()
        return
      }
      anchorRouteRequests += 1
      if (anchorRouteRequests === 1) await firstAnchorGate
      await route.continue()
    })
    page.on("request", (request) => {
      if (request.method() === "GET") requests.push(request.url())
    })
    page.on("response", (response) => {
      if (response.request().method() === "GET" && response.ok()) {
        successfulResponses.push(response.url())
      }
    })

    const initialCombined = page.waitForResponse((response) =>
      response.ok() && isSidebarRequest(response.url(), serverId),
    )
    const initialNewest = page.waitForResponse((response) => {
      if (!response.ok() || !isChannelMessagesRequest(response.url(), threadId)) return false
      return !new URL(response.url()).searchParams.has("anchor")
    })
    const initialAnchored = page.waitForResponse((response) => {
      if (!response.ok() || !isChannelMessagesRequest(response.url(), threadId)) return false
      return new URL(response.url()).searchParams.has("anchor")
    })
    try {
      await page.goto(`/c/channels/${serverId}/${threadId}`)
      await expect.poll(() => anchorRouteRequests, { timeout: 20_000 }).toBeGreaterThan(0)
      await expect.poll(() => new URL(page.url()).pathname).toBe(
        `/c/channels/${serverId}/${threadId}`,
      )
      await page.waitForTimeout(500) // duplicate-anchor exclusion window
      expect(anchorRouteRequests).toBe(1)
    } finally {
      releaseFirstAnchor()
    }
    await Promise.all([initialCombined, initialNewest, initialAnchored])
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${threadId}`,
    )
    await expect(page.getByRole("heading", { name: forumTitle })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("post body", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)

    const coldSidebarRequests = requests.filter((url) => isSidebarRequest(url, serverId))
    expect(coldSidebarRequests.length).toBeGreaterThanOrEqual(1)
    expect(coldSidebarRequests.length).toBeLessThanOrEqual(2)
    expect(coldSidebarRequests.every((url) => {
      const retainId = new URL(url).searchParams.get("retainId")
      return retainId === null || retainId === threadId
    })).toBe(true)
    expect(successfulResponses.filter((url) => isExactChannelRequest(url, threadId))).toHaveLength(1)
    const coldMessageRequests = requests.filter((url) => isChannelMessagesRequest(url, threadId))
    const coldSuccessfulMessageResponses = successfulResponses.filter((url) =>
      isChannelMessagesRequest(url, threadId),
    )
    expect(coldSuccessfulMessageResponses).toHaveLength(2)
    expect(coldSuccessfulMessageResponses.filter((url) => !new URL(url).searchParams.has("anchor")))
      .toHaveLength(1)
    expect(coldSuccessfulMessageResponses.filter((url) => new URL(url).searchParams.has("anchor")))
      .toHaveLength(1)
    expect(anchorRouteRequests).toBe(1)
    expect(new Set(coldSuccessfulMessageResponses).size).toBe(coldSuccessfulMessageResponses.length)
    expect(coldMessageRequests.length).toBeGreaterThanOrEqual(coldSuccessfulMessageResponses.length)

    requests.length = 0
    successfulResponses.length = 0
    const refreshCombined = page.waitForResponse((response) =>
      response.ok() && isSidebarRequest(response.url(), serverId),
    )
    await page.reload({ waitUntil: "commit" })
    await refreshCombined
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${threadId}`,
    )
    await expect(page.getByRole("heading", { name: forumTitle })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("post body", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    await page.waitForTimeout(2_000) // late exact-channel/message fetch exclusion window

    const refreshSidebarRequests = requests.filter((url) => isSidebarRequest(url, serverId))
    expect(refreshSidebarRequests.length).toBeGreaterThanOrEqual(1)
    expect(refreshSidebarRequests.length).toBeLessThanOrEqual(2)
    expect(successfulResponses.filter((url) => isExactChannelRequest(url, threadId))).toHaveLength(1)
    const refreshMessageRequests = requests.filter((url) => isChannelMessagesRequest(url, threadId))
    expect(refreshMessageRequests.length).toBeGreaterThanOrEqual(1)
    const refreshSuccessfulMessageResponses = successfulResponses.filter((url) =>
      isChannelMessagesRequest(url, threadId),
    )
    const refreshNewestResponses = refreshSuccessfulMessageResponses.filter((url) =>
      !new URL(url).searchParams.has("anchor"),
    )
    const refreshAnchorResponses = refreshSuccessfulMessageResponses.filter((url) =>
      new URL(url).searchParams.has("anchor"),
    )
    expect(refreshNewestResponses.length).toBeLessThanOrEqual(1)
    expect(refreshAnchorResponses.length).toBeLessThanOrEqual(1)
    expect(new Set(refreshSuccessfulMessageResponses).size)
      .toBe(refreshSuccessfulMessageResponses.length)
  })

  test("a flat child route preserves one settled message load", async ({ asUser }) => {
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
    await expect(page.getByRole("heading", { name: forumTitle })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("post body", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    await page.waitForTimeout(2_000) // late duplicate anchored/unanchored fetch exclusion window

    const messageResponses = successfulResponses.filter((url) =>
      isChannelMessagesRequest(url, threadId),
    )
    expect(messageResponses.filter((url) => new URL(url).searchParams.has("anchor")))
      .toHaveLength(1)
    expect(messageResponses.filter((url) => !new URL(url).searchParams.has("anchor")).length)
      .toBeLessThanOrEqual(1)
  })

  test("a non-participant keeps a grouped forum route after retained null arrives", async ({ asUser }) => {
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
    await expect(page.getByTestId(tid.channelComposerShell)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("post body", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => sidebarResponses.some(({ url }) =>
      new URL(url).searchParams.get("retainId") === threadId,
    )).toBe(true)
    await page.waitForTimeout(2_000)

    const retainedResponses = sidebarResponses.filter(({ url }) =>
      new URL(url).searchParams.get("retainId") === threadId
    )
    expect(retainedResponses).toHaveLength(1)
    expect(retainedResponses[0]?.retainedChannel).toBeNull()
    expect(successfulResponses.filter((url) => isExactChannelRequest(url, threadId))).toHaveLength(1)
    expect(await routeStability(page)).toEqual({ mounts: 1, losses: 0, present: true })
    expect(await participantUserIds(page, threadId)).not.toContain(userId("bob"))

    const reply = `bob joins ${Date.now()}`
    await sendMessage(page, reply)
    await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => participantUserIds(page, threadId)).toContain(userId("bob"))
  })

  test("a non-participant warm forum-card click settles one negative retained request", async ({ asUser }) => {
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
    await expect(page.getByTestId(tid.channelComposerShell)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("post body", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => sidebarResponses.filter(({ url }) =>
      new URL(url).searchParams.get("retainId") === threadId,
    ).length).toBe(1)
    await page.waitForTimeout(2_000)

    const retainedResponses = sidebarResponses.filter(({ url }) =>
      new URL(url).searchParams.get("retainId") === threadId
    )
    expect(retainedResponses).toHaveLength(1)
    expect(retainedResponses[0]?.retainedChannel).toBeNull()
    expect(successfulResponses.filter((url) => isExactChannelRequest(url, threadId))).toHaveLength(1)
    expect(await routeStability(page)).toEqual({ mounts: 1, losses: 0, present: true })
    expect(await participantUserIds(page, threadId)).not.toContain(userId("carol"))
  })

  test("a grouped ordinary thread never asks the forum sidebar to retain it", async ({ asUser }) => {
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
    await expect(page.getByTestId(tid.channelComposerShell)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("ordinary thread opener", { exact: true })).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(2_000)

    expect(successfulResponses.filter((url) => isExactChannelRequest(url, ordinaryThreadId)))
      .toHaveLength(1)
    expect(requests.filter((url) =>
      isSidebarRequest(url, serverId)
      && new URL(url).searchParams.get("retainId") === ordinaryThreadId
    )).toHaveLength(0)
    expect(await routeStability(page)).toEqual({ mounts: 1, losses: 0, present: true })
    expect(await participantUserIds(page, ordinaryThreadId)).not.toContain(userId("bob"))
  })

  test("sidebar top-level and child navigation reuse the warm flat base", async ({ asUser }) => {
    const { page } = await asUser("alice")
    const requests: string[] = []
    page.on("request", (request) => {
      if (request.method() === "GET") requests.push(request.url())
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
    await page.getByTestId(tid.forumSidebarThread(threadId)).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${threadId}`,
    )
    await expect(page.getByRole("heading", { name: forumTitle })).toBeVisible({ timeout: 20_000 })
    expect(requests.filter((url) => isSidebarRequest(url, serverId))).toHaveLength(0)

    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${textBId}`,
    )
    await page.goForward()
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${threadId}`,
    )
  })
})
