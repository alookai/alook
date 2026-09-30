import type { Page, Route } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { expectConversationReady, observeConversationTransport } from "./_fixtures/conversation-readiness"

async function holdRoute(page: Page, pathname: string) {
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  let held = 0
  const pattern = `**${pathname}**`
  const handler = async (route: Route) => {
    held += 1
    await gate
    await route.continue()
  }
  await page.route(pattern, handler)
  return {
    held: () => held,
    release: async () => {
      releaseGate()
      await page.waitForTimeout(100)
      await page.unroute(pattern, handler)
    },
  }
}

function channelHeader(page: Page, name: string) {
  return page.getByRole("banner").getByText(name, { exact: true })
}

type SurfaceAnimationRecord = {
  surface: string | null
}

type SurfaceFrameRecord = {
  pathname: string
  surface: string | null
  transform: string
  opacity: string
  rows: string[]
  pendingMain: string | null
  treeScope: string | null
}

async function installSurfaceAnimationProbe(page: Page) {
  const channelRowPrefix = tid.channelRow("")
  await page.addInitScript(({ channelRowPrefix }) => {
    const state = window as typeof window & {
      __communitySurfaceAnimations?: Array<{
        surface: string | null
      }>
      __communitySurfaceFrames?: SurfaceFrameRecord[]
      __communitySurfaceFrameStop?: () => void
    }
    state.__communitySurfaceAnimations = []
    state.__communitySurfaceFrames = []
    const nativeAnimate = Element.prototype.animate
    Element.prototype.animate = function (keyframes, options) {
      if (this.hasAttribute("data-community-mobile-surface")) {
        state.__communitySurfaceAnimations!.push({
          surface: this.getAttribute("data-community-mobile-surface"),
        })
      }
      return nativeAnimate.call(this, keyframes, options)
    }

    let raf = 0
    const sample = () => {
      for (const surface of document.querySelectorAll<HTMLElement>("[data-community-mobile-surface]")) {
        const style = getComputedStyle(surface)
        if (style.display === "none" || surface.getClientRects().length === 0) continue
        const rows = Array.from(surface.querySelectorAll<HTMLElement>(
          `[data-testid^="${channelRowPrefix}"]`,
        )).filter((row) => {
          const rowStyle = getComputedStyle(row)
          return rowStyle.display !== "none" && row.getClientRects().length > 0
        }).map((row) => row.dataset.testid!.replace(channelRowPrefix, ""))
        state.__communitySurfaceFrames!.push({
          pathname: location.pathname,
          surface: surface.getAttribute("data-community-mobile-surface"),
          transform: style.transform,
          opacity: style.opacity,
          rows,
          pendingMain: surface.querySelector<HTMLElement>("[data-community-main-kind]")
            ?.dataset.communityMainKind ?? null,
          treeScope: surface.querySelector<HTMLElement>("[data-community-channel-tree-scope]")
            ?.dataset.communityChannelTreeScope ?? null,
        })
      }
      raf = requestAnimationFrame(sample)
    }
    raf = requestAnimationFrame(sample)
    state.__communitySurfaceFrameStop = () => cancelAnimationFrame(raf)
  }, { channelRowPrefix })
}

async function surfaceAnimations(page: Page): Promise<SurfaceAnimationRecord[]> {
  return page.evaluate(() => (
    window as typeof window & { __communitySurfaceAnimations?: SurfaceAnimationRecord[] }
  ).__communitySurfaceAnimations ?? [])
}

async function clearSurfaceAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as typeof window & {
      __communitySurfaceAnimations?: SurfaceAnimationRecord[]
      __communitySurfaceFrames?: SurfaceFrameRecord[]
    }
    state.__communitySurfaceAnimations = []
    state.__communitySurfaceFrames = []
  })
}

async function surfaceFrames(page: Page): Promise<SurfaceFrameRecord[]> {
  return page.evaluate(() => (
    window as typeof window & { __communitySurfaceFrames?: SurfaceFrameRecord[] }
  ).__communitySurfaceFrames ?? [])
}

function expectStationaryFrames(frames: SurfaceFrameRecord[]) {
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames) {
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(frame.transform)
    expect(frame.opacity).toBe("1")
  }
}

test("community detail reaches target consumer readiness and keeps list surfaces stable", async ({ asUser }, testInfo) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Frame Gate ${stamp}`)
  const channelAName = `frame-a-${stamp}`
  const channelBName = `frame-b-${stamp}`
  const channelA = await seedChannel("alice", serverId, channelAName)
  const channelB = await seedChannel("alice", serverId, channelBName)
  const { page } = await asUser("alice")
  const transport = observeConversationTransport(page)
  try {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/c/channels/${serverId}/${channelA}`)
    await expect(channelHeader(page, channelAName)).toBeVisible({ timeout: 30_000 })
    await expectConversationReady(page, {
      pathname: `/c/channels/${serverId}/${channelA}`, serverId, channelId: channelA, kind: "text", empty: true,
    }, testInfo)

    const readOnlyPostPaths = new Set([
      "/api/community/messages/batch",
      "/api/community/messages/tags/batch",
      "/api/community/channels/participants/batch",
    ])
    const mutations: string[] = []
    page.on("request", (request) => {
      const method = request.method()
      const pathname = new URL(request.url()).pathname
      if (
        !["GET", "HEAD", "OPTIONS"].includes(method)
        && !(method === "POST" && readOnlyPostPaths.has(pathname))
      ) mutations.push(`${method} ${pathname}`)
    })

    const targetPath = `/c/channels/${serverId}/${channelB}`
    type TransitionFrame = {
      atEpochMs: number; atPageMs: number; pathname: string
      headers: string[]; conversations: string[]; scopes: string[]; pending: boolean
    }
    type TransitionObservation = {
      timeOrigin: number
      click: { atEpochMs: number; atPageMs: number; row: string; trusted: boolean } | null
      stopRequestedAt: number | null; stoppedAt: number | null; frames: TransitionFrame[]
    }
    type TransitionWindow = typeof window & {
      __case38Transition?: { stop: () => Promise<TransitionObservation> }
    }
    await page.evaluate(({ rowId, sidebarId, pendingId }) => {
      const observation: TransitionObservation = {
        timeOrigin: performance.timeOrigin, click: null,
        stopRequestedAt: null, stoppedAt: null, frames: [],
      }
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0
          || rect.top >= innerHeight || rect.left >= innerWidth) return false
        for (let node: Element | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node)
          if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility)
            || Number(style.opacity || 1) === 0) return false
        }
        return true
      }
      const sample = () => {
        const atPageMs = performance.now()
        const main = document.querySelector('[data-slot="community-main-panel-content"]')
        const scopes = Array.from(document.querySelectorAll("[data-community-channel-tree-scope]"))
          .filter((owner) => Array.from(owner.querySelectorAll(`[data-testid="${sidebarId}"]`))
            .some((sidebar) => sidebar.closest("[data-community-channel-tree-scope]") === owner && visible(sidebar)))
          .map((owner) => owner.getAttribute("data-community-channel-tree-scope")!)
        observation.frames.push({
          atEpochMs: performance.timeOrigin + atPageMs, atPageMs, pathname: location.pathname,
          headers: Array.from(main?.querySelectorAll('[role="banner"] [data-slot="message-header-identity"] > span[title]') ?? [])
            .filter(visible).map((title) => title.textContent?.trim() ?? ""),
          conversations: Array.from(main?.querySelectorAll('[data-slot="community-conversation-surface"]') ?? [])
            .filter(visible).map((surface) => surface.getAttribute("data-channel-id") ?? "<missing>"),
          scopes: [...new Set(scopes)],
          pending: Array.from(main?.querySelectorAll(`[data-testid="${pendingId}"], [aria-label="Resolving conversation"], [data-community-unresolved-main], [data-message-list-skeleton], [data-message-positioning-skeleton]`) ?? [])
            .some(visible),
        })
      }
      let raf = 0
      const tick = () => { sample(); raf = requestAnimationFrame(tick) }
      const onClick = (event: MouseEvent) => {
        const row = event.target instanceof Element ? event.target.closest(`[data-testid="${rowId}"]`) : null
        if (!event.isTrusted || !row || observation.click) return
        const atPageMs = performance.now()
        observation.click = { atEpochMs: performance.timeOrigin + atPageMs, atPageMs, row: rowId, trusted: event.isTrusted }
        raf = requestAnimationFrame(tick)
      }
      document.addEventListener("click", onClick, true)
      ;(window as TransitionWindow).__case38Transition = {
        stop: () => {
          observation.stopRequestedAt = performance.timeOrigin + performance.now()
          document.removeEventListener("click", onClick, true)
          cancelAnimationFrame(raf)
          return new Promise((resolve) => {
            if (!observation.click) {
              delete (window as TransitionWindow).__case38Transition
              observation.stoppedAt = performance.timeOrigin + performance.now()
              resolve(observation)
              return
            }
            requestAnimationFrame(() => {
              sample()
              observation.stoppedAt = performance.timeOrigin + performance.now()
              delete (window as TransitionWindow).__case38Transition
              resolve(observation)
            })
          })
        },
      }
    }, { rowId: tid.channelRow(channelB), sidebarId: tid.channelSidebarScroll, pendingId: tid.pendingMain("server-conversation") })
    let transition: TransitionObservation | null = null
    try {
      const leafGate = await holdRoute(page, targetPath)
      try {
        await page.getByTestId(tid.channelRow(channelB)).click({ noWaitAfter: true })
        await expect.poll(leafGate.held).toBeGreaterThan(0)
        await testInfo.attach("held-target-route", {
          body: JSON.stringify({ targetPath, channelB, heldCount: leafGate.held(), transport: transport.snapshot() }),
          contentType: "application/json",
        })
      } finally {
        await leafGate.release()
      }
      await expectConversationReady(page, {
        pathname: targetPath, serverId, channelId: channelB, kind: "text", empty: true,
      }, testInfo)
    } finally {
      transition = await page.evaluate(async () => (window as TransitionWindow).__case38Transition?.stop() ?? null)
      await testInfo.attach("rendered-target-transition", {
        body: JSON.stringify({ sourcePath: `/c/channels/${serverId}/${channelA}`, targetPath, transition }),
        contentType: "application/json",
      })
    }
    expect(transition, "transition observation must survive through B readiness").not.toBeNull()
    expect(transition!.click).toMatchObject({ row: tid.channelRow(channelB), trusted: true })
    expect(transition!.frames.length, "post-click rendered observations, not a required pending dwell").toBeGreaterThan(0)
    for (const frame of transition!.frames) {
      expect(frame.atEpochMs).toBeGreaterThan(transition!.click!.atEpochMs)
      expect(frame.pathname).toMatch(new RegExp(`^/c/channels/${serverId}/(?:${channelA}|${channelB})$`))
      expect(frame.scopes).toEqual([`server:${serverId}`])
      expect(frame.headers.filter((name) => name !== channelBName), `stale/wrong header at ${frame.atEpochMs}`).toEqual([])
      expect(frame.conversations.filter((id) => id !== channelB), `stale/wrong conversation at ${frame.atEpochMs}`).toEqual([])
      expect(frame.pending || frame.headers.includes(channelBName) || frame.conversations.includes(channelB),
        `missing rendered checkpoint/target at ${frame.atEpochMs}`).toBe(true)
    }
    const finalFrame = transition!.frames.at(-1)!
    expect(finalFrame.pathname).toBe(targetPath)
    expect(finalFrame.conversations).toContain(channelB)
    await expect(channelHeader(page, channelAName)).toHaveCount(0)
    await expect(page.locator(`[data-slot="community-conversation-surface"][data-channel-id="${channelA}"]`)).toHaveCount(0)
    await expect(channelHeader(page, channelBName)).toBeVisible({ timeout: 30_000 })
    transport.assertHealthy()

    await page.setViewportSize({ width: 390, height: 844 })
    const rootGate = await holdRoute(page, `/c/channels/${serverId}`)
    await page.getByRole("banner").getByRole("button", { name: "Back" }).click({ noWaitAfter: true })
    await expect.poll(rootGate.held).toBeGreaterThan(0)
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
    await expect(channelHeader(page, channelBName)).toBeVisible()
    await page.waitForTimeout(150)
    await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
    await expect(channelHeader(page, channelBName)).toBeVisible()
    await rootGate.release()
    await expect(channelHeader(page, channelBName)).toBeVisible({ timeout: 30_000 })

    await page.goto("/c/me/friends")
    await expect(page.getByPlaceholder("Search friends")).toBeVisible({ timeout: 30_000 })
    const machinesGate = await holdRoute(page, "/c/me/machines")
    await page.getByRole("button", { name: "Machines", exact: true }).click({ noWaitAfter: true })
    await expect.poll(machinesGate.held).toBeGreaterThan(0)
    await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
    await expect(page.getByPlaceholder("Search friends")).toBeVisible()
    await page.waitForTimeout(150)
    await expect(page.getByPlaceholder("Search friends")).toBeVisible()
    await machinesGate.release()
    await expect(page.getByTestId(tid.machinePairOpen))
      .toBeVisible({ timeout: 30_000 })

    expect(mutations).toEqual([])
    transport.assertHealthy()
  } finally {
    await testInfo.attach("conversation-transport", {
      body: JSON.stringify(transport.snapshot()), contentType: "application/json",
    })
    transport.stop()
  }
})

test("mobile route commits stay stationary while sidebar identity survives same-server history", async ({ asUser }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Mobile frame ${stamp}`)
  const fastName = `fast-${stamp}`
  const pendingName = `pending-${stamp}`
  const fastChannel = await seedChannel("alice", serverId, fastName)
  const pendingChannel = await seedChannel("alice", serverId, pendingName)
  const { page } = await asUser("alice")
  await page.setViewportSize({ width: 390, height: 844 })
  await installSurfaceAnimationProbe(page)
  await page.goto(`/c/channels/${serverId}`)

  const fastRow = page.getByTestId(tid.channelRow(fastChannel))
  const sidebarScroll = page.getByTestId(tid.channelSidebarScroll)
  await expect(fastRow).toBeVisible({ timeout: 30_000 })
  await sidebarScroll.evaluate((element) => {
    ;(element as typeof element & { __e2eIdentity?: string }).__e2eIdentity = "stable"
  })
  await fastRow.evaluate((element) => {
    ;(element as typeof element & { __e2eDndOwner?: string }).__e2eDndOwner = "stable"
  })
  await clearSurfaceAnimations(page)

  await fastRow.click()
  await expect.poll(() => new URL(page.url()).pathname)
    .toBe(`/c/channels/${serverId}/${fastChannel}`)
  await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  expect(await surfaceAnimations(page)).toEqual([])
  expectStationaryFrames(await surfaceFrames(page))
  expect(await sidebarScroll.evaluate((element) => (
    element as typeof element & { __e2eIdentity?: string }
  ).__e2eIdentity)).toBe("stable")
  expect(await fastRow.evaluate((element) => (
    element as typeof element & { __e2eDndOwner?: string }
  ).__e2eDndOwner)).toBe("stable")

  await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await expect(fastRow).toBeVisible()
  expect(await surfaceAnimations(page)).toEqual([])
  expectStationaryFrames(await surfaceFrames(page))
  expect(await sidebarScroll.evaluate((element) => (
    element as typeof element & { __e2eIdentity?: string }
  ).__e2eIdentity)).toBe("stable")
  expect(await fastRow.evaluate((element) => (
    element as typeof element & { __e2eDndOwner?: string }
  ).__e2eDndOwner)).toBe("stable")

  await clearSurfaceAnimations(page)
  const pendingPath = `/c/channels/${serverId}/${pendingChannel}`
  const pendingGate = await holdRoute(page, pendingPath)
  await page.getByTestId(tid.channelRow(pendingChannel)).click({ noWaitAfter: true })
  await expect.poll(pendingGate.held).toBeGreaterThan(0)
  await expect(page.getByTestId(tid.pendingMain("server-conversation"))).toBeVisible()
  await pendingGate.release()

  await expect.poll(() => new URL(page.url()).pathname).toBe(pendingPath)
  await expect(page.getByTestId(tid.composerInput)).toBeVisible({ timeout: 30_000 })
  expect(await surfaceAnimations(page)).toEqual([])
  expectStationaryFrames(await surfaceFrames(page))
  expect(await sidebarScroll.evaluate((element) => (
    element as typeof element & { __e2eIdentity?: string }
  ).__e2eIdentity)).toBe("stable")
  expect(await fastRow.evaluate((element) => (
    element as typeof element & { __e2eDndOwner?: string }
  ).__e2eDndOwner)).toBe("stable")

  await page.goBack()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await expect(fastRow).toBeVisible()
  await page.goForward()
  await expect.poll(() => new URL(page.url()).pathname).toBe(pendingPath)
  await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  expect(await surfaceAnimations(page)).toEqual([])
  expectStationaryFrames(await surfaceFrames(page))

  await page.goBack()
  await expect(fastRow).toBeVisible()
  await page.getByTestId(tid.homeButton).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me")
  await page.getByTestId(tid.serverIcon(serverId)).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await expect(fastRow).toBeVisible()
  expect(await surfaceAnimations(page)).toEqual([])
  const finalFrames = await surfaceFrames(page)
  expectStationaryFrames(finalFrames)
  const targetFrames = finalFrames.filter((frame) => frame.rows.includes(fastChannel))
  expect(targetFrames.length).toBeGreaterThan(0)
  expect(targetFrames.every((frame) => frame.treeScope === `server:${serverId}`)).toBe(true)
})
