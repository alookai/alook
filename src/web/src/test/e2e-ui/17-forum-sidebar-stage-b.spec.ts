import type { Request } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { seedChannel, seedForumThread, seedServer } from "./_fixtures/seed"

function isSidebarRequest(url: string, serverId: string): boolean {
  const parsed = new URL(url)
  return parsed.pathname === `/api/community/servers/${serverId}/channels`
    && parsed.searchParams.get("participating") === "true"
}

function isExactChannelRequest(url: string, channelId: string): boolean {
  return new URL(url).pathname === `/api/community/channels/${channelId}`
}

function isExactMessageRequest(url: string): boolean {
  return /^\/api\/community\/messages\/[^/]+$/.test(new URL(url).pathname)
}

function isChannelMessagesRequest(url: string, channelId: string): boolean {
  return new URL(url).pathname === `/api/community/channels/${channelId}/messages`
}

test.describe.serial("forum sidebar Stage B request shape", () => {
  let serverId: string
  let forumId: string
  let threadId: string
  let textAId: string
  let textBId: string
  let forumTitle: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Sidebar ${Date.now()}`)
    forumId = await seedChannel("alice", serverId, "forum", "forum")
    textAId = await seedChannel("alice", serverId, "text-a")
    textBId = await seedChannel("alice", serverId, "text-b")
    forumTitle = `Retained ${Date.now()}`
    threadId = await seedForumThread("alice", forumId, forumTitle, "post body")
  })

  test("a cold direct child and hard refresh use one combined GET with no exact meta/opener GETs", async ({ asUser }) => {
    const { page } = await asUser("alice")
    const requests: string[] = []
    type CapturePhase = "cold" | "refresh"
    let capturePhase: CapturePhase = "cold"
    const requestPhases = new WeakMap<Request, CapturePhase>()
    const successfulResponses: { phase: CapturePhase; url: string }[] = []
    page.on("request", (request) => {
      requestPhases.set(request, capturePhase)
      if (request.method() === "GET") requests.push(request.url())
    })
    page.on("response", (response) => {
      if (response.request().method() === "GET" && response.ok()) {
        successfulResponses.push({
          phase: requestPhases.get(response.request()) ?? capturePhase,
          url: response.url(),
        })
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
    await page.goto(`/c/channels/${serverId}/${threadId}`)
    await Promise.all([initialCombined, initialNewest, initialAnchored])
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${threadId}`,
    )
    await expect(page.getByRole("heading", { name: forumTitle })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("post body", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)

    expect(requests.filter((url) => isSidebarRequest(url, serverId))).toHaveLength(1)
    expect(new URL(requests.find((url) => isSidebarRequest(url, serverId))!).searchParams.get("retainId"))
      .toBe(threadId)
    expect(requests.filter((url) => isExactChannelRequest(url, threadId))).toHaveLength(0)
    expect(requests.filter(isExactMessageRequest)).toHaveLength(0)
    const coldMessageRequests = requests.filter((url) => isChannelMessagesRequest(url, threadId))
    const coldSuccessfulMessageResponses = successfulResponses
      .filter(({ phase, url }) => (
        phase === "cold" && isChannelMessagesRequest(url, threadId)
      ))
      .map(({ url }) => url)
    expect(coldSuccessfulMessageResponses).toHaveLength(2)
    expect(coldSuccessfulMessageResponses.filter((url) => !new URL(url).searchParams.has("anchor")))
      .toHaveLength(1)
    expect(coldSuccessfulMessageResponses.filter((url) => new URL(url).searchParams.has("anchor")))
      .toHaveLength(1)
    expect(new Set(coldSuccessfulMessageResponses).size).toBe(coldSuccessfulMessageResponses.length)
    expect(coldMessageRequests.length).toBeGreaterThanOrEqual(coldSuccessfulMessageResponses.length)

    requests.length = 0
    successfulResponses.length = 0
    capturePhase = "refresh"
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
    await page.waitForTimeout(2_000)

    expect(requests.filter((url) => isSidebarRequest(url, serverId))).toHaveLength(1)
    expect(new URL(requests.find((url) => isSidebarRequest(url, serverId))!).searchParams.get("retainId"))
      .toBe(threadId)
    expect(requests.filter((url) => isExactChannelRequest(url, threadId))).toHaveLength(0)
    expect(requests.filter(isExactMessageRequest)).toHaveLength(0)
    const refreshMessageRequests = requests.filter((url) => isChannelMessagesRequest(url, threadId))
    expect(refreshMessageRequests.length).toBeGreaterThanOrEqual(1)
    const refreshSuccessfulMessageResponses = successfulResponses
      .filter(({ phase, url }) => (
        phase === "refresh" && isChannelMessagesRequest(url, threadId)
      ))
      .map(({ url }) => url)
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

  test("switching between top-level channels reuses the warm canonical base", async ({ asUser }) => {
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

    requests.length = 0
    await page.getByTestId(tid.channelRow(textBId)).click()
    await page.waitForURL(new RegExp(`${textBId}(?:\\?|$)`), { timeout: 20_000, waitUntil: "commit" })
    await expect(page.getByTestId(tid.channelRow(textBId))).toBeVisible()
    await page.waitForTimeout(300)

    expect(requests.filter((url) => isSidebarRequest(url, serverId))).toHaveLength(0)
  })
})
