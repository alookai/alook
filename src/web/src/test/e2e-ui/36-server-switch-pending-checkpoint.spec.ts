import type { Page, Request, Response, Route, WebSocket } from "@playwright/test"
import { test, expect, userId } from "./_fixtures/community-fixture"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { expectConversationReady, observeConversationTransport } from "./_fixtures/conversation-readiness"
import { runRenderedNavigation, type RenderedContract, type RenderedObservation } from "./_fixtures/rendered-navigation"
import { WEB_URL } from "./_setup/paths"

test.beforeEach(async ({ baseURL }) => {
  expect(baseURL, "seed helper origin must match the browser before any mutation").toBeTruthy()
  expect(new URL(WEB_URL).origin).toBe(new URL(baseURL!).origin)
})

type HistoryEvent = { kind: "pushState" | "replaceState" | "popstate"; pathname: string }
async function installHistoryProbe(page: Page) {
  await page.addInitScript(() => {
    const state = window as typeof window & { __communityHistoryEvents?: HistoryEvent[] }
    state.__communityHistoryEvents = []
    for (const kind of ["pushState", "replaceState"] as const) {
      const original = history[kind].bind(history)
      history[kind] = (...args) => { state.__communityHistoryEvents!.push({ kind, pathname: new URL(String(args[2] ?? location.href), location.href).pathname }); return original(...args) }
    }
    addEventListener("popstate", () => state.__communityHistoryEvents!.push({ kind: "popstate", pathname: location.pathname }))
  })
}

async function holdServerTransition(page: Page, serverId: string) {
  let releaseRoute!: () => void; let releaseReads!: () => void
  const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve })
  const readGate = new Promise<void>((resolve) => { releaseReads = resolve })
  const installedAt = Date.now()
  const requests: Array<{ purpose: string; pathname: string; query: string; rsc: boolean; prefetch: boolean; at: number }> = []
  let navigationReleasedAt: number | null = null; let dataReleasedAt: number | null = null
  const handlers = new Map<string, (route: Route) => Promise<void>>()
  for (const purpose of ["navigation", "categories", "channels", "unreads"] as const) {
    const pattern = purpose === "navigation" ? `**/c/channels/${serverId}**` : `**/api/community/servers/${serverId}/${purpose}**`
    const handler = async (route: Route) => {
      const url = new URL(route.request().url()); const headers = route.request().headers()
      if (purpose !== "navigation" && url.pathname !== `/api/community/servers/${serverId}/${purpose}`) return route.continue()
      requests.push({ purpose, pathname: url.pathname, query: url.search, rsc: headers.rsc === "1", prefetch: !!(headers["next-router-prefetch"] || headers["next-router-segment-prefetch"]), at: Date.now() })
      await (purpose === "navigation" ? routeGate : readGate); await route.continue()
    }
    handlers.set(pattern, handler); await page.route(pattern, handler)
  }
  return {
    snapshot: () => ({ serverId, installedAt, requests, navigationReleasedAt, dataReleasedAt }),
    heldNavigation: () => requests.filter((request) => request.purpose === "navigation").length,
    expectDataHeld: async () => {
      await expect.poll(() => ["categories", "channels"].every((purpose) => requests.some((request) => request.purpose === purpose))).toBe(true)
      expect(dataReleasedAt).toBeNull()
    },
    releaseNavigation: () => { navigationReleasedAt ??= Date.now(); releaseRoute() },
    releaseData: () => { dataReleasedAt ??= Date.now(); releaseReads() },
    release: async () => {
      navigationReleasedAt ??= Date.now(); dataReleasedAt ??= Date.now(); releaseRoute(); releaseReads()
      await Promise.all([...handlers].map(([pattern, handler]) => page.unroute(pattern, handler)))
    },
  }
}

async function persistedTree(page: Page, accountId: string, serverId: string, channelId: string) {
  return page.evaluate(async ({ accountId, serverId, channelId }) => {
    const startedAt = performance.timeOrigin + performance.now()
    if (!(await indexedDB.databases()).some((db) => db.name === "keyval-store")) return { startedAt, at: performance.timeOrigin + performance.now(), blob: false, serverComplete: false, channel: false, categories: false, channelCount: 0, categoryCount: 0 }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error("persistence database absent during readonly inspection")) }
    })
    try {
      const raw = await new Promise<unknown>((resolve, reject) => {
        const transaction = db.transaction("keyval", "readonly"); const request = transaction.objectStore("keyval").get(`alook:qc:v2:${accountId}:client`)
        let value: unknown; request.onsuccess = () => { value = request.result }; transaction.oncomplete = () => resolve(value)
        transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error)
      })
      if (raw === undefined) return { startedAt, at: performance.timeOrigin + performance.now(), blob: false, serverComplete: false, channel: false, categories: false, channelCount: 0, categoryCount: 0 }
      if (typeof raw !== "string") throw new Error("invalid persisted canonical blob")
      const blob = JSON.parse(raw) as { buster: string; timestamp: number; clientState: { queries: Array<{ queryKey: unknown[]; state: { data: Array<Record<string, unknown>> } }> } }
      const at = performance.timeOrigin + performance.now()
      if (blob.buster !== "v2" || typeof blob.timestamp !== "number" || !Number.isFinite(blob.timestamp) || at - blob.timestamp > 24 * 60 * 60 * 1000 || blob.timestamp > at) throw new Error("invalid canonical persistence lifetime")
      const collections = blob.clientState.queries.filter((query) => query.queryKey.length === 4 && query.queryKey[0] === "community" && query.queryKey[1] === "db" && query.queryKey[2] === accountId)
      const rows = (name: string) => collections.find((query) => query.queryKey[3] === name)?.state.data ?? []
      return { startedAt, at, blob: true, buster: blob.buster, timestamp: blob.timestamp,
        serverComplete: rows("servers").some((row) => row.id === serverId && row.detailComplete === true),
        channel: rows("channels").some((row) => row.id === channelId && row.serverId === serverId),
        categories: collections.some((query) => query.queryKey[3] === "categories"),
        channelCount: rows("channels").filter((row) => row.serverId === serverId).length,
        categoryCount: rows("categories").filter((row) => row.serverId === serverId).length }
    } finally { db.close() }
  }, { accountId, serverId, channelId })
}

function observeAlternateStructure(page: Page, channelIds: string[], serverIds: string[]) {
  const events: Array<{ at: number; source: string; targetIds: string[]; targetServers: string[] }> = []; const errors: string[] = []
  const reads: Promise<void>[] = []; const sockets = new Map<WebSocket, (frame: { payload: string | Buffer }) => void>()
  const find = (body: unknown) => {
    const found = new Set<string>(); const servers = new Set<string>()
    const walk = (value: unknown) => {
      if (!value || typeof value !== "object") return
      if (Array.isArray(value)) { value.forEach(walk); return }
      for (const [key, child] of Object.entries(value)) { if (["id", "channelId"].includes(key) && typeof child === "string" && channelIds.includes(child)) found.add(child); else if (["id", "serverId"].includes(key) && typeof child === "string" && serverIds.includes(child)) servers.add(child); else walk(child) }
    }
    walk(body); return { targetIds: [...found], targetServers: [...servers] }
  }
  const onResponse = (response: Response) => {
    const pathname = new URL(response.url()).pathname
    if (!pathname.startsWith("/api/community/") || response.status() !== 200 || !response.headers()["content-type"]?.includes("json")) return
    reads.push(response.json().then((body) => { const matches = find(body); if (matches.targetIds.length || matches.targetServers.length) events.push({ at: Date.now(), source: pathname, ...matches }) }, () => { errors.push(`unread-structure-response:${pathname}`) }))
  }
  const onSocket = (socket: WebSocket) => {
    const handler = ({ payload }: { payload: string | Buffer }) => {
      try { const matches = find(JSON.parse(String(payload))); if (matches.targetIds.length || matches.targetServers.length) events.push({ at: Date.now(), source: "websocket", ...matches }) }
      catch { errors.push("invalid-structure-websocket-json") }
    }
    sockets.set(socket, handler); socket.on("framereceived", handler)
  }
  page.on("response", onResponse); page.on("websocket", onSocket)
  return { events, errors, settle: async () => { await Promise.all(reads); expect(errors).toEqual([]) }, stop: () => {
    page.off("response", onResponse); page.off("websocket", onSocket); for (const [socket, handler] of sockets) socket.off("framereceived", handler)
  } }
}

function expectAtomicTargetFrames(observation: RenderedObservation, scope: string, targetRow: string, forbiddenRows: string[]) {
  const target = observation.frames.flatMap((frame) => frame.scopes.filter((owner) => owner.scope === scope && owner.visible))
  expect(target.length).toBeGreaterThan(0); expect(new Set(target.map((owner) => owner.owner)).size).toBe(1)
  expect(target[0].rows).toContain(targetRow)
  for (const owner of target) { expect(owner.rows).toContain(targetRow); expect(owner.rows.some((row) => forbiddenRows.includes(row))).toBe(false) }
}

async function clickServer(page: Page, serverId: string) {
  const icon = page.getByTestId(tid.serverIcon(serverId)); await icon.focus()
  await expect(icon.locator("xpath=ancestor::*[@data-slot='context-menu-trigger'][1]")).toBeVisible()
  await icon.click({ noWaitAfter: true })
}
async function expectActiveServer(page: Page, activeId: string, inactiveId: string) {
  await expect(page.getByTestId(tid.serverIcon(activeId))).toHaveClass(/cursor-default/)
  await expect(page.getByTestId(tid.serverIcon(inactiveId))).toHaveClass(/cursor-pointer/)
}

test("server switching exposes one target-scoped cold checkpoint and skips it when warm", async ({ asUser }, testInfo) => {
  test.setTimeout(180_000)
  const stamp = Date.now()
  const serverA = await seedServer("alice", `Checkpoint A ${stamp}`); const serverB = await seedServer("alice", `Checkpoint B ${stamp}`)
  const serverC = await seedServer("alice", `Checkpoint C ${stamp}`); const serverD = await seedServer("alice", `Checkpoint D ${stamp}`)
  const serverE = await seedServer("alice", `Checkpoint E ${stamp}`); const serverF = await seedServer("alice", `Checkpoint F ${stamp}`)
  const serverAName = `Checkpoint-A-${stamp}`; const serverBName = `Checkpoint-B-${stamp}`
  const channelAName = `checkpoint-a-${stamp}`; const channelBName = `checkpoint-b-${stamp}`
  const channelCName = `checkpoint-c-${stamp}`; const channelDName = `checkpoint-d-${stamp}`
  const channelA = await seedChannel("alice", serverA, channelAName); const channelB = await seedChannel("alice", serverB, channelBName)
  const channelC = await seedChannel("alice", serverC, channelCName); const channelD = await seedChannel("alice", serverD, channelDName)
  const channelE = await seedChannel("alice", serverE, `checkpoint-e-${stamp}`); const channelF = await seedChannel("alice", serverF, `checkpoint-f-${stamp}`)
  const { page } = await asUser("alice")
  const transport = observeConversationTransport(page); const alternate = observeAlternateStructure(page, [channelC, channelD, channelE, channelF], [serverC, serverD, serverE, serverF])
  const gates: Awaited<ReturnType<typeof holdServerTransition>>[] = []
  const hold = async (server: string) => { const gate = await holdServerTransition(page, server); gates.push(gate); return gate }
  const coldC = await hold(serverC); const coldD = await hold(serverD); const coldE = await hold(serverE); const coldF = await hold(serverF)
  const root = (server: string) => `/c/channels/${server}`; const path = (server: string, channel: string) => `${root(server)}/${channel}`; const scope = (server: string) => `server:${server}`
  const ready = async (server: string, channel?: string) => {
    if (!channel) await expect.poll(() => new URL(page.url()).pathname.startsWith(`${root(server)}/`)).toBe(true)
    const pathname = channel ? path(server, channel) : new URL(page.url()).pathname
    expect(pathname).toMatch(new RegExp(`^/c/channels/${server}/[^/]+$`))
    const selected = pathname.split("/").at(-1)!
    await expectConversationReady(page, { pathname, serverId: server, channelId: selected, kind: "text", empty: true }, testInfo); transport.assertHealthy()
    return selected
  }
  const mutations: string[] = []; const readOnly = new Set(["/api/community/messages/batch", "/api/community/messages/tags/batch", "/api/community/channels/participants/batch"])
  const onRequest = (request: Request) => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && !(request.method() === "POST" && readOnly.has(new URL(request.url()).pathname))) mutations.push(`${request.method()} ${new URL(request.url()).pathname}`) }
  const coldBaselines: unknown[] = []
  try {
    await installHistoryProbe(page); await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(path(serverA, channelA))
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 }); await ready(serverA, channelA)
    for (const [server, channel] of [[serverC, channelC], [serverD, channelD], [serverE, channelE], [serverF, channelF]]) {
      const baseline = await persistedTree(page, userId("alice"), server, channel); expect(baseline.serverComplete).toBe(false); expect(baseline.channel).toBe(false); expect(baseline.channelCount).toBe(0); expect(baseline.categoryCount).toBe(0)
      coldBaselines.push({ server, channel, baseline, freshContext: true, seededBeforeContext: true })
    }
    page.on("request", onRequest)
    await clickServer(page, serverB); const selectedB = await ready(serverB)
    await expect(page.locator("#sidebar").getByRole("button", { name: serverBName, exact: true })).toBeVisible()
    const rememberedBPath = new URL(page.url()).pathname
    await clickServer(page, serverA); await ready(serverA, channelA)
    const warmB = await runRenderedNavigation(page, testInfo, "warm-B", `[data-testid="${tid.serverIcon(serverB)}"]`, {
      paths: [path(serverA, channelA), root(serverB), rememberedBPath], finalPath: rememberedBPath, scopes: [scope(serverA), scope(serverB)], finalScope: scope(serverB), channelId: selectedB, header: "all", pendingKind: "server-conversation", subtype: "text", forbiddenRows: [channelA],
    }, async () => { await clickServer(page, serverB); await expect(page.getByTestId(tid.channelSidebarPending(serverB))).toHaveCount(0); await expect(page.getByTestId(tid.pendingMain("server-landing"))).toHaveCount(0); await ready(serverB, selectedB) })
    expect(warmB.frames.flatMap((frame) => frame.cold).some((cold) => cold.serverId === serverB)).toBe(false)
    expectAtomicTargetFrames(warmB, scope(serverB), channelB, [channelA])
    await clickServer(page, serverA); await ready(serverA, channelA)
    await expect(page.locator("#sidebar").getByRole("button", { name: serverAName, exact: true })).toBeVisible()
    await expectActiveServer(page, serverA, serverB)

    const coldJourney = async (server: string, channel: string, gate: Awaited<ReturnType<typeof holdServerTransition>>, mobile: boolean) => {
      const contract: RenderedContract = {
        paths: [mobile ? root(serverA) : path(serverA, channelA), root(server)], finalPath: mobile ? root(server) : path(server, channel), scopes: [scope(server)], finalScope: scope(server), allowedColdServers: [server],
        ...(mobile ? { listStates: ["server"], finalListState: "server" } : { header: "all", listStates: ["server"] }), pendingKind: "server-landing", stationary: mobile, forbiddenRows: [channelA, channelB, ...(server === serverD ? [channelC] : [])],
      }
      const result = await runRenderedNavigation(page, testInfo, `cold-${server}`, `[data-testid="${tid.serverIcon(server)}"]`, contract, async (probe) => {
        await clickServer(page, server); await expect.poll(gate.heldNavigation).toBeGreaterThan(0); gate.releaseNavigation()
        await gate.expectDataHeld(); await alternate.settle()
        await expect(page.getByTestId(tid.channelSidebarPending(server))).toBeVisible()
        await expect(page.getByRole("button", { name: channelAName, exact: true })).toHaveCount(0)
        await expectActiveServer(page, server, serverA); expect(mutations).toEqual([])
        if (mobile) {
          const box = await page.getByTestId(tid.channelSidebarPending(server)).boundingBox(); expect(box).not.toBeNull()
          expect(box!.width).toBeGreaterThan(300); expect(box!.x + box!.width).toBeLessThanOrEqual(390)
        }
        await expect.poll(async () => (await probe.frames()).some((frame) => frame.cold.some((cold) => cold.serverId === server))).toBe(true)
        expect(gate.snapshot().dataReleasedAt).toBeNull(); gate.releaseData()
        await expect(page.getByTestId(tid.channelRow(channel))).toBeVisible({ timeout: 30_000 })
        if (mobile) { await expect.poll(() => new URL(page.url()).pathname).toBe(root(server)); await expect(page.locator('[data-community-mobile-surface="list"]')).toBeVisible() }
        else { const selected = await ready(server); contract.channelId = selected; contract.finalPath = path(server, selected); contract.paths.push(contract.finalPath) }
      })
      const cold = result.frames.flatMap((frame) => frame.cold.filter((cold) => cold.serverId === server))
      expect(cold.length).toBeGreaterThan(0); expect(cold.every((frame) => frame.owner === null && frame.rows.length === 0)).toBe(true)
      if (mobile) for (const frame of cold) { expect(frame.width).toBeGreaterThan(300); expect(frame.right).toBeLessThanOrEqual(390) }
      expectAtomicTargetFrames(result, scope(server), channel, [channelA, channelB, ...(server === serverD ? [channelC] : [])])
      await gate.release()
    }
    await coldJourney(serverC, channelC, coldC, false)
    const rememberedCPath = new URL(page.url()).pathname
    const selectedC = rememberedCPath.split("/").at(-1)!
    await clickServer(page, serverA); await ready(serverA, channelA)
    let durable: Awaited<ReturnType<typeof persistedTree>> | undefined
    await expect.poll(async () => { durable = await persistedTree(page, userId("alice"), serverC, channelC); return durable.blob && durable.serverComplete && durable.channel && durable.categories && durable.categoryCount > 0 }).toBe(true)
    await testInfo.attach("durable-C-before-reload", { body: JSON.stringify(durable), contentType: "application/json" })
    const structuralC = await hold(serverC)
    await page.reload()
    await page.waitForFunction(() => performance.getEntriesByName("alook:restore:complete").length > 0 && performance.getEntriesByName("alook:restore:stable").length > 0)
    await ready(serverA, channelA)
    await page.evaluate(() => { (window as typeof window & { __communityHistoryEvents?: HistoryEvent[] }).__communityHistoryEvents = [] })
    const targetRscStart = Date.now()
    const restoredC = await runRenderedNavigation(page, testInfo, "restored-C-pre-data-release", `[data-testid="${tid.serverIcon(serverC)}"]`, {
      paths: [path(serverA, channelA), root(serverC), rememberedCPath], finalPath: rememberedCPath, scopes: [scope(serverA), scope(serverC)], finalScope: scope(serverC), channelId: selectedC, header: "all", pendingKind: "server-conversation", subtype: "text", forbiddenRows: [channelA, channelB],
    }, async (probe) => {
      await clickServer(page, serverC); await expect.poll(structuralC.heldNavigation).toBeGreaterThan(0); structuralC.releaseNavigation()
      await structuralC.expectDataHeld(); await expect(page.getByTestId(tid.channelRow(channelC))).toBeVisible()
      await expect.poll(async () => (await probe.frames()).some((frame) => frame.scopes.some((owner) => owner.scope === scope(serverC) && owner.visible && owner.rows.includes(channelC)))).toBe(true)
      expect(structuralC.snapshot().dataReleasedAt).toBeNull()
      const preRelease = await page.evaluate(({ scope, rowId }) => {
        const owner = document.querySelector(`[data-community-channel-tree-scope="${scope}"]`)!
        const row = owner.querySelector(`[data-testid="${rowId}"]`)!
        if (!owner || !row) throw new Error("missing pre-release restored tree")
        ;(window as typeof window & { __restoredTreeOwner?: Element }).__restoredTreeOwner = owner
        return { at: performance.timeOrigin + performance.now(), scope, rowId, complete: performance.getEntriesByName("alook:restore:complete").map((entry) => entry.startTime), stable: performance.getEntriesByName("alook:restore:stable").map((entry) => entry.startTime) }
      }, { scope: scope(serverC), rowId: tid.channelRow(channelC) })
      await testInfo.attach("warm-C-before-data-release", { body: JSON.stringify({ preRelease, gate: structuralC.snapshot(), alternate: alternate.events }), contentType: "application/json" })
      structuralC.releaseData(); await ready(serverC, selectedC)
      expect(await page.evaluate((scope) => (window as typeof window & { __restoredTreeOwner?: Element }).__restoredTreeOwner === document.querySelector(`[data-community-channel-tree-scope="${scope}"]`), scope(serverC))).toBe(true)
    })
    const targetRequests = transport.targetRsc(serverC, targetRscStart); expect(targetRequests).toHaveLength(1)
    expect(targetRequests[0]).toMatchObject({ pathname: rememberedCPath, prefetch: false, status: 200 })
    expectAtomicTargetFrames(restoredC, scope(serverC), channelC, [channelA, channelB])
    expect(await page.evaluate(() => (window as typeof window & { __communityHistoryEvents?: HistoryEvent[] }).__communityHistoryEvents)).toEqual([{ kind: "pushState", pathname: rememberedCPath }])
    await structuralC.release(); await clickServer(page, serverA); await ready(serverA, channelA)
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(root(serverA)); await expect(page.getByTestId(tid.serverIcon(serverD))).toBeVisible()
    await coldJourney(serverD, channelD, coldD, true)
    await page.setViewportSize({ width: 1280, height: 900 }); const selectedD = await ready(serverD)

    await expect(page.getByTestId(tid.serverIcon(serverE))).toBeVisible()
    const supersededContract: RenderedContract = {
      paths: [path(serverD, selectedD), root(serverE), root(serverF)], finalPath: path(serverF, channelF), scopes: [scope(serverF)], finalScope: scope(serverF), allowedColdServers: [serverF], header: "all", listStates: ["server"], pendingKind: "server-landing", actionKind: "synthetic", forbiddenRows: [channelA, channelB, channelC, channelD, channelE],
    }
    const superseded = await runRenderedNavigation(page, testInfo, "synthetic-E-to-F", `[data-testid="${tid.serverIcon(serverF)}"]`, supersededContract, async () => {
      await clickServer(page, serverE)
      await page.getByTestId(tid.serverIcon(serverF)).dispatchEvent("click")
      await expect.poll(coldF.heldNavigation).toBeGreaterThan(0); coldF.releaseNavigation(); await coldF.expectDataHeld()
      await expect(page.getByTestId(tid.channelSidebarPending(serverE))).toHaveCount(0); await expectActiveServer(page, serverF, serverD)
      coldE.releaseNavigation(); coldE.releaseData(); await expectActiveServer(page, serverF, serverD)
      coldF.releaseData(); const selectedF = await ready(serverF); supersededContract.channelId = selectedF; supersededContract.finalPath = path(serverF, selectedF); supersededContract.paths.push(supersededContract.finalPath)
    })
    expect(superseded.frames.some((frame) => frame.scopes.some((owner) => owner.scope === scope(serverE)))).toBe(false)
    expectAtomicTargetFrames(superseded, scope(serverF), channelF, [channelA, channelB, channelC, channelD, channelE])
    expect(mutations).toEqual([]); await alternate.settle(); transport.assertHealthy()
  } finally {
    for (const gate of gates) await gate.release()
    page.off("request", onRequest); alternate.stop()
    await testInfo.attach("data-gates-and-cold-baselines", { body: JSON.stringify({ gates: gates.map((gate) => gate.snapshot()), coldBaselines, alternate: alternate.events, errors: alternate.errors, qualification: "fresh context/seeded targets; complete server detail requires held categories+channels; alternate metadata/attention/WS retained, not sole-source provenance" }), contentType: "application/json" })
    await testInfo.attach("conversation-transport", { body: JSON.stringify(transport.snapshot()), contentType: "application/json" }); transport.stop()
    await page.evaluate(() => { delete (window as typeof window & { __restoredTreeOwner?: Element }).__restoredTreeOwner })
    await testInfo.attach("navigation-state", { body: await page.screenshot(), contentType: "image/png" })
  }
})
