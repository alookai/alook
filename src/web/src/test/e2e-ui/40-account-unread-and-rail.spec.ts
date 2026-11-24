import { CURRENT_COMMUNITY_FIXTURE_HEADERS, confirmCommunityFixtureApiResponse, currentCommunityFixtureError } from "./_fixtures/business-contract"
import { expectInertBackground } from "./_fixtures/inert-background"
import type { Locator, Page, Request, Response } from "@playwright/test"
import { AccountAttentionSnapshotSchema } from "@alook/shared"
import { type CaseResources, expect, test } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { type CapturedCommunityFrame, communityFrameEvents, isCommunityBatchFrame, proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"

test.describe("server rail unread", () => {
  async function indicatorHeight(indicator: Locator) {
    return indicator.evaluate((element) => element.getBoundingClientRect().height)
  }

  async function expectIndicatorHeight(indicator: Locator, height: number) {
    await expect.poll(() => indicatorHeight(indicator), { timeout: 20_000 }).toBe(height)
  }

  async function combineServers(page: Page, sourceId: string, targetId: string) {
    const sourceButton = page.getByTestId(tid.serverIcon(sourceId))
    const targetButton = page.getByTestId(tid.serverIcon(targetId))
    await sourceButton.focus()
    await targetButton.focus()
    const source = sourceButton
    const target = targetButton
    await expect(source).toHaveAttribute("draggable", "true")
    await expect(target).toHaveAttribute("draggable", "true")
    const targetBox = await target.boundingBox()
    if (!targetBox) throw new Error("server rail drag target is outside the viewport")
    let responseStatus: number | null = null
    const captureResponse = (candidate: Response) => {
      if (
        candidate.request().method() === "PATCH"
        && new URL(candidate.url()).pathname === "/api/community/users/me/server-rail"
      ) responseStatus = candidate.status()
    }
    page.on("response", captureResponse)
    try {
      for (let attempt = 0; attempt < 3 && responseStatus === null; attempt += 1) {
        await source.dragTo(target, {
          targetPosition: { x: targetBox.width / 2, y: targetBox.height / 2 },
          force: true,
        })
        await page.waitForTimeout(250)
      }
      expect(responseStatus).toBe(200)
    } finally {
      page.off("response", captureResponse)
    }
  }

  test("server unread owns exact rail geometry, folder aggregation, read clear, and mobile parity", async ({ caseActors, caseResources }, testInfo) => {
    test.setTimeout(150_000)

    const actors = await caseActors(["alice", "bob"])
    const { asUser, userId } = actors
    const { memberInfo, seedChannel, seedJoinServer, seedMessage, seedServer } = actors.seed

    const stamp = Date.now()
    const foregroundServer = await seedServer("alice", `Unread foreground ${stamp}`)
    const backgroundServer = await seedServer("alice", `Unread background ${stamp}`)
    const neutralServer = await seedServer("alice", `Unread neutral ${stamp}`)
    const foregroundChannel = await seedChannel("alice", foregroundServer, `foreground-${stamp}`)
    const backgroundChannel = await seedChannel("alice", backgroundServer, `background-${stamp}`)
    await seedJoinServer("alice", "bob", foregroundServer)
    await seedJoinServer("alice", "bob", backgroundServer)
    await seedJoinServer("alice", "bob", neutralServer)
    const bobInfo = await memberInfo("alice", backgroundServer, userId("bob"))
    const { page, context } = await asUser("bob", {
      recordVideo: { dir: testInfo.outputPath("server-digits-video"), size: { width: 1280, height: 900 } },
    })
    const ws = await proxyCommunityWebSockets(context)
    const snapshots: Array<Record<string, unknown>> = []
    const video = page.video()
    actors.onCleanup(async () => {
      try {
        await testInfo.attach("server-digits-stages.json", {
          body: JSON.stringify({ snapshots, frames: ws.frames }, null, 2), contentType: "application/json",
        })
      } finally {
        await caseResources.closeContext(context)
        if (video) await testInfo.attach("server-hidden-message-return-video", {
          path: await video.path(), contentType: "video/webm",
        })
      }
    })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/c/channels/${foregroundServer}/${foregroundChannel}`)
    await expect(page.getByTestId(tid.serverIcon(backgroundServer))).toBeVisible({ timeout: 30_000 })

    const indicatorBefore = (testId: string) => page.getByTestId(testId)
      .locator('xpath=preceding-sibling::*[@data-slot="community-server-rail-indicator"][1]')
    const foregroundIndicator = page.getByTestId(tid.serverRailIndicator(foregroundServer))
    const homeButton = page.getByTestId(tid.homeButton)
    const homeIndicator = indicatorBefore(tid.homeButton)
    const addButton = page.getByTestId(tid.serverAdd)
    const addIndicator = indicatorBefore(tid.serverAdd)
    await expectIndicatorHeight(foregroundIndicator, 32)
    await expectIndicatorHeight(homeIndicator, 0)
    await homeButton.hover()
    await expectIndicatorHeight(homeIndicator, 20)
    await page.mouse.move(300, 300)
    await expectIndicatorHeight(homeIndicator, 0)
    await addButton.hover()
    await expectIndicatorHeight(addIndicator, 20)
    await page.mouse.move(300, 300)
    await expectIndicatorHeight(addIndicator, 0)

    const backgroundIndicator = page.getByTestId(tid.serverRailIndicator(backgroundServer))
    await expectIndicatorHeight(backgroundIndicator, 0)
    const firstBody = `background unread ${stamp}`
    await seedMessage("alice", backgroundChannel, firstBody)
    await expectIndicatorHeight(backgroundIndicator, 10)

    const backgroundIcon = page.getByTestId(tid.serverIcon(backgroundServer))
    await backgroundIcon.hover()
    await expectIndicatorHeight(backgroundIndicator, 20)
    await page.mouse.move(300, 300)
    await expectIndicatorHeight(backgroundIndicator, 10)
    await backgroundIcon.focus()
    await expectIndicatorHeight(backgroundIndicator, 20)
    await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
    await expectIndicatorHeight(backgroundIndicator, 10)

    await combineServers(page, backgroundServer, neutralServer)
    const folder = page.locator(`[data-testid^="${tid.serverRailFolder("")}"]`).first()
    await expect(folder).toBeVisible()
    const folderTestId = await folder.getAttribute("data-testid")
    if (!folderTestId) throw new Error("missing folder testid")
    const folderId = folderTestId.slice(tid.serverRailFolder("").length)
    const folderIndicator = page.getByTestId(tid.serverRailFolderIndicator(folderId))
    await page.mouse.move(300, 300)
    await page.getByRole("link", { name: "Home" }).focus()
    await expectIndicatorHeight(folderIndicator, 0)
    await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
    await expectIndicatorHeight(backgroundIndicator, 10)
    await folder.click()
    await expect(folder).toHaveAttribute("aria-expanded", "false")
    await expect(backgroundIcon).not.toBeInViewport()
    await page.mouse.move(300, 300)
    await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
    await expectIndicatorHeight(folderIndicator, 10)
    await folder.click()
    await expect(backgroundIcon).toBeVisible()
    await page.mouse.move(300, 300)
    await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
    await expectIndicatorHeight(backgroundIndicator, 10)

    await backgroundIcon.click()
    await expectIndicatorHeight(backgroundIndicator, 32)
    await folder.click()
    await expect(folder).toHaveAttribute("aria-expanded", "false")
    await expect(backgroundIcon).not.toBeInViewport()
    await expectIndicatorHeight(folderIndicator, 32)
    await folder.click()
    await expect(backgroundIcon).toBeVisible()
    await expectIndicatorHeight(backgroundIndicator, 32)
    const backgroundChannelRow = page.getByTestId(tid.channelRow(backgroundChannel))
    await expect(backgroundChannelRow).toBeVisible({ timeout: 30_000 })
    const readResponse = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${backgroundChannel}/read`
    ))
    await page.goto(`/c/channels/${backgroundServer}/${backgroundChannel}`)
    await expect(page.getByText(firstBody, { exact: true })).toBeVisible({ timeout: 30_000 })
    expect((await readResponse).status()).toBe(200)
    await page.getByTestId(tid.serverIcon(foregroundServer)).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${foregroundServer}/${foregroundChannel}`,
    )
    await expectIndicatorHeight(folderIndicator, 0)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${foregroundServer}`)
    if (await folder.getAttribute("aria-expanded") !== "true") {
      await folder.click()
      await expect(backgroundIcon).toBeVisible()
    }
    await page.mouse.move(300, 300)
    await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
    const alice = await asUser("alice")
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${backgroundServer}/${backgroundChannel}`)
    const editable = composerEditable(alice.page)
    const sendMention = async (content: string) => {
      const frameStart = ws.frames.length
      const response = alice.page.waitForResponse((candidate) => (
        candidate.request().method() === "POST"
        && new URL(candidate.url()).pathname === `/api/community/channels/${backgroundChannel}/messages`
      ))
      void response.catch(() => {})
      await editable.click()
      await editable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
      await alice.page.getByTestId(tid.mentionOption(bobInfo.id)).click()
      await editable.pressSequentially(` ${content}`)
      await alice.page.keyboard.press("Enter")
      const result = await response
      expect(result.status()).toBe(201)
      const messageId = (await result.json() as { message: { id: string } }).message.id
      await expect.poll(() => {
        const events = ws.frames.slice(frameStart).flatMap(communityFrameEvents)
        return events.some((event) => event.type === "community:message.create" && event.message?.id === messageId)
          && events.some((event) => event.type === "community:unread.bump"
            && event.channelId === backgroundChannel && event.serverId === backgroundServer
            && event.userId === userId("bob") && event.isMention === true)
      }).toBe(true)
      snapshots.push({ stage: "mention-receipt", at: Date.now(), content, messageId,
        status: result.status(), events: ws.frames.slice(frameStart).flatMap(communityFrameEvents) })
      return messageId
    }
    const secondBody = `mobile background mention ${stamp}`
    await sendMention(secondBody)
    await expectIndicatorHeight(backgroundIndicator, 10)
    await expect(page.getByTestId(tid.railUnreadBadge(backgroundServer))).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath("server-rail-unread-390.png"),
      fullPage: true,
    })

    const seed = await confirmCommunityFixtureApiResponse(page.request.get("/api/community/servers", { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
    expect(seed.status()).toBe(200)
    const body = await seed.json() as { servers: Array<{ id: string; unread: boolean }> }
    expect(body.servers.find((server) => server.id === backgroundServer)?.unread).toBe(true)

    const badge = page.getByTestId(tid.railUnreadBadge(backgroundServer))
    const flow = badge.locator("number-flow-react")
    const railContainer = backgroundIcon.locator("xpath=ancestor::nav[1]/..")
    const readDigits = () => flow.evaluate((element) => {
      const number = element.shadowRoot?.querySelector<HTMLElement>('[part="number"]')
      const bounds = number?.getBoundingClientRect()
      const badgeBounds = element.parentElement!.getBoundingClientRect()
      const characters = [...element.shadowRoot?.querySelectorAll<HTMLElement>(
        '[part~="integer"] > [part~="digit"]:not([inert]) .digit__num:not([inert])',
      ) ?? []]
      return {
        text: characters.map((character) => character.textContent).join(""),
        width: bounds?.width ?? 0, height: bounds?.height ?? 0,
        storedWidth: number?.style.getPropertyValue("--width") ?? "",
        characters: characters.map((character) => {
          const rect = character.getBoundingClientRect()
          const style = getComputedStyle(character)
          return { text: character.textContent, width: rect.width, height: rect.height,
            visibility: style.visibility, opacity: style.opacity,
            intersectsBadge: rect.right > badgeBounds.left && rect.left < badgeBounds.right
              && rect.bottom > badgeBounds.top && rect.top < badgeBounds.bottom }
        }),
        animations: element.shadowRoot?.getAnimations().map((animation) => ({
          playState: animation.playState, pending: animation.pending, currentTime: animation.currentTime,
        })) ?? [],
      }
    })
    const expectPrimaryCount = async (stage: string, count: number) => {
      const response = await confirmCommunityFixtureApiResponse(page.request.get("/api/community/users/me/attention", { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
      expect(response.status()).toBe(200)
      const raw: unknown = await response.json()
      expect(raw).not.toHaveProperty("stale", true)
      const snapshot = AccountAttentionSnapshotSchema.parse(raw)
      const actualCount = snapshot.scopes.filter((scope) => scope.serverId === backgroundServer)
        .reduce((total, scope) => total + scope.attentionCount, 0)
      snapshots.push({ stage: `${stage}-primary`, at: Date.now(), count, actualCount,
        status: response.status(), snapshot })
      expect(actualCount).toBe(count)
    }
    const capture = async (stage: string, count: number) => {
      const mounted = await flow.count()
      snapshots.push({ stage, at: Date.now(), count, mounted, digits: mounted ? await readDigits() : null })
      await testInfo.attach(`server-digits-${stage}.png`, {
        body: await page.screenshot(), contentType: "image/png",
      })
      if (await badge.isVisible()) await testInfo.attach(`server-digits-${stage}-badge.png`, {
        body: await badge.screenshot(), contentType: "image/png",
      })
    }
    const expectVisibleDigits = async (stage: string, count: number) => {
      await expect(badge).toBeVisible()
      await expect(flow).toHaveCount(1)
      await expect.poll(async () => (await readDigits()).text).toBe(String(count))
      await capture(`${stage}-transition`, count)
      await expect.poll(async () => (await readDigits()).animations.filter((animation) => (
        animation.playState === "running" || animation.pending
      )).length).toBe(0)
      const digits = await readDigits()
      expect(digits.width).toBeGreaterThan(0)
      expect(digits.height).toBeGreaterThan(0)
      expect(digits.characters).toHaveLength(String(count).length)
      for (const character of digits.characters) {
        expect(character.width).toBeGreaterThan(0)
        expect(character.height).toBeGreaterThan(0)
        expect(character.visibility).toBe("visible")
        expect(Number(character.opacity)).toBeGreaterThan(0)
        expect(character.intersectsBadge).toBe(true)
      }
      await expectPrimaryCount(stage, count)
      await capture(stage, count)
    }
    await expectVisibleDigits("visible", 1)
    for (let count = 2; count <= 9; count += 1) {
      await sendMention(`Server digit precondition ${stamp} ${count}`)
      await expect.poll(async () => (await readDigits()).text).toBe(String(count))
    }
    await expectVisibleDigits("before-detail", 9)
    const retained = await flow.elementHandle()
    expect(retained).not.toBeNull()
    await page.getByTestId(tid.channelRow(foregroundChannel)).click()
    await expect(page).toHaveURL(`/c/channels/${foregroundServer}/${foregroundChannel}`)
    await expectInertBackground(railContainer)
    await expect(railContainer).toHaveAttribute("inert", "")
    await expect(railContainer).toHaveAttribute("aria-hidden", "true")
    let lastMessageId = await sendMention(`Hidden Server digit ${stamp}`)
    await expect.poll(async () => (await readDigits()).text).toBe("10")
    await expectPrimaryCount("hidden-update", 10)
    await capture("hidden-update", 10)
    await page.getByRole("banner").getByRole("button", { name: "Back", exact: true }).click()
    await expect(page).toHaveURL(`/c/channels/${foregroundServer}`)
    expect(await flow.evaluate((element, prior) => element === prior, retained)).toBe(true)
    await expectVisibleDigits("first-return", 10)

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await page.getByTestId(tid.channelRow(foregroundChannel)).click()
      await expectInertBackground(railContainer)
      await expect(railContainer).toHaveAttribute("inert", "")
      await expect(railContainer).toHaveAttribute("aria-hidden", "true")
      lastMessageId = await sendMention(`Repeated hidden Server ${stamp} ${cycle}`)
      const count = 11 + cycle
      await expect.poll(async () => (await readDigits()).text).toBe(String(count))
      await expectPrimaryCount(`hidden-repeat-${cycle}`, count)
      await capture(`hidden-repeat-${cycle}`, count)
      await page.getByRole("banner").getByRole("button", { name: "Back", exact: true }).click()
      await expect(page).toHaveURL(`/c/channels/${foregroundServer}`)
      expect(await flow.evaluate((element, prior) => element === prior, retained)).toBe(true)
      await expectVisibleDigits(`repeat-return-${cycle}`, count)
    }

    await backgroundIcon.click()
    await expect(page).toHaveURL(`/c/channels/${backgroundServer}`)
    const clearResponse = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/community/channels/${backgroundChannel}/read`
      && (response.request().postDataJSON() as { lastReadMessageId?: string } | null)?.lastReadMessageId === lastMessageId
    ))
    void clearResponse.catch(() => {})
    await page.getByTestId(tid.channelRow(backgroundChannel)).click()
    await expect(page.getByTestId(tid.message(lastMessageId))).toBeVisible()
    await expect(page.getByTestId(tid.message(lastMessageId))).toBeInViewport({ ratio: 0.2 })
    const cleared = await clearResponse
    expect(cleared.status()).toBe(200)
    expect(await cleared.json()).toMatchObject({ targetSeq: 13 })
    await expect(badge).toHaveCount(0)
    await expectPrimaryCount("read-clear", 0)
    await capture("read-clear", 0)
    await page.getByRole("banner").getByRole("button", { name: "Back", exact: true }).click()
    await expect(page).toHaveURL(`/c/channels/${backgroundServer}`)
    await expect(badge).toHaveCount(0)
    await sendMention(`Server positive again ${stamp}`)
    await expectVisibleDigits("positive-again", 1)
    expect(await flow.evaluate((element, prior) => element === prior, retained)).toBe(false)
    const beforeFolder = await flow.elementHandle()
    expect(beforeFolder).not.toBeNull()
    await folder.click()
    await expect(folder).toHaveAttribute("aria-expanded", "false")
    await expect(backgroundIcon).not.toBeInViewport()
    await sendMention(`Server folder update ${stamp}`)
    await expectPrimaryCount("folder-hidden", 2)
    await capture("folder-hidden", 2)
    await folder.click()
    await expectVisibleDigits("folder-reopen", 2)
    expect(await flow.evaluate((element, prior) => element === prior, beforeFolder)).toBe(true)
  })


  test("Home retains touch focus without an inactive bar and keeps keyboard feedback", async ({ caseActors }) => {
    test.setTimeout(150_000)
    const actors = await caseActors(["alice", "bob"])
    const serverId = await actors.seed.seedServer("alice", `Touch focus ${Date.now()}`)
    const otherServerId = await actors.seed.seedServer("alice", `Touch target ${Date.now()}`)
    await actors.seed.seedJoinServer("alice", "bob", serverId)
    await actors.seed.seedJoinServer("alice", "bob", otherServerId)
    const { page } = await actors.asUser("bob", {
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    })
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}`)
    const home = page.getByTestId(tid.homeButton)
    const server = page.getByTestId(tid.serverIcon(serverId))
    const homeIndicator = home.locator("xpath=preceding-sibling::*[@data-slot='community-server-rail-indicator']")
    await home.tap()
    await expect(page).toHaveURL(/\/c\/me$/)
    await expect(home).toHaveAttribute("aria-current", "page")
    await expectIndicatorHeight(homeIndicator, 32)
    await server.tap()
    await expect(page).toHaveURL(new RegExp(`/c/channels/${serverId}$`))
    await expect(server).toHaveAttribute("aria-current", "page")
    await expect(home).not.toHaveAttribute("aria-current", "page")
    await expectIndicatorHeight(page.getByTestId(tid.serverRailIndicator(serverId)), 32)
    await home.focus()
    expect(await home.evaluate((element) => element.matches(":focus-visible"))).toBe(false)
    await expectIndicatorHeight(homeIndicator, 0)
    await page.keyboard.press("Tab")
    await home.focus()
    expect(await home.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
    await expectIndicatorHeight(homeIndicator, 20)
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(/\/c\/me$/)
    await expectIndicatorHeight(homeIndicator, 32)
  })
})

test.describe("account unread projection", () => {
  async function installReadObserverGate(page: Page, initiallyBlocked = false) {
    await page.addInitScript((blockInitially) => {
      const NativeIntersectionObserver = window.IntersectionObserver
      const queued: Array<() => void> = []
      let blocked = blockInitially
      class GatedIntersectionObserver implements IntersectionObserver {
        readonly root: Element | Document | null
        readonly rootMargin: string
        readonly scrollMargin: string
        readonly thresholds: readonly number[]
        private readonly observer: IntersectionObserver

        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          this.observer = new NativeIntersectionObserver((entries) => {
            const deliver = () => callback(entries, this)
            if (blocked && entries.some((entry) => (
              (entry.target as HTMLElement).hasAttribute("data-msg-id")
            ))) {
              queued.push(deliver)
              return
            }
            deliver()
          }, options)
          this.root = this.observer.root
          this.rootMargin = this.observer.rootMargin
          this.scrollMargin = this.observer.scrollMargin
          this.thresholds = this.observer.thresholds
        }

        disconnect() { this.observer.disconnect() }
        observe(target: Element) { this.observer.observe(target) }
        takeRecords() { return this.observer.takeRecords() }
        unobserve(target: Element) { this.observer.unobserve(target) }
      }
      window.IntersectionObserver = GatedIntersectionObserver
      ;(window as unknown as Record<string, unknown>).__accountUnreadObserverGate = {
        block: () => { blocked = true },
        pending: () => queued.length,
        release: () => {
          blocked = false
          for (const deliver of queued.splice(0)) deliver()
        },
      }
    }, initiallyBlocked)
    const invoke = async (method: "block" | "pending" | "release") => page.evaluate((name) => {
      const gate = (window as unknown as Record<string, {
        block: () => void
        pending: () => number
        release: () => void
      }>).__accountUnreadObserverGate
      return gate[name]()
    }, method)
    return {
      block: () => invoke("block"),
      pending: () => invoke("pending") as Promise<number>,
      release: () => invoke("release"),
    }
  }

  function hasCorrelatedBundle(
    frames: CapturedCommunityFrame[],
    messageId: string,
    channelId: string,
  ) {
    return frames.some((frame) => {
      if (!isCommunityBatchFrame(frame)) return false
      const events = communityFrameEvents(frame)
      return events.some((event) => (
        event.type === "community:message.create"
        && event.message?.id === messageId
        && event.message?.seq !== undefined
      )) && events.some((event) => (
        event.type === "community:unread.bump"
        && event.channelId === channelId
      ))
    })
  }

  async function expectUnreadDot(row: ReturnType<Page["getByTestId"]>, height = "10px") {
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row.locator('[data-slot="community-channel-unread-indicator"]')).toHaveCSS("height", height)
  }

  async function expectNoUnreadDot(row: ReturnType<Page["getByTestId"]>) {
    await expect(row.locator('[data-slot="community-channel-unread-indicator"]')).toHaveCSS("height", "0px")
  }

  async function readSeq(page: Page, channelId: string): Promise<number> {
    const response = await confirmCommunityFixtureApiResponse(page.request.get("/api/community/users/me/read-state", { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
    expect(response.ok()).toBe(true)
    const snapshot = await response.json() as {
      readStates: Array<{ channelId: string; lastReadSeq: number }>
    }
    return snapshot.readStates.find((row) => row.channelId === channelId)?.lastReadSeq ?? 0
  }

  async function expectReadbackDoesNotBlockMessages({
    page,
    observerGate,
    href,
    channelId,
    latestText,
    inboxRowTestId,
    triggerUnread,
    triggerReadback,
  }: {
    page: Page
    observerGate: Awaited<ReturnType<typeof installReadObserverGate>>
    href: string
    channelId: string
    latestText: string
    inboxRowTestId: string
    triggerUnread: () => Promise<string>
    triggerReadback: () => Promise<void>
  }, caseResources: CaseResources) {
    const beforeReadSeq = await readSeq(page, channelId)
    const latestId = await triggerUnread()
    await page.getByTestId(tid.inboxTrigger).click()
    await expect(page.getByTestId(inboxRowTestId)).toBeVisible({ timeout: 30_000 })
    await page.getByTestId(tid.inboxTrigger).click()
    let releaseRailGate!: () => void
    const railRelease = new Promise<void>((resolve) => { releaseRailGate = resolve })
    caseResources.own(releaseRailGate, async (captured) => { captured() })
    let markRailHeld!: () => void
    const railHeld = new Promise<void>((resolve) => { markRailHeld = resolve })
    caseResources.own(markRailHeld, async (captured) => { captured() })
    let markRailSettled!: () => void
    const railSettled = new Promise<void>((resolve) => { markRailSettled = resolve })
    caseResources.own(markRailSettled, async (captured) => { captured() })
    let railRequestHeld = false
    const releaseRail = async () => {
      releaseRailGate()
      if (railRequestHeld) await railSettled
    }
    let readbackRequests = 0
    let messagesRequests = 0

    const readbackPattern = "**/api/community/users/me/read-state"
    await page.route(readbackPattern, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue()
        return
      }
      readbackRequests += 1
      if (readbackRequests === 1) {
        railRequestHeld = true
        markRailHeld()
        await railRelease
        try {
          await route.continue()
        } finally {
          markRailSettled()
        }
        return
      }
      await route.continue()
    })
    const countMessagesRequest = (request: Request) => {
      if (
        request.method() === "GET"
        && new URL(request.url()).pathname === `/api/community/channels/${channelId}/messages`
      ) messagesRequests += 1
    }
    page.on("request", countMessagesRequest)

    try {
      await triggerReadback()
      await railHeld
      await page.getByTestId(tid.inboxTrigger).click()
      const inboxRow = page.getByTestId(inboxRowTestId)
      await expect(inboxRow).toBeVisible({ timeout: 30_000 })
      const messagesResponse = page.waitForResponse((response) => (
        response.request().method() === "GET"
        && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
        && response.status() === 200
      ), { timeout: 30_000 })
      await inboxRow.click()

      const response = await messagesResponse
      expect(readbackRequests).toBeGreaterThanOrEqual(1)
      expect(messagesRequests).toBeGreaterThanOrEqual(1)
      expect(await readSeq(page, channelId)).toBe(beforeReadSeq)
      await releaseRail()

      const body = await response.json() as { messages: Array<{ id: string; seq: number }> }
      expect(body.messages.at(-1)?.id).toBe(latestId)
      await expect(page).toHaveURL(href)
      await expect(page.getByText(latestText, { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(latestText, { exact: true })).toHaveCount(1)
      await expect.poll(observerGate.pending, { timeout: 20_000 }).toBeGreaterThan(0)
      expect(await readSeq(page, channelId)).toBe(beforeReadSeq)

      const readResponse = page.waitForResponse((candidate) => (
        candidate.request().method() === "PUT"
        && new URL(candidate.url()).pathname === `/api/community/channels/${channelId}/read`
      ))
      await observerGate.release()
      expect((await readResponse).status()).toBe(200)
      await expect.poll(() => readSeq(page, channelId), { timeout: 20_000 })
        .toBeGreaterThan(beforeReadSeq)
    } finally {
      await releaseRail()
      page.off("request", countMessagesRequest)
      await page.unroute(readbackPattern)
    }
  }

  test.describe("account unread projection", () => {
  test.setTimeout(180_000)

    test("one mention source disappears from Unreads, Mentions, and every dot in the same frame", async ({ caseActors }) => {
      const actors = await caseActors(["alice", "bob"])
      const { asUser, userId } = actors
      const { memberInfo, seedChannel, seedJoinServer, seedServer } = actors.seed

      const stamp = Date.now()
      const serverId = await seedServer("alice", `Projection mention ${stamp}`)
      const channelName = `mention-${stamp}`
      const channelId = await seedChannel("alice", serverId, channelName)
      await seedJoinServer("alice", "bob", serverId)
      const bobInfo = await memberInfo("alice", serverId, userId("bob"))

      const bob = await asUser("bob")
      for (const path of [
        "/api/community/users/me/inbox/mentions/read-all",
        "/api/community/users/me/inbox/unreads/read-all",
        "/api/community/users/me/inbox/dms/read-all",
      ]) {
        expect((await confirmCommunityFixtureApiResponse(bob.page.request.post(path, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))).ok()).toBe(true)
      }
      const observerGate = await installReadObserverGate(bob.page)
      const proxy = await proxyCommunityWebSockets(bob.context)
      await gotoAfterUserWsAuth(bob.page, "/c/me/friends")
      await expect(bob.page.getByTestId(tid.serverIcon(serverId))).toBeVisible({ timeout: 30_000 })

      const alice = await asUser("alice")
      await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
      const mentionText = `Canonical mention ${stamp}`
      const frameStart = proxy.frames.length
      const response = alice.page.waitForResponse((candidate) => (
        candidate.request().method() === "POST"
        && new URL(candidate.url()).pathname === `/api/community/channels/${channelId}/messages`
      ))
      const editable = composerEditable(alice.page)
      await editable.click()
      await editable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
      await alice.page.getByTestId(tid.mentionOption(bobInfo.id)).click()
      await editable.pressSequentially(` ${mentionText}`)
      await alice.page.keyboard.press("Enter")
      const messageResponse = await response
      expect(messageResponse.status()).toBe(201)
      const messageId = (await messageResponse.json() as { message: { id: string } }).message.id
      await expect.poll(() => {
        const events = proxy.frames.slice(frameStart).flatMap(communityFrameEvents)
        return events.some((event) => (
          event.type === "community:message.create"
          && event.message?.id === messageId
        )) && events.some((event) => (
          event.type === "community:unread.bump"
          && event.channelId === channelId
        )) && events.some((event) => (
          event.type === "community:mention.create"
          && event.messageId === messageId
        ))
      }, { timeout: 20_000 }).toBe(true)

      const inboxTrigger = bob.page.getByTestId(tid.inboxTrigger)
      await expect(inboxTrigger.locator('[data-slot="inbox-unread-indicator"]')).toHaveAttribute("data-unread", "true")
      await inboxTrigger.click()
      await expect(bob.page.getByTestId(tid.inboxUnreadChannel(channelId))).toBeVisible()
      await expect(bob.page.getByRole("tab", { name: "Mentions", exact: true })).toHaveCount(0)
      await bob.page.getByTestId(tid.inboxToggleChannel(channelId)).click()
      await expect(bob.page.getByTestId(tid.inboxUnreadCard(channelId)).getByText(mentionText, { exact: false })).toBeVisible()
      await bob.page.getByTestId(tid.inboxToggleChannel(channelId)).click()

      await observerGate.block()
      await bob.page.getByTestId(tid.inboxUnreadChannel(channelId)).click()
      await expect(bob.page).toHaveURL(`/c/channels/${serverId}/${channelId}`)
      await expect(bob.page.getByText(mentionText, { exact: false })).toBeVisible({ timeout: 20_000 })
      await expect.poll(observerGate.pending).toBeGreaterThan(0)
      await expect(inboxTrigger.locator('[data-slot="inbox-unread-indicator"]')).toHaveAttribute("data-count", "0")
      await expectNoUnreadDot(bob.page.getByTestId(tid.channelRow(channelId)))
      await expect.poll(async () => bob.page
        .getByTestId(tid.serverRailIndicator(serverId))
        .evaluate((element) => element.getBoundingClientRect().height)).toBe(32)
      await expect(bob.page.getByTestId(tid.railUnreadBadge(serverId))).toHaveCount(0)

      await inboxTrigger.click()
      await expect(bob.page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)
      await expect(bob.page.getByRole("tab", { name: "Unreads" }).locator("span.bg-primary")).toHaveCount(0)
      const inboxPanel = bob.page.getByTestId(tid.inboxTabList).locator("xpath=..")
      await expect(inboxPanel.getByText(mentionText, { exact: false })).toHaveCount(0)
      await expect(bob.page.getByRole("tab", { name: "Mentions", exact: true })).toHaveCount(0)

      const readResponse = bob.page.waitForResponse((candidate) => (
        candidate.request().method() === "PUT"
        && new URL(candidate.url()).pathname === `/api/community/channels/${channelId}/read`
      ))
      await observerGate.release()
      expect((await readResponse).status()).toBe(200)
    })

    test("one committed bundle projects every surface and only a visible row clears it", async ({ caseActors }, testInfo) => {
      const actors = await caseActors(["alice", "bob"])
      const { asUser, userId } = actors
      const { seedChannel, seedDm, seedDmMessage, seedForumThread, seedJoinServer, seedMessage, seedServer } = actors.seed

      const stamp = Date.now()
      const foregroundServer = await seedServer("alice", `Projection foreground ${stamp}`)
      const foregroundChannel = await seedChannel("alice", foregroundServer, `foreground-${stamp}`)
      const backgroundServer = await seedServer("alice", `Projection background ${stamp}`)
      const landingChannel = await seedChannel("alice", backgroundServer, `landing-${stamp}`)
      const unreadChannel = await seedChannel("alice", backgroundServer, `unread-${stamp}`)
      const forumId = await seedChannel("alice", backgroundServer, `forum-${stamp}`, "forum")
      await seedJoinServer("alice", "bob", foregroundServer)
      await seedJoinServer("alice", "bob", backgroundServer)
      const forumChild = await seedForumThread(
        "bob",
        forumId,
        `Projection post ${stamp}`,
        `Bob participation ${stamp}`,
      )
      const dmId = await seedDm("alice", userId("bob"))

      const { context, page } = await asUser("bob")
      await page.setViewportSize({ width: 1280, height: 900 })
      const observerGate = await installReadObserverGate(page)
      const proxy = await proxyCommunityWebSockets(context)
      await gotoAfterUserWsAuth(page, `/c/channels/${foregroundServer}/${foregroundChannel}`)
      await expect(page.getByTestId(tid.serverIcon(backgroundServer))).toBeVisible({ timeout: 30_000 })
      const beforeSnapshot = await (await confirmCommunityFixtureApiResponse(page.request.get(
        "/api/community/users/me/read-state", { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS },
      ))).json() as { readStates: Array<{ channelId: string; lastReadSeq: number }> }
      const beforeCursor = (channelId: string) => beforeSnapshot.readStates
        .find((row) => row.channelId === channelId)?.lastReadSeq ?? 0

      const frameStart = proxy.frames.length
      const channelMessage = await seedMessage("alice", unreadChannel, `Projected channel ${stamp}`)
      const childMessage = await seedMessage("alice", forumChild, `Projected forum child ${stamp}`)
      const dmMessage = await seedDmMessage("alice", dmId, `Projected DM ${stamp}`)
      for (const [messageId, channelId] of [
        [channelMessage, unreadChannel],
        [childMessage, forumChild],
        [dmMessage, dmId],
      ]) {
        await expect.poll(() => hasCorrelatedBundle(
          proxy.frames.slice(frameStart),
          messageId,
          channelId,
        ), { timeout: 20_000 }).toBe(true)
      }

      await expect.poll(async () => page
        .getByTestId(tid.serverRailIndicator(backgroundServer))
        .evaluate((element) => element.getBoundingClientRect().height), {
        timeout: 20_000,
      }).toBe(10)
      await gotoAfterUserWsAuth(
        page,
        `/c/channels/${backgroundServer}/${landingChannel}`,
      )
      await expect(page).toHaveURL(`/c/channels/${backgroundServer}/${landingChannel}`)
      await expectUnreadDot(page.getByTestId(tid.channelRow(unreadChannel)))

      await gotoAfterUserWsAuth(page, `/c/channels/${backgroundServer}/${forumId}`)
      await expect(page).toHaveURL(`/c/channels/${backgroundServer}/${forumId}`)
      await expectUnreadDot(page.getByTestId(tid.forumSidebarThread(forumChild)), "4px")
      await page.getByRole("button", { name: "Inbox", exact: true }).click()
      await expect(page.getByTestId(tid.inboxUnreadChannel(unreadChannel))).toBeVisible()
      await expect(page.getByTestId(tid.inboxUnreadChild(forumChild))).toBeVisible()
      await expect(page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()
      await page.waitForTimeout(500)
      await page.screenshot({
        path: testInfo.outputPath("account-unread-projection-1280.png"),
        fullPage: true,
      })

      await observerGate.block()
      const targetPuts: string[] = []
      page.on("request", (request) => {
        if (
          request.method() === "PUT"
          && new URL(request.url()).pathname === `/api/community/channels/${unreadChannel}/read`
        ) targetPuts.push(request.url())
      })
      await page.getByTestId(tid.inboxUnreadChannel(unreadChannel)).click()
      await expect(page).toHaveURL(`/c/channels/${backgroundServer}/${unreadChannel}`)
      await expect(page.getByText(`Projected channel ${stamp}`, { exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect.poll(observerGate.pending).toBeGreaterThan(0)
      await expectNoUnreadDot(page.getByTestId(tid.channelRow(unreadChannel)))
      await page.getByTestId(tid.inboxTrigger).click()
      await expect(page.getByTestId(tid.inboxUnreadChannel(unreadChannel))).toHaveCount(0)
      await expect(page.getByTestId(tid.inboxUnreadChild(forumChild))).toBeVisible()
      await expect(page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()
      await expect(page.getByTestId(tid.inboxTrigger).locator('[data-slot="inbox-unread-indicator"]')).toHaveAttribute("data-count", "2")
      await page.getByTestId(tid.inboxTrigger).click()
      expect(targetPuts).toEqual([])

      const readResponse = page.waitForResponse((response) => (
        response.request().method() === "PUT"
        && new URL(response.url()).pathname === `/api/community/channels/${unreadChannel}/read`
      ))
      await observerGate.release()
      expect((await readResponse).status()).toBe(200)
      expect(targetPuts).toHaveLength(1)

      await page.setViewportSize({ width: 390, height: 844 })
      await gotoAfterUserWsAuth(page, "/c/me")
      await page.getByTestId(tid.inboxTrigger).click()
      await expect(page.getByTestId(tid.inboxUnreadChannel(unreadChannel))).toHaveCount(0)
      await expect(page.getByTestId(tid.inboxUnreadChild(forumChild))).toBeVisible()
      await expect(page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()
      await page.waitForTimeout(500)
      await page.screenshot({
        path: testInfo.outputPath("account-unread-projection-390.png"),
        fullPage: true,
      })

      const snapshot = await (await confirmCommunityFixtureApiResponse(page.request.get(
        "/api/community/users/me/read-state", { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS },
      ))).json() as { readStates: Array<{ channelId: string; lastReadSeq: number }> }
      const cursor = (channelId: string) => snapshot.readStates
        .find((row) => row.channelId === channelId)?.lastReadSeq ?? 0
      expect(cursor(unreadChannel)).toBeGreaterThan(beforeCursor(unreadChannel))
      expect(cursor(forumChild)).toBe(beforeCursor(forumChild))
      expect(cursor(dmId)).toBe(beforeCursor(dmId))
    })

    test("a held canonical read-state request does not block channel or child messages", async ({ caseActors, caseResources }) => {
      const actors = await caseActors(["alice", "bob"])
      const { asUser, userId } = actors
      const { memberInfo, seedChannel, seedForumThread, seedJoinServer, seedMessage, seedServer } = actors.seed

      const stamp = Date.now()
      const foregroundServer = await seedServer("alice", `Rail foreground ${stamp}`)
      const foregroundChannel = await seedChannel("alice", foregroundServer, `foreground-${stamp}`)
      await seedJoinServer("alice", "bob", foregroundServer)

      const channelServer = await seedServer("alice", `Rail channel target ${stamp}`)
      const channelId = await seedChannel("alice", channelServer, `channel-${stamp}`)
      await seedJoinServer("alice", "bob", channelServer)
      const childServer = await seedServer("alice", `Rail child target ${stamp}`)
      const forumId = await seedChannel("alice", childServer, `forum-${stamp}`, "forum")
      await seedJoinServer("alice", "bob", childServer)
      const childId = await seedForumThread(
        "bob",
        forumId,
        `Child ${stamp}`,
        `Child participation ${stamp}`,
      )
      const railTriggerServer = await seedServer("alice", `Rail mention trigger ${stamp}`)
      const railTriggerChannel = await seedChannel(
        "alice",
        railTriggerServer,
        `mention-trigger-${stamp}`,
      )
      await seedJoinServer("alice", "bob", railTriggerServer)
      const bobInfo = await memberInfo("alice", railTriggerServer, userId("bob"))
      const channelText = `Rail-independent channel ${stamp}`
      const childText = `Rail-independent child ${stamp}`

      const { context, page } = await asUser("bob")
      await page.setViewportSize({ width: 1280, height: 900 })
      const channelObserverGate = await installReadObserverGate(page, true)
      const childPage = await context.newPage()
      await childPage.setViewportSize({ width: 390, height: 844 })
      const childObserverGate = await installReadObserverGate(childPage, true)
      await Promise.all([
        gotoAfterUserWsAuth(page, `/c/channels/${foregroundServer}/${foregroundChannel}`),
        gotoAfterUserWsAuth(childPage, `/c/channels/${foregroundServer}/${foregroundChannel}`),
      ])
      await Promise.all([
        expect(page.getByTestId(tid.serverIcon(channelServer))).toBeVisible({ timeout: 30_000 }),
        expect(page.getByTestId(tid.serverIcon(childServer))).toBeVisible({ timeout: 30_000 }),
        expect(page.getByTestId(tid.channelComposerShell)).toBeVisible({ timeout: 30_000 }),
        expect(childPage.getByTestId(tid.channelComposerShell)).toBeVisible({ timeout: 30_000 }),
      ])

      const alice = await asUser("alice")
      await gotoAfterUserWsAuth(
        alice.page,
        `/c/channels/${railTriggerServer}/${railTriggerChannel}`,
      )
      const triggerComposer = composerEditable(alice.page)
      await expect(triggerComposer).toBeVisible({ timeout: 30_000 })
      const sendRailMention = async (label: string) => {
        const response = alice.page.waitForResponse((candidate) => (
          candidate.request().method() === "POST"
          && new URL(candidate.url()).pathname
            === `/api/community/channels/${railTriggerChannel}/messages`
        ))
        await triggerComposer.click()
        await triggerComposer.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
        await alice.page.getByTestId(tid.mentionOption(bobInfo.id)).click()
        await triggerComposer.pressSequentially(` ${label}`)
        await alice.page.keyboard.press("Enter")
        const sent = await response
        expect(sent.status()).toBe(201)
        const body = await sent.json() as { message: { id: string } }
        return body.message.id
      }

      await expectReadbackDoesNotBlockMessages({
        page,
        observerGate: channelObserverGate,
        href: `/c/channels/${channelServer}/${channelId}`,
        channelId,
        latestText: channelText,
        inboxRowTestId: tid.inboxUnreadChannel(channelId),
        triggerUnread: () => seedMessage("alice", channelId, channelText),
        triggerReadback: async () => {
          const messageId = await sendRailMention(`channel readback ${stamp}`)
          expect((await confirmCommunityFixtureApiResponse(page.request.put(`/api/community/channels/${railTriggerChannel}/read`, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
            data: { lastReadMessageId: messageId },
          }))).status()).toBe(200)
        },
      }, caseResources)

      await gotoAfterUserWsAuth(childPage, "/c/me")
      await expectReadbackDoesNotBlockMessages({
        page: childPage,
        observerGate: childObserverGate,
        href: `/c/channels/${childServer}/${childId}`,
        channelId: childId,
        latestText: childText,
        inboxRowTestId: tid.inboxUnreadChild(childId),
        triggerUnread: () => seedMessage("alice", childId, childText),
        triggerReadback: async () => {
          const messageId = await sendRailMention(`child readback ${stamp}`)
          expect((await confirmCommunityFixtureApiResponse(childPage.request.put(`/api/community/channels/${railTriggerChannel}/read`, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
            data: { lastReadMessageId: messageId },
          }))).status()).toBe(200)
        },
      }, caseResources)
      await childPage.close()
    })

    test("mark all settles three domains and rolls back only the failed domain", async ({ caseActors }) => {
      const actors = await caseActors(["alice", "bob"])
      const { asUser, userId } = actors
      const { seedChannel, seedDm, seedDmMessage, seedJoinServer, seedMessage, seedServer } = actors.seed

      const stamp = Date.now()
      const serverId = await seedServer("alice", `Projection mark all ${stamp}`)
      const channelId = await seedChannel("alice", serverId, `mark-all-${stamp}`)
      await seedJoinServer("alice", "bob", serverId)
      await seedMessage("alice", channelId, `Channel mark all ${stamp}`)
      const dmId = await seedDm("alice", userId("bob"))
      await seedDmMessage("alice", dmId, `DM mark all ${stamp}`)

      const { page } = await asUser("bob")
      await gotoAfterUserWsAuth(page, "/c/me/friends")
      await page.getByRole("button", { name: "Inbox", exact: true }).click()
      await expect(page.getByTestId(tid.inboxUnreadChannel(channelId))).toBeVisible()
      await expect(page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()

      const paths: string[] = []
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname
        if (request.method() === "POST" && path.endsWith("/read-all")) paths.push(path)
      })
      await page.route("**/api/community/users/me/inbox/dms/read-all", async (route) => {
        await route.fulfill(currentCommunityFixtureError("dm read-all unavailable", 503))
      })
      await page.getByRole("button", { name: "Mark all read" }).click()
      await expect.poll(() => paths.length, { timeout: 20_000 }).toBe(3)
      expect([...paths].sort()).toEqual([
        "/api/community/users/me/inbox/dms/read-all",
        "/api/community/users/me/inbox/mentions/read-all",
        "/api/community/users/me/inbox/unreads/read-all",
      ])
      await expect(page.getByTestId(tid.inboxUnreadChannel(channelId))).toHaveCount(0)
      await expect(page.getByTestId(tid.inboxUnreadDm(dmId))).toBeVisible()

      await page.unroute("**/api/community/users/me/inbox/dms/read-all")
      await page.getByRole("button", { name: "Mark all read" }).click()
      await expect(page.getByText("Caught up", { exact: true })).toBeVisible({ timeout: 20_000 })
    })
  })
})
