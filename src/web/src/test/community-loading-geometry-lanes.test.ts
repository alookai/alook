import { describe, expect, it, vi } from "vitest"
import type { BrowserContext, Page } from "@playwright/test"
import { runDesktopPersistedPendingGeometry } from "./e2e-ui/_fixtures/community-loading-geometry"
import { tid } from "./e2e-ui/_fixtures/testids"

const steps = vi.hoisted(() => vi.fn())
vi.mock("./e2e-ui/_fixtures/community-fixture", async () => {
  const { expect: nativeExpect } = await import("vitest")
  const fixtureExpect = (value: unknown, message?: string) => {
    if (value && typeof value === "object" && "fixtureLocator" in value) {
      const locator = value as unknown as { visible: boolean; count: number; attributes: Record<string, string> }
      return {
        toBeVisible: async () => nativeExpect(locator.visible).toBe(true),
        toHaveAttribute: async (name: string, expected: string) => nativeExpect(locator.attributes[name]).toBe(expected),
        toHaveCount: async (count: number) => nativeExpect(locator.count).toBe(count),
        not: { toHaveCount: async (count: number) => nativeExpect(locator.count).not.toBe(count) },
      }
    }
    return nativeExpect(value, message)
  }
  return {
    test: { step: (label: string, work: () => Promise<void>) => { steps(label); return work() } },
    expect: Object.assign(fixtureExpect, {
      poll: (read: () => number | Promise<number>) => ({ toBeGreaterThan: async (minimum: number) => {
        let actual = 0
        for (let i = 0; i < 100; i++) {
          actual = await read()
          if (actual > minimum) break
          await Promise.resolve()
        }
        nativeExpect(actual).toBeGreaterThan(minimum)
      } }),
    }),
    sessionCookie: () => "", userId: () => "",
  }
})
vi.mock("./e2e-ui/_fixtures/community-ssr-frame", () => ({
  expectUniqueSsrCommunityFrame: async (page: Page) => page.getByTestId("fixture-frame"),
}))

type Visit = {
  account: string
  scale: number
  width: number
  sidebar: number | null
  waits: number[]
  events: string[]
  closed: boolean
  closeAttempts: number
}
type RequestRoute = { request: () => { url: () => string; method: () => string }; continue: () => Promise<void> }

function fixtureRun(failure?: "navigation" | "overflow" | "empty" | "ssr-duplicate" | "ssr-hidden" | "ssr-size" | "ssr-overflow", stage: "initial" | "seeded" = "initial", closeFailure?: "first" | "last" | "last-both") {
  const visits: Visit[] = [], active = new Set<string>()
  const originalFailure = new Error("original navigation failure")
  const closeFailures = { dave: new Error("original dave context close failure"), geometry: new Error("original geometry context close failure") }
  const contexts: Array<{ visit: Visit; context: BrowserContext }> = []
  const cleanupOperations: Array<() => Promise<unknown>> = []
  const onCleanup: Parameters<typeof runDesktopPersistedPendingGeometry>[2] = vi.fn(operation => { cleanupOperations.push(operation) })
  const asUser: Parameters<typeof runDesktopPersistedPendingGeometry>[1] = async (account, options) => {
    expect(active.has(account), "one mutable context per account").toBe(false)
    active.add(account)
    const visit: Visit = { account, scale: options?.deviceScaleFactor ?? 1, width: 0, sidebar: null, waits: [], events: [], closed: false, closeAttempts: 0 }
    visits.push(visit)
    let sidebarWidth = 317
    const handlers = new Map<string, (route: RequestRoute) => Promise<void>>()
    const listeners = new Map<string, (event: { url: () => string }) => void>()
    const pending: Promise<void>[] = []
    const request = (kind: "script" | "read") => {
      const url = () => kind === "script" ? "https://fixture.test/_next/app.js" : "https://fixture.test/api/community/servers"
      listeners.get("request")?.({ url })
      const handler = handlers.get(kind === "script" ? "**/_next/**" : "**/api/community/**")!
      const operation = handler({ request: () => ({ url, method: () => "GET" }), continue: async () => {
        visit.events.push(`${kind}.continue`)
        listeners.get("response")?.({ url })
        if (kind === "script") request("read")
      } })
      pending.push(operation)
    }
    const locator = (count = 1) => ({
      fixtureLocator: true, visible: true, count,
      attributes: { "aria-busy": "true", "aria-label": "Loading community" },
      locator: () => locator(),
    })
    const page = {
      on: (event: string, listener: (event: { url: () => string }) => void) => listeners.set(event, listener),
      route: async (pattern: string, handler: (route: RequestRoute) => Promise<void>) => { handlers.set(pattern, handler) },
      setViewportSize: async ({ width }: { width: number }) => { visit.width = width },
      emulateMedia: async () => {},
      addInitScript: async (_script: unknown, input: { persistedLayout: { sidebar: number } | null }) => {
        visit.sidebar = input.persistedLayout ? Math.round(input.persistedLayout.sidebar * (visit.width - 59) / 100) : null
        sidebarWidth = visit.sidebar ?? 317
      },
      goto: async () => {
        visit.events.push("navigation")
        request("script")
        if (failure === "navigation" && visits[0] === visit) throw originalFailure
      },
      getByTestId: () => locator(),
      locator: (selector: string) => locator(selector.includes("restore-bootstrap") ? 0 : 1),
      waitForTimeout: async (time: number) => { visit.waits.push(time); visit.events.push("sample.wait") },
      evaluate: async (callback: () => unknown, input?: unknown) => {
        if (input && typeof input === "object" && "initialId" in input && input.initialId === tid.initialFrame) {
          const root = { initial: stage === "initial", busy: "true", label: "Loading community", slot: "community-shell-root", placeholders: 1, visible: true, streamId: null, streamDisplay: null, display: "block", x: 0, y: 0, width: visit.width, height: 900 }
          const nodes = [root, { ...root, visible: false, streamId: "S:0", streamDisplay: "none", width: 0, height: 0 }]
          if (visits[0] === visit) {
            if (failure === "ssr-duplicate") nodes.push({ ...root })
            if (failure === "ssr-hidden") nodes.push({ ...root, visible: false, width: 0, height: 0 })
            if (failure === "ssr-size") root.width -= 1
          }
          return { nodes, overflow: failure === "ssr-overflow" && visits[0] === visit ? 3 : 0 }
        }
        if (!callback.toString().includes("__communityDesktopPendingFrameSamples")) return undefined
        visit.events.push("samples")
        if (failure === "empty" && visits[0] === visit) return []
        return [{ overflow: failure === "overflow" && visits[0] === visit ? 3 : 0, sidebarWidth, sidebarRight: 10, mainLeft: 11, userBarRight: 11 }]
      },
    } as unknown as Page
    const context = { close: async () => {
      visit.closeAttempts += 1
      await Promise.all(pending)
      const laneVisits = visits.filter(value => value.account === account)
      const shouldReject = closeFailure === "first" ? visits[0] === visit
        : (closeFailure === "last" || closeFailure === "last-both") && laneVisits.length === 24
          && (account === "dave" || closeFailure === "last-both")
      if (shouldReject && visit.closeAttempts === 1) {
        visit.events.push("close.reject")
        throw closeFailures[account as keyof typeof closeFailures]
      }
      visit.events.push("close"); visit.closed = true; active.delete(account)
    } } as unknown as BrowserContext
    contexts.push({ visit, context })
    return { context, page }
  }
  const cleanup = async () => {
    const errors: unknown[] = []
    // Match case-owner exit order: retained cleanup operations, then unclosed contexts.
    for (const operation of [...cleanupOperations].reverse()) {
      try { await operation() } catch (error) { errors.push(error) }
    }
    for (const { visit, context } of contexts) {
      if (visit.closed) continue
      try { await context.close() } catch (error) { errors.push(error) }
    }
    return errors
  }
  return { visits, active, originalFailure, closeFailures, onCleanup, cleanup,
    run: () => runDesktopPersistedPendingGeometry("light", asUser, onCleanup) }
}

describe("geometry fixture account lanes and resource release", () => {
  it("runs all 48 distinct contexts with separate accounts, original gates and one 250ms sample", async () => {
    steps.mockClear()
    const fixture = fixtureRun()
    await fixture.run()
    expect(await fixture.cleanup()).toEqual([])
    const expected = [640, 768, 1024, 1280].flatMap(width => [null, 100, 160, 240, 350, 360].flatMap(sidebar => [1, 1.25].map(scale => `${width}:${sidebar}:${scale}`)))
    expect(fixture.visits.map(v => `${v.width}:${v.sidebar}:${v.scale}`).sort()).toEqual(expected.sort())
    expect(fixture.visits.filter(v => v.account === "dave")).toHaveLength(24)
    expect(fixture.visits.filter(v => v.account === "geometry")).toHaveLength(24)
    expect(steps).toHaveBeenCalledTimes(48)
    for (const visit of fixture.visits) {
      expect(visit.waits).toEqual([250])
      expect(visit.events).toEqual(["navigation", "script.continue", "sample.wait", "samples", "read.continue", "close"])
      expect(visit.closed).toBe(true)
    }
    expect(fixture.active.size).toBe(0)
  })

  it("keeps the same geometry and resource contract for an already resolved RSC shell", async () => {
    const fixture = fixtureRun(undefined, "seeded")
    await fixture.run()
    expect(await fixture.cleanup()).toEqual([])
    expect(fixture.visits).toHaveLength(48)
    expect(fixture.visits.every(visit => visit.closed && visit.waits.length === 1 && visit.waits[0] === 250)).toBe(true)
    expect(fixture.active.size).toBe(0)
  })

  it.each(["navigation", "overflow", "empty", "ssr-duplicate", "ssr-hidden", "ssr-size", "ssr-overflow"] as const)("releases gates and awaits the other lane before propagating %s failure", async failure => {
    const fixture = fixtureRun(failure)
    const error = await fixture.run().catch((error: unknown) => error)
    expect(await fixture.cleanup()).toEqual([])
    if (!(error instanceof Error)) throw error
    if (failure === "navigation") expect(error).toBe(fixture.originalFailure)
    else expect(error).toBeInstanceOf(Error)
    if (failure === "ssr-duplicate") expect(error.message).toContain("SSR must have exactly one visible SSR frame")
    if (failure === "ssr-hidden") expect(error.message).toContain("Unexpected hidden SSR frame")
    if (failure === "ssr-size") expect(error.message).toContain("width")
    expect(fixture.visits.filter(v => v.account === "geometry")).toHaveLength(24)
    expect(fixture.visits.filter(v => v.account === "dave")).toHaveLength(1)
    expect(fixture.visits.every(v => v.closed && v.events.includes("script.continue") && v.events.includes("read.continue"))).toBe(true)
    expect(fixture.active.size).toBe(0)
  })

  it("retains a context close rejection in its cleanup owner and does not retire the failed close", async () => {
    const fixture = fixtureRun(undefined, "initial", "last")
    await fixture.run()
    expect(fixture.onCleanup).toHaveBeenCalledTimes(1)
    const failed = fixture.visits.filter(visit => visit.events.includes("close.reject"))
    expect(failed).toHaveLength(1)
    expect(failed[0].closed).toBe(false)
    expect(fixture.active.size).toBe(1)
    expect(await fixture.cleanup()).toEqual([fixture.closeFailures.dave])
    expect(failed[0].closeAttempts).toBe(2)
    expect(fixture.visits).toHaveLength(48)
    expect(fixture.visits.every(visit => visit.closed)).toBe(true)
    expect(fixture.active.size).toBe(0)
  })

  it("preserves the original navigation error and the separately owned close error", async () => {
    const fixture = fixtureRun("navigation", "initial", "first")
    const error = await fixture.run().catch((error: unknown) => error)
    expect(error).toBe(fixture.originalFailure)
    expect(fixture.onCleanup).toHaveBeenCalledTimes(1)
    expect(fixture.visits[0].closed).toBe(false)
    expect(fixture.visits.filter(visit => visit.account === "geometry")).toHaveLength(24)
    expect(fixture.visits.every(visit => visit.events.includes("script.continue") && visit.events.includes("read.continue"))).toBe(true)
    expect(await fixture.cleanup()).toEqual([fixture.closeFailures.dave])
    expect(fixture.visits.every(visit => visit.closed)).toBe(true)
    expect(fixture.active.size).toBe(0)
  })

  it("drains both lanes' retained cleanup errors without masking either original rejection", async () => {
    const fixture = fixtureRun(undefined, "initial", "last-both")
    await fixture.run()
    expect(fixture.onCleanup).toHaveBeenCalledTimes(2)
    expect(fixture.active.size).toBe(2)
    const cleanupErrors = await fixture.cleanup()
    expect(cleanupErrors).toHaveLength(2)
    expect(cleanupErrors).toEqual(expect.arrayContaining([fixture.closeFailures.dave, fixture.closeFailures.geometry]))
    expect(fixture.visits.filter(visit => visit.closeAttempts === 2)).toHaveLength(2)
    expect(fixture.visits.every(visit => visit.closed)).toBe(true)
    expect(fixture.active.size).toBe(0)
  })
})
