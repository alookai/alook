import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import type { SpikeSnapshot } from "./test-api"

async function resetApi(request: APIRequestContext) {
  const response = await request.post("/spike-api/control/reset")
  expect(response.ok()).toBe(true)
}

async function openSpike(page: Page, name: string) {
  await page.goto(`/?db=t-${Date.now().toString(36)}-${name.slice(0, 2)}`)
  await expect(page.getByTestId("runtime-state")).toHaveAttribute("data-state", "ready")
  await idle(page)
}

async function idle(page: Page) {
  await page.evaluate(() => window.__tanstackOfficialSpike.waitForIdle())
}

async function snapshot(page: Page): Promise<SpikeSnapshot> {
  return page.evaluate(() => window.__tanstackOfficialSpike.snapshot())
}

test.beforeEach(async ({ request }) => {
  await resetApi(request)
})

test("cold OPFS cache survives an offline runtime rebuild", async ({ page }) => {
  await openSpike(page, "cold-cache")
  await expect(page.getByTestId("servers-state")).toContainText("Alpha")

  await page.getByTestId("offline-toggle").click()
  await page.getByTestId("rebuild-runtime").click()
  await expect(page.getByTestId("runtime-state")).toHaveAttribute("data-state", "ready")
  await idle(page)

  await expect(page.getByTestId("servers-state")).toContainText("Alpha")
  const state = await snapshot(page)
  expect(state.offline).toBe(true)
  expect(state.servers.map((row) => row.id)).toContain("s-alpha")
  expect(state.logs.some((entry) => (
    entry.kind === "runtime-preload"
    && (entry.detail.results as string[]).includes("rejected")
    && Number(entry.detail.serverCount) > 0
  ))).toBe(true)
})

test("exact WS batches are idempotent and freshness signals coalesce", async ({ page }) => {
  await openSpike(page, "ws-refetch")

  await page.getByTestId("ws-apply").click()
  await expect(page.getByTestId("servers-state")).toContainText("s-live-alpha")
  await expect(page.getByTestId("messages-window")).toContainText("m-live-alpha")
  await page.getByTestId("duplicate-replay").click()
  await idle(page)

  let state = await snapshot(page)
  expect(state.servers.filter((row) => row.id === "s-live-alpha")).toHaveLength(1)
  expect(state.messages.filter((row) => row.id === "m-live-alpha")).toHaveLength(1)

  const refetchesBefore = state.logs.filter((entry) => entry.kind === "refetch-start").length
  await page.getByTestId("freshness-burst").click()
  await expect(page.getByTestId("servers-state")).toContainText("s-fresh-alpha")
  await idle(page)
  state = await snapshot(page)
  expect(state.logs.filter((entry) => entry.kind === "refetch-start")).toHaveLength(refetchesBefore + 1)
  expect(state.logs.filter((entry) => entry.kind === "refetch-applied")).toHaveLength(refetchesBefore + 1)
  expect(state.logs.filter((entry) => entry.kind === "freshness-signal").map((entry) => entry.detail.reason))
    .toEqual(["reconnect", "gap", "unknown"])
})

test("on-demand messages translate channel, order, and expanding limit demand", async ({ page }) => {
  await openSpike(page, "messages-window")
  let state = await snapshot(page)
  expect(state.messages.map((row) => row.seq)).toEqual([6, 5])

  await page.getByTestId("load-next-window").click()
  await expect(page.getByTestId("runtime-state")).toHaveAttribute("data-state", "ready")
  await idle(page)
  state = await snapshot(page)
  expect(state.messages.map((row) => row.seq)).toEqual([6, 5, 4, 3])
  const messageLoads = state.logs.filter((entry) => entry.kind === "rest-messages")
  expect(messageLoads.some((entry) => entry.detail.channelId === "c-alpha")).toBe(true)
  expect(messageLoads.some((entry) => Number(entry.detail.limit) >= 4)).toBe(true)
  await expect(page.getByTestId("capability-state")).toContainText("does not export documented createCursorPager")
})

test("scope revocation deletes rows and account replacement isolates OPFS", async ({ page }) => {
  await openSpike(page, "account-scope")
  await page.getByTestId("revoke-scope").click()
  await expect(page.getByTestId("servers-state")).not.toContainText('"id": "s-alpha"')
  await expect(page.getByTestId("messages-window")).toHaveText("[]")
  await page.getByTestId("rebuild-runtime").click()
  await expect(page.getByTestId("runtime-state")).toHaveAttribute("data-state", "ready")
  await idle(page)
  await expect(page.getByTestId("servers-state")).not.toContainText('"id": "s-alpha"')
  await expect(page.getByTestId("messages-window")).toHaveText("[]")

  await page.getByTestId("account-switch").click()
  await expect(page.getByTestId("runtime-state")).toContainText("account=beta")
  await idle(page)
  const state = await snapshot(page)
  expect(state.account).toBe("beta")
  expect(state.servers.map((row) => row.id)).toEqual(["s-beta"])
  expect(state.messages.every((row) => row.channelId === "c-beta")).toBe(true)
})

test("two tabs share committed rows through the browser coordinator", async ({ page, context }) => {
  const db = `t-${Date.now().toString(36)}-2t`
  await page.goto(`/?db=${db}`)
  await expect(page.getByTestId("runtime-state")).toHaveAttribute("data-state", "ready")
  const peer = await context.newPage()
  await peer.goto(`/?db=${db}`)
  await expect(peer.getByTestId("runtime-state")).toHaveAttribute("data-state", "ready")

  await page.evaluate(() => window.__tanstackOfficialSpike.applyLocalServer({
    id: "s-coordinator-alpha",
    name: "Coordinator alpha",
    version: 2,
  }))
  await expect(page.getByTestId("servers-state")).toContainText("s-coordinator-alpha")
  await expect(peer.getByTestId("servers-state")).toContainText("s-coordinator-alpha")
  await idle(page)
  await idle(peer)
  const left = await snapshot(page)
  const right = await snapshot(peer)
  expect(left.servers.filter((row) => row.id === "s-coordinator-alpha")).toHaveLength(1)
  expect(right.servers.filter((row) => row.id === "s-coordinator-alpha")).toHaveLength(1)
  expect(left.logs.some((entry) => entry.kind === "runtime-opened" && entry.detail.coordinator !== undefined)).toBe(true)
  expect(right.logs.some((entry) => entry.kind === "runtime-opened" && entry.detail.coordinator !== undefined)).toBe(true)
  await peer.close()
})

test("persisted page restore rebuilds the complete runtime generation", async ({ page }) => {
  await openSpike(page, "bfcache")
  const before = (await snapshot(page)).generation

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })))
  await idle(page)
  await expect(page.getByTestId("runtime-state")).toHaveAttribute("data-state", "ready")
  expect((await snapshot(page)).generation).toBe(before)

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })))
  await idle(page)
  await expect(page.getByTestId("runtime-state")).toHaveAttribute("data-state", "closed")
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
  await idle(page)
  await expect(page.getByTestId("runtime-state")).toHaveAttribute("data-state", "ready")

  const restored = await snapshot(page)
  expect(restored.generation).toBeGreaterThan(before)
  expect(restored.logs.some((entry) => entry.kind === "runtime-closed")).toBe(true)
  await page.getByTestId("ws-apply").click()
  await expect(page.getByTestId("servers-state")).toContainText("s-live-alpha")
})
