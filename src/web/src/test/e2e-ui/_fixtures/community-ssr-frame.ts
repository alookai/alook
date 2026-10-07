import { expect, type Page } from "@playwright/test"
import { tid } from "./testids"

export async function expectUniqueSsrInitialFrame(page: Page) {
  const frames = page.getByTestId(tid.initialFrame)
  const visibleFrame = frames.filter({ visible: true })
  let visibleCount = 0
  await expect.poll(async () => {
    visibleCount = await visibleFrame.count()
    return visibleCount
  }).toBeGreaterThan(0)
  expect(
    visibleCount,
    "SSR must have exactly one visible initial frame",
  ).toBe(1)
  const hiddenState = await frames.filter({ visible: false }).evaluateAll((elements) => ({
    readyState: document.readyState,
    nodes: elements.map((element) => {
      const stream = element.parentElement?.closest('[hidden][id^="S:"]')
      return {
        routeKind: element.getAttribute("data-community-route-kind"),
        streamId: stream?.id ?? null,
        streamDisplay: stream ? getComputedStyle(stream).display : null,
      }
    }),
  }))
  expect(
    hiddenState.nodes.filter((node) => node.streamId === null || node.streamDisplay !== "none"),
    `Unexpected hidden SSR initial frame: ${JSON.stringify(hiddenState)}`,
  ).toEqual([])
  await expect(visibleFrame).toBeVisible()
  return visibleFrame
}
