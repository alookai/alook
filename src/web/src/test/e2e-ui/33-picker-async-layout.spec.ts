import type { Locator } from "@playwright/test"
import { expect, test, userId } from "./_fixtures/community-fixture"
import {
  memberInfo,
  renameUser,
  seedChannel,
  seedForumThread,
  seedFriendship,
  seedJoinServer,
  seedMessage,
  seedServer,
} from "./_fixtures/seed"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
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

test.describe.serial("invite and participant picker async states", () => {
  test.setTimeout(180_000)

  let inviteServerId: string
  let participantServerId: string
  let parentChannelId: string
  let failureThreadId: string
  let parentFailureThreadId: string
  let emptyThreadId: string
  let mutationThreadId: string
  let bobName: string
  let carolName: string

  test.beforeAll(async () => {
    const userStamp = Date.now().toString().slice(-6)
    await renameUser("bob", `PickerBob${userStamp}`)
    await renameUser("carol", `PickerCarol${userStamp}`)
    inviteServerId = await seedServer(
      "alice",
      `Invite ${Date.now()} ${"unbroken-title-".repeat(5)}`,
    )
    await seedFriendship("alice", "bob", userId("bob"))
    await seedFriendship("alice", "carol", userId("carol"))

    participantServerId = await seedServer("alice", `Participants ${Date.now()}`)
    await seedJoinServer("alice", "bob", participantServerId)
    await seedJoinServer("alice", "carol", participantServerId)
    parentChannelId = await seedChannel("alice", participantServerId, "picker-parent", "forum")
    failureThreadId = await seedForumThread(
      "alice",
      parentChannelId,
      `Failure ${"unbroken-thread-title-".repeat(4)}`,
      "failure state",
    )
    parentFailureThreadId = await seedForumThread(
      "alice",
      parentChannelId,
      `Parent failure ${"unbroken-thread-title-".repeat(4)}`,
      "parent failure state",
    )
    emptyThreadId = await seedForumThread(
      "alice",
      parentChannelId,
      `Empty ${Date.now()}`,
      "resolved empty state",
    )
    mutationThreadId = await seedForumThread(
      "alice",
      parentChannelId,
      `Mutation ${"unbroken-thread-title-".repeat(4)}`,
      "mutation state",
    )
    await seedMessage("bob", failureThreadId, "existing participant")
    await seedMessage("bob", emptyThreadId, "existing participant bob")
    await seedMessage("carol", emptyThreadId, "existing participant carol")
    bobName = (await memberInfo("alice", participantServerId, userId("bob"))).name
    carolName = (await memberInfo("alice", participantServerId, userId("carol"))).name
  })

  test("Invite friends keeps cold data provisional, search local, row pending, and title clear", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 844 })
    await page.goto(`/c/channels/${inviteServerId}`)
    await expect(page.getByRole("button", { name: "Invite to server" })).toBeVisible({ timeout: 20_000 })

    const acceptedGate = deferred()
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

    await page.getByRole("button", { name: "Invite to server" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.locator('[data-slot="invite-friends-loading"]')).toBeVisible()
    await expect(dialog.getByText(/No friends to invite|No matches/)).toHaveCount(0)
    acceptedGate.resolve()
    await expect(dialog.getByRole("button", { name: "Invite" }).first()).toBeVisible({ timeout: 20_000 })
    await expectTitleClearOfClose(dialog, 1280)

    const beforeSearch = { acceptedGets, memberGets }
    await dialog.getByPlaceholder("Search for friends").fill("no-user-matches-this-query")
    await expect(dialog.getByText("No matches.", { exact: true })).toBeVisible()
    expect({ acceptedGets, memberGets }).toEqual(beforeSearch)
    await dialog.getByPlaceholder("Search for friends").fill("")
    await expect(dialog.getByRole("button", { name: "Invite" }).first()).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Copy" })).toBeEnabled({ timeout: 20_000 })

    const dmGate = deferred()
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

  test("Invite friends exposes one recoverable first-load error chain before resolved empty", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/c/channels/${inviteServerId}`)
    await expect(page.getByRole("button", { name: "Invite to server" })).toBeVisible({ timeout: 20_000 })

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

    await page.getByRole("button", { name: "Invite to server" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Couldn't load friends.", { exact: true })).toBeVisible({ timeout: 20_000 })
    const failedChainGets = acceptedGets
    expect(failedChainGets).toBeGreaterThanOrEqual(2)
    fail = false
    await dialog.getByRole("button", { name: "Retry" }).click()
    await expect(dialog.getByText("No friends to invite — everyone you know is already here.", { exact: true }))
      .toBeVisible({ timeout: 20_000 })
    expect(acceptedGets).toBeGreaterThan(failedChainGets)
    await expectTitleClearOfClose(dialog, 390)
  })

  test("Add participants composes both sources and recovers without re-offering a participant", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 844 })
    let failParticipants = true
    let participantGets = 0
    let parentGets = 0
    await page.route(`**/api/community/channels/${failureThreadId}/members`, async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      participantGets += 1
      if (failParticipants) {
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"failed"}' })
        return
      }
      await route.continue()
    })
    await page.route(`**/api/community/channels/${parentChannelId}/members`, async (route) => {
      if (route.request().method() === "GET") parentGets += 1
      await route.continue()
    })

    await page.goto(`/c/channels/${participantServerId}/${failureThreadId}`)
    await expect(page.getByRole("button", { name: /member/i }).first()).toBeVisible({ timeout: 20_000 })
    await page.getByRole("button", { name: /member/i }).first().click()
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

  test("Add participants keeps a slow first load provisional before resolved empty", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 844 })
    const parentGate = deferred()
    let parentGets = 0
    await page.route(`**/api/community/channels/${parentChannelId}/members`, async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      parentGets += 1
      await parentGate.promise
      await route.continue()
    })

    await page.goto(`/c/channels/${participantServerId}/${emptyThreadId}`)
    await expect(page.getByRole("button", { name: /member/i }).first()).toBeVisible({ timeout: 20_000 })
    await page.getByRole("button", { name: /member/i }).first().click()
    await page.getByRole("button", { name: "Add members" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.locator('[data-slot="people-picker-loading"]')).toBeVisible()
    await expect(dialog.getByText(/Everyone is already here|No matches/)).toHaveCount(0)
    expect(parentGets).toBeGreaterThanOrEqual(1)

    parentGate.resolve()
    await expect(dialog.getByText("Everyone is already here.", { exact: true }))
      .toBeVisible({ timeout: 20_000 })
  })

  test("Add participants retries an unresolved parent without refetching participants", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 844 })
    let failParent = true
    let participantGets = 0
    let parentGets = 0
    await page.route(`**/api/community/channels/${parentFailureThreadId}/members`, async (route) => {
      if (route.request().method() === "GET") participantGets += 1
      await route.continue()
    })
    await page.route(`**/api/community/channels/${parentChannelId}/members`, async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      parentGets += 1
      if (failParent) {
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"failed"}' })
        return
      }
      await route.continue()
    })

    await page.goto(`/c/channels/${participantServerId}/${parentFailureThreadId}`)
    await expect(page.getByRole("button", { name: /member/i }).first()).toBeVisible({ timeout: 20_000 })
    await page.getByRole("button", { name: /member/i }).first().click()
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

  test("Add participants keeps mutation pending local to one row", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/c/channels/${participantServerId}/${mutationThreadId}`)
    await expect(page.getByRole("button", { name: /member/i }).first()).toBeVisible({ timeout: 20_000 })
    await page.getByRole("button", { name: /member/i }).first().click()
    await page.getByRole("button", { name: "Add members" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText(bobName, { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByText(carolName, { exact: true })).toBeVisible()
    await expectTitleClearOfClose(dialog, 390)

    const mutationGate = deferred()
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
