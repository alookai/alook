import type { Page, WebSocket } from "@playwright/test"
import { type CaseActors, type CaseResources, expect, test } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"
import { holdRoute } from "./_fixtures/held-route"
import { CURRENT_COMMUNITY_FIXTURE_HEADERS, communityFixtureFetch, confirmCommunityFixtureApiResponse, currentCommunityFixtureError } from "./_fixtures/business-contract"
import { gotoAfterUserWsAuth, openServer } from "./_fixtures/actions"
import { WEB_URL } from "./_setup/paths"
import type { UserKey } from "./_setup/users"
import { lastChannelKey } from "@/lib/community/last-channel"

test.describe("server switch pending checkpoint", () => {
  type HeldServer = {
    heldReads: () => number
    release: () => Promise<void>
  }

  type SidebarFrame = {
    pathname: string
    ownerId: number | null
    scope: string | null
    retainedOwner: { scope: string | null; hidden: boolean; inert: boolean } | null
    pendingServer: string | null
    skeleton: boolean
    rows: string[]
    transform: string | null
    opacity: string | null
  }

  type HistoryEvent = {
    kind: "pushState" | "replaceState" | "popstate"
    pathname: string
    internal: boolean
  }

  async function installSidebarFrameProbe(page: Page) {
    const channelRowPrefix = tid.channelRow("")
    await page.addInitScript(({ channelRowPrefix }) => {
      const state = window as typeof window & {
        __communityHistoryEvents?: HistoryEvent[]
        __communitySidebarFrames?: SidebarFrame[]
      }
      state.__communitySidebarFrames = []
      state.__communityHistoryEvents = []
      const recordHistory = (
        kind: HistoryEvent["kind"],
        href: string | URL | null | undefined,
        data: unknown,
      ) => {
        const url = href == null ? new URL(location.href) : new URL(String(href), location.href)
        state.__communityHistoryEvents!.push({ kind, pathname: url.pathname, internal: typeof data === "object" && data !== null && "__NA" in data && data.__NA === true && "__PRIVATE_NEXTJS_INTERNALS_TREE" in data })
      }
      const pushState = history.pushState.bind(history)
      history.pushState = (...args) => {
        recordHistory("pushState", args[2], args[0])
        return pushState(...args)
      }
      const replaceState = history.replaceState.bind(history)
      history.replaceState = (...args) => {
        recordHistory("replaceState", args[2], args[0])
        return replaceState(...args)
      }
      addEventListener("popstate", () => recordHistory("popstate", location.href, history.state))
      const ownerIds = new WeakMap<Element, number>()
      let nextOwnerId = 0
      const sample = () => {
        const surface = document.querySelector<HTMLElement>('[data-community-mobile-surface="list"]')
        const sidebar = surface ?? document.querySelector<HTMLElement>("#sidebar")
        const retainedOwner = sidebar?.querySelector<HTMLElement>("[data-community-channel-tree-scope]") ?? null
        const ownerStyle = retainedOwner ? getComputedStyle(retainedOwner) : null
        const ownerHasLayout = retainedOwner !== null && (
          retainedOwner.getClientRects().length > 0
          || Array.from(retainedOwner.children).some((child) => child.getClientRects().length > 0)
        )
        const ownerHidden = retainedOwner !== null && (
          ownerStyle?.display === "none" || ownerStyle?.visibility === "hidden"
          || !ownerHasLayout
        )
        const ownerInert = retainedOwner !== null && retainedOwner.closest("[inert]") !== null
        const owner = ownerHidden || ownerInert ? null : retainedOwner
        let ownerId: number | null = null
        if (owner) {
          ownerId = ownerIds.get(owner) ?? ++nextOwnerId
          ownerIds.set(owner, ownerId)
        }
        const rows = Array.from(sidebar?.querySelectorAll<HTMLElement>(
          `[data-testid^="${channelRowPrefix}"]`,
        ) ?? []).filter((row) => {
          const style = getComputedStyle(row)
          return style.display !== "none" && row.getClientRects().length > 0
        }).map((row) => row.dataset.testid!.replace(channelRowPrefix, ""))
        const surfaceStyle = surface ? getComputedStyle(surface) : null
        state.__communitySidebarFrames!.push({
          pathname: location.pathname,
          ownerId,
          scope: owner?.dataset.communityChannelTreeScope ?? null,
          retainedOwner: retainedOwner ? {
            scope: retainedOwner.dataset.communityChannelTreeScope ?? null,
            hidden: ownerHidden,
            inert: ownerInert,
          } : null,
          pendingServer: sidebar?.querySelector<HTMLElement>("[data-pending-server-id]")
            ?.dataset.pendingServerId ?? null,
          skeleton: sidebar?.querySelector('[data-slot="skeleton"]') !== null,
          rows,
          transform: surfaceStyle?.transform ?? null,
          opacity: surfaceStyle?.opacity ?? null,
        })
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }, { channelRowPrefix })
  }

  async function clearSidebarFrames(page: Page) {
    await page.evaluate(() => {
      ;(window as typeof window & { __communitySidebarFrames?: SidebarFrame[] })
        .__communitySidebarFrames = []
    })
  }

  async function clearHistoryEvents(page: Page) {
    await page.evaluate(() => {
      ;(window as typeof window & { __communityHistoryEvents?: HistoryEvent[] })
        .__communityHistoryEvents = []
    })
  }

  async function historyEvents(page: Page): Promise<HistoryEvent[]> {
    return page.evaluate(() => (
      window as typeof window & { __communityHistoryEvents?: HistoryEvent[] }
    ).__communityHistoryEvents ?? [])
  }

  async function sidebarFrames(page: Page, targetScope: string): Promise<SidebarFrame[]> {
    const read = () => page.evaluate(() => (
      window as typeof window & { __communitySidebarFrames?: SidebarFrame[] }
    ).__communitySidebarFrames ?? [])
    await expect.poll(async () => (await read()).some(frame => frame.scope === targetScope && !frame.skeleton)).toBe(true)
    return read()
  }

  function expectAtomicTargetFrames(
    frames: SidebarFrame[],
    scope: string,
    targetRow: string,
    forbiddenRows: string[],
  ) {
    const target = frames.filter((frame) => frame.scope === scope)
    expect(target.length).toBeGreaterThan(0)
    expect(new Set(target.map((frame) => frame.ownerId)).size).toBe(1)
    const committed = target.filter((frame) => !frame.skeleton)
    expect(committed.length).toBeGreaterThan(0)
    expect(committed[0].rows).toContain(targetRow)
    for (const frame of committed) {
      expect(frame.rows).toContain(targetRow)
      expect(frame.rows.some((row) => forbiddenRows.includes(row))).toBe(false)
      if (frame.transform !== null) {
        expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(frame.transform)
        expect(frame.opacity).toBe("1")
      }
    }
  }

  async function holdServerTransition(
    page: Page,
    serverId: string, caseResources: CaseResources
  ): Promise<HeldServer> {
    const held = await holdRoute(page, url => [
      `/api/community/servers/${serverId}/categories`,
      `/api/community/servers/${serverId}/channels`,
      `/api/community/servers/${serverId}/unreads`,
    ].includes(url.pathname), caseResources)
    return { heldReads: held.held, release: held.release }
  }

  async function activateServerIcon(page: Page, serverId: string) {
    const icon = page.getByTestId(tid.serverIcon(serverId))
    // Focus activates the accessible menu path and starts Server-root prefetch.
    // The trigger and button are already stable, so the same node receives the
    // following physical click, including during an immediate A→B supersession.
    await icon.focus()
    await expect(icon.locator("xpath=ancestor::*[@data-slot='context-menu-trigger'][1]"))
      .toBeVisible()
    return icon
  }

  async function clickServer(page: Page, serverId: string): Promise<void> {
    const icon = await activateServerIcon(page, serverId)
    await icon.click({ noWaitAfter: true })
  }

  async function expectDesktopServerDetail(page: Page, serverId: string): Promise<void> {
    const prefix = `/c/channels/${serverId}/`
    await expect.poll(() => new URL(page.url()).pathname.startsWith(prefix)).toBe(true)
  }

  async function expectActiveServer(page: Page, activeId: string, inactiveId: string): Promise<void> {
    await expect(page.getByTestId(tid.serverIcon(activeId))).toHaveClass(/cursor-default/)
    await expect(page.getByTestId(tid.serverIcon(inactiveId))).toHaveClass(/cursor-pointer/)
  }

  test("server switching exposes one target-scoped cold checkpoint and skips it when warm", async ({ caseActors, caseResources }) => {
    test.setTimeout(180_000)

    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { seedChannel, seedServer } = actors.seed

    const stamp = Date.now()
    const serverA = await seedServer("alice", `Checkpoint A ${stamp}`)
    const serverB = await seedServer("alice", `Checkpoint B ${stamp}`)
    const serverC = await seedServer("alice", `Checkpoint C ${stamp}`)
    const serverD = await seedServer("alice", `Checkpoint D ${stamp}`)
    const serverE = await seedServer("alice", `Checkpoint E ${stamp}`)
    const serverF = await seedServer("alice", `Checkpoint F ${stamp}`)
    const serverAName = `Checkpoint-A-${stamp}`
    const serverBName = `Checkpoint-B-${stamp}`
    const channelAName = `checkpoint-a-${stamp}`
    const channelBName = `checkpoint-b-${stamp}`
    const channelCName = `checkpoint-c-${stamp}`
    const channelDName = `checkpoint-d-${stamp}`
    const channelA = await seedChannel("alice", serverA, channelAName)
    const channelB = await seedChannel("alice", serverB, channelBName)
    const channelC = await seedChannel("alice", serverC, channelCName)
    const channelD = await seedChannel("alice", serverD, channelDName)
    const channelE = await seedChannel("alice", serverE, `checkpoint-e-${stamp}`)
    const channelF = await seedChannel("alice", serverF, `checkpoint-f-${stamp}`)

    const { page } = await asUser("alice")
    const rscRequests: string[] = []
    page.on("request", request => {
      if (request.headers().rsc === "1" && new URL(request.url()).pathname.startsWith("/c/")) rscRequests.push(request.url())
    })
    await page.setViewportSize({ width: 1280, height: 900 })
    await installSidebarFrameProbe(page)
    await page.goto(`/c/channels/${serverA}/${channelA}`)
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })

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
      ) {
        mutations.push(`${method} ${pathname}`)
      }
    })

    // Install every cold gate before the first physical rail movement. Moving
    // the pointer between vertically stacked icons can cross another icon and
    // legitimately trigger its hover prefetch; those targets must stay cold
    // until their explicit phase below.
    const coldC = await holdServerTransition(page, serverC, caseResources)
    const coldD = await holdServerTransition(page, serverD, caseResources)
    const coldE = await holdServerTransition(page, serverE, caseResources)
    const coldF = await holdServerTransition(page, serverF, caseResources)

    // Visit B once so both its route and live detail query are deterministically
    // memory-warm, then return to A before sampling the warm switch.
    await clickServer(page, serverB)
    await expect(page.getByTestId(tid.channelRow(channelB))).toBeVisible({ timeout: 30_000 })
    await clickServer(page, serverA)
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })

    await clearSidebarFrames(page)
    await clickServer(page, serverB)
    await expect(page.getByTestId(tid.channelSidebarPending(serverB))).toHaveCount(0)
    await expect(page.getByTestId(tid.pendingMain("server-landing"))).toHaveCount(0)
    await expectDesktopServerDetail(page, serverB)
    await expect(page.locator("#sidebar").getByRole("button", { name: serverBName, exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId(tid.channelRow(channelB))).toBeVisible({ timeout: 30_000 })
    expectAtomicTargetFrames(
      await sidebarFrames(page, `server:${serverB}`),
      `server:${serverB}`,
      channelB,
      [channelA],
    )

    await clickServer(page, serverA)
    await expectDesktopServerDetail(page, serverA)
    await expect(page.locator("#sidebar").getByRole("button", { name: serverAName, exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
    await expectActiveServer(page, serverA, serverB)

    await clearSidebarFrames(page)
    await clickServer(page, serverC)
    await expect.poll(coldC.heldReads).toBeGreaterThan(0)
    await expect(page.getByTestId(tid.channelSidebarPending(serverC))).toBeVisible()
    await expect(page.getByTestId(tid.pendingMain("server-landing"))).toBeVisible()
    await expect(page.getByRole("link", { name: channelAName, exact: true })).toHaveCount(0)
    await expectActiveServer(page, serverC, serverA)
    expect(mutations).toEqual([])
    await coldC.release()
    await expectDesktopServerDetail(page, serverC)
    await expect(page.getByTestId(tid.channelSidebarPending(serverC))).toHaveCount(0)
    await expect(page.getByTestId(tid.channelRow(channelC))).toBeVisible({ timeout: 30_000 })
    const firstCMain = page.locator('[data-slot="community-conversation-surface"]')
    await expect(firstCMain).toBeVisible({ timeout: 30_000 })
    await expect(firstCMain.getByTestId(tid.composerInput)).toBeVisible()
    const rememberedC = await firstCMain.getAttribute("data-channel-id")
    expect(rememberedC).not.toBeNull()
    const rememberedCHref = `/c/channels/${serverC}/${encodeURIComponent(rememberedC!)}`
    await expect.poll(() => new URL(page.url()).pathname).toBe(rememberedCHref)
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key),
      `community:lastChannel:${serverC}`)).toBe(rememberedC)
    const rememberedCHeading = await firstCMain.getByRole("heading").innerText()
    await expect(firstCMain.getByRole("heading", { name: rememberedCHeading, exact: true })).toBeVisible()
    const coldFrames = await sidebarFrames(page, `server:${serverC}`)
    const coldPendingFrames = coldFrames.filter((frame) => frame.pendingServer === serverC)
    expect(coldPendingFrames.length).toBeGreaterThan(0)
    expect(coldPendingFrames.every((frame) => frame.ownerId === null && frame.rows.length === 0))
      .toBe(true)
    expect(coldPendingFrames.every((frame) => !frame.retainedOwner
      || frame.retainedOwner.hidden && frame.retainedOwner.inert)).toBe(true)
    expectAtomicTargetFrames(coldFrames, `server:${serverC}`, channelC, [channelA])

    await clickServer(page, serverA)
    await expectDesktopServerDetail(page, serverA)
    await expect(page.locator("#sidebar").getByRole("button", { name: serverAName, exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
    await expectActiveServer(page, serverA, serverC)

    // A reload restores the persisted structural snapshot but not the live
    // server-detail query. Hold C's fresh reads so its first non-skeleton frame
    // must come from the structural target tree, then reconcile in the same owner.
    await page.waitForTimeout(1_000)
    await page.reload()
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
    const structuralC = await holdServerTransition(page, serverC, caseResources)
    await clearSidebarFrames(page)
    await clearHistoryEvents(page)
    const historyLength = await page.evaluate(() => history.length)
    {
      await clickServer(page, serverC)
      await expect.poll(structuralC.heldReads).toBeGreaterThan(0)
      await structuralC.release()
      await expectDesktopServerDetail(page, serverC)
      await expect(page.getByTestId(tid.channelRow(channelC))).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => new URL(page.url()).pathname).toBe(rememberedCHref)
      const restoredCMain = page.locator('[data-slot="community-conversation-surface"]')
      await expect(restoredCMain).toHaveAttribute("data-channel-id", rememberedC!)
      await expect(restoredCMain.getByRole("heading", { name: rememberedCHeading, exact: true })).toBeVisible()
      await expect(restoredCMain.getByTestId(tid.composerInput)).toBeVisible()
      await expect.poll(() => page.evaluate((key) => localStorage.getItem(key),
        `community:lastChannel:${serverC}`)).toBe(rememberedC)
      expectAtomicTargetFrames(
        await sidebarFrames(page, `server:${serverC}`),
        `server:${serverC}`,
        channelC,
        [channelA, channelB],
      )
      const navigationEvents = await historyEvents(page)
      expect(navigationEvents.filter(event => event.kind === "pushState")).toEqual([{
        kind: "pushState",
        pathname: rememberedCHref,
        internal: true,
      }])
      expect(navigationEvents.every(event => event.pathname === rememberedCHref
        && (event.kind === "pushState" || event.kind === "replaceState" && event.internal))).toBe(true)
      expect(await page.evaluate(() => history.length)).toBe(historyLength + 1)
    }
    await page.goBack()
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible()
    await page.goForward()
    await expect.poll(() => new URL(page.url()).pathname).toBe(rememberedCHref)
    await expect(page.getByRole("heading", { name: rememberedCHeading, exact: true })).toBeVisible()

    await clickServer(page, serverA)
    await expectDesktopServerDetail(page, serverA)
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })

    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
    await expect.poll(() => new URL(page.url()).pathname === `/c/channels/${serverA}`)
      .toBe(true)
    await expect(page.getByTestId(tid.serverIcon(serverD))).toBeVisible()

    await clearSidebarFrames(page)
    await clickServer(page, serverD)
    await expect.poll(coldD.heldReads).toBeGreaterThan(0)
    const mobileCheckpoint = page.getByTestId(tid.channelSidebarPending(serverD))
    await expect(mobileCheckpoint).toBeVisible()
    await expect(page.getByRole("link", { name: channelAName, exact: true })).toHaveCount(0)
    const mobileBox = await mobileCheckpoint.boundingBox()
    expect(mobileBox).not.toBeNull()
    expect(mobileBox!.width).toBeGreaterThan(300)
    expect(mobileBox!.x + mobileBox!.width).toBeLessThanOrEqual(390)
    await expectActiveServer(page, serverD, serverA)
    await coldD.release()
    await expect.poll(() => new URL(page.url()).pathname.startsWith(`/c/channels/${serverD}`))
      .toBe(true)
    await expect(page.getByTestId(tid.channelRow(channelD))).toBeVisible({ timeout: 30_000 })
    const mobileColdFrames = await sidebarFrames(page, `server:${serverD}`)
    expectAtomicTargetFrames(
      mobileColdFrames,
      `server:${serverD}`,
      channelD,
      [channelA, channelB, channelC],
    )

    await page.setViewportSize({ width: 1280, height: 900 })
    await expectDesktopServerDetail(page, serverD)
    await expect(page.getByTestId(tid.serverIcon(serverE))).toBeVisible()
    await clearSidebarFrames(page)
    await clickServer(page, serverE)
    // Dispatch the superseding click directly against the current stable
    // button so this remains one immediate E→F intent window; awaiting F's
    // focus-driven prefetch would serialize the two intents.
    await page.getByTestId(tid.serverIcon(serverF)).dispatchEvent("click")
    await expect.poll(coldF.heldReads).toBeGreaterThan(0)
    await expect(page.getByTestId(tid.channelSidebarPending(serverE))).toHaveCount(0)
    await expect(page.getByTestId(tid.channelSidebarPending(serverF))).toBeVisible()
    await expectActiveServer(page, serverF, serverD)
    await coldE.release()
    await expect(page.getByTestId(tid.channelSidebarPending(serverF))).toBeVisible()
    await expectActiveServer(page, serverF, serverD)
    await coldF.release()
    await expectDesktopServerDetail(page, serverF)
    await expect(page.getByTestId(tid.channelRow(channelF))).toBeVisible({ timeout: 30_000 })
    const supersededFrames = await sidebarFrames(page, `server:${serverF}`)
    expect(supersededFrames.some((frame) => frame.scope === `server:${serverE}`)).toBe(false)
    expectAtomicTargetFrames(
      supersededFrames,
      `server:${serverF}`,
      channelF,
      [channelA, channelB, channelC, channelD, channelE],
    )
    expect(rscRequests).toEqual([])
  })
})

test.describe("community navigation checkpoint matrix", () => {
  function channelHeader(page: Page, name: string) {
    return page.getByRole("banner").getByText(name, { exact: true })
  }

  type SurfaceBounds = { left: number; top: number; width: number; height: number }

  const mobileEntryInsets = { top: 24, right: 16, bottom: 20, left: 18 }

  type SurfaceAnimationRecord = {
    surface: string | null
    duration: number
    viewportWidth: number
    viewportHeight: number
    before: SurfaceBounds
    start: SurfaceBounds
  }

  type SurfaceFrameRecord = {
    pathname: string
    surface: string | null
    transform: string
    translateX: number
    bounds: SurfaceBounds
    opacity: string
    rows: string[]
    pendingMain: string | null
    treeScope: string | null
  }

  async function installSurfaceAnimationProbe(page: Page) {
    const channelRowPrefix = tid.channelRow("")
    await page.addInitScript(({ channelRowPrefix }) => {
      const state = window as typeof window & {
        __communitySurfaceAnimations?: SurfaceAnimationRecord[]
        __communitySurfaceFrames?: SurfaceFrameRecord[]
        __communitySurfaceFrameStop?: () => void
      }
      state.__communitySurfaceAnimations = []
      state.__communitySurfaceFrames = []
      const bounds = (element: Element): SurfaceBounds => {
        const { left, top, width, height } = element.getBoundingClientRect()
        return { left, top, width, height }
      }
      const nativeAnimate = Element.prototype.animate
      Element.prototype.animate = function (keyframes, options) {
        const before = this.hasAttribute("data-community-mobile-surface") ? bounds(this) : null
        const animation = nativeAnimate.call(this, keyframes, options)
        if (before) {
          state.__communitySurfaceAnimations!.push({
            surface: this.getAttribute("data-community-mobile-surface"),
            duration: Number(animation.effect!.getTiming().duration),
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
            before,
            start: bounds(this),
          })
        }
        return animation
      }
      const probeAnimate = Element.prototype.animate

      let raf = 0
      const sample = () => {
        for (const surface of document.querySelectorAll<HTMLElement>('[data-slot="community-sidebar-panel-content"], [data-slot="community-main-panel-content"]')) {
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
            surface: surface.dataset.slot === "community-sidebar-panel-content" ? "list" : "detail",
            transform: style.transform,
            translateX: style.transform === "none" ? 0 : new DOMMatrixReadOnly(style.transform).m41,
            bounds: bounds(surface),
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
      state.__communitySurfaceFrameStop = () => {
        cancelAnimationFrame(raf)
        if (Element.prototype.animate === probeAnimate) Element.prototype.animate = nativeAnimate
      }
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

  async function expectDetailEntry(page: Page) {
    const detail = page.locator('[data-community-mobile-surface="detail"]')
    await expect.poll(() => detail.evaluate(element => getComputedStyle(element).transform)).toBe("none")
    const animations = await surfaceAnimations(page)
    expect(animations).toHaveLength(1)
    const entry = animations[0]
    expect(entry.surface).toBe("detail")
    expect(entry.duration).toBe(280)
    const { width, height } = page.viewportSize()!
    expect(entry.viewportWidth).toBe(width)
    expect(entry.viewportHeight).toBe(height)
    const expected = {
      left: mobileEntryInsets.left,
      top: mobileEntryInsets.top,
      width: width - mobileEntryInsets.left - mobileEntryInsets.right,
      height: height - mobileEntryInsets.top - mobileEntryInsets.bottom,
    }
    const settled = await detail.evaluate(element => {
      const { left, top, width, height } = element.getBoundingClientRect()
      return { left, top, width, height }
    })
    for (const edge of ["left", "top", "width", "height"] as const) {
      expect(entry.before[edge]).toBeCloseTo(expected[edge], 0)
      expect(settled[edge]).toBeCloseTo(expected[edge], 0)
      expect(entry.start[edge]).toBeCloseTo(expected[edge] + (edge === "left" ? width : 0), 0)
    }
    const frames = await surfaceFrames(page)
    const listFrames = frames.filter(frame => frame.surface === "list")
    expectStationaryFrames(listFrames)
    for (const frame of listFrames) {
      for (const edge of ["left", "top", "width", "height"] as const) {
        expect(frame.bounds[edge]).toBeCloseTo(listFrames[0].bounds[edge], 0)
      }
    }
    const detailFrames = frames.filter(frame => frame.surface === "detail")
    expect(detailFrames.some(frame => frame.translateX > 0)).toBe(true)
    for (const frame of detailFrames) {
      expect(frame.translateX).toBeGreaterThanOrEqual(-0.5)
      expect(frame.translateX).toBeLessThanOrEqual(width + 0.5)
      expect(frame.opacity).toBe("1")
      expect(frame.bounds.left).toBeCloseTo(expected.left + frame.translateX, 0)
      expect(frame.bounds.top).toBeCloseTo(expected.top, 0)
      expect(frame.bounds.width).toBeCloseTo(expected.width, 0)
      expect(frame.bounds.height).toBeCloseTo(expected.height, 0)
    }
  }

  test("community checkpoint shows target pending for detail and keeps list surfaces stable", async ({ caseActors, caseResources }) => {
    test.setTimeout(120_000)

    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { seedChannel, seedServer } = actors.seed

    const stamp = Date.now()
    const serverId = await seedServer("alice", `Frame Gate ${stamp}`)
    const channelAName = `frame-a-${stamp}`
    const channelBName = `frame-b-${stamp}`
    const channelA = await seedChannel("alice", serverId, channelAName)
    const channelB = await seedChannel("alice", serverId, channelBName)
    const { page } = await asUser("alice")
    const machineDataGate = await holdRoute(page, "**/api/community/machines**", caseResources)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/c/channels/${serverId}/${channelA}`)
    await expect(channelHeader(page, channelAName)).toBeVisible({ timeout: 30_000 })

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

    const leafGate = await holdRoute(page, `**/api/community/channels/${channelB}/messages*`, caseResources)
    await page.getByTestId(tid.channelRow(channelB)).click({ noWaitAfter: true })
    await expect.poll(leafGate.held).toBeGreaterThan(0)
    const pendingMain = page.locator(
      `[data-community-target-href="/c/channels/${serverId}/${channelB}"]`,
    ).locator('main[aria-label="Loading conversation"][aria-busy="true"][data-community-conversation-subtype="text"]').filter({
      has: page.locator('[data-slot="skeleton"]'),
    })
    const targetReady = page.locator(
      `[data-community-target-href="/c/channels/${serverId}/${channelB}"]`,
    ).filter({
      has: page.getByRole("heading", { name: channelBName, exact: true }),
    }).filter({ has: page.locator(
      `[data-slot="community-conversation-surface"][data-channel-id="${channelB}"]`,
    ).filter({ has: page.getByTestId(tid.composerInput) }) })
    const oldMain = page.locator(
      `[data-slot="community-conversation-surface"][data-channel-id="${channelA}"]`,
    )
    await expect(pendingMain.or(targetReady).first()).toBeVisible()
    await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
    await expect(channelHeader(page, channelAName)).toHaveCount(0)
    await expect(oldMain).toHaveCount(0)
    await page.waitForTimeout(150)
    await expect(pendingMain.or(targetReady).first()).toBeVisible()
    await expect(channelHeader(page, channelAName)).toHaveCount(0)
    await expect(oldMain).toHaveCount(0)
    await leafGate.release()
    await expect(channelHeader(page, channelBName)).toBeVisible({ timeout: 30_000 })
    await expect(targetReady).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole("banner").getByRole("button", { name: "Back" }).click({ noWaitAfter: true })
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
    await expect(channelHeader(page, channelBName)).toBeVisible()
    await page.waitForTimeout(150)
    await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
    await expect(channelHeader(page, channelBName)).toBeVisible({ timeout: 30_000 })

    await page.goto("/c/me/friends")
    await expect(page.getByPlaceholder("Search friends")).toBeVisible({ timeout: 30_000 })
    await page.getByRole("link", { name: "Machines", exact: true }).click({ noWaitAfter: true })
    await expect.poll(machineDataGate.held).toBeGreaterThan(0)
    await expect(page.getByPlaceholder("Search friends")).toHaveCount(0)
    await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
    await expect(page.locator('[data-slot="community-machines-heading"] [data-slot="skeleton"]').first()).toBeVisible()
    await expect(page.getByText("No machines yet", {exact: true})).toHaveCount(0)
    await expect(page.getByTestId(tid.machinePairOpen)).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe("/c/me/machines")
    await machineDataGate.release()
    await expect(page.getByText("No machines yet", {exact: true})).toBeVisible()
    await expect(page.getByTestId(tid.machinePairOpen)).toBeEnabled()
    expect(new URL(page.url()).pathname).toBe("/c/me/machines")
    const cachedMachineContent = page.getByText("No machines yet", {exact: true})
    await cachedMachineContent.evaluate(element => { element.setAttribute("data-e2e-cached-identity", "retained") })
    await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me/machines")
    await expect(cachedMachineContent).toHaveAttribute("data-e2e-cached-identity", "retained")
    await page.getByRole("link", {name: "Friends", exact: true}).click()
    await expect(page.getByPlaceholder("Search friends")).toBeVisible()
    await page.getByRole("link", {name: "Machines", exact: true}).click({noWaitAfter: true})
    await expect(cachedMachineContent).toBeVisible()
    await expect(page.getByTestId(tid.machinePairOpen)).toBeEnabled()
    await expect(page.getByPlaceholder("Search friends")).toHaveCount(0)
    await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me/machines")

    expect(mutations).toEqual([])
  })

  test("mobile detail enters once while sidebar identity survives pending and same-server history", async ({ caseActors, caseResources }) => {
    test.setTimeout(120_000)

    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { seedChannel, seedServer } = actors.seed

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
    const previousInsets = await page.evaluate(insets => Object.entries(insets).map(([edge, value]) => {
      const style = document.documentElement.style
      const name = `--app-safe-area-${edge}`
      const previous = { name, value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) }
      style.setProperty(name, `${value}px`)
      return previous
    }), mobileEntryInsets)
    caseResources.own(previousInsets, async values => {
      if (page.isClosed()) return
      await page.evaluate(previous => {
        const state = window as typeof window & {
          __communitySurfaceAnimations?: SurfaceAnimationRecord[]
          __communitySurfaceFrames?: SurfaceFrameRecord[]
          __communitySurfaceFrameStop?: () => void
        }
        state.__communitySurfaceFrameStop?.()
        delete state.__communitySurfaceAnimations
        delete state.__communitySurfaceFrames
        delete state.__communitySurfaceFrameStop
        const style = document.documentElement.style
        for (const { name, value, priority } of previous) {
          if (value) style.setProperty(name, value, priority)
          else style.removeProperty(name)
        }
      }, values)
    })
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
    await expectDetailEntry(page)
    expect(await sidebarScroll.evaluate((element) => (
      element as typeof element & { __e2eIdentity?: string }
    ).__e2eIdentity)).toBe("stable")
    expect(await fastRow.evaluate((element) => (
      element as typeof element & { __e2eDndOwner?: string }
    ).__e2eDndOwner)).toBe("stable")

    await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    await expect(fastRow).toBeVisible()
    expect(await surfaceAnimations(page)).toHaveLength(1)
    expectStationaryFrames((await surfaceFrames(page)).filter(frame => frame.surface === "list"))
    expect(await sidebarScroll.evaluate((element) => (
      element as typeof element & { __e2eIdentity?: string }
    ).__e2eIdentity)).toBe("stable")
    expect(await fastRow.evaluate((element) => (
      element as typeof element & { __e2eDndOwner?: string }
    ).__e2eDndOwner)).toBe("stable")

    await clearSurfaceAnimations(page)
    const pendingPath = `/c/channels/${serverId}/${pendingChannel}`
    const pendingGate = await holdRoute(page, `**/api/community/channels/${pendingChannel}/messages*`, caseResources)
    await page.getByTestId(tid.channelRow(pendingChannel)).click({ noWaitAfter: true })
    await expect.poll(pendingGate.held).toBeGreaterThan(0)
    const pendingMain = page.locator(
      `[data-community-target-href="${pendingPath}"]`,
    ).locator('main[aria-label="Loading conversation"][aria-busy="true"][data-community-conversation-subtype="text"]').filter({
      has: page.locator('[data-slot="skeleton"]'),
    })
    const targetReady = page.locator(
      `[data-community-target-href="${pendingPath}"]`,
    ).filter({
      has: page.getByRole("heading", { name: pendingName, exact: true }),
    }).filter({ has: page.locator(
      `[data-slot="community-conversation-surface"][data-channel-id="${pendingChannel}"]`,
    ).filter({ has: page.getByTestId(tid.composerInput) }) })
    await expect(pendingMain.or(targetReady).first()).toBeVisible()
    await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
    await expect(channelHeader(page, fastName)).toHaveCount(0)
    await expect(page.locator(
      `[data-slot="community-conversation-surface"][data-channel-id="${fastChannel}"]`,
    )).toHaveCount(0)
    await pendingGate.release()

    await expect.poll(() => new URL(page.url()).pathname).toBe(pendingPath)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible({ timeout: 30_000 })
    await expect(targetReady).toBeVisible()
    await expectDetailEntry(page)
    expect(await sidebarScroll.evaluate((element) => (
      element as typeof element & { __e2eIdentity?: string }
    ).__e2eIdentity)).toBe("stable")
    expect(await fastRow.evaluate((element) => (
      element as typeof element & { __e2eDndOwner?: string }
    ).__e2eDndOwner)).toBe("stable")

    await clearSurfaceAnimations(page)
    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    await expect(fastRow).toBeVisible()
    await page.goForward()
    await expect.poll(() => new URL(page.url()).pathname).toBe(pendingPath)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    await expectDetailEntry(page)

    await clearSurfaceAnimations(page)
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

    await page.setViewportSize({ width: 640, height: 844 })
    await clearSurfaceAnimations(page)
    await fastRow.click()
    await expect(channelHeader(page, fastName)).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    expect(await surfaceAnimations(page)).toEqual([])
    expectStationaryFrames(await surfaceFrames(page))
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    expect(await surfaceAnimations(page)).toEqual([])
  })
})

test.describe("server delete navigation races", () => {
  async function prepareCase(actors: CaseActors) {
    const { sessionCookie } = actors
    const { seedChannel, seedServer } = actors.seed
    async function serverIds(key: UserKey): Promise<string[]> {
      const response = await communityFixtureFetch(`${WEB_URL}/api/community/servers`, {
        headers: { Cookie: sessionCookie(key), Origin: WEB_URL },
      })
      expect(response.status).toBe(200)
      const body = await response.json() as {
        servers: Array<{
          id: string
        }>
      }
      return body.servers.map((server) => server.id)
    }
    async function seedServerRoute(key: UserKey, name: string): Promise<{
      serverId: string
      channelId: string
      name: string
    }> {
      const serverId = await seedServer(key, name)
      const channelId = await seedChannel(key, serverId, `${name} channel`, "text")
      return { serverId, channelId, name }
    }
    return { serverIds, seedServerRoute }
  }

  type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
  }

  function captureServerDeletes(page: Page) {
    const frames: Array<{ type: string; serverId?: string }> = []
    const sockets = new Set<WebSocket>()
    page.on("websocket", (socket) => {
      sockets.add(socket)
      socket.on("framereceived", ({ payload }) => {
        try {
          const frame = JSON.parse(payload.toString()) as { type: string; serverId?: string }
          if (frame.type === "community:server.delete") frames.push(frame)
        } catch {}
      })
    })
    return { frames, sockets }
  }

  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => {
      resolve = resolvePromise
    })
    return { promise, resolve }
  }

  async function firstTextChannelId(page: Page, serverId: string): Promise<string> {
    const response = await confirmCommunityFixtureApiResponse(page.request.get(
      `/api/community/servers/${serverId}/channels`, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS },
    ))
    expect(response.status()).toBe(200)
    const body = await response.json() as {
      channels: Array<{ id: string; type: string; parentChannelId?: string | null }>
    }
    const channel = body.channels.find((candidate) => (
      candidate.type === "text" && !candidate.parentChannelId
    ))
    expect(channel).toBeTruthy()
    return channel!.id
  }

  async function openChannelRoute(
    page: Page,
    serverId: string,
    channelId: string,
  ): Promise<void> {
    const pathname = `/c/channels/${serverId}/${channelId}`
    await page.goto(pathname, { waitUntil: "commit" })
    await expect(page).toHaveURL(pathname)
  }

  async function clickDeleteServer(
    page: Page,
    serverId: string,
    beforeConfirm?: () => Promise<void>,
    expectedServerName?: string,
  ): Promise<void> {
    await page.getByTestId(tid.serverIcon(serverId)).click({ button: "right" })
    await page.getByTestId(tid.serverSettingsOpen).click()
    const settingsShell = page.getByTestId(tid.settingsShell)
    await expect(settingsShell).toBeVisible()
    await settingsShell.getByRole("button", { name: "Delete Server", exact: true }).click()
    const confirmDialog = expectedServerName
      ? page.getByRole("dialog", { name: `Delete "${expectedServerName}"?`, exact: true })
      : page.getByRole("dialog", { name: /^Delete ".+"\?$/ })
    await expect(confirmDialog).toBeVisible()
    await beforeConfirm?.()
    await confirmDialog.getByRole("button", {
      name: "Delete Server",
      exact: true,
    }).click()
    await expect(confirmDialog).toBeHidden()
  }

  async function reloadOnServerRoute(
    page: Page,
    serverId: string,
  ): Promise<void> {
    const pathname = await expectServerLeaf(page, serverId)
    const channelId = pathname.split("/").at(-1)!
    await page.reload()
    await expect(page).toHaveURL(pathname)
    const surface = page.locator('[data-slot="community-conversation-surface"]').filter({ visible: true })
    await expect(surface).toHaveAttribute("data-channel-id", channelId)
    await expect(surface.getByTestId(tid.composerInput)).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-e2e-user-ws-authenticated", "true", { timeout: 20_000 })
  }

  async function delayDelete(page: Page, serverId: string, caseResources: CaseResources) {
    const release = deferred<void>()
    caseResources.own(release, async (captured) => { captured.resolve() })
    const intercepted = deferred<void>()
    caseResources.own(intercepted, async (captured) => { captured.resolve() })
    const pattern = `**/api/community/servers/${serverId}`
    await page.route(pattern, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue()
        return
      }
      intercepted.resolve()
      await release.promise
      await route.continue()
    })
    const response = page.waitForResponse((candidate) => (
      candidate.request().method() === "DELETE"
      && new URL(candidate.url()).pathname === `/api/community/servers/${serverId}`
    ))
    await clickDeleteServer(page, serverId)
    await intercepted.promise
    return {
      release: () => release.resolve(),
      response,
      cleanup: () => page.unroute(pattern),
    }
  }

  async function delayServerEntry(page: Page, channelId: string, resources: CaseResources) {
    return holdRoute(page, url => url.pathname === `/api/community/channels/${channelId}/messages`
      && url.searchParams.get("entry") === "1", resources)
  }

  async function installHistoryRecorder(page: Page): Promise<void> {
    await page.evaluate(() => {
      const scope = window as typeof window & {
        __serverDeleteHistoryWrites?: Array<{ method: "push" | "replace"; href: string | null }>
        __serverDeleteHistoryWrapped?: boolean
      }
      scope.__serverDeleteHistoryWrites = []
      if (scope.__serverDeleteHistoryWrapped) return
      scope.__serverDeleteHistoryWrapped = true
      const nativePush = history.pushState
      const nativeReplace = history.replaceState
      history.pushState = function (data, unused, url) {
        scope.__serverDeleteHistoryWrites?.push({
          method: "push",
          href: url === undefined || url === null ? null : String(url),
        })
        return nativePush.call(this, data, unused, url)
      }
      history.replaceState = function (data, unused, url) {
        scope.__serverDeleteHistoryWrites?.push({
          method: "replace",
          href: url === undefined || url === null ? null : String(url),
        })
        return nativeReplace.call(this, data, unused, url)
      }
    })
  }

  async function resetHistoryRecorder(page: Page): Promise<void> {
    await page.evaluate(() => {
      const scope = window as typeof window & {
        __serverDeleteHistoryWrites?: unknown[]
      }
      scope.__serverDeleteHistoryWrites = []
    })
  }

  async function divergentHistoryWrites(page: Page, expectedPathname: string) {
    return page.evaluate((expected) => {
      const scope = window as typeof window & {
        __serverDeleteHistoryWrites?: Array<{ method: "push" | "replace"; href: string | null }>
      }
      return (scope.__serverDeleteHistoryWrites ?? []).filter(({ href }) => (
        href !== null && new URL(href, location.origin).pathname !== expected
      ))
    }, expectedPathname)
  }

  async function expectServerLeaf(page: Page, serverId: string): Promise<string> {
    await expect(page).toHaveURL(new RegExp(`/c/channels/${serverId}/[^/]+$`))
    return new URL(page.url()).pathname
  }



  test("deleting the only Server replaces once to Home", async ({ caseActors }) => {
    const actors = await caseActors(["sole-delete"])
    const { asUser, userId } = actors
    const { serverIds, seedServerRoute } = await prepareCase(actors)

    const key = "sole-delete"
    expect(await serverIds(key)).toEqual([])
    const route = await seedServerRoute(key, `delete-only-${Date.now()}`)
    const page = (await asUser(key)).page
    await gotoAfterUserWsAuth(
      page,
      `/c/channels/${route.serverId}/${route.channelId}`,
    )
    await installHistoryRecorder(page)
    const response = page.waitForResponse((candidate) => (
      candidate.request().method() === "DELETE"
        && new URL(candidate.url()).pathname === `/api/community/servers/${route.serverId}`
    ))

    await clickDeleteServer(page, route.serverId, async () => {
      expect(await serverIds(key)).toEqual([route.serverId])
      const membershipResponse = await confirmCommunityFixtureApiResponse(page.request.get(`/api/community/servers/${route.serverId}/members`, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
      expect(membershipResponse.status()).toBe(200)
      const body = await membershipResponse.json() as { members: Array<{ userId: string }> }
      expect(body.members.map((member) => member.userId)).toContain(userId(key))
      await expect(page).toHaveURL(`/c/channels/${route.serverId}/${route.channelId}`)
      await resetHistoryRecorder(page)
    })

    expect((await response).status()).toBe(204)
    const deleteResponse = await response
    await actors.recordServerDeletion(key, route.serverId, { page, response: deleteResponse })
    await expect(page).toHaveURL("/c/me")
    await expect(page.getByTestId(tid.serverIcon(route.serverId))).toHaveCount(0)
    await expect(page.getByText("Server deleted", { exact: true })).toBeVisible()
    expect(await divergentHistoryWrites(page, "/c/me")).toEqual([])
    expect(await serverIds(key)).toEqual([])
  })

  for (const testCase of [
    { key: "alice" as const, name: "computed target", chooseUserRoute: (ids: string[]) => ids[0] },
    { key: "bob" as const, name: "different safe route", chooseUserRoute: (ids: string[]) => ids[1] },
  ]) {
    test(`a committed ${testCase.name} wins before DELETE success with no later history write`, async ({ caseActors, caseResources }) => {
      const actors = await caseActors([testCase.key])
      const { asUser } = actors
      const { serverIds, seedServerRoute } = await prepareCase(actors)

      const stamp = Date.now()
      const survivorA = await seedServerRoute(testCase.key, `survivor-a-${stamp}`)
      const survivorB = await seedServerRoute(testCase.key, `survivor-b-${stamp}`)
      const deleted = await seedServerRoute(testCase.key, `deleted-${stamp}`)
      const page = (await asUser(testCase.key)).page
      await gotoAfterUserWsAuth(
        page,
        `/c/channels/${deleted.serverId}/${deleted.channelId}`,
      )
      await installHistoryRecorder(page)
      const survivors = (await serverIds(testCase.key)).filter((id) => id !== deleted.serverId)
      expect(survivors).toContain(survivorA.serverId)
      expect(survivors).toContain(survivorB.serverId)
      const userServerId = testCase.chooseUserRoute(survivors)
      expect(userServerId).toBeTruthy()
      const deletion = await delayDelete(page, deleted.serverId, caseResources)

      await openServer(page, userServerId)
      const safePathname = await expectServerLeaf(page, userServerId)
      await resetHistoryRecorder(page)
      deletion.release()

      expect((await deletion.response).status()).toBe(204)
      const deleteResponse = await deletion.response
      await actors.recordServerDeletion(testCase.key, deleted.serverId, { page, response: deleteResponse })
      await expect(page).toHaveURL(safePathname)
      await expect(page.getByTestId(tid.serverIcon(deleted.serverId))).toHaveCount(0)
      await expect(page.getByText("Server deleted", { exact: true })).toHaveCount(0)
      expect(await divergentHistoryWrites(page, safePathname)).toEqual([])
      await deletion.cleanup()
    })
  }

  test("a held target entry survives delete/list/WS convergence on its remembered Channel", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["carol"])
    const { asUser } = actors
    const { serverIds, seedServerRoute } = await prepareCase(actors)

    const stamp = Date.now()
    const ensuredSurvivor = await seedServerRoute("carol", `slow-target-${stamp}`)
    const deleted = await seedServerRoute("carol", `slow-deleted-${stamp}`)
    const page = (await asUser("carol")).page
    await gotoAfterUserWsAuth(
      page,
      `/c/channels/${ensuredSurvivor.serverId}/${ensuredSurvivor.channelId}`,
    )
    const targetServerId = (await serverIds("carol")).find((id) => id !== deleted.serverId)
    expect(targetServerId).toBeTruthy()
    const targetChannelId = await firstTextChannelId(page, targetServerId!)
    const readyTargetEntry = page.waitForResponse((candidate) => {
      const url = new URL(candidate.url())
      return candidate.request().method() === "GET"
        && url.pathname === `/api/community/channels/${targetChannelId}/messages`
        && url.searchParams.get("entry") === "1"
    })
    await openChannelRoute(
      page,
      targetServerId!,
      targetChannelId,
    )
    const targetResponse = await readyTargetEntry
    expect(targetResponse.status()).toBe(200)
    expect(await targetResponse.finished()).toBeNull()
    const targetPathname = await expectServerLeaf(page, targetServerId!)
    const targetSurface = page.locator('[data-slot="community-conversation-surface"]').filter({ visible: true })
    await expect(targetSurface).toHaveAttribute("data-channel-id", targetChannelId)
    await expect(targetSurface.getByTestId(tid.composerInput)).toBeVisible()
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key),
      lastChannelKey(targetServerId!))).toBe(targetChannelId)
    await openServer(page, deleted.serverId)
    await expectServerLeaf(page, deleted.serverId)
    await openServer(page, targetServerId!)
    expect(await expectServerLeaf(page, targetServerId!)).toBe(targetPathname)
    await expect(targetSurface).toHaveAttribute("data-channel-id", targetChannelId)
    await expect(targetSurface.getByTestId(tid.composerInput)).toBeVisible()
    await openServer(page, deleted.serverId)
    await reloadOnServerRoute(page, deleted.serverId)
    const targetEntry = await delayServerEntry(page, targetChannelId, caseResources)
    const response = page.waitForResponse((candidate) => (
      candidate.request().method() === "DELETE"
        && new URL(candidate.url()).pathname === `/api/community/servers/${deleted.serverId}`
    ))

    await clickDeleteServer(page, deleted.serverId, undefined, deleted.name)

    expect((await response).status()).toBe(204)
    const deleteResponse = await response
    await actors.recordServerDeletion("carol", deleted.serverId, { page, response: deleteResponse })
    await expect.poll(targetEntry.held).toBeGreaterThan(0)
    expect(new URL(page.url()).pathname).not.toBe("/c/me")
    await targetEntry.release()
    expect(await expectServerLeaf(page, targetServerId!)).toBe(targetPathname)
    await expect(page.getByTestId(tid.serverIcon(deleted.serverId))).toHaveCount(0)
  })

  test("a newer user navigation wins while the delete target entry is pending", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["dave"])
    const { asUser } = actors
    const { serverIds, seedServerRoute } = await prepareCase(actors)

    const stamp = Date.now()
    const candidateA = await seedServerRoute("dave", `queued-target-a-${stamp}`)
    const candidateB = await seedServerRoute("dave", `queued-target-b-${stamp}`)
    const deleted = await seedServerRoute("dave", `queued-deleted-${stamp}`)
    const page = (await asUser("dave")).page
    await gotoAfterUserWsAuth(
      page,
      `/c/channels/${candidateA.serverId}/${candidateA.channelId}`,
    )
    const targetServerId = (await serverIds("dave")).find((id) => id !== deleted.serverId)
    expect(targetServerId).toBeTruthy()
    const userRoute = [candidateA, candidateB].find(({ serverId }) => (
      serverId !== targetServerId
    ))
    expect(userRoute).toBeTruthy()
    await openServer(page, targetServerId!)
    const targetPathname = await expectServerLeaf(page, targetServerId!)
    await openServer(page, deleted.serverId)
    await reloadOnServerRoute(page, deleted.serverId)
    const targetEntry = await delayServerEntry(page, targetPathname.split("/").at(-1)!, caseResources)
    const response = page.waitForResponse((candidate) => (
      candidate.request().method() === "DELETE"
        && new URL(candidate.url()).pathname === `/api/community/servers/${deleted.serverId}`
    ))

    await clickDeleteServer(page, deleted.serverId, undefined, deleted.name)

    expect((await response).status()).toBe(204)
    const deleteResponse = await response
    await actors.recordServerDeletion("dave", deleted.serverId, { page, response: deleteResponse })
    await expect.poll(targetEntry.held).toBeGreaterThan(0)
    await page.getByTestId(tid.serverIcon(userRoute!.serverId)).click()
    await targetEntry.release()
    await expectServerLeaf(page, userRoute!.serverId)
    await expect(page).not.toHaveURL(new RegExp(`/c/channels/${targetServerId}(?:/|$)`), {
      timeout: 2_000,
    })
  })

  test("a Back visit after terminal cleanup is an ordinary missing route", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { seedServerRoute } = await prepareCase(actors)

    const stamp = Date.now()
    const survivor = await seedServerRoute("alice", `terminal-survivor-${stamp}`)
    const deleted = await seedServerRoute("alice", `terminal-deleted-${stamp}`)
    const page = (await asUser("alice")).page
    await gotoAfterUserWsAuth(
      page,
      `/c/channels/${deleted.serverId}/${deleted.channelId}`,
    )
    const deletion = await delayDelete(page, deleted.serverId, caseResources)
    await openServer(page, survivor.serverId)
    const safePathname = await expectServerLeaf(page, survivor.serverId)

    deletion.release()
    expect((await deletion.response).status()).toBe(204)
    const deleteResponse = await deletion.response
    await actors.recordServerDeletion("alice", deleted.serverId, { page, response: deleteResponse })
    await expect(page).toHaveURL(safePathname)
    await expect(page.getByTestId(tid.serverIcon(deleted.serverId))).toHaveCount(0)
    await expect(page.getByText("Server deleted", { exact: true })).toHaveCount(0)
    await page.goBack({ waitUntil: "commit" })

    await expect(page).not.toHaveURL(new RegExp(`/c/channels/${deleted.serverId}(?:/|$)`))
    await expect(page).toHaveURL(/\/c\/channels\/[^/]+\/[^/]+$/)
    await deletion.cleanup()
  })

  test("a failed DELETE keeps the current route and emits no success frame", async ({ caseActors }) => {
    const actors = await caseActors(["carol"])
    const { asUser } = actors
    const { serverIds, seedServerRoute } = await prepareCase(actors)

    const route = await seedServerRoute("carol", `failed-delete-${Date.now()}`)
    const page = (await asUser("carol")).page
    const deletes = captureServerDeletes(page)
    const pathname = `/c/channels/${route.serverId}/${route.channelId}`
    await gotoAfterUserWsAuth(page, pathname)
    const pattern = `**/api/community/servers/${route.serverId}`
    await page.route(pattern, async (request) => {
      if (request.request().method() !== "DELETE") {
        await request.continue()
        return
      }
      await request.fulfill(currentCommunityFixtureError("forced delete failure", 500))
    })
    const response = page.waitForResponse((candidate) => (
      candidate.request().method() === "DELETE"
        && new URL(candidate.url()).pathname === `/api/community/servers/${route.serverId}`
    ))

    await clickDeleteServer(page, route.serverId)

    expect((await response).status()).toBe(500)
    await expect(page).toHaveURL(pathname)
    await expect(page.getByText("Server deleted", { exact: true })).toHaveCount(0)
    await expect(page.getByTestId(tid.serverIcon(route.serverId))).toBeVisible()
    await expect(page.getByTestId(tid.channelRow(route.channelId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toHaveCount(1)
    await expect.poll(() => deletes.frames.filter((frame) => (
      frame.serverId === route.serverId
    ))).toHaveLength(0)
    expect(await serverIds("carol")).toContain(route.serverId)
    await page.unroute(pattern)
  })
})
