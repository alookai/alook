import { readFileSync } from "node:fs"
import type { Page, Request } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
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

async function serveMachines(page: Page, {
  machines = [outdatedMachine],
  failOnce = [],
}: {
  machines?: Array<typeof outdatedMachine>
  failOnce?: string[]
} = {}) {
  let requestCount = 0
  const updateRequests: string[] = []
  const remainingFailures = new Set(failOnce)
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
    const machineId = match?.[1]
    if (machineId) updateRequests.push(machineId)
    if (machineId && remainingFailures.delete(machineId)) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary unavailable" }),
      })
      return
    }
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

function observeWrites(page: Page) {
  const writes: string[] = []
  const listener = (request: Request) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    }
  }
  page.on("request", listener)
  return { writes, stop: () => page.off("request", listener) }
}

test("Update, Inbox, and viewer Profile share one persistent User Bar extension", async ({ asUser }) => {
  const { page } = await asUser("alice")
  const requests = await serveMachines(page)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoAfterUserWsAuth(page, "/c/me/friends")

  const slot = page.getByTestId(tid.userBarExtension)
  const userBar = page.getByTestId(tid.userBar)
  const userBarBase = userBar.locator("[data-slot='community-user-bar-base']")
  await expect(slot).toBeVisible()
  await expect(slot).toHaveAttribute("data-extension", "update")
  await expect(slot).toContainText("Machine update available")
  await expect(slot).toContainText("You can update your machine to get more features.")
  await expect(page.getByTestId(tid.daemonUpdateAction)).toHaveText("Update")
  await expect(page.getByTestId(tid.daemonUpdateBadge)).toHaveCount(0)
  await expect(slot.getByRole("button", { name: /^Dismiss / })).toHaveCount(0)
  await expect(slot).toHaveCSS("animation-name", "none")
  expect(requests.machineRequestCount()).toBe(1)

  const [slotBox, baseBox] = await Promise.all([slot.boundingBox(), userBarBase.boundingBox()])
  expect(slotBox).not.toBeNull()
  expect(baseBox).not.toBeNull()
  expect(Math.abs(slotBox!.y + slotBox!.height - baseBox!.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(slotBox!.x - baseBox!.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(slotBox!.width - baseBox!.width)).toBeLessThanOrEqual(1)

  await page.keyboard.press("Escape")
  const badge = page.getByTestId(tid.daemonUpdateBadge)
  await expect(slot).toHaveCount(0)
  await expect(badge).toBeVisible()
  await expect(badge).toHaveText("")
  await expect(badge.locator("svg")).toHaveCount(1)
  await expect.poll(() => page.evaluate((version) => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith("alook:daemon-update-collapsed:") && key.endsWith(`:${version}`)) {
        return localStorage.getItem(key)
      }
    }
    return null
  }, latestDaemonVersion)).toBe("1")

  await page.reload()
  await expect(badge).toBeVisible()
  await expect(slot).toHaveCount(0)
  await badge.focus()
  await page.keyboard.press("Enter")
  await expect(slot).toHaveAttribute("data-extension", "update")
  await expect(slot).toBeFocused()
  await expect(badge).toHaveCount(0)
  await page.keyboard.press("Tab")
  await expect(page.getByTestId(tid.daemonUpdateAction)).toBeFocused()

  const writes = observeWrites(page)
  const inboxTrigger = page.getByTestId(tid.inboxTrigger)
  const inboxIcon = inboxTrigger.locator("svg")
  const readInboxTriggerStyle = () => inboxTrigger.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
    }
  })
  await expect(inboxTrigger).toHaveAttribute("aria-label", "Inbox")
  await expect(inboxIcon).toHaveAttribute("fill", "none")
  await expect(inboxIcon).not.toHaveClass(/fill-current/)
  const closedInboxTriggerStyle = await readInboxTriggerStyle()
  await inboxTrigger.focus()
  await page.keyboard.press("Enter")
  await expect(slot).toHaveAttribute("data-extension", "inbox")
  await expect(slot).toBeFocused()
  await expect(page.getByTestId(tid.daemonUpdateBadge)).toBeVisible()
  await expect(inboxIcon).toHaveAttribute("fill", "none")
  await expect(inboxIcon).not.toHaveClass(/fill-current/)
  await expect.poll(async () => {
    const openStyle = await readInboxTriggerStyle()
    return {
      backgroundChanged: openStyle.backgroundColor !== closedInboxTriggerStyle.backgroundColor,
      foregroundChanged: openStyle.color !== closedInboxTriggerStyle.color,
    }
  }).toEqual({ backgroundChanged: true, foregroundChanged: true })
  const [badgeBox, inboxBox] = await Promise.all([
    page.getByTestId(tid.daemonUpdateBadge).boundingBox(),
    inboxTrigger.boundingBox(),
  ])
  expect(badgeBox).not.toBeNull()
  expect(inboxBox).not.toBeNull()
  expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(inboxBox!.x)

  await inboxTrigger.click()
  await page.mouse.move(0, 0)
  await expect(slot).toHaveCount(0)
  await expect(inboxTrigger).toHaveAttribute("aria-expanded", "false")
  await expect(inboxIcon).toHaveAttribute("fill", "none")
  await expect(inboxIcon).not.toHaveClass(/fill-current/)
  await expect.poll(readInboxTriggerStyle).toEqual(closedInboxTriggerStyle)
  await inboxTrigger.click()
  await page.mouse.move(0, 0)
  await expect(slot).toHaveAttribute("data-extension", "inbox")
  await expect(inboxIcon).toHaveAttribute("fill", "none")
  await expect(inboxIcon).not.toHaveClass(/fill-current/)
  await expect.poll(async () => {
    const openStyle = await readInboxTriggerStyle()
    return {
      backgroundChanged: openStyle.backgroundColor !== closedInboxTriggerStyle.backgroundColor,
      foregroundChanged: openStyle.color !== closedInboxTriggerStyle.color,
    }
  }).toEqual({ backgroundChanged: true, foregroundChanged: true })

  const profileNameTrigger = userBarBase.getByTestId(tid.userBarName).locator("..")
  await profileNameTrigger.focus()
  await page.keyboard.press("Enter")
  await expect(slot).toHaveAttribute("data-extension", "profile")
  await expect(slot).toBeFocused()
  await expect(page.getByTestId(tid.profileCard)).toBeVisible()
  await expect(page.getByTestId(tid.inboxTabList)).toHaveCount(0)
  await profileNameTrigger.click()
  await expect(slot).toHaveCount(0)
  await expect(profileNameTrigger).toBeFocused()
  await expect(page.getByTestId(tid.daemonUpdateBadge)).toBeVisible()
  expect(writes.writes).toEqual([])
  writes.stop()
})

test("partial dispatch retries only failed eligible Machines and clears from live Machine data", async ({ asUser }) => {
  const { context, page } = await asUser("bob")
  const ws = await proxyCommunityWebSockets(context)
  const secondMachine = {
    ...outdatedMachine,
    id: "machine_daemon_notice_2",
    hostname: "travel-mac",
    displayName: "Travel Mac",
    daemonVersion: "0.1.20",
  }
  const requests = await serveMachines(page, {
    machines: [outdatedMachine, secondMachine],
    failOnce: [secondMachine.id],
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoAfterUserWsAuth(page, "/c/me")

  const slot = page.getByTestId(tid.userBarExtension)
  await expect(slot).toContainText("You can update your machines to get more features.")
  await expect(page.getByTestId(tid.daemonUpdateBadge)).toHaveCount(0)
  await page.getByTestId(tid.daemonUpdateAction).click()
  await expect(slot).toContainText("1 machine is updating. 1 update request failed.")
  await expect(page.getByTestId(tid.daemonUpdateAction)).toHaveText("Retry")
  await expect.poll(() => requests.updateRequests()).toEqual([
    outdatedMachine.id,
    secondMachine.id,
  ])

  await page.getByTestId(tid.daemonUpdateAction).click()
  await expect(slot).toContainText("2 machines are updating")
  await expect(page.getByTestId(tid.daemonUpdateAction)).toHaveCount(0)
  await expect.poll(() => requests.updateRequests()).toEqual([
    outdatedMachine.id,
    secondMachine.id,
    secondMachine.id,
  ])

  await page.keyboard.press("Escape")
  const progressBadge = page.getByTestId(tid.daemonUpdateBadge)
  await expect(progressBadge).toHaveAttribute("aria-label", "Machine update in progress")
  await expect(progressBadge).toHaveText("")

  const { quota: _firstQuota, ...firstUpdated } = outdatedMachine
  const { quota: _secondQuota, ...secondUpdated } = secondMachine
  ws.send({
    type: "community:machine.updated",
    machine: { ...firstUpdated, daemonVersion: latestDaemonVersion },
  })
  await expect(progressBadge).toBeVisible()
  ws.send({
    type: "community:machine.updated",
    machine: { ...secondUpdated, daemonVersion: latestDaemonVersion },
  })
  await expect(progressBadge).toHaveCount(0)
  await expect(slot).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key) => key?.startsWith("alook:daemon-update-collapsed:"))
  ))).toEqual([])
})
