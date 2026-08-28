import type { Page } from "@playwright/test"
import { expect, test } from "./_fixtures/community-fixture"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

const RAIL_ENDPOINT = "/api/community/users/me/server-rail"

type RailGeometry = {
  rootScrollTop: number
  railScrollTop: number
  railMaxScrollTop: number
  railClientHeight: number
  railScrollHeight: number
  target: { top: number; bottom: number }
  userBar: { top: number; bottom: number }
  add: { top: number; bottom: number }
  targetOwnsCenter: boolean
}

async function railGeometry(page: Page, serverId: string): Promise<RailGeometry> {
  return page.getByTestId(tid.serverIcon(serverId)).evaluate((target, ids) => {
    const nav = target.closest("nav")
    const rail = nav?.querySelector<HTMLElement>(`[data-testid='${ids.rail}']`)
    const userBar = document.querySelector<HTMLElement>("[data-slot='community-user-bar-overlay']")
      ?.firstElementChild as HTMLElement | null
    const add = nav?.querySelector<HTMLElement>(`[data-testid='${ids.add}']`)
    let root = nav?.parentElement ?? null
    while (root && getComputedStyle(root).position !== "fixed") root = root.parentElement
    if (!root || !rail || !userBar || !add) throw new Error("missing server rail geometry node")
    const targetRect = target.getBoundingClientRect()
    const userBarRect = userBar.getBoundingClientRect()
    const addRect = add.getBoundingClientRect()
    const hit = document.elementFromPoint(
      targetRect.left + targetRect.width / 2,
      targetRect.top + targetRect.height / 2,
    )
    return {
      rootScrollTop: root.scrollTop,
      railScrollTop: rail.scrollTop,
      railMaxScrollTop: rail.scrollHeight - rail.clientHeight,
      railClientHeight: rail.clientHeight,
      railScrollHeight: rail.scrollHeight,
      target: { top: targetRect.top, bottom: targetRect.bottom },
      userBar: { top: userBarRect.top, bottom: userBarRect.bottom },
      add: { top: addRect.top, bottom: addRect.bottom },
      targetOwnsCenter: target.contains(hit),
    }
  }, { rail: tid.serverRailScroll, add: tid.serverAdd })
}

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
  const overflowServers: string[] = []
  for (let index = 0; index < 12; index++) {
    overflowServers.push(await seedServer("alice", `Rail overflow ${index} ${stamp}`))
  }
  const tail = overflowServers.at(-1)!
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
  const rail = page.getByTestId(tid.serverRailScroll)
  await rail.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(async () => (await railGeometry(page, tail)).railScrollTop)
    .toBeGreaterThan(0)
  const mobileTail = await railGeometry(page, tail)
  expect(mobileTail.rootScrollTop).toBe(0)
  expect(mobileTail.railScrollTop).toBe(mobileTail.railMaxScrollTop)
  expect(mobileTail.target.bottom).toBeLessThanOrEqual(mobileTail.userBar.top + 0.5)
  expect(mobileTail.targetOwnsCenter).toBe(true)
  await openMove(page, tail)
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
    commands: [{ kind: "create-folder", name: "Group", serverIds: [tail, first] }],
  })
  await expect(page.getByTestId(tid.serverIcon(tail))).toBeVisible()
  await expect(page.getByTestId(tid.serverIcon(first))).toBeVisible()
  await expect(page.getByTestId(tid.serverIcon(second))).toBeVisible()
  await rail.evaluate((element) => { element.scrollTop = element.scrollHeight })
  const expandedTail = await railGeometry(page, tail)
  expect(expandedTail.rootScrollTop).toBe(0)
  expect(expandedTail.target.bottom).toBeLessThanOrEqual(expandedTail.userBar.top + 0.5)
  expect(expandedTail.targetOwnsCenter).toBe(true)
  const beforeSwipe = await rail.evaluate((element) => element.scrollTop)
  const box = await page.getByTestId(tid.serverIcon(second)).boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 20, box!.y + 20)
  await page.mouse.down()
  await page.mouse.move(box!.x + 20, Math.max(10, box!.y - 100), { steps: 8 })
  await page.mouse.up()
  expect(railRequests).toHaveLength(2)
  expect(await rail.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(beforeSwipe)

  await page.setViewportSize({ width: 1280, height: 900 })
  let releaseCommit!: () => void
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve })
  let delayed = false
  await page.route(`**${RAIL_ENDPOINT}`, async (route) => {
    if (route.request().method() === "PATCH" && !delayed) {
      delayed = true
      await commitGate
    }
    await route.continue()
  })
  const pendingResponse = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && new URL(response.url()).pathname === RAIL_ENDPOINT,
  )
  try {
    const topLevel = page.getByTestId(tid.serverIcon(second))
    await topLevel.focus()
    await expect(topLevel.locator("xpath=ancestor::*[@data-slot='context-menu-trigger'][1]")).toBeVisible()
    await topLevel.click({ button: "right" })
    await page.getByRole("menuitem", { name: "Create group" }).click()
    await expect.poll(() => railRequests.length).toBe(3)

    const existingFolder = page.locator(`[data-testid^="${tid.serverRailFolder("")}"]`).first()
    await existingFolder.click({ button: "right" })
    await page.getByRole("menuitem", { name: "Ungroup" }).click()
    await page.waitForTimeout(250)
    expect(railRequests).toHaveLength(3)
  } finally {
    releaseCommit()
  }
  expect((await pendingResponse).status()).toBe(200)
  await page.unroute(`**${RAIL_ENDPOINT}`)
})

test("short server rail keeps Add adjacent and desktop geometry stable", async ({ asUser }) => {
  const stamp = Date.now()
  const serverId = await seedServer("carol", `Rail short ${stamp}`)
  const { page } = await asUser("carol")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/c/channels/${serverId}`)
  await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible({ timeout: 30_000 })

  const mobile = await railGeometry(page, serverId)
  expect(mobile.rootScrollTop).toBe(0)
  expect(mobile.railScrollHeight).toBeLessThanOrEqual(mobile.railClientHeight)
  expect(mobile.add.top - mobile.target.bottom).toBeGreaterThanOrEqual(0)
  expect(mobile.add.top - mobile.target.bottom).toBeLessThanOrEqual(16)
  expect(mobile.targetOwnsCenter).toBe(true)

  await page.setViewportSize({ width: 1280, height: 844 })
  const desktop = await railGeometry(page, serverId)
  expect(desktop.rootScrollTop).toBe(0)
  expect(desktop.target).toEqual(mobile.target)
  expect(desktop.add).toEqual(mobile.add)
  expect(desktop.targetOwnsCenter).toBe(true)
})
