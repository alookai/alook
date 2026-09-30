import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { makeBadge } from "badge-maker"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const faviconPath = resolve(repoRoot, "src/web/src/app/favicon.ico")
const outputPath = resolve(repoRoot, "assets/readme/alook-join.svg")
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function extractPngIcon(ico, size = 32) {
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error("Invalid ICO header")
  }

  const imageCount = ico.readUInt16LE(4)
  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + index * 16
    if (entryOffset + 16 > ico.length) throw new Error("Invalid ICO directory")
    const width = ico[entryOffset] || 256
    const height = ico[entryOffset + 1] || 256
    if (width !== size || height !== size) continue

    const byteLength = ico.readUInt32LE(entryOffset + 8)
    const imageOffset = ico.readUInt32LE(entryOffset + 12)
    const image = ico.subarray(imageOffset, imageOffset + byteLength)
    if (image.length !== byteLength || !image.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new Error(`The ${size}x${size} favicon entry is not a complete PNG`)
    }
    return image
  }

  throw new Error(`The favicon does not contain a ${size}x${size} PNG entry`)
}

export function makeReadmeBadge(faviconIco) {
  const favicon = extractPngIcon(faviconIco)
  return `${makeBadge({
    label: "Alook",
    message: "Join",
    labelColor: "#555",
    color: "#ff9915",
    logoBase64: `data:image/png;base64,${favicon.toString("base64")}`,
    style: "flat",
    idSuffix: "alook-join",
  })}\n`
}

export async function generateReadmeBadges() {
  const svg = makeReadmeBadge(await readFile(faviconPath))
  await writeFile(outputPath, svg)
  process.stdout.write(`Generated ${outputPath}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generateReadmeBadges()
}
