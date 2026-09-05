import type { Page } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { seedChannel, seedForumThread, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

function observeTagPuts(page: Page): string[] {
  const writes: string[] = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === "PUT" && path.endsWith("/tags")) writes.push(path)
  })
  return writes
}

async function gateNextTagPut(page: Page) {
  let release!: () => void
  let sawRequest!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const requested = new Promise<void>((resolve) => {
    sawRequest = resolve
  })
  await page.route("**/api/community/messages/*/tags", async (routeRequest) => {
    const response = await routeRequest.fetch()
    sawRequest()
    await gate
    await routeRequest.fulfill({ response })
  }, { times: 1 })
  return { release, requested }
}

async function gateNextForumFeedResponse(page: Page) {
  let release!: () => void
  let sawResponse!: () => void
  let finished!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const captured = new Promise<void>((resolve) => {
    sawResponse = resolve
  })
  const delivered = new Promise<void>((resolve) => {
    finished = resolve
  })
  await page.route(/\/api\/community\/channels\/[^/]+\/threads\?/, async (routeRequest) => {
    const response = await routeRequest.fetch()
    sawResponse()
    await gate
    await routeRequest.fulfill({ response }).catch(() => undefined)
    finished()
  }, { times: 1 })
  return { release, captured, delivered }
}

async function seedForum(label: string) {
  const serverId = await seedServer("alice", `${label} ${Date.now()}`)
  const forumId = await seedChannel("alice", serverId, "tag-editor", "forum")
  const threadId = await seedForumThread("alice", forumId, `Post ${Date.now()}`, "tag editor body")
  return {
    route: `/c/channels/${serverId}/${forumId}`,
    threadId,
  }
}

async function openEditor(page: Page, threadId: string) {
  await page.getByTestId(tid.forumThreadCard(threadId)).hover()
  const trigger = page.getByTestId(tid.forumThreadTagBtn(threadId))
  await trigger.click()
  await expect(page.getByTestId(tid.forumTagDialog)).toBeVisible()
  return trigger
}

async function addDraft(page: Page, tag: string) {
  const input = page.getByTestId(tid.forumTagDialogInput)
  await input.fill(tag)
  await input.press("Enter")
  await expect(page.getByTestId(tid.forumTagDialogChip(tag))).toHaveAttribute(
    "aria-label",
    `Remove tag ${tag}`,
  )
}

test.describe.serial("forum tag editor", () => {
  test("keeps Archived out of the tag editor and toggles it from the row action", async ({ asUser }, testInfo) => {
    const { route, threadId } = await seedForum("Archived row action")
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.emulateMedia({ colorScheme: "light" })
    await gotoAfterUserWsAuth(page, route)
    const writes = observeTagPuts(page)

    await openEditor(page, threadId)
    const editor = page.getByTestId(tid.forumTagDialog)
    await expect(editor.getByText("Archived", { exact: true })).toHaveCount(0)
    await expect(page.getByTestId(tid.forumTagDialogChip("archived"))).toHaveCount(0)
    await addDraft(page, "kept")
    const ordinarySave = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await page.keyboard.press("Escape")
    expect((await ordinarySave).request().postDataJSON()).toEqual({ tags: ["kept"] })

    const card = page.getByTestId(tid.forumThreadCard(threadId))
    await expect(card.getByText("#kept", { exact: true })).toBeVisible()
    await page.getByTestId(tid.forumTagChip("kept")).click()
    await expect(card).toBeVisible()
    await card.hover()
    const archiveButton = page.getByTestId(tid.forumThreadArchiveBtn(threadId))
    await expect(archiveButton).toHaveAttribute("aria-label", "Archive post")
    await expect(archiveButton).toHaveAttribute("aria-pressed", "false")
    await testInfo.attach("forum-archived-status-light.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    })
    const archiveGate = await gateNextTagPut(page)
    const archivedSave = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await archiveButton.click()
    await archiveGate.requested
    await expect(card).toHaveCount(0)
    archiveGate.release()
    const archivedResponse = await archivedSave
    expect(archivedResponse.status()).toBe(200)
    expect((archivedResponse.request().postDataJSON() as { tags: string[] }).tags)
      .toEqual(["kept", "archived"])
    await expect(page.getByTestId(tid.forumTagChip("archived"))).toBeVisible()
    await page.getByTestId(tid.forumTagChip("archived")).click()
    await expect(page.getByTestId(tid.forumThreadCard(threadId))).toBeVisible()

    await openEditor(page, threadId)
    await expect(page.getByTestId(tid.forumTagDialog).getByText("Archived", { exact: true }))
      .toHaveCount(0)
    await expect(page.getByTestId(tid.forumTagDialogChip("kept"))).toHaveAttribute(
      "aria-label",
      "Remove tag kept",
    )
    await addDraft(page, "retained")
    const preservedSave = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await page.keyboard.press("Escape")
    const preservedResponse = await preservedSave
    expect(preservedResponse.status()).toBe(200)
    expect([...(preservedResponse.request().postDataJSON() as { tags: string[] }).tags].sort())
      .toEqual(["archived", "kept", "retained"])

    await expect(card.getByText("#retained", { exact: true })).toBeVisible()
    await card.hover()
    const unarchiveButton = page.getByTestId(tid.forumThreadArchiveBtn(threadId))
    await expect(unarchiveButton).toHaveAttribute("aria-label", "Unarchive post")
    await expect(unarchiveButton).toHaveAttribute("aria-pressed", "true")
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveClass(/dark/)
    await testInfo.attach("forum-archived-status-dark.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    })
    await page.emulateMedia({ colorScheme: "light" })
    const unarchiveGate = await gateNextTagPut(page)
    const restoredSave = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await unarchiveButton.click()
    await unarchiveGate.requested
    await expect(card).toHaveCount(0)
    unarchiveGate.release()
    const restoredResponse = await restoredSave
    expect(restoredResponse.status()).toBe(200)
    expect([...(restoredResponse.request().postDataJSON() as { tags: string[] }).tags].sort())
      .toEqual(["kept", "retained"])

    await page.goto(route)
    await expect(page.getByTestId(tid.forumThreadCard(threadId))).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(tid.forumThreadCard(threadId)).getByText("#kept", { exact: true }))
      .toBeVisible()
    expect(writes).toHaveLength(4)
  })

  test("keeps a cancelled stale feed response behind the active archive generation", async ({ asUser }) => {
    const { route, threadId } = await seedForum("Archive stale feed fence")
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 900 })
    await gotoAfterUserWsAuth(page, route)
    const card = page.getByTestId(tid.forumThreadCard(threadId))
    await expect(card).toBeVisible()

    const staleFeed = await gateNextForumFeedResponse(page)
    await openEditor(page, threadId)
    await addDraft(page, "stale-source")
    const ordinarySave = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await page.keyboard.press("Escape")
    expect((await ordinarySave).status()).toBe(200)
    await staleFeed.captured

    await card.hover()
    const archiveResponse = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await page.getByTestId(tid.forumThreadArchiveBtn(threadId)).click()
    await expect(card).toHaveCount(0)

    staleFeed.release()
    await staleFeed.delivered
    await expect(card).toHaveCount(0)

    expect((await archiveResponse).status()).toBe(200)
    await expect(card).toHaveCount(0)
  })

  test("converges Archive and Unarchive across two tabs", async ({ asUser }) => {
    const { route, threadId } = await seedForum("Archive cross tab")
    const tabA = await asUser("alice")
    const tabB = await asUser("alice")
    await Promise.all([
      gotoAfterUserWsAuth(tabA.page, route),
      gotoAfterUserWsAuth(tabB.page, route),
    ])
    const cardA = tabA.page.getByTestId(tid.forumThreadCard(threadId))
    const cardB = tabB.page.getByTestId(tid.forumThreadCard(threadId))
    await expect(cardA).toBeVisible()
    await expect(cardB).toBeVisible()

    await cardA.hover()
    const archived = tabA.page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await tabA.page.getByTestId(tid.forumThreadArchiveBtn(threadId)).click()
    expect((await archived).status()).toBe(200)
    await expect(cardB).toHaveCount(0)

    await expect(tabA.page.getByTestId(tid.forumTagChip("archived"))).toBeVisible()
    await expect(tabB.page.getByTestId(tid.forumTagChip("archived"))).toBeVisible()
    await tabA.page.getByTestId(tid.forumTagChip("archived")).click()
    await tabB.page.getByTestId(tid.forumTagChip("archived")).click()
    await expect(cardA).toBeVisible()
    await expect(cardB).toBeVisible()

    await cardB.hover()
    const unarchived = tabB.page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await tabB.page.getByTestId(tid.forumThreadArchiveBtn(threadId)).click()
    expect((await unarchived).status()).toBe(200)
    await expect(cardA).toHaveCount(0)

    await tabA.page.getByTestId(tid.forumTagAll).click()
    await expect(cardA).toBeVisible()
    await expect(tabA.page.getByTestId(tid.forumThreadCard(threadId))).toHaveCount(1)
  })

  test("discards implicit close and commits only explicit Save", async ({ asUser }) => {
    const { route, threadId } = await seedForum("Mobile explicit save")
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoAfterUserWsAuth(page, route)
    const archiveSetup = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await page.getByTestId(tid.forumThreadArchiveBtn(threadId)).click()
    expect((await archiveSetup).status()).toBe(200)
    await expect(page.getByTestId(tid.forumTagChip("archived"))).toBeVisible()
    await page.getByTestId(tid.forumTagChip("archived")).click()
    await expect(page.getByTestId(tid.forumThreadCard(threadId))).toBeVisible()
    const writes = observeTagPuts(page)
    const initialUrl = page.url()

    const trigger = await openEditor(page, threadId)
    await expect(page.getByTestId(tid.forumTagDialog).getByText("Archived", { exact: true }))
      .toHaveCount(0)
    await addDraft(page, "discarded")
    await page.keyboard.press("Escape")
    await expect(page.getByTestId(tid.forumTagDialog)).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page).toHaveURL(initialUrl)
    expect(writes).toEqual([])

    await openEditor(page, threadId)
    await expect(page.getByTestId(tid.forumTagDialog).getByText("Archived", { exact: true }))
      .toHaveCount(0)
    await expect(page.getByTestId(tid.forumTagDialogChip("discarded"))).toHaveCount(0)
    await addDraft(page, "kept")
    const saved = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await page.getByTestId(tid.forumTagDialogSave).click()
    const savedResponse = await saved
    expect(savedResponse.status()).toBe(200)
    expect([...(savedResponse.request().postDataJSON() as { tags: string[] }).tags].sort())
      .toEqual(["archived", "kept"])
    await expect(page.getByTestId(tid.forumTagDialog)).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.getByTestId(tid.forumTagChip("kept"))).toBeVisible()
    expect(writes).toHaveLength(1)
  })

  test("keeps the row archive state after failure and retries once", async ({ asUser }) => {
    const { route, threadId } = await seedForum("Archive action retry")
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoAfterUserWsAuth(page, route)
    const writes = observeTagPuts(page)
    let rejectNext = true
    let releaseFailure!: () => void
    let sawFailureRequest!: () => void
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve
    })
    const failureRequested = new Promise<void>((resolve) => {
      sawFailureRequest = resolve
    })
    await page.route("**/api/community/messages/*/tags", async (routeRequest) => {
      if (rejectNext) {
        rejectNext = false
        sawFailureRequest()
        await failureGate
        await routeRequest.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "archive retry" }),
        })
        return
      }
      await routeRequest.continue()
    })

    const archiveButton = page.getByTestId(tid.forumThreadArchiveBtn(threadId))
    await expect(archiveButton).toHaveAttribute("aria-label", "Archive post")
    await expect(archiveButton).toHaveAttribute("aria-pressed", "false")
    const failed = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await archiveButton.click()
    await failureRequested
    await expect(page.getByTestId(tid.forumThreadCard(threadId))).toHaveCount(0)
    expect(writes).toHaveLength(1)
    releaseFailure()
    expect((await failed).status()).toBe(500)
    await expect(page.getByText("archive retry", { exact: true })).toBeVisible()
    const restoredCard = page.getByTestId(tid.forumThreadCard(threadId))
    await expect(restoredCard).toBeVisible()
    await restoredCard.hover()
    const restoredArchiveButton = page.getByTestId(tid.forumThreadArchiveBtn(threadId))
    await expect(restoredArchiveButton).toBeEnabled()
    await expect(restoredArchiveButton).toHaveAttribute("aria-pressed", "false")

    const retried = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
      && response.status() === 200
    ))
    await restoredArchiveButton.click()
    const retriedResponse = await retried
    expect((retriedResponse.request().postDataJSON() as { tags: string[] }).tags)
      .toEqual(["archived"])
    await expect(page.getByTestId(tid.forumTagChip("archived"))).toBeVisible()
    expect(writes).toHaveLength(2)
  })

  test("preserves one session across both breakpoint directions without transition writes", async ({ asUser }) => {
    const { route, threadId } = await seedForum("Responsive tag session")
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 639, height: 844 })
    await gotoAfterUserWsAuth(page, route)
    const writes = observeTagPuts(page)

    const trigger = await openEditor(page, threadId)
    await addDraft(page, "cross-mobile")
    await page.getByTestId(tid.forumTagDialogInput).fill("unfinished")
    await page.setViewportSize({ width: 640, height: 844 })
    const desktopSurface = page.getByTestId(tid.forumTagDialog)
    await expect(desktopSurface).toBeVisible()
    await expect(page.getByTestId(tid.forumTagDialogInput)).toHaveValue("unfinished")
    await expect(page.getByTestId(tid.forumTagDialogChip("cross-mobile"))).toHaveAttribute(
      "aria-label",
      "Remove tag cross-mobile",
    )
    await expect.poll(() => desktopSurface.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    expect(writes).toEqual([])

    const desktopSave = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await page.keyboard.press("Escape")
    expect((await desktopSave).status()).toBe(200)
    await expect(desktopSurface).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(
      page.getByTestId(tid.forumThreadCard(threadId)).getByText("#cross-mobile", { exact: true }),
    ).toBeVisible()
    expect(writes).toHaveLength(1)

    await openEditor(page, threadId)
    const crossMobileChip = page.getByTestId(tid.forumTagDialogChip("cross-mobile"))
    await expect(crossMobileChip).toHaveAttribute("aria-label", "Remove tag cross-mobile")
    await crossMobileChip.click()
    await expect(crossMobileChip).toHaveAttribute("aria-label", "Add tag cross-mobile")
    await page.getByTestId(tid.forumTagDialogInput).fill("mobile-discard")
    await page.setViewportSize({ width: 639, height: 844 })
    const mobileSurface = page.getByTestId(tid.forumTagDialog)
    await expect(mobileSurface).toBeVisible()
    await expect(page.getByTestId(tid.forumTagDialogInput)).toHaveValue("mobile-discard")
    await expect(page.getByTestId(tid.forumTagDialogChip("cross-mobile"))).toHaveAttribute(
      "aria-label",
      "Add tag cross-mobile",
    )
    await expect.poll(() => mobileSurface.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    expect(writes).toHaveLength(1)

    await page.getByTestId(tid.forumTagDialogCancel).click()
    await expect(mobileSurface).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(writes).toHaveLength(1)
    await openEditor(page, threadId)
    await expect(page.getByTestId(tid.forumTagDialogChip("cross-mobile"))).toHaveAttribute(
      "aria-label",
      "Remove tag cross-mobile",
    )
    await page.keyboard.press("Escape")
    expect(writes).toHaveLength(1)
  })

  test("retains the draft after a failed Save and retries once", async ({ asUser }) => {
    const { route, threadId } = await seedForum("Tag save retry")
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoAfterUserWsAuth(page, route)
    const writes = observeTagPuts(page)
    let rejectNext = true
    await page.route("**/api/community/messages/*/tags", async (routeRequest) => {
      if (rejectNext) {
        rejectNext = false
        await routeRequest.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "retry" }),
        })
        return
      }
      await routeRequest.continue()
    })

    const trigger = await openEditor(page, threadId)
    await addDraft(page, "retry-tag")
    await page.getByTestId(tid.forumTagDialogInput).fill("still-here")
    const failed = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await page.getByTestId(tid.forumTagDialogSave).click()
    expect((await failed).status()).toBe(500)
    await expect(page.getByTestId(tid.forumTagDialog)).toBeVisible()
    await expect(page.getByTestId(tid.forumTagDialogInput)).toHaveValue("still-here")
    await expect(page.getByTestId(tid.forumTagDialogChip("retry-tag"))).toHaveAttribute(
      "aria-label",
      "Remove tag retry-tag",
    )
    await expect(page.getByTestId(tid.forumTagDialogSave)).toBeEnabled()

    const retried = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
      && response.status() === 200
    ))
    await page.getByTestId(tid.forumTagDialogSave).click()
    expect((await retried).status()).toBe(200)
    await expect(page.getByTestId(tid.forumTagDialog)).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.getByTestId(tid.forumTagChip("retry-tag"))).toBeVisible()
    expect(writes).toHaveLength(2)
  })
})
