import type { Page, TestInfo } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"

const days = [
  { day: "2026-08-23", period: "closed", metrics: { input: 1200, output: 400, cache: 2000 } },
  { day: "2026-08-24", period: "closed", metrics: { input: 800, output: 200, cache: 1000 } },
  { day: "2026-08-25", period: "closed", metrics: { input: null, output: null, cache: null } },
  { day: "2026-08-26", period: "closed", metrics: { input: 700, output: 300, cache: null } },
  { day: "2026-08-27", period: "closed", metrics: { input: 0, output: 0, cache: 0 } },
  { day: "2026-08-28", period: "closed", metrics: { input: 4000, output: 1200, cache: 6400 } },
  { day: "2026-08-29", period: "in_progress", metrics: { input: 1800, output: 650, cache: 2400 } },
] as const

const smallerDays = days.map((day) => ({
  ...day,
  metrics: {
    input: day.metrics.input === null ? null : day.metrics.input / 10,
    output: day.metrics.output === null ? null : day.metrics.output / 10,
    cache: day.metrics.cache === null ? null : day.metrics.cache / 10,
  },
}))

const claudeDays = days.map((day) => ({
  ...day,
  metrics: {
    input: day.metrics.input === null ? null : day.metrics.input / 2,
    output: day.metrics.output === null ? null : day.metrics.output / 2,
    cache: day.metrics.cache === null ? null : day.metrics.cache / 2,
  },
}))

const machine = {
  id: "machine_telemetry",
  hostname: "studio-mac",
  displayName: "Studio Mac",
  platform: "darwin",
  arch: "arm64",
  osRelease: "26.0",
  daemonVersion: "0.1.24",
  lastSeenAt: "2026-08-29T01:00:00.000Z",
  status: "online",
  availableRuntimes: [
    { id: "codex", status: "healthy" },
    { id: "pi", status: "healthy" },
    { id: "claude", status: "healthy" },
  ],
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T01:00:00.000Z",
  quota: [
    {
      scope: { kind: "machine_backend", machineId: "machine_telemetry", agentBackendId: "codex" },
      capability: "supported",
      runtimeState: "healthy",
      snapshot: {
        status: "available",
        observedAt: new Date().toISOString(),
        planName: "Plus",
        limits: [
          {
            bucket: {
              limitId: "spark-five-hour",
              product: { kind: "reported", id: "spark", displayName: "Spark" },
              model: { kind: "reported", id: "gpt-5.3-codex-spark" },
              window: { kind: "rolling", durationSeconds: 18_000, displayName: "5 hour usage limit" },
            },
            usedPercent: 82,
            resetsAt: "2026-08-29T05:00:00.000Z",
          },
          {
            bucket: {
              limitId: "spark-weekly",
              product: { kind: "reported", id: "spark", displayName: "Spark" },
              model: { kind: "reported", id: "gpt-5.3-codex-spark" },
              window: { kind: "calendar", period: "week", displayName: "Weekly usage limit" },
            },
            usedPercent: 55.5,
            resetsAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
    },
    {
      scope: { kind: "machine_backend", machineId: "machine_telemetry", agentBackendId: "pi" },
      capability: "unsupported",
      runtimeState: "healthy",
      snapshot: { status: "pending" },
    },
    {
      scope: { kind: "machine_backend", machineId: "machine_telemetry", agentBackendId: "claude" },
      capability: "supported",
      runtimeState: "healthy",
      snapshot: {
        status: "available",
        observedAt: new Date().toISOString(),
        planName: "Max",
        limits: [{
          bucket: {
            limitId: "five_hour",
            product: { kind: "reported", id: "claude", displayName: "Claude" },
            model: { kind: "not_applicable" },
            window: { kind: "rolling", durationSeconds: 18_000, displayName: "5 hour usage limit" },
          },
          usedPercent: 36,
          resetsAt: "2026-08-29T06:00:00.000Z",
        }],
      },
    },
  ],
}

const bots = [
  {
    id: "bot_codex",
    name: "Alli",
    description: "",
    image: null,
    machineId: machine.id,
    runtime: "codex",
    modelName: "gpt-5.3-codex-spark",
    lastRefreshContextAt: "2026-08-28T20:00:00.000Z",
    dailyActivity: [],
    usage: { capability: "supported", days },
  },
  {
    id: "bot_pi",
    name: "Scout",
    description: "",
    image: null,
    machineId: machine.id,
    runtime: "pi",
    modelName: null,
    lastRefreshContextAt: null,
    dailyActivity: [],
    usage: { capability: "unsupported", days: [] },
  },
  {
    id: "bot_claude",
    name: "Draft",
    description: "",
    image: null,
    machineId: machine.id,
    runtime: "claude",
    modelName: "claude-opus-4-6",
    lastRefreshContextAt: null,
    dailyActivity: [],
    usage: { capability: "supported", days: claudeDays },
  },
  {
    id: "bot_small",
    name: "Pocket",
    description: "",
    image: null,
    machineId: machine.id,
    runtime: "codex",
    modelName: "gpt-5.3-codex-spark",
    lastRefreshContextAt: null,
    dailyActivity: [],
    usage: { capability: "supported", days: smallerDays },
  },
]

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(`${name}.png`, { path, contentType: "image/png" })
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test("My Bots renders seven-day usage and replace-all quota across responsive themes", async ({ asUser }, testInfo) => {
  const { page } = await asUser("alice", { hasTouch: true })
  await page.route("**/api/community/bots", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bots }) })
  })
  await page.route("**/api/community/machines", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ machines: [machine] }) })
  })
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" })
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoAfterUserWsAuth(page, "/c/me/bots")

  const usage = page.getByTestId(tid.botUsage("bot_codex"))
  await expect(usage).toBeVisible()
  await expect(usage.getByRole("listitem")).toHaveCount(7)
  await expect(usage).not.toContainText("8/23")
  await expect(usage).not.toContainText("Today")
  await expect(usage).not.toContainText("Tokens")
  await expect.poll(async () => (await usage.boundingBox())?.height ?? 0).toBe(42)
  const botCard = usage.locator('xpath=ancestor::*[@data-slot="card"]')
  await expect.poll(async () => (await botCard.boundingBox())?.height ?? 0)
    .toBeLessThanOrEqual(80)
  const [usageBox, botMetaBox] = await Promise.all([
    usage.boundingBox(),
    botCard.getByTestId(tid.botCardModel).boundingBox(),
  ])
  expect(usageBox).not.toBeNull()
  expect(botMetaBox).not.toBeNull()
  expect(Math.abs(
    usageBox!.y + usageBox!.height - (botMetaBox!.y + botMetaBox!.height),
  )).toBeLessThanOrEqual(3)
  await expect(page.getByTestId(tid.botUsage("bot_pi"))).toHaveCount(0)
  await expect(page.getByText("Token usage not supported")).toHaveCount(0)
  const claudeUsage = page.getByTestId(tid.botUsage("bot_claude"))
  await expect(claudeUsage.getByRole("listitem")).toHaveCount(7)
  const quota = page.getByTestId(tid.machineQuota(machine.id))
  await expect(quota).toHaveCount(1)
  await expect(quota).toContainText("Quota · Spark · 18% left · 3 limits")

  const largestDayBar = page
    .getByTestId(tid.botUsageDay("bot_codex", "2026-08-28"))
    .locator('[style*="height"]')
  const smallerDayBar = page
    .getByTestId(tid.botUsageDay("bot_small", "2026-08-28"))
    .locator('[style*="height"]')
  await expect(largestDayBar).toHaveAttribute("style", /height: 100%/)
  await expect(smallerDayBar).toHaveAttribute("style", /height: 10%/)
  await expect(
    page.getByTestId(tid.botUsageDay("bot_claude", "2026-08-28")).locator('[style*="height"]'),
  ).toHaveAttribute("style", /height: 50%/)

  const usageDay = page.getByTestId(tid.botUsageDay("bot_codex", "2026-08-26"))
  await usageDay.hover()
  const tooltip = page.locator('[data-slot="tooltip-content"]:visible')
  await expect(tooltip).toContainText("Input700")
  await expect(tooltip).toContainText("Output300")
  await expect(tooltip).toContainText("CacheUnavailable")
  await usageDay.focus()
  await expect(page.getByText("Input", { exact: true }).last()).toBeVisible()
  await page.keyboard.press("Escape")

  await expect(quota).toHaveAttribute("aria-expanded", "false")
  await quota.click()
  await expect(quota).toHaveAttribute("aria-expanded", "true")
  const quotaDetail = page.getByTestId(tid.machineQuotaDetail(machine.id))
  await expect(quotaDetail).toContainText("Codex")
  await expect(quotaDetail).toContainText("Pi")
  await expect(quotaDetail).toContainText("Not supported")
  await expect(quotaDetail).toContainText("Claude")
  await expect(quotaDetail).toContainText("Max")
  await expect(quotaDetail).toContainText("64% left")
  await expect(quotaDetail).toContainText("5 hour usage limit")
  await expect(quotaDetail).toContainText("Weekly usage limit")
  await expect(quotaDetail).toContainText("gpt-5.3-codex-spark")
  await expect(quotaDetail).toHaveCSS("opacity", "1")

  await expectNoHorizontalOverflow(page)
  await attachScreenshot(page, testInfo, "my-bots-telemetry-pc-light")
  await quota.click()
  await expect(quota).toHaveAttribute("aria-expanded", "false")
  await expect(quotaDetail).toBeHidden()
  await page.emulateMedia({ colorScheme: "dark" })
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true)
  await page.waitForTimeout(300)
  await attachScreenshot(page, testInfo, "my-bots-telemetry-pc-dark")

  await page.setViewportSize({ width: 639, height: 844 })
  await page.emulateMedia({ colorScheme: "light" })
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(false)
  await page.waitForTimeout(300)
  await expectNoHorizontalOverflow(page)
  await expect(usage).toBeVisible()
  await expect(usage.getByRole("listitem")).toHaveCount(7)
  const mobileUsageTrigger = usage.getByRole("button", { name: "Open token usage details" })
  const mobileUsageBox = await mobileUsageTrigger.boundingBox()
  expect(mobileUsageBox?.height).toBeGreaterThanOrEqual(44)
  expect(mobileUsageBox?.width).toBeGreaterThanOrEqual(44)
  await mobileUsageTrigger.tap()
  const mobileUsageDetail = page.locator('[data-slot="popover-content"]:visible')
  await expect.poll(async () => (await mobileUsageDetail.boundingBox())?.height ?? 0)
    .toBeLessThanOrEqual(260)
  const mobileDayTargets = page.locator(
    `[data-testid^="${tid.botUsageDay("bot_codex", "")}"]:visible`,
  )
  await expect(mobileDayTargets).toHaveCount(7)
  await expect.poll(async () => {
    const boxes = await mobileDayTargets.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect()
      return { width: box.width, height: box.height }
    }))
    return boxes.every((box) => box.width >= 44 && box.height >= 44)
  }).toBe(true)
  const mobileDayBoxes = await mobileDayTargets.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height, y: Math.round(box.y) }
  }))
  expect(new Set(mobileDayBoxes.map((box) => box.y)).size).toBeLessThanOrEqual(2)
  await expect(page.locator(
    `[data-testid^="${tid.botUsageDay("bot_codex", "")}"][aria-pressed="true"]:visible`,
  )).toHaveCount(1)
  const mobileUsageDay = page.locator(
    `[data-testid="${tid.botUsageDay("bot_codex", "2026-08-26")}"]:visible`,
  )
  await expect.poll(async () => (await mobileUsageDay.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44)
  await expect.poll(async () => (await mobileUsageDay.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(44)
  await mobileUsageDay.tap()
  await expect(mobileUsageDay).toHaveAttribute("aria-pressed", "true")
  await expect(mobileUsageDetail).toContainText("Input700")
  await expect(mobileUsageDetail).toContainText("Output300")
  await expect(mobileUsageDetail).toContainText("CacheUnavailable")
  const mobileQuotaBox = await quota.boundingBox()
  expect(mobileQuotaBox?.height).toBeGreaterThanOrEqual(44)
  expect(mobileQuotaBox?.width).toBeGreaterThanOrEqual(44)
  await mobileUsageTrigger.tap()
  await expect(mobileUsageTrigger).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator('[data-slot="popover-content"]:visible')).toHaveCount(0)
  await attachScreenshot(page, testInfo, "my-bots-telemetry-mobile-light")
  await page.emulateMedia({ colorScheme: "dark" })
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true)
  await page.waitForTimeout(300)
  await expectNoHorizontalOverflow(page)
  await attachScreenshot(page, testInfo, "my-bots-telemetry-mobile-dark")

  await page.setViewportSize({ width: 640, height: 844 })
  await expect(mobileUsageTrigger).toBeHidden()
  await expect(page.locator(
    `[data-testid^="${tid.botUsageDay("bot_codex", "")}"]:visible`,
  )).toHaveCount(7)
  await expect.poll(async () => (await usage.boundingBox())?.height ?? 0).toBe(42)
  const desktopBoundaryDay = page.getByTestId(tid.botUsageDay("bot_codex", "2026-08-26"))
  await desktopBoundaryDay.hover()
  await expect(page.locator('[data-slot="tooltip-content"]:visible')).toContainText("Input700")
})
