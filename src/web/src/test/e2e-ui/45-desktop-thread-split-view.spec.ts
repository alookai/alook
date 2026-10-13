import { expect, test } from "./_fixtures/case-fixture"
import { composerEditable } from "./_fixtures/actions"

import { tid } from "./_fixtures/testids"
import type { CaseActors } from "./_fixtures/case-fixture"

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

test.describe("desktop thread split view", () => {
  async function prepareCase1(actors: CaseActors) {
    const { seedChannel, seedForumThread, seedMessage, seedServer, seedThread } = actors.seed
    const serverId: string = await seedServer("alice", `Split view ${Date.now()}`)
    const textChannelId: string = await seedChannel("alice", serverId, "split-parent")
    const parentBody: string = `parent opener ${Date.now()}`
    const openerId = await seedMessage("alice", textChannelId, parentBody)
    const threadId: string = await seedThread("alice", openerId, "Focused thread")
    const threadBody: string = `thread reply ${Date.now()}`
    await seedMessage("alice", threadId, threadBody)
    const forumId: string = await seedChannel("alice", serverId, "split-forum", "forum")
    const forumTitle: string = `Forum post ${Date.now()}`
    const forumPostId: string = await seedForumThread("alice", forumId, forumTitle, "Forum reply")
    return { serverId, textChannelId, threadId, forumId, forumPostId, parentBody, threadBody, forumTitle }
  }

  test("resizes the thread panel within limits and restores the user layout", async ({ caseActors }) => {
    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId, textChannelId, threadId, parentBody, threadBody } = await prepareCase1(actors)

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
    expect(Math.abs(savedWidth - 520)).toBeLessThanOrEqual(1)

    await page.goto(`/c/channels/${serverId}/${textChannelId}`)
    await expect(page.getByTestId(tid.threadSplitPanel)).toHaveCount(0)
    await page.goto(`/c/channels/${serverId}/${threadId}`)
    await expect(shell).toHaveAttribute("data-layout", "split", { timeout: 20_000 })
    await expect.poll(async () => Math.round((await thread.boundingBox())?.width ?? 0))
      .toBe(savedWidth)
  })

  test("keeps parent and thread live, supports fullscreen/close, and falls back below the width threshold", async ({ caseActors }, testInfo) => {
    test.setTimeout(120_000)

    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { seedMessage } = actors.seed
    const { serverId, textChannelId, threadId, parentBody, threadBody } = await prepareCase1(actors)

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

  test("opens forum posts in the same desktop split contract", async ({ caseActors, caseResources }, testInfo) => {
    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId, forumId, forumPostId, forumTitle } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/c/channels/${serverId}/${forumId}`)
    await expect(page.getByTestId(tid.forumThreadCard(forumPostId))).toBeVisible()
    let releaseMetadata!: () => void
    const metadataGate = new Promise<void>((resolve) => { releaseMetadata = resolve })
    caseResources.own(releaseMetadata, async (captured) => { captured() })
    const metadataPath = `/api/community/channels/${forumPostId}`
    const metadataUrl = (url: URL) => url.pathname === metadataPath
    const holdMetadata = async (route: import("@playwright/test").Route) => {
      await metadataGate
      await route.continue()
    }
    await page.route(metadataUrl, holdMetadata)
    try {
      const requested = page.waitForRequest((request) => new URL(request.url()).pathname === metadataPath)
      await page.getByTestId(tid.forumThreadCard(forumPostId)).click()
      await requested
      const pendingShell = page.getByTestId(tid.threadSplit)
      const pendingParent = page.getByTestId(tid.threadSplitParent)
      const pendingPost = page.getByTestId(tid.threadSplitPanel)
      await expect(pendingShell).toHaveAttribute("data-layout", "split")
      await expect(pendingParent.getByTestId(tid.forumFilterBar)).toBeVisible()
      await expect(pendingParent.getByTestId(tid.forumPostList)).toBeVisible()
      await expect(pendingParent.getByTestId(tid.forumThreadCard(forumPostId))).toBeVisible()
      await expect(pendingPost.locator("[data-message-list-skeleton]")).toBeVisible()
      const group = await pendingShell.locator('[data-slot="resizable-panel-group"]').elementHandle()
      if (!group) throw new Error("Pending split group is unavailable")
      const pendingWidth = (await pendingPost.boundingBox())?.width
      if (pendingWidth === undefined) throw new Error("Pending post geometry is unavailable")
      releaseMetadata()
      await expect(pendingParent.getByTestId(tid.forumPostList)).toBeVisible()
      await expect(pendingPost.getByText("Forum reply", { exact: false })).toBeVisible()
      expect(await group.evaluate((node) => node.isConnected)).toBe(true)
      expect(Math.abs(((await pendingPost.boundingBox())?.width ?? 0) - pendingWidth)).toBeLessThanOrEqual(1)
      await group.dispose()
    } finally {
      releaseMetadata()
      await page.unrouteAll({ behavior: "wait" })
    }
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

  test("keeps a cold parent placeholder until its own metadata is readable", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId, forumId, forumPostId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 900 })
    let releaseMetadata!: () => void
    const metadataGate = new Promise<void>((resolve) => { releaseMetadata = resolve })
    caseResources.own(releaseMetadata, async (captured) => { captured() })
    const metadataPath = `/api/community/channels/${forumId}`
    const metadataUrl = (url: URL) => url.pathname === metadataPath
    await page.route(metadataUrl, async (route) => {
      await metadataGate
      await route.continue()
    })
    try {
      const requested = page.waitForRequest((request) => new URL(request.url()).pathname === metadataPath)
      await page.goto(`/c/channels/${serverId}/${forumPostId}`)
      await requested
      const parent = page.getByTestId(tid.threadSplitParent)
      await expect(page.getByTestId(tid.threadSplit)).toHaveAttribute("data-layout", "split")
      await expect(parent.getByTestId(tid.forumPostList)).toHaveCount(0)
      await expect(parent.getByRole("main").locator('[data-slot="skeleton"]').first()).toBeVisible()
      releaseMetadata()
      await expect(parent.getByTestId(tid.forumPostList)).toBeVisible()
      await expect(page.getByTestId(tid.threadSplitPanel).getByText("Forum reply", { exact: false }))
        .toBeVisible()
    } finally {
      releaseMetadata()
      await page.unrouteAll({ behavior: "wait" })
    }
  })

  test("retains the forum scroll node and resized group across a held post switch", async ({ caseActors, caseResources }) => {
    test.setTimeout(120_000)

    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { seedForumThread } = actors.seed
    const { serverId, forumId, forumPostId } = await prepareCase1(actors)

    for (let index = 0; index < 12; index++) {
      await seedForumThread("alice", forumId, `Split filler ${index}`, `Filler reply ${index}`)
    }
    const postA = await seedForumThread("alice", forumId, "Switch post A", "Switch reply A")
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto(`/c/channels/${serverId}/${postA}`)
    const shell = page.getByTestId(tid.threadSplit)
    const parent = page.getByTestId(tid.threadSplitParent)
    const thread = page.getByTestId(tid.threadSplitPanel)
    const list = parent.getByTestId(tid.forumPostList)
    await expect(shell).toHaveAttribute("data-layout", "split", { timeout: 20_000 })
    await expect(thread.getByText("Switch reply A", { exact: false })).toBeVisible()
    await resizeThreadPanel(page, 520)
    await list.evaluate((node) => { node.scrollTop = node.scrollHeight })
    await expect(parent.getByTestId(tid.forumThreadCard(forumPostId))).toBeVisible()
    const scrollTop = await list.evaluate((node) => node.scrollTop)
    expect(scrollTop).toBeGreaterThan(0)
    const width = (await thread.boundingBox())?.width ?? 0
    const group = await shell.locator('[data-slot="resizable-panel-group"]').elementHandle()
    const listNode = await list.elementHandle()
    if (!group || !listNode) throw new Error("Forum split nodes are unavailable")
    let releaseMetadata!: () => void
    const metadataGate = new Promise<void>((resolve) => { releaseMetadata = resolve })
    caseResources.own(releaseMetadata, async (captured) => { captured() })
    const metadataPath = `/api/community/channels/${forumPostId}`
    const metadataUrl = (url: URL) => url.pathname === metadataPath
    await page.route(metadataUrl, async (route) => {
      await metadataGate
      await route.continue()
    })
    try {
      const requested = page.waitForRequest((request) => new URL(request.url()).pathname === metadataPath)
      await parent.getByTestId(tid.forumThreadCard(forumPostId)).click()
      await requested
      await expect(thread.locator("[data-message-list-skeleton]")).toBeVisible()
      await expect(thread.getByText("Switch reply A", { exact: false })).toHaveCount(0)
      for (const phase of ["pending", "ready"] as const) {
        if (phase === "ready") {
          releaseMetadata()
          await expect(thread.getByText("Forum reply", { exact: false })).toBeVisible()
        }
        expect(await list.evaluate((node, original) => node === original, listNode)).toBe(true)
        expect(await shell.locator('[data-slot="resizable-panel-group"]')
          .evaluate((node, original) => node === original, group)).toBe(true)
        expect(await list.evaluate((node) => node.scrollTop)).toBe(scrollTop)
        expect(Math.abs(((await thread.boundingBox())?.width ?? 0) - width)).toBeLessThanOrEqual(1)
      }
    } finally {
      releaseMetadata()
      await page.unrouteAll({ behavior: "wait" })
      await Promise.all([group.dispose(), listNode.dispose()])
    }
  })

  test("retains the text parent draft and scroll while child drafts stay separate", async ({ caseActors, caseResources }) => {
    test.setTimeout(120_000)

    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { seedMessage, seedThread } = actors.seed
    const { serverId, textChannelId } = await prepareCase1(actors)

    for (let index = 0; index < 35; index++) {
      await seedMessage("alice", textChannelId, `Parent scroll row ${index}`)
    }
    const openerA = await seedMessage("alice", textChannelId, "Draft switch opener A")
    const childA = await seedThread("alice", openerA, "Draft thread A")
    await seedMessage("alice", childA, "Draft reply A")
    const openerB = await seedMessage("alice", textChannelId, "Draft switch opener B")
    const childB = await seedThread("alice", openerB, "Draft thread B")
    await seedMessage("alice", childB, "Draft reply B")
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto(`/c/channels/${serverId}/${childA}`)
    const shell = page.getByTestId(tid.threadSplit)
    const parent = page.getByTestId(tid.threadSplitParent)
    const thread = page.getByTestId(tid.threadSplitPanel)
    const scroller = parent.getByTestId(tid.messageScroller)
    const parentInput = composerEditable(page, parent)
    await expect(shell).toHaveAttribute("data-layout", "split", { timeout: 20_000 })
    await expect(thread.getByText("Draft reply A", { exact: false })).toBeVisible()
    await expect(parent.getByTestId(tid.threadIndicator(openerB))).toBeVisible()
    await resizeThreadPanel(page, 520)
    await parentInput.fill("Parent draft survives")
    await composerEditable(page, thread).fill("Child A draft")
    await parent.getByTestId(tid.threadIndicator(openerB)).scrollIntoViewIfNeeded()
    const scrollTop = await scroller.evaluate((node) => node.scrollTop)
    expect(scrollTop).toBeGreaterThan(0)
    const width = (await thread.boundingBox())?.width ?? 0
    const group = await shell.locator('[data-slot="resizable-panel-group"]').elementHandle()
    const scrollNode = await scroller.elementHandle()
    const inputNode = await parentInput.elementHandle()
    if (!group || !scrollNode || !inputNode) throw new Error("Text split nodes are unavailable")
    let releaseMetadata!: () => void
    const metadataGate = new Promise<void>((resolve) => { releaseMetadata = resolve })
    caseResources.own(releaseMetadata, async (captured) => { captured() })
    const metadataPath = `/api/community/channels/${childB}`
    const metadataUrl = (url: URL) => url.pathname === metadataPath
    await page.route(metadataUrl, async (route) => {
      await metadataGate
      await route.continue()
    })
    try {
      const requested = page.waitForRequest((request) => new URL(request.url()).pathname === metadataPath)
      await parent.getByTestId(tid.threadIndicator(openerB)).click()
      await requested
      await expect(thread.locator("[data-message-list-skeleton]")).toBeVisible()
      await expect(thread.getByText("Draft reply A", { exact: false })).toHaveCount(0)
      for (const phase of ["pending", "ready"] as const) {
        if (phase === "ready") {
          releaseMetadata()
          await expect(thread.getByText("Draft reply B", { exact: false })).toBeVisible()
        }
        expect(await scroller.evaluate((node, original) => node === original, scrollNode)).toBe(true)
        expect(await parentInput.evaluate((node, original) => node === original, inputNode)).toBe(true)
        expect(await shell.locator('[data-slot="resizable-panel-group"]')
          .evaluate((node, original) => node === original, group)).toBe(true)
        expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollTop)
        await expect(parentInput).toHaveText("Parent draft survives")
        expect(Math.abs(((await thread.boundingBox())?.width ?? 0) - width)).toBeLessThanOrEqual(1)
      }
      await expect(composerEditable(page, thread)).toBeEmpty()
      await composerEditable(page, thread).fill("Child B draft")
      await parent.getByTestId(tid.threadIndicator(openerA)).click()
      await expect(thread.getByText("Draft reply A", { exact: false })).toBeVisible()
      await expect(composerEditable(page, thread)).toHaveText("Child A draft")
      await parent.getByTestId(tid.threadIndicator(openerB)).click()
      await expect(composerEditable(page, thread)).toHaveText("Child B draft")
      await expect(parentInput).toHaveText("Parent draft survives")
      const parentLive = `switch parent live ${Date.now()}`
      const childLive = `switch child live ${Date.now()}`
      await seedMessage("alice", textChannelId, parentLive)
      await seedMessage("alice", childB, childLive)
      await expect(parent.getByText(parentLive, { exact: false })).toBeVisible({ timeout: 20_000 })
      await expect(thread.getByText(childLive, { exact: false })).toBeVisible({ timeout: 20_000 })
    } finally {
      releaseMetadata()
      await page.unrouteAll({ behavior: "wait" })
      await Promise.all([group.dispose(), scrollNode.dispose(), inputNode.dispose()])
    }
  })
})
