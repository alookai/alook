import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { CURRENT_COMMUNITY_FIXTURE_HEADERS } from "./_fixtures/business-contract"
import { tid } from "./_fixtures/testids"

async function iconTone(control: Locator, token: string) {
  return control.evaluate((element, token) => {
    const marker = document.createElement("span")
    marker.style.color = getComputedStyle(element).getPropertyValue(token)
    document.body.appendChild(marker)
    const expected = getComputedStyle(marker).color
    marker.remove()
    return { actual: getComputedStyle(element.querySelector("svg")!).color, expected }
  }, token)
}

async function expectIconTone(control: Locator, token: string) {
  await expect.poll(async () => {
    const colors = await iconTone(control, token)
    return colors.actual === colors.expected
  }).toBe(true)
}

function inboxActionFace(control: Locator) {
  return control.locator('[data-slot="inbox-action-visual"]')
}

async function expectCompactMobileInboxAction(control: Locator) {
  await expect(control).toHaveCSS("width", "44px")
  await expect(control).toHaveCSS("height", "44px")
  await expect(control).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(control).toHaveCSS("background-image", "none")
  const face = inboxActionFace(control)
  await expect(face).toHaveCSS("width", "28px")
  await expect(face).toHaveCSS("height", "28px")
  await expect.poll(() => face.evaluate(element => {
    const visual = element.getBoundingClientRect()
    const target = element.closest("button")!.getBoundingClientRect()
    return [visual.left - target.left, target.right - visual.right, visual.top - target.top, target.bottom - visual.bottom]
  })).toEqual([8, 8, 8, 8])
}

async function expectInboxHeaderHover(page: Page, action: Locator) {
  const header = page.locator('[data-slot="inbox-card-header"]').filter({ has: action })
  const colors = await header.evaluate((element) => {
    const probe = document.createElement("span")
    element.appendChild(probe)
    probe.style.backgroundColor = "var(--card)"
    const idle = getComputedStyle(probe).backgroundColor
    probe.style.backgroundColor = "var(--accent)"
    const hovered = getComputedStyle(probe).backgroundColor
    probe.remove()
    return { idle, hovered }
  })
  expect(colors.hovered).not.toBe(colors.idle)
  const expectTint = (opacity: string) => expect.poll(() => header.evaluate((element) => {
    const tint = getComputedStyle(element, "::before")
    return {
      base: getComputedStyle(element).backgroundColor,
      tint: tint.backgroundColor,
      opacity: tint.opacity,
    }
  })).toEqual({ base: colors.idle, tint: colors.hovered, opacity })
  await page.mouse.move(0, 0)
  await expectTint("0")
  await header.hover({ position: { x: 3, y: 4 } })
  await expectTint("1")
  await header.locator("button").first().hover()
  await expectTint("1")
  await action.hover()
  await expectTint("1")
}

async function acceptWhilePending(page: Page, control: Locator, friendshipId: string) {
  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  const pattern = `**/api/community/friends/${friendshipId}/accept`
  await page.route(pattern, async (route) => { await hold; await route.continue() })
  try {
    await control.click()
    await expect(control).toBeDisabled()
    await expect(control.locator("svg.animate-spin")).toBeVisible()
    const busy = await iconTone(control, "--status-online")
    expect(busy.actual).not.toBe(busy.expected)
    release()
    await expect(control).toBeHidden()
  } finally {
    release()
    await page.unroute(pattern)
  }
}

test("App friend acceptance keeps its semantic icon through both surfaces and pending state", async ({ caseActors }) => {
  test.setTimeout(180_000)
  const actors = await caseActors(["alice", "bob", "carol"])
  for (const colorScheme of ["light", "dark"] as const) {
    const bobRequest = await actors.seed.seedPendingFriendRequest("bob", "alice", actors.userId("alice"))
    const carolRequest = await actors.seed.seedPendingFriendRequest("carol", "alice", actors.userId("alice"))
    const { page, context } = await actors.asUser("alice", { colorScheme, viewport: { width: 1280, height: 900 } })
    await gotoAfterUserWsAuth(page, "/c/me/friends")
    await page.getByRole("tab", { name: /^New/ }).click()
    const accept = page.getByRole("button", { name: `Accept ${actors.userName("bob")}'s friend request`, exact: true })
    await expectIconTone(accept, "--status-online")
    await acceptWhilePending(page, accept, bobRequest)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId(tid.inboxTrigger).click()
    const inboxAccept = page.getByTestId(tid.inboxFriendRequestAccept(carolRequest))
    const inboxReject = page.getByTestId(tid.inboxFriendRequestReject(carolRequest))
    for (const action of [inboxAccept, inboxReject]) await expectCompactMobileInboxAction(action)
    await expectIconTone(inboxAccept, "--status-online")
    await expectIconTone(inboxReject, "--destructive")
    await acceptWhilePending(page, inboxAccept, carolRequest)
    const response = await page.request.get("/api/community/friends/accepted", { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS })
    expect(response.ok()).toBe(true)
    const body = await response.json() as { friends: Array<{ userId: string }> }
    expect(body.friends.map((friend) => friend.userId)).toEqual(expect.arrayContaining([actors.userId("bob"), actors.userId("carol")]))
    await context.close()
  }
})

test("App reaction and matching Inbox header controls retain their colors and actions", async ({ caseActors }) => {
  test.setTimeout(180_000)
  const actors = await caseActors(["alice", "bob"])
  const serverId = await actors.seed.seedServer("alice", `Semantic controls ${Date.now()}`)
  const reactionChannel = await actors.seed.seedChannel("alice", serverId, "reactions")
  const mentionChannel = await actors.seed.seedChannel("alice", serverId, "mentions")
  await actors.seed.seedJoinServer("alice", "bob", serverId)
  const bob = await actors.seed.memberInfo("alice", serverId, actors.userId("bob"))
  for (const colorScheme of ["light", "dark"] as const) {
    const messageId = await actors.seed.seedMessage("alice", reactionChannel, `Reaction ${colorScheme}`)
    await actors.seed.seedReaction("alice", messageId, "👍")
    await actors.seed.seedMark("bob", reactionChannel, messageId)
    await actors.seed.seedMessage("alice", mentionChannel, `@${bob.name}#${bob.discriminator} Supporting action ${colorScheme}`)
    const { page, context } = await actors.asUser("bob", { colorScheme, viewport: { width: 1280, height: 900 } })
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${reactionChannel}`)
    const reaction = page.getByTestId(tid.message(messageId)).locator('button[data-variant="secondary"][aria-label="Add reaction"]')
    await expect(reaction).toBeVisible()
    await page.mouse.move(0, 0)
    await expectIconTone(reaction, "--muted-foreground")
    // The existing desktop message shell activates its overlays on body entry.
    await page.getByTestId(tid.message(messageId)).getByText(`Reaction ${colorScheme}`, { exact: true }).hover()
    await reaction.hover()
    await expectIconTone(reaction, "--foreground")
    await expect(reaction).toHaveAttribute("aria-haspopup", "dialog")
    await reaction.click()
    await expect(reaction).toHaveAttribute("aria-expanded", "true")
    await page.mouse.move(0, 0)
    await expectIconTone(reaction, "--foreground")
    await page.keyboard.press("Escape")
    await expect(reaction).toHaveAttribute("aria-expanded", "false")
    const narrow = colorScheme === "dark"
    if (narrow) {
      await page.setViewportSize({ width: 390, height: 844 })
      await gotoAfterUserWsAuth(page, "/c/me/friends")
    }
    await page.getByTestId(tid.inboxTrigger).click()
    await expect(page.getByRole("tab", { name: /^Mentions/ })).toHaveCount(0)
    const markRead = page.getByTestId(tid.inboxMarkChannelRead(mentionChannel))
    const arrow = page.getByTestId(tid.inboxToggleChannel(mentionChannel))
    await expect(markRead).toHaveAttribute("data-variant", "ghost")
    await expect(arrow).toHaveAttribute("data-variant", "ghost")
    if (narrow) {
      await expectCompactMobileInboxAction(markRead)
      await expectCompactMobileInboxAction(arrow)
    }
    const markPaint = narrow ? inboxActionFace(markRead) : markRead
    const arrowPaint = narrow ? inboxActionFace(arrow) : arrow
    await page.mouse.move(0, 0)
    await expectIconTone(markRead, "--muted-foreground")
    const readBackground = await markPaint.evaluate(element => getComputedStyle(element).backgroundColor)
    expect(readBackground).not.toBe("rgba(0, 0, 0, 0)")
    await expect(arrowPaint).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await expectInboxHeaderHover(page, markRead)
    await expect(markPaint).toHaveCSS("background-color", readBackground)
    await arrow.hover()
    await expect(arrowPaint).toHaveCSS("background-color", readBackground)
    await expect(markRead).toHaveCSS("width", narrow ? "44px" : "32px")
    await expect(arrow).toHaveCSS("width", narrow ? "44px" : "32px")
    await expect.poll(() => arrow.evaluate((element) => {
      const read = element.previousElementSibling!
      const arrowButton = element.getBoundingClientRect()
      const readButton = read.getBoundingClientRect()
      const arrowIcon = element.querySelector("svg")!.getBoundingClientRect()
      const readIcon = read.querySelector("svg")!.getBoundingClientRect()
      return {
        buttonGap: arrowButton.left - readButton.right,
        iconGap: arrowIcon.left - readIcon.right,
        arrowInset: arrowButton.right - arrowIcon.right,
        readInset: readButton.right - readIcon.right,
      }
    })).toEqual(narrow
      ? { buttonGap: 0, iconGap: 28, arrowInset: 14, readInset: 14 }
      : { buttonGap: 0, iconGap: 16, arrowInset: 8, readInset: 8 })

    const readPath = `/api/community/channels/${mentionChannel}/read`
    let readRequests = 0
    page.on("request", request => {
      if (request.method() === "PUT" && new URL(request.url()).pathname === readPath) readRequests += 1
    })
    await markRead.focus()
    await page.keyboard.press("Tab")
    await expect(arrow).toBeFocused()
    await expect.poll(() => arrow.evaluate(element => element.matches(":focus-visible"))).toBe(true)
    await arrow.press("Enter")
    await expect(arrow).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByTestId(tid.inboxUnreadMessages(mentionChannel))).toContainText(`Supporting action ${colorScheme}`)
    await page.mouse.move(0, 0)
    await expect(arrowPaint).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await arrow.hover()
    await expect(arrowPaint).toHaveCSS("background-color", readBackground)
    await arrow.press("Space")
    await expect(arrow).toHaveAttribute("aria-expanded", "false")
    expect(readRequests).toBe(0)
    const dismissed = page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === readPath)
    if (colorScheme === "light") await markRead.click()
    else {
      await page.keyboard.press("Shift+Tab")
      await expect(markRead).toBeFocused()
      await markRead.press("Enter")
    }
    expect((await dismissed).ok()).toBe(true)
    await expect(markRead).toHaveCount(0)
    expect(readRequests).toBe(1)
    await page.getByRole("tab", { name: "Marked", exact: true }).click()
    await expectInboxHeaderHover(page, page.getByTestId(tid.inboxUnmark(messageId)))
    await context.close()
  }
})
