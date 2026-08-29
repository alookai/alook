import { test, expect } from "./_fixtures/community-fixture"
import { composerEditable, gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import { proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { seedChannel, seedJoinServer, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import {
  WS_CONNECTION_VALIDATION_TIMEOUT_MS,
  WS_FOREGROUND_SENTINEL_INTERVAL_MS,
  WS_FOREGROUND_SUSPENSION_GAP_MS,
} from "../../lib/use-user-ws"

test("mobile foreground proof is exact, bounded, and recovers through one current generation", async ({ asUser }, testInfo) => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Foreground validation ${stamp}`)
  const channelId = await seedChannel("alice", serverId, `foreground-${stamp}`)
  await seedJoinServer("alice", "bob", serverId)

  const alice = await asUser("alice")
  const bob = await asUser("bob")
  await alice.page.addInitScript(() => {
    const nativeSetInterval = window.setInterval.bind(window)
    const nativeClearInterval = window.clearInterval.bind(window)
    const intervals = new Map<number, { delay: number; run: () => void }>()
    window.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      const id = nativeSetInterval(handler, delay, ...args)
      if (typeof handler === "function") {
        intervals.set(id, { delay: delay ?? 0, run: () => handler(...args) })
      }
      return id
    }) as typeof window.setInterval
    window.clearInterval = ((id?: number) => {
      if (id !== undefined) intervals.delete(id)
      nativeClearInterval(id)
    }) as typeof window.clearInterval
    Object.defineProperty(window, "__alookQaRunIntervals", {
      configurable: true,
      value: (delay: number) => {
        const matching = [...intervals.values()].filter((entry) => entry.delay === delay)
        for (const entry of matching) entry.run()
        return matching.length
      },
    })
  })
  let dropValidationPong = false
  let holdReplacementAuth = false
  const proxy = await proxyCommunityWebSockets(alice.context, {
    decideConnectionFrame: (frame) => {
      if (
        dropValidationPong
        && frame.direction === "server-to-client"
        && frame.type === "connection.pong"
      ) return "drop"
      if (
        holdReplacementAuth
        && frame.direction === "server-to-client"
        && frame.type === "auth.ok"
        && frame.connectionId > 1
      ) return "hold"
      return "forward"
    },
  })
  let tokenRequests = 0
  let successfulTokenResponses = 0
  alice.page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/ws/token") tokenRequests += 1
  })
  alice.page.on("response", (response) => {
    if (
      new URL(response.url()).pathname === "/api/ws/token"
      && response.ok()
    ) successfulTokenResponses += 1
  })

  await alice.page.setViewportSize({ width: 390, height: 844 })
  await bob.page.setViewportSize({ width: 390, height: 844 })
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(alice.page, route)
  await gotoAfterUserWsAuth(bob.page, route)
  await expect(composerEditable(alice.page)).toBeVisible()
  await expect(composerEditable(bob.page)).toBeVisible()
  await alice.page.evaluate(() => {
    let qaVisibility: DocumentVisibilityState = "visible"
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => qaVisibility,
    })
    Object.defineProperty(window, "__alookQaSetVisibility", {
      configurable: true,
      value: (next: DocumentVisibilityState, dispatch = true) => {
        qaVisibility = next
        if (dispatch) document.dispatchEvent(new Event("visibilitychange"))
      },
    })
    const originalDateNow = Date.now.bind(Date)
    Object.defineProperty(window, "__alookQaAdvanceWallClock", {
      configurable: true,
      value: (offsetMs: number) => {
        Date.now = () => originalDateNow() + offsetMs
      },
    })
    Object.defineProperty(window, "__alookQaRestoreWallClock", {
      configurable: true,
      value: () => {
        Date.now = originalDateNow
      },
    })
  })
  const setVisibility = async (state: "hidden" | "visible", dispatch = true) => {
    await alice.page.evaluate(({ next, shouldDispatch }) => {
      const setter = (window as Window & {
        __alookQaSetVisibility?: (
          value: DocumentVisibilityState,
          dispatch?: boolean,
        ) => void
      }).__alookQaSetVisibility
      if (!setter) throw new Error("QA visibility setter missing")
      setter(next, shouldDispatch)
    }, { next: state, shouldDispatch: dispatch })
    await expect.poll(() => alice.page.evaluate(() => document.visibilityState)).toBe(state)
  }
  const dispatchDuplicateResumeSignals = async (persisted = true) => {
    await alice.page.evaluate((isPersisted) => {
      document.dispatchEvent(new Event("resume"))
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: isPersisted }))
      window.dispatchEvent(new FocusEvent("focus"))
      window.dispatchEvent(new Event("online"))
    }, persisted)
  }
  const runSentinelIntervals = async () => alice.page.evaluate((delay) => {
    const run = (window as Window & {
      __alookQaRunIntervals?: (intervalDelay: number) => number
    }).__alookQaRunIntervals
    if (!run) throw new Error("QA interval runner missing")
    return run(delay)
  }, WS_FOREGROUND_SENTINEL_INTERVAL_MS)
  const wsOverlay = alice.page.getByTestId(tid.wsReconnectOverlay)

  const initialPageShowFrameCount = proxy.connectionFrames.length
  const initialPageShowConnectionCount = proxy.connectionCount()
  const initialPageShowTokenRequests = tokenRequests
  await composerEditable(alice.page).focus()
  await alice.page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }))
  })
  await alice.page.waitForTimeout(250)
  expect(proxy.connectionCount()).toBe(initialPageShowConnectionCount)
  expect(tokenRequests).toBe(initialPageShowTokenRequests)
  expect(proxy.connectionFrames.slice(initialPageShowFrameCount).filter((frame) =>
    frame.direction === "client-to-server"
    && frame.type === "connection.ping",
  )).toEqual([])

  const initialConnectionCount = proxy.connectionCount()
  const initialTokenRequests = tokenRequests
  const hiddenFrameStart = proxy.connectionFrames.length
  await setVisibility("hidden")
  await alice.page.waitForTimeout(26_000)
  expect(proxy.connectionCount()).toBe(initialConnectionCount)
  expect(tokenRequests).toBe(initialTokenRequests)
  expect(proxy.connectionFrames.slice(hiddenFrameStart).filter((frame) =>
    frame.direction === "client-to-server"
    && (frame.type === "raw.ping" || frame.type === "connection.ping"),
  )).toEqual([])
  await expect(wsOverlay).toHaveCount(0)

  const healthyStart = proxy.connectionFrames.length
  await setVisibility("visible", false)
  await dispatchDuplicateResumeSignals()
  await expect.poll(() => proxy.connectionFrames.slice(healthyStart).filter((frame) =>
    frame.direction === "client-to-server" && frame.type === "connection.ping",
  ).length).toBe(1)
  const healthyPing = proxy.connectionFrames.slice(healthyStart).find((frame) =>
    frame.direction === "client-to-server" && frame.type === "connection.ping",
  )!
  await expect.poll(() => proxy.connectionFrames.slice(healthyStart).filter((frame) =>
    frame.direction === "server-to-client"
    && frame.type === "connection.pong"
    && frame.connectionId === healthyPing.connectionId
    && frame.nonce === healthyPing.nonce,
  ).length).toBe(1)
  expect(proxy.connectionCount()).toBe(initialConnectionCount)
  expect(tokenRequests).toBe(initialTokenRequests)
  await expect(wsOverlay).toHaveCount(0)
  await expect(composerEditable(alice.page)).toBeVisible()

  await setVisibility("hidden")
  const freezeFrameStart = proxy.connectionFrames.length
  const freezeConnectionBaseline = proxy.connectionCount()
  const freezeTokenBaseline = tokenRequests
  await alice.page.evaluate(() => document.dispatchEvent(new Event("freeze")))
  await alice.page.waitForTimeout(WS_FOREGROUND_SENTINEL_INTERVAL_MS + 500)
  await alice.page.evaluate(() => document.dispatchEvent(new Event("resume")))
  await alice.page.waitForTimeout(250)
  expect(proxy.connectionCount()).toBe(freezeConnectionBaseline)
  expect(tokenRequests).toBe(freezeTokenBaseline)
  expect(proxy.connectionFrames.slice(freezeFrameStart).filter((frame) =>
    frame.direction === "client-to-server"
    && (
      frame.type === "raw.ping"
      || frame.type === "connection.ping"
      || frame.type === "auth"
    ),
  )).toEqual([])

  await setVisibility("visible", false)
  await dispatchDuplicateResumeSignals()
  await expect.poll(() => proxy.connectionCount()).toBe(freezeConnectionBaseline + 1)
  await expect.poll(() => tokenRequests).toBe(freezeTokenBaseline + 1)
  await expect.poll(() => proxy.connectionFrames.filter((frame) =>
    frame.direction === "server-to-client"
    && frame.type === "auth.ok"
    && frame.connectionId === freezeConnectionBaseline + 1,
  ).length).toBe(1)
  expect(proxy.connectionFrames.slice(freezeFrameStart).filter((frame) =>
    frame.direction === "client-to-server"
    && frame.type === "connection.ping",
  )).toEqual([])
  await expect(wsOverlay).toHaveCount(0, { timeout: 10_000 })

  dropValidationPong = true
  holdReplacementAuth = true
  const failedStart = proxy.connectionFrames.length
  const failedConnectionBaseline = proxy.connectionCount()
  const failedTokenBaseline = tokenRequests
  await alice.page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")))
  await dispatchDuplicateResumeSignals()
  await expect.poll(() => proxy.connectionFrames.slice(failedStart).filter((frame) =>
    frame.direction === "client-to-server" && frame.type === "connection.ping",
  ).length).toBe(1)
  proxy.sendConnectionFrame({ type: "connection.pong", nonce: "queued_stale_nonce" })
  await alice.page.waitForTimeout(WS_CONNECTION_VALIDATION_TIMEOUT_MS - 1_000)
  await expect(wsOverlay).toHaveCount(0)

  await expect(wsOverlay).toHaveAttribute(
    "data-ws-status",
    "reconnecting",
    { timeout: 5_000 },
  )
  await expect.poll(() => proxy.connectionCount()).toBe(failedConnectionBaseline + 1)
  await expect.poll(() => tokenRequests).toBe(failedTokenBaseline + 1)
  await expect.poll(() => proxy.heldConnectionCount()).toBe(1)
  await dispatchDuplicateResumeSignals()
  await alice.page.waitForTimeout(250)
  expect(proxy.connectionCount()).toBe(failedConnectionBaseline + 1)
  expect(tokenRequests).toBe(failedTokenBaseline + 1)
  expect(proxy.heldConnectionCount()).toBe(1)
  expect(proxy.connectionFrames.filter((frame) =>
    frame.direction === "client-to-server"
    && frame.type === "auth"
    && frame.connectionId === failedConnectionBaseline + 1,
  )).toHaveLength(1)

  dropValidationPong = false
  holdReplacementAuth = false
  expect(proxy.releaseHeldConnections((frame) =>
    frame.type === "auth.ok" && frame.connectionId === failedConnectionBaseline + 1,
  )).toBe(1)
  await expect(wsOverlay).toHaveCount(0, { timeout: 10_000 })
  await expect(composerEditable(alice.page)).toBeVisible()

  await alice.page.bringToFront()
  await alice.page.waitForTimeout(500)
  const sentinelOrdinaryStart = proxy.connectionFrames.length
  const sentinelConnectionBaseline = proxy.connectionCount()
  const sentinelTokenBaseline = tokenRequests
  expect(await runSentinelIntervals()).toBeGreaterThanOrEqual(1)
  await alice.page.waitForTimeout(250)
  expect(proxy.connectionCount()).toBe(sentinelConnectionBaseline)
  expect(tokenRequests).toBe(sentinelTokenBaseline)
  expect(proxy.connectionFrames.slice(sentinelOrdinaryStart).filter((frame) =>
    frame.direction === "client-to-server" && frame.type === "connection.ping",
  )).toEqual([])

  dropValidationPong = true
  holdReplacementAuth = true
  const sentinelRecoveryStart = proxy.connectionFrames.length
  const observedClockShift = await alice.page.evaluate((offsetMs) => {
    const before = Date.now()
    const advance = (window as Window & {
      __alookQaAdvanceWallClock?: (offset: number) => void
    }).__alookQaAdvanceWallClock
    if (!advance) throw new Error("QA wall-clock advancer missing")
    advance(offsetMs)
    return Date.now() - before
  }, WS_FOREGROUND_SUSPENSION_GAP_MS + 5_000)
  expect(observedClockShift).toBeGreaterThanOrEqual(WS_FOREGROUND_SUSPENSION_GAP_MS)
  expect(await runSentinelIntervals()).toBeGreaterThanOrEqual(1)
  await expect.poll(() => proxy.connectionFrames.slice(sentinelRecoveryStart).filter((frame) =>
    frame.direction === "client-to-server" && frame.type === "connection.ping",
  ).length).toBe(1)
  await alice.page.evaluate(() => {
    const restore = (window as Window & {
      __alookQaRestoreWallClock?: () => void
    }).__alookQaRestoreWallClock
    if (!restore) throw new Error("QA wall-clock restorer missing")
    restore()
  })
  await dispatchDuplicateResumeSignals()
  proxy.sendConnectionFrame({ type: "connection.pong", nonce: "sentinel_stale_nonce" })

  await expect(wsOverlay).toHaveAttribute(
    "data-ws-status",
    "reconnecting",
    { timeout: WS_CONNECTION_VALIDATION_TIMEOUT_MS + 5_000 },
  )
  await expect.poll(() => proxy.connectionCount()).toBe(sentinelConnectionBaseline + 1)
  await expect.poll(() => tokenRequests).toBe(sentinelTokenBaseline + 1)
  await expect.poll(() => proxy.heldConnectionCount()).toBe(1)
  expect(proxy.connectionFrames.slice(sentinelRecoveryStart).filter((frame) =>
    frame.direction === "client-to-server" && frame.type === "connection.ping",
  )).toHaveLength(1)

  dropValidationPong = false
  holdReplacementAuth = false
  expect(proxy.releaseHeldConnections((frame) =>
    frame.type === "auth.ok" && frame.connectionId === sentinelConnectionBaseline + 1,
  )).toBe(1)
  await expect(wsOverlay).toHaveCount(0, { timeout: 10_000 })
  await expect(composerEditable(alice.page)).toBeVisible()

  try {
    await alice.context.setOffline(true)
    await proxy.disconnect()
    await expect(wsOverlay).toHaveAttribute(
      "data-ws-status",
      "reconnecting",
      { timeout: 10_000 },
    )
    await expect(wsOverlay).toHaveAttribute(
      "data-ws-status",
      "failed",
      { timeout: 40_000 },
    )
  } finally {
    await alice.context.setOffline(false)
  }

  await alice.page.getByTestId(tid.wsRetry).click()
  await expect(wsOverlay).toHaveCount(0, { timeout: 20_000 })

  const reloadFrameStart = proxy.connectionFrames.length
  const reloadConnectionBaseline = proxy.connectionCount()
  const reloadSuccessfulTokenBaseline = successfulTokenResponses
  await alice.page.reload({ waitUntil: "commit" })
  await expect(composerEditable(alice.page)).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => proxy.connectionCount()).toBe(reloadConnectionBaseline + 1)
  await expect.poll(() => successfulTokenResponses).toBe(reloadSuccessfulTokenBaseline + 1)
  await expect.poll(() => proxy.connectionFrames.slice(reloadFrameStart).filter((frame) =>
    frame.direction === "server-to-client"
    && frame.type === "auth.ok"
    && frame.connectionId === reloadConnectionBaseline + 1,
  ).length).toBe(1)
  await alice.page.waitForTimeout(500)
  expect(proxy.connectionCount()).toBe(reloadConnectionBaseline + 1)
  expect(successfulTokenResponses).toBe(reloadSuccessfulTokenBaseline + 1)
  expect(proxy.connectionFrames.slice(reloadFrameStart).filter((frame) =>
    frame.direction === "client-to-server"
    && frame.connectionId === reloadConnectionBaseline + 1
    && frame.type === "connection.ping",
  )).toEqual([])

  const body = `foreground recovery ${stamp}`
  await sendMessage(bob.page, body)
  await expect(alice.page.getByText(body, { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(composerEditable(alice.page)).toBeVisible()

  await testInfo.attach("foreground-validation-frames.json", {
    body: Buffer.from(JSON.stringify({
      tokenRequests,
      successfulTokenResponses,
      connectionCount: proxy.connectionCount(),
      frames: proxy.connectionFrames,
      simulatedLifecycleCoverage: [
        "initial-pageshow",
        "element-focus",
        "hidden-network-silence",
        "healthy-retained-validation",
        "freeze-resume",
        "focus-only-zombie-open",
        "foreground-event-storm",
        "wall-clock-sentinel",
        "offline-online",
        "discarded-document-reload",
        "post-recovery-delivery",
      ],
      physicalDeviceCoverage: "not run; approved residual risk",
      stagingCoverage: "not run; approved residual risk",
    }, null, 2)),
    contentType: "application/json",
  })
  await testInfo.attach("foreground-validation-final.png", {
    body: await alice.page.screenshot(),
    contentType: "image/png",
  })
})
