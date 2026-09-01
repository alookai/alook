import { expect, test } from "./_fixtures/community-fixture"
import {
  seedChannel,
  seedForumThread,
  seedMessage,
  seedServer,
  seedThread,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

const THREAD_PANEL_MIN_WIDTH = 360
const THREAD_PANEL_MAX_WIDTH = 800

async function resizeThreadPanel(page: import("@playwright/test").Page, targetWidth: number) {
  const divider = page.getByRole("separator", { name: "Resize thread panel" })
  const thread = page.getByTestId(tid.threadSplitPanel)
  const [dividerBox, threadBox] = await Promise.all([
    divider.boundingBox(),
    thread.boundingBox(),
  ])
  if (!dividerBox || !threadBox) throw new Error("Thread split geometry is unavailable")

  const y = dividerBox.y + dividerBox.height / 2
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(threadBox.x + threadBox.width - targetWidth, y, { steps: 8 })
  await page.mouse.up()
}

test.describe.serial("desktop thread split view", () => {
  let serverId: string
  let textChannelId: string
  let threadId: string
  let forumId: string
  let forumPostId: string
  let parentBody: string
  let threadBody: string
  let forumTitle: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Split view ${Date.now()}`)
    textChannelId = await seedChannel("alice", serverId, "split-parent")
    parentBody = `parent opener ${Date.now()}`
    const openerId = await seedMessage("alice", textChannelId, parentBody)
    threadId = await seedThread("alice", openerId, "Focused thread")
    threadBody = `thread reply ${Date.now()}`
    await seedMessage("alice", threadId, threadBody)

    forumId = await seedChannel("alice", serverId, "split-forum", "forum")
    forumTitle = `Forum post ${Date.now()}`
    forumPostId = await seedForumThread("alice", forumId, forumTitle, "Forum reply")
  })

  test("resizes the thread panel within limits and restores the user layout", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto(`/c/channels/${serverId}/${threadId}`)

    const shell = page.getByTestId(tid.threadSplit)
    const parent = page.getByTestId(tid.threadSplitParent)
    const thread = page.getByTestId(tid.threadSplitPanel)
    await expect(shell).toHaveAttribute("data-layout", "split", { timeout: 20_000 })
    await expect(page.getByRole("separator", { name: "Resize thread panel" })).toBeVisible()
    const layoutWidth = Math.round(
      (await shell.locator('[data-slot="resizable-panel-group"]').boundingBox())?.width ?? 0,
    )

    await resizeThreadPanel(page, 200)
    await expect.poll(async () => Math.round((await thread.boundingBox())?.width ?? 0))
      .toBe(THREAD_PANEL_MIN_WIDTH)
    await expect(parent.getByText(parentBody, { exact: false })).toBeVisible()
    await expect(thread.getByText(threadBody, { exact: false })).toBeVisible()

    await resizeThreadPanel(page, 800)
    const expectedMaxWidth = Math.min(THREAD_PANEL_MAX_WIDTH, layoutWidth - 320)
    await expect.poll(async () => Math.abs(
      Math.round((await thread.boundingBox())?.width ?? 0) - expectedMaxWidth,
    )).toBeLessThanOrEqual(1)

    await resizeThreadPanel(page, 520)
    const savedWidth = Math.round((await thread.boundingBox())?.width ?? 0)
    expect(savedWidth).toBe(520)

    await page.goto(`/c/channels/${serverId}/${textChannelId}`)
    await expect(page.getByTestId(tid.threadSplitPanel)).toHaveCount(0)
    await page.goto(`/c/channels/${serverId}/${threadId}`)
    await expect(shell).toHaveAttribute("data-layout", "split", { timeout: 20_000 })
    await expect.poll(async () => Math.round((await thread.boundingBox())?.width ?? 0))
      .toBe(savedWidth)
  })

  test("keeps parent and thread live, supports fullscreen/close, and falls back below the width threshold", async ({ asUser }, testInfo) => {
    test.setTimeout(120_000)
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/c/channels/${serverId}/${threadId}`)

    const shell = page.getByTestId(tid.threadSplit)
    const parent = page.getByTestId(tid.threadSplitParent)
    const thread = page.getByTestId(tid.threadSplitPanel)
    await expect(shell).toHaveAttribute("data-layout", "split", { timeout: 20_000 })
    await expect(parent.getByText(parentBody, { exact: false })).toBeVisible()
    await expect(thread.getByText(threadBody, { exact: false })).toBeVisible()
    await expect(thread.getByTestId(tid.threadSplitFullscreen)).toBeVisible()
    await expect(thread.getByTestId(tid.threadSplitClose)).toBeVisible()
    await expect(thread.getByRole("button", { name: "Rename" })).toHaveCount(0)
    await expect(thread.getByRole("button", { name: "Member list" })).toHaveCount(0)
    await expect(thread.getByRole("button", { name: "Channel notifications" })).toHaveCount(0)
    await expect(thread.getByRole("button", { name: "More channel options" })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true)
    const desktopLight = testInfo.outputPath("1280-light-split.png")
    await page.screenshot({ path: desktopLight })
    await testInfo.attach("1280-light-split", { path: desktopLight, contentType: "image/png" })

    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveClass(/dark/)
    const desktopDark = testInfo.outputPath("1280-dark-split.png")
    await page.screenshot({ path: desktopDark })
    await testInfo.attach("1280-dark-split", { path: desktopDark, contentType: "image/png" })
    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).not.toHaveClass(/dark/)

    const parentLive = `parent live ${Date.now()}`
    const threadLive = `thread live ${Date.now()}`
    await seedMessage("alice", textChannelId, parentLive)
    await seedMessage("alice", threadId, threadLive)
    await expect(parent.getByText(parentLive, { exact: false })).toBeVisible({ timeout: 20_000 })
    await expect(thread.getByText(threadLive, { exact: false })).toBeVisible({ timeout: 20_000 })

    await page.getByTestId(tid.threadSplitFullscreen).click()
    await page.waitForURL(`/c/channels/${serverId}/${threadId}?threadView=full`)
    await expect(shell).toHaveAttribute("data-layout", "full")
    await expect(page.getByTestId(tid.threadSplitParent)).toHaveCount(0)
    await expect(thread.getByRole("button", { name: "Rename" })).toBeVisible()
    await expect(thread.getByRole("button", { name: "Member list" })).toBeVisible()
    await expect(thread.getByRole("button", { name: "Channel notifications" })).toBeVisible()
    await expect(thread.getByRole("button", { name: "More channel options" })).toBeVisible()

    await page.goBack()
    await expect(shell).toHaveAttribute("data-layout", "split")
    await page.getByTestId(tid.threadSplitClose).click()
    await page.waitForURL(`/c/channels/${serverId}/${textChannelId}`)

    await page.goto(`/c/channels/${serverId}/${threadId}`)
    await expect(shell).toHaveAttribute("data-layout", "split")
    await expect(page.getByTestId(tid.threadSplitPanel).getByText(parentBody, { exact: false }))
      .toBeVisible({ timeout: 20_000 })
    await page.setViewportSize({ width: 1050, height: 900 })
    await expect(shell).toHaveAttribute("data-layout", "full")
    await expect(page.getByTestId(tid.threadSplitParent)).toHaveCount(0)
    await expect(page.getByRole("separator", { name: "Resize thread panel" })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true)
    const narrowLight = testInfo.outputPath("1050-light-fallback.png")
    await page.screenshot({ path: narrowLight })
    await testInfo.attach("1050-light-fallback", { path: narrowLight, contentType: "image/png" })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(shell).toHaveAttribute("data-layout", "full")
    await expect(page.getByTestId(tid.threadSplitFullscreen)).toHaveCount(0)
    await expect(page.getByTestId(tid.threadSplitClose)).toHaveCount(0)
    await expect(page.getByRole("separator", { name: "Resize thread panel" })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true)
    const mobileLight = testInfo.outputPath("390-light-full.png")
    await page.screenshot({ path: mobileLight })
    await testInfo.attach("390-light-full", { path: mobileLight, contentType: "image/png" })

    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveClass(/dark/)
    const mobileDark = testInfo.outputPath("390-dark-full.png")
    await page.screenshot({ path: mobileDark })
    await testInfo.attach("390-dark-full", { path: mobileDark, contentType: "image/png" })
  })

  test("opens forum posts in the same desktop split contract", async ({ asUser }, testInfo) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/c/channels/${serverId}/${forumPostId}`)

    await expect(page.getByTestId(tid.threadSplit)).toHaveAttribute("data-layout", "split", {
      timeout: 20_000,
    })
    const parent = page.getByTestId(tid.threadSplitParent)
    await expect(parent.getByTestId(tid.forumPostList)).toBeVisible()
    await expect(parent.getByTestId(tid.forumThreadTitleText(forumPostId)))
      .toHaveText(forumTitle)
    const post = page.getByTestId(tid.threadSplitPanel)
    await expect(post.getByText("Forum reply", { exact: false })).toBeVisible()
    await expect(post.getByTestId(tid.threadSplitFullscreen)).toBeVisible()
    await expect(post.getByTestId(tid.threadSplitClose)).toBeVisible()
    await expect(post.getByRole("button", { name: "Rename" })).toHaveCount(0)
    await expect(post.getByRole("button", { name: "Member list" })).toHaveCount(0)
    await expect(post.getByRole("button", { name: "Channel notifications" })).toHaveCount(0)
    await expect(post.getByRole("button", { name: "More channel options" })).toHaveCount(0)

    const forumSplit = testInfo.outputPath("1280-light-forum-split.png")
    await page.screenshot({ path: forumSplit })
    await testInfo.attach("1280-light-forum-split", { path: forumSplit, contentType: "image/png" })
  })
})
