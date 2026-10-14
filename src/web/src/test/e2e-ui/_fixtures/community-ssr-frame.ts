import { expect, type Page } from "@playwright/test"
import { tid } from "./testids"

export async function expectUniqueSsrInitialFrame(page: Page) {
  const frames = page.getByTestId(tid.initialFrame)
  const visibleFrame = frames.filter({ visible: true })
  const readState = () => page.evaluate((testId) => ({
    readyState: document.readyState,
    nodes: Array.from(document.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`)).map((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const stream = element.parentElement?.closest('[hidden][id^="S:"]')
      return {
        visible: rect.width > 0 && rect.height > 0
          && style.visibility !== "hidden" && style.visibility !== "collapse",
        routeKind: element.getAttribute("data-community-route-kind"),
        streamId: stream?.id ?? null,
        streamDisplay: stream ? getComputedStyle(stream).display : null,
      }
    }),
  }), tid.initialFrame)
  let state: Awaited<ReturnType<typeof readState>> | undefined
  await expect.poll(async () => {
    state = await readState()
    return state.nodes.filter((node) => node.visible).length
  }).toBeGreaterThan(0)
  expect(
    state!.nodes.filter((node) => node.visible).length,
    "SSR must have exactly one visible initial frame",
  ).toBe(1)
  expect(
    state!.nodes.filter((node) => !node.visible && (node.streamId === null || node.streamDisplay !== "none")),
    `Unexpected hidden SSR initial frame: ${JSON.stringify(state)}`,
  ).toEqual([])
  await expect(visibleFrame).toBeVisible()
  return visibleFrame
}
