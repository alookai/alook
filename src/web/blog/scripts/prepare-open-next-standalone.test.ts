import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
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

  it("rejects a missing nested standalone tree", () => {
    const root = mkdtempSync(join(tmpdir(), "alook-blog-standalone-missing-"))

    expect(() => prepareOpenNextStandalone(root)).toThrow("Nested Blog standalone output is missing")
  })

  it("rejects an invalid instrumentation trace", () => {
    const root = mkdtempSync(join(tmpdir(), "alook-blog-standalone-invalid-instrumentation-"))
    mkdirSync(join(root, "blog/.next/standalone/src/web/blog/.next/server"), { recursive: true })
    mkdirSync(join(root, "blog/.next/server"), { recursive: true })
    writeFileSync(join(root, "blog/.next/server/instrumentation.js.nft.json"), '{"files":42}')

    expect(() => prepareOpenNextStandalone(root)).toThrow("Invalid instrumentation trace")
  })

  it("rejects a missing instrumentation dependency", () => {
    const root = mkdtempSync(join(tmpdir(), "alook-blog-standalone-missing-instrumentation-"))
    mkdirSync(join(root, "blog/.next/standalone/src/web/blog/.next/server"), { recursive: true })
    mkdirSync(join(root, "blog/.next/server"), { recursive: true })
    writeFileSync(
      join(root, "blog/.next/server/instrumentation.js.nft.json"),
      JSON.stringify({ files: ["./chunks/missing.js"] }),
    )

    expect(() => prepareOpenNextStandalone(root)).toThrow("Missing instrumentation dependency")
  })

  it("rejects an invalid OG route trace", () => {
    const root = mkdtempSync(join(tmpdir(), "alook-blog-standalone-invalid-og-"))
    const tracePath = join(root, "blog/.next/server/app/og/blog/[slug]/route.js.nft.json")
    mkdirSync(join(root, "blog/.next/standalone/src/web/blog/.next/server"), { recursive: true })
    mkdirSync(dirname(tracePath), { recursive: true })
    writeFileSync(tracePath, '{"files":42}')

    expect(() => prepareOpenNextStandalone(root)).toThrow("Invalid OG route trace")
  })

  it("ignores an OG trace without the Vercel OG node runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "alook-blog-standalone-no-og-runtime-"))
    const tracePath = join(root, "blog/.next/server/app/og/blog/[slug]/route.js.nft.json")
    mkdirSync(join(root, "blog/.next/standalone/src/web/blog/.next/server"), { recursive: true })
    mkdirSync(dirname(tracePath), { recursive: true })
    writeFileSync(tracePath, JSON.stringify({ files: ["./unrelated.js"] }))

    prepareOpenNextStandalone(root)

    expect(JSON.parse(readFileSync(tracePath, "utf8"))).toEqual({ files: ["./unrelated.js"] })
  })

  it("rejects a missing standalone OG runtime file", () => {
    const root = mkdtempSync(join(tmpdir(), "alook-blog-standalone-missing-og-runtime-"))
    const nextRoot = join(root, "blog/.next")
    const tracePath = join(nextRoot, "server/app/og/blog/[slug]/route.js.nft.json")
    const originalNode = join(root, "node_modules/next/dist/compiled/@vercel/og/index.node.js")
    mkdirSync(join(nextRoot, "standalone/src/web/blog/.next/server"), { recursive: true })
    mkdirSync(dirname(tracePath), { recursive: true })
    writeFileSync(tracePath, JSON.stringify({ files: [relative(dirname(tracePath), originalNode)] }))

    expect(() => prepareOpenNextStandalone(root)).toThrow(
      "Missing standalone @vercel/og runtime source",
    )
  })

  it("adds standalone OG runtime files to the route trace", () => {
    const root = mkdtempSync(join(tmpdir(), "alook-blog-standalone-og-"))
    const nextRoot = join(root, "blog/.next")
    const tracePath = join(nextRoot, "server/app/og/blog/[slug]/route.js.nft.json")
    const nestedNext = join(nextRoot, "standalone/src/web/blog/.next")
    const originalNode = join(root, "node_modules/next/dist/compiled/@vercel/og/index.node.js")
    const tracedNodePath = relative(dirname(tracePath), originalNode)
    const standaloneOg = join(nextRoot, "standalone/src/web/node_modules/next/dist/compiled/@vercel/og")

    mkdirSync(join(nestedNext, "server"), { recursive: true })
    mkdirSync(dirname(tracePath), { recursive: true })
    mkdirSync(standaloneOg, { recursive: true })
    writeFileSync(tracePath, JSON.stringify({ files: [tracedNodePath] }))
    writeFileSync(join(standaloneOg, "index.edge.js"), "edge-runtime")
    writeFileSync(join(standaloneOg, "yoga.wasm"), "wasm-runtime")

    prepareOpenNextStandalone(root)
    prepareOpenNextStandalone(root)

    const trace = JSON.parse(readFileSync(tracePath, "utf8")) as { files: string[] }
    expect(trace.files).toEqual([
      tracedNodePath,
      tracedNodePath.replace(/index\.node\.js$/, "index.edge.js"),
      tracedNodePath.replace(/index\.node\.js$/, "yoga.wasm"),
    ])
  })
})
