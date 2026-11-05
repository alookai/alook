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
    await page.getByTestId(tid.inboxTrigger).click()
    const inboxAccept = page.getByTestId(tid.inboxFriendRequestAccept(carolRequest))
    await expectIconTone(inboxAccept, "--status-online")
    await acceptWhilePending(page, inboxAccept, carolRequest)
    const response = await page.request.get("/api/community/friends/accepted", { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS })
    expect(response.ok()).toBe(true)
    const body = await response.json() as { friends: Array<{ userId: string }> }
    expect(body.friends.map((friend) => friend.userId)).toEqual(expect.arrayContaining([actors.userId("bob"), actors.userId("carol")]))
    await context.close()
  }
})

test("App secondary reaction and mention actions retain supporting colors and their actions", async ({ caseActors }) => {
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
    await page.getByTestId(tid.inboxTrigger).click()
    await page.getByRole("tab", { name: /^Mentions/ }).click()
    const markRead = page.getByRole("button", { name: "Mark mention as read", exact: true })
    await expectIconTone(markRead, "--muted-foreground")
    const dismissed = page.waitForResponse((response) =>
      response.request().method() === "DELETE"
      && new URL(response.url()).pathname.startsWith("/api/community/users/me/inbox/mentions/"))
    await markRead.click()
    expect((await dismissed).ok()).toBe(true)
    await expect(markRead).toHaveCount(0)
    await context.close()
  }
})
