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
  await expect(page.getByTestId(tid.botUsage("bot_pi")).getByRole("listitem")).toHaveCount(7)
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
      { length: 7 },
      (_, index) => calendarDayKeyDaysAgo(today, 6 - index),
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
      metrics: { input: 106, output: 16, cache: 1006 },
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
    await expect(usage.getByRole("listitem")).toHaveCount(7)
    await usage.getByRole("button", { name: "Open token usage details" }).tap()
    const visibleDayTargets = page.locator(
      `[data-testid^="${tid.botUsageDay(botId, "")}"]:visible`,
    )
    await expect(visibleDayTargets).toHaveCount(7)
    const visibleDayTestIds = await visibleDayTargets.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-testid")),
    )
    expect(visibleDayTestIds).toEqual(expectedDays.map((day) => tid.botUsageDay(botId!, day)))
    const todayTarget = page.locator(
      `[data-testid="${tid.botUsageDay(botId, today)}"]:visible`,
    )
    await expect(todayTarget).toHaveText("Today")
    await expect(page.locator('[data-slot="popover-content"]:visible')).toContainText("Input106")
    const browserEvidencePath = testInfo.outputPath("real-pi-browser-observation.json")
    writeFileSync(browserEvidencePath, `${JSON.stringify({
      route: "/c/me/bots",
      botId,
      visibleDayTestIds,
      today,
      todayText: await todayTarget.textContent(),
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
