import { test, expect } from "./_fixtures/community-fixture"
import { composerEditable, gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import { proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { seedChannel, seedJoinServer, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { WS_CONNECTION_VALIDATION_TIMEOUT_MS } from "../../lib/use-user-ws"

test("mobile foreground proof is exact, bounded, and recovers through one current generation", async ({ asUser }, testInfo) => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Foreground validation ${stamp}`)
  const channelId = await seedChannel("alice", serverId, `foreground-${stamp}`)
  await seedJoinServer("alice", "bob", serverId)

  const alice = await asUser("alice")
  const bob = await asUser("bob")
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
  alice.page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/ws/token") tokenRequests += 1
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
      value: (next: DocumentVisibilityState) => {
        qaVisibility = next
        document.dispatchEvent(new Event("visibilitychange"))
      },
    })
  })
  const setVisibility = async (state: "hidden" | "visible") => {
    await alice.page.evaluate((next) => {
      const setter = (window as Window & {
        __alookQaSetVisibility?: (value: DocumentVisibilityState) => void
      }).__alookQaSetVisibility
      if (!setter) throw new Error("QA visibility setter missing")
      setter(next)
    }, state)
    await expect.poll(() => alice.page.evaluate(() => document.visibilityState)).toBe(state)
  }
  const dispatchDuplicateResumeSignals = async () => {
    await alice.page.evaluate(() => {
      window.dispatchEvent(new Event("pageshow"))
      window.dispatchEvent(new Event("online"))
    })
  }
  const wsControls = alice.page.locator(
    `[data-testid='${tid.wsStatus}'], [data-testid='${tid.wsRetry}']`,
  )

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
  await expect(wsControls).toHaveCount(0)

  const healthyStart = proxy.connectionFrames.length
  await setVisibility("visible")
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
  await expect(wsControls).toHaveCount(0)
  await expect(composerEditable(alice.page)).toBeVisible()

  await setVisibility("hidden")
  dropValidationPong = true
  holdReplacementAuth = true
  const failedStart = proxy.connectionFrames.length
  const failedConnectionBaseline = proxy.connectionCount()
  const failedTokenBaseline = tokenRequests
  await setVisibility("visible")
  await dispatchDuplicateResumeSignals()
  await expect.poll(() => proxy.connectionFrames.slice(failedStart).filter((frame) =>
    frame.direction === "client-to-server" && frame.type === "connection.ping",
  ).length).toBe(1)
  proxy.sendConnectionFrame({ type: "connection.pong", nonce: "queued_stale_nonce" })
  await alice.page.waitForTimeout(WS_CONNECTION_VALIDATION_TIMEOUT_MS - 1_000)
  await expect(wsControls).toHaveCount(0)

  await expect(alice.page.getByTestId(tid.wsStatus)).toHaveAttribute(
    "data-ws-status",
    "reconnecting",
    { timeout: 5_000 },
  )
  await expect.poll(() => proxy.connectionCount()).toBe(failedConnectionBaseline + 1)
  await expect.poll(() => tokenRequests).toBe(failedTokenBaseline + 1)
  await expect.poll(() => proxy.heldConnectionCount()).toBe(1)
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
  await expect(wsControls).toHaveCount(0, { timeout: 10_000 })
  await expect(composerEditable(alice.page)).toBeVisible()

  try {
    await alice.context.setOffline(true)
    await proxy.disconnect()
    await expect(alice.page.getByTestId(tid.wsStatus)).toHaveAttribute(
      "data-ws-status",
      "reconnecting",
      { timeout: 10_000 },
    )
    await expect(alice.page.getByTestId(tid.wsRetry)).toHaveAttribute(
      "data-ws-status",
      "failed",
      { timeout: 40_000 },
    )
  } finally {
    await alice.context.setOffline(false)
  }

  await alice.page.getByTestId(tid.wsRetry).click()
  await expect(wsControls).toHaveCount(0, { timeout: 20_000 })
  const body = `foreground recovery ${stamp}`
  await sendMessage(bob.page, body)
  await expect(alice.page.getByText(body, { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(composerEditable(alice.page)).toBeVisible()

  await testInfo.attach("foreground-validation-frames.json", {
    body: Buffer.from(JSON.stringify({
      tokenRequests,
      connectionCount: proxy.connectionCount(),
      frames: proxy.connectionFrames,
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
