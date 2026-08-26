import { test, expect } from "./_fixtures/community-fixture"
import { composerEditable } from "./_fixtures/actions"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

type Candidate = {
  id: string
  userId: string
  name: string
  discriminator: string
  avatar: string
  status: "offline"
  sub: string
  role: "member"
}

function candidate(prefix: string, index: number): Candidate {
  const tag = String(index).padStart(4, "0")
  return {
    id: `${prefix}-member-${tag}`,
    userId: `${prefix}-user-${tag}`,
    name: `${prefix}${tag}`,
    discriminator: tag,
    avatar: prefix[0] ?? "M",
    status: "offline",
    sub: "",
    role: "member",
  }
}

test("@ candidates page to completion, expose first search page, and keep status anchored on mobile", async ({ asUser }) => {
  const serverId = await seedServer("alice", `Mention pages ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "mention-pages")
  const { page } = await asUser("alice")
  await page.setViewportSize({ width: 390, height: 640 })

  const browse = Array.from({ length: 12 }, (_, index) => candidate("Browse", index + 1))
  const matches = Array.from({ length: 205 }, (_, index) => candidate("CapMatch", index + 1))
  let releaseSearchTail!: () => void
  const searchTailReleased = new Promise<void>((resolve) => {
    releaseSearchTail = resolve
  })
  let markSearchTailRequested!: () => void
  const searchTailRequested = new Promise<void>((resolve) => {
    markSearchTailRequested = resolve
  })

  await page.route(`**/api/community/servers/${serverId}/members**`, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/members/search")) {
      const query = url.searchParams.get("q") ?? ""
      const cursor = url.searchParams.get("cursor")
      if (query === "Fail") {
        await route.fulfill({ status: 500, json: { error: "forced failure" } })
        return
      }
      if (query === "NoMatch") {
        await route.fulfill({ json: { members: [], limit: 200, hasMore: false } })
        return
      }
      if (query === "CapMatch" && cursor) {
        markSearchTailRequested()
        await searchTailReleased
        await route.fulfill({
          json: { members: matches.slice(200), limit: 200, hasMore: false },
        })
        return
      }
      if (query === "CapMatch") {
        await route.fulfill({
          json: {
            members: matches.slice(0, 200),
            limit: 200,
            hasMore: true,
            cursor: "search-page-2",
          },
        })
        return
      }
    }

    const cursor = url.searchParams.get("cursor")
    await route.fulfill({
      json: cursor
        ? { members: browse.slice(8), limit: 8, total: 12, hasMore: false }
        : {
            members: browse.slice(0, 8),
            limit: 8,
            total: 12,
            hasMore: true,
            cursor: "browse-page-2",
          },
    })
  })

  await page.goto(`/c/channels/${serverId}/${channelId}`)
  const editable = composerEditable(page)
  await expect(editable).toBeVisible({ timeout: 20_000 })
  await editable.click()
  await editable.pressSequentially("@")
  await expect(page.getByTestId(tid.mentionOption(browse[11]!.id))).toHaveCount(1)

  await editable.pressSequentially("CapMatch")
  await searchTailRequested
  await expect(page.getByTestId(tid.mentionOption(matches[0]!.id))).toBeVisible()
  const mentionOptions = page.getByTestId(tid.mentionPopup).getByRole("option")
  await expect(mentionOptions).toHaveCount(200)
  await expect(page.getByTestId(tid.mentionStatus)).toHaveAttribute("data-state", "loading-more")
  releaseSearchTail()
  await expect(page.getByTestId(tid.mentionOption(matches[204]!.id))).toHaveCount(1)
  await expect(mentionOptions).toHaveCount(205)

  const bounds = await page.getByTestId(tid.mentionPopup).evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const viewport = window.visualViewport
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: viewport?.width ?? window.innerWidth,
      height: viewport?.height ?? window.innerHeight,
    }
  })
  expect(bounds.top).toBeGreaterThanOrEqual(0)
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width)

  await page.keyboard.press("Escape")
  await editable.press("ControlOrMeta+A")
  await editable.press("Backspace")
  await editable.pressSequentially("@NoMatch")
  await expect(page.getByTestId(tid.mentionStatus)).toHaveAttribute("data-state", "empty")

  await page.keyboard.press("Escape")
  await editable.press("ControlOrMeta+A")
  await editable.press("Backspace")
  await editable.pressSequentially("@Fail")
  await expect(page.getByTestId(tid.mentionStatus)).toHaveAttribute("data-state", "error")
})
