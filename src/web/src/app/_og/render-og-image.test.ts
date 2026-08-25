import { inflateSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  normalizeOgTitle,
  OG_TITLE_FONT_SIZE,
  OG_TITLE_LINE_CLAMP,
  OG_TITLE_MAX_HEIGHT,
  OG_TITLE_MAX_INPUT_GRAPHEMES,
  OG_TITLE_MAX_LINES,
} from "./og-title"
import { renderOgImage } from "./render-og-image"

const {
  mockAssetFetch,
  mockGetCloudflareContext,
  mockHeaders,
} = vi.hoisted(() => ({
  mockAssetFetch: vi.fn(),
  mockGetCloudflareContext: vi.fn(),
  mockHeaders: vi.fn(),
}))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mockGetCloudflareContext,
}))

vi.mock("next/headers", () => ({
  headers: mockHeaders,
}))

const LOGO_ASSET_URL = "https://assets.local/icon-192.png"
const FONT_ASSET_URL = "https://assets.local/fonts/dm-sans-600.ttf"
const officialLogo = readFileSync(new URL("../../../public/icon-192.png", import.meta.url))
const officialFont = readFileSync(new URL("../../../public/fonts/dm-sans-600.ttf", import.meta.url))

beforeEach(() => {
  mockHeaders.mockReset().mockResolvedValue(new Headers())
  mockAssetFetch.mockReset().mockImplementation(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === LOGO_ASSET_URL) return new Response(Uint8Array.from(officialLogo))
    if (url === FONT_ASSET_URL) return new Response(Uint8Array.from(officialFont))
    return new Response(null, { status: 404 })
  })
  mockGetCloudflareContext.mockReset().mockResolvedValue({
    env: { ASSETS: { fetch: mockAssetFetch } },
  })
})

type DecodedPng = {
  width: number
  height: number
  rgba: Uint8Array
}

type PixelBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
  count: number
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left
  return aboveDistance <= upperLeftDistance ? above : upperLeft
}

function decodeRgbaPng(png: Uint8Array): DecodedPng {
  expect(Buffer.from(png.subarray(0, 8))).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (offset < png.length) {
    const length = Buffer.from(png.subarray(offset, offset + 4)).readUInt32BE()
    const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString("ascii")
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      width = Buffer.from(data).readUInt32BE(0)
      height = Buffer.from(data).readUInt32BE(4)
      expect(data[8]).toBe(8)
      expect(data[9]).toBe(6)
      expect(data[12]).toBe(0)
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data))
    }
    offset += 12 + length
    if (type === "IEND") break
  }

  const bytesPerPixel = 4
  const rowLength = width * bytesPerPixel
  const filtered = inflateSync(Buffer.concat(idat))
  expect(filtered).toHaveLength((rowLength + 1) * height)
  const rgba = new Uint8Array(rowLength * height)

  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * (rowLength + 1)
    const targetRow = y * rowLength
    const filter = filtered[sourceRow]
    expect(filter).toBeGreaterThanOrEqual(0)
    expect(filter).toBeLessThanOrEqual(4)
    for (let x = 0; x < rowLength; x += 1) {
      const raw = filtered[sourceRow + 1 + x]
      const left = x >= bytesPerPixel ? rgba[targetRow + x - bytesPerPixel] : 0
      const above = y > 0 ? rgba[targetRow - rowLength + x] : 0
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? rgba[targetRow - rowLength + x - bytesPerPixel]
        : 0
      const predictor = filter === 0
        ? 0
        : filter === 1
          ? left
          : filter === 2
            ? above
            : filter === 3
              ? Math.floor((left + above) / 2)
              : paeth(left, above, upperLeft)
      rgba[targetRow + x] = (raw + predictor) & 0xff
    }
  }

  return { width, height, rgba }
}

function colorBounds(
  decoded: DecodedPng,
  color: readonly [number, number, number],
  region: { minX: number; maxX: number; minY: number; maxY: number },
  tolerance = 12,
): PixelBounds | null {
  let minX = decoded.width
  let maxX = -1
  let minY = decoded.height
  let maxY = -1
  let count = 0

  for (let y = region.minY; y <= region.maxY; y += 1) {
    for (let x = region.minX; x <= region.maxX; x += 1) {
      const index = (y * decoded.width + x) * 4
      const distance = Math.hypot(
        decoded.rgba[index] - color[0],
        decoded.rgba[index + 1] - color[1],
        decoded.rgba[index + 2] - color[2],
      )
      if (distance <= tolerance) {
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
        count += 1
      }
    }
  }

  return count > 0 ? { minX, maxX, minY, maxY, count } : null
}

function saturatedColorBounds(
  decoded: DecodedPng,
  region: { minX: number; maxX: number; minY: number; maxY: number },
): PixelBounds | null {
  let minX = decoded.width
  let maxX = -1
  let minY = decoded.height
  let maxY = -1
  let count = 0

  for (let y = region.minY; y <= region.maxY; y += 1) {
    for (let x = region.minX; x <= region.maxX; x += 1) {
      const index = (y * decoded.width + x) * 4
      const red = decoded.rgba[index]
      const green = decoded.rgba[index + 1]
      const blue = decoded.rgba[index + 2]
      if (Math.max(red, green, blue) - Math.min(red, green, blue) < 40) continue
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      count += 1
    }
  }

  return count > 0 ? { minX, maxX, minY, maxY, count } : null
}

function countSmallColorComponents(
  decoded: DecodedPng,
  color: readonly [number, number, number],
  region: { minX: number; maxX: number; minY: number; maxY: number },
  tolerance = 12,
): number {
  const width = region.maxX - region.minX + 1
  const height = region.maxY - region.minY + 1
  const mask = new Uint8Array(width * height)
  for (let y = region.minY; y <= region.maxY; y += 1) {
    for (let x = region.minX; x <= region.maxX; x += 1) {
      const sourceIndex = (y * decoded.width + x) * 4
      const distance = Math.hypot(
        decoded.rgba[sourceIndex] - color[0],
        decoded.rgba[sourceIndex + 1] - color[1],
        decoded.rgba[sourceIndex + 2] - color[2],
      )
      if (distance <= tolerance) {
        mask[(y - region.minY) * width + x - region.minX] = 1
      }
    }
  }

  let smallComponents = 0
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1) continue
    const queue = [start]
    mask[start] = 2
    let minX = width
    let maxX = -1
    let minY = height
    let maxY = -1
    let pixels = 0
    while (queue.length > 0) {
      const current = queue.pop()
      if (current === undefined) break
      const x = current % width
      const y = Math.floor(current / width)
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      pixels += 1

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          const nextX = x + dx
          const nextY = y + dy
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue
          const next = nextY * width + nextX
          if (mask[next] !== 1) continue
          mask[next] = 2
          queue.push(next)
        }
      }
    }

    const componentWidth = maxX - minX + 1
    const componentHeight = maxY - minY + 1
    if (pixels >= 4 && componentWidth <= 12 && componentHeight <= 12) smallComponents += 1
  }

  return smallComponents
}

describe("OG image", () => {
  it("loads the canonical public assets through the request-scoped ASSETS binding", async () => {
    const rendererSource = readFileSync(new URL("./render-og-image.tsx", import.meta.url), "utf8")

    expect(officialLogo.byteLength).toBeGreaterThan(1_000)
    expect(officialFont.byteLength).toBeGreaterThan(30_000)
    expect(rendererSource).toContain(`"${LOGO_ASSET_URL}"`)
    expect(rendererSource).toContain(`"${FONT_ASSET_URL}"`)
    expect(rendererSource).not.toContain("node:fs")
    expect(rendererSource).not.toContain("node:path")
    expect(rendererSource).not.toContain("process.cwd()")
    expect(rendererSource).not.toContain("file://")
    expect(rendererSource).not.toContain("iVBORw0KGgo")
    expect(rendererSource).not.toContain("alook.svg")

    await renderOgImage("OG asset binding regression")

    expect(mockHeaders).toHaveBeenCalledOnce()
    expect(mockGetCloudflareContext).toHaveBeenCalledWith({ async: true })
    expect(mockAssetFetch.mock.calls.map(([input]) => input)).toEqual([
      LOGO_ASSET_URL,
      FONT_ASSET_URL,
    ])
    expect(mockHeaders.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetCloudflareContext.mock.invocationCallOrder[0],
    )
    expect(mockGetCloudflareContext.mock.invocationCallOrder[0]).toBeLessThan(
      mockAssetFetch.mock.invocationCallOrder[0],
    )
  })

  it("fails explicitly when the ASSETS binding is unavailable", async () => {
    mockGetCloudflareContext.mockResolvedValueOnce({ env: {} })

    await expect(renderOgImage("missing binding")).rejects.toThrow(
      "Cloudflare ASSETS binding is unavailable",
    )
    expect(mockAssetFetch).not.toHaveBeenCalled()
  })

  it("fails explicitly when a required OG asset is unavailable", async () => {
    mockAssetFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === LOGO_ASSET_URL) return new Response(Uint8Array.from(officialLogo))
      return new Response(null, { status: 404 })
    })

    await expect(renderOgImage("missing font")).rejects.toThrow(
      "OG asset /fonts/dm-sans-600.ttf returned 404",
    )
  })

  it("renders the official brand colors into the logo crop", async () => {
    const response = await renderOgImage("OG logo regression")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/png")

    const decoded = decodeRgbaPng(new Uint8Array(await response.arrayBuffer()))
    expect([decoded.width, decoded.height]).toEqual([1200, 630])

    const brandColors = [
      [254, 67, 101],
      [138, 90, 158],
      [69, 173, 168],
      [106, 140, 175],
      [255, 153, 21],
    ]
    const hits = brandColors.map(() => 0)
    for (let y = 70; y < 330; y += 1) {
      for (let x = 75; x < 205; x += 1) {
        const index = (y * decoded.width + x) * 4
        const pixel = decoded.rgba.subarray(index, index + 3)
        brandColors.forEach((color, colorIndex) => {
          const distance = Math.hypot(
            pixel[0] - color[0],
            pixel[1] - color[1],
            pixel[2] - color[2],
          )
          if (distance < 18) hits[colorIndex] += 1
        })
      }
    }

    for (const count of hits) expect(count).toBeGreaterThan(20)
    expect(hits.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(4_000)
  })

  it("lets Satori clamp text titles to two contained lines with a visible ellipsis", async () => {
    const cases = [
      {
        name: "short",
        title: "Bring your agents",
        expectsEllipsis: false,
      },
      {
        name: "medium",
        title: "How to Coordinate Multiple AI Agents Across Teams Without Losing Context, Duplicating Work, or Missing Approvals",
        expectsEllipsis: true,
      },
      {
        name: "long",
        title: "How to Coordinate Multiple AI Agents Across Teams Without Losing Context, Duplicating Work, Missing Approvals, or Breaking Shared Workflows in a Fast-Moving Organization While Keeping Every Decision Visible and Reviewable",
        expectsEllipsis: true,
      },
      {
        name: "unbroken",
        title: "X".repeat(5_600),
        expectsEllipsis: true,
      },
      {
        name: "cjk-long",
        title: "如何在快速变化的团队里协调多个人工智能代理同时保留上下文避免重复工作遗漏审批并确保每一个共享流程都清晰可靠可追溯并能长期安全展示",
        expectsEllipsis: true,
      },
    ]

    expect(OG_TITLE_MAX_LINES).toBe(2)
    expect(OG_TITLE_LINE_CLAMP).toBe('2 "…"')
    expect(OG_TITLE_MAX_INPUT_GRAPHEMES).toBe(240)
    expect(OG_TITLE_FONT_SIZE).toBe(52)
    expect(OG_TITLE_MAX_HEIGHT).toBe(120)

    const familyEmoji = "👨‍👩‍👧‍👦"
    const oversized = `  ${familyEmoji.repeat(260)}  `
    const normalized = normalizeOgTitle(oversized)
    expect(Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(normalized)))
      .toHaveLength(OG_TITLE_MAX_INPUT_GRAPHEMES)
    expect(normalized.endsWith("…")).toBe(true)
    expect(normalizeOgTitle("  spaced\n\t title  ")).toBe("spaced title")

    for (const testCase of cases) {
      const response = await renderOgImage(testCase.title)
      expect(response.status, testCase.name).toBe(200)
      const decoded = decodeRgbaPng(new Uint8Array(await response.arrayBuffer()))
      expect([decoded.width, decoded.height], testCase.name).toEqual([1200, 630])

      const titleBounds = colorBounds(decoded, [42, 35, 26], {
        minX: 70,
        maxX: 740,
        minY: 280,
        maxY: 430,
      })
      const subtitleBounds = colorBounds(decoded, [138, 126, 110], {
        minX: 70,
        maxX: 740,
        minY: 440,
        maxY: 560,
      })
      const logoBounds = colorBounds(decoded, [255, 153, 21], {
        minX: 70,
        maxX: 210,
        minY: 80,
        maxY: 360,
      })
      const typewriterBounds = colorBounds(decoded, [184, 169, 142], {
        minX: 740,
        maxX: 1120,
        minY: 220,
        maxY: 520,
      })

      expect(titleBounds, testCase.name).not.toBeNull()
      expect(subtitleBounds, testCase.name).not.toBeNull()
      expect(logoBounds, testCase.name).not.toBeNull()
      expect(typewriterBounds, testCase.name).not.toBeNull()
      if (!titleBounds || !subtitleBounds || !logoBounds || !typewriterBounds) continue

      expect(titleBounds.maxY - titleBounds.minY + 1, testCase.name)
        .toBeLessThanOrEqual(OG_TITLE_MAX_HEIGHT)
      expect(titleBounds.maxX, testCase.name).toBeLessThan(680)
      expect(titleBounds.minY - logoBounds.maxY, testCase.name).toBeGreaterThanOrEqual(24)
      expect(subtitleBounds.minY - titleBounds.maxY, testCase.name).toBeGreaterThanOrEqual(16)
      expect(typewriterBounds.minX - titleBounds.maxX, testCase.name).toBeGreaterThanOrEqual(40)
      if (testCase.expectsEllipsis) {
        const ellipsisComponents = countSmallColorComponents(decoded, [42, 35, 26], {
          minX: Math.max(titleBounds.minX, titleBounds.maxX - 80),
          maxX: titleBounds.maxX,
          minY: titleBounds.maxY - 24,
          maxY: titleBounds.maxY,
        })
        expect(ellipsisComponents, testCase.name).toBeGreaterThanOrEqual(2)
      }
    }
  }, 30_000)

  it("contains ordinary and ZWJ emoji inside the two-line title box", async () => {
    for (const [name, title] of [
      ["ordinary emoji", "😀".repeat(100)],
      ["ZWJ emoji", "👨‍👩‍👧‍👦".repeat(100)],
    ] as const) {
      expect(normalizeOgTitle(title)).toBe(title)
      const response = await renderOgImage(title)
      const decoded = decodeRgbaPng(new Uint8Array(await response.arrayBuffer()))
      const emojiBounds = saturatedColorBounds(decoded, {
        minX: 70,
        maxX: 740,
        minY: 280,
        maxY: 440,
      })

      expect(emojiBounds, name).not.toBeNull()
      if (!emojiBounds) continue
      expect(emojiBounds.maxX, name).toBeLessThan(680)
      expect(emojiBounds.maxY - emojiBounds.minY + 1, name)
        .toBeLessThanOrEqual(OG_TITLE_MAX_HEIGHT)

      const overflowBounds = saturatedColorBounds(decoded, {
        minX: 680,
        maxX: 740,
        minY: 280,
        maxY: 440,
      })
      expect(overflowBounds, name).toBeNull()
    }
  }, 20_000)
})
