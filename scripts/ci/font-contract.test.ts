import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const appRoot = resolve(import.meta.dirname, "../../src/web/src/app")
const layout = readFileSync(resolve(appRoot, "layout.tsx"), "utf8")
const ogRoute = readFileSync(resolve(appRoot, "og/route.tsx"), "utf8")
const fontDefinitions = readFileSync(resolve(appRoot, "fonts.ts"), "utf8")

describe("web font contract", () => {
  it("keeps layout and Open Graph rendering independent of Google Fonts", () => {
    for (const source of [layout, ogRoute, fontDefinitions]) {
      expect(source).not.toMatch(/next\/font\/google|fonts\.googleapis\.com|fonts\.gstatic\.com/)
    }
  })

  it("references committed local font files", () => {
    const paths = [...fontDefinitions.matchAll(/(?:src|path): "\.\/fonts\/([^\"]+)"/g)]
      .map((match) => match[1])
      .concat("dm-sans-600.ttf")

    expect(paths).toHaveLength(8)
    for (const path of paths) {
      expect(existsSync(resolve(appRoot, "fonts", path))).toBe(true)
    }
  })
})
