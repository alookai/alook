import type { Page } from "@playwright/test"
import { expect, test } from "./_fixtures/community-fixture"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

const RAIL_ENDPOINT = "/api/community/users/me/server-rail"

async function openMove(page: Page, serverId: string) {
  const icon = page.getByTestId(tid.serverIcon(serverId))
  await icon.focus()
  await expect(icon.locator("xpath=ancestor::*[@data-slot='context-menu-trigger'][1]")).toBeVisible()
  await icon.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Move…" }).click()
  await expect(page.getByRole("heading", { name: "Move server" })).toBeVisible()
}

test("server rail commits one PDD drop and exposes mobile Move parity", async ({ asUser }) => {
  test.setTimeout(150_000)
  const stamp = Date.now()
  const first = await seedServer("alice", `Rail first ${stamp}`)
  const second = await seedServer("alice", `Rail second ${stamp}`)
  const third = await seedServer("alice", `Rail third ${stamp}`)
  const channel = await seedChannel("alice", first, `rail-${stamp}`)
  const { page } = await asUser("alice")
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/c/channels/${first}/${channel}`)
  await expect(page.getByTestId(tid.serverIcon(first))).toBeVisible({ timeout: 30_000 })

  const railRequests: Array<{ body: unknown; status?: number }> = []
  page.on("request", (request) => {
    if (request.method() !== "PATCH" || new URL(request.url()).pathname !== RAIL_ENDPOINT) return
    railRequests.push({ body: request.postDataJSON() })
  })
  page.on("response", (response) => {
    if (response.request().method() !== "PATCH" || new URL(response.url()).pathname !== RAIL_ENDPOINT) return
    const current = railRequests.at(-1)
    if (current) current.status = response.status()
  })

  const source = page.getByTestId(tid.serverIcon(first))
  const target = page.getByTestId(tid.serverIcon(second))
  await source.focus()
  await expect(source.locator("xpath=ancestor::*[@data-slot='context-menu-trigger'][1]")).toBeVisible()
  await target.focus()
  await expect(target.locator("xpath=ancestor::*[@data-slot='context-menu-trigger'][1]")).toBeVisible()
  await page.evaluate(() => {
    const events: string[] = []
    Reflect.set(window, "__railDragEvents", events)
    for (const type of ["dragstart", "dragenter", "dragover", "drop", "dragend"]) {
      document.addEventListener(type, () => events.push(type), { capture: true })
    }
  })
  const sourceDraggable = source.locator("xpath=ancestor::*[@draggable='true'][1]")
  const targetDraggable = target.locator("xpath=ancestor::*[@draggable='true'][1]")
  await expect(sourceDraggable).toHaveCount(1)
  await expect(targetDraggable).toHaveCount(1)
  await sourceDraggable.dragTo(targetDraggable, {
    targetPosition: { x: 28, y: 34 },
    force: true,
  })
  await page.waitForTimeout(500)
  const dragEvents = await page.evaluate(() => Reflect.get(window, "__railDragEvents"))
  expect(dragEvents).toContain("dragstart")
  expect(dragEvents).toContain("drop")
  await expect.poll(() => railRequests.length, { timeout: 10_000 }).toBe(1)
  expect(railRequests).toHaveLength(1)
  expect(railRequests[0]?.body).toMatchObject({
    commands: [{ kind: "reorder-servers" }],
  })
  await expect.poll(() => railRequests[0]?.status).toBe(200)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Back" }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${first}`)
  await openMove(page, third)
  await page.getByTestId(tid.serverRailMoveDestination).selectOption("new")
  await page.getByTestId(tid.serverRailMoveTarget).selectOption(first)
  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && new URL(response.url()).pathname === RAIL_ENDPOINT,
  )
  await page.getByTestId(tid.serverRailMoveConfirm).click()
  const createResponse = await createResponsePromise
  expect(createResponse.status()).toBe(200)
  expect(railRequests).toHaveLength(2)
  expect(railRequests[1]?.body).toMatchObject({
    commands: [{ kind: "create-folder", name: "Group", serverIds: [third, first] }],
  })
  await expect(page.getByTestId(tid.serverIcon(third))).toBeVisible()
  await expect(page.getByTestId(tid.serverIcon(first))).toBeVisible()
  await expect(page.getByTestId(tid.serverIcon(second))).toBeVisible()
  const rail = page.getByTestId(tid.serverRailScroll)
  const beforeSwipe = await rail.evaluate((element) => element.scrollTop)
  const box = await page.getByTestId(tid.serverIcon(second)).boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 20, box!.y + 20)
  await page.mouse.down()
  await page.mouse.move(box!.x + 20, Math.max(10, box!.y - 100), { steps: 8 })
  await page.mouse.up()
  expect(railRequests).toHaveLength(2)
  expect(await rail.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(beforeSwipe)
})
