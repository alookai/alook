import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import { webcrypto } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { builtPrecacheEntries } from "./dev-zone-processes.mjs"
import { describe, expect, it } from "vitest"

const webRoot = fileURLToPath(new URL("../", import.meta.url))
const { build } = createRequire(import.meta.resolve("@serwist/turbopack"))("esbuild") as {
  build: (options: Record<string, unknown>) => Promise<{ outputFiles: Array<{ text: string }>; metafile: { inputs: Record<string, unknown> } }>
}
const shell = `/community-shell/${"a".repeat(64)}`
const options = {
  absWorkingDir: webRoot, bundle: true, write: false, metafile: true, platform: "browser", format: "iife", minify: true, sourcemap: false, logLevel: "silent",
  define: { "process.env.NODE_ENV": JSON.stringify("production"), "self.__SW_MANIFEST": JSON.stringify([{ url: shell, revision: "unit-shell" }]) },
}
function workerGlobal() {
  const listeners: string[] = []
  const addEventListener = (type: string) => { listeners.push(type) }
  const location = new URL("https://worker.example.test/sw.js")
  const worker = { location, addEventListener, removeEventListener: () => {}, skipWaiting: async () => {},
    registration: { scope: "https://worker.example.test/", navigationPreload: { enable: async () => {} } },
    clients: { claim: async () => {}, matchAll: async () => [] },
  }
  return { listeners, context: { self: worker, location, addEventListener, URL, Request, Response, Headers, console, crypto: webcrypto, setTimeout, clearTimeout, caches: {} } }
}

describe("actual SW entry isolated browser dependency bundle", () => {
  it("loads the unique version leaf and registers worker listeners without Node globals", async () => {
    const output = await build({ ...options, entryPoints: [resolve(webRoot, "src/app/sw.ts")] })
    const inputs = Object.keys(output.metafile.inputs).map(path => path.replaceAll("\\", "/"))
    expect(inputs.some(path => path.endsWith("shared/src/business-schema-version.ts"))).toBe(true)
    expect(inputs.some(path => /shared\/src\/(index\.ts|constants\.ts|db\/)/.test(path))).toBe(false)
    expect(builtPrecacheEntries(output.outputFiles[0]!.text)).toEqual([{ url: shell, revision: "unit-shell" }])
    const fixture = workerGlobal()
    expect(fixture.context).not.toHaveProperty("process")
    expect(fixture.context).not.toHaveProperty("Buffer")
    expect(() => runInNewContext(output.outputFiles[0]!.text, fixture.context, { timeout: 1000 })).not.toThrow()
    for (const name of ["install", "activate", "fetch", "message"]) expect(fixture.listeners).toContain(name)
    console.info(JSON.stringify({ case: "isolated-actual-sw-entry-browser-global", bytes: output.outputFiles[0]!.text.length, listeners: fixture.listeners, sharedInputs: inputs.filter(path => path.includes("shared/src/")) }))
  })
  it("detects the old broad version dependency rather than supplying a process shim", async () => {
    const output = await build({ ...options, stdin: { contents: 'import { BUSINESS_SCHEMA_VERSION } from "@alook/shared";self.addEventListener("message",()=>BUSINESS_SCHEMA_VERSION)', resolveDir: webRoot, sourcefile: "old-root-version-dependency.ts" } })
    expect(Object.keys(output.metafile.inputs).some(path => path.endsWith("shared/src/constants.ts"))).toBe(true)
    const fixture = workerGlobal()
    expect(() => runInNewContext(output.outputFiles[0]!.text, fixture.context, { timeout: 1000 })).toThrow("process is not defined")
    expect(fixture.listeners).toEqual([])
  })
})
