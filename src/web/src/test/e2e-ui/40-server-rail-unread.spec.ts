import type { Locator, Page } from "@playwright/test"
import { expect, test, userId } from "./_fixtures/community-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import { memberInfo, seedChannel, seedJoinServer, seedMessage, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

async function indicatorHeight(indicator: Locator) {
  return indicator.evaluate((element) => element.getBoundingClientRect().height)
}

async function expectIndicatorHeight(indicator: Locator, height: number) {
  await expect.poll(() => indicatorHeight(indicator), { timeout: 20_000 }).toBe(height)
}

async function createSingleServerFolder(page: Page, serverId: string) {
  const icon = page.getByTestId(tid.serverIcon(serverId))
  await icon.focus()
  await expect(icon.locator("xpath=ancestor::*[@data-slot='context-menu-trigger'][1]")).toBeVisible()
  await icon.click({ button: "right" })
  const response = page.waitForResponse((candidate) => (
    candidate.request().method() === "PATCH"
    && new URL(candidate.url()).pathname === "/api/community/users/me/server-rail"
  ))
  await page.getByRole("menuitem", { name: "Create group" }).click()
  expect((await response).status()).toBe(200)
}

test("server unread owns exact rail geometry, folder aggregation, read clear, and mobile parity", async ({ asUser }, testInfo) => {
  test.setTimeout(150_000)
  const stamp = Date.now()
  const foregroundServer = await seedServer("alice", `Unread foreground ${stamp}`)
  const backgroundServer = await seedServer("alice", `Unread background ${stamp}`)
  const foregroundChannel = await seedChannel("alice", foregroundServer, `foreground-${stamp}`)
  const backgroundChannel = await seedChannel("alice", backgroundServer, `background-${stamp}`)
  await seedJoinServer("alice", "bob", foregroundServer)
  await seedJoinServer("alice", "bob", backgroundServer)
  const bobInfo = await memberInfo("alice", backgroundServer, userId("bob"))
  const { page } = await asUser("bob")
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/c/channels/${foregroundServer}/${foregroundChannel}`)
  await expect(page.getByTestId(tid.serverIcon(backgroundServer))).toBeVisible({ timeout: 30_000 })

  const backgroundIndicator = page.getByTestId(tid.serverRailIndicator(backgroundServer))
  await expectIndicatorHeight(backgroundIndicator, 0)
  const firstBody = `background unread ${stamp}`
  await seedMessage("alice", backgroundChannel, firstBody)
  await expectIndicatorHeight(backgroundIndicator, 10)

  const backgroundIcon = page.getByTestId(tid.serverIcon(backgroundServer))
  await backgroundIcon.hover()
  await expectIndicatorHeight(backgroundIndicator, 20)
  await page.mouse.move(300, 300)
  await expectIndicatorHeight(backgroundIndicator, 10)
  await backgroundIcon.focus()
  await expectIndicatorHeight(backgroundIndicator, 20)
  await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
  await expectIndicatorHeight(backgroundIndicator, 10)

  await createSingleServerFolder(page, backgroundServer)
  const folder = page.locator(`[data-testid^="${tid.serverRailFolder("")}"]`).first()
  await expect(folder).toBeVisible()
  const folderTestId = await folder.getAttribute("data-testid")
  if (!folderTestId) throw new Error("missing folder testid")
  const folderId = folderTestId.slice(tid.serverRailFolder("").length)
  const folderIndicator = page.getByTestId(tid.serverRailFolderIndicator(folderId))
  await expectIndicatorHeight(folderIndicator, 0)
  await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
  await expectIndicatorHeight(backgroundIndicator, 10)
  await folder.click()
  await expect(page.getByTestId(tid.serverIcon(backgroundServer))).toHaveCount(0)
  await page.mouse.move(300, 300)
  await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
  await expectIndicatorHeight(folderIndicator, 10)
  await folder.click()
  await expect(backgroundIcon).toBeVisible()
  await page.mouse.move(300, 300)
  await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
  await expectIndicatorHeight(backgroundIndicator, 10)

  await backgroundIcon.click()
  await expectIndicatorHeight(backgroundIndicator, 40)
  const backgroundChannelRow = page.getByTestId(tid.channelRow(backgroundChannel))
  await expect(backgroundChannelRow).toBeVisible({ timeout: 30_000 })
  const readResponse = page.waitForResponse((response) => (
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${backgroundChannel}/read`
  ))
  await page.goto(`/c/channels/${backgroundServer}/${backgroundChannel}`)
  await expect(page.getByText(firstBody, { exact: true })).toBeVisible({ timeout: 30_000 })
  expect((await readResponse).status()).toBe(200)
  await page.getByTestId(tid.serverIcon(foregroundServer)).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(
    `/c/channels/${foregroundServer}/${foregroundChannel}`,
  )
  await expectIndicatorHeight(folderIndicator, 0)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0)
  await page.getByTestId(tid.channelHeaderServer(foregroundServer)).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${foregroundServer}`)
  if (await backgroundIcon.count() === 0) {
    await folder.click()
    await expect(backgroundIcon).toBeVisible()
  }
  await page.mouse.move(300, 300)
  await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
  const alice = await asUser("alice")
  await gotoAfterUserWsAuth(alice.page, `/c/channels/${backgroundServer}/${backgroundChannel}`)
  const secondBody = `mobile background mention ${stamp}`
  const editable = composerEditable(alice.page)
  await editable.click()
  await editable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
  await alice.page.getByTestId(tid.mentionOption(bobInfo.id)).click()
  await editable.pressSequentially(` ${secondBody}`)
  await alice.page.keyboard.press("Enter")
  await expectIndicatorHeight(backgroundIndicator, 10)
  await expect(page.getByTestId(tid.railUnreadBadge(backgroundServer))).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("server-rail-unread-390.png"),
    fullPage: true,
  })

  const seed = await page.request.get("/api/community/servers")
  expect(seed.status()).toBe(200)
  const body = await seed.json() as { servers: Array<{ id: string; unread: boolean }> }
  expect(body.servers.find((server) => server.id === backgroundServer)?.unread).toBe(true)
})
