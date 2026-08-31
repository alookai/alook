import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { prepareOpenNextStandalone } from "./prepare-open-next-standalone"

describe("prepareOpenNextStandalone", () => {
  it("maps the nested Next standalone tree to the single package root", () => {
    const root = mkdtempSync(join(tmpdir(), "alook-blog-standalone-"))
    const nestedNext = join(root, "blog/.next/standalone/src/web/blog/.next")
    mkdirSync(join(nestedNext, "server"), { recursive: true })
    mkdirSync(join(root, "blog/.next/server/chunks"), { recursive: true })
    writeFileSync(join(root, "blog/.next/server/instrumentation.js"), "export {}")
    writeFileSync(
      join(root, "blog/.next/server/instrumentation.js.nft.json"),
      JSON.stringify({ version: 1, files: ["./chunks/instrumentation.js"] }),
    )
    writeFileSync(join(root, "blog/.next/server/chunks/instrumentation.js"), "export const traced = true")

    prepareOpenNextStandalone(root)
    prepareOpenNextStandalone(root)

    expect(existsSync(join(nestedNext, "server/instrumentation.js"))).toBe(true)
    expect(readFileSync(join(nestedNext, "server/chunks/instrumentation.js"), "utf8")).toBe(
      "export const traced = true",
    )
  })
})
