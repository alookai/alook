import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  androidAdaptiveForegroundSizes,
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

const androidLegacyIconSizes = {
  mdpi: 48,
  hdpi: 49,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
} as const

const desktopPngSizes = {
  "32x32.png": 32,
  "64x64.png": 64,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
  "Square30x30Logo.png": 30,
  "Square44x44Logo.png": 44,
  "Square71x71Logo.png": 71,
  "Square89x89Logo.png": 89,
  "Square107x107Logo.png": 107,
  "Square142x142Logo.png": 142,
  "Square150x150Logo.png": 150,
  "Square284x284Logo.png": 284,
  "Square310x310Logo.png": 310,
  "StoreLogo.png": 50,
} as const

const iosPngSizes = {
  "AppIcon-20x20@1x.png": 20,
  "AppIcon-20x20@2x-1.png": 40,
  "AppIcon-20x20@2x.png": 40,
  "AppIcon-20x20@3x.png": 60,
  "AppIcon-29x29@1x.png": 29,
  "AppIcon-29x29@2x-1.png": 58,
  "AppIcon-29x29@2x.png": 58,
  "AppIcon-29x29@3x.png": 87,
  "AppIcon-40x40@1x.png": 40,
  "AppIcon-40x40@2x-1.png": 80,
  "AppIcon-40x40@2x.png": 80,
  "AppIcon-40x40@3x.png": 120,
  "AppIcon-60x60@2x.png": 120,
  "AppIcon-60x60@3x.png": 180,
  "AppIcon-76x76@1x.png": 76,
  "AppIcon-76x76@2x.png": 152,
  "AppIcon-83.5x83.5@2x.png": 167,
  "AppIcon-512@2x.png": 1024,
} as const

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
    expect(Object.keys(desktopPngSizes)).toEqual(desktopRasterAssets.filter(file => file.endsWith(".png")))
    expect(Object.keys(iosPngSizes)).toEqual(iosRasterAssets)
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

  it("keeps Android adaptive foreground artwork inside the safe zone at every density", async () => {
    const adaptiveXml = await readFile(resolve(repoRoot, "src/desktop/src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml"), "utf8")
    expect(adaptiveXml).toContain('<foreground android:drawable="@mipmap/ic_launcher_foreground"/>')
    expect(adaptiveXml).toContain('<background android:drawable="@color/ic_launcher_background"/>')

    for (const [density, { canvas, artwork }] of Object.entries(androidAdaptiveForegroundSizes)) {
      const offset = Math.floor((canvas - artwork) / 2)
      const base = resolve(repoRoot, `src/desktop/src-tauri/gen/android/app/src/main/res/mipmap-${density}`)
      expect(await alphaBounds(resolve(base, "ic_launcher_foreground.png"))).toEqual({
        width: canvas,
        height: canvas,
        bounds: [offset, offset, offset + artwork, offset + artwork],
        opaque: false,
      })
      for (const file of ["ic_launcher.png", "ic_launcher_round.png"]) {
        expect(await alphaBounds(resolve(base, file))).toMatchObject({
          width: androidLegacyIconSizes[density as keyof typeof androidLegacyIconSizes],
          height: androidLegacyIconSizes[density as keyof typeof androidLegacyIconSizes],
          opaque: false,
        })
      }
    }
  })

  it("locks Tauri Apple, macOS, Windows, and Linux icon container contracts", async () => {
    for (const [file, size] of Object.entries(iosPngSizes)) {
      const generated = resolve(repoRoot, "src/desktop/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset", file)
      const packaged = resolve(repoRoot, "src/desktop/src-tauri/icons/ios", file)
      expect(await readFile(packaged)).toEqual(await readFile(generated))
      expect(await alphaBounds(generated)).toEqual({
        width: size,
        height: size,
        bounds: [0, 0, size, size],
        opaque: true,
      })
    }

    for (const [file, size] of Object.entries(desktopPngSizes)) {
      expect(await alphaBounds(resolve(repoRoot, "src/desktop/src-tauri/icons", file))).toMatchObject({
        width: size,
        height: size,
        bounds: [0, 0, size, size],
        opaque: false,
      })
    }

    const ico = await readFile(resolve(repoRoot, "src/desktop/src-tauri/icons/icon.ico"))
    const icoSizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
      const offset = 6 + index * 16
      return [ico[offset] || 256, ico[offset + 1] || 256]
    })
    expect(ico.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
    expect(icoSizes).toEqual([[32, 32], [16, 16], [24, 24], [48, 48], [64, 64], [256, 256]])

    const icns = await readFile(resolve(repoRoot, "src/desktop/src-tauri/icons/icon.icns"))
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns")
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    expect(canonicalizeIcns(icns)).toEqual(icns)
  })
})
