import type { Page, TestInfo } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { composerEditable, gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import { renameUser, seedChannel, seedJoinServer, seedMessage, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

const VIEWPORT_WIDTHS = [320, 390, 639, 640, 1280] as const
const LONG_TYPING_NAME = `Typing ${"occupancy ".repeat(8)}edge`

type Rect = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
  center: number
}

type RailMetrics = {
  layout: string | null
  rail: Rect | null
  scroller: Rect & { clientHeight: number; scrollTop: number }
  composer: Rect
  typing: Rect | null
  center: Rect | null
  finalMessage: Rect | null
  contentPaddingBottom: number
  documentClientWidth: number
  documentScrollWidth: number
  typingText: {
    clientWidth: number
    scrollWidth: number
    overflowX: string
    textOverflow: string
    whiteSpace: string
  } | null
  selectionTypingFit: {
    state: string | null
    slotWidth: number
    pillWidth: number
    visibility: string
  } | null
}

async function railMetrics(page: Page, finalMessageId?: string): Promise<RailMetrics> {
  const composer = page.getByTestId(tid.channelComposerShell)
  return page.evaluate((ids) => {
    const find = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`)
    const rail = find(ids.rail)
    const typing = find(ids.typing)
    const selectionTypingSlot = document.querySelector<HTMLElement>("[data-selection-typing-fit]")
    const selectionTypingPill = selectionTypingSlot?.firstElementChild as HTMLElement | null
    const center = find(ids.scroll) ?? find(ids.selection)
    const scroller = find(ids.scroller)!
    const content = document.querySelector<HTMLElement>("[data-message-list-content]")!
    const finalMessage = ids.finalMessage ? find(ids.finalMessage) : null
    const typingText = typing?.querySelector<HTMLElement>("span.min-w-0.truncate") ?? null
    const style = typingText ? getComputedStyle(typingText) : null
    const typingStyle = typing ? getComputedStyle(typing) : null
    const typingVisible = !!typing && typingStyle?.visibility !== "hidden"
    const toRect = (value: DOMRect) => ({
      left: value.left,
      top: value.top,
      right: value.right,
      bottom: value.bottom,
      width: value.width,
      height: value.height,
      center: value.left + value.width / 2,
    })
    return {
      layout: rail?.dataset.layout ?? null,
      rail: rail ? toRect(rail.getBoundingClientRect()) : null,
      scroller: {
        ...toRect(scroller.getBoundingClientRect()),
        clientHeight: scroller.clientHeight,
        scrollTop: scroller.scrollTop,
      },
      composer: toRect(find(ids.composer)!.getBoundingClientRect()),
      typing: typingVisible ? toRect(typing.getBoundingClientRect()) : null,
      center: center ? toRect(center.getBoundingClientRect()) : null,
      finalMessage: finalMessage ? toRect(finalMessage.getBoundingClientRect()) : null,
      contentPaddingBottom: Number.parseFloat(getComputedStyle(content).paddingBottom),
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
      selectionTypingFit: selectionTypingSlot && selectionTypingPill
        ? {
          state: selectionTypingSlot.dataset.selectionTypingFit ?? null,
          slotWidth: selectionTypingSlot.getBoundingClientRect().width,
          pillWidth: selectionTypingPill.getBoundingClientRect().width,
          visibility: getComputedStyle(selectionTypingPill).visibility,
        }
        : null,
    }
  }, {
    rail: tid.composerAccessoryRail,
    typing: tid.typingIndicator,
    scroll: tid.scrollToPresent,
    selection: tid.messageSelectionToolbar,
    scroller: tid.messageScroller,
    composer: tid.channelComposerShell,
    finalMessage: finalMessageId ? tid.message(finalMessageId) : null,
  }).then(async (metrics) => {
    await expect(composer).toBeVisible()
    return metrics
  })
}

async function settledRailMetrics(page: Page, finalMessageId?: string): Promise<RailMetrics> {
  let previous = ""
  let settled: RailMetrics | null = null
  await expect.poll(async () => {
    const current = await railMetrics(page, finalMessageId)
    const signature = JSON.stringify(current)
    const stable = signature === previous
    previous = signature
    if (stable) settled = current
    return stable
  }, { timeout: 10_000 }).toBe(true)
  return settled!
}

function expectContained(metrics: RailMetrics, state: string, width: number): void {
  const evidence = `${state}@${width}: ${JSON.stringify(metrics)}`
  expect(metrics.documentScrollWidth, evidence).toBe(metrics.documentClientWidth)
  for (const control of [metrics.typing, metrics.center]) {
    if (!control || control.width === 0) continue
    expect(control.left, evidence).toBeGreaterThanOrEqual(-0.5)
    expect(control.right, evidence).toBeLessThanOrEqual(metrics.documentClientWidth + 0.5)
  }
  if (metrics.rail && metrics.center) {
    expect(metrics.center.left, evidence).toBeGreaterThanOrEqual(metrics.rail.left - 0.5)
    expect(metrics.center.right, evidence).toBeLessThanOrEqual(metrics.rail.right + 0.5)
  }
}

function expectStableScrollerViewport(before: RailMetrics, after: RailMetrics): void {
  for (const key of ["left", "top", "right", "bottom", "width", "height", "clientHeight"] as const) {
    expect(after.scroller[key], `${key}: ${JSON.stringify({ before, after })}`)
      .toBe(before.scroller[key])
  }
}

function expectCheckpoint(
  metrics: RailMetrics,
  state: string,
  width: number,
  selection: boolean,
  typing: boolean,
): void {
  const evidence = `${state}@${width}: ${JSON.stringify(metrics)}`
  const expectedGap = width < 640 ? 8 : 16
  expect(metrics.contentPaddingBottom, evidence).toBe(width < 640 ? 56 : 72)
  expect(metrics.scroller.bottom, evidence).toBeLessThanOrEqual(metrics.composer.top + 1)
  if (metrics.typing?.width) {
    expect(metrics.typing.height, `typing ${evidence}`).toBe(32)
    expect(metrics.rail, evidence).not.toBeNull()
    expect(metrics.typing.top, evidence).toBeGreaterThanOrEqual(metrics.rail!.top - 1)
    expect(metrics.typing.bottom, evidence).toBeLessThanOrEqual(metrics.rail!.bottom + 1)
  }
  if (metrics.center?.width) {
    expect(metrics.rail, evidence).not.toBeNull()
    expect(Math.abs(metrics.scroller.bottom - metrics.center.bottom - expectedGap), evidence)
      .toBeLessThanOrEqual(1)
    expect(metrics.rail!.bottom, evidence).toBeLessThanOrEqual(metrics.scroller.bottom + 1)
    expect(metrics.center.bottom, evidence).toBeLessThanOrEqual(metrics.scroller.bottom + 1)
    if (!selection) {
      expect(metrics.center.height, `scroll ${evidence}`).toBe(32)
    } else if (width < 640) {
      expect(metrics.center.height, `selection ${evidence}`).toBe(40)
    } else {
      expect(metrics.center.height, `selection ${evidence}`).toBe(38)
    }
  }
  const controls = [metrics.typing, metrics.center].filter(
    (control): control is Rect => !!control && control.width > 0,
  )
  if (metrics.finalMessage && controls.length > 0 && (selection || (typing && !metrics.center))) {
    const highestControlTop = Math.min(...controls.map((control) => control.top))
    expect(highestControlTop - metrics.finalMessage.bottom, evidence)
      .toBeGreaterThanOrEqual(expectedGap - 1)
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
  themeEvidence?: boolean
  widths?: readonly number[]
  finalMessageId?: string
}): Promise<Record<number, RailMetrics>> {
  const {
    page,
    testInfo,
    state,
    layout,
    center,
    typing,
    selection = false,
    themeEvidence = false,
    widths = VIEWPORT_WIDTHS,
    finalMessageId,
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
    await expect(rail).toHaveCount(center || typing ? 1 : 0)
    if (center || typing) await expect(rail).toHaveAttribute("data-layout", layout!)
    await expect(page.getByTestId(tid.typingIndicator)).toHaveCount(typing ? 1 : 0)
    if (typing && !selection) await expect(page.getByTestId(tid.typingIndicator)).toBeVisible()
    if (typing && selection) {
      await expect(page.locator("[data-selection-typing-fit]"))
        .toHaveAttribute("data-selection-typing-fit", /^(visible|hidden)$/)
    }
    await expect(page.getByTestId(tid.messageSelectionToolbar)).toHaveCount(selection ? 1 : 0)
    if (selection) {
      await expect.poll(() => page.getByTestId(tid.messageSelectionToolbar).evaluate(
        (element) => element.getBoundingClientRect().height,
      )).toBe(width < 640 ? 40 : 38)
    }
    if (!center || selection) {
      await scrollRoot.evaluate((element) => {
        element.scrollTop = element.scrollHeight
        element.dispatchEvent(new Event("scroll"))
      })
    }
    const metrics = await settledRailMetrics(page, finalMessageId)
    expectContained(metrics, state, width)
    expectCheckpoint(metrics, state, width, selection, metrics.typing !== null)
    if (selection && typing) {
      const fit = metrics.selectionTypingFit
      expect(fit, `${state}@${width}`).not.toBeNull()
      const shouldFit = fit!.pillWidth <= fit!.slotWidth
      expect(fit!.state, `${state}@${width}: ${JSON.stringify(fit)}`)
        .toBe(shouldFit ? "visible" : "hidden")
      expect(fit!.visibility, `${state}@${width}: ${JSON.stringify(fit)}`)
        .toBe(shouldFit ? "visible" : "hidden")
      expect(metrics.typing === null, `${state}@${width}: ${JSON.stringify(fit)}`)
        .toBe(!shouldFit)
      if (shouldFit) {
        expect(metrics.typingText!.scrollWidth, `${state}@${width}: ${JSON.stringify(metrics)}`)
          .toBeLessThanOrEqual(metrics.typingText!.clientWidth)
      }
    }
    if (center) {
      expect(metrics.center, `${state}@${width}`).not.toBeNull()
      expect(Math.abs(metrics.center!.center - metrics.composer.center), `${state}@${width}`)
        .toBeLessThanOrEqual(1)
    }
    evidence[width] = metrics
    if (themeEvidence) {
      await page.emulateMedia({ colorScheme: "light" })
      await expect(page.locator("html")).not.toHaveClass(/dark/)
      await expectCancelForeground(page, "light")
    }
    await testInfo.attach(`${width}-${state}${themeEvidence ? "-light" : ""}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    })
    if (themeEvidence) {
      await page.emulateMedia({ colorScheme: "dark" })
      await expect(page.locator("html")).toHaveClass(/dark/)
      await expectCancelForeground(page, "dark")
      await testInfo.attach(`${width}-${state}-dark.png`, {
        body: await page.screenshot(),
        contentType: "image/png",
      })
      await page.emulateMedia({ colorScheme: "light" })
      await expect(page.locator("html")).not.toHaveClass(/dark/)
    }
  }
  return evidence
}

async function expectCancelForeground(page: Page, theme: "light" | "dark"): Promise<void> {
  const colors = await page.getByRole("button", { name: "Cancel message selection" }).evaluate((button) => {
    const icon = button.querySelector("svg")!
    const label = button.querySelector("span")!
    return {
      button: getComputedStyle(button).color,
      icon: getComputedStyle(icon).color,
      label: getComputedStyle(label).color,
      body: getComputedStyle(document.body).color,
    }
  })
  expect(colors.icon, `${theme}: ${JSON.stringify(colors)}`).toBe(colors.body)
  expect(colors.label, `${theme}: ${JSON.stringify(colors)}`).toBe(colors.body)
  if (theme === "dark") expect(colors.label).not.toBe("rgb(0, 0, 0)")
}

async function captureEmptyState(
  page: Page,
  testInfo: TestInfo,
  finalMessageId: string,
): Promise<void> {
  for (const width of VIEWPORT_WIDTHS) {
    await page.setViewportSize({ width, height: 844 })
    await page.getByTestId(tid.messageScroller).evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event("scroll"))
    })
    await expect(page.getByTestId(tid.scrollToPresent)).toHaveCount(0)
    await expect(page.getByTestId(tid.composerAccessoryRail)).toHaveCount(0)
    await expect(page.getByTestId(tid.channelComposerShell)).toBeVisible()
    const metrics = await settledRailMetrics(page, finalMessageId)
    expect(metrics.contentPaddingBottom).toBe(width < 640 ? 56 : 72)
    expect(metrics.scroller.bottom).toBeLessThanOrEqual(metrics.composer.top + 1)
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
  await seedJoinServer("alice", "carol", serverId)
  await renameUser("bob", LONG_TYPING_NAME)
  await renameUser("carol", "Cy")
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
  const carol = await asUser("carol")
  await alice.page.setViewportSize({ width: 390, height: 844 })
  await bob.page.setViewportSize({ width: 390, height: 844 })
  await carol.page.setViewportSize({ width: 390, height: 844 })
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(alice.page, route)
  await gotoAfterUserWsAuth(bob.page, route)
  await gotoAfterUserWsAuth(carol.page, route)
  await expect(composerEditable(alice.page)).toBeVisible()
  await expect(composerEditable(bob.page)).toBeVisible()
  await expect(composerEditable(carol.page)).toBeVisible()

  const ping = `rail ws ready ${Date.now()}`
  await sendMessage(bob.page, ping)
  const finalMessage = alice.page.getByText(ping, { exact: true })
  await expect(finalMessage).toBeVisible()
  const finalMessageId = await finalMessage.evaluate((element, messageTestIdPrefix) => {
    const testId = element.closest(`[data-testid^="${messageTestIdPrefix}"]`)
      ?.getAttribute("data-testid")
    if (!testId) throw new Error("final WS message row has no test id")
    return testId.slice(messageTestIdPrefix.length)
  }, tid.message(""))

  const scrollRoot = alice.page.getByTestId(tid.messageScroller)
  await expect.poll(() => scrollRoot.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)
  await scrollRoot.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toHaveCount(0)
  await captureEmptyState(alice.page, testInfo, finalMessageId)

  let row = alice.page.getByTestId(tid.message(selectableMessageId))
  await row.hover()
  await alice.page.getByTestId(tid.messageShare(selectableMessageId)).click()
  await expect(alice.page.getByTestId(tid.messageSelectionToolbar)).toBeVisible()
  const selectionNone = await captureState({
    page: alice.page,
    testInfo,
    state: "selection-none",
    layout: "centered",
    center: true,
    typing: false,
    selection: true,
    finalMessageId,
  })
  await alice.page.getByRole("button", { name: "Cancel message selection" }).click()

  await scrollRoot.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeVisible()

  const centerOnly = await captureState({
    page: alice.page,
    testInfo,
    state: "c-only",
    layout: "centered",
    center: true,
    typing: false,
    finalMessageId,
  })

  const bobEditor = composerEditable(bob.page)
  await expect(async () => {
    await bobEditor.click()
    await bob.page.keyboard.press("ControlOrMeta+A")
    await bob.page.keyboard.press("Backspace")
    await bob.page.keyboard.type("typing occupancy")
    await expect(alice.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 4_000 })
  }).toPass({ timeout: 20_000 })

  const typingAndCenter = await captureState({
    page: alice.page,
    testInfo,
    state: "l-c",
    layout: "centered",
    center: true,
    typing: true,
    finalMessageId,
  })
  for (const width of VIEWPORT_WIDTHS) {
    expectStableScrollerViewport(centerOnly[width], typingAndCenter[width])
  }

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
    finalMessageId,
  })
  expect(leftOnly[320].typingText?.overflowX).toBe("hidden")
  expect(leftOnly[320].typingText?.textOverflow).toBe("ellipsis")
  expect(leftOnly[320].typingText?.whiteSpace).toBe("nowrap")
  expect(leftOnly[320].typingText!.scrollWidth).toBeGreaterThan(leftOnly[320].typingText!.clientWidth)

  await sendMessage(bob.page, `long typing clear ${Date.now()}`)
  await expect(alice.page.getByTestId(tid.typingIndicator)).toHaveCount(0)
  const carolEditor = composerEditable(carol.page)
  await expect(async () => {
    await carolEditor.click()
    await carol.page.keyboard.press("ControlOrMeta+A")
    await carol.page.keyboard.press("Backspace")
    await carol.page.keyboard.type("short selection typing")
    await expect(alice.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 4_000 })
  }).toPass({ timeout: 20_000 })

  row = alice.page.getByTestId(tid.message(selectableMessageId))
  await row.hover()
  await alice.page.getByTestId(tid.messageShare(selectableMessageId)).click()
  await expect(alice.page.getByTestId(tid.messageSelectionToolbar)).toBeVisible()
  const selectionShort = await captureState({
    page: alice.page,
    testInfo,
    state: "selection-short",
    layout: "centered",
    center: true,
    typing: true,
    selection: true,
    finalMessageId,
  })
  const shortFitStates = VIEWPORT_WIDTHS.map(
    (width) => selectionShort[width].selectionTypingFit?.state,
  )
  expect(shortFitStates).toContain("visible")
  expect(shortFitStates).toContain("hidden")
  for (const width of VIEWPORT_WIDTHS) {
    expect(selectionShort[width].center!.center).toBe(selectionNone[width].center!.center)
  }

  await expect(async () => {
    await bobEditor.click()
    await bob.page.keyboard.press("ControlOrMeta+A")
    await bob.page.keyboard.press("Backspace")
    await bob.page.keyboard.type("multiple selection typing")
    await expect(alice.page.getByTestId(tid.typingIndicator)).toContainText(" and ", {
      timeout: 4_000,
    })
  }).toPass({ timeout: 20_000 })
  const selectionMultiple = await captureState({
    page: alice.page,
    testInfo,
    state: "selection-multiple",
    layout: "centered",
    center: true,
    typing: true,
    selection: true,
    widths: [390, 639, 1280],
    finalMessageId,
  })
  for (const width of [390, 639, 1280] as const) {
    expect(selectionMultiple[width].center!.center).toBe(selectionNone[width].center!.center)
  }

  await sendMessage(bob.page, `multiple typing clear ${Date.now()}`)
  await sendMessage(carol.page, `short typing clear ${Date.now()}`)
  await expect(alice.page.getByTestId(tid.typingIndicator)).toHaveCount(0)
  await expect(async () => {
    await bobEditor.click()
    await bob.page.keyboard.press("ControlOrMeta+A")
    await bob.page.keyboard.press("Backspace")
    await bob.page.keyboard.type("long selection typing")
    await expect(alice.page.getByTestId(tid.typingIndicator)).toHaveCount(1, { timeout: 4_000 })
  }).toPass({ timeout: 20_000 })
  const selectionLong = await captureState({
    page: alice.page,
    testInfo,
    state: "selection-long",
    layout: "centered",
    center: true,
    typing: true,
    selection: true,
    widths: [390, 639, 640, 1280],
    finalMessageId,
  })
  for (const width of [390, 639, 640, 1280] as const) {
    expect(selectionLong[width].selectionTypingFit?.state).toBe("hidden")
    expect(selectionLong[width].typing).toBeNull()
  }

  await sendMessage(bob.page, `theme typing clear ${Date.now()}`)
  await expect(alice.page.getByTestId(tid.typingIndicator)).toHaveCount(0)
  await captureState({
    page: alice.page,
    testInfo,
    state: "selection-theme",
    layout: "centered",
    center: true,
    typing: false,
    selection: true,
    themeEvidence: true,
    widths: [1280],
    finalMessageId,
  })
  await alice.page.getByRole("button", { name: "Cancel message selection" }).click()

  await scrollRoot.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeVisible()
  const settledCenter = await captureState({
    page: alice.page,
    testInfo,
    state: "settled-center",
    layout: "centered",
    center: true,
    typing: false,
    finalMessageId,
  })
  for (const width of VIEWPORT_WIDTHS) {
    expectStableScrollerViewport(centerOnly[width], settledCenter[width])
  }

  await scrollRoot.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toHaveCount(0)
  await captureEmptyState(alice.page, testInfo, finalMessageId)

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
  let metrics = await settledRailMetrics(alice.page, finalMessageId)
  expect(Math.abs(metrics.center!.center - metrics.composer.center)).toBeLessThanOrEqual(1)
  await alice.page.setViewportSize({ width: 1280, height: 900 })
  await scrollRoot.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeVisible()
  metrics = await settledRailMetrics(alice.page, finalMessageId)
  expect(Math.abs(metrics.center!.center - metrics.composer.center)).toBeLessThanOrEqual(1)
})
