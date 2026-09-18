import type { Page, Route } from "@playwright/test"
import { test, expect, sessionCookie } from "./_fixtures/community-fixture"
import { seedChannel, seedJoinServer, seedMessage, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"

const VIEWPORT = { width: 1280, height: 800 }

type Geometry = {
  scrollTop: number
  scrollHeight: number
  firstVisibleId: string | null
  firstVisibleOffset: number | null
}

async function readGeometry(page: Page): Promise<Geometry> {
  return page.getByTestId(tid.messageScroller).evaluate((element) => {
    const root = element as HTMLElement
    const rootRect = root.getBoundingClientRect()
    const row = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect()
        return rect.bottom > rootRect.top + 1 && rect.top < rootRect.bottom - 1
      }) ?? null
    const rect = row?.getBoundingClientRect() ?? null
    return {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      firstVisibleId: row?.dataset.msgId ?? null,
      firstVisibleOffset: rect ? rect.top - rootRect.top : null,
    }
  })
}

async function waitForStableGeometry(page: Page): Promise<Geometry> {
  let previous = ""
  let stable: Geometry | null = null
  await expect.poll(async () => {
    await page.getByTestId(tid.messageScroller).evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    const next = await readGeometry(page)
    const signature = JSON.stringify(next)
    if (signature === previous) stable = next
    previous = signature
    return stable !== null
  }, { timeout: 20_000 }).toBe(true)
  return stable!
}

async function readMessageOffset(page: Page, messageId: string): Promise<number | null> {
  return page.getByTestId(tid.messageScroller).evaluate((element, id) => {
    const root = element as HTMLElement
    const row = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
      .find((candidate) => candidate.dataset.msgId === id)
    return row ? row.getBoundingClientRect().top - root.getBoundingClientRect().top : null
  }, messageId)
}

async function setReadCheckpoint(channelId: string, messageId: string): Promise<void> {
  const response = await fetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
    method: "PUT",
    headers: {
      Cookie: sessionCookie("alice"),
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({ lastReadMessageId: messageId }),
  })
  expect(response.ok).toBe(true)
}

async function holdNextPage(page: Page, channelId: string, param: "cursor" | "since") {
  let release!: () => void
  let resolveMatched!: () => void
  let consumed = false
  const gate = new Promise<void>((resolve) => { release = resolve })
  const matched = new Promise<void>((resolve) => { resolveMatched = resolve })
  const pattern = `**/api/community/channels/${channelId}/messages**`
  const handler = async (route: Route) => {
    const url = new URL(route.request().url())
    if (!consumed && url.searchParams.has(param)) {
      consumed = true
      resolveMatched()
      await gate
    }
    await route.continue()
  }
  await page.route(pattern, handler)
  return {
    matched,
    release,
    dispose: async () => {
      release()
      await page.unroute(pattern, handler)
    },
  }
}

async function moveToEdge(page: Page, edge: "start" | "end"): Promise<void> {
  await page.getByTestId(tid.messageScroller).evaluate((element, target) => {
    element.scrollTop = target === "start" ? 0 : element.scrollHeight
    element.dispatchEvent(new Event("scroll"))
  }, edge)
}

function expectAnchorPreserved(before: Geometry, retainedOffset: number | null, label: string): void {
  expect(retainedOffset, `${label}: retained message`).not.toBeNull()
  expect(
    Math.abs((retainedOffset ?? 0) - (before.firstVisibleOffset ?? 0)),
    `${label}: viewport offset`,
  ).toBeLessThanOrEqual(1)
}

test("older and newer pages preserve a real-message anchor and do not replay", async ({ asUser }, testInfo) => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Pagination anchor ${stamp}`)
  await seedJoinServer("alice", "bob", serverId)
  const channelId = await seedChannel("alice", serverId, `pagination-anchor-${stamp}`)
  const ids: string[] = []
  for (let index = 0; index < 130; index += 1) {
    const variable = index % 5 === 0
      ? Array.from({ length: 10 }, (_, line) => `row ${index} variable ${line} ${"x".repeat(line * 3)}`).join("\n")
      : `row ${index}`
    ids.push(await seedMessage(index <= 64 ? "alice" : "bob", channelId, variable))
  }
  await setReadCheckpoint(channelId, ids[64])

  const olderUser = await asUser("alice")
  await olderUser.page.setViewportSize(VIEWPORT)
  const olderRequests: string[] = []
  olderUser.page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith(`/channels/${channelId}/messages`) && url.searchParams.has("cursor")) {
      olderRequests.push(url.search)
    }
  })
  await olderUser.page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
  await expect(olderUser.page.getByTestId(tid.newDivider)).toBeVisible({ timeout: 30_000 })
  const olderPage = await holdNextPage(olderUser.page, channelId, "cursor")
  await moveToEdge(olderUser.page, "start")
  await olderPage.matched
  const olderBefore = await waitForStableGeometry(olderUser.page)
  olderPage.release()
  await expect(olderUser.page.getByText("Loading older messages…", { exact: true })).toHaveCount(0)
  const olderAfter = await waitForStableGeometry(olderUser.page)
  const olderRetainedOffset = await readMessageOffset(olderUser.page, olderBefore.firstVisibleId!)
  await olderPage.dispose()

  await setReadCheckpoint(channelId, ids[64])
  const newerUser = await asUser("alice")
  await newerUser.page.setViewportSize(VIEWPORT)
  const newerRequests: string[] = []
  newerUser.page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith(`/channels/${channelId}/messages`) && url.searchParams.has("since")) {
      newerRequests.push(url.search)
    }
  })
  await newerUser.page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
  await expect(newerUser.page.getByTestId(tid.newDivider)).toBeVisible({ timeout: 30_000 })
  const newerPage = await holdNextPage(newerUser.page, channelId, "since")
  await moveToEdge(newerUser.page, "end")
  await newerPage.matched
  const newerBefore = await waitForStableGeometry(newerUser.page)
  newerPage.release()
  await expect(newerUser.page.getByText("Loading newer messages…", { exact: true })).toHaveCount(0)
  const newerAfter = await waitForStableGeometry(newerUser.page)
  const newerRetainedOffset = await readMessageOffset(newerUser.page, newerBefore.firstVisibleId!)
  await newerPage.dispose()

  await testInfo.attach("pagination-anchor-trajectory.json", {
    body: JSON.stringify({
      sourceSha: "b1ea24a7f73778717662b5d894f1e14b019c8c08",
      older: { before: olderBefore, after: olderAfter, retainedOffset: olderRetainedOffset, requests: olderRequests },
      newer: { before: newerBefore, after: newerAfter, retainedOffset: newerRetainedOffset, requests: newerRequests },
    }, null, 2),
    contentType: "application/json",
  })

  expect(olderRequests).toHaveLength(1)
  expect(newerRequests).toHaveLength(1)
  expectAnchorPreserved(olderBefore, olderRetainedOffset, "older prepend")
  expectAnchorPreserved(newerBefore, newerRetainedOffset, "newer append")
})
