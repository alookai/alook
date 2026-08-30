import { readFileSync } from "node:fs"
import type { BrowserContext, Page } from "@playwright/test"
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
  daemonVersion: "0.0.0",
  lastSeenAt: null,
  status: "offline",
  availableRuntimes: [],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  quota: [],
}

async function serveOutdatedMachine(page: Page) {
  let requestCount = 0
  await page.route("**/api/community/machines", async (route) => {
    requestCount += 1
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ machines: [outdatedMachine] }),
    })
  })
  return () => requestCount
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

test("daemon reminder checks once, respects reduced motion, and stays dismissed", async ({ asUser }) => {
  const { context, page } = await asUser("alice")
  await clearSavedDaemonCheckOnce(context)
  const machineRequestCount = await serveOutdatedMachine(page)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoAfterUserWsAuth(page, "/c/me/friends")

  const notice = page.getByTestId(tid.daemonUpdateNotice)
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(`1 machine needs daemon v${latestDaemonVersion}.`)
  expect(machineRequestCount()).toBe(1)

  const box = await notice.boundingBox()
  expect(box).not.toBeNull()
  expect(Math.abs(box!.x + box!.width / 2 - 640)).toBeLessThanOrEqual(1)
  expect(box!.y).toBe(16)
  await expect(notice).toHaveCSS("transition-property", "none")
  await expect(notice.locator('[data-slot="message-notification-content"]'))
    .toHaveCSS("transition-property", "none")

  await notice.locator('[data-slot="message-notification-close"]').click()
  await expect(notice).toBeHidden()
  await page.reload()
  await expect(notice).toHaveCount(0)
  expect(machineRequestCount()).toBe(1)
})

test("mobile daemon reminder fits, swipes away, and its action navigates", async ({ asUser }) => {
  const swipeSession = await asUser("bob", { hasTouch: true })
  await clearSavedDaemonCheckOnce(swipeSession.context)
  await serveOutdatedMachine(swipeSession.page)
  await swipeSession.page.setViewportSize({ width: 390, height: 844 })
  await gotoAfterUserWsAuth(swipeSession.page, "/c/me/friends")

  const swipeNotice = swipeSession.page.getByTestId(tid.daemonUpdateNotice)
  await expect(swipeNotice).toBeVisible()
  const [noticeBox, actionBox, closeBox] = await Promise.all([
    swipeNotice.boundingBox(),
    swipeSession.page.getByTestId(tid.daemonUpdateViewMachines).boundingBox(),
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

  await swipeSession.page.mouse.move(noticeBox!.x + noticeBox!.width / 2, noticeBox!.y + noticeBox!.height / 2)
  await swipeSession.page.mouse.down()
  await swipeSession.page.mouse.move(noticeBox!.x + 24, noticeBox!.y + noticeBox!.height / 2, { steps: 8 })
  await swipeSession.page.mouse.up()
  await expect(swipeNotice).toBeHidden()

  const actionSession = await asUser("carol", { hasTouch: true })
  await clearSavedDaemonCheckOnce(actionSession.context)
  await serveOutdatedMachine(actionSession.page)
  await actionSession.page.setViewportSize({ width: 390, height: 844 })
  await gotoAfterUserWsAuth(actionSession.page, "/c/me/friends")
  await actionSession.page.getByTestId(tid.daemonUpdateViewMachines).click()
  await expect(actionSession.page).toHaveURL(/\/c\/me\/machines$/)
  await expect(actionSession.page.getByTestId(tid.daemonUpdateNotice)).toHaveCount(0)
})
