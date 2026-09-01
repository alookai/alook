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
  test("treats Archived as status and preserves ordinary tags through archive and restore", async ({ asUser }, testInfo) => {
    const { route, threadId } = await seedForum("Archived status")
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.emulateMedia({ colorScheme: "light" })
    await gotoAfterUserWsAuth(page, route)
    const writes = observeTagPuts(page)

    await openEditor(page, threadId)
    await addDraft(page, "kept")
    const archived = page.getByTestId(tid.forumTagDialogArchived)
    await expect(archived).toHaveAttribute("aria-pressed", "false")
    await expect(archived).toHaveAttribute("aria-label", "Add Archived status")
    await expect(page.getByTestId(tid.forumTagDialogChip("archived"))).toHaveCount(0)
    await archived.click()
    await expect(archived).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByTestId(tid.forumTagDialogChip("kept"))).toHaveAttribute(
      "aria-label",
      "Remove tag kept",
    )
    await testInfo.attach("forum-archived-status-light.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    })
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveClass(/dark/)
    await testInfo.attach("forum-archived-status-dark.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    })
    await page.emulateMedia({ colorScheme: "light" })

    const archivedSave = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await page.keyboard.press("Escape")
    const archivedResponse = await archivedSave
    expect(archivedResponse.status()).toBe(200)
    expect((archivedResponse.request().postDataJSON() as { tags: string[] }).tags)
      .toEqual(["kept", "archived"])
    await expect(page.getByTestId(tid.forumTagChip("archived"))).toBeVisible()
    await page.getByTestId(tid.forumTagChip("archived")).click()
    await expect(page.getByTestId(tid.forumThreadCard(threadId))).toBeVisible()

    await openEditor(page, threadId)
    await expect(page.getByTestId(tid.forumTagDialogArchived)).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByTestId(tid.forumTagDialogChip("kept"))).toHaveAttribute(
      "aria-label",
      "Remove tag kept",
    )
    await page.getByTestId(tid.forumTagDialogArchived).click()
    const restoredSave = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await page.keyboard.press("Escape")
    const restoredResponse = await restoredSave
    expect(restoredResponse.status()).toBe(200)
    expect((restoredResponse.request().postDataJSON() as { tags: string[] }).tags).toEqual(["kept"])

    await page.goto(route)
    await expect(page.getByTestId(tid.forumThreadCard(threadId))).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(tid.forumThreadCard(threadId)).getByText("#kept", { exact: true }))
      .toBeVisible()
    expect(writes).toHaveLength(2)
  })

  test("discards implicit close and commits only explicit Save", async ({ asUser }) => {
    const { route, threadId } = await seedForum("Mobile explicit save")
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoAfterUserWsAuth(page, route)
    const writes = observeTagPuts(page)
    const initialUrl = page.url()

    const trigger = await openEditor(page, threadId)
    await page.getByTestId(tid.forumTagDialogArchived).click()
    await expect(page.getByTestId(tid.forumTagDialogArchived)).toHaveAttribute("aria-pressed", "true")
    await addDraft(page, "discarded")
    await page.keyboard.press("Escape")
    await expect(page.getByTestId(tid.forumTagDialog)).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page).toHaveURL(initialUrl)
    expect(writes).toEqual([])

    await openEditor(page, threadId)
    await expect(page.getByTestId(tid.forumTagDialogArchived)).toHaveAttribute("aria-pressed", "false")
    await expect(page.getByTestId(tid.forumTagDialogChip("discarded"))).toHaveCount(0)
    await addDraft(page, "kept")
    const saved = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/tags")
    ))
    await page.getByTestId(tid.forumTagDialogSave).click()
    expect((await saved).status()).toBe(200)
    await expect(page.getByTestId(tid.forumTagDialog)).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.getByTestId(tid.forumTagChip("kept"))).toBeVisible()
    expect(writes).toHaveLength(1)
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
