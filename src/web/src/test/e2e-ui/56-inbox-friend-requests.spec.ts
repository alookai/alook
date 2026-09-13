import type { Locator, Page } from "@playwright/test"
import { expect, test, userId, userName } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import {
  seedCancelFriendRequest,
  seedChannel,
  seedDm,
  seedDmMessage,
  seedJoinServer,
  seedMessage,
  seedPendingFriendRequest,
  seedServer,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

async function expectInboxDot(page: Page) {
  await expect(page.getByTestId(tid.inboxTrigger).locator("span.bg-primary")).toHaveCount(1)
}

async function expectNoInboxDot(page: Page) {
  await expect(page.getByTestId(tid.inboxTrigger).locator("span.bg-primary")).toHaveCount(0)
}

async function clearMessageInbox(page: Page) {
  for (const path of [
    "/api/community/users/me/inbox/mentions/read-all",
    "/api/community/users/me/inbox/unreads/read-all",
    "/api/community/users/me/inbox/dms/read-all",
  ]) {
    expect((await page.request.post(path)).ok()).toBe(true)
  }
}

async function clientRect(locator: Locator) {
  return locator.evaluate((element) => {
    const { width, height } = element.getBoundingClientRect()
    return { width, height }
  })
}

async function siblingActionStructure(
  navigation: Locator,
  acceptName: string,
  rejectName: string,
) {
  return navigation.evaluate((node, names) => {
    const layout = node.parentElement
    const row = layout?.parentElement
    const buttons = Array.from(row?.querySelectorAll("button") ?? [])
    const accept = buttons.find((button) => button.getAttribute("aria-label") === names.acceptName)
    const reject = buttons.find((button) => button.getAttribute("aria-label") === names.rejectName)
    return {
      actionsAreSiblings: accept?.parentElement?.parentElement === layout
        && reject?.parentElement?.parentElement === layout,
      navigationContainsAction: Boolean(accept && node.contains(accept))
        || Boolean(reject && node.contains(reject)),
      nestedInteractiveCount: row?.querySelectorAll("button button").length ?? -1,
    }
  }, { acceptName, rejectName })
}

function expectMinimumRect(
  label: string,
  rect: { width: number; height: number },
  minimum: number,
) {
  expect.soft(rect.width, `${label} width`).toBeGreaterThanOrEqual(minimum)
  expect.soft(rect.height, `${label} height`).toBeGreaterThanOrEqual(minimum)
}

async function expectExactRect(
  label: string,
  locator: Locator,
  size: number,
) {
  await expect.poll(
    () => clientRect(locator),
    { message: `${label} stable rect` },
  ).toEqual({ width: size, height: size })
}

test.describe.serial("actionable Inbox friend requests", () => {
  test.setTimeout(120_000)

  test("fans out live, survives opening, and owns the Friends New URL", async ({ asUser }) => {
    const bob = await asUser("bob")
    await bob.page.setViewportSize({ width: 1280, height: 900 })
    await clearMessageInbox(bob.page)
    await gotoAfterUserWsAuth(bob.page, "/c/me/friends")

    const friendshipId = await seedPendingFriendRequest("alice", "bob", userId("bob"))
    try {
      await expect(bob.page.getByTestId(tid.friendsShortcutBadge)).toHaveText("1")
      await expect(bob.page.getByTestId(tid.friendsNewBadge)).toHaveText("1")
      await expectInboxDot(bob.page)

      const trigger = bob.page.getByTestId(tid.inboxTrigger)
      await trigger.click()
      const row = bob.page.getByTestId(tid.inboxFriendRequest(friendshipId))
      await expect(row).toBeVisible()
      await expect(bob.page.getByText("Friend requests — 1", { exact: true })).toBeVisible()
      await expect(bob.page.getByText("Caught up", { exact: true })).toHaveCount(0)
      await expect(bob.page.getByRole("button", { name: "Mark all read" })).toBeDisabled()

      await trigger.click()
      await expectInboxDot(bob.page)
      await trigger.click()
      await expect(row).toBeVisible()

      const open = bob.page.getByTestId(tid.inboxFriendRequestOpen(friendshipId))
      const accept = bob.page.getByTestId(tid.inboxFriendRequestAccept(friendshipId))
      const reject = bob.page.getByTestId(tid.inboxFriendRequestReject(friendshipId))
      expect(await open.evaluate((node, actionIds) => (
        actionIds.every((id) => !node.contains(document.querySelector(`[data-testid='${id}']`)))
      ), [tid.inboxFriendRequestAccept(friendshipId), tid.inboxFriendRequestReject(friendshipId)])).toBe(true)
      await expect(accept).toHaveAccessibleName(/Accept .+ friend request/)
      await expect(reject).toHaveAccessibleName(/Reject .+ friend request/)

      await open.click()
      await expect(bob.page).toHaveURL(/\/c\/me\/friends\?tab=new$/)
      await expect(bob.page.getByRole("tab", { name: /New/ })).toHaveAttribute("aria-selected", "true")
    } finally {
      await seedCancelFriendRequest("alice", friendshipId)
    }
  })

  test("keeps requests above DM/server unread and Mark all is message-only", async ({ asUser }) => {
    const stamp = Date.now()
    const serverName = `Friend request mix ${stamp}`
    const serverId = await seedServer("alice", serverName)
    const channelId = await seedChannel("alice", serverId, `friend-mix-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const dmId = await seedDm("alice", userId("bob"))

    const bob = await asUser("bob")
    await clearMessageInbox(bob.page)
    await gotoAfterUserWsAuth(bob.page, "/c/me/friends")
    const friendshipId = await seedPendingFriendRequest("carol", "bob", userId("bob"))
    try {
      await seedMessage("alice", channelId, `Friend request channel unread ${stamp}`)
      await seedDmMessage("alice", dmId, `Friend request DM unread ${stamp}`)

      await expectInboxDot(bob.page)
      await bob.page.getByTestId(tid.inboxTrigger).click()
      const requestRow = bob.page.getByTestId(tid.inboxFriendRequest(friendshipId))
      const dmRow = bob.page.getByTestId(tid.inboxUnreadDm(dmId))
      const serverRow = bob.page.getByTestId(tid.inboxUnreadChannel(channelId))
      await expect(requestRow).toBeVisible()
      await expect(dmRow).toBeVisible()
      await expect(serverRow).toBeVisible()

      const [requestBox, dmBox, serverBox] = await Promise.all([
        requestRow.boundingBox(),
        dmRow.boundingBox(),
        serverRow.boundingBox(),
      ])
      expect(requestBox).not.toBeNull()
      expect(dmBox).not.toBeNull()
      expect(serverBox).not.toBeNull()
      expect(requestBox!.y).toBeLessThan(dmBox!.y)
      expect(dmBox!.y).toBeLessThan(serverBox!.y)

      await bob.page.getByRole("button", { name: "Mark all read" }).click()
      await expect(requestRow).toBeVisible()
      await expect(dmRow).toHaveCount(0)
      await expect(serverRow).toHaveCount(0)
      await expect(bob.page.getByRole("button", { name: "Mark all read" })).toBeDisabled()
      await expectInboxDot(bob.page)
    } finally {
      await seedCancelFriendRequest("carol", friendshipId)
    }
  })

  test("a failed action keeps its keyed row while another request remains usable", async ({ asUser }) => {
    const firstId = await seedPendingFriendRequest("alice", "bob", userId("bob"))
    const secondId = await seedPendingFriendRequest("carol", "bob", userId("bob"))
    const bob = await asUser("bob")
    let releaseFailure!: () => void
    let markFirstAttempt!: () => void
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve })
    const firstAttempt = new Promise<void>((resolve) => { markFirstAttempt = resolve })
    let attempts = 0
    await bob.page.route(`**/api/community/friends/${firstId}/accept`, async (route) => {
      attempts += 1
      if (attempts === 1) {
        markFirstAttempt()
        await failureGate
        await route.fulfill({ status: 503, json: { error: "forced retry" } })
        return
      }
      await route.continue()
    })

    try {
      await clearMessageInbox(bob.page)
      await gotoAfterUserWsAuth(bob.page, "/c/me/friends")
      await expect(bob.page.getByTestId(tid.friendsShortcutBadge)).toHaveText("2")
      await expect(bob.page.getByTestId(tid.friendsNewBadge)).toHaveText("2")
      await bob.page.getByTestId(tid.inboxTrigger).click()

      const firstRow = bob.page.getByTestId(tid.inboxFriendRequest(firstId))
      const secondRow = bob.page.getByTestId(tid.inboxFriendRequest(secondId))
      const firstAccept = bob.page.getByTestId(tid.inboxFriendRequestAccept(firstId))
      const secondReject = bob.page.getByTestId(tid.inboxFriendRequestReject(secondId))
      await firstAccept.click()
      await firstAttempt
      await expect(firstRow).toHaveAttribute("aria-busy", "true")
      await expect(firstAccept).toBeDisabled()
      await expect(secondReject).toBeEnabled()
      await expect(bob.page).toHaveURL(/\/c\/me\/friends$/)

      releaseFailure()
      await expect(firstRow.getByRole("status")).toContainText("Couldn’t accept")
      await expect(firstRow.getByRole("button", { name: "Retry" })).toBeVisible()
      await expect(bob.page.getByText("Friend requests — 2", { exact: true })).toBeVisible()
      await expect(bob.page.getByTestId(tid.friendsShortcutBadge)).toHaveText("2")

      await firstRow.getByRole("button", { name: "Retry" }).click()
      await expect(firstRow).toHaveCount(0)
      await expect(bob.page.getByText("Friend requests — 1", { exact: true })).toBeVisible()
      await expect(bob.page.getByTestId(tid.friendsShortcutBadge)).toHaveText("1")
      await expect(bob.page.getByTestId(tid.friendsNewBadge)).toHaveText("1")

      await secondReject.focus()
      await expect(secondReject).toBeFocused()
      await secondReject.press("Enter")
      await expect(secondRow).toHaveCount(0)
      await expect(bob.page.getByTestId(tid.friendsShortcutBadge)).toHaveCount(0)
      await expect(bob.page.getByTestId(tid.friendsNewBadge)).toHaveCount(0)
      await expectNoInboxDot(bob.page)

      await bob.page.getByTestId(tid.inboxTrigger).click()
      await bob.page.getByRole("button", { name: "Friends", exact: true }).click()
      const accepted = await bob.page.request.get("/api/community/friends/accepted")
      expect(accepted.ok()).toBe(true)
      const acceptedBody = await accepted.json() as { friends: Array<{ userId: string; name: string }> }
      const alice = acceptedBody.friends.find((friend) => friend.userId === userId("alice"))
      expect(alice).toBeDefined()
      await expect(bob.page.getByText(alice!.name, { exact: true }).first()).toBeVisible()
    } finally {
      releaseFailure()
      await bob.page.unroute(`**/api/community/friends/${firstId}/accept`)
      await seedCancelFriendRequest("alice", firstId)
      await seedCancelFriendRequest("carol", secondId)
    }
  })

  test("reconnect reconciles a request cancelled while its event was missed", async ({ asUser }) => {
    const bob = await asUser("bob")
    await gotoAfterUserWsAuth(bob.page, "/c/me/friends")
    const friendshipId = await seedPendingFriendRequest("dave", "bob", userId("bob"))
    const row = bob.page.getByTestId(tid.inboxFriendRequest(friendshipId))

    try {
      await bob.page.getByTestId(tid.inboxTrigger).click()
      await expect(row).toBeVisible()
      await bob.context.setOffline(true)
      await seedCancelFriendRequest("dave", friendshipId)
      await expect(row).toBeVisible()
      await bob.context.setOffline(false)
      await expect(row).toHaveCount(0, { timeout: 30_000 })
    } finally {
      await bob.context.setOffline(false)
      await seedCancelFriendRequest("dave", friendshipId)
    }
  })

  test("mobile actions keep 44px targets, readable labels, focus, and row-local busy state", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Friend request mobile ${stamp}`)
    await seedChannel("alice", serverId, `friend-mobile-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const bob = await asUser("bob")
    await bob.page.setViewportSize({ width: 390, height: 844 })
    await clearMessageInbox(bob.page)
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}`)
    const inboxTrigger = bob.page.getByTestId(tid.inboxTrigger)
    await expect(inboxTrigger).toBeVisible()
    const startingUrl = bob.page.url()
    const friendshipId = await seedPendingFriendRequest("alice", "bob", userId("bob"))

    try {
      await inboxTrigger.click()
      const inboxSurface = bob.page.getByTestId(tid.userBarExtension)
      await expect(inboxSurface).toBeVisible()
      await expect(inboxSurface).toHaveAttribute("data-extension", "inbox")
      const row = bob.page.getByTestId(tid.inboxFriendRequest(friendshipId))
      const accept = bob.page.getByTestId(tid.inboxFriendRequestAccept(friendshipId))
      const reject = bob.page.getByTestId(tid.inboxFriendRequestReject(friendshipId))
      await expect(accept).toHaveAccessibleName(/Accept .+ friend request/)
      await expect(reject).toHaveAccessibleName(/Reject .+ friend request/)
      await inboxSurface.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished))
      })
      for (const action of [accept, reject]) {
        const box = await action.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.width).toBeGreaterThanOrEqual(44)
        expect(box!.height).toBeGreaterThanOrEqual(44)
      }

      await reject.focus()
      await expect(reject).toBeFocused()
      const response = bob.page.waitForResponse((candidate) => (
        candidate.request().method() === "POST"
        && new URL(candidate.url()).pathname === `/api/community/friends/${friendshipId}/reject`
      ))
      await reject.press("Enter")
      expect((await response).status()).toBe(200)
      await expect(row).toHaveCount(0)
      expect(bob.page.url()).toBe(startingUrl)
    } finally {
      await seedCancelFriendRequest("alice", friendshipId)
    }
  })

  test("locks 390px navigation and retry targets plus 640px action geometry on both surfaces", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `Friend request geometry ${stamp}`)
    await seedChannel("alice", serverId, `friend-geometry-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const inboxRequestId = await seedPendingFriendRequest("alice", "bob", userId("bob"))
    const friendsRequestId = await seedPendingFriendRequest("carol", "bob", userId("bob"))
    const bob = await asUser("bob")
    const inboxAcceptPath = `/api/community/friends/${inboxRequestId}/accept`
    const friendsAcceptPath = `/api/community/friends/${friendsRequestId}/accept`
    await bob.page.route(`**${inboxAcceptPath}`, async (route) => {
      await route.fulfill({ status: 503, json: { error: "forced inbox geometry retry" } })
    })
    await bob.page.route(`**${friendsAcceptPath}`, async (route) => {
      await route.fulfill({ status: 503, json: { error: "forced friends geometry retry" } })
    })

    try {
      await bob.page.setViewportSize({ width: 390, height: 844 })
      await clearMessageInbox(bob.page)
      await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}`)

      const inboxTrigger = bob.page.getByTestId(tid.inboxTrigger)
      await inboxTrigger.click()
      const inboxRow = bob.page.getByTestId(tid.inboxFriendRequest(inboxRequestId))
      await expect(inboxRow).toBeVisible()
      const inboxNavigation = bob.page.getByTestId(tid.inboxFriendRequestOpen(inboxRequestId))
      const inboxAccept = bob.page.getByTestId(tid.inboxFriendRequestAccept(inboxRequestId))
      const inboxReject = bob.page.getByTestId(tid.inboxFriendRequestReject(inboxRequestId))
      const inboxAcceptName = `Accept ${userName("alice")}'s friend request`
      const inboxRejectName = `Reject ${userName("alice")}'s friend request`
      const inboxStructure = await siblingActionStructure(inboxNavigation, inboxAcceptName, inboxRejectName)
      expect.soft(inboxStructure.actionsAreSiblings, "Inbox navigation/action groups are siblings").toBe(true)
      expect.soft(inboxStructure.navigationContainsAction, "Inbox navigation has no nested action").toBe(false)
      expect.soft(inboxStructure.nestedInteractiveCount, "Inbox row has no nested interactive control").toBe(0)
      expectMinimumRect("390px Inbox navigation", await clientRect(inboxNavigation), 44)
      expectMinimumRect("390px Inbox Accept", await clientRect(inboxAccept), 44)
      expectMinimumRect("390px Inbox Reject", await clientRect(inboxReject), 44)

      await inboxAccept.click()
      const inboxRetry = inboxRow.getByRole("button", { name: "Retry" })
      await expect(inboxRetry).toBeVisible()
      expectMinimumRect("390px Inbox Retry", await clientRect(inboxRetry), 44)

      await inboxNavigation.click()
      await expect(bob.page).toHaveURL(/\/c\/me\/friends\?tab=new$/)
      const friendsName = userName("carol")
      const friendsNavigation = bob.page.getByRole("button", { name: friendsName, exact: true })
      const friendsRow = friendsNavigation.locator("..").locator("..")
      const friendsAcceptName = `Accept ${friendsName}'s friend request`
      const friendsRejectName = `Reject ${friendsName}'s friend request`
      const friendsAccept = friendsRow.getByRole("button", { name: friendsAcceptName })
      const friendsReject = friendsRow.getByRole("button", { name: friendsRejectName })
      await expect(friendsNavigation).toBeVisible()
      const friendsStructure = await siblingActionStructure(friendsNavigation, friendsAcceptName, friendsRejectName)
      expect.soft(friendsStructure.actionsAreSiblings, "Friends navigation/action groups are siblings").toBe(true)
      expect.soft(friendsStructure.navigationContainsAction, "Friends navigation has no nested action").toBe(false)
      expect.soft(friendsStructure.nestedInteractiveCount, "Friends row has no nested interactive control").toBe(0)
      expectMinimumRect("390px Friends profile navigation", await clientRect(friendsNavigation), 44)
      expectMinimumRect("390px Friends Accept", await clientRect(friendsAccept), 44)
      expectMinimumRect("390px Friends Reject", await clientRect(friendsReject), 44)

      await friendsAccept.click()
      const friendsRetry = friendsRow.getByRole("button", { name: "Retry" })
      await expect(friendsRetry).toBeVisible()
      expectMinimumRect("390px Friends Retry", await clientRect(friendsRetry), 44)

      await bob.page.setViewportSize({ width: 640, height: 900 })
      await bob.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      await expectExactRect("640px Friends Accept", friendsAccept, 32)
      await expectExactRect("640px Friends Reject", friendsReject, 32)

      await inboxTrigger.click()
      await expect(inboxRow).toBeVisible()
      await expectExactRect("640px Inbox Accept", inboxAccept, 32)
      await expectExactRect("640px Inbox Reject", inboxReject, 32)
    } finally {
      if (!bob.page.isClosed()) {
        await bob.page.unroute(`**${inboxAcceptPath}`)
        await bob.page.unroute(`**${friendsAcceptPath}`)
      }
      await seedCancelFriendRequest("alice", inboxRequestId)
      await seedCancelFriendRequest("carol", friendsRequestId)
    }
  })
})
