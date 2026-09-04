import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import type { Page, TestInfo } from "@playwright/test"
import { calendarDayKeyDaysAgo, dayKeyInTimeZone } from "@alook/shared"
import { test, expect, sessionCookie, userId } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { REPO_ROOT, WEB_URL } from "./_setup/paths"

type D1Result<Row = Record<string, unknown>> = {
  results: Row[]
  success: boolean
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function executeLocalD1<Row = Record<string, unknown>>(sql: string): D1Result<Row>[] {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "alook-app", "--local", "--json", "--command", sql],
    {
      cwd: `${REPO_ROOT}/src/web`,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  if (result.status !== 0) {
    throw new Error(`local D1 command failed (${result.status}): ${result.stderr}`)
  }
  return JSON.parse(result.stdout) as D1Result<Row>[]
}

async function postAsAlice(path: string, body?: unknown): Promise<Response> {
  return fetch(`${WEB_URL}${path}`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie("alice"),
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const dayOverrides: Record<string, { input: number | null; output: number | null; cache: number | null }> = {
  "2026-08-24": { input: 0, output: 0, cache: 0 },
  "2026-08-25": { input: null, output: null, cache: null },
  "2026-08-26": { input: 6_000_000, output: 3_000_000, cache: null },
  "2026-08-27": { input: 8_000_000, output: 2_000_000, cache: 0 },
  "2026-08-28": { input: 70_000_000, output: 30_000_000, cache: 0 },
  "2026-08-29": { input: 300_000_000, output: 100_000_000, cache: 100_000_000 },
}

const days = Array.from({ length: 30 }, (_, index) => {
  const day = `2026-08-${String(index + 1).padStart(2, "0")}`
  return {
    day,
    period: index === 29 ? "in_progress" as const : "closed" as const,
    metrics: dayOverrides[day] ?? { input: null, output: null, cache: null },
  }
})

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
  daemonVersion: "0.1.29",
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
    usage: { capability: "supported", days: smallerDays },
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
  {
    id: "bot_cursor",
    name: "Cursor",
    description: "",
    image: null,
    machineId: machine.id,
    runtime: "cursor",
    modelName: null,
    lastRefreshContextAt: null,
    dailyActivity: [],
    usage: { capability: "unsupported", days: [] },
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

async function expectDarkTheme(page: Page, expected: boolean) {
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(expected)
}

test("My Bots restores the 30-day token heatmap across PC and mobile", async ({ asUser }, testInfo) => {
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
  await expectDarkTheme(page, false)
  const writeRequests: string[] = []
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      writeRequests.push(`${request.method()} ${new URL(request.url()).pathname}`)
    }
  })

  const usage = page.getByTestId(tid.botUsage("bot_codex"))
  const dayCells = usage.locator(`[data-testid^="${tid.botUsageDay("bot_codex", "")}"]`)
  await expect(usage).toBeVisible()
  await expect(dayCells).toHaveCount(30)
  await expect(usage).toHaveAttribute("aria-label", /Token usage over the last 30 days/)
  await expect.poll(async () => (await usage.boundingBox())?.height ?? 0).toBe(42)
  await expect.poll(async () => (await usage.boundingBox())?.width ?? 0).toBe(147)
  const cellGeometry = await dayCells.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height, x: Math.round(box.x), y: Math.round(box.y) }
  }))
  expect(cellGeometry.every((box) => box.width === 12 && box.height === 12)).toBe(true)
  expect(new Set(cellGeometry.map((box) => box.x)).size).toBe(10)
  expect(new Set(cellGeometry.map((box) => box.y)).size).toBe(3)
  await expect(usage.locator('[style*="height"]')).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Open token usage details" })).toHaveCount(0)
  const botCard = usage.locator('xpath=ancestor::*[@data-slot="card"]')
  await expect.poll(async () => (await botCard.boundingBox())?.height ?? 0)
    .toBeLessThanOrEqual(80)
  const [usageBox, botMetaBox] = await Promise.all([
    usage.boundingBox(),
    botCard.getByTestId(tid.botCardModel).boundingBox(),
  ])
  expect(usageBox).not.toBeNull()
  expect(botMetaBox).not.toBeNull()
  expect(usageBox!.x).toBeGreaterThan(botMetaBox!.x + botMetaBox!.width)
  await expect(page.locator(
    `[data-testid^="${tid.botUsageDay("bot_pi", "")}"]`,
  )).toHaveCount(30)
  await expect(page.getByText("Token usage not supported")).toHaveCount(0)
  await expect(page.getByTestId(tid.botUsage("bot_cursor"))).toHaveCount(0)
  await expect(page.getByTestId(tid.botUsageTrigger("bot_cursor"))).toHaveCount(0)
  await expect(page.locator(
    `[data-testid^="${tid.botUsageDay("bot_claude", "")}"]`,
  )).toHaveCount(30)
  const quota = page.getByTestId(tid.machineQuota(machine.id))
  await expect(quota).toHaveCount(1)
  await expect(quota).toContainText("Quota · Spark · 18% left · 3 limits")

  await expect(page.getByTestId(tid.botUsageDay("bot_codex", "2026-08-24")))
    .toHaveClass(/bg-muted-foreground\/15/)
  await expect(page.getByTestId(tid.botUsageDay("bot_codex", "2026-08-26")))
    .toHaveClass(/bg-status-online\/30/)
  await expect(page.getByTestId(tid.botUsageDay("bot_codex", "2026-08-27")))
    .toHaveClass(/bg-status-online\/55/)
  await expect(page.getByTestId(tid.botUsageDay("bot_codex", "2026-08-28")))
    .toHaveClass(/bg-status-online\/80/)
  expect((await page.getByTestId(
    tid.botUsageDay("bot_codex", "2026-08-29"),
  ).getAttribute("class"))?.split(/\s+/)).toContain("bg-status-online")

  const usageDay = page.getByTestId(tid.botUsageDay("bot_codex", "2026-08-26"))
  await expectNoHorizontalOverflow(page)
  await attachScreenshot(page, testInfo, "my-bots-token-heatmap-pc")
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" })
  await expectDarkTheme(page, true)
  await attachScreenshot(page, testInfo, "my-bots-token-heatmap-pc-dark")
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" })
  await expectDarkTheme(page, false)
  await usageDay.hover()
  const tooltip = page.locator('[data-slot="tooltip-content"]:visible')
  await expect(tooltip).toContainText("Aug 26")
  await expect(tooltip).toContainText("Input6,000,000")
  await expect(tooltip).toContainText("Output3,000,000")
  await expect(tooltip).toContainText("CacheUnavailable")
  await expect(tooltip).toHaveCSS("opacity", "1")
  await attachScreenshot(page, testInfo, "my-bots-token-heatmap-pc-hover")

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

  await quota.click()
  await expect(quota).toHaveAttribute("aria-expanded", "false")
  await expect(quotaDetail).toBeHidden()
  await page.mouse.move(1, 1)

  await page.setViewportSize({ width: 639, height: 844 })
  await page.waitForTimeout(300)
  await expectNoHorizontalOverflow(page)
  await expect(usage).toBeVisible()
  await expect(dayCells).toHaveCount(30)
  await expect.poll(async () => (await usage.boundingBox())?.height ?? 0).toBe(42)
  await expect.poll(async () => (await usage.boundingBox())?.width ?? 0).toBe(147)
  const narrowBoundaryTrigger = page.getByTestId(tid.botUsageTrigger("bot_codex"))
  await expect(narrowBoundaryTrigger).toBeVisible()
  await expect.poll(async () => (await narrowBoundaryTrigger.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44)
  await narrowBoundaryTrigger.click()
  const narrowBoundaryDialog = page.getByTestId(tid.botUsageDialog("bot_codex"))
  await expect(narrowBoundaryDialog).toBeVisible()
  await expect(page.getByTestId(tid.botUsageDialogDay("bot_codex", "2026-08-30")))
    .toHaveAttribute("aria-pressed", "true")
  await page.getByRole("button", { name: "Close" }).click()
  await expect(narrowBoundaryDialog).toBeHidden()
  const [narrowBoundaryUsageBox, narrowBoundaryMetaBox] = await Promise.all([
    usage.boundingBox(),
    botCard.getByTestId(tid.botCardModel).boundingBox(),
  ])
  expect(narrowBoundaryUsageBox).not.toBeNull()
  expect(narrowBoundaryMetaBox).not.toBeNull()
  const narrowBoundaryBoxesOverlap = !(
    narrowBoundaryUsageBox!.x + narrowBoundaryUsageBox!.width <= narrowBoundaryMetaBox!.x
    || narrowBoundaryMetaBox!.x + narrowBoundaryMetaBox!.width <= narrowBoundaryUsageBox!.x
    || narrowBoundaryUsageBox!.y + narrowBoundaryUsageBox!.height <= narrowBoundaryMetaBox!.y
    || narrowBoundaryMetaBox!.y + narrowBoundaryMetaBox!.height <= narrowBoundaryUsageBox!.y
  )
  expect(narrowBoundaryBoxesOverlap).toBe(false)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  await expectNoHorizontalOverflow(page)
  await expect(usage).toBeVisible()
  await expect(dayCells).toHaveCount(30)
  await expect.poll(async () => (await usage.boundingBox())?.height ?? 0).toBe(42)
  await expect.poll(async () => (await usage.boundingBox())?.width ?? 0).toBe(147)
  const mobileTrigger = page.getByTestId(tid.botUsageTrigger("bot_codex"))
  await expect(mobileTrigger).toBeVisible()
  await expect.poll(async () => (await mobileTrigger.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44)
  const [mobileUsageBox, mobileMetaBox] = await Promise.all([
    usage.boundingBox(),
    botCard.getByTestId(tid.botCardModel).boundingBox(),
  ])
  expect(mobileUsageBox).not.toBeNull()
  expect(mobileMetaBox).not.toBeNull()
  expect(mobileUsageBox!.y).toBeGreaterThan(mobileMetaBox!.y + mobileMetaBox!.height)
  await attachScreenshot(page, testInfo, "my-bots-token-heatmap-mobile")
  await mobileTrigger.click()
  const usageDialog = page.getByTestId(tid.botUsageDialog("bot_codex"))
  const dateRail = page.getByTestId(tid.botUsageDateRail("bot_codex"))
  const newestDay = page.getByTestId(tid.botUsageDialogDay("bot_codex", "2026-08-30"))
  const selectedDay = page.getByTestId(tid.botUsageDialogDay("bot_codex", "2026-08-26"))
  const dialogSummary = page.getByTestId(tid.botUsageDialogSummary("bot_codex"))
  await expect(usageDialog).toBeVisible()
  await expect(dateRail.locator("button").first()).toHaveAttribute(
    "data-testid",
    tid.botUsageDialogDay("bot_codex", "2026-08-30"),
  )
  expect(await dateRail.evaluate((element) => element.scrollLeft)).toBe(0)
  await expect(newestDay).toHaveAttribute("aria-pressed", "true")
  await expect(dialogSummary).toContainText("TotalUnavailable")
  expect(await dateRail.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  await attachScreenshot(page, testInfo, "my-bots-token-heatmap-mobile-dialog")
  await selectedDay.click()
  await expect(selectedDay).toHaveAttribute("aria-pressed", "true")
  await expect(newestDay).toHaveAttribute("aria-pressed", "false")
  await expect(dialogSummary).toContainText("Aug 26")
  await expect(dialogSummary).toContainText("Total9,000,000")
  await expect(dialogSummary).toContainText("Input6,000,000")
  await expect(dialogSummary).toContainText("Output3,000,000")
  await expect(dialogSummary).toContainText("CacheUnavailable")
  await newestDay.click()
  await expect(newestDay).toHaveAttribute("aria-pressed", "true")
  const lightDialogBackground = await usageDialog.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" })
  await expectDarkTheme(page, true)
  await expect.poll(() => usageDialog.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).not.toBe(lightDialogBackground)
  await attachScreenshot(page, testInfo, "my-bots-token-heatmap-mobile-dialog-dark")
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" })
  await expectDarkTheme(page, false)
  await page.getByRole("button", { name: "Close" }).click()
  await expect(usageDialog).toBeHidden()

  await page.setViewportSize({ width: 640, height: 844 })
  await expect(page.getByTestId(tid.botUsageTrigger("bot_codex"))).toHaveCount(0)
  await expect(dayCells).toHaveCount(30)
  await expect.poll(async () => (await usage.boundingBox())?.height ?? 0).toBe(42)
  const desktopBoundaryDay = page.getByTestId(tid.botUsageDay("bot_codex", "2026-08-26"))
  await desktopBoundaryDay.hover()
  await expect(page.locator('[data-slot="tooltip-content"]:visible')).toContainText("Input6,000,000")
  expect(writeRequests).toEqual([])
})

test("My Bots renders Pi usage through real D1 and the unmocked bots API", async ({ asUser }, testInfo) => {
  const ownerId = userId("alice")
  let machineId: string | undefined
  let botId: string | undefined
  try {
    const pairResponse = await postAsAlice("/api/community/machines/pair")
    expect(pairResponse.ok).toBe(true)
    const { tokenId } = await pairResponse.json() as { tokenId: string }

    const activateResponse = await fetch(`${WEB_URL}/api/community/daemon/activate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenId}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hostname: "real-d1-timezone-e2e",
        platform: "linux",
        arch: "x64",
        osRelease: "e2e",
        daemonVersion: "0.1.26",
        runtimeReport: [{ id: "pi", status: "healthy" }],
      }),
    })
    expect(activateResponse.ok).toBe(true)
    machineId = ((await activateResponse.json()) as { machineId: string }).machineId

    const createResponse = await postAsAlice("/api/community/bots", {
      name: `Local Day ${randomUUID().slice(0, 8)}`,
      description: "real Pi D1 usage projection evidence",
      machineId,
      runtime: "pi",
    })
    expect(createResponse.status).toBe(201)
    botId = ((await createResponse.json()) as { bot: { id: string } }).bot.id

    const timeZone = "Asia/Shanghai"
    const today = dayKeyInTimeZone(new Date(), timeZone)
    const expectedDays = Array.from(
      { length: 30 },
      (_, index) => calendarDayKeyDaysAgo(today, 29 - index),
    )
    const updatedAt = new Date().toISOString()
    executeLocalD1([
      `UPDATE community_machine SET time_zone = ${sqlLiteral(timeZone)} WHERE id = ${sqlLiteral(machineId)}`,
      ...expectedDays.map((day, index) => `
        INSERT INTO community_bot_daily_token_usage (
          bot_id, day, input_tokens, output_tokens, cache_tokens, updated_at
        ) VALUES (
          ${sqlLiteral(botId!)}, ${sqlLiteral(day)}, ${100 + index}, ${10 + index}, ${1000 + index}, ${sqlLiteral(updatedAt)}
        )
      `),
    ].join(";"))

    const d1Evidence = executeLocalD1<{
      time_zone: string
      day: string
      input_tokens: number
      output_tokens: number
      cache_tokens: number
    }>(`
      SELECT m.time_zone, u.day, u.input_tokens, u.output_tokens, u.cache_tokens
      FROM community_machine m
      JOIN community_bot_binding b ON b.machine_id = m.id
      JOIN community_bot_daily_token_usage u ON u.bot_id = b.user_id
      WHERE m.id = ${sqlLiteral(machineId)} AND b.user_id = ${sqlLiteral(botId)}
      ORDER BY u.day
    `)[0]!.results
    expect(d1Evidence.map((row) => row.day)).toEqual(expectedDays)
    expect(d1Evidence.every((row) => row.time_zone === timeZone)).toBe(true)
    const d1EvidencePath = testInfo.outputPath("real-pi-d1-token-usage.json")
    writeFileSync(d1EvidencePath, `${JSON.stringify(d1Evidence, null, 2)}\n`)
    await testInfo.attach("real-pi-d1-token-usage.json", { path: d1EvidencePath })

    const apiResponse = await fetch(`${WEB_URL}/api/community/bots`, {
      headers: { Cookie: sessionCookie("alice"), Origin: WEB_URL },
    })
    expect(apiResponse.ok).toBe(true)
    const apiBody = await apiResponse.json() as {
      bots: Array<{
        id: string
        usage: {
          capability: string
          days: Array<{
            day: string
            period: string
            metrics: { input: number | null; output: number | null; cache: number | null }
          }>
        }
      }>
    }
    const apiBot = apiBody.bots.find((bot) => bot.id === botId)
    expect(apiBot).toMatchObject({ id: botId })
    expect(apiBot?.usage.capability).toBe("supported")
    expect(apiBot?.usage.days.map((day) => day.day)).toEqual(expectedDays)
    expect(apiBot?.usage.days.at(-1)).toEqual({
      day: today,
      period: "in_progress",
      metrics: { input: 129, output: 39, cache: 1029 },
    })
    const apiEvidencePath = testInfo.outputPath("real-pi-bots-api-response.json")
    writeFileSync(apiEvidencePath, `${JSON.stringify(apiBot, null, 2)}\n`)
    await testInfo.attach("real-pi-bots-api-response.json", { path: apiEvidencePath })

    const { page } = await asUser("alice", { hasTouch: true })
    await page.setViewportSize({ width: 639, height: 844 })
    const browserApiResponse = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/api/community/bots",
    )
    await gotoAfterUserWsAuth(page, "/c/me/bots")
    expect((await browserApiResponse).ok()).toBe(true)

    const usage = page.getByTestId(tid.botUsage(botId))
    await expect(usage).toBeVisible()
    const visibleDayTargets = page.locator(
      `[data-testid^="${tid.botUsageDay(botId, "")}"]:visible`,
    )
    await expect(visibleDayTargets).toHaveCount(30)
    const visibleDayTestIds = await visibleDayTargets.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-testid")),
    )
    expect(visibleDayTestIds).toEqual(expectedDays.map((day) => tid.botUsageDay(botId!, day)))
    const todayTarget = page.locator(
      `[data-testid="${tid.botUsageDay(botId, today)}"]:visible`,
    )
    await expect(todayTarget).toBeVisible()
    await page.getByTestId(tid.botUsageTrigger(botId)).click()
    const todayButton = page.getByTestId(tid.botUsageDialogDay(botId, today))
    const todaySummary = page.getByTestId(tid.botUsageDialogSummary(botId))
    await expect(todayButton).toHaveAttribute("aria-pressed", "true")
    await expect(todaySummary).toContainText("Input129")
    await expect(todaySummary).toContainText("Output39")
    await expect(todaySummary).toContainText("Cache1,029")
    const browserEvidencePath = testInfo.outputPath("real-pi-browser-observation.json")
    writeFileSync(browserEvidencePath, `${JSON.stringify({
      route: "/c/me/bots",
      botId,
      visibleDayTestIds,
      today,
      todaySummary: await todaySummary.innerText(),
    }, null, 2)}\n`)
    await testInfo.attach("real-pi-browser-observation.json", { path: browserEvidencePath })
    await attachScreenshot(page, testInfo, "real-pi-d1-local-today")
  } finally {
    if (botId || machineId) {
      executeLocalD1([
        botId ? `DELETE FROM community_bot_daily_token_usage WHERE bot_id = ${sqlLiteral(botId)}` : "",
        botId ? `DELETE FROM community_bot_binding WHERE user_id = ${sqlLiteral(botId)}` : "",
        botId ? `DELETE FROM \"user\" WHERE id = ${sqlLiteral(botId)}` : "",
        machineId ? `DELETE FROM community_machine_credential WHERE machine_id = ${sqlLiteral(machineId)}` : "",
        `DELETE FROM community_machine_token WHERE user_id = ${sqlLiteral(ownerId)}`,
        machineId ? `DELETE FROM community_machine WHERE id = ${sqlLiteral(machineId)}` : "",
      ].filter(Boolean).join(";"))
    }
  }
})
