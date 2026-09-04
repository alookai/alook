import type { BrowserContext, Page, Route } from "@playwright/test"
import { test, expect, userId } from "./_fixtures/community-fixture"
import { seedChannel, seedDm, seedDmMessage, seedMessage, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

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

const coldRootStorageKey = `community:lastRoute:${encodeURIComponent(userId("alice"))}`

async function installColdRootProbe(page: Page, destination: string | null) {
  await page.addInitScript(({ storageKey, storedDestination, machinesPendingTestId }) => {
    const target = window as typeof window & { __communityColdRootProbe?: ColdRootProbe }
    target.__communityColdRootProbe = { machinesSeen: false }
    try {
      if (storedDestination) localStorage.setItem(storageKey, storedDestination)
      else localStorage.removeItem(storageKey)
    } catch { }

    const inspect = () => {
      const machines = document.querySelector(
        `[data-community-main-kind="machines"], [data-testid="${machinesPendingTestId}"]`,
      )
      if (machines) target.__communityColdRootProbe!.machinesSeen = true
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

async function expectNoMachinesDuringColdRootRestore(page: Page) {
  expect(await page.evaluate(() => (
    window as typeof window & { __communityColdRootProbe?: ColdRootProbe }
  ).__communityColdRootProbe)).toEqual({ machinesSeen: false })
}

async function holdSession(page: Page) {
  let releaseGate!: () => void
  let disposition: "continue" | "abort" = "continue"
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  let hits = 0
  const pattern = "**/api/auth/get-session**"
  const handler = async (route: Route) => {
    hits += 1
    await gate
    if (disposition === "abort") await route.abort("aborted")
    else await route.continue()
  }
  await page.route(pattern, handler)
  return {
    hits: () => hits,
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

async function expectVisibility(locator: ReturnType<Page["getByTestId"]>, visible: boolean) {
  if (visible) await expect(locator).toBeVisible()
  else await expect(locator).toBeHidden()
}

async function expectOwnedFrame(
  page: Page,
  expected: ExpectedFrame,
  distinctiveStrings: string[],
) {
  const frame = page.getByTestId(tid.initialFrame)
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute("data-community-route-kind", expected.route)
  const mobile = (page.viewportSize()?.width ?? 640) < 640
  const shellVisible = expected.sidebar !== "none"
  const detailMobile = mobile && expected.surface === "detail"
  const listMobile = mobile && expected.surface === "list"

  const rail = page.getByTestId(tid.initialRailPending)
  const userBar = page.getByTestId(tid.initialUserBarPending)
  if (shellVisible) {
    await expect(rail).toHaveCount(1)
    await expect(userBar).toHaveCount(1)
    await expectVisibility(rail, !detailMobile)
    await expectVisibility(userBar, !detailMobile)
  } else {
    await expect(rail).toHaveCount(0)
    await expect(userBar).toHaveCount(0)
  }

  const meSidebar = page.getByTestId(tid.dmSidebarPending)
  const serverSidebar = expected.serverId
    ? page.getByTestId(tid.channelSidebarPending(expected.serverId))
    : page.locator(`[data-testid^="${tid.channelSidebarPending("")}"]`)
  await expect(meSidebar).toHaveCount(expected.sidebar === "me" ? 1 : 0)
  await expect(serverSidebar).toHaveCount(expected.sidebar === "server" ? 1 : 0)
  if (expected.sidebar === "me") await expectVisibility(meSidebar, !detailMobile)
  if (expected.sidebar === "server") await expectVisibility(serverSidebar, !detailMobile)

  const main = page.getByTestId(tid.pendingMain(expected.main))
  await expect(main).toHaveCount(1)
  await expectVisibility(main, !listMobile)
  await expect(frame.getByRole("button")).toHaveCount(0)
  await expect(frame.locator("a")).toHaveCount(0)
  for (const value of distinctiveStrings) await expect(frame).not.toContainText(value)
}

async function closeHeldContext(
  context: BrowserContext,
  gate: Awaited<ReturnType<typeof holdSession>>,
) {
  gate.abort()
  await context.close()
}

test.describe.serial("community initial-load module skeletons", () => {
  let serverId: string
  let channelId: string
  let dmId: string
  let serverName: string
  let channelName: string
  let channelMessageId: string
  let privateMessage: string

  test.beforeAll(async () => {
    const stamp = Date.now()
    serverName = `COLD SERVER ${stamp}`
    channelName = `cold-channel-${stamp}`
    privateMessage = `PRIVATE COLD MESSAGE ${stamp}`
    serverId = await seedServer("alice", serverName)
    channelId = await seedChannel("alice", serverId, channelName)
    channelMessageId = await seedMessage("alice", channelId, privateMessage)
    dmId = await seedDm("alice", userId("bob"))
    await seedDmMessage("alice", dmId, privateMessage)
  })

  test("cold mobile paths expose only their URL-owned inert modules", async ({ asUser }, testInfo) => {
    test.setTimeout(240_000)
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
      const gate = await holdSession(page)
      const traffic = captureCommunityTraffic(page)
      await page.goto(pathname, { waitUntil: "commit" })
      await expect.poll(gate.hits).toBeGreaterThan(0)
      await expectOwnedFrame(page, expected, [serverName, channelName, privateMessage])
      if (pathname === "/c") {
        await testInfo.attach("community-root-neutral-390x844", {
          body: await page.screenshot(),
          contentType: "image/png",
        })
      }
      expect(traffic.requests).toEqual([])
      expect(traffic.sockets()).toBe(0)
      if (expected.main === "server-conversation") {
        await expect(page.getByLabel("Resolving conversation")).toBeVisible()
        await expect(page.getByTestId(tid.messageHeaderLeadingLoading)).toHaveCount(0)
        await expect(page.getByTestId(tid.channelComposerShell)).toHaveCount(0)
        await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0)
      }
      await closeHeldContext(context, gate)
    }
  })

  test("desktop cold frames retain all route-owned shell columns", async ({ asUser }, testInfo) => {
    test.setTimeout(120_000)
    for (const [pathname, expected] of [
      ["/c", { route: "community-root-redirect", surface: "neutral", sidebar: "none", main: "route-resolution" }],
      [`/c/me/${dmId}`, { route: "dm-detail", surface: "detail", sidebar: "me", main: "dm" }],
      [`/c/channels/${serverId}`, { route: "server-root", surface: "list", sidebar: "server", main: "server-landing", serverId }],
      [`/c/channels/${serverId}/${channelId}`, { route: "server-detail", surface: "detail", sidebar: "server", main: "server-conversation", serverId }],
    ] satisfies Array<[string, ExpectedFrame]>) {
      const { context, page } = await asUser("alice")
      await page.setViewportSize({ width: 1280, height: 900 })
      const gate = await holdSession(page)
      const traffic = captureCommunityTraffic(page)
      await page.goto(pathname, { waitUntil: "commit" })
      await expect.poll(gate.hits).toBeGreaterThan(0)
      await expectOwnedFrame(page, expected, [serverName, channelName, privateMessage])
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

  test("Android cold root restores channel, DM, and Bots without any Machines DOM", async ({ asUser }) => {
    test.setTimeout(180_000)
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
      const gate = await holdSession(page)
      await page.goto("/c", { waitUntil: "commit" })
      await expect.poll(gate.hits).toBeGreaterThan(0)
      await expectOwnedFrame(page, {
        route: "community-root-redirect",
        surface: "neutral",
        sidebar: "none",
        main: "route-resolution",
      }, [serverName, channelName, privateMessage])
      const historyLength = await page.evaluate(() => history.length)

      gate.release()
      await expect.poll(() => new URL(page.url()).pathname).toBe(destination)
      await expect(ready(page)).toBeVisible({ timeout: 30_000 })
      expect(await page.evaluate(() => history.length)).toBe(historyLength)
      await expectNoMachinesDuringColdRootRestore(page)
      await context.close()
    }
  })

  test("Android cold root falls back to Machines only without valid account memory", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    await installColdRootProbe(page, null)
    const gate = await holdSession(page)
    await page.goto("/c", { waitUntil: "commit" })
    await expect.poll(gate.hits).toBeGreaterThan(0)
    await expect(page.getByTestId(tid.pendingMain("route-resolution"))).toBeVisible()
    await expect(page.getByTestId(tid.pendingMain("machines"))).toHaveCount(0)
    const historyLength = await page.evaluate(() => history.length)

    gate.release()
    await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me/machines")
    await expect(page.getByTestId(tid.machinePairOpen)).toBeVisible({ timeout: 30_000 })
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
  })

  test("a stale cold-root DM is replaced by the verified Machines fallback", async ({ asUser }) => {
    const { page } = await asUser("alice")
    const missingDm = `/c/me/dm_missing_${Date.now()}`
    await page.setViewportSize({ width: 390, height: 844 })
    await installColdRootProbe(page, missingDm)
    const gate = await holdSession(page)
    await page.goto("/c", { waitUntil: "commit" })
    await expect.poll(gate.hits).toBeGreaterThan(0)
    await expect(page.getByTestId(tid.pendingMain("route-resolution"))).toBeVisible()
    const historyLength = await page.evaluate(() => history.length)

    gate.release()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
      .toBe("/c/me/machines")
    await expect(page.getByTestId(tid.machinePairOpen)).toBeVisible({ timeout: 30_000 })
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
    expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), coldRootStorageKey))
      .toBe("/c/me/machines")
  })

  test("639↔640 preserves one pending main node with zero request or socket delta", async ({ asUser }) => {
    test.setTimeout(120_000)
    for (const [pathname, mainKind] of [
      [`/c/me/${dmId}`, "dm"],
      [`/c/channels/${serverId}/${channelId}`, "server-conversation"],
    ] as const) {
      const { context, page } = await asUser("alice")
      await page.setViewportSize({ width: 639, height: 844 })
      const gate = await holdSession(page)
      await page.goto(pathname, { waitUntil: "commit" })
      await expect.poll(gate.hits).toBeGreaterThan(0)
      const main = page.getByTestId(tid.pendingMain(mainKind))
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

  test("releasing identity mounts one user-keyed shell without duplicate route work", async ({ asUser }) => {
    test.setTimeout(120_000)
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    const gate = await holdSession(page)
    const traffic = captureCommunityTraffic(page)
    await page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
    await expect.poll(gate.hits).toBeGreaterThan(0)
    await expect(page.getByTestId(tid.pendingMain("server-conversation"))).toBeVisible()
    expect(traffic.requests).toEqual([])
    expect(traffic.sockets()).toBe(0)

    gate.release()
    await expect(page.getByTestId(tid.initialFrame)).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByTestId(tid.composerInput)).toBeVisible({ timeout: 30_000 })
    await expect.poll(traffic.sockets).toBe(1)
    await expect.poll(() => traffic.responses.filter(({ method, pathname, status }) => (
      method === "GET"
      && pathname === `/api/community/channels/${channelId}/read-state`
      && status === 200
    )).length).toBe(1)
    const exactMessageSearch = `?anchor=${encodeURIComponent(channelMessageId)}`
    await expect.poll(() => traffic.responses.filter(({ method, pathname, search, status }) => (
      method === "GET"
      && pathname === `/api/community/channels/${channelId}/messages`
      && search === exactMessageSearch
      && status === 200
    )).length).toBe(1)
    await page.waitForTimeout(200)
    const exactMessageReads = traffic.requests.filter(({ method, pathname, search }) => (
      method === "GET"
      && pathname === `/api/community/channels/${channelId}/messages`
      && search === exactMessageSearch
    ))
    const exactMessageFailures = traffic.failures.filter(({ method, pathname, search }) => (
      method === "GET"
      && pathname === `/api/community/channels/${channelId}/messages`
      && search === exactMessageSearch
    ))
    expect(exactMessageReads).toHaveLength(1 + exactMessageFailures.length)
    expect(exactMessageFailures.every(({ error }) => error === "net::ERR_ABORTED")).toBe(true)
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
