import { expect, test, type Page } from "@playwright/test"

type SpikeReadout = {
  state: {
    serverOrder: string[]
    folderOrder: string[]
    folders: Record<string, string[]>
    expanded: string[]
  }
  events: Array<{ type: string; detail?: string; commands?: unknown[] }>
  clickCount: number
  commitCount: number
  persistenceBatchCount: number
  rollbackCount: number
  preview: null | { operation: string; target: { kind: string; id: string } }
}

async function read(page: Page): Promise<SpikeReadout> {
  return page.evaluate(() => window.__railSpike.read())
}

async function reset(page: Page): Promise<void> {
  await page.getByTestId("reset").click()
}

async function pointerDrag(
  page: Page,
  sourceTestId: string,
  targetTestId: string,
  targetYRatio: number,
): Promise<void> {
  const sourceBox = await page.getByTestId(sourceTestId).boundingBox()
  const targetBox = await page.getByTestId(targetTestId).boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height * targetYRatio, { steps: 12 })
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.goto("/")
})

test.describe("desktop pointer contract", () => {
  test.skip(({ isMobile }) => Boolean(isMobile))

  test("click, reorder, combine, and rollback each settle once", async ({ page }) => {
    const clickBox = await page.getByTestId("primary-server-a").boundingBox()
    expect(clickBox).not.toBeNull()
    await page.mouse.move(clickBox!.x + clickBox!.width / 2, clickBox!.y + clickBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(clickBox!.x + clickBox!.width / 2 + 2, clickBox!.y + clickBox!.height / 2 + 2)
    await page.mouse.up()
    expect((await read(page)).clickCount).toBe(1)
    expect((await read(page)).commitCount).toBe(0)

    await pointerDrag(page, "primary-server-a", "rail-item-server-b", 0.95)
    await expect.poll(async () => (await read(page)).commitCount).toBe(1)
    const reordered = await read(page)
    expect(reordered.state.serverOrder.slice(0, 2)).toEqual(["b", "a"])
    expect(reordered.persistenceBatchCount).toBe(1)
    expect(reordered.events.filter((event) => event.type === "optimistic-commit")).toHaveLength(1)

    await reset(page)
    await pointerDrag(page, "primary-server-a", "rail-item-server-b", 0.5)
    await expect.poll(async () => (await read(page)).commitCount).toBe(1)
    const combined = await read(page)
    const createdFolder = combined.state.folderOrder.find((id) => id.startsWith("temporary-"))
    expect(createdFolder).toBeTruthy()
    expect(combined.state.folders[createdFolder!]).toEqual(["a", "b"])
    expect(combined.events.find((event) => event.type === "optimistic-commit")?.commands).toEqual([
      { type: "create-folder", tempFolderId: createdFolder, serverIds: ["a", "b"] },
    ])

    await reset(page)
    await page.getByTestId("fail-next").click()
    await page.getByTestId("move-trigger-server-a").click()
    await page.getByTestId("move-server-a-reorder-after-b").click()
    await expect.poll(async () => (await read(page)).rollbackCount).toBe(1)
    const rolledBack = await read(page)
    expect(rolledBack.state.serverOrder.slice(0, 2)).toEqual(["a", "b"])
    expect(rolledBack.commitCount).toBe(1)
    expect(rolledBack.persistenceBatchCount).toBe(1)
  })

  test("preview is non-mutating, collapsed folder hover expands, and Escape cancels", async ({ page }) => {
    const before = await read(page)
    const sourceBox = await page.getByTestId("primary-server-a").boundingBox()
    const folderBox = await page.getByTestId("rail-item-folder-two").boundingBox()
    expect(sourceBox).not.toBeNull()
    expect(folderBox).not.toBeNull()

    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(folderBox!.x + folderBox!.width / 2, folderBox!.y + folderBox!.height / 2, { steps: 12 })
    await expect(page.getByTestId("rail-item-folder-two")).toHaveClass(/preview-combine/)
    expect((await read(page)).state).toEqual(before.state)
    await page.waitForTimeout(200)
    await page.mouse.move(8, 8, { steps: 6 })
    await page.waitForTimeout(400)
    await expect(page.locator('[data-folder-children="two"]')).toBeHidden()
    const currentFolderBox = await page.getByTestId("rail-item-folder-two").boundingBox()
    expect(currentFolderBox).not.toBeNull()
    await page.mouse.move(currentFolderBox!.x + currentFolderBox!.width / 2, currentFolderBox!.y + currentFolderBox!.height / 2, { steps: 8 })
    await page.waitForTimeout(550)
    await expect(page.locator('[data-folder-children="two"]')).toBeVisible()
    await page.screenshot({ path: "evidence/desktop-hover-combine.png", fullPage: true })
    await page.keyboard.press("Escape")
    await expect.poll(async () => (await read(page)).events.some((event) => event.type === "cancel")).toBe(true)
    const after = await read(page)
    expect(after.state).toEqual(before.state)
    expect(after.commitCount).toBe(0)
    expect(after.persistenceBatchCount).toBe(0)

    const nextSourceBox = await page.getByTestId("primary-server-a").boundingBox()
    expect(nextSourceBox).not.toBeNull()
    await page.mouse.move(nextSourceBox!.x + nextSourceBox!.width / 2, nextSourceBox!.y + nextSourceBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(8, 8, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await read(page)).events.filter((event) => event.type === "cancel").length).toBe(2)
    expect((await read(page)).commitCount).toBe(0)
  })

  test("edge drag auto-scrolls while canonical state stays fixed until drop", async ({ page }) => {
    const rail = page.getByTestId("rail-scroll")
    const railBox = await rail.boundingBox()
    const sourceBox = await page.getByTestId("primary-folder-one").boundingBox()
    expect(railBox).not.toBeNull()
    expect(sourceBox).not.toBeNull()

    await page.mouse.move(railBox!.x + railBox!.width / 2, railBox!.y + railBox!.height / 2)
    await page.mouse.wheel(0, 260)
    await expect.poll(async () => rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    expect((await read(page)).commitCount).toBe(0)
    await rail.evaluate((element) => { element.scrollTop = 0 })

    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(railBox!.x + railBox!.width / 2, railBox!.y + railBox!.height - 3, { steps: 16 })
    await expect(page.locator('[data-folder-children="one"]')).toBeHidden()
    await expect.poll(async () => rail.evaluate((element) => element.scrollTop), { timeout: 4_000 }).toBeGreaterThan(0)
    expect((await read(page)).commitCount).toBe(0)
    await page.keyboard.press("Escape")
    await expect.poll(async () => (await read(page)).events.some((event) => event.type === "cancel")).toBe(true)
    await expect(page.locator('[data-folder-children="one"]')).toBeVisible()
    expect((await read(page)).commitCount).toBe(0)
  })

  test("Move menu preserves parity, announcement, and focus", async ({ page }) => {
    await page.getByTestId("move-trigger-server-c").click()
    await page.getByTestId("move-server-c-reorder-after-e").click()
    await expect.poll(async () => (await read(page)).commitCount).toBe(1)
    const moved = await read(page)
    expect(moved.state.folders.one).toEqual(["d"])
    expect(moved.state.folders.two).toEqual(["e", "c", "f"])
    await expect(page.getByRole("status")).toHaveText("Server c moved after server e from folder one")
    await expect(page.getByTestId("primary-server-c")).toBeFocused()
  })
})

test.describe("mobile touch separation", () => {
  test.skip(({ isMobile }) => !isMobile)

  test("row swipe scrolls, short tap clicks once, and Move is intentional", async ({ page }) => {
    const rail = page.getByTestId("rail-scroll")
    const row = page.getByTestId("primary-server-g")
    const rowBox = await row.boundingBox()
    expect(rowBox).not.toBeNull()
    const client = await page.context().newCDPSession(page)
    const x = rowBox!.x + rowBox!.width / 2
    const startY = rowBox!.y + rowBox!.height / 2

    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: startY }],
    })
    for (let index = 1; index <= 8; index += 1) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: startY - index * 18 }],
      })
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await expect.poll(async () => rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    let current = await read(page)
    expect(current.commitCount).toBe(0)
    expect(current.clickCount).toBe(0)

    await rail.evaluate((element) => { element.scrollTop = 0 })
    const tapBox = await page.getByTestId("primary-server-a").boundingBox()
    expect(tapBox).not.toBeNull()
    await page.touchscreen.tap(tapBox!.x + tapBox!.width / 2, tapBox!.y + tapBox!.height / 2)
    await expect.poll(async () => (await read(page)).clickCount).toBe(1)
    current = await read(page)
    expect(current.commitCount).toBe(0)

    await page.getByTestId("move-trigger-server-a").click()
    await page.screenshot({ path: "evidence/mobile-move-menu.png", fullPage: true })
    await page.getByTestId("move-server-a-into-two").click()
    await expect.poll(async () => (await read(page)).commitCount).toBe(1)
    current = await read(page)
    expect(current.state.folders.two).toEqual(["e", "f", "a"])
    expect(current.persistenceBatchCount).toBe(1)
  })
})
