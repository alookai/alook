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
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    const geometry = {
      offsetTop: 0,
      offsetLeft: 0,
      width: 390,
      height: 844,
    }
    const viewport = new EventTarget()
    for (const property of ["offsetTop", "offsetLeft", "width", "height"] as const) {
      Object.defineProperty(viewport, property, {
        configurable: true,
        get: () => geometry[property],
      })
    }
    Object.defineProperty(viewport, "scale", { configurable: true, value: 1 })
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    })
    Object.defineProperty(window, "__setMentionTestVisualViewport", {
      configurable: true,
      value: (next: Partial<typeof geometry>) => {
        Object.assign(geometry, next)
        viewport.dispatchEvent(new Event("resize"))
        viewport.dispatchEvent(new Event("scroll"))
      },
    })
  })

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
  const wrappedPrefix = Array.from(
    { length: 6 },
    (_, index) => `wrapped composer line ${index + 1} keeps the terminal caret moving`,
  ).join(" ")
  await editable.fill(wrappedPrefix)
  await editable.pressSequentially(" @")
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

  const readBounds = (popupTestId: string) => page.getByTestId(popupTestId).evaluate((element) => {
    const popup = element.getBoundingClientRect()
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) throw new Error("Missing composer caret")
    const caret = selection.getRangeAt(0).getBoundingClientRect()
    const viewport = window.visualViewport
    return {
      popup: {
        top: popup.top,
        bottom: popup.bottom,
        left: popup.left,
        right: popup.right,
      },
      caret: { top: caret.top, bottom: caret.bottom },
      viewport: {
        top: viewport?.offsetTop ?? 0,
        bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
        left: viewport?.offsetLeft ?? 0,
        right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
      },
    }
  })

  const expectAnchoredToCaret = (bounds: Awaited<ReturnType<typeof readBounds>>) => {
    const margin = 8
    expect(bounds.caret.top).toBeGreaterThanOrEqual(bounds.viewport.top)
    expect(bounds.caret.bottom).toBeLessThanOrEqual(bounds.viewport.bottom)
    expect(bounds.popup.top).toBeGreaterThanOrEqual(bounds.viewport.top + margin - 0.5)
    expect(bounds.popup.bottom).toBeLessThanOrEqual(bounds.viewport.bottom - margin + 0.5)
    expect(bounds.popup.left).toBeGreaterThanOrEqual(bounds.viewport.left + margin - 0.5)
    expect(bounds.popup.right).toBeLessThanOrEqual(bounds.viewport.right - margin + 0.5)
    const nearestEdgeGaps = [
      bounds.caret.top - bounds.popup.bottom,
      bounds.popup.top - bounds.caret.bottom,
    ]
    expect(
      nearestEdgeGaps.some((gap) => gap >= 3 && gap <= 5),
      `popup did not stay 4px from terminal caret: ${JSON.stringify(bounds)}`,
    ).toBe(true)
  }

  expectAnchoredToCaret(await readBounds(tid.mentionPopup))
  await page.evaluate(() => {
    const setViewport = Reflect.get(window, "__setMentionTestVisualViewport") as
      | ((geometry: { offsetTop: number; height: number }) => void)
      | undefined
    if (!setViewport) throw new Error("Missing controlled visual viewport")
    setViewport({ offsetTop: 364, height: 480 })
  })
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  expectAnchoredToCaret(await readBounds(tid.mentionPopup))
  await page.waitForTimeout(250)
  expectAnchoredToCaret(await readBounds(tid.mentionPopup))

  await page.keyboard.press("Escape")
  await editable.press("ControlOrMeta+A")
  await editable.press("Backspace")
  await editable.fill(wrappedPrefix)
  await editable.pressSequentially(" /")
  await expect(page.getByTestId(tid.channelRefPopup)).toBeVisible()
  expectAnchoredToCaret(await readBounds(tid.channelRefPopup))
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  expectAnchoredToCaret(await readBounds(tid.channelRefPopup))

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
