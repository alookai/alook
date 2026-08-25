import { inflateSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { NextRequest } from "next/server"
import { OG_LOGO_DATA_URI } from "./og-logo"
import { GET } from "./route"

type DecodedPng = {
  width: number
  height: number
  rgba: Uint8Array
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

describe("OG image", () => {
  it("embeds the checked-in raster logo instead of requesting the public SVG", () => {
    const [prefix, payload] = OG_LOGO_DATA_URI.split(",", 2)
    const officialLogo = readFileSync(new URL("../../../public/icon-192.png", import.meta.url))
    const routeSource = readFileSync(new URL("./route.tsx", import.meta.url), "utf8")

    expect(prefix).toBe("data:image/png;base64")
    expect(Buffer.from(payload, "base64")).toEqual(officialLogo)
    expect(routeSource).toContain("src={OG_LOGO_DATA_URI}")
    expect(routeSource).not.toContain('new URL("/alook.svg", request.url)')
  })

  it("renders the official brand colors into the logo crop", async () => {
    const response = await GET(new NextRequest("http://localhost/og?title=OG%20logo%20regression"))
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
    for (let y = 170; y < 315; y += 1) {
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
})
