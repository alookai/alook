import type { Locator, Page } from "@playwright/test"
import { expect, test } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"

import type { CaseActors, CaseResources } from "./_fixtures/case-fixture"

function deferred(caseResources: CaseResources) {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  caseResources.own(resolve, async (captured) => { captured() })
  return { promise, resolve }
}

async function expectTitleClearOfClose(dialog: Locator, width: 390 | 1280) {
  const title = await dialog.getByRole("heading", { level: 2 }).boundingBox()
  const close = await dialog.getByRole("button", { name: "Close" }).boundingBox()
  expect(title, `title rect at ${width}px`).not.toBeNull()
  expect(close, `Close rect at ${width}px`).not.toBeNull()
  expect(title!.x + title!.width, `title must end before Close at ${width}px`)
    .toBeLessThanOrEqual(close!.x)
}

async function openDesktopThreadMemberList(page: Page) {
  const shell = page.getByTestId(tid.threadSplit)
  const threadPanel = page.getByTestId(tid.threadSplitPanel)
  await expect(shell).toHaveAttribute("data-layout", "split", { timeout: 20_000 })
  await threadPanel.getByTestId(tid.threadSplitFullscreen).click()
  await expect(shell).toHaveAttribute("data-layout", "full")
  await threadPanel.getByRole("button", { name: "Member list" }).click()
}

test.describe("invite and participant picker async states", () => {
test.setTimeout(180_000)

  async function prepareCase1(actors: CaseActors) {
    const { userId, userName } = actors
    const { memberInfo, renameUser, seedChannel, seedForumThread, seedFriendship, seedJoinServer, seedMessage, seedServer } = actors.seed
    actors.onCleanup(async () => {
      const restorations = await Promise.allSettled([
        renameUser("bob", userName("bob")),
        renameUser("carol", userName("carol")),
      ])
      expect(restorations.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])
    })
    const userStamp = Date.now().toString().slice(-6)
    await renameUser("bob", `PickerBob${userStamp}`)
    await renameUser("carol", `PickerCarol${userStamp}`)
    const inviteServerId: string = await seedServer("alice", `Invite ${Date.now()} ${"unbroken-title-".repeat(5)}`)
    await seedFriendship("alice", "bob", userId("bob"))
    await seedFriendship("alice", "carol", userId("carol"))
    const participantServerId: string = await seedServer("alice", `Participants ${Date.now()}`)
    await seedJoinServer("alice", "bob", participantServerId)
    await seedJoinServer("alice", "carol", participantServerId)
    const parentChannelId: string = await seedChannel("alice", participantServerId, "picker-parent", "forum")
    const failureThreadId: string = await seedForumThread("alice", parentChannelId, `Failure ${"unbroken-thread-title-".repeat(4)}`, "failure state")
    const parentFailureThreadId: string = await seedForumThread("alice", parentChannelId, `Parent failure ${"unbroken-thread-title-".repeat(4)}`, "parent failure state")
    const emptyThreadId: string = await seedForumThread("alice", parentChannelId, `Empty ${Date.now()}`, "resolved empty state")
    const mutationThreadId: string = await seedForumThread("alice", parentChannelId, `Mutation ${"unbroken-thread-title-".repeat(4)}`, "mutation state")
    await seedMessage("bob", failureThreadId, "existing participant")
    await seedMessage("bob", emptyThreadId, "existing participant bob")
    await seedMessage("carol", emptyThreadId, "existing participant carol")
    const bobName: string = (await memberInfo("alice", participantServerId, userId("bob"))).name
    const carolName: string = (await memberInfo("alice", participantServerId, userId("carol"))).name
    return { inviteServerId, participantServerId, parentChannelId, failureThreadId, parentFailureThreadId, emptyThreadId, mutationThreadId, bobName, carolName }
  }

  test("Invite friends keeps cold data provisional, search local, row pending, and title clear", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { inviteServerId, bobName, carolName } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 844 })

    const acceptedGate = deferred(caseResources)
    let acceptedGets = 0
    let memberGets = 0
    await page.route("**/api/community/friends/accepted", async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      acceptedGets += 1
      await acceptedGate.promise
      await route.continue()
    })
    await page.route(`**/api/community/servers/${inviteServerId}/members?**`, async (route) => {
      if (route.request().method() === "GET") memberGets += 1
      await route.continue()
    })

    await page.goto(`/c/channels/${inviteServerId}`)
    await expect(page.getByRole("button", { name: "Invite to server" })).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => acceptedGets).toBe(1)
    await page.getByRole("button", { name: "Invite to server" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.locator('[data-slot="invite-friends-loading"]')).toBeVisible()
    await expect(dialog.getByText(/No friends to invite|No matches/)).toHaveCount(0)
    const copy = dialog.getByRole("button", { name: "Copy", exact: true })
    await expect(copy).toBeEnabled({ timeout: 20_000 })
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    await page.evaluate(() => navigator.clipboard.writeText("invite-copy-not-yet"))
    const inviteUrl = await dialog.locator("input[readonly]").inputValue()
    await copy.hover()
    const copyBeforeLoad = await copy.boundingBox()
    expect(copyBeforeLoad).not.toBeNull()
    await page.mouse.move(
      copyBeforeLoad!.x + copyBeforeLoad!.width / 2,
      copyBeforeLoad!.y + copyBeforeLoad!.height / 2,
    )
    await page.mouse.down()
    acceptedGate.resolve()
    await expect(dialog.getByRole("button", { name: "Invite" }).first()).toBeVisible({ timeout: 20_000 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(inviteUrl)
    await expect.poll(async () => (await copy.boundingBox())!.y).toBe(copyBeforeLoad!.y)
    await expectTitleClearOfClose(dialog, 1280)

    const beforeSearch = { acceptedGets, memberGets }
    await dialog.getByPlaceholder("Search for friends").fill("no-user-matches-this-query")
    await expect(dialog.getByText("No matches.", { exact: true })).toBeVisible()
    expect((await copy.boundingBox())!.y).toBe(copyBeforeLoad!.y)
    expect({ acceptedGets, memberGets }).toEqual(beforeSearch)
    await dialog.getByPlaceholder("Search for friends").fill("")
    await expect(dialog.getByRole("button", { name: "Invite" }).first()).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Copy" })).toBeEnabled({ timeout: 20_000 })

    const dmGate = deferred(caseResources)
    const writes: string[] = []
    page.on("request", (request) => {
      if (request.method() === "POST") writes.push(new URL(request.url()).pathname)
    })
    await page.route("**/api/community/channels", async (route) => {
      if (route.request().method() !== "POST") return route.continue()
      await dmGate.promise
      await route.continue()
    })
    const selectedRow = dialog.getByText(bobName, { exact: true }).locator("..").locator("..")
    const otherRow = dialog.getByText(carolName, { exact: true }).locator("..").locator("..")
    await expect(selectedRow.getByRole("button", { name: "Invite" })).toHaveCount(1)
    await expect(otherRow.getByRole("button", { name: "Invite" })).toHaveCount(1)
    await selectedRow.getByRole("button", { name: "Invite" }).click()
    await expect.poll(() => writes.filter((path) => path === "/api/community/channels").length).toBe(1)
    await expect(selectedRow.locator("button")).toBeDisabled()
    await expect(selectedRow.locator("svg.animate-spin")).toBeVisible()
    await expect(otherRow.getByRole("button", { name: "Invite" })).toBeEnabled()
    dmGate.resolve()
    await expect(selectedRow.getByRole("button", { name: "Invited" })).toBeVisible({ timeout: 20_000 })
    expect(writes.filter((path) => path === "/api/community/channels")).toHaveLength(1)
    expect(writes.filter((path) => /\/api\/community\/channels\/[^/]+\/messages$/.test(path))).toHaveLength(1)
  })

  test("Invite friends exposes one recoverable first-load error chain before resolved empty", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { inviteServerId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })

    let fail = true
    let acceptedGets = 0
    await page.route("**/api/community/friends/accepted", async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      acceptedGets += 1
      if (fail) {
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"failed"}' })
        return
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"friends":[]}' })
    })

    await page.goto(`/c/channels/${inviteServerId}`)
    await expect(page.getByRole("button", { name: "Invite to server" })).toBeVisible({ timeout: 20_000 })
    await page.getByRole("button", { name: "Invite to server" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Couldn't load friends.", { exact: true })).toBeVisible({ timeout: 20_000 })
    const copyBeforeRetry = await dialog.getByRole("button", { name: "Copy", exact: true }).boundingBox()
    const failedChainGets = acceptedGets
    expect(failedChainGets).toBeGreaterThanOrEqual(2)
    fail = false
    await dialog.getByRole("button", { name: "Retry" }).click()
    await expect(dialog.getByText("No friends to invite — everyone you know is already here.", { exact: true }))
      .toBeVisible({ timeout: 20_000 })
    expect(acceptedGets).toBeGreaterThan(failedChainGets)
    expect(await dialog.getByRole("button", { name: "Copy", exact: true }).boundingBox()).toEqual(copyBeforeRetry)
    await expectTitleClearOfClose(dialog, 390)
  })

  test("Add participants composes both sources and recovers without re-offering a participant", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { participantServerId, parentChannelId, failureThreadId, bobName, carolName } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 844 })
    let failParticipants = true
    let participantGets = 0
    let parentGets = 0
    await page.route((url) => url.pathname === `/api/community/channels/${failureThreadId}/members` && url.searchParams.get("relation") === "notify", async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      participantGets += 1
      if (failParticipants) {
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"failed"}' })
        return
      }
      await route.continue()
    })
    await page.route((url) => url.pathname === `/api/community/channels/${parentChannelId}/members` && url.searchParams.get("relation") === "access", async (route) => {
      if (route.request().method() === "GET") parentGets += 1
      await route.continue()
    })

    await page.goto(`/c/channels/${participantServerId}/${failureThreadId}`)
    await openDesktopThreadMemberList(page)
    await expect(page.getByRole("button", { name: "Add members" })).toBeVisible({ timeout: 20_000 })
    await page.getByRole("button", { name: "Add members" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Couldn't load people.", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByText(bobName, { exact: true })).toHaveCount(0)
    await expectTitleClearOfClose(dialog, 1280)

    const failedParticipantGets = participantGets
    const resolvedParentGets = parentGets
    expect(failedParticipantGets).toBeGreaterThanOrEqual(2)
    failParticipants = false
    await dialog.getByRole("button", { name: "Retry" }).click()
    await expect(dialog.getByText(carolName, { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByText(bobName, { exact: true })).toHaveCount(0)
    expect(participantGets).toBeGreaterThan(failedParticipantGets)
    expect(parentGets).toBe(resolvedParentGets)

    const beforeSearch = { participantGets, parentGets }
    await dialog.getByPlaceholder("Search members").fill("no-participant-matches-this")
    await expect(dialog.getByText("No matches.", { exact: true })).toBeVisible()
    expect({ participantGets, parentGets }).toEqual(beforeSearch)
  })

  test("Add participants keeps a slow first load provisional before resolved empty", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { participantServerId, parentChannelId, emptyThreadId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 844 })
    const parentGate = deferred(caseResources)
    let parentGets = 0
    await page.route((url) => url.pathname === `/api/community/channels/${parentChannelId}/members` && url.searchParams.get("relation") === "access", async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      parentGets += 1
      await parentGate.promise
      await route.continue()
    })

    await page.goto(`/c/channels/${participantServerId}/${emptyThreadId}`)
    await openDesktopThreadMemberList(page)
    await page.getByRole("button", { name: "Add members" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.locator('[data-slot="people-picker-loading"]')).toBeVisible()
    await expect(dialog.getByText(/Everyone is already here|No matches/)).toHaveCount(0)
    expect(parentGets).toBeGreaterThanOrEqual(1)

    parentGate.resolve()
    await expect(dialog.getByText("Everyone is already here.", { exact: true }))
      .toBeVisible({ timeout: 20_000 })
  })

  test("Add participants retries an unresolved parent without refetching participants", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { participantServerId, parentChannelId, parentFailureThreadId, bobName, carolName } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 844 })
    let failParent = true
    let participantGets = 0
    let parentGets = 0
    await page.route((url) => url.pathname === `/api/community/channels/${parentFailureThreadId}/members` && url.searchParams.get("relation") === "notify", async (route) => {
      if (route.request().method() === "GET") participantGets += 1
      await route.continue()
    })
    await page.route((url) => url.pathname === `/api/community/channels/${parentChannelId}/members` && url.searchParams.get("relation") === "access", async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      parentGets += 1
      if (failParent) {
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"failed"}' })
        return
      }
      await route.continue()
    })

    await page.goto(`/c/channels/${participantServerId}/${parentFailureThreadId}`)
    await openDesktopThreadMemberList(page)
    await page.getByRole("button", { name: "Add members" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Couldn't load people.", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByText(bobName, { exact: true })).toHaveCount(0)
    await expect(dialog.getByText(carolName, { exact: true })).toHaveCount(0)

    const resolvedParticipantGets = participantGets
    const failedParentGets = parentGets
    expect(resolvedParticipantGets).toBeGreaterThanOrEqual(1)
    expect(failedParentGets).toBeGreaterThanOrEqual(2)
    failParent = false
    await dialog.getByRole("button", { name: "Retry" }).click()
    await expect(dialog.getByText(bobName, { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByText(carolName, { exact: true })).toBeVisible()
    expect(participantGets).toBe(resolvedParticipantGets)
    expect(parentGets).toBeGreaterThan(failedParentGets)
  })

  test("Add participants keeps mutation pending local to one row", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { participantServerId, mutationThreadId, bobName, carolName } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/c/channels/${participantServerId}/${mutationThreadId}`)
    const threadPanel = page.getByTestId(tid.threadSplitPanel)
    await expect(threadPanel.getByRole("button", { name: /member/i }).first()).toBeVisible({ timeout: 20_000 })
    await threadPanel.getByRole("button", { name: /member/i }).first().click()
    await page.getByRole("button", { name: "Add members" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText(bobName, { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByText(carolName, { exact: true })).toBeVisible()
    await expectTitleClearOfClose(dialog, 390)

    const mutationGate = deferred(caseResources)
    let participantPosts = 0
    await page.route(`**/api/community/channels/${mutationThreadId}/participants`, async (route) => {
      if (route.request().method() !== "POST") return route.continue()
      participantPosts += 1
      await mutationGate.promise
      await route.continue()
    })
    const bobRow = dialog.getByText(bobName, { exact: true }).locator("..")
    const carolRow = dialog.getByText(carolName, { exact: true }).locator("..")
    await bobRow.getByRole("button", { name: "Add" }).click()
    await expect.poll(() => participantPosts).toBe(1)
    await expect(bobRow.locator("button")).toBeDisabled()
    await expect(bobRow.locator("svg.animate-spin")).toBeVisible()
    await expect(carolRow.getByRole("button", { name: "Add" })).toBeEnabled()
    mutationGate.resolve()
    await expect(dialog.getByText(bobName, { exact: true })).toHaveCount(0, { timeout: 20_000 })
    expect(participantPosts).toBe(1)
  })
})
