import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  assertSvgContract,
  canonicalizeIcns,
  desktopRasterAssets,
  fullBleedSvg,
  iosRasterAssets,
  preservedAssets,
  trayRasterAssets,
} from "../generate-logo-assets.mjs"

const repoRoot = resolve(import.meta.dirname, "../..")
const requireFromCli = createRequire(resolve(repoRoot, "src/cli/package.json"))
const sharp = requireFromCli("sharp")

async function alphaBounds(path: string) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let left = info.width
  let top = info.height
  let right = 0
  let bottom = 0
  let opaque = true
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3]
      if (alpha !== 255) opaque = false
      if (alpha === 0) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x + 1)
      bottom = Math.max(bottom, y + 1)
    }
  }
  return { width: info.width, height: info.height, bounds: [left, top, right, bottom], opaque }
}

describe("logo asset generator", () => {
  it("locks the canonical structured transparent SVG", async () => {
    const canonical = await readFile(resolve(repoRoot, "assets/alook.svg"), "utf8")
    const publicCopy = await readFile(resolve(repoRoot, "src/web/public/alook.svg"), "utf8")

    expect(() => assertSvgContract(canonical)).not.toThrow()
    expect(publicCopy).toBe(canonical)
    expect(fullBleedSvg(canonical)).toContain("<g>")
    expect(fullBleedSvg(canonical)).not.toContain('<g clip-path="url(#alook-logo-clip)">')
  })

  it("covers every approved platform family and protects the exceptions", () => {
    expect(desktopRasterAssets).toHaveLength(17)
    expect(iosRasterAssets).toHaveLength(18)
    expect(preservedAssets).toEqual([
      "src/web/src/app/favicon.ico",
      "assets/readme/banner.png",
    ])
    expect(trayRasterAssets).toEqual([
      ["assets/alook-tray.svg", "src/desktop/src-tauri/icons/tray-default.png"],
      ["assets/alook-tray.svg", "src/desktop/src-tauri/icons/tray-online.png"],
      ["assets/alook-tray-offline.svg", "src/desktop/src-tauri/icons/tray-offline.png"],
    ])
  })

  it("canonicalizes nondeterministic ICNS chunk order", () => {
    const chunk = (type: string, payload: string) => {
      const data = Buffer.from(payload)
      const output = Buffer.alloc(8 + data.length)
      output.write(type, 0, "ascii")
      output.writeUInt32BE(output.length, 4)
      data.copy(output, 8)
      return output
    }
    const header = Buffer.alloc(8)
    header.write("icns", 0, "ascii")
    const unordered = Buffer.concat([header, chunk("zzzz", "second"), chunk("aaaa", "first")])
    unordered.writeUInt32BE(unordered.length, 4)

    const canonical = canonicalizeIcns(unordered)
    expect(canonical.subarray(8, 12).toString("ascii")).toBe("aaaa")
    expect(canonicalizeIcns(canonical)).toEqual(canonical)
  })

  it("keeps Retina Tray templates generated from their SVG sources", async () => {
    for (const [source, destination] of trayRasterAssets) {
      const svg = await readFile(resolve(repoRoot, source))
      const expected = await sharp(svg).resize(36, 36).png().toBuffer()
      expect(await readFile(resolve(repoRoot, destination))).toEqual(expected)
      expect(await alphaBounds(resolve(repoRoot, destination))).toEqual({
        width: 36,
        height: 36,
        bounds: [2, 2, 35, 33],
        opaque: false,
      })
    }
  })

  it("preserves web, platform, and splash canvas contracts", async () => {
    expect(await alphaBounds(resolve(repoRoot, "src/web/public/icon-192.png"))).toEqual({
      width: 192,
      height: 192,
      bounds: [0, 0, 192, 192],
      opaque: false,
    })
    expect(await alphaBounds(resolve(repoRoot, "src/web/public/apple-touch-icon.png"))).toEqual({
      width: 180,
      height: 180,
      bounds: [0, 0, 180, 180],
      opaque: true,
    })
    expect(await alphaBounds(resolve(repoRoot, "src/desktop/src-tauri/gen/android/app/src/main/res/drawable-mdpi/splash_icon.png"))).toEqual({
      width: 108,
      height: 108,
      bounds: [26, 26, 82, 82],
      opaque: false,
    })
    expect(await alphaBounds(resolve(repoRoot, "src/desktop/src-tauri/gen/android/app/src/main/res/mipmap-mdpi/ic_launcher.png"))).toMatchObject({
      width: 48,
      height: 48,
      bounds: [4, 4, 44, 44],
    })
    expect(await alphaBounds(resolve(repoRoot, "src/desktop/src-tauri/gen/android/app/src/main/res/mipmap-mdpi/ic_launcher_round.png"))).toMatchObject({
      width: 48,
      height: 48,
      bounds: [2, 2, 46, 46],
    })
  })
})
