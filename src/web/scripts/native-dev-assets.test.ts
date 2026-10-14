import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_EXPORT,
  PHASE_INFO,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
  PHASE_TEST,
} from "next/constants"

vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: vi.fn() }))

import resolveConfig from "../next.config"

const require = createRequire(import.meta.url)
const { getAssetPrefix } = require("next/dist/client/asset-prefix") as typeof import("next/dist/client/asset-prefix")
const { getSocketUrl } = require("next/dist/client/dev/hot-reloader/get-socket-url") as typeof import("next/dist/client/dev/hot-reloader/get-socket-url")
const { blockCrossSiteDEV } = require("next/dist/server/lib/router-utils/block-cross-site-dev") as typeof import("next/dist/server/lib/router-utils/block-cross-site-dev")

class AssetScript {
  constructor(readonly src: string) {}
}

function installDocument(documentUrl: string, scriptUrl: string) {
  vi.stubGlobal("window", { location: new URL(documentUrl) })
  vi.stubGlobal("document", { currentScript: new AssetScript(scriptUrl) })
  vi.stubGlobal("HTMLScriptElement", AssetScript)
  vi.stubGlobal("self", {})
}

function bootstrapPrefix(documentUrl: string, scriptUrl: string): string {
  installDocument(documentUrl, scriptUrl)
  const { appBootstrap } = require("next/dist/client/app-bootstrap") as typeof import("next/dist/client/app-bootstrap")
  const prefixes: string[] = []
  appBootstrap((prefix) => prefixes.push(prefix))
  expect(prefixes).toHaveLength(1)
  return prefixes[0]!
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("native development assets", () => {
  it("uses the public development phase for the existing root ingress", () => {
    expect(resolveConfig(PHASE_DEVELOPMENT_SERVER).assetPrefix).toBe("http://localhost:3000")
  })

  it.each([
    PHASE_PRODUCTION_BUILD,
    PHASE_PRODUCTION_SERVER,
    PHASE_EXPORT,
    PHASE_TEST,
    PHASE_INFO,
    "unknown-phase",
  ])("preserves the ordinary config outside the development phase: %s", (phase) => {
    const { assetPrefix: devPrefix, ...devConfig } = resolveConfig(PHASE_DEVELOPMENT_SERVER)
    const { assetPrefix, ...config } = resolveConfig(phase)
    expect(devPrefix).toBe("http://localhost:3000")
    expect(assetPrefix).toBeUndefined()
    expect(config).toEqual(devConfig)
  })

  it.each([
    ["http://tauri.localhost/c", "http://localhost:3000/_next/static/chunks/main.js", "http://localhost:3000", "ws://localhost:3000/_next/hmr"],
    ["tauri://localhost/c", "http://localhost:3000/_next/static/chunks/main.js", "http://localhost:3000", "ws://localhost:3000/_next/hmr"],
    ["http://tauri.localhost/c", "https://localhost:3000/prefix/_next/static/chunks/main.js", "https://localhost:3000/prefix", "wss://localhost:3000/prefix/_next/hmr"],
  ])("passes the actual cross-origin script prefix through bootstrap to the original socket helper: %s", (documentUrl, scriptUrl, expectedPrefix, expectedSocket) => {
    vi.stubEnv("__NEXT_DEV_SERVER", "1")
    const prefix = bootstrapPrefix(documentUrl, scriptUrl)
    expect(prefix).toBe(expectedPrefix)
    expect(`${getSocketUrl(prefix)}/_next/hmr`).toBe(expectedSocket)
  })

  it.each([
    ["http://localhost:3000/c", "http://localhost:3000/_next/static/chunks/main.js", "", "ws://localhost:3000/_next/hmr"],
    ["http://localhost:3000/blog", "http://localhost:3000/blog-static/_next/static/chunks/blog.js", "/blog-static", "ws://localhost:3000/blog-static/_next/hmr"],
  ])("retains same-origin root and Blog path behavior: %s", (documentUrl, scriptUrl, expectedPrefix, expectedSocket) => {
    vi.stubEnv("__NEXT_DEV_SERVER", "1")
    const prefix = bootstrapPrefix(documentUrl, scriptUrl)
    expect(prefix).toBe(expectedPrefix)
    expect(`${getSocketUrl(prefix)}/_next/hmr`).toBe(expectedSocket)
  })

  it.each([undefined, ""])("keeps the original non-dev prefix even with development NODE_ENV: %s", (devServer) => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("__NEXT_DEV_SERVER", devServer)
    const prefix = bootstrapPrefix("http://tauri.localhost/c", "http://localhost:3000/prefix/_next/static/chunks/main.js")
    expect(prefix).toBe("/prefix")
    expect(`${getSocketUrl(prefix)}/_next/hmr`).toBe("ws://tauri.localhost/prefix/_next/hmr")
  })

  it.each(["file:///prefix/_next/static/chunks/main.js", "tauri://localhost/prefix/_next/static/chunks/main.js"])("keeps the original path for a non-HTTP script: %s", (scriptUrl) => {
    vi.stubEnv("__NEXT_DEV_SERVER", "1")
    expect(bootstrapPrefix("http://tauri.localhost/c", scriptUrl)).toBe("/prefix")
  })

  it("preserves the invalid currentScript error", () => {
    vi.stubEnv("__NEXT_DEV_SERVER", "1")
    installDocument("http://tauri.localhost/c", "http://localhost:3000/_next/static/chunks/main.js")
    vi.stubGlobal("document", { currentScript: null })
    expect(() => getAssetPrefix()).toThrow(/Expected document.currentScript to be a <script> element/)
  })

  it("preserves the missing Next path error", () => {
    vi.stubEnv("__NEXT_DEV_SERVER", "1")
    installDocument("http://tauri.localhost/c", "http://localhost:3000/unrelated.js")
    expect(() => getAssetPrefix()).toThrow(/Expected document.currentScript src to contain '\/_next\/'/)
  })
})

describe("unchanged Next development source gate", () => {
  it.each([
    ["http://tauri.localhost", false],
    ["tauri://localhost", false],
    ["null", true],
    ["https://foreign.invalid", true],
  ])("retains the original origin decision for %s", (origin, blocked) => {
    const request = { url: "/_next/hmr", headers: { origin } } as IncomingMessage
    const response = { statusCode: 200, end: vi.fn() } as unknown as ServerResponse
    expect(blockCrossSiteDEV(request, response, undefined, "127.0.0.1")).toBe(blocked)
    expect(response.statusCode).toBe(blocked ? 403 : 200)
    expect(response.end).toHaveBeenCalledTimes(blocked ? 1 : 0)
  })

  it("rejects a cross-site script with no allowlistable source", () => {
    const request = {
      url: "/_next/static/chunks/main.js",
      headers: { "sec-fetch-mode": "no-cors", "sec-fetch-site": "cross-site" },
    } as IncomingMessage
    const response = { statusCode: 200, end: vi.fn() } as unknown as ServerResponse
    expect(blockCrossSiteDEV(request, response, undefined, "127.0.0.1")).toBe(true)
    expect(response.statusCode).toBe(403)
  })

  it("preserves Next's separate no-Origin GET behavior", () => {
    const request = { url: "/_next/static/chunks/main.js", headers: {} } as IncomingMessage
    const response = { statusCode: 200, end: vi.fn() } as unknown as ServerResponse
    expect(blockCrossSiteDEV(request, response, undefined, "127.0.0.1")).toBe(false)
    expect(response.end).not.toHaveBeenCalled()
  })
})

type PrefixMap = {
  version: number
  sources: string[]
  sourcesContent: string[]
  mappings: string
}

type MappingConsumer = {
  originalPositionFor(position: { line: number; column: number }): { source: string | null; line: number | null }
}

const { SourceMapConsumer } = require("next/dist/compiled/source-map") as {
  SourceMapConsumer: new (map: PrefixMap) => MappingConsumer
}

describe("installed Next prefix source maps", () => {
  it.each(["next/dist/client/asset-prefix.js", "next/dist/esm/client/asset-prefix.js"])("maps actual generated decision tokens to the changed source: %s", (entry) => {
    const filename = require.resolve(entry)
    const lines = readFileSync(filename, "utf8").split("\n")
    const map = JSON.parse(readFileSync(`${filename}.map`, "utf8")) as PrefixMap
    const source = map.sourcesContent[0]!.split("\n")
    const consumer = new SourceMapConsumer(map)
    for (const token of ["process.env.__NEXT_DEV_SERVER", "origin !== window.location.origin", "origin + prefix"]) {
      const generatedIndex = lines.findIndex((line) => line.includes(token))
      expect(generatedIndex, token).toBeGreaterThanOrEqual(0)
      const position = consumer.originalPositionFor({ line: generatedIndex + 1, column: lines[generatedIndex]!.indexOf(token) })
      expect(position.source).toBe(map.sources[0])
      expect(position.line).not.toBeNull()
      expect(source[position.line! - 1], token).toContain(token)
    }
    const counterpart = require.resolve(entry.includes("/esm/") ? "next/dist/client/asset-prefix.js" : "next/dist/esm/client/asset-prefix.js")
    const otherMap = JSON.parse(readFileSync(`${counterpart}.map`, "utf8")) as PrefixMap
    expect(otherMap.sourcesContent).toEqual(map.sourcesContent)
  })
})
