import type { Page, Route } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

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

test("community checkpoint keeps the committed frame live until navigation commits", async ({ asUser }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Frame Gate ${stamp}`)
  const channelAName = `frame-a-${stamp}`
  const channelBName = `frame-b-${stamp}`
  const channelA = await seedChannel("alice", serverId, channelAName)
  const channelB = await seedChannel("alice", serverId, channelBName)
  const { page } = await asUser("alice")
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/c/channels/${serverId}/${channelA}`)
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
    ) mutations.push(`${method} ${pathname}`)
  })

  const leafGate = await holdRoute(page, `/c/channels/${serverId}/${channelB}`)
  await page.getByTestId(tid.channelRow(channelB)).click({ noWaitAfter: true })
  await expect.poll(leafGate.held).toBeGreaterThan(0)
  await expect(page.getByLabel("Loading conversation")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: channelAName })).toBeVisible()
  await page.waitForTimeout(150)
  await expect(page.getByLabel("Loading conversation")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: channelAName })).toBeVisible()
  await leafGate.release()
  await expect(page.getByRole("heading", { name: channelBName })).toBeVisible({ timeout: 30_000 })

  await page.setViewportSize({ width: 390, height: 844 })
  const rootGate = await holdRoute(page, `/c/channels/${serverId}`)
  await page.getByRole("button", { name: "Back" }).click({ noWaitAfter: true })
  await expect.poll(rootGate.held).toBeGreaterThan(0)
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.getByLabel("Loading conversation")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: channelBName })).toBeVisible()
  await page.waitForTimeout(150)
  await expect(page.getByLabel("Loading conversation")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: channelBName })).toBeVisible()
  await rootGate.release()
  await expect(page.getByRole("heading", { name: channelBName })).toBeVisible({ timeout: 30_000 })

  await page.goto("/c/me/friends")
  await expect(page.getByPlaceholder("Search friends")).toBeVisible({ timeout: 30_000 })
  const machinesGate = await holdRoute(page, "/c/me/machines")
  await page.getByRole("button", { name: "Machines", exact: true }).click({ noWaitAfter: true })
  await expect.poll(machinesGate.held).toBeGreaterThan(0)
  await expect(page.getByLabel("Loading conversation")).toHaveCount(0)
  await expect(page.getByPlaceholder("Search friends")).toBeVisible()
  await page.waitForTimeout(150)
  await expect(page.getByPlaceholder("Search friends")).toBeVisible()
  await machinesGate.release()
  await expect(page.getByRole("heading", { name: "No machines yet", exact: true }))
    .toBeVisible({ timeout: 30_000 })

  expect(mutations).toEqual([])
})
