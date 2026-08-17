import type { Page } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { seedChannel, seedMessage, seedServer } from "./_fixtures/seed"

type RowRect = { top: number; bottom: number; height: number }

async function messageRowRect(page: Page, messageId: string): Promise<RowRect> {
  return page.locator(`[data-msg-id="${messageId}"]`).evaluate((message) => {
    const row = message.parentElement
    if (!row?.hasAttribute("data-index")) throw new Error("virtual message row not found")
    const rect = row.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, height: rect.height }
  })
}

async function expectRowsNotToOverlap(page: Page, messageIds: string[]): Promise<void> {
  await expect.poll(async () => {
    const rows = await Promise.all(messageIds.map((messageId) => messageRowRect(page, messageId)))
    return rows.slice(1).every((row, index) => row.top >= rows[index]!.bottom - 0.5)
  }).toBe(true)
}

test("long Markdown rows stay measured and separated at iPhone width", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Mobile rows ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "mobile-rows")
  const otherChannelId = await seedChannel("alice", serverId, "other-mobile-rows")

  const longParagraph = Array.from(
    { length: 86 },
    (_, index) => `wrapped phrase ${index} with \`inline-${index}\` content`,
  ).join(" ")
  const longId = await seedMessage(
    "alice",
    channelId,
    `A narrow long paragraph with inline code.\n\n${longParagraph}`,
  )
  const codeId = await seedMessage(
    "alice",
    channelId,
    `A fenced block follows.\n\n\`\`\`ts\n${Array.from({ length: 28 }, (_, index) => `const row${index} = "${"x".repeat(48)}"`).join("\n")}\n\`\`\``,
  )
  const sentinelId = await seedMessage("alice", channelId, "message after the tall Markdown rows")
  await seedMessage("alice", otherChannelId, "other channel sentinel")

  const { page } = await asUser("alice")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/c/channels/${serverId}/${channelId}`)
  await page.waitForURL(new RegExp(channelId), { timeout: 20_000, waitUntil: "commit" })
  await expect(page.locator(`[data-msg-id="${sentinelId}"]`)).toBeVisible({ timeout: 30_000 })

  const firstMeasurement = await messageRowRect(page, longId)
  expect(firstMeasurement.height).toBeGreaterThan(400)
  await expectRowsNotToOverlap(page, [longId, codeId, sentinelId])

  const scroller = page.locator(`[data-msg-id="${sentinelId}"]`).locator("xpath=ancestor::*[contains(@class, 'overflow-y-auto')][1]")
  await expect(scroller).toHaveCount(1)
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(async () => scroller.evaluate((element) => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeLessThanOrEqual(2)
  // Let the virtualizer consume the scroll event and leave its transient
  // scrolling state before simulating delayed Markdown growth.
  await page.waitForTimeout(250)

  const beforeGrowth = await messageRowRect(page, codeId)
  await page.locator(`[data-msg-id="${codeId}"] [data-community-message-body]`).evaluate((messageBody: Element) => {
    const delayedBlock = document.createElement("div")
    delayedBlock.dataset.e2eDelayedCodeBlock = "true"
    delayedBlock.style.height = "360px"
    delayedBlock.style.margin = "0"
    delayedBlock.textContent = "delayed fenced-code expansion"
    messageBody.appendChild(delayedBlock)
  })

  await expect.poll(async () => (await messageRowRect(page, codeId)).height).toBeGreaterThan(beforeGrowth.height + 300)
  await expectRowsNotToOverlap(page, [longId, codeId, sentinelId])
  await expect.poll(async () => scroller.evaluate((element) => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeLessThanOrEqual(2)

  // A later resize must not repin somebody who has deliberately moved up to
  // read. Record every scroll sample as well as a visible row anchor so a
  // transient down-and-back yank cannot hide behind the settled position.
  await scroller.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 320)
  })
  await expect.poll(async () => scroller.evaluate((element) => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeGreaterThan(100)
  await page.waitForTimeout(250)

  const readingAnchorBefore = await messageRowRect(page, codeId)
  const readingScrollBefore = await scroller.evaluate((element) => {
    element.dataset.e2eMaxScrollTop = String(element.scrollTop)
    element.addEventListener("scroll", () => {
      const previousMax = Number(element.dataset.e2eMaxScrollTop)
      element.dataset.e2eMaxScrollTop = String(Math.max(previousMax, element.scrollTop))
    }, { passive: true })
    return {
      scrollTop: element.scrollTop,
      bottomDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
    }
  })
  expect(readingScrollBefore.bottomDistance).toBeGreaterThan(100)

  const beforeReadingGrowth = await messageRowRect(page, codeId)
  await page.locator(`[data-msg-id="${codeId}"] [data-community-message-body]`).evaluate((messageBody: Element) => {
    const secondDelayedBlock = document.createElement("div")
    secondDelayedBlock.dataset.e2eReadingGrowth = "true"
    secondDelayedBlock.style.height = "240px"
    secondDelayedBlock.style.margin = "0"
    secondDelayedBlock.textContent = "growth while reading above the bottom"
    messageBody.appendChild(secondDelayedBlock)
  })

  await expect.poll(async () => (await messageRowRect(page, codeId)).height)
    .toBeGreaterThan(beforeReadingGrowth.height + 200)
  await expectRowsNotToOverlap(page, [longId, codeId, sentinelId])
  await page.waitForTimeout(500)

  const readingAnchorAfter = await messageRowRect(page, codeId)
  const readingScrollAfter = await scroller.evaluate((element) => ({
    scrollTop: element.scrollTop,
    maxScrollTop: Number(element.dataset.e2eMaxScrollTop),
    bottomDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
  }))
  expect(readingScrollAfter.bottomDistance).toBeGreaterThan(100)
  expect(readingScrollAfter.scrollTop).toBeLessThanOrEqual(readingScrollBefore.scrollTop + 1)
  expect(readingScrollAfter.maxScrollTop).toBeLessThanOrEqual(readingScrollBefore.scrollTop + 1)
  expect(Math.abs(readingAnchorAfter.top - readingAnchorBefore.top)).toBeLessThanOrEqual(1)

  await page.goto(`/c/channels/${serverId}/${otherChannelId}`)
  await page.waitForURL(new RegExp(otherChannelId), { timeout: 20_000, waitUntil: "commit" })
  await expect(page.getByText("other channel sentinel", { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.goto(`/c/channels/${serverId}/${channelId}`)
  await page.waitForURL(new RegExp(channelId), { timeout: 20_000, waitUntil: "commit" })
  await expect(page.locator(`[data-msg-id="${sentinelId}"]`)).toBeVisible({ timeout: 30_000 })
  await expectRowsNotToOverlap(page, [longId, codeId, sentinelId])
})
