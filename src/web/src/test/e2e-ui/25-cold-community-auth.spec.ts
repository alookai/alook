import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable } from "./_fixtures/actions"
import { proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { tid } from "./_fixtures/testids"

test("slow auth and an initial retry never block a cold Community page", async ({ caseActors }) => {
  test.setTimeout(90_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { seedChannel, seedServer } = actors.seed

  const serverId = await seedServer("alice", `Reconnect cold start ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "reconnect-cold-start")
  const alice = await asUser("alice")
  const proxy = await proxyCommunityWebSockets(alice.context, {
    decideConnectionFrame: (frame) => frame.connectionId === 1 && frame.type === "auth.ok" ? "hold" : "forward",
  })
  await alice.page.setViewportSize({ width: 390, height: 844 })

  await alice.page.goto(`/c/channels/${serverId}/${channelId}`)
  const composer = composerEditable(alice.page)
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => proxy.heldConnectionCount()).toBe(1)
  await alice.page.waitForTimeout(1_600)
  await expect(alice.page.getByTestId(tid.wsReconnectOverlay)).toHaveCount(0)
  await expect.poll(() => composer.evaluate((element) => element.closest("[inert]") !== null))
    .toBe(false)
  await composer.fill("Cold start stays usable")
  await expect(composer).toContainText("Cold start stays usable")

  expect(proxy.connectionCount()).toBe(1)
  await proxy.disconnect()
  await expect.poll(() => proxy.connectionFrames.filter((frame) =>
    frame.direction === "server-to-client" && frame.connectionId === 2 && frame.type === "auth.ok",
  ).length, { timeout: 20_000 }).toBe(1)
  expect(proxy.connectionCount()).toBe(2)
  await expect(composer).toContainText("Cold start stays usable")
})
