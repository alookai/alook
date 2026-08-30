import { readFileSync } from "node:fs"
import type { BrowserContext, Locator, Page } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { REPO_ROOT } from "./_setup/paths"

const latestDaemonVersion = (JSON.parse(readFileSync(
  `${REPO_ROOT}/src/daemon/package.json`,
  "utf8",
)) as { version: string }).version

const outdatedMachine = {
  id: "machine_daemon_notice",
  hostname: "studio-mac",
  displayName: "Studio Mac",
  platform: "darwin",
  arch: "arm64",
  osRelease: "26.0",
  daemonVersion: "0.1.7",
  lastSeenAt: null,
  status: "online",
  availableRuntimes: [],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  quota: [],
}

async function serveMachines(page: Page, machines = [outdatedMachine]) {
  let requestCount = 0
  const updateRequests: string[] = []
  await page.route("**/api/community/machines", async (route) => {
    requestCount += 1
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ machines }),
    })
  })
  await page.route("**/api/community/machines/*/update", async (route) => {
    const match = new URL(route.request().url()).pathname.match(/\/machines\/([^/]+)\/update$/)
    if (match) updateRequests.push(match[1]!)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ dispatched: true }),
    })
  })
  return {
    machineRequestCount: () => requestCount,
    updateRequests: () => [...updateRequests],
  }
}

async function clearSavedDaemonCheckOnce(context: BrowserContext) {
  await context.addInitScript(() => {
    const marker = "alook:qa:daemon-update-check-cleared"
    if (sessionStorage.getItem(marker)) return
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index)
      if (key?.startsWith("alook:daemon-update-check:")) localStorage.removeItem(key)
    }
    sessionStorage.setItem(marker, "1")
  })
}

async function waitForNoticeLogo(notice: Locator) {
  const logo = notice.locator('[data-slot="message-notification-icon"] img')
  await expect(logo).toBeVisible()
  await expect.poll(() => logo.evaluate((image: HTMLImageElement) => (
    image.complete && image.naturalWidth > 0
  ))).toBe(true)
}

test("daemon reminder checks once, respects reduced motion, and stays dismissed", async ({ asUser }, testInfo) => {
  const { context, page } = await asUser("alice")
  await clearSavedDaemonCheckOnce(context)
  const requests = await serveMachines(page)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoAfterUserWsAuth(page, "/c/me/friends")

  const notice = page.getByTestId(tid.daemonUpdateNotice)
  await expect(notice).toBeVisible()
  await expect(notice).toContainText("Machine update available")
  await expect(notice).toContainText("You can update your machine to get more features.")
  await expect(page.getByTestId(tid.daemonUpdateAction)).toHaveText("Update")
  await waitForNoticeLogo(notice)
  expect(requests.machineRequestCount()).toBe(1)

  const box = await notice.boundingBox()
  expect(box).not.toBeNull()
  expect(Math.abs(box!.x + box!.width / 2 - 640)).toBeLessThanOrEqual(1)
  expect(box!.y).toBe(16)
  await expect(notice).toHaveCSS("transition-property", "none")
  await expect(notice.locator('[data-slot="message-notification-content"]'))
    .toHaveCSS("transition-property", "none")
  const desktopScreenshot = testInfo.outputPath("daemon-update-desktop.png")
  await page.screenshot({ path: desktopScreenshot })
  await testInfo.attach("daemon-update-desktop", {
    path: desktopScreenshot,
    contentType: "image/png",
  })

  await notice.locator('[data-slot="message-notification-close"]').click()
  await expect(notice).toBeHidden()
  await page.reload()
  await expect(notice).toHaveCount(0)
  expect(requests.machineRequestCount()).toBe(1)
  expect(requests.updateRequests()).toEqual([])
})

test("mobile daemon reminder fits, swipes away, and dispatches eligible updates", async ({ asUser }, testInfo) => {
  const swipeSession = await asUser("bob", { hasTouch: true })
  await clearSavedDaemonCheckOnce(swipeSession.context)
  await serveMachines(swipeSession.page)
  await swipeSession.page.setViewportSize({ width: 390, height: 844 })
  await gotoAfterUserWsAuth(swipeSession.page, "/c/me/friends")

  const swipeNotice = swipeSession.page.getByTestId(tid.daemonUpdateNotice)
  await expect(swipeNotice).toBeVisible()
  await waitForNoticeLogo(swipeNotice)
  const [noticeBox, actionBox, closeBox] = await Promise.all([
    swipeNotice.boundingBox(),
    swipeSession.page.getByTestId(tid.daemonUpdateAction).boundingBox(),
    swipeNotice.locator('[data-slot="message-notification-close"]').boundingBox(),
  ])
  expect(noticeBox).not.toBeNull()
  expect(actionBox).not.toBeNull()
  expect(closeBox).not.toBeNull()
  expect(noticeBox!.x).toBeGreaterThanOrEqual(0)
  expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(390)
  expect(actionBox!.height).toBeGreaterThanOrEqual(43.9)
  expect(closeBox!.height).toBeGreaterThanOrEqual(43.9)
  expect(await swipeSession.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const mobileScreenshot = testInfo.outputPath("daemon-update-mobile.png")
  await swipeSession.page.screenshot({ path: mobileScreenshot })
  await testInfo.attach("daemon-update-mobile", {
    path: mobileScreenshot,
    contentType: "image/png",
  })

  await swipeSession.page.mouse.move(noticeBox!.x + noticeBox!.width / 2, noticeBox!.y + noticeBox!.height / 2)
  await swipeSession.page.mouse.down()
  await swipeSession.page.mouse.move(noticeBox!.x + 24, noticeBox!.y + noticeBox!.height / 2, { steps: 8 })
  await swipeSession.page.mouse.up()
  await expect(swipeNotice).toBeHidden()

  const actionSession = await asUser("carol", { hasTouch: true })
  await clearSavedDaemonCheckOnce(actionSession.context)
  const actionRequests = await serveMachines(actionSession.page, [
    outdatedMachine,
    { ...outdatedMachine, id: "machine_daemon_notice_2", daemonVersion: "0.1.20" },
    { ...outdatedMachine, id: "offline_machine", status: "offline" },
    { ...outdatedMachine, id: "manual_update_machine", daemonVersion: "0.1.6" },
    { ...outdatedMachine, id: "current_machine", daemonVersion: latestDaemonVersion },
  ])
  await actionSession.page.setViewportSize({ width: 390, height: 844 })
  await gotoAfterUserWsAuth(actionSession.page, "/c/me/friends")
  await actionSession.page.getByTestId(tid.daemonUpdateAction).click()
  await expect(actionSession.page.getByTestId(tid.daemonUpdateNotice)).toHaveCount(0)
  await expect(actionSession.page).toHaveURL(/\/c\/me\/friends$/)
  await expect.poll(() => actionRequests.updateRequests().sort()).toEqual([
    "machine_daemon_notice",
    "machine_daemon_notice_2",
  ])
})
