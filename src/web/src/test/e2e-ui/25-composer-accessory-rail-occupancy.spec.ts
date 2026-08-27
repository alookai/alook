import type { Page, TestInfo } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { composerEditable, gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import { renameUser, seedChannel, seedJoinServer, seedMessage, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

const MOBILE_WIDTHS = [390, 320] as const
const LONG_TYPING_NAME = `Typing ${"occupancy ".repeat(8)}edge`

type Rect = {
  left: number
  right: number
  bottom: number
  width: number
  center: number
}

type RailMetrics = {
  layout: string | null
  rail: Rect
  composer: Rect
  typing: Rect | null
  center: Rect | null
  documentClientWidth: number
  documentScrollWidth: number
  typingText: {
    clientWidth: number
    scrollWidth: number
    overflowX: string
    textOverflow: string
    whiteSpace: string
  } | null
}

async function railMetrics(page: Page): Promise<RailMetrics> {
  const rail = page.getByTestId(tid.composerAccessoryRail)
  const composer = page.getByTestId(tid.channelComposerShell)
  return rail.evaluate((element, ids) => {
    const target = element as HTMLElement
    const find = (id: string) => target.querySelector<HTMLElement>(`[data-testid='${id}']`)
    const typing = find(ids.typing)
    const center = find(ids.scroll) ?? find(ids.selection)
    const typingText = typing?.querySelector<HTMLElement>("span.min-w-0.truncate") ?? null
    const style = typingText ? getComputedStyle(typingText) : null
    const toRect = (value: DOMRect) => ({
      left: value.left,
      right: value.right,
      bottom: value.bottom,
      width: value.width,
      center: value.left + value.width / 2,
    })
    return {
      layout: target.dataset.layout ?? null,
      rail: toRect(target.getBoundingClientRect()),
      composer: toRect(document.querySelector<HTMLElement>(`[data-testid='${ids.composer}']`)!.getBoundingClientRect()),
      typing: typing ? toRect(typing.getBoundingClientRect()) : null,
      center: center ? toRect(center.getBoundingClientRect()) : null,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      typingText: typingText && style
        ? {
          clientWidth: typingText.clientWidth,
          scrollWidth: typingText.scrollWidth,
          overflowX: style.overflowX,
          textOverflow: style.textOverflow,
          whiteSpace: style.whiteSpace,
        }
        : null,
    }
  }, {
    typing: tid.typingIndicator,
    scroll: tid.scrollToPresent,
    selection: tid.messageSelectionToolbar,
    composer: tid.channelComposerShell,
  }).then(async (metrics) => {
    await expect(composer).toBeVisible()
    return metrics
  })
}

function expectContained(metrics: RailMetrics, state: string, width: number): void {
  const evidence = `${state}@${width}: ${JSON.stringify(metrics)}`
  expect(metrics.documentScrollWidth, evidence).toBe(metrics.documentClientWidth)
  for (const control of [metrics.typing, metrics.center]) {
    if (!control || control.width === 0) continue
    expect(control.left, evidence).toBeGreaterThanOrEqual(metrics.rail.left - 0.5)
    expect(control.right, evidence).toBeLessThanOrEqual(metrics.rail.right + 0.5)
  }
}

async function captureState(args: {
  page: Page
  testInfo: TestInfo
  state: string
  layout: RailMetrics["layout"]
  center: boolean
  typing: boolean
  selection?: boolean
  widths?: readonly number[]
}): Promise<Record<number, RailMetrics>> {
  const {
    page,
    testInfo,
    state,
    layout,
    center,
    typing,
    selection = false,
    widths = MOBILE_WIDTHS,
  } = args
  const evidence: Record<number, RailMetrics> = {}
  for (const width of widths) {
    await page.setViewportSize({ width, height: width >= 768 ? 900 : 844 })
    const scrollRoot = page.getByTestId(tid.messageScroller)
    await scrollRoot.evaluate((element, showScrollControl) => {
      element.scrollTop = showScrollControl ? 0 : element.scrollHeight
      element.dispatchEvent(new Event("scroll"))
    }, center && !selection)
    await expect(page.getByTestId(tid.scrollToPresent)).toHaveCount(center && !selection ? 1 : 0)
    const composer = page.getByTestId(tid.channelComposerShell)
    await expect.poll(() => composer.evaluate((element, viewportWidth) => {
      const rect = element.getBoundingClientRect()
      return viewportWidth < 640
        ? Math.abs(rect.left) <= 1 && Math.abs(rect.right - viewportWidth) <= 1
        : rect.left > 1 && Math.abs(rect.right - viewportWidth) <= 1
    }, width)).toBe(true)
    const rail = page.getByTestId(tid.composerAccessoryRail)
    await expect(rail).toHaveAttribute("data-layout", layout!)
    await expect(page.getByTestId(tid.typingIndicator)).toHaveCount(typing ? 1 : 0)
    await expect(page.getByTestId(tid.messageSelectionToolbar)).toHaveCount(selection ? 1 : 0)
    const metrics = await railMetrics(page)
    expectContained(metrics, state, width)
    if (center) {
      expect(metrics.center, `${state}@${width}`).not.toBeNull()
      expect(Math.abs(metrics.center!.center - metrics.composer.center), `${state}@${width}`)
        .toBeLessThanOrEqual(1)
    }
    evidence[width] = metrics
    await testInfo.attach(`${width}-${state}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    })
  }
  return evidence
}

async function captureEmptyState(page: Page, testInfo: TestInfo): Promise<void> {
  for (const width of MOBILE_WIDTHS) {
    await page.setViewportSize({ width, height: 844 })
    await page.getByTestId(tid.messageScroller).evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event("scroll"))
    })
    await expect(page.getByTestId(tid.scrollToPresent)).toHaveCount(0)
    await expect(page.getByTestId(tid.composerAccessoryRail)).toHaveCount(0)
    await expect(page.getByTestId(tid.channelComposerShell)).toBeVisible()
    const documentWidths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    expect(documentWidths.scroll, `empty@${width}`).toBe(documentWidths.client)
    await testInfo.attach(`${width}-empty.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    })
  }
}

test("composer accessory rail reallocates every occupied slot without overflow", async ({ asUser }, testInfo) => {
  test.setTimeout(180_000)
  const serverId = await seedServer("alice", `Rail occupancy ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "rail-occupancy")
  await seedJoinServer("alice", "bob", serverId)
  await renameUser("bob", LONG_TYPING_NAME)
  let selectableMessageId = ""
  for (let index = 0; index < 28; index++) {
    selectableMessageId = await seedMessage(
      "alice",
      channelId,
      `occupancy row ${index + 1} ${"content ".repeat(8)}`,
    )
  }

  const alice = await asUser("alice")
  const bob = await asUser("bob")
  await alice.page.setViewportSize({ width: 390, height: 844 })
  await bob.page.setViewportSize({ width: 390, height: 844 })
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(alice.page, route)
  await gotoAfterUserWsAuth(bob.page, route)
  await expect(composerEditable(alice.page)).toBeVisible()
  await expect(composerEditable(bob.page)).toBeVisible()

  const ping = `rail ws ready ${Date.now()}`
  await sendMessage(bob.page, ping)
  await expect(alice.page.getByText(ping)).toBeVisible()

  const scrollRoot = alice.page.getByTestId(tid.messageScroller)
  await expect.poll(() => scrollRoot.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)
  await scrollRoot.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toHaveCount(0)
  await captureEmptyState(alice.page, testInfo)

  let row = alice.page.getByTestId(tid.message(selectableMessageId))
  await row.hover()
  await alice.page.getByTestId(tid.messageShare(selectableMessageId)).click()
  await expect(alice.page.getByTestId(tid.messageSelectionToolbar)).toBeVisible()
  await captureState({
    page: alice.page,
    testInfo,
    state: "selection-none",
    layout: "centered",
    center: true,
    typing: false,
    selection: true,
  })
  await alice.page.getByRole("button", { name: "Cancel message selection" }).click()

  await scrollRoot.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeVisible()

  await captureState({
    page: alice.page,
    testInfo,
    state: "c-only",
    layout: "centered",
    center: true,
    typing: false,
  })

  const bobEditor = composerEditable(bob.page)
  await expect(async () => {
    await bobEditor.click()
    await bob.page.keyboard.press("ControlOrMeta+A")
    await bob.page.keyboard.press("Backspace")
    await bob.page.keyboard.type("typing occupancy")
    await expect(alice.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 4_000 })
  }).toPass({ timeout: 20_000 })

  await captureState({
    page: alice.page,
    testInfo,
    state: "l-c",
    layout: "centered",
    center: true,
    typing: true,
  })

  await alice.page.getByTestId(tid.typingIndicator).evaluate((element) => {
    element.setAttribute("data-e2e-node-identity", "typing-survived")
    element.querySelector("span > span")?.setAttribute("data-e2e-dot-identity", "dot-survived")
  })

  await alice.page.getByTestId(tid.scrollToPresent).click()
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toHaveCount(0)
  await expect(alice.page.locator("[data-e2e-node-identity='typing-survived']")).toHaveCount(1)
  await expect(alice.page.locator("[data-e2e-dot-identity='dot-survived']")).toHaveCount(1)
  const leftOnly = await captureState({
    page: alice.page,
    testInfo,
    state: "l-only",
    layout: "left-only",
    center: false,
    typing: true,
  })
  expect(leftOnly[320].typingText?.overflowX).toBe("hidden")
  expect(leftOnly[320].typingText?.textOverflow).toBe("ellipsis")
  expect(leftOnly[320].typingText?.whiteSpace).toBe("nowrap")
  expect(leftOnly[320].typingText!.scrollWidth).toBeGreaterThan(leftOnly[320].typingText!.clientWidth)

  row = alice.page.getByTestId(tid.message(selectableMessageId))
  await row.hover()
  await alice.page.getByTestId(tid.messageShare(selectableMessageId)).click()
  await expect(alice.page.getByTestId(tid.messageSelectionToolbar)).toBeVisible()
  await captureState({
    page: alice.page,
    testInfo,
    state: "selection-l",
    layout: "centered",
    center: true,
    typing: true,
    selection: true,
    widths: [390, 1280],
  })
  await alice.page.getByRole("button", { name: "Cancel message selection" }).click()

  await expect(async () => {
    await bobEditor.click()
    await bob.page.keyboard.press("ControlOrMeta+A")
    await bob.page.keyboard.press("Backspace")
    await bob.page.keyboard.type("typing occupancy settle")
    await expect(alice.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 4_000 })
  }).toPass({ timeout: 20_000 })

  await expect(alice.page.getByTestId(tid.typingIndicator)).toHaveCount(0, { timeout: 15_000 })
  await scrollRoot.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeVisible()
  await captureState({
    page: alice.page,
    testInfo,
    state: "settled-center",
    layout: "centered",
    center: true,
    typing: false,
    widths: [390, 320, 1280],
  })

  await scrollRoot.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toHaveCount(0)
  await captureEmptyState(alice.page, testInfo)

  await scrollRoot.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeVisible()
  await alice.page.setViewportSize({ width: 430, height: 844 })
  await scrollRoot.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeVisible()
  let metrics = await railMetrics(alice.page)
  expect(Math.abs(metrics.center!.center - metrics.composer.center)).toBeLessThanOrEqual(1)
  await alice.page.setViewportSize({ width: 1280, height: 900 })
  await scrollRoot.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeVisible()
  metrics = await railMetrics(alice.page)
  expect(Math.abs(metrics.center!.center - metrics.composer.center)).toBeLessThanOrEqual(1)
})
