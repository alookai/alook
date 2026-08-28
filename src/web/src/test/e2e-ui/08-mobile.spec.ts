import type { Page } from "@playwright/test"
import { test, expect, userId } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import {
  seedServer,
  seedChannel,
  seedDm,
  seedMark,
  seedMessage,
  seedThread,
} from "./_fixtures/seed"

// Journey 8 — adaptive list/detail routing. At <640px semantic roots render
// lists and leaf paths render detail. Server and verified-parent header crumbs
// replace directly to their canonical hierarchy targets; DM keeps Header Back.
test.use({ viewport: { width: 390, height: 844 } })

const shellGroup = (page: Page) => page.locator('[data-slot="resizable-panel-group"]')
const shellPanel = (page: Page, id: "sidebar" | "main") => (
  page.locator(`[data-slot="resizable-panel"][data-testid="${id}"]`)
)

async function expectPanelToFillGroup(page: Page, id: "sidebar" | "main"): Promise<void> {
  const [groupRect, panelRect] = await Promise.all([
    shellGroup(page).boundingBox(),
    shellPanel(page, id).boundingBox(),
  ])
  expect(groupRect).not.toBeNull()
  expect(panelRect).not.toBeNull()
  expect(Math.abs(panelRect!.x - groupRect!.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(panelRect!.width - groupRect!.width)).toBeLessThanOrEqual(1)
}

async function installMeLoadingProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as typeof window & { __wrongMeConversationLoadingSeen?: boolean }
    state.__wrongMeConversationLoadingSeen = false
    const inspect = () => {
      if (location.pathname.startsWith("/c/me/") && document.querySelector('[aria-label="Loading conversation"]')) {
        state.__wrongMeConversationLoadingSeen = true
      }
    }
    new MutationObserver(inspect).observe(document.documentElement, { childList: true, subtree: true })
    inspect()
  })
}

async function expectNoWrongMeConversationLoading(page: Page): Promise<void> {
  expect(await page.evaluate(() => (
    window as typeof window & { __wrongMeConversationLoadingSeen?: boolean }
  ).__wrongMeConversationLoadingSeen)).toBe(false)
}

test.describe.serial("mobile layout", () => {
  let serverId: string
  let channelId: string
  let childChannelId: string
  let dmId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Mobile ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "mobile-chan")
    const parentMessageId = await seedMessage("alice", channelId, "mobile seq command target")
    childChannelId = await seedThread("alice", parentMessageId, "mobile-child")
    const childMessageId = await seedMessage("alice", childChannelId, "mobile child seq target")
    await seedMark("alice", childChannelId, childMessageId)
    dmId = await seedDm("alice", userId("bob"))
  })

  test("whole-page panels fill mobile routes and keep detail identity across 640px", async ({ asUser }) => {
    const { page } = await asUser("alice")

    for (const width of [375, 639]) {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(`/c/channels/${serverId}`)
      await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()
      await expect(shellPanel(page, "main")).toBeHidden()
      await expectPanelToFillGroup(page, "sidebar")

      await page.goto(`/c/channels/${serverId}/${channelId}`)
      await expect(page.getByTestId(tid.composerInput)).toBeVisible()
      await expect(shellPanel(page, "sidebar")).toBeHidden()
      await expectPanelToFillGroup(page, "main")
    }

    const mainPanel = shellPanel(page, "main")
    await mainPanel.evaluate((element) => { element.dataset.e2eShellIdentity = "stable" })
    await page.getByRole("button", { name: "Member list" }).click()
    const membersDialog = page.getByRole("dialog")
    await expect(membersDialog).toBeVisible()
    await membersDialog.evaluate((element) => { element.dataset.e2eSheetIdentity = "stable" })

    for (const width of [640, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      await expect(shellPanel(page, "sidebar")).toBeVisible()
      await expect(mainPanel).toBeVisible()
      await expect(mainPanel).toHaveAttribute("data-e2e-shell-identity", "stable")
      await expect(membersDialog).toHaveAttribute("data-e2e-sheet-identity", "stable")

      const [groupRect, sidebarRect, mainRect] = await Promise.all([
        shellGroup(page).boundingBox(),
        shellPanel(page, "sidebar").boundingBox(),
        mainPanel.boundingBox(),
      ])
      expect(groupRect).not.toBeNull()
      expect(sidebarRect).not.toBeNull()
      expect(mainRect).not.toBeNull()
      expect(sidebarRect!.width).toBeGreaterThanOrEqual(160)
      expect(mainRect!.width).toBeGreaterThan(0)
      expect(sidebarRect!.width).toBeLessThan(groupRect!.width)
      expect(mainRect!.width).toBeLessThan(groupRect!.width)
      expect(Math.abs(sidebarRect!.width + mainRect!.width - groupRect!.width)).toBeLessThanOrEqual(2)
    }
  })

  test("a direct channel opens detail and its server crumb replaces to the server root", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })

    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    const serverCrumb = page.getByTestId(tid.channelHeaderServer(serverId))
    await expect(serverCrumb).toBeVisible()
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0)
    const [controlBox, visualBox] = await Promise.all([
      serverCrumb.boundingBox(),
      serverCrumb.locator(":scope > span").boundingBox(),
    ])
    expect(controlBox).not.toBeNull()
    expect(visualBox).not.toBeNull()
    expect(controlBox!.width).toBe(44)
    expect(controlBox!.height).toBe(44)
    expect(visualBox!.width).toBe(24)
    expect(visualBox!.height).toBe(24)

    const historyLength = await page.evaluate(() => history.length)
    await serverCrumb.click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()
    expect(await page.evaluate(() => history.length)).toBe(historyLength)

    await page.reload()
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()
  })

  test("browser Back and Forward restore list and detail from semantic paths", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}`)
    const channelRow = page.getByTestId(tid.channelRow(channelId))
    await expect(channelRow).toBeVisible()

    await channelRow.click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()

    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    await expect(channelRow).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()

    await page.goForward()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  })

  test("Friends, Machines, and Bots deep links all default to content", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await installMeLoadingProbe(page)

    for (const pathname of ["/c/me/friends", "/c/me/machines", "/c/me/bots"]) {
      await page.goto(pathname)
      const back = page.getByRole("button", { name: "Back" })
      await expect(back).toBeVisible()
      await expect(page.getByTestId(tid.homeButton)).toBeHidden()
      await expectNoWrongMeConversationLoading(page)

      await back.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me")
      expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
      await expect(page.getByTestId(tid.homeButton)).toBeVisible()
    }
  })

  test("detail consumes seq without dropping other URL state", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}?seq=1&keep=detail-seq`)

    await expect.poll(() => new URL(page.url()).searchParams.has("seq")).toBe(false)
    expect(new URL(page.url()).searchParams.get("keep")).toBe("detail-seq")
    expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  })

  test("flat child detail consumes seq without dropping route or other URL state", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(
      `/c/channels/${serverId}/${childChannelId}?seq=1&keep=child-seq`,
    )

    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${childChannelId}`,
    )
    await expect.poll(() => new URL(page.url()).searchParams.has("seq")).toBe(false)
    expect(new URL(page.url()).searchParams.get("keep")).toBe("child-seq")
    await expect(page.getByRole("dialog").getByText("mobile child seq target")).toBeVisible()
  })

  test("a flat child exposes direct parent and server hierarchy controls", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${childChannelId}`)
    const current = page.getByRole("banner").getByText("mobile-child", { exact: true })
    await expect(current).toBeVisible()
    expect(await current.evaluate((element) => element.tagName)).toBe("SPAN")
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0)

    const historyLength = await page.evaluate(() => history.length)
    await page.getByTestId(tid.channelHeaderParent(channelId)).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${channelId}`,
    )
    expect(await page.evaluate(() => history.length)).toBe(historyLength)

    await page.goto(`/c/channels/${serverId}/${childChannelId}`)
    await expect(current).toBeVisible()
    const serverHistoryLength = await page.evaluate(() => history.length)
    await page.getByTestId(tid.channelHeaderServer(serverId)).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}`,
    )
    expect(await page.evaluate(() => history.length)).toBe(serverHistoryLength)
  })

  test("Marked opens a child message on its canonical route without losing context", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto("/c/me")
    await page.getByRole("button", { name: "Inbox" }).click()
    await page.getByRole("tab", { name: "Marked" }).click()
    await page.getByText("mobile child seq target", { exact: true }).click()

    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${childChannelId}`,
    )
    await expect.poll(() => new URL(page.url()).searchParams.has("seq")).toBe(false)
    await expect(page.getByRole("dialog").getByText("mobile child seq target")).toBeVisible()
  })

  test("rejects the removed nested route and clears nested last-channel memory", async ({ asUser }) => {
    const { page } = await asUser("alice")
    const response = await page.goto(
      `/c/channels/${serverId}/${channelId}/${childChannelId}`,
    )
    expect(response?.status()).toBe(404)

    await page.goto("/c/me")
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [`community:lastChannel:${serverId}`, `${channelId}/${childChannelId}`],
    )
    await page.setViewportSize({ width: 900, height: 844 })
    await page.goto(`/c/channels/${serverId}`)
    await expect.poll(() => {
      const segments = new URL(page.url()).pathname.split("/").filter(Boolean)
      return segments.length === 4 ? segments.at(-1) : null
    }).not.toBeNull()
    const selectedChannelId = new URL(page.url()).pathname.split("/").at(-1)
    expect(selectedChannelId).not.toBe(childChannelId)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    await expect.poll(() => page.evaluate(
      (key) => localStorage.getItem(key),
      `community:lastChannel:${serverId}`,
    )).toBe(selectedChannelId)
  })

  test("server-root modal markers are one-shot on mobile", async ({ asUser }) => {
    for (const marker of ["settings", "invite"]) {
      const { page } = await asUser("alice")
      await page.goto(`/c/channels/${serverId}?${marker}=1&keep=${marker}`)

      if (marker === "settings") {
        await expect(page.getByTestId(tid.settingsShell)).toBeVisible()
        await page.getByTestId(tid.settingsClose).click()
        await expect(page.getByTestId(tid.settingsShell)).toBeHidden()
      } else {
        const inviteDialog = page.getByRole("dialog")
        await expect(inviteDialog).toBeVisible()
        await expect(inviteDialog.getByText(/^Invite friends to Mobile-/)).toBeVisible()
        await inviteDialog.getByRole("button", { name: "Close" }).click()
        await expect(inviteDialog).toBeHidden()
      }

      await expect.poll(() => new URL(page.url()).pathname).toBe(
        `/c/channels/${serverId}`,
      )
      await expect.poll(() => new URL(page.url()).searchParams.has(marker)).toBe(false)
      expect(new URL(page.url()).searchParams.get("keep")).toBe(marker)

      await page.reload()
      expect(new URL(page.url()).searchParams.has(marker)).toBe(false)
      await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible()
      if (marker === "settings") {
        await expect(page.getByTestId(tid.settingsShell)).toBeHidden()
      } else {
        await expect(page.getByRole("dialog")).toBeHidden()
      }
      await page.close()
    }
  })

  test("a direct DM opens detail and Header Back replaces it with Me root", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await installMeLoadingProbe(page)
    await page.goto(`/c/me/${dmId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    await expectNoWrongMeConversationLoading(page)

    await page.getByRole("button", { name: "Back" }).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me")
    expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
    await expect(page.getByTestId(tid.dmRow(dmId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()
  })

  test("cross-layout Back and Forward restore each route-owned surface", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}`)
    await expect(page.getByTestId(tid.homeButton)).toBeVisible()

    await page.getByTestId(tid.homeButton).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me")
    await page.getByTestId(tid.dmRow(dmId)).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/me/${dmId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()

    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me")
    await expect(page.getByTestId(tid.dmRow(dmId))).toBeVisible()

    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()

    await page.goForward()
    await page.goForward()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/me/${dmId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  })

  test("resizing resolves desktop roots to detail without inventing layout URL state", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    await page.getByTestId(tid.channelHeaderServer(serverId)).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()

    await page.setViewportSize({ width: 900, height: 844 })
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
  })
})
