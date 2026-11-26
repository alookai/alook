import { communityFixtureFetch } from "./_fixtures/business-contract"
import { expectInertBackground } from "./_fixtures/inert-background"
import { expectPaintedInboxCardSurface, expectSeamlessInboxCard } from "./_fixtures/inbox-divider"
import type { Page, Request } from "@playwright/test"
import { expect, test, type CaseActors } from "./_fixtures/case-fixture"
import { GEOMETRY_EPSILON, composerEditable, gotoAfterUserWsAuth, ignoreNextDevToolsPointerCapture, waitForElementMotion } from "./_fixtures/actions"
import { communityFrameEvents, proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { WEB_URL } from "./_setup/paths"
import { tid } from "./_fixtures/testids"

type SurfaceGeometry = {
  viewport: { width: number; height: number }
  userBar: { top: number; surfaceBottom: number; bottom: number; left: number; right: number; width: number }
  card: { top: number; bottom: number; left: number; right: number; width: number; height: number }
  borders: {
    expectedColor: string
    card: BorderGeometry
    userBar: BorderGeometry
  }
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

type BorderGeometry = Record<"top" | "right" | "bottom" | "left", {
  width: string
  color: string
}>

async function removeServerChannels(serverId: string, sessionCookie: CaseActors["sessionCookie"]) {
  const headers = { Cookie: sessionCookie("alice"), Origin: WEB_URL }
  const response = await communityFixtureFetch(`${WEB_URL}/api/community/servers/${serverId}/channels`, { headers })
  if (!response.ok) throw new Error(`list server channels failed (${response.status})`)
  const body = await response.json() as { channels: Array<{ id: string }> }
  for (const channel of body.channels) {
    const deleted = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channel.id}`, {
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
      throw new Error("missing User Bar Extension geometry")
    }
    const wrapperRect = userBar.getBoundingClientRect()
    const userRect = userBarSurface.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const cardStyle = getComputedStyle(card)
    const userBarStyle = getComputedStyle(userBarSurface)
    const reference = document.createElement("div")
    reference.className = "border border-border/40"
    reference.style.position = "fixed"
    reference.style.visibility = "hidden"
    document.body.appendChild(reference)
    const expectedColor = getComputedStyle(reference).borderTopColor
    reference.remove()
    const borders = (style: CSSStyleDeclaration) => ({
      top: { width: style.borderTopWidth, color: style.borderTopColor },
      right: { width: style.borderRightWidth, color: style.borderRightColor },
      bottom: { width: style.borderBottomWidth, color: style.borderBottomColor },
      left: { width: style.borderLeftWidth, color: style.borderLeftColor },
    })
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
        width: userRect.width,
      },
      card: {
        top: cardRect.top,
        bottom: cardRect.bottom,
        left: cardRect.left,
        right: cardRect.right,
        width: cardRect.width,
        height: cardRect.height,
      },
      borders: {
        expectedColor,
        card: borders(cardStyle),
        userBar: borders(userBarStyle),
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

function expectJoinedBorderContract(geometry: SurfaceGeometry) {
  expect(Math.abs(geometry.card.left - geometry.userBar.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(geometry.card.right - geometry.userBar.right)).toBeLessThanOrEqual(1)
  expect(Math.abs(geometry.card.width - geometry.userBar.width)).toBeLessThanOrEqual(1)
  expect(geometry.borders.expectedColor).not.toBe("rgba(0, 0, 0, 0)")

  for (const side of ["top", "right", "left"] as const) {
    expect(geometry.borders.card[side]).toEqual({
      width: "1px",
      color: geometry.borders.expectedColor,
    })
  }
  expect(geometry.borders.card.bottom.width).toBe("0px")
  for (const side of ["top", "right", "bottom", "left"] as const) {
    expect(geometry.borders.userBar[side]).toEqual({
      width: "1px",
      color: geometry.borders.expectedColor,
    })
  }
  expect(Math.abs(geometry.card.bottom - geometry.userBar.top)).toBeLessThanOrEqual(1)
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

test.describe("mobile Inbox interactive user-bar base", () => {
  test.setTimeout(180_000)

  for (const cancelBeforeCommit of [false, true]) {
    test(`handles the first Inbox command after immediate parent return, close immediately=${cancelBeforeCommit}`, async ({ caseActors }) => {
      const actors = await caseActors(["alice", "bob"])
      const stamp = Date.now()
      const serverId = await actors.seed.seedServer("alice", `Pending Inbox ${stamp}`)
      const channelName = `pending-inbox-${stamp}`
      const channelId = await actors.seed.seedChannel("alice", serverId, channelName)
      await actors.seed.seedJoinServer("alice", "bob", serverId)
      const { page } = await actors.asUser("bob", {
        viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
      })
      await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
      await ignoreNextDevToolsPointerCapture(page)
      await expect(page.getByRole("banner").getByText(channelName, { exact: true })).toBeVisible()
      const root = `/c/channels/${serverId}`
      await page.getByRole("banner").getByRole("button", { name: "Back" }).tap({ noWaitAfter: true })
      await expect(page).toHaveURL(new RegExp(`${root}$`))
      await expect(page.getByRole("banner").getByText(channelName, { exact: true })).toHaveCount(0)
      const trigger = page.getByTestId(tid.inboxTrigger)
      await expect(trigger).toBeVisible()
      await trigger.tap()
      await expect(trigger).not.toHaveAttribute("aria-busy")
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      if (!cancelBeforeCommit) {
        await expect(page.getByRole("dialog", { name: "Inbox", exact: true })).toBeVisible()
        await expect(page.getByTestId(tid.userBarExtension)).toHaveCount(1)
      }
      await trigger.tap()
      await expect(trigger).toHaveAttribute("aria-expanded", "false")
      await expect(page.getByRole("dialog", { name: "Inbox", exact: true })).toHaveCount(0)
    })
  }

  test("paints the retained Inbox digits after hidden messages and repeated detail returns", async ({ caseActors }, testInfo) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { seedChannel, seedJoinServer, seedMessage, seedServer } = actors.seed

    const stamp = Date.now()
    const serverId = await seedServer("alice", `Inbox digits ${stamp}`)
    const landingId = await seedChannel("alice", serverId, `landing-${stamp}`)
    const firstId = await seedChannel("alice", serverId, `unread-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const bob = await asUser("bob", {
      viewport: { width: 390, height: 844 },
      recordVideo: { dir: testInfo.outputPath("inbox-digits-video"), size: { width: 390, height: 844 } },
    })
    const alice = await asUser("alice")
    const ws = await proxyCommunityWebSockets(bob.context)
    const trigger = bob.page.getByTestId(tid.inboxTrigger)
    const indicator = trigger.locator('[data-slot="inbox-unread-indicator"]')
    const flow = indicator.locator("number-flow-react")
    const overlay = bob.page.locator('[data-slot="community-user-bar-overlay"]')
    const snapshots: Array<{ stage: string; count: number; digits: unknown }> = []
    const video = bob.page.video()

    const readDigits = () => flow.evaluate((element) => {
      const number = element.shadowRoot?.querySelector('[part="number"]')
      const circle = element.closest('[data-slot="inbox-unread-circle"]')!
      const circleRect = circle.getBoundingClientRect()
      const rect = number?.getBoundingClientRect()
      const characters = [...element.shadowRoot?.querySelectorAll<HTMLElement>(
        '[part~="integer"] > [part~="digit"]:not([inert]) .digit__num:not([inert])',
      ) ?? []]
      return {
        text: characters.map((character) => character.textContent).join(""),
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        storedWidth: (number as HTMLElement | null)?.style.getPropertyValue("--width") ?? "",
        characters: characters.map((character) => {
          const bounds = character.getBoundingClientRect()
          const style = getComputedStyle(character)
          return {
            text: character.textContent,
            width: bounds.width,
            height: bounds.height,
            visibility: style.visibility,
            opacity: style.opacity,
            intersectsCircle: bounds.right > circleRect.left && bounds.left < circleRect.right
              && bounds.bottom > circleRect.top && bounds.top < circleRect.bottom,
          }
        }),
        animations: element.shadowRoot?.getAnimations().map((animation) => ({
          playState: animation.playState,
          pending: animation.pending,
          currentTime: animation.currentTime,
        })) ?? [],
      }
    })
    const capture = async (stage: string, count: number) => {
      const digits = await readDigits()
      snapshots.push({ stage, count, digits })
      await testInfo.attach(`inbox-digits-${stage}.json`, {
        body: JSON.stringify({ stage, count, digits }, null, 2), contentType: "application/json",
      })
      await testInfo.attach(`inbox-digits-${stage}.png`, {
        body: await bob.page.screenshot(), contentType: "image/png",
      })
      if (await trigger.isVisible()) {
        await testInfo.attach(`inbox-digits-${stage}-circle.png`, {
          body: await indicator.locator('[data-slot="inbox-unread-circle"]').screenshot(), contentType: "image/png",
        })
      }
      return digits
    }
    const expectDigits = async (stage: string, count: number) => {
      await expect(indicator).toHaveAttribute("data-count", String(count))
      await expect(indicator).toHaveAttribute("data-unread", "true")
      await expect.poll(async () => (await readDigits()).text).toBe(String(count))
      snapshots.push({ stage: `${stage}-transition`, count, digits: await readDigits() })
      await expect.poll(async () => (await readDigits()).animations.filter((animation) => (
        animation.playState === "running" || animation.pending
      )).length).toBe(0)
      const digits = await capture(stage, count)
      expect(digits.width).toBeGreaterThan(0)
      expect(digits.height).toBeGreaterThan(0)
      expect(digits.characters).toHaveLength(String(count).length)
      for (const character of digits.characters) {
        expect(character.width).toBeGreaterThan(0)
        expect(character.height).toBeGreaterThan(0)
        expect(character.visibility).toBe("visible")
        expect(Number(character.opacity)).toBeGreaterThan(0)
        expect(character.intersectsCircle).toBe(true)
      }
    }
    const send = async (channelId: string, content: string) => {
      await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
      const frameStart = ws.frames.length
      const response = alice.page.waitForResponse((candidate) => (
        candidate.request().method() === "POST"
        && new URL(candidate.url()).pathname === `/api/community/channels/${channelId}/messages`
      ))
      await composerEditable(alice.page).fill(content)
      await alice.page.keyboard.press("Enter")
      const result = await response
      expect(result.status()).toBe(201)
      const messageId = (await result.json() as { message: { id: string } }).message.id
      await expect.poll(() => {
        const events = ws.frames.slice(frameStart).flatMap(communityFrameEvents)
        return events.some((event) => event.type === "community:message.create" && event.message?.id === messageId)
          && events.some((event) => event.type === "community:unread.bump" && event.channelId === channelId)
      }, { timeout: 20_000 }).toBe(true)
      await testInfo.attach(`inbox-message-${messageId}.json`, {
        body: JSON.stringify({ channelId, messageId, status: result.status(), events: ws.frames.slice(frameStart).flatMap(communityFrameEvents) }),
        contentType: "application/json",
      })
    }

    try {
      await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}`)
      await expect(trigger).toBeVisible()
      await expect(indicator).toHaveAttribute("data-partial", "false")
      const baseCount = Number(await indicator.getAttribute("data-count"))
      expect(Number.isInteger(baseCount)).toBe(true)
      expect(baseCount).toBeLessThan(98)
      await send(firstId, `Visible Inbox digit ${stamp}`)
      await expectDigits("visible", baseCount + 1)
      const targetCount = Math.max(10, baseCount + 2)
      for (let count = baseCount + 1; count < targetCount - 1; count += 1) {
        const id = await seedChannel("alice", serverId, `digit-${stamp}-${count}`)
        await seedMessage("alice", id, `Digit precondition ${stamp} ${count}`)
        await expect(indicator).toHaveAttribute("data-count", String(count + 1))
      }
      await expectDigits("before-detail", targetCount - 1)
      const retained = await flow.elementHandle()
      expect(retained).not.toBeNull()
      const hiddenId = await seedChannel("alice", serverId, `hidden-${stamp}`)
      await bob.page.getByTestId(tid.channelRow(landingId)).click()
      await expect(bob.page).toHaveURL(`/c/channels/${serverId}/${landingId}`)
      await expectInertBackground(overlay)
      await expect(overlay).toHaveAttribute("inert", "")
      await expect(overlay).toHaveAttribute("aria-hidden", "true")
      await send(hiddenId, `Hidden Inbox digit ${stamp}`)
      await expect(indicator).toHaveAttribute("data-count", String(targetCount))
      await capture("hidden-update", targetCount)
      await bob.page.getByRole("banner").getByRole("button", { name: "Back", exact: true }).click()
      await expect(bob.page).toHaveURL(`/c/channels/${serverId}`)
      expect(await flow.evaluate((element, prior) => element === prior, retained)).toBe(true)
      await expectDigits("first-return", targetCount)

      for (let cycle = 0; cycle < 2; cycle += 1) {
        await bob.page.getByTestId(tid.channelRow(landingId)).click()
        await expectInertBackground(overlay)
        await expect(overlay).toHaveAttribute("inert", "")
        await expect(overlay).toHaveAttribute("aria-hidden", "true")
        await send(hiddenId, `Repeated hidden Inbox ${stamp} ${cycle}`)
        await expect(indicator).toHaveAttribute("data-count", String(targetCount))
        await capture(`hidden-repeat-${cycle}`, targetCount)
        await bob.page.getByRole("banner").getByRole("button", { name: "Back", exact: true }).click()
        await expect(bob.page).toHaveURL(`/c/channels/${serverId}`)
        expect(await flow.evaluate((element, prior) => element === prior, retained)).toBe(true)
        await expectDigits(`repeat-return-${cycle}`, targetCount)
      }
      await trigger.click()
      await expect(indicator).toHaveAttribute("data-unread", "false")
      await trigger.click()
      await expectDigits("closed-again", targetCount)
    } finally {
      await testInfo.attach("inbox-digit-stages.json", {
        body: JSON.stringify(snapshots, null, 2), contentType: "application/json",
      })
      await bob.context.close()
      if (video) await testInfo.attach("inbox-hidden-message-return-video", {
        path: await video.path(), contentType: "video/webm",
      })
    }
  })

  test("keeps the mobile shell unmasked and dismisses on outside press without writes", async ({ caseActors }, testInfo) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { seedChannel, seedJoinServer, seedMessage, seedServer } = actors.seed

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
        backgroundColor: getComputedStyle(element, "::before").backgroundColor,
        color: style.color,
        borderWidth: style.borderWidth,
      }
    })
    const readTriggerFocusRing = () => inboxTrigger.evaluate((element) => (
      getComputedStyle(element).boxShadow
    ))
    const closedTriggerSurfaceStyle = await readTriggerSurfaceStyle()
    const closedTriggerFocusRing = await readTriggerFocusRing()
    await expect(inboxTrigger).toHaveAttribute("data-variant", "unread")
    expect(closedTriggerSurfaceStyle.borderWidth).toBe("0px")
    expect(closedTriggerFocusRing).not.toBe("none")
    await inboxTrigger.click()
    await bob.page.mouse.move(0, 0)
    const mobileSurface = bob.page.getByTestId(tid.userBarExtension)
    await expect(mobileSurface).toBeVisible()
    await expect(mobileSurface).toHaveAttribute("role", "dialog")
    await expect(mobileSurface).not.toHaveAttribute("aria-modal", "true")
    await expect(inboxTrigger).toHaveAttribute("aria-expanded", "true")
    await expect(inboxTrigger).toHaveAttribute("data-variant", "ghost")
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
      borderWidth: "0px",
      boxShadow: "none",
    })
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
    await waitForElementMotion(mobileSurface)
    const geometry = await surfaceGeometry(bob.page)
    expectJoinedBorderContract(geometry)
    expect(geometry.userBar.bottom).toBe(844 - 34)
    expect(geometry.userBar.surfaceBottom).toBe(844 - 34 - 12)
    expect(geometry.userBarOwnsCenter).toBe(true)
    expect(geometry.card.height).toBeLessThanOrEqual(448 + GEOMETRY_EPSILON)
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
    const shell = bob.page.locator('[data-slot="community-shell-root"]')
    await expect.poll(() => shell.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return [rect.top, rect.right, rect.bottom, rect.left]
    })).toEqual([20, 374, 810, 18])
    for (const [edge, value, expected] of [
      ["right", 26, [20, 364, 810, 18]],
      ["bottom", 44, [20, 364, 800, 18]],
      ["left", 28, [20, 364, 800, 28]],
    ] as const) {
      await bob.page.evaluate(([edge, value]) => document.documentElement.style.setProperty(`--app-safe-area-${edge}`, `${value}px`), [edge, value] as const)
      await expect.poll(() => shell.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return [rect.top, rect.right, rect.bottom, rect.left]
      })).toEqual([...expected])
    }
    await bob.page.evaluate(() => {
      for (const [edge, value] of [["right", 16], ["bottom", 34], ["left", 18]] as const) {
        document.documentElement.style.setProperty(`--app-safe-area-${edge}`, `${value}px`)
      }
    })
    await bob.page.evaluate(() => {
      document.documentElement.style.setProperty("--alook-keyboard-bottom", "300px")
      document.documentElement.style.setProperty("--alook-keyboard-progress", "max(0px, calc(300px - var(--app-safe-area-bottom)))")
    })
    await expect.poll(async () => {
      const current = await surfaceGeometry(bob.page)
      return current.card.bottom <= 544 + GEOMETRY_EPSILON && current.card.top >= 20 - GEOMETRY_EPSILON
        && Math.abs(current.userBar.top - geometry.userBar.top) <= GEOMETRY_EPSILON
        && Math.abs(current.userBar.bottom - 810) <= GEOMETRY_EPSILON
    }).toBe(true)
    await bob.page.evaluate(() => {
      document.documentElement.style.removeProperty("--alook-keyboard-bottom")
      document.documentElement.style.removeProperty("--alook-keyboard-progress")
    })
    await testInfo.attach("user-bar-extension-mobile-390x844", {
      body: await bob.page.screenshot(),
      contentType: "image/png",
    })

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
    await expect(inboxTrigger).toHaveAttribute("data-variant", "unread")
    await expect(inboxTrigger).toHaveAttribute("aria-label", "Open Inbox")
    await expect(inboxTrigger).toHaveAttribute("aria-pressed", "false")
    await expect(inboxIcon).toHaveAttribute("fill", "none")
    await expect(inboxIcon).not.toHaveClass(/fill-current/)
    await expect.poll(readTriggerSurfaceStyle).toEqual(closedTriggerSurfaceStyle)
    await expect.poll(() => inboxTrigger.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
    await expect.poll(readTriggerFocusRing).toContain("0px 0px 0px 2px")
    await expect.poll(readTriggerFocusRing).not.toBe(closedTriggerFocusRing)
    await expect(bob.page).toHaveURL(new RegExp(`/c/channels/${serverId}$`))
    expect(writes.writes).toEqual([])
    expect(ws.frames).toHaveLength(wsBefore)

    await inboxTrigger.click()
    await inboxTrigger.click()
    await bob.page.mouse.move(0, 0)
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await expect(inboxTrigger).toBeFocused()
    await expect(inboxTrigger).toHaveAttribute("data-variant", "unread")
    await expect(inboxIcon).toHaveAttribute("fill", "none")
    await expect(inboxIcon).not.toHaveClass(/fill-current/)
    await expect.poll(readTriggerSurfaceStyle).toEqual(closedTriggerSurfaceStyle)
    await expect.poll(() => inboxTrigger.evaluate((element) => element.matches(":focus-visible"))).toBe(false)
    await expect.poll(readTriggerFocusRing).toBe(closedTriggerFocusRing)

    await inboxTrigger.click()
    await bob.page.keyboard.press("Escape")
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await expect(inboxTrigger).toBeFocused()
    await expect(inboxTrigger).toHaveAttribute("data-variant", "unread")
    await expect.poll(() => inboxTrigger.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
    await expect.poll(readTriggerFocusRing).toContain("0px 0px 0px 2px")
    await expect.poll(readTriggerFocusRing).not.toBe(closedTriggerFocusRing)

    await inboxTrigger.click()
    await bob.page.getByTestId(tid.userSettingsOpen).click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await expect(bob.page.getByTestId(tid.settingsShell)).toHaveCount(1)
    await expect.poll(() => bob.page.getByTestId(tid.settingsShell).evaluate(element => {
      const bounds = element.closest('[data-slot="dialog-content"]')!.getBoundingClientRect()
      return [bounds.top, bounds.right, bounds.bottom, bounds.left]
    })).toEqual([20, 374, 810, 18])
    await expect(inboxTrigger).not.toBeFocused()
    await bob.page.evaluate(() => document.documentElement.style.setProperty("--alook-keyboard-bottom", "300px"))
    await expect.poll(() => bob.page.getByTestId(tid.settingsShell).evaluate(element => {
      const bounds = element.closest('[data-slot="dialog-content"]')!.getBoundingClientRect()
      return [bounds.top, bounds.right, bounds.bottom, bounds.left]
    })).toEqual([20, 374, 544, 18])
    await expect.poll(() => shell.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return [bounds.top, bounds.right, bounds.bottom, bounds.left]
    })).toEqual([20, 374, 810, 18])
    await bob.page.evaluate(() => document.documentElement.style.removeProperty("--alook-keyboard-bottom"))
    await bob.page.getByTestId(tid.settingsClose).click()

    const avatarButton = bob.page.locator("[data-slot='community-user-bar-base'] button").first()
    const nameButton = bob.page.getByTestId(tid.userBarName)
    const userBarBase = bob.page.locator("[data-slot='community-user-bar-base']")
    const clickBlankUserBarSpace = async () => {
      const point = await userBarBase.evaluate((base) => {
        const rect = base.getBoundingClientRect()
        const candidates = [
          { x: rect.left + 4, y: rect.top + rect.height / 2 },
          { x: rect.right - 4, y: rect.top + rect.height / 2 },
          { x: rect.left + rect.width / 2, y: rect.top + 2 },
        ]
        for (const candidate of candidates) {
          const hit = document.elementFromPoint(candidate.x, candidate.y)
          if (hit && base.contains(hit) && !hit.closest("button")) return candidate
        }
        return null
      })
      expect(point).not.toBeNull()
      await bob.page.mouse.click(point!.x, point!.y)
    }

    await inboxTrigger.click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveAttribute("data-extension", "inbox")
    await avatarButton.click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await expect(bob.page.getByTestId(tid.profileCard)).toHaveCount(0)

    await inboxTrigger.click()
    await nameButton.click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await expect(bob.page.getByTestId(tid.profileCard)).toHaveCount(0)

    await inboxTrigger.click()
    await clickBlankUserBarSpace()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await expect(bob.page.getByTestId(tid.profileCard)).toHaveCount(0)

    await avatarButton.click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveAttribute("data-extension", "profile")
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveAttribute("data-presentation", "slot")
    await expect(bob.page.getByTestId(tid.profileCard)).toHaveCount(1)
    await expect(inboxTrigger).not.toBeFocused()
    const mobileProfileStyle = await bob.page.getByTestId(tid.profileCard).evaluate((card) => {
      const style = getComputedStyle(card)
      const reference = document.createElement("div")
      reference.className = "border border-border/40"
      reference.style.position = "fixed"
      reference.style.visibility = "hidden"
      document.body.appendChild(reference)
      const expectedBorderColor = getComputedStyle(reference).borderTopColor
      reference.remove()
      return {
        topLeft: style.borderTopLeftRadius,
        topRight: style.borderTopRightRadius,
        bottomLeft: style.borderBottomLeftRadius,
        bottomRight: style.borderBottomRightRadius,
        topWidth: style.borderTopWidth,
        rightWidth: style.borderRightWidth,
        bottomWidth: style.borderBottomWidth,
        leftWidth: style.borderLeftWidth,
        topColor: style.borderTopColor,
        expectedBorderColor,
      }
    })
    expect(mobileProfileStyle.bottomLeft).toBe("0px")
    expect(mobileProfileStyle.bottomRight).toBe("0px")
    expect(mobileProfileStyle.topLeft).not.toBe("0px")
    expect(mobileProfileStyle.topRight).not.toBe("0px")
    expect(mobileProfileStyle.topWidth).toBe("1px")
    expect(mobileProfileStyle.rightWidth).toBe("1px")
    expect(mobileProfileStyle.leftWidth).toBe("1px")
    expect(mobileProfileStyle.bottomWidth).toBe("0px")
    expect(mobileProfileStyle.topColor).toBe(mobileProfileStyle.expectedBorderColor)

    await clickBlankUserBarSpace()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await nameButton.click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveAttribute("data-extension", "profile")
    await bob.page.keyboard.press("Escape")
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)

    await bob.page.setViewportSize({ width: 320, height: 568 })
    await inboxTrigger.click()
    await expect.poll(async () => {
      const current = await surfaceGeometry(bob.page)
      return Math.abs(current.card.bottom - current.userBar.top)
    }).toBeLessThanOrEqual(1)
    const compact = await surfaceGeometry(bob.page)
    expectJoinedBorderContract(compact)
    expect(compact.card.top).toBeGreaterThanOrEqual(20)
    expect(compact.card.left).toBe(18 + 12)
    expect(compact.card.right).toBe(320 - 16 - 12)
    await inboxTrigger.click()

    expect(writes.writes).toEqual([])
    expect(ws.frames).toHaveLength(wsBefore)

    await bob.page.setViewportSize({ width: 1280, height: 900 })
    await inboxTrigger.click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveAttribute("data-extension", "inbox")
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveAttribute("data-presentation", "popup")
    await avatarButton.click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await expect(bob.page.getByTestId(tid.profileCard)).toHaveCount(0)

    await inboxTrigger.click()
    await nameButton.click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)
    await expect(bob.page.getByTestId(tid.profileCard)).toHaveCount(0)

    await inboxTrigger.click()
    await clickBlankUserBarSpace()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)

    await avatarButton.click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveAttribute("data-extension", "profile")
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveAttribute("data-presentation", "popup")
    await expect(bob.page.getByTestId(tid.profileCard)).toHaveCount(1)
    const desktopProfileRadii = await bob.page.getByTestId(tid.profileCard).evaluate((card) => {
      const style = getComputedStyle(card)
      return {
        bottomLeft: style.borderBottomLeftRadius,
        bottomRight: style.borderBottomRightRadius,
      }
    })
    expect(desktopProfileRadii.bottomLeft).not.toBe("0px")
    expect(desktopProfileRadii.bottomRight).not.toBe("0px")
    await avatarButton.click()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveCount(0)

    expect(writes.writes).toEqual([])
    writes.stop()
  })

  test("matches the mobile Composer width, height, and bottom margin", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { seedChannel, seedJoinServer, seedServer } = actors.seed

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
      expect(userBarBox!.x).toBe(18 + 12)
      expect(userBarBox!.x + userBarBox!.width).toBe(width - 16 - 12)
      expect(userBarBox!.height).toBe(48)
      expect(Math.abs(844 - userBarBox!.y - userBarBox!.height)).toBe(34 + 12)
    }
  })

  test("preserves Marked tab, scroll, and request ownership across 639↔640", async ({ caseActors }, testInfo) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { seedChannel, seedJoinServer, seedMark, seedMessage, seedServer } = actors.seed

    const stamp = Date.now()
    const serverId = await seedServer("alice", `Inbox continuity ${stamp}`)
    const channelId = await seedChannel("alice", serverId, `continuity-${stamp}`)
    const emptyServerId = await seedServer("alice", `Inbox continuity empty ${stamp}`)
    await removeServerChannels(emptyServerId, actors.sessionCookie)
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
    const eagerInboxPaths = [
      "/api/community/users/me/attention",
    ]
    bob.page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === "GET" && eagerInboxPaths.includes(path)) {
        inboxGets.push(path)
      }
    })
    bob.page.on("requestfinished", (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === "GET" && eagerInboxPaths.includes(path)) {
        completedInboxGets.push(path)
      }
    })
    await bob.page.setViewportSize({ width: 390, height: 844 })
    await bob.page.goto(`/c/channels/${emptyServerId}`, { waitUntil: "commit" })
    await expect.poll(() => eagerInboxPaths.every((path) => (
      completedInboxGets.filter((completed) => completed === path).length >= 1
    )), { timeout: 30_000 }).toBe(true)
    await expect.poll(ws.heldConnectionCount).toBe(1)
    expect(ws.releaseHeldConnections((frame) => frame.type === "auth.ok")).toBe(1)
    const writes = observeWrites(bob.page)
    const wsBefore = ws.frames.length

    await bob.page.getByTestId(tid.inboxTrigger).click()
    const collapsedCard = bob.page.getByTestId(tid.inboxUnreadCard(channelId))
    await expect(collapsedCard).toBeVisible()
    await waitForElementMotion(collapsedCard)
    await expectPaintedInboxCardSurface(collapsedCard)
    await bob.page.getByRole("tab", { name: "Marked" }).click()
    const markedScroll = bob.page.getByTestId(tid.inboxTabScroll("marked"))
    await expect(markedScroll.getByText(`Marked ${stamp} 13`, { exact: true })).toBeAttached()
    await waitForElementMotion(markedScroll)
    const markedCards = markedScroll.getByRole("article")
    const firstCard = markedCards.first()
    await expectSeamlessInboxCard(firstCard)
    await expect(firstCard.locator('[data-slot="inbox-card-messages"]')).toHaveCSS("--inbox-preview-fade-edge", "0%")
    await expect.poll(() => firstCard.evaluate((card, scrollId) => {
      const header = card.querySelector('[data-slot="inbox-card-header"]')!
      const list = card.closest(`[data-testid="${scrollId}"]`)!
      const listTop = list.getBoundingClientRect().top
      return {
        cardInset: Math.round(header.getBoundingClientRect().top - listTop),
        listInset: Math.round(listTop - list.closest('[role="tabpanel"]')!.getBoundingClientRect().top),
      }
    }, tid.inboxTabScroll("marked"))).toEqual({ cardInset: 0, listInset: 12 })
    await bob.page.setViewportSize({ width: 639, height: 844 })
    await waitForElementMotion(markedScroll)
    const tailCardId = await markedCards.last().getAttribute("data-testid")
    expect(tailCardId).toBeTruthy()
    const priorScroll = await markedScroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      return element.scrollTop
    })
    expect(priorScroll).toBeGreaterThan(0)
    await expect(markedScroll.getByTestId(tailCardId!).locator("[data-message-renderer]")).toBeInViewport()
    await waitForElementMotion(markedScroll)
    await expect.poll(() => markedScroll.evaluate((element) => element.scrollTop)).toBe(priorScroll)
    const getsBeforeResize = inboxGets.length

    await bob.page.setViewportSize({ width: 640, height: 844 })
    await expect(bob.page.getByTestId(tid.userBarExtension)).toBeVisible()
    await expect(bob.page.getByTestId(tid.userBarExtension)).toHaveAttribute("data-extension", "inbox")
    await expect(bob.page.locator("[data-slot='popover-content']")).toHaveCount(1)
    await expect(bob.page.getByRole("tab", { name: "Marked" })).toHaveAttribute("aria-selected", "true")
    const desktopScroll = bob.page.getByTestId(tid.inboxTabScroll("marked"))
    await waitForElementMotion(desktopScroll)
    await expect.poll(() => desktopScroll.evaluate((element, savedOffset) => {
      const maxOffset = element.scrollHeight - element.clientHeight
      return Math.abs(element.scrollTop - Math.min(savedOffset, maxOffset))
    }, priorScroll)).toBeLessThanOrEqual(1)
    await expect(desktopScroll.getByTestId(tailCardId!).locator("[data-message-renderer]")).toBeInViewport()

    await bob.page.setViewportSize({ width: 639, height: 844 })
    await expect(bob.page.getByTestId(tid.userBarExtension)).toBeVisible()
    await expect(bob.page.getByRole("tab", { name: "Marked" })).toHaveAttribute("aria-selected", "true")
    const mobileScroll = bob.page.getByTestId(tid.inboxTabScroll("marked"))
    await waitForElementMotion(mobileScroll)
    const restoredMobileScroll = await mobileScroll.evaluate((element) => ({
      scrollTop: element.scrollTop,
      maxScrollTop: element.scrollHeight - element.clientHeight,
    }))
    expect(Math.abs(
      restoredMobileScroll.scrollTop
        - Math.min(priorScroll, restoredMobileScroll.maxScrollTop),
    )).toBeLessThanOrEqual(1)
    await expect(mobileScroll.getByTestId(tailCardId!).locator("[data-message-renderer]")).toBeInViewport()

    await bob.page.setViewportSize({ width: 1280, height: 900 })
    const desktopContent = bob.page.getByTestId(tid.userBarExtension)
    await expect(desktopContent).toBeVisible()
    await expect.poll(async () => (await desktopContent.boundingBox())?.width ?? 0)
      .toBeCloseTo(480, 0)
    const desktopBox = await desktopContent.boundingBox()
    const desktopBaseBox = await bob.page.locator("[data-slot='community-user-bar-base']").boundingBox()
    expect(desktopBaseBox).not.toBeNull()
    expect(desktopBox!.width).toBeCloseTo(480, 0)
    expect(desktopBox!.y + desktopBox!.height).toBeLessThan(desktopBaseBox!.y)
    await expect(desktopContent).toHaveAttribute("data-presentation", "popup")
    await expect(bob.page.getByTestId(tid.inboxMobileBackdrop)).toHaveCount(0)
    await expect(bob.page.getByRole("tab", { name: "Marked" })).toHaveAttribute("aria-selected", "true")
    await testInfo.attach("user-bar-extension-desktop-1280x900", {
      body: await bob.page.screenshot(),
      contentType: "image/png",
    })

    expect(inboxGets).toHaveLength(getsBeforeResize)
    expect(writes.writes).toEqual([])
    expect(ws.frames).toHaveLength(wsBefore)
    writes.stop()
  })

  test("keeps expanded-viewport Inbox above the native keyboard without jumping and preserves Sonner toast surface on press", async ({ caseActors }, testInfo) => {
    const actors = await caseActors(["alice", "bob"])
    const stamp = Date.now()
    const serverId = await actors.seed.seedServer("alice", `Tablet Inbox ${stamp}`)
    const landingId = await actors.seed.seedChannel("alice", serverId, `landing-${stamp}`)
    const unreadId = await actors.seed.seedChannel("alice", serverId, `unread-${stamp}`)
    await actors.seed.seedJoinServer("alice", "bob", serverId)
    for (let i = 1; i <= 4; i++) {
      await actors.seed.seedMessage("alice", unreadId, `Tablet unread line ${stamp} #${i}`)
    }
    await actors.seed.seedMessage("alice", landingId, `Pin target ${stamp}`)

    const bob = await actors.asUser("bob", { viewport: { width: 951, height: 669 } })
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${landingId}`)
    await ignoreNextDevToolsPointerCapture(bob.page)
    await expect(bob.page.getByText(`Pin target ${stamp}`, { exact: true })).toBeVisible()

    // Simulate native mobile WebView full-window geometry before keyboard opens.
    await bob.page.evaluate(() => {
      const root = document.documentElement
      root.dataset.alookNativeResize = "true"
      root.style.setProperty("--app-safe-area-top", "10px")
      root.style.setProperty("--app-safe-area-bottom", "20px")
      root.style.setProperty("--app-native-window-height", "669px")
      root.style.setProperty("--app-native-window-safe-bottom", "20px")
      window.dispatchEvent(new Event("resize"))
    })

    const trigger = bob.page.getByTestId(tid.inboxTrigger)
    await expect(trigger).toBeVisible()
    await trigger.click()
    const card = bob.page.getByTestId(tid.userBarExtension)
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute("data-presentation", "popup")
    await waitForElementMotion(card)

    const before = await card.evaluate((el, userBarId) => {
      const userBar = document.querySelector<HTMLElement>(`[data-testid="${userBarId}"] [data-slot="community-user-bar-base"]`)!
      const c = el.getBoundingClientRect()
      const u = userBar.getBoundingClientRect()
      return {
        card: { left: c.left, top: c.top, bottom: c.bottom, width: c.width, height: c.height },
        userBar: { left: u.left, top: u.top, bottom: u.bottom },
      }
    }, tid.userBar)
    expect(Math.abs(before.card.left - before.userBar.left)).toBeLessThanOrEqual(4)
    expect(before.card.top).toBeGreaterThanOrEqual(10 - GEOMETRY_EPSILON)
    expect(before.card.bottom).toBeLessThanOrEqual(before.userBar.top + GEOMETRY_EPSILON)

    await bob.page.getByTestId(tid.inboxToggleChannel(unreadId)).click()
    const replyInput = bob.page.getByTestId(tid.inboxReplyInput(unreadId))
    await expect(replyInput).toBeVisible()
    await replyInput.click()
    await expect(replyInput).toBeFocused()
    await testInfo.attach("inbox-expanded-951x669-before-keyboard", {
      body: await bob.page.screenshot(),
      contentType: "image/png",
    })

    // Simulate native keyboard resizing WebView to 951x410 while UserBar stays at full-window bottom.
    await bob.page.setViewportSize({ width: 951, height: 410 })
    await bob.page.evaluate(() => {
      const root = document.documentElement
      root.style.setProperty("--app-safe-area-bottom", "0px")
      window.dispatchEvent(new Event("resize"))
    })

    await expect.poll(async () => {
      return card.evaluate((el, ids) => {
        const bounds = document.querySelector<HTMLElement>('[data-slot="app-safe-bounds"]')!.getBoundingClientRect()
        const scroll = document.querySelector<HTMLElement>(`[data-testid="${ids.scroll}"]`)!.getBoundingClientRect()
        const input = document.querySelector<HTMLElement>(`[data-testid="${ids.input}"]`)!
        const composer = input.closest<HTMLElement>('[data-slot="inbox-reply-composer"]')!.getBoundingClientRect()
        const send = document.querySelector<HTMLElement>(`[data-testid="${ids.send}"]`)!.getBoundingClientRect()
        const c = el.getBoundingClientRect()
        return bounds.top === 10
          && bounds.bottom === 410
          && document.documentElement.scrollTop === 0
          && c.top >= bounds.top - 0.5
          && c.bottom <= bounds.bottom + 0.5
          && composer.top >= scroll.top - 0.5
          && composer.bottom <= scroll.bottom + 0.5
          && send.top >= scroll.top - 0.5
          && send.bottom <= scroll.bottom + 0.5
      }, {
        scroll: tid.inboxTabScroll("unreads"),
        input: tid.inboxReplyInput(unreadId),
        send: tid.inboxReplySend(unreadId),
      })
    }).toBe(true)

    const after = await card.evaluate((el, ids) => {
      const bounds = document.querySelector<HTMLElement>('[data-slot="app-safe-bounds"]')!.getBoundingClientRect()
      const scroll = document.querySelector<HTMLElement>(`[data-testid="${ids.scroll}"]`)!.getBoundingClientRect()
      const input = document.querySelector<HTMLElement>(`[data-testid="${ids.input}"]`)!
      const composer = input.closest<HTMLElement>('[data-slot="inbox-reply-composer"]')!.getBoundingClientRect()
      const send = document.querySelector<HTMLElement>(`[data-testid="${ids.send}"]`)!.getBoundingClientRect()
      const c = el.getBoundingClientRect()
      return {
        docScrollTop: document.documentElement.scrollTop,
        card: { left: c.left, top: c.top, bottom: c.bottom, height: c.height },
        bounds: { top: bounds.top, bottom: bounds.bottom },
        scroll: { top: scroll.top, bottom: scroll.bottom },
        composer: { top: composer.top, bottom: composer.bottom, height: composer.height },
        send: { top: send.top, bottom: send.bottom, height: send.height },
      }
    }, {
      scroll: tid.inboxTabScroll("unreads"),
      input: tid.inboxReplyInput(unreadId),
      send: tid.inboxReplySend(unreadId),
    })
    expect(after.docScrollTop).toBe(0)
    expect(Math.abs(after.card.left - before.card.left)).toBeLessThanOrEqual(4)
    expect(after.card.top).toBeGreaterThanOrEqual(after.bounds.top - GEOMETRY_EPSILON)
    expect(after.card.bottom).toBeLessThanOrEqual(after.bounds.bottom + GEOMETRY_EPSILON)
    expect(after.composer.height).toBeGreaterThanOrEqual(44)
    expect(after.composer.top).toBeGreaterThanOrEqual(after.scroll.top - GEOMETRY_EPSILON)
    expect(after.composer.bottom).toBeLessThanOrEqual(after.scroll.bottom + GEOMETRY_EPSILON)
    expect(after.composer.bottom).toBeLessThanOrEqual(after.card.bottom + GEOMETRY_EPSILON)
    expect(after.composer.bottom).toBeLessThanOrEqual(410 + GEOMETRY_EPSILON)
    expect(after.send.top).toBeGreaterThanOrEqual(after.scroll.top - GEOMETRY_EPSILON)
    expect(after.send.bottom).toBeLessThanOrEqual(after.scroll.bottom + GEOMETRY_EPSILON)
    expect(after.send.bottom).toBeLessThanOrEqual(410 + GEOMETRY_EPSILON)
    await testInfo.attach("inbox-expanded-951x410-keyboard-open", {
      body: await bob.page.screenshot(),
      contentType: "image/png",
    })

    const replyText = `Inline keyboard reply ${stamp}`
    const replyPost = bob.page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes(`/api/community/channels/${unreadId}/messages`)
    ))
    await replyInput.fill(replyText)
    await bob.page.getByTestId(tid.inboxReplySend(unreadId)).click()
    expect((await replyPost).status()).toBe(201)
    await expect(bob.page.getByTestId(tid.inboxUnreadCard(unreadId))).toHaveCount(0)

    // Dismiss the native keyboard while Inbox remains open and verify it returns cleanly above UserBar.
    await bob.page.setViewportSize({ width: 951, height: 669 })
    await bob.page.evaluate(() => {
      const root = document.documentElement
      root.style.setProperty("--app-safe-area-bottom", "20px")
      window.dispatchEvent(new Event("resize"))
    })
    await expect.poll(async () => {
      return card.evaluate((el, userBarId) => {
        const userBar = document.querySelector<HTMLElement>(`[data-testid="${userBarId}"] [data-slot="community-user-bar-base"]`)!.getBoundingClientRect()
        const c = el.getBoundingClientRect()
        return c.top >= 10 - 1 && c.bottom <= userBar.top + 1
      }, tid.userBar)
    }).toBe(true)
    const restored = await card.evaluate((el, userBarId) => {
      const userBar = document.querySelector<HTMLElement>(`[data-testid="${userBarId}"] [data-slot="community-user-bar-base"]`)!.getBoundingClientRect()
      const c = el.getBoundingClientRect()
      return {
        card: { left: c.left, top: c.top, bottom: c.bottom, height: c.height },
        userBar: { left: userBar.left, top: userBar.top, bottom: userBar.bottom },
      }
    }, tid.userBar)
    expect(Math.abs(restored.card.left - before.card.left)).toBeLessThanOrEqual(4)
    expect(restored.card.top).toBeGreaterThanOrEqual(10 - GEOMETRY_EPSILON)
    expect(restored.card.bottom).toBeLessThanOrEqual(restored.userBar.top + GEOMETRY_EPSILON)
    await testInfo.attach("inbox-expanded-951x669-after-keyboard-close", {
      body: await bob.page.screenshot(),
      contentType: "image/png",
    })

    await bob.page.keyboard.press("Escape")
    await expect(card).toHaveCount(0)

    // Verify clicking/pressing a real Sonner toast does not stretch its ::before sticker face.
    await bob.page.evaluate(() => {
      const root = document.documentElement
      delete root.dataset.alookNativeResize
      root.style.removeProperty("--app-safe-area-top")
      root.style.removeProperty("--app-safe-area-bottom")
      root.style.removeProperty("--app-native-window-height")
      root.style.removeProperty("--app-native-window-safe-bottom")
      window.dispatchEvent(new Event("resize"))
    })
    await bob.context.grantPermissions(["clipboard-write"])
    const pinMessage = bob.page.getByText(`Pin target ${stamp}`, { exact: true })
    await pinMessage.click({ button: "right" })
    await bob.page.getByRole("menuitem", { name: "Copy Text" }).click()
    const sonnerToast = bob.page.locator('[data-sonner-toast][data-styled="true"]').first()
    await expect(sonnerToast).toBeVisible()
    const toastBox = await sonnerToast.boundingBox()
    expect(toastBox).not.toBeNull()
    await bob.page.mouse.move(toastBox!.x + toastBox!.width / 2, toastBox!.y + toastBox!.height / 2)
    await bob.page.mouse.down()
    await expect(sonnerToast).toHaveAttribute("data-swiping", "true")
    const pseudoState = await sonnerToast.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const beforeStyle = getComputedStyle(el, "::before")
      const afterStyle = getComputedStyle(el, "::after")
      return {
        toastHeight: Math.round(rect.height),
        beforeTransform: beforeStyle.transform,
        afterTransform: afterStyle.transform,
        beforeHeight: Math.round(parseFloat(beforeStyle.height)),
        afterHeight: Math.round(parseFloat(afterStyle.height)),
      }
    })
    expect(pseudoState.beforeTransform).toBe("none")
    expect(pseudoState.afterTransform).toBe("none")
    expect(Math.abs(pseudoState.beforeHeight - pseudoState.toastHeight)).toBeLessThanOrEqual(1)
    expect(Math.abs(pseudoState.afterHeight - pseudoState.toastHeight)).toBeLessThanOrEqual(1)
    await testInfo.attach("sonner-toast-pressed", {
      body: await bob.page.screenshot(),
      contentType: "image/png",
    })
    await bob.page.mouse.up()
  })
})
