import { expect, type Page } from "@playwright/test"
import type { CommunityDocumentSeed } from "@/lib/community/document-seed"
import { tid } from "./testids"

export function readCommunityDocumentSeedFromHtml(html: string): CommunityDocumentSeed {
  const flight = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g)]
    .map(match => JSON.parse(match[1]) as string).join("")
  const seedKey = '"initialSeed":'
  const seedKeyIndex = flight.indexOf(`${seedKey}{`)
  expect(seedKeyIndex).toBeGreaterThanOrEqual(0)
  const seedStart = seedKeyIndex + seedKey.length
  let depth = 0
  let quoted = false
  let escaped = false
  let seedEnd = seedStart
  for (; seedEnd < flight.length; seedEnd += 1) {
    const char = flight[seedEnd]
    if (escaped) { escaped = false; continue }
    if (quoted && char === "\\") { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (!quoted && char === "{") depth += 1
    if (!quoted && char === "}" && --depth === 0) { seedEnd += 1; break }
  }
  return JSON.parse(flight.slice(seedStart, seedEnd)) as CommunityDocumentSeed
}

export async function expectUniqueSsrInitialFrame(page: Page) {
  return expectUniqueSsrFrame(page, `[data-testid="${tid.initialFrame}"]`, "initial")
}

export async function expectUniqueSsrCommunityFrame(page: Page) {
  return expectUniqueSsrFrame(page, `[data-testid="${tid.initialFrame}"], [data-slot="community-shell-root"]`)
}

async function expectUniqueSsrFrame(page: Page, selector: string, kind: "initial" | "community" = "community") {
  const frames = page.locator(selector)
  const visibleFrame = frames.filter({ visible: true })
  const readState = () => page.evaluate((selector) => ({
    readyState: document.readyState,
    nodes: Array.from(document.querySelectorAll(selector)).map((element) => {
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
  }), selector)
  let state: Awaited<ReturnType<typeof readState>> | undefined
  await expect.poll(async () => {
    state = await readState()
    return state.nodes.filter((node) => node.visible).length
  }).toBeGreaterThan(0)
  expect(
    state!.nodes.filter((node) => node.visible).length,
    kind === "initial" ? "SSR must have exactly one visible initial frame" : "SSR must have exactly one visible SSR frame",
  ).toBe(1)
  expect(
    state!.nodes.filter((node) => !node.visible && (node.streamId === null || node.streamDisplay !== "none")),
    `Unexpected hidden SSR ${kind === "initial" ? "initial " : ""}frame: ${JSON.stringify(state)}`,
  ).toEqual([])
  await expect(visibleFrame).toBeVisible()
  return visibleFrame
}
