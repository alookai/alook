import type { BrowserContext, Page, Route } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"

import { tid } from "./_fixtures/testids"
import type { CaseActors, CaseResources } from "./_fixtures/case-fixture"

async function prepareCase(actors: CaseActors, caseResources: CaseResources) {
  const { userId } = actors
  const coldRootStorageKey = `community:lastRoute:${encodeURIComponent(userId("alice"))}`
  async function installColdRootProbe(page: Page, destination: string | null) {
    await page.addInitScript(({ storageKey, storedDestination, machinesPendingTestId }) => {
      const target = window as typeof window & {
        __communityColdRootProbe?: ColdRootProbe
      }
      target.__communityColdRootProbe = { machinesSeen: false }
      try {
        if (storedDestination)
          localStorage.setItem(storageKey, storedDestination)
        else
          localStorage.removeItem(storageKey)
      }
      catch { }
      const inspect = () => {
        const machines = document.querySelector(`[data-community-main-kind="machines"], [data-testid="${machinesPendingTestId}"]`)
        if (machines)
          target.__communityColdRootProbe!.machinesSeen = true
      }
      const observe = () => {
        if (!document.documentElement) {
          globalThis.setTimeout(observe, 0)
          return
        }
        new MutationObserver(inspect).observe(document.documentElement, {
          childList: true,
          subtree: true,
        })
        inspect()
      }
      observe()
    }, {
      storageKey: coldRootStorageKey,
      storedDestination: destination,
      machinesPendingTestId: tid.pendingMain("machines"),
    })
  }
  async function closeHeldContext(context: BrowserContext, gate: Awaited<ReturnType<typeof holdApplicationScripts>>) {
    gate.abort()
    await caseResources.closeContext(context)
  }
  return { coldRootStorageKey, installColdRootProbe, closeHeldContext }
}

type Surface = "list" | "detail" | "neutral"
type Sidebar = "me" | "server" | "none"

type ExpectedFrame = {
  route: string
  surface: Surface
  sidebar: Sidebar
  main: string
  serverId?: string
}

type ColdRootProbe = {
  machinesSeen: boolean
}

async function expectNoMachinesDuringColdRootRestore(page: Page) {
  expect(await page.evaluate(() => (
    window as typeof window & { __communityColdRootProbe?: ColdRootProbe }
  ).__communityColdRootProbe)).toEqual({ machinesSeen: false })
}

async function holdApplicationScripts(page: Page, caseResources: CaseResources) {
  let releaseGate!: () => void
  let disposition: "continue" | "abort" = "continue"
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  caseResources.own(releaseGate, async (captured) => { captured() })
  let hits = 0
  let sessionRequests = 0
  let documentHtml: Promise<string> | undefined
  page.on("response", response => {
    if (response.request().resourceType() === "document" && response.request().frame() === page.mainFrame()) documentHtml = response.text()
  })
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/get-session") sessionRequests += 1
  })
  const handler = async (route: Route) => {
    if (!/\/_next\/.*\.js(?:\?|$)/.test(route.request().url())) {
      await route.continue()
      return
    }
    hits += 1
    await gate
    if (disposition === "abort") await route.abort("aborted")
    else await route.continue()
  }
  await page.route("**/_next/**", handler)
  return {
    hits: () => hits,
    sessionRequests: () => sessionRequests,
    documentHtml: () => {
      if (!documentHtml) throw new Error("Original document response was not captured")
      return documentHtml
    },
    release: () => { releaseGate() },
    abort: () => {
      disposition = "abort"
      releaseGate()
    },
  }
}

function captureCommunityTraffic(page: Page) {
  const requests: Array<{ method: string; pathname: string; search: string }> = []
  const responses: Array<{ method: string; pathname: string; search: string; status: number }> = []
  const failures: Array<{ method: string; pathname: string; search: string; error: string }> = []
  let sockets = 0
  page.on("request", (request) => {
    const { pathname, search } = new URL(request.url())
    if (pathname.startsWith("/api/community/")) {
      requests.push({ method: request.method(), pathname, search })
    }
  })
  page.on("response", (response) => {
    const { pathname, search } = new URL(response.url())
    if (pathname.startsWith("/api/community/")) {
      responses.push({
        method: response.request().method(),
        pathname,
        search,
        status: response.status(),
      })
    }
  })
  page.on("requestfailed", (request) => {
    const { pathname, search } = new URL(request.url())
    if (pathname.startsWith("/api/community/")) {
      failures.push({
        method: request.method(),
        pathname,
        search,
        error: request.failure()?.errorText ?? "unknown",
      })
    }
  })
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.endsWith("/user")) sockets += 1
  })
  return { requests, responses, failures, sockets: () => sockets }
}

async function expectDocumentRouteFallback(
  page: Page,
  expected: ExpectedFrame,
  distinctiveStrings: string[],
  originalHtml: Promise<string>,
) {
  const fallback = await page.evaluate(({ html, initialId, mainId, railId, userBarId, meId, serverId }) => {
    const document = new DOMParser().parseFromString(html, "text/html")
    const frames = Array.from(document.querySelectorAll(`[data-testid="${initialId}"]`))
    const primary = frames.filter(node => !node.parentElement?.closest('[hidden][id^="S:"]'))
    if (primary.length !== 1) return null
    const frame = primary[0]
    const count = (id: string) => frame.querySelectorAll(`[data-testid="${id}"]`).length
    return {
      route: frame.getAttribute("data-community-route-kind"),
      primaryCount: primary.length,
      unexplainedExtras: frames.filter(node => node !== frame && !node.parentElement?.closest('[hidden][id^="S:"]')).length,
      rail: count(railId), userBar: count(userBarId), me: count(meId),
      server: frame.querySelectorAll(`[data-testid^="${serverId}"]`).length,
      main: count(mainId), placeholders: frame.querySelectorAll('[data-slot="skeleton"], [data-community-unresolved-main]').length,
      buttons: frame.querySelectorAll("button").length, links: frame.querySelectorAll("a").length,
      text: frame.textContent ?? "",
      customBootstrap: document.querySelectorAll('[data-slot="community-restore-bootstrap"]').length,
    }
  }, { html: await originalHtml, initialId: tid.initialFrame, mainId: tid.pendingMain(expected.main),
    railId: tid.initialRailPending, userBarId: tid.initialUserBarPending, meId: tid.dmSidebarPending,
    serverId: expected.serverId ? tid.channelSidebarPending(expected.serverId) : tid.channelSidebarPending("") })
  expect(fallback).not.toBeNull()
  expect(fallback!.route).toBe(expected.route)
  expect(fallback!.primaryCount).toBe(1)
  expect(fallback!.unexplainedExtras).toBe(0)
  expect(fallback!.customBootstrap).toBe(0)
  expect(fallback!.rail).toBe(expected.sidebar !== "none" ? 1 : 0)
  expect(fallback!.userBar).toBe(expected.sidebar !== "none" ? 1 : 0)
  expect(fallback!.me).toBe(expected.sidebar === "me" ? 1 : 0)
  expect(fallback!.server).toBe(expected.sidebar === "server" ? 1 : 0)
  expect(fallback!.main).toBe(1)
  expect(fallback!.placeholders).toBeGreaterThan(0)
  expect(fallback!.buttons).toBe(0)
  expect(fallback!.links).toBe(0)
  for (const value of distinctiveStrings) expect(fallback!.text).not.toContain(value)
}

test.describe("community initial-load module skeletons", () => {
  async function prepareCase1(actors: CaseActors, caseResources: CaseResources) {
    const { coldRootStorageKey, installColdRootProbe, closeHeldContext } = await prepareCase(actors, caseResources)
    const { userId } = actors
    const { seedChannel, seedDm, seedDmMessage, seedMessage, seedServer } = actors.seed
    const stamp = Date.now()
    const serverName: string = `COLD SERVER ${stamp}`
    const channelName: string = `cold-channel-${stamp}`
    const privateMessage: string = `PRIVATE COLD MESSAGE ${stamp}`
    const serverId: string = await seedServer("alice", serverName)
    const channelId: string = await seedChannel("alice", serverId, channelName)
    const channelMessageId: string = await seedMessage("alice", channelId, privateMessage)
    const dmId: string = await seedDm("alice", userId("bob"))
    await seedDmMessage("alice", dmId, privateMessage)
    return { coldRootStorageKey, installColdRootProbe, closeHeldContext, serverId, channelId, dmId, serverName, channelName, channelMessageId, privateMessage }
  }

  test("cold mobile documents retain URL-owned fallbacks and authorized RSC content", async ({ caseActors, caseResources }, testInfo) => {
    test.setTimeout(240_000)

    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { closeHeldContext, serverId, channelId, dmId, serverName, channelName, privateMessage } = await prepareCase1(actors, caseResources)

    const cases: Array<[string, ExpectedFrame]> = [
      ["/c", { route: "community-root-redirect", surface: "neutral", sidebar: "none", main: "route-resolution" }],
      ["/c/me", { route: "me-root", surface: "list", sidebar: "me", main: "me-root" }],
      ["/c/me/friends", { route: "me-friends", surface: "detail", sidebar: "me", main: "friends" }],
      ["/c/me/machines", { route: "me-machines", surface: "detail", sidebar: "me", main: "machines" }],
      ["/c/me/bots", { route: "me-bots", surface: "detail", sidebar: "me", main: "bots" }],
      [`/c/me/${dmId}`, { route: "dm-detail", surface: "detail", sidebar: "me", main: "dm" }],
      [`/c/channels/${serverId}`, { route: "server-root", surface: "list", sidebar: "server", main: "server-landing", serverId }],
      [`/c/channels/${serverId}/${channelId}`, { route: "server-detail", surface: "detail", sidebar: "server", main: "server-conversation", serverId }],
      [`/c/channels/${serverId}/settings`, { route: "server-settings-redirect", surface: "list", sidebar: "server", main: "server-landing", serverId }],
      ["/c/me/not%5Cdm", { route: "unknown", surface: "neutral", sidebar: "none", main: "route-resolution" }],
    ]

    for (const [pathname, expected] of cases) {
      const { context, page } = await asUser("alice")
      await page.setViewportSize({ width: 390, height: 844 })
      const gate = await holdApplicationScripts(page, caseResources)
      const traffic = captureCommunityTraffic(page)
      await page.goto(pathname, { waitUntil: "commit" })
      await expect.poll(gate.hits).toBeGreaterThan(0)
      expect(gate.sessionRequests()).toBe(0)
      await expectDocumentRouteFallback(page, expected, [serverName, channelName, privateMessage], gate.documentHtml())
      if (expected.main === "dm" || expected.main === "server-conversation") {
        await expect(page.getByText(privateMessage, { exact: true }).filter({ visible: true })).toHaveCount(1)
        await expect(page.getByTestId(tid.messageScroller).filter({ visible: true })).toHaveCount(1)
      }
      if (pathname === "/c") {
        await testInfo.attach("community-root-neutral-390x844", {
          body: await page.screenshot(),
          contentType: "image/png",
        })
      }
      expect(traffic.requests).toEqual([])
      expect(traffic.sockets()).toBe(0)
      await closeHeldContext(context, gate)
    }
  })

  test("desktop cold documents retain route-owned fallback columns and RSC content", async ({ caseActors, caseResources }, testInfo) => {
    test.setTimeout(120_000)

    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { closeHeldContext, serverId, channelId, dmId, serverName, channelName, privateMessage } = await prepareCase1(actors, caseResources)

    for (const [pathname, expected] of [
      ["/c", { route: "community-root-redirect", surface: "neutral", sidebar: "none", main: "route-resolution" }],
      [`/c/me/${dmId}`, { route: "dm-detail", surface: "detail", sidebar: "me", main: "dm" }],
      [`/c/channels/${serverId}`, { route: "server-root", surface: "list", sidebar: "server", main: "server-landing", serverId }],
      [`/c/channels/${serverId}/${channelId}`, { route: "server-detail", surface: "detail", sidebar: "server", main: "server-conversation", serverId }],
    ] satisfies Array<[string, ExpectedFrame]>) {
      const { context, page } = await asUser("alice")
      await page.setViewportSize({ width: 1280, height: 900 })
      const gate = await holdApplicationScripts(page, caseResources)
      const traffic = captureCommunityTraffic(page)
      await page.goto(pathname, { waitUntil: "commit" })
      await expect.poll(gate.hits).toBeGreaterThan(0)
      expect(gate.sessionRequests()).toBe(0)
      await expectDocumentRouteFallback(page, expected, [serverName, channelName, privateMessage], gate.documentHtml())
      if (expected.main === "dm" || expected.main === "server-conversation") {
        await expect(page.getByText(privateMessage, { exact: true }).filter({ visible: true })).toHaveCount(1)
        await expect(page.getByTestId(tid.messageScroller).filter({ visible: true })).toHaveCount(1)
      }
      if (pathname === "/c") {
        await testInfo.attach("community-root-neutral-1280x900", {
          body: await page.screenshot(),
          contentType: "image/png",
        })
      }
      expect(traffic.requests).toEqual([])
      expect(traffic.sockets()).toBe(0)
      await closeHeldContext(context, gate)
    }
  })

  test("Android cold root restores channel, DM, and Bots without any Machines DOM", async ({ caseActors, caseResources }) => {
    test.setTimeout(180_000)

    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { installColdRootProbe, serverId, channelId, dmId, serverName, channelName, privateMessage } = await prepareCase1(actors, caseResources)

    const cases = [
      {
        destination: `/c/channels/${serverId}/${channelId}`,
        ready: (page: Page) => page.getByText(privateMessage, { exact: true }).first(),
      },
      {
        destination: `/c/me/${dmId}`,
        ready: (page: Page) => page.getByText(privateMessage, { exact: true }).first(),
      },
      {
        destination: "/c/me/bots",
        ready: (page: Page) => page.getByRole("button", { name: /Create a bot|Connect a machine/ }),
      },
    ]

    for (const { destination, ready } of cases) {
      const { context, page } = await asUser("alice")
      await page.setViewportSize({ width: 390, height: 844 })
      await installColdRootProbe(page, destination)
      const gate = await holdApplicationScripts(page, caseResources)
      await page.goto("/c", { waitUntil: "commit" })
      await expect.poll(gate.hits).toBeGreaterThan(0)
      expect(gate.sessionRequests()).toBe(0)
      await expectDocumentRouteFallback(page, {
        route: "community-root-redirect",
        surface: "neutral",
        sidebar: "none",
        main: "route-resolution",
      }, [serverName, channelName, privateMessage], gate.documentHtml())
      const historyLength = await page.evaluate(() => history.length)

      gate.release()
      await expect.poll(() => new URL(page.url()).pathname).toBe(destination)
      await expect(ready(page)).toBeVisible({ timeout: 30_000 })
      expect(await page.evaluate(() => history.length)).toBe(historyLength)
      await expectNoMachinesDuringColdRootRestore(page)
      await caseResources.closeContext(context)
    }
  })

  test("Android cold root falls back to Machines only without valid account memory", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { installColdRootProbe, serverName, channelName, privateMessage } = await prepareCase1(actors, caseResources)

    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    await installColdRootProbe(page, null)
    const gate = await holdApplicationScripts(page, caseResources)
    await page.goto("/c", { waitUntil: "commit" })
    await expect.poll(gate.hits).toBeGreaterThan(0)
    expect(gate.sessionRequests()).toBe(0)
    await expectDocumentRouteFallback(page, {
      route: "community-root-redirect",
      surface: "neutral",
      sidebar: "none",
      main: "route-resolution",
    }, [serverName, channelName, privateMessage], gate.documentHtml())
    const historyLength = await page.evaluate(() => history.length)

    gate.release()
    await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me/machines")
    await expect(page.getByTestId(tid.machinePairOpen)).toBeVisible({ timeout: 30_000 })
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
  })

  test("a stale cold-root DM is replaced by the verified Machines fallback", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { coldRootStorageKey, installColdRootProbe, serverName, channelName, privateMessage } = await prepareCase1(actors, caseResources)

    const { page } = await asUser("alice")
    const missingDm = `/c/me/dm_missing_${Date.now()}`
    await page.setViewportSize({ width: 390, height: 844 })
    await installColdRootProbe(page, missingDm)
    const gate = await holdApplicationScripts(page, caseResources)
    await page.goto("/c", { waitUntil: "commit" })
    await expect.poll(gate.hits).toBeGreaterThan(0)
    expect(gate.sessionRequests()).toBe(0)
    await expectDocumentRouteFallback(page, {
      route: "community-root-redirect",
      surface: "neutral",
      sidebar: "none",
      main: "route-resolution",
    }, [serverName, channelName, privateMessage], gate.documentHtml())
    const historyLength = await page.evaluate(() => history.length)

    gate.release()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
      .toBe("/c/me/machines")
    await expect(page.getByTestId(tid.machinePairOpen)).toBeVisible({ timeout: 30_000 })
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
    expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), coldRootStorageKey))
      .toBe("/c/me/machines")
  })

  test("639↔640 preserves one RSC main node with zero request or socket delta", async ({ caseActors, caseResources }) => {
    test.setTimeout(120_000)

    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { closeHeldContext, serverId, channelId, dmId, privateMessage } = await prepareCase1(actors, caseResources)

    for (const pathname of [
      `/c/me/${dmId}`,
      `/c/channels/${serverId}/${channelId}`,
    ] as const) {
      const { context, page } = await asUser("alice")
      await page.setViewportSize({ width: 639, height: 844 })
      const gate = await holdApplicationScripts(page, caseResources)
      await page.goto(pathname, { waitUntil: "commit" })
      await expect.poll(gate.hits).toBeGreaterThan(0)
      expect(gate.sessionRequests()).toBe(0)
      await expect(page.getByText(privateMessage, { exact: true }).filter({ visible: true })).toHaveCount(1)
      const main = page.locator('[data-slot="community-main-panel-content"]').filter({ visible: true })
      await expect(main).toBeVisible()
      await main.evaluate((node) => { Reflect.set(window, "__communityInitialMain", node) })

      const traffic = captureCommunityTraffic(page)
      await page.setViewportSize({ width: 640, height: 844 })
      await expect(main).toBeVisible()
      expect(await main.evaluate((node) => (
        Reflect.get(window, "__communityInitialMain") === node
      ))).toBe(true)
      await page.setViewportSize({ width: 639, height: 844 })
      await expect(main).toBeVisible()
      expect(await main.evaluate((node) => (
        Reflect.get(window, "__communityInitialMain") === node
      ))).toBe(true)
      expect(traffic.requests).toEqual([])
      expect(traffic.sockets()).toBe(0)
      await closeHeldContext(context, gate)
    }
  })

  test("releasing scripts mounts one server-seeded user shell without duplicate route work", async ({ caseActors, caseResources }) => {
    test.setTimeout(120_000)

    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId, serverName, channelName, channelMessageId, privateMessage } = await prepareCase1(actors, caseResources)

    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    const gate = await holdApplicationScripts(page, caseResources)
    const traffic = captureCommunityTraffic(page)
    await page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
    await expect.poll(gate.hits).toBeGreaterThan(0)
    expect(gate.sessionRequests()).toBe(0)
    await expectDocumentRouteFallback(page, {
      route: "server-detail",
      surface: "detail",
      sidebar: "server",
      main: "server-conversation",
      serverId,
    }, [serverName, channelName, privateMessage], gate.documentHtml())
    expect(traffic.requests).toEqual([])
    expect(traffic.sockets()).toBe(0)

    await expect(page.getByTestId(tid.message(channelMessageId)).filter({ visible: true })).toHaveCount(1)
    await expect(page.getByTestId(tid.message(channelMessageId)).filter({ visible: true }).getByText(privateMessage, { exact: true })).toBeVisible()
    gate.release()
    await expect(page.getByTestId(tid.initialFrame)).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByTestId(tid.composerInput)).toBeVisible({ timeout: 30_000 })
    await expect.poll(traffic.sockets).toBe(1)
    await expect(page.getByTestId(tid.message(channelMessageId))).toBeVisible()
    await expect(page.getByTestId(tid.message(channelMessageId)).getByText(privateMessage, { exact: true })).toBeVisible()
    await page.waitForTimeout(200)
    const targetReadPaths = new Set([
      `/api/community/channels/${channelId}`,
      `/api/community/channels/${channelId}/read-state`,
      `/api/community/channels/${channelId}/messages`,
    ])
    expect(traffic.requests.filter(({ method, pathname }) => method === "GET" && targetReadPaths.has(pathname))).toEqual([])
    expect(traffic.failures.filter(({ pathname }) => targetReadPaths.has(pathname))).toEqual([])
    const readOnlyPostPaths = new Set([
      "/api/community/messages/batch",
      "/api/community/messages/tags/batch",
      "/api/community/channels/participants/batch",
    ])
    expect(traffic.requests.filter(({ method, pathname }) => (
      !["GET", "HEAD", "OPTIONS"].includes(method)
      && !(method === "POST" && readOnlyPostPaths.has(pathname))
    )))
      .toEqual([])
  })
})
