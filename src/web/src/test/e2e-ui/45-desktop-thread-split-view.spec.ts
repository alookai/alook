import { expect, test } from "./_fixtures/community-fixture"
import {
  seedChannel,
  seedForumThread,
  seedMessage,
  seedServer,
  seedThread,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

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
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true)
    const narrowLight = testInfo.outputPath("1050-light-fallback.png")
    await page.screenshot({ path: narrowLight })
    await testInfo.attach("1050-light-fallback", { path: narrowLight, contentType: "image/png" })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(shell).toHaveAttribute("data-layout", "full")
    await expect(page.getByTestId(tid.threadSplitFullscreen)).toHaveCount(0)
    await expect(page.getByTestId(tid.threadSplitClose)).toHaveCount(0)
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

  test("opens forum posts in the same desktop split contract", async ({ asUser }) => {
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
    await expect(page.getByTestId(tid.threadSplitPanel).getByText("Forum reply", { exact: false }))
      .toBeVisible()
  })
})
