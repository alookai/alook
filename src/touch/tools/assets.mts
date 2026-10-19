import { createRequire } from "node:module"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { renderFaceSvg } from "../../web/src/lib/avatar/face"
import { AVATAR_PALETTES, avatarHash, avatarThemeFromSeed } from "../../web/src/lib/avatar/theme"

const require = createRequire(new URL("../../web/package.json", import.meta.url))
const sharp = require("sharp") as typeof import("../../web/node_modules/sharp")
const output = new URL("../firmware/touch/generated/", import.meta.url)
await mkdir(output, { recursive: true })
const lines = ["#pragma once", "#include <lvgl.h>", "namespace alook_touch::assets {", "struct Feature { const lv_img_dsc_t* image; int x; int y; }; "]
const identity = ["#pragma once", "#include <cstdint>", "namespace alook_touch {", "inline constexpr uint32_t avatar_palettes[25][5] = {"]
identity.push(...AVATAR_PALETTES.map(row => "{" + row.map(hex => "0x" + hex.slice(1)).join(",") + "},"), "};", "}")
const features: Record<string, string[]> = { eyes: [], mouth: [] }
const selected = new Map<string, string>()
for (let index = 0; selected.size < (21 + 22) * 4; index++) {
  if (index > 500_000) throw new Error("Feature vocabulary coverage failed")
  const seed = `touch-${index}`
  const hash = avatarHash(seed)
  const white = avatarThemeFromSeed(seed).ink === "#ffffff" ? 1 : 0
  for (const [part, count, divisor] of [["eyes", 21, 11], ["mouth", 22, 231]] as const) {
    const key = `${part}-${Math.floor(hash / divisor) % count}-${hash % 2}-${white}`
    if (!selected.has(key)) selected.set(key, seed)
  }
}

function emit(name: string, bytes: Uint8Array, width: number, height: number, format: string) {
  lines.push(`inline const uint8_t ${name}_data[] = {`)
  for (let start = 0; start < bytes.length; start += 32) lines.push(Array.from(bytes.subarray(start, start + 32)).join(",") + ",")
  lines.push("};", `inline const lv_img_dsc_t ${name} = {{${format},0,0,${width},${height}},${bytes.length},${name}_data};`)
}

for (const [part, count] of [["eyes", 21], ["mouth", 22]] as const) {
  for (let index = 0; index < count; index++) for (let spread = 0; spread < 2; spread++) for (let white = 0; white < 2; white++) {
    const key = `${part}-${index}-${spread}-${white}`
    const seed = selected.get(key)!
    const body = renderFaceSvg(seed, { motionParts: true }).match(new RegExp(`<g class="alook-avatar-${part}">([\\s\\S]*?)</g>`))?.[1]
    if (!body) throw new Error(`Missing ${key}`)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="288" height="288" viewBox="0 0 36 36">${body}</svg>`
    const raw = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer()
    let left = 288, right = -1, top = 288, bottom = -1
    for (let y = 0; y < 288; y++) for (let x = 0; x < 288; x++) if (raw[(y * 288 + x) * 4 + 3]) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
    }
    if (right < left) throw new Error(`Empty ${key}`)
    const width = right - left + 1, height = bottom - top + 1
    const stride = Math.ceil(width / 2)
    const data = new Uint8Array(64 + stride * height)
    for (let color = 0; color < 2; color++) for (let alpha = 1; alpha <= 7; alpha++) {
      const offset = (color * 7 + alpha) * 4
      data.set([color * 255, color * 255, color * 255, Math.round(alpha * 255 / 7)], offset)
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = ((y + top) * 288 + x + left) * 4
      const alpha = Math.round(raw[offset + 3] * 7 / 255)
      const pixel = alpha === 0 ? 0 : (raw[offset] >= 128 ? 7 : 0) + alpha
      data[64 + y * stride + Math.floor(x / 2)] |= pixel << (x % 2 ? 0 : 4)
    }
    const name = key.replaceAll("-", "_")
    emit(name, data, width, height, "LV_IMG_CF_INDEXED_4BIT")
    features[part].push(`{&${name},${left},${top}}`)
  }
}
for (const part of ["eyes", "mouth"]) lines.push(`inline const Feature ${part}[] = {${features[part].join(",")}};`)
const logo = await sharp(await readFile(new URL("../../../assets/alook.svg", import.meta.url))).resize(180, 180).ensureAlpha().raw().toBuffer()
const packed = new Uint8Array(180 * 180 * 3)
for (let i = 0; i < 180 * 180; i++) {
  const color = ((logo[i * 4] >> 3) << 11) | ((logo[i * 4 + 1] >> 2) << 5) | (logo[i * 4 + 2] >> 3)
  packed.set([color & 255, color >> 8, logo[i * 4 + 3]], i * 3)
}
emit("logo", packed, 180, 180, "LV_IMG_CF_TRUE_COLOR_ALPHA")
lines.push("}")
await writeFile(new URL("face_assets.h", output), lines.join("\n") + "\n")
await writeFile(new URL("avatar_palettes.h", output), identity.join("\n") + "\n")
const seeds = ["", "Samara", "你好", "🫶", "touch-42", "a".repeat(31)]
await writeFile(new URL("../tests/avatar-golden.json", import.meta.url), JSON.stringify(seeds.map(seed => ({ seed, hash: avatarHash(seed), ...avatarThemeFromSeed(seed) })), null, 2) + "\n")
console.log(`Generated ${selected.size} exact Alook face parts and canonical logo in ${fileURLToPath(output)}`)
