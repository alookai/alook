import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"

test("slow auth and an initial retry never block a cold Community page", async ({ caseActors, caseResources }) => {
  test.setTimeout(90_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { seedChannel, seedServer } = actors.seed

  const serverId = await seedServer("alice", `Reconnect cold start ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "reconnect-cold-start")
  const alice = await asUser("alice")
  let tokenRequests = 0
  let releaseTokens!: () => void
  let holdTokens = true
  const tokenGate = new Promise<void>((resolve) => {
    releaseTokens = resolve
  })
  caseResources.own(releaseTokens, async (captured) => { captured() })
  let socketAttempts = 0

  await alice.page.route("**/api/ws/token", async (route) => {
    tokenRequests += 1
    if (holdTokens) await tokenGate
    await route.continue()
  })
  await alice.page.routeWebSocket((url) => url.pathname.endsWith("/user"), (ws) => {
    socketAttempts += 1
    void ws.close({ code: 1012, reason: "cold start auth retry" })
  })
  await alice.page.setViewportSize({ width: 390, height: 844 })

  try {
    await alice.page.goto(`/c/channels/${serverId}/${channelId}`)
    const composer = composerEditable(alice.page)
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => tokenRequests).toBeGreaterThan(0)
    await alice.page.waitForTimeout(1_600)
    await expect(alice.page.getByTestId(tid.wsReconnectOverlay)).toHaveCount(0)
    await expect.poll(() => composer.evaluate((element) => element.closest("[inert]") !== null))
      .toBe(false)
    await composer.fill("Cold start stays usable")
    await expect(composer).toContainText("Cold start stays usable")

    holdTokens = false
    releaseTokens()
    await expect.poll(() => socketAttempts, { timeout: 20_000 }).toBeGreaterThan(1)
    await expect(composer).toContainText("Cold start stays usable")
  } finally {
    holdTokens = false
    releaseTokens()
  }
})
