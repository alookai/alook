import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { JSDOM } from "jsdom"
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import {
  androidAdaptiveForegroundSizes,
  androidSplashArtworkSizes,
  androidSplashSizes,
  androidSplashSystemIconSize,
  appleSplashSizes,
  assertSvgContract,
  canonicalizeIcns,
  fullBleedSvg,
  mobileSplashVisibleSize,
  trayRasterAssets,
} from "../../../../../scripts/generate-logo-assets.mjs"

const repoRoot = resolve(import.meta.dirname, "../../../../..")

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

async function visibleColors(path: string) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const colors = new Set<string>()
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (data[offset + 3] === 0) continue
    colors.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`)
  }
  return colors
}

async function expressionBounds(path: string) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let left = info.width
  let top = info.height
  let right = 0
  let bottom = 0
  let hasBlack = false
  let hasWhite = false
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels
      if (data[offset + 3] === 0) continue
      const isBlack = data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 0
      const isWhite = data[offset] === 255 && data[offset + 1] === 255 && data[offset + 2] === 255
      if (!isBlack && !isWhite) continue
      hasBlack ||= isBlack
      hasWhite ||= isWhite
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x + 1)
      bottom = Math.max(bottom, y + 1)
    }
  }
  if (!hasBlack || !hasWhite) throw new Error(`${path} is missing visible expression colors`)
  return [left, top, right, bottom]
}

describe("logo asset generator", () => {
  it("keeps canonical copies coherent and removes rounded clipping from full-bleed pixels", async () => {
    const canonical = await readFile(resolve(repoRoot, "assets/alook.svg"), "utf8")
    const publicCopy = await readFile(resolve(repoRoot, "src/web/public/alook.svg"), "utf8")

    expect(() => assertSvgContract(canonical)).not.toThrow()
    expect(publicCopy).toBe(canonical)
    const cornerAlpha = async (svg: string) => {
      const pixel = await sharp(Buffer.from(svg)).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer()
      return pixel[3]
    }
    expect(await cornerAlpha(canonical)).toBe(0)
    expect(await cornerAlpha(fullBleedSvg(canonical))).toBeGreaterThan(0)
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
    const expected = Buffer.concat([header, chunk("aaaa", "first"), chunk("zzzz", "second")])
    expected.writeUInt32BE(expected.length, 4)
    expect(canonical).toEqual(expected)
    expect(canonicalizeIcns(canonical)).toEqual(canonical)
  })

  it("keeps platform tray assets generated from their SVG sources", async () => {
    for (const [source, destination] of trayRasterAssets) {
      const svg = await readFile(resolve(repoRoot, source))
      const expected = await sharp(svg).resize(36, 36).png().toBuffer()
      expect(await readFile(resolve(repoRoot, destination))).toEqual(expected)
    }

    const template = resolve(repoRoot, "src/desktop/src-tauri/icons/tray-macos-template.png")
    expect(await alphaBounds(template)).toEqual({
      width: 36,
      height: 36,
      bounds: [2, 2, 35, 33],
      opaque: false,
    })
    expect([...await visibleColors(template)]).toEqual(["0,0,0"])

    const color = resolve(repoRoot, "src/desktop/src-tauri/icons/tray-windows-linux-color.png")
    expect(await alphaBounds(color)).toMatchObject({
      width: 36,
      height: 36,
      opaque: false,
    })
    expect((await visibleColors(color)).size).toBeGreaterThan(5)
  })

  it("preserves web and platform canvas contracts", async () => {
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

  it("aligns native mobile splash artwork with the mobile unknown/neutral frame", async () => {
    expect(mobileSplashVisibleSize).toBe(106)

    for (const [density, canvas] of Object.entries(androidSplashSizes)) {
      const artwork = androidSplashArtworkSizes[density as keyof typeof androidSplashArtworkSizes]
      const offset = Math.floor((canvas - artwork) / 2)
      const path = resolve(repoRoot, `src/desktop/src-tauri/gen/android/app/src/main/res/drawable-${density}/splash_icon.png`)
      const systemVisibleSize = artwork * androidSplashSystemIconSize / canvas
      expect(Math.abs(systemVisibleSize - mobileSplashVisibleSize)).toBeLessThanOrEqual(1)
      expect(await alphaBounds(path)).toEqual({
        width: canvas,
        height: canvas,
        bounds: [offset, offset, offset + artwork, offset + artwork],
        opaque: false,
      })
    }

    for (const [file, size] of Object.entries(appleSplashSizes)) {
      const path = resolve(repoRoot, "src/desktop/src-tauri/gen/apple/Assets.xcassets/SplashIcon.imageset", file)
      expect(await alphaBounds(path)).toEqual({
        width: size,
        height: size,
        bounds: [0, 0, size, size],
        opaque: false,
      })
    }

    const storyboard = new JSDOM(await readFile(resolve(repoRoot, "src/desktop/src-tauri/gen/apple/LaunchScreen.storyboard"), "utf8"), { contentType: "application/xml" })
    try {
      const document = storyboard.window.document
      const initial = document.documentElement.getAttribute("initialViewController")
      expect(initial).toBeTruthy()
      const controllers = [...document.getElementsByTagName("viewController")].filter(controller => controller.id === initial)
      expect(controllers).toHaveLength(1)
      const images = controllers[0].querySelectorAll("view > subviews > imageView")
      expect(images).toHaveLength(1)
      const image = images[0]
      expect(image.getAttribute("image")).toBe("SplashIcon")
      for (const attribute of ["width", "height"]) {
        const constraints = [...image.querySelectorAll("constraints > constraint")].filter(constraint => constraint.getAttribute("firstAttribute") === attribute
          && constraint.getAttribute("active") !== "NO"
          && (!constraint.getAttribute("firstItem") || constraint.getAttribute("firstItem") === image.id))
        expect(constraints).toHaveLength(1)
        expect(constraints[0].getAttribute("relation") ?? "equal").toBe("equal")
        expect(constraints[0].getAttribute("secondItem")).toBeNull()
        expect(Number(constraints[0].getAttribute("constant"))).toBe(106)
      }
      const resources = [...document.querySelectorAll("document > resources > image")].filter(resource => resource.getAttribute("name") === image.getAttribute("image"))
      expect(resources).toHaveLength(1)
      expect(["width", "height"].map(attribute => Number(resources[0].getAttribute(attribute)))).toEqual([106, 106])
      const catalog = JSON.parse(await readFile(resolve(repoRoot, "src/desktop/src-tauri/gen/apple/Assets.xcassets/SplashIcon.imageset/Contents.json"), "utf8"))
      expect(catalog.images.map((entry: { filename: string; scale: string }) => [entry.filename, entry.scale])).toEqual([
        ["splash_icon@1x.png", "1x"], ["splash_icon@2x.png", "2x"], ["splash_icon@3x.png", "3x"],
      ])
    } finally { storyboard.window.close() }
  })

  it("fills Android adaptive masks while keeping the expression inside the safe zone at every density", async () => {
    const adaptiveXml = new JSDOM(await readFile(resolve(repoRoot, "src/desktop/src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml"), "utf8"), { contentType: "application/xml" })
    let foregroundResource: string
    try {
      const icon = adaptiveXml.window.document.documentElement
      expect(icon.localName).toBe("adaptive-icon")
      const foreground = [...icon.children].filter(child => child.localName === "foreground")
      const background = [...icon.children].filter(child => child.localName === "background")
      expect(foreground).toHaveLength(1)
      expect(background).toHaveLength(1)
      foregroundResource = foreground[0].getAttributeNS("http://schemas.android.com/apk/res/android", "drawable")!
      expect(foregroundResource).toBe("@mipmap/ic_launcher_foreground")
      expect(background[0].getAttributeNS("http://schemas.android.com/apk/res/android", "drawable")).toBe("@color/ic_launcher_background")
    } finally { adaptiveXml.window.close() }

    for (const [density, { canvas, artwork }] of Object.entries(androidAdaptiveForegroundSizes)) {
      const offset = Math.floor((canvas - artwork) / 2)
      const safeSize = canvas * 66 / 108
      const safeOffset = (canvas - safeSize) / 2
      const base = resolve(repoRoot, `src/desktop/src-tauri/gen/android/app/src/main/res/mipmap-${density}`)
      const foreground = resolve(base, `${foregroundResource.slice("@mipmap/".length)}.png`)
      expect(artwork).toBe(canvas * 84 / 108)
      expect(await alphaBounds(foreground)).toEqual({
        width: canvas,
        height: canvas,
        bounds: [offset, offset, offset + artwork, offset + artwork],
        opaque: false,
      })
      const [left, top, right, bottom] = await expressionBounds(foreground)
      expect(left).toBeGreaterThanOrEqual(safeOffset)
      expect(top).toBeGreaterThanOrEqual(safeOffset)
      expect(right).toBeLessThanOrEqual(safeOffset + safeSize)
      expect(bottom).toBeLessThanOrEqual(safeOffset + safeSize)
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
    const directoryEnd = 6 + ico.readUInt16LE(4) * 16
    expect(directoryEnd).toBeLessThanOrEqual(ico.length)
    const icoSizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
      const offset = 6 + index * 16
      const bytes = ico.readUInt32LE(offset + 8)
      const start = ico.readUInt32LE(offset + 12)
      expect(bytes).toBeGreaterThan(0)
      expect(start).toBeGreaterThanOrEqual(directoryEnd)
      expect(start + bytes).toBeLessThanOrEqual(ico.length)
      return [ico[offset] || 256, ico[offset + 1] || 256]
    })
    expect(ico.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
    expect(icoSizes.sort((left, right) => left[0] - right[0] || left[1] - right[1])).toEqual([[16, 16], [24, 24], [32, 32], [48, 48], [64, 64], [256, 256]])

    const icns = await readFile(resolve(repoRoot, "src/desktop/src-tauri/icons/icon.icns"))
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns")
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    expect(canonicalizeIcns(icns)).toEqual(icns)
  })
})
