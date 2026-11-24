import { expectInertBackground } from "./_fixtures/inert-background"
import type { Page, Request, Route } from "@playwright/test"
import { type CaseActors, type CaseResources, expect, test } from "./_fixtures/case-fixture"
import { expectPublicCommunityDocument } from "./_fixtures/community-ssr-frame"
import { tid } from "./_fixtures/testids"
import { CURRENT_COMMUNITY_FIXTURE_HEADERS, communityFixtureFetch, confirmCommunityFixtureApiResponse } from "./_fixtures/business-contract"
import { WEB_URL } from "./_setup/paths"

// Journey 8 — adaptive list/detail routing. At <640px semantic roots render
// lists and leaf paths render detail. Server and verified-parent header crumbs
// replace directly to their canonical hierarchy targets; DM keeps Header Back.
test.use({ viewport: { width: 390, height: 844 } })

const shellGroup = (page: Page) => page.locator('[data-slot="resizable-panel-group"][id="community-shell"]')
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

test.describe("mobile layout", () => {
  async function prepareCase1(actors: CaseActors, repliesOutsideRoots = false) {
    const { userId } = actors
    const { seedServer, seedChannel, seedDm, seedMark, seedMessage, seedThread } = actors.seed
    const serverId: string = await seedServer("alice", `Mobile ${Date.now()}`)
    const channelId: string = await seedChannel("alice", serverId, "mobile-chan")
    const parentReplyTo = repliesOutsideRoots ? await seedMessage("alice", channelId, "mobile unpinned original") : undefined
    const parentMessageId = await seedMessage("alice", channelId, "mobile seq command target", parentReplyTo ? { replyToId: parentReplyTo } : undefined)
    const childChannelId: string = await seedThread("alice", parentMessageId, "mobile-child")
    const childReplyTo = repliesOutsideRoots ? await seedMessage("alice", childChannelId, "mobile unmarked original") : undefined
    const childMessageId = await seedMessage("alice", childChannelId, "mobile child seq target", childReplyTo ? { replyToId: childReplyTo } : undefined)
    await seedMark("alice", childChannelId, childMessageId)
    const dmId: string = await seedDm("alice", userId("bob"))
    return { serverId, channelId, childChannelId, dmId, parentMessageId, childMessageId, parentReplyTo, childReplyTo }
  }

  test("whole-page panels fill mobile routes and keep detail identity across 640px", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

    const { page } = await asUser("alice")

    for (const width of [375, 639]) {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(`/c/channels/${serverId}`)
      await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()
      await expect(shellPanel(page, "main")).toBeHidden()
      await expectPanelToFillGroup(page, "sidebar")

      await page.goto(`/c/channels/${serverId}/${channelId}`)
      await expect(page.getByTestId(tid.composerInput)).toBeVisible()
      await expectInertBackground(shellPanel(page, "sidebar"))
      const detail = page.locator('[data-mobile-page-active="true"] [data-slot="mobile-page"]')
      await expect.poll(() => detail.boundingBox()).toMatchObject({ x: 0, y: 0, width, height: 844 })
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
      expect(sidebarRect!.width).toBeGreaterThanOrEqual(100)
      expect(mainRect!.width).toBeGreaterThan(0)
      expect(sidebarRect!.width).toBeLessThan(groupRect!.width)
      expect(mainRect!.width).toBeLessThan(groupRect!.width)
      expect(Math.abs(sidebarRect!.width + mainRect!.width - groupRect!.width)).toBeLessThanOrEqual(2)
    }
  })

  test("a direct channel opens detail and Back replaces to the server root", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })

    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    const back = page.getByRole("banner").getByRole("button", { name: "Back" })
    await expect(back).toBeVisible()
    const controlBox = await back.boundingBox()
    expect(controlBox).not.toBeNull()
    expect(controlBox!.width).toBe(44)
    expect(controlBox!.height).toBe(44)

    const historyLength = await page.evaluate(() => history.length)
    await back.click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()
    expect(await page.evaluate(() => history.length)).toBe(historyLength)

    await page.reload()
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()
  })

  test("browser Back and Forward restore list and detail from semantic paths", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

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

  test("Friends, Machines, and Bots deep links all default to content", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    await prepareCase1(actors)

    const { page } = await asUser("alice")
    await installMeLoadingProbe(page)

    for (const pathname of ["/c/me/friends", "/c/me/machines", "/c/me/bots"]) {
      await page.goto(pathname)
      const back = page.getByRole("button", { name: "Back" })
      await expect(back).toBeVisible()
      await expectInertBackground(page.getByTestId(tid.homeButton))
      await expectNoWrongMeConversationLoading(page)

      await back.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me")
      expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
      await expect(page.getByTestId(tid.homeButton)).toBeVisible()
    }
  })

  test("detail consumes seq without dropping other URL state", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}?seq=1&keep=detail-seq`)

    await expect.poll(() => new URL(page.url()).searchParams.has("seq")).toBe(false)
    expect(new URL(page.url()).searchParams.get("keep")).toBe("detail-seq")
    expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  })

  test("flat child detail consumes seq without dropping route or other URL state", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, childChannelId } = await prepareCase1(actors)

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

  test("a flat child exposes its current identity and direct parent Back control", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId, childChannelId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${childChannelId}`)
    const current = page.getByRole("banner").getByText("mobile-child", { exact: true })
    await expect(current).toBeVisible()
    const back = page.getByRole("button", { name: "Back" })
    await expect(back).toBeVisible()
    const historyLength = await page.evaluate(() => history.length)
    await back.click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${channelId}`,
    )
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
  })

  test("Marked opens a child message on its canonical route without losing context", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId, childChannelId, parentMessageId, childMessageId, parentReplyTo, childReplyTo } = await prepareCase1(actors, true)
    for (const [channel, messageId] of [[channelId, parentMessageId], [childChannelId, childMessageId]]) {
      const pin = await communityFixtureFetch(WEB_URL + "/api/community/channels/" + channel + "/pins", {
        method: "POST", headers: { Cookie: actors.sessionCookie("alice"), Origin: WEB_URL, "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
      })
      expect(pin.status).toBe(201)
    }
    const { page } = await asUser("alice")
    const textPins = page.waitForResponse(response => response.url().endsWith("/api/community/channels/" + channelId + "/pins") && response.request().method() === "GET")
    await page.goto("/c/channels/" + serverId + "/" + channelId)
    const text = await (await textPins).json()
    expect(text.pins).toEqual([{ id: parentMessageId }])
    expect(text.resources.messages.map((message: { id: string }) => message.id).sort()).toEqual([parentMessageId, parentReplyTo].sort())
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    await page.getByRole("button", { name: "More channel options", exact: true }).click()
    await page.getByRole("menuitem", { name: "Pinned messages", exact: true }).click()
    const publishedPins = page.getByRole("dialog")
    await expect(publishedPins.getByRole("button").filter({ hasText: "mobile seq command target" })).toBeVisible()
    await expect(page.getByTestId(tid.businessSchemaUpdate)).toHaveCount(0)
    await publishedPins.getByRole("button", { name: "Close", exact: true }).click()
    await expect(publishedPins).toBeHidden()

    await page.goto("/c/me")
    await page.getByRole("button", { name: "Inbox" }).click()
    const marks = page.waitForResponse(response => response.url().includes("/api/community/users/me/marks") && response.request().method() === "GET")
    await page.getByRole("tab", { name: "Marked" }).click()
    const marked = await (await marks).json()
    expect(marked.marked.map((row: { m: { id: string } }) => row.m.id)).toEqual([childMessageId])
    expect(marked.resources.messages.map((message: { id: string }) => message.id).sort()).toEqual([childMessageId, childReplyTo].sort())
    const threadPins = page.waitForResponse(response => response.url().endsWith("/api/community/channels/" + childChannelId + "/pins") && response.request().method() === "GET")
    await page.getByText("mobile child seq target", { exact: true }).click()

    await expect.poll(() => new URL(page.url()).pathname).toBe("/c/channels/" + serverId + "/" + childChannelId)
    const thread = await (await threadPins).json()
    expect(thread.pins).toEqual([{ id: childMessageId }])
    expect(thread.resources.messages.map((message: { id: string }) => message.id).sort()).toEqual([childMessageId, childReplyTo].sort())
    await expect.poll(() => new URL(page.url()).searchParams.has("seq")).toBe(false)
    await expect(page.getByRole("dialog").getByText("mobile child seq target")).toBeVisible()
    await expect(page.getByTestId(tid.businessSchemaUpdate)).toHaveCount(0)
  })

  test("rejects the removed nested route and clears nested last-channel memory", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId, childChannelId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    const response = await page.goto(
      `/c/channels/${serverId}/${channelId}/${childChannelId}`,
    )
    expect(response?.status()).toBe(200)
    expectPublicCommunityDocument(await response!.text())
    await expect(page.getByText("Undeliverable — page not found", { exact: false })).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toHaveCount(0)

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

  test("server-root modal markers are one-shot on mobile", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId } = await prepareCase1(actors)

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

  test("a direct DM opens detail and Header Back replaces it with Me root", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { dmId } = await prepareCase1(actors)

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

  test("cross-layout Back and Forward restore each route-owned surface", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId, dmId } = await prepareCase1(actors)

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

  test("resizing resolves desktop roots to detail without inventing layout URL state", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
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

test.describe("mobile parent return", () => {
  async function holdReturnDocumentRoutes(page: Page, pathnames: string[], resources: CaseResources) {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const pattern = (url: URL) => pathnames.includes(url.pathname)
    let held = 0
    const pending = new Set<Request>()
    const continuations: Promise<void>[] = []
    const settled = (request: Request) => { pending.delete(request) }
    page.on("requestfinished", settled)
    page.on("requestfailed", settled)
    const handler = (route: Route) => {
      held += 1
      const request = route.request()
      pending.add(request)
      const continuation = (async () => {
        await gate
        if (pending.has(request)) await route.continue()
      })()
      continuations.push(continuation)
      return continuation
    }
    await page.route(pattern, handler)
    let finishing: Promise<void> | undefined
    const finish = () => finishing ??= (async () => {
      release()
      await Promise.all(continuations)
      await page.unroute(pattern, handler)
      await expect.poll(() => pending.size).toBe(0)
      page.off("requestfinished", settled)
      page.off("requestfailed", settled)
    })()
    resources.own(finish, async cleanup => cleanup())
    return { held: () => held, release: finish }
  }

  for (const parentType of ["forum", "text"] as const) {
    for (const input of ["button", "system"] as const) {
      test(`mobile ${parentType} parent accepts consecutive ${input} Back without framework route reads`, async ({ caseActors, caseResources }, testInfo) => {
        const actors = await caseActors(["alice"])
        const { seedServer, seedChannel, seedMessage, seedThread, seedForumThread } = actors.seed
        const serverId = await seedServer("alice", `Parent return ${parentType} ${input}`)
        const parentId = await seedChannel("alice", serverId, "return-parent", parentType)
        const childId = parentType === "forum"
          ? await seedForumThread("alice", parentId, "Return child", "Child reply")
          : await seedThread("alice", await seedMessage("alice", parentId, "Thread opener"), "Return child")
        const rootPath = `/c/channels/${serverId}`
        const childPath = `${rootPath}/${childId}`
        const parentPath = `${rootPath}/${parentId}`
        const { page } = await actors.asUser("alice")
        await page.setViewportSize({ width: 390, height: 844 })
        await page.emulateMedia({ reducedMotion: "reduce" })

        if (parentType === "forum" && input === "button") {
          await page.goto(rootPath, { waitUntil: "commit" })
          await page.getByTestId(tid.forumSidebarThread(childId)).click()
        } else await page.goto(childPath, { waitUntil: "commit" })

        const foreground = page.locator('[data-mobile-page-active="true"]')
        const back = foreground.getByRole("banner").getByRole("button", { name: "Back", exact: true })
        await expect(back).toBeVisible()
        const [childResponse, parentResponse] = await Promise.all([
          confirmCommunityFixtureApiResponse(page.request.get(new URL(`/api/community/channels/${childId}`, page.url()).href, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS })),
          confirmCommunityFixtureApiResponse(page.request.get(new URL(`/api/community/channels/${parentId}`, page.url()).href, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS })),
        ])
        expect(childResponse.status()).toBe(200)
        expect(parentResponse.status()).toBe(200)
        const { channel } = await childResponse.json() as { channel: {
          id: string; serverId: string; parentChannelId: string
        } }
        const { channel: parent } = await parentResponse.json() as { channel: { id: string; type: string } }
        expect(channel).toMatchObject({ id: childId, serverId, parentChannelId: parentId })
        expect(parent).toMatchObject({ id: parentId, type: parentType })

        const parentRoute = await holdReturnDocumentRoutes(page, [parentPath, rootPath], caseResources)
        await back.click({ noWaitAfter: true })
        await expect(foreground.locator(`[data-community-target-href="${parentPath}"]`)).toBeVisible()
        expect(new URL(page.url()).pathname).toBe(parentPath)

        if (input === "button") await back.click({ noWaitAfter: true })
        else await page.evaluate(() => window.dispatchEvent(new Event("alook:native-back", { cancelable: true })))

        const parentRow = page.getByTestId(tid.channelRow(parentId))
        await expect(parentRow).toBeVisible()
        await expect(page.locator(`[data-mobile-page-active="true"] [data-community-target-href="${childPath}"]`)).toBeHidden()
        const screenshot = testInfo.outputPath("list-before-parent-release.png")
        await page.screenshot({ path: screenshot })
        await testInfo.attach("list-before-parent-release", { path: screenshot, contentType: "image/png" })
        expect(parentRoute.held()).toBe(0)
        await parentRoute.release()
        await expect.poll(() => new URL(page.url()).pathname).toBe(rootPath)
        await expect(parentRow).toBeVisible()
        await expect(foreground).toBeHidden()
        await testInfo.attach("parent-return-result", {
          body: JSON.stringify({ parentType, input, metadataStatuses: [childResponse.status(), parentResponse.status()], heldParentRequests: parentRoute.held(), finalPath: rootPath,
            channel: { id: channel.id, serverId: channel.serverId, parentChannelId: channel.parentChannelId }, parent: { id: parent.id, type: parent.type } }),
          contentType: "application/json",
        })
      })
    }
  }
})
