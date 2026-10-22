import { createRequire } from "node:module"
import { resolve } from "node:path"
import { expect, type Page } from "@playwright/test"
import type { CommunityDocumentSeed } from "@/lib/community/document-seed"
import { tid } from "./testids"

const nodeRequire = createRequire(resolve(__dirname, "community-ssr-frame.ts"))

export async function readCommunityDocumentSeedFromHtml(html: string): Promise<CommunityDocumentSeed> {
  const flight = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g)]
    .map(match => JSON.parse(match[1]) as string).join("")
  const bytes = new TextEncoder().encode(flight)
  const decoder = new TextDecoder()
  const data: Uint8Array[] = []
  let seed: unknown
  const findSeed = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return undefined
    if (Object.hasOwn(value, "initialSeed")) return (value as { initialSeed: unknown }).initialSeed
    for (const child of Object.values(value)) {
      const result = findSeed(child)
      if (result !== undefined) return result
    }
  }
  for (let offset = 0; offset < bytes.length;) {
    const start = offset
    const colon = bytes.indexOf(58, offset)
    expect(colon, "Flight record must have a separator").toBeGreaterThanOrEqual(offset)
    const id = decoder.decode(bytes.subarray(offset, colon))
    const payload = colon + 1
    const tag = String.fromCharCode(bytes[payload])
    expect(id).toMatch(tag === "H" ? /^[0-9a-f]*$/ : /^[0-9a-f]+$/)
    const sized = "TAOobUSsLlGgMmV".includes(tag)
    let end: number
    if (sized) {
      const comma = bytes.indexOf(44, payload + 1)
      expect(comma, "Flight length must end with a comma").toBeGreaterThan(payload + 1)
      const length = decoder.decode(bytes.subarray(payload + 1, comma))
      expect(length).toMatch(/^[0-9a-f]+$/)
      end = comma + 1 + Number.parseInt(length, 16)
      expect(end).toBeLessThanOrEqual(bytes.length)
    } else {
      const newline = bytes.indexOf(10, payload)
      expect(newline, "Flight line must be complete").toBeGreaterThanOrEqual(payload)
      end = newline + 1
    }
    const model = !sized && !/^[A-Z#rx]$/.test(tag)
    if (model) {
      const value: unknown = JSON.parse(decoder.decode(bytes.subarray(payload, end - 1)))
      if (seed === undefined) seed = findSeed(value)
    }
    if (id !== "0" && (sized || model || tag === "E")) data.push(bytes.subarray(start, end))
    offset = end
  }
  expect(seed, "Document must contain initialSeed").not.toBeUndefined()
  const { createFromReadableStream } = nodeRequire("next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.edge.production.js") as {
    createFromReadableStream<T>(stream: ReadableStream<Uint8Array>, options: { serverConsumerManifest: { moduleMap: object; serverModuleMap: object; moduleLoading: null } }): Promise<T>
  }
  const decoded = await createFromReadableStream<CommunityDocumentSeed>(new ReadableStream<Uint8Array>({
    start(controller) {
      const root = new TextEncoder().encode(`0:${JSON.stringify(seed)}\n`)
      const projected = new Uint8Array(root.length + data.reduce((size, record) => size + record.length, 0))
      projected.set(root)
      let offset = root.length
      for (const record of data) { projected.set(record, offset); offset += record.length }
      controller.enqueue(projected)
      controller.close()
    },
  }), { serverConsumerManifest: { moduleMap: {}, serverModuleMap: {}, moduleLoading: null } })
  expect(decoded, "Document seed must be resolved").toMatchObject({ viewerId: expect.any(String), entries: expect.any(Array) })
  return decoded
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
