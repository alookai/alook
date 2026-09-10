import type { Page, Request } from "@playwright/test"
import { expect, sessionCookie, test } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth, ignoreNextDevToolsPointerCapture } from "./_fixtures/actions"
import { proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { WEB_URL } from "./_setup/paths"
import {
  seedChannel,
  seedJoinServer,
  seedMark,
  seedMessage,
  seedServer,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

type SurfaceGeometry = {
  viewport: { width: number; height: number }
  userBar: { top: number; surfaceBottom: number; bottom: number; left: number; right: number }
  card: { top: number; bottom: number; left: number; right: number; height: number }
  seam: {
    cardTopLeft: string
    cardTopRight: string
    cardBottomLeft: string
    cardBottomRight: string
    userBarTopLeft: string
    userBarTopRight: string
    userBarBottomLeft: string
    userBarBottomRight: string
  }
  userBarOwnsCenter: boolean
  rootScrollTop: number
}

async function removeServerChannels(serverId: string) {
  const headers = { Cookie: sessionCookie("alice"), Origin: WEB_URL }
  const response = await fetch(`${WEB_URL}/api/community/servers/${serverId}/channels`, { headers })
  if (!response.ok) throw new Error(`list server channels failed (${response.status})`)
  const body = await response.json() as { channels: Array<{ id: string }> }
  for (const channel of body.channels) {
    const deleted = await fetch(`${WEB_URL}/api/community/channels/${channel.id}`, {
      method: "DELETE",
      headers,
    })
    if (!deleted.ok) throw new Error(`delete server channel failed (${deleted.status})`)
  }
}

async function surfaceGeometry(page: Page): Promise<SurfaceGeometry> {
  return page.getByTestId(tid.userBarExtension).evaluate((card, ids) => {
    const userBar = document.querySelector<HTMLElement>(
      `[data-testid='${ids.userBar}']`,
    )
    const userBarSurface = userBar?.querySelector<HTMLElement>(
      "[data-slot='community-user-bar-base']",
    ) ?? null
    if (!userBar || !userBarSurface) {
      throw new Error("missing mobile Inbox geometry")
    }
    const wrapperRect = userBar.getBoundingClientRect()
    const userRect = userBarSurface.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const cardStyle = getComputedStyle(card)
    const userBarStyle = getComputedStyle(userBarSurface)
    const hit = document.elementFromPoint(
      userRect.left + userRect.width / 2,
      userRect.top + userRect.height / 2,
    )
    return {
      viewport: { width: innerWidth, height: innerHeight },
      userBar: {
        top: userRect.top,
        surfaceBottom: userRect.bottom,
        bottom: wrapperRect.bottom,
        left: userRect.left,
        right: userRect.right,
      },
      card: {
        top: cardRect.top,
        bottom: cardRect.bottom,
        left: cardRect.left,
        right: cardRect.right,
        height: cardRect.height,
      },
      seam: {
        cardTopLeft: cardStyle.borderTopLeftRadius,
        cardTopRight: cardStyle.borderTopRightRadius,
        cardBottomLeft: cardStyle.borderBottomLeftRadius,
        cardBottomRight: cardStyle.borderBottomRightRadius,
        userBarTopLeft: userBarStyle.borderTopLeftRadius,
        userBarTopRight: userBarStyle.borderTopRightRadius,
        userBarBottomLeft: userBarStyle.borderBottomLeftRadius,
        userBarBottomRight: userBarStyle.borderBottomRightRadius,
      },
      userBarOwnsCenter: !!hit && userBar.contains(hit),
      rootScrollTop: document.scrollingElement?.scrollTop ?? 0,
    }
  }, {
    userBar: tid.userBar,
  })
}

function observeWrites(page: Page) {
  const writes: string[] = []
  const listener = (request: Request) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    }
  }
  page.on("request", listener)
  return { writes, stop: () => page.off("request", listener) }
}

test.describe.serial("mobile Inbox interactive user-bar base", () => {
  test.setTimeout(180_000)

  test("keeps the mobile shell unmasked and dismisses on outside press without writes", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Inbox surface ${stamp}`)
    const channelId = await seedChannel("alice", serverId, `inbox-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    await seedMessage("alice", channelId, `Inbox unread ${stamp}`)

    const bob = await asUser("bob")
    const ws = await proxyCommunityWebSockets(bob.context)
    await bob.page.setViewportSize({ width: 390, height: 844 })
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}`)
    await ignoreNextDevToolsPointerCapture(bob.page)
    await expect(bob.page.getByTestId(tid.inboxTrigger)).toBeVisible()

    await bob.page.evaluate(() => {
      const style = document.documentElement.style
      style.setProperty("--app-safe-area-top", "20px")
      style.setProperty("--app-safe-area-right", "16px")
      style.setProperty("--app-safe-area-bottom", "34px")
      style.setProperty("--app-safe-area-left", "18px")
    })
    const writes = observeWrites(bob.page)
    const wsBefore = ws.frames.length

    const inboxTrigger = bob.page.getByTestId(tid.inboxTrigger)
    const inboxIcon = inboxTrigger.locator("svg")
    await expect(inboxTrigger).toHaveAttribute("aria-label", "Open Inbox")
    await expect(inboxTrigger).toHaveAttribute("aria-pressed", "false")
    await expect(inboxIcon).toHaveAttribute("fill", "none")
    await expect(inboxIcon).not.toHaveClass(/fill-current/)
    const readTriggerSurfaceStyle = () => inboxTrigger.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderWidth: style.borderWidth,
      }
    })
    const readTriggerFocusRing = () => inboxTrigger.evaluate((element) => (
      getComputedStyle(element).boxShadow
    ))
    const closedTriggerSurfaceStyle = await readTriggerSurfaceStyle()
    const closedTriggerFocusRing = await readTriggerFocusRing()
    await inboxTrigger.click()
    await bob.page.mouse.move(0, 0)
    const mobileSurface = bob.page.getByTestId(tid.userBarExtension)
    await expect(mobileSurface).toBeVisible()
    await expect(mobileSurface).toHaveAttribute("role", "dialog")
    await expect(mobileSurface).not.toHaveAttribute("aria-modal", "true")
    await expect(inboxTrigger).toHaveAttribute("aria-expanded", "true")
    await expect(inboxTrigger).toHaveAttribute("aria-controls", await mobileSurface.getAttribute("id") ?? "")
    await expect(inboxTrigger).toHaveAttribute("aria-label", "Close Inbox")
    await expect(inboxTrigger).toHaveAttribute("aria-pressed", "true")
    await expect(inboxIcon).toHaveAttribute("fill", "none")
    await expect(inboxIcon).not.toHaveClass(/fill-current/)
    await expect.poll(async () => {
      const openStyle = await readTriggerSurfaceStyle()
      return {
        backgroundChanged: openStyle.backgroundColor !== closedTriggerSurfaceStyle.backgroundColor,
        foregroundChanged: openStyle.color !== closedTriggerSurfaceStyle.color,
        borderWidth: openStyle.borderWidth,
        boxShadow: await readTriggerFocusRing(),
      }
    }).toEqual({
      backgroundChanged: true,
      foregroundChanged: true,
      borderWidth: closedTriggerSurfaceStyle.borderWidth,
      boxShadow: closedTriggerFocusRing,
    })
    expect(closedTriggerSurfaceStyle.borderWidth).toBe("0px")
    expect(closedTriggerFocusRing).toBe("none")
    await expect(bob.page.getByRole("button", { name: "Close Inbox" })).toHaveCount(1)
    await expect(mobileSurface.getByRole("button", { name: /^Dismiss / })).toHaveCount(0)
    await expect(mobileSurface).toBeFocused()
    await bob.page.keyboard.press("Tab")
    expect(await mobileSurface.evaluate((element) => (
      element.contains(document.activeElement)
      && document.activeElement !== element
    ))).toBe(true)
    await expect(bob.page.getByTestId(tid.inboxMobileBackdrop)).toHaveCount(0)
    await expect.poll(async () => {
      const current = await surfaceGeometry(bob.page)
      return Math.abs(current.card.bottom - current.userBar.top)
    }).toBeLessThanOrEqual(1)
    const geometry = await surfaceGeometry(bob.page)
    expect(Math.abs(geometry.card.bottom - geometry.userBar.top)).toBeLessThanOrEqual(1)
    expect(geometry.userBar.bottom).toBe(844)
    expect(geometry.userBar.surfaceBottom).toBe(844 - 34 - 12)
    expect(geometry.userBarOwnsCenter).toBe(true)
    expect(geometry.card.height).toBeLessThanOrEqual(448)
    expect(geometry.card.top).toBeGreaterThanOrEqual(20)
    expect(geometry.seam.cardTopLeft).not.toBe("0px")
    expect(geometry.seam.cardTopRight).not.toBe("0px")
    expect(geometry.seam.cardBottomLeft).toBe("0px")
    expect(geometry.seam.cardBottomRight).toBe("0px")
    expect(geometry.seam.userBarTopLeft).toBe("0px")
    expect(geometry.seam.userBarTopRight).toBe("0px")
    expect(geometry.seam.userBarBottomLeft).not.toBe("0px")
    expect(geometry.seam.userBarBottomRight).not.toBe("0px")
    expect(geometry.rootScrollTop).toBe(0)

    const outsidePoint = {
      x: Math.floor(geometry.viewport.width / 2),
      y: 1,
    }
    const outsideHit = await bob.page.evaluate(({ point, ids }) => {
      const hit = document.elementFromPoint(point.x, point.y)
      const interactive = hit?.closest([
        "button",
        "a[href]",
        "input",
        "select",
        "textarea",
        "[contenteditable='true']",
        "[role='button']",
        "[role='link']",
        "[role='checkbox']",
        "[role='radio']",
        "[role='switch']",
        "[role='tab']",
        "[role='menuitem']",
        "[role='option']",
        "[role='combobox']",
        "[role='listbox']",
        "[role='slider']",
        "[role='spinbutton']",
        "[role='textbox']",
        "[role='searchbox']",
      ].join(","))
      return {
        exists: !!hit,
        insideInbox: !!hit?.closest(`[data-testid='${ids.userBarExtension}']`),
        interactive: !!interactive,
      }
    }, { point: outsidePoint, ids: { userBarExtension: tid.userBarExtension } })
    expect(outsideHit).toEqual({
      exists: true,
      insideInbox: false,
      interactive: false,
    })
    await bob.page.mouse.click(outsidePoint.x, outsidePoint.y)
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await expect(inboxTrigger).toBeFocused()
    await expect(inboxTrigger).toHaveAttribute("aria-label", "Open Inbox")
    await expect(inboxTrigger).toHaveAttribute("aria-pressed", "false")
    await expect(inboxIcon).toHaveAttribute("fill", "none")
    await expect(inboxIcon).not.toHaveClass(/fill-current/)
    await expect.poll(readTriggerSurfaceStyle).toEqual(closedTriggerSurfaceStyle)
    await expect.poll(readTriggerFocusRing).toContain("2px")
    await expect(bob.page).toHaveURL(new RegExp(`/c/channels/${serverId}$`))
    expect(writes.writes).toEqual([])
    expect(ws.frames).toHaveLength(wsBefore)

    await inboxTrigger.click()
    await inboxTrigger.click()
    await bob.page.mouse.move(0, 0)
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await expect(inboxTrigger).toBeFocused()
    await expect(inboxIcon).toHaveAttribute("fill", "none")
    await expect(inboxIcon).not.toHaveClass(/fill-current/)
    await expect.poll(readTriggerSurfaceStyle).toEqual(closedTriggerSurfaceStyle)
    await expect.poll(readTriggerFocusRing).toBe("none")

    await inboxTrigger.click()
    await bob.page.keyboard.press("Escape")
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await expect(inboxTrigger).toBeFocused()

    await inboxTrigger.click()
    await bob.page.getByTestId(tid.userSettingsOpen).click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await expect(bob.page.getByTestId(tid.settingsShell)).toHaveCount(1)
    await expect(inboxTrigger).not.toBeFocused()
    await bob.page.getByTestId(tid.settingsClose).click()

    await inboxTrigger.click()
    await bob.page.locator("[data-slot='community-user-bar-base'] button").first().click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveAttribute("data-extension", "profile")
    await expect(bob.page.getByTestId(tid.profileCard)).toHaveCount(1)
    await expect(inboxTrigger).not.toBeFocused()
    await bob.page.keyboard.press("Escape")

    await bob.page.setViewportSize({ width: 320, height: 568 })
    await inboxTrigger.click()
    await expect.poll(async () => {
      const current = await surfaceGeometry(bob.page)
      return Math.abs(current.card.bottom - current.userBar.top)
    }).toBeLessThanOrEqual(1)
    const compact = await surfaceGeometry(bob.page)
    expect(compact.card.top).toBeGreaterThanOrEqual(20)
    expect(compact.card.left).toBe(18)
    expect(compact.card.right).toBe(320 - 16)
    await inboxTrigger.click()

    expect(writes.writes).toEqual([])
    expect(ws.frames).toHaveLength(wsBefore)
    writes.stop()
  })

  test("matches the mobile Composer width, height, and bottom margin", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `User Bar alignment ${stamp}`)
    const channelId = await seedChannel("alice", serverId, `alignment-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const bob = await asUser("bob")

    for (const width of [320, 390]) {
      await bob.page.setViewportSize({ width, height: 844 })
      await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}`)
      await expect(bob.page.locator('meta[name="viewport"]')).toHaveAttribute(
        "content",
        /viewport-fit=cover/,
      )
      await bob.page.evaluate(() => {
        const style = document.documentElement.style
        style.setProperty("--app-safe-area-top", "20px")
        style.setProperty("--app-safe-area-right", "16px")
        style.setProperty("--app-safe-area-bottom", "34px")
        style.setProperty("--app-safe-area-left", "18px")
      })
      const userBarBox = await bob.page
        .locator("[data-slot='community-user-bar-base']")
        .boundingBox()
      expect(userBarBox).not.toBeNull()

      await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${channelId}`)
      await bob.page.evaluate(() => {
        const style = document.documentElement.style
        style.setProperty("--app-safe-area-top", "20px")
        style.setProperty("--app-safe-area-right", "16px")
        style.setProperty("--app-safe-area-bottom", "34px")
        style.setProperty("--app-safe-area-left", "18px")
      })
      const composer = bob.page
        .getByTestId(tid.channelComposerShell)
        .locator("[data-slot='community-composer-base']")
      await expect(composer).toBeVisible()
      const composerBox = await composer.boundingBox()
      expect(composerBox).not.toBeNull()

      expect(Math.abs(userBarBox!.x - composerBox!.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(userBarBox!.width - composerBox!.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(userBarBox!.height - composerBox!.height)).toBeLessThanOrEqual(1)
      expect(Math.abs(userBarBox!.y - composerBox!.y)).toBeLessThanOrEqual(1)
      expect(userBarBox!.x).toBe(18)
      expect(userBarBox!.x + userBarBox!.width).toBe(width - 16)
      expect(userBarBox!.height).toBe(48)
      expect(Math.abs(844 - userBarBox!.y - userBarBox!.height)).toBe(34 + 12)
    }
  })

  test("preserves Marked tab, scroll, and request ownership across 639↔640", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Inbox continuity ${stamp}`)
    const channelId = await seedChannel("alice", serverId, `continuity-${stamp}`)
    const emptyServerId = await seedServer("alice", `Inbox continuity empty ${stamp}`)
    await removeServerChannels(emptyServerId)
    await seedJoinServer("alice", "bob", serverId)
    await seedJoinServer("alice", "bob", emptyServerId)
    for (let index = 0; index < 14; index += 1) {
      const messageId = await seedMessage("alice", channelId, `Marked ${stamp} ${index}`)
      await seedMark("bob", channelId, messageId)
    }

    const bob = await asUser("bob")
    let heldFirstAuthOk = false
    const ws = await proxyCommunityWebSockets(bob.context, {
      decideConnectionFrame: (frame) => {
        if (frame.type !== "auth.ok" || heldFirstAuthOk) return "forward"
        heldFirstAuthOk = true
        return "hold"
      },
    })
    const inboxGets: string[] = []
    const completedInboxGets: string[] = []
    const postAuthInboxGets = new WeakSet<Request>()
    const completedPostAuthInboxPaths = new Set<string>()
    let authOkReleased = false
    const eagerInboxPaths = [
      "/api/community/users/me/inbox/unreads",
      "/api/community/users/me/inbox/mentions",
    ]
    bob.page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === "GET" && path.includes("/users/me/inbox/")) {
        inboxGets.push(path)
        if (authOkReleased) postAuthInboxGets.add(request)
      }
    })
    bob.page.on("requestfinished", (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === "GET" && path.includes("/users/me/inbox/")) {
        completedInboxGets.push(path)
        if (postAuthInboxGets.has(request)) completedPostAuthInboxPaths.add(path)
      }
    })
    await bob.page.setViewportSize({ width: 639, height: 844 })
    await bob.page.goto(`/c/channels/${emptyServerId}`, { waitUntil: "commit" })
    await expect.poll(() => eagerInboxPaths.every((path) => (
      completedInboxGets.filter((completed) => completed === path).length >= 1
    )), { timeout: 30_000 }).toBe(true)
    await expect.poll(ws.heldConnectionCount).toBe(1)
    expect(ws.releaseHeldConnections((frame) => frame.type === "auth.ok")).toBe(1)
    authOkReleased = true
    await expect.poll(() => eagerInboxPaths.every((path) => (
      completedPostAuthInboxPaths.has(path)
    ))).toBe(true)
    const writes = observeWrites(bob.page)
    const wsBefore = ws.frames.length

    await bob.page.getByTestId(tid.inboxTrigger).click()
    await bob.page.getByRole("tab", { name: "Marked" }).click()
    const markedScroll = bob.page.getByTestId(tid.inboxTabScroll("marked"))
    await expect(markedScroll.getByText(`Marked ${stamp} 13`, { exact: true })).toBeAttached()
    const priorScroll = await markedScroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      return element.scrollTop
    })
    expect(priorScroll).toBeGreaterThan(0)
    const getsBeforeResize = inboxGets.length

    await bob.page.setViewportSize({ width: 640, height: 844 })
    await expect(bob.page.getByTestId(tid.userBarExtension)).toBeVisible()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveAttribute("data-extension", "inbox")
    await expect(bob.page.locator("[data-slot='popover-content']")).toHaveCount(0)
    await expect(bob.page.getByRole("tab", { name: "Marked" })).toHaveAttribute("aria-selected", "true")
    const desktopScroll = bob.page.getByTestId(tid.inboxTabScroll("marked"))
    await expect.poll(() => desktopScroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThanOrEqual(priorScroll - 1)

    await bob.page.setViewportSize({ width: 639, height: 844 })
    await expect(bob.page.getByTestId(tid.userBarExtension)).toBeVisible()
    await expect(bob.page.getByRole("tab", { name: "Marked" })).toHaveAttribute("aria-selected", "true")
    const mobileScroll = bob.page.getByTestId(tid.inboxTabScroll("marked"))
    const restoredMobileScroll = await mobileScroll.evaluate((element) => ({
      scrollTop: element.scrollTop,
      maxScrollTop: element.scrollHeight - element.clientHeight,
    }))
    expect(Math.abs(
      restoredMobileScroll.scrollTop
        - Math.min(priorScroll, restoredMobileScroll.maxScrollTop),
    )).toBeLessThanOrEqual(1)

    await bob.page.setViewportSize({ width: 1280, height: 900 })
    const desktopContent = bob.page.getByTestId(tid.userBarExtension)
    await expect(desktopContent).toBeVisible()
    await expect.poll(async () => (await desktopContent.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(200)
    const desktopBox = await desktopContent.boundingBox()
    const desktopBaseBox = await bob.page.locator("[data-slot='community-user-bar-base']").boundingBox()
    expect(desktopBaseBox).not.toBeNull()
    expect(Math.abs((desktopBox?.width ?? 0) - desktopBaseBox!.width)).toBeLessThanOrEqual(1)
    await expect(bob.page.getByTestId(tid.inboxMobileBackdrop)).toHaveCount(0)
    await expect(bob.page.getByRole("tab", { name: "Marked" })).toHaveAttribute("aria-selected", "true")

    expect(inboxGets).toHaveLength(getsBeforeResize)
    expect(writes.writes).toEqual([])
    expect(ws.frames).toHaveLength(wsBefore)
    writes.stop()
  })
})
