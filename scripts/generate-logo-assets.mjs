import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const requireFromCli = createRequire(pathToFileURL(resolve(repoRoot, "src/cli/package.json")))
const sharp = requireFromCli("sharp")

export const preservedAssets = [
  "src/web/src/app/favicon.ico",
  "assets/readme/banner.png",
]

export const trayRasterAssets = [
  ["assets/alook-tray.svg", "src/desktop/src-tauri/icons/tray-default.png"],
  ["assets/alook-tray.svg", "src/desktop/src-tauri/icons/tray-online.png"],
  ["assets/alook-tray-offline.svg", "src/desktop/src-tauri/icons/tray-offline.png"],
]

export const desktopRasterAssets = [
  "32x32.png",
  "64x64.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.png",
  "icon.icns",
  "icon.ico",
  "Square30x30Logo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square89x89Logo.png",
  "Square107x107Logo.png",
  "Square142x142Logo.png",
  "Square150x150Logo.png",
  "Square284x284Logo.png",
  "Square310x310Logo.png",
  "StoreLogo.png",
]

export const iosRasterAssets = [
  "AppIcon-20x20@1x.png",
  "AppIcon-20x20@2x-1.png",
  "AppIcon-20x20@2x.png",
  "AppIcon-20x20@3x.png",
  "AppIcon-29x29@1x.png",
  "AppIcon-29x29@2x-1.png",
  "AppIcon-29x29@2x.png",
  "AppIcon-29x29@3x.png",
  "AppIcon-40x40@1x.png",
  "AppIcon-40x40@2x-1.png",
  "AppIcon-40x40@2x.png",
  "AppIcon-40x40@3x.png",
  "AppIcon-60x60@2x.png",
  "AppIcon-60x60@3x.png",
  "AppIcon-76x76@1x.png",
  "AppIcon-76x76@2x.png",
  "AppIcon-83.5x83.5@2x.png",
  "AppIcon-512@2x.png",
]

export const androidAdaptiveForegroundSizes = {
  mdpi: { canvas: 108, artwork: 66 },
  hdpi: { canvas: 162, artwork: 99 },
  xhdpi: { canvas: 216, artwork: 132 },
  xxhdpi: { canvas: 324, artwork: 198 },
  xxxhdpi: { canvas: 432, artwork: 264 },
}
const androidDensities = Object.keys(androidAdaptiveForegroundSizes)
const androidSplashSizes = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 }
const appleSplashSizes = { "splash_icon@1x.png": 80, "splash_icon@2x.png": 160, "splash_icon@3x.png": 240 }

export function assertSvgContract(svg) {
  if (!svg.includes('viewBox="0 0 1024 1024"')) throw new Error("logo viewBox drifted")
  if (!svg.includes('rx="236"')) throw new Error("logo clip radius drifted")
  if (svg.includes("#F2E7D2")) throw new Error("inline logo must stay transparent")
  if ((svg.match(/data-face=/g) ?? []).length !== 5) throw new Error("logo must have five face groups")
  if ((svg.match(/data-part="expression"/g) ?? []).length !== 4) throw new Error("logo must have four expression groups")
  if ((svg.match(/<path/g) ?? []).length !== 21) throw new Error("logo path order/count drifted")
  if (!svg.includes('data-motion-layer="foreground"')) throw new Error("foreground motion layer is missing")
}

export function fullBleedSvg(svg) {
  assertSvgContract(svg)
  return svg.replace('<g clip-path="url(#alook-logo-clip)">', "<g>")
}

export function canonicalizeIcns(bytes) {
  const input = Buffer.from(bytes)
  if (input.subarray(0, 4).toString("ascii") !== "icns") throw new Error("invalid ICNS header")
  const chunks = []
  for (let offset = 8; offset < input.length;) {
    const length = input.readUInt32BE(offset + 4)
    chunks.push(input.subarray(offset, offset + length))
    offset += length
  }
  chunks.sort((left, right) => left.subarray(0, 4).compare(right.subarray(0, 4)))
  const output = Buffer.concat([Buffer.alloc(8), ...chunks])
  output.write("icns", 0, "ascii")
  output.writeUInt32BE(output.length, 4)
  return output
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

async function copy(source, destination) {
  await copyFile(source, resolve(repoRoot, destination))
}

async function render(svg, width, height = width) {
  return sharp(Buffer.from(svg)).resize(width, height).png().toBuffer()
}

async function renderOpaque(svg, width, height = width) {
  return sharp(Buffer.from(svg)).resize(width, height).flatten({ background: "#FE4365" }).png().toBuffer()
}

async function renderContained(svg, canvasSize, artworkSize) {
  const artwork = await render(svg, artworkSize)
  const offset = Math.floor((canvasSize - artworkSize) / 2)
  return sharp({
    create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: artwork, left: offset, top: offset }]).png().toBuffer()
}

export async function generateTrayAssets() {
  for (const [source, destination] of trayRasterAssets) {
    const svg = await readFile(resolve(repoRoot, source), "utf8")
    await writeFile(resolve(repoRoot, destination), await render(svg, 36))
  }
}

async function assertDimensions(path, width, height = width) {
  const metadata = await sharp(path).metadata()
  if (metadata.width !== width || metadata.height !== height) {
    throw new Error(`${path} is ${metadata.width}x${metadata.height}; expected ${width}x${height}`)
  }
}

export async function generateLogoAssets() {
  const canonicalPath = resolve(repoRoot, "assets/alook.svg")
  const canonical = await readFile(canonicalPath, "utf8")
  assertSvgContract(canonical)
  const publicCanonical = await readFile(resolve(repoRoot, "src/web/public/alook.svg"), "utf8")
  if (canonical !== publicCanonical) throw new Error("canonical SVG copies must be byte-identical")

  const preservedBefore = new Map(await Promise.all(preservedAssets.map(async (path) => [path, await digest(resolve(repoRoot, path))])))
  const scratch = await mkdtemp(join(tmpdir(), "alook-logo-assets-"))
  const roundedOutput = join(scratch, "rounded")
  const fullBleedOutput = join(scratch, "full-bleed")
  const fullBleedPath = join(scratch, "alook-full-bleed.svg")
  await writeFile(fullBleedPath, fullBleedSvg(canonical))

  for (const [source, output] of [[canonicalPath, roundedOutput], [fullBleedPath, fullBleedOutput]]) {
    execFileSync("pnpm", ["--filter", "@alook/desktop", "tauri", "icon", "--output", output, source], {
      cwd: repoRoot,
      stdio: "inherit",
    })
  }

  await writeFile(resolve(repoRoot, "src/web/public/icon-192.png"), await render(canonical, 192))
  await writeFile(resolve(repoRoot, "src/web/public/icon-512.png"), await render(canonical, 512))
  const fullBleed = fullBleedSvg(canonical)
  await writeFile(resolve(repoRoot, "src/web/public/apple-touch-icon.png"), await renderOpaque(fullBleed, 180))
  await generateTrayAssets()

  for (const file of desktopRasterAssets) {
    const source = join(roundedOutput, file)
    const destination = resolve(repoRoot, "src/desktop/src-tauri/icons", file)
    if (file === "icon.icns") await writeFile(destination, canonicalizeIcns(await readFile(source)))
    else await copy(source, `src/desktop/src-tauri/icons/${file}`)
  }

  for (const file of iosRasterAssets) {
    const source = join(fullBleedOutput, "ios", file)
    const opaque = await sharp(source).flatten({ background: "#FE4365" }).png().toBuffer()
    await writeFile(resolve(repoRoot, "src/desktop/src-tauri/icons/ios", file), opaque)
    await writeFile(resolve(repoRoot, "src/desktop/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset", file), opaque)
  }

  for (const [file, size] of Object.entries(appleSplashSizes)) {
    await writeFile(
      resolve(repoRoot, "src/desktop/src-tauri/gen/apple/Assets.xcassets/SplashIcon.imageset", file),
      await render(canonical, size),
    )
  }

  for (const density of androidDensities) {
    const sourceDir = join(fullBleedOutput, "android", `mipmap-${density}`)
    const destinationDir = `src/desktop/src-tauri/gen/android/app/src/main/res/mipmap-${density}`
    for (const file of ["ic_launcher.png", "ic_launcher_round.png"]) {
      await copy(join(sourceDir, file), `${destinationDir}/${file}`)
    }
    const { canvas, artwork } = androidAdaptiveForegroundSizes[density]
    await writeFile(
      resolve(repoRoot, destinationDir, "ic_launcher_foreground.png"),
      await renderContained(canonical, canvas, artwork),
    )
    const splashSize = androidSplashSizes[density]
    const artworkSize = Math.round(splashSize * 0.5185185185)
    await writeFile(
      resolve(repoRoot, `src/desktop/src-tauri/gen/android/app/src/main/res/drawable-${density}/splash_icon.png`),
      await renderContained(canonical, splashSize, artworkSize),
    )
  }

  await assertDimensions(resolve(repoRoot, "src/web/public/icon-192.png"), 192)
  await assertDimensions(resolve(repoRoot, "src/web/public/icon-512.png"), 512)
  await assertDimensions(resolve(repoRoot, "src/web/public/apple-touch-icon.png"), 180)
  for (const [path, before] of preservedBefore) {
    const after = await digest(resolve(repoRoot, path))
    if (after !== before) throw new Error(`preserved asset changed: ${basename(path)}`)
  }
  await rm(scratch, { recursive: true })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generateLogoAssets()
}
