import { afterEach, expect, it, vi } from "vitest"
import { buildSync } from "esbuild"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import { normalizeConfig } from "next/dist/server/config-shared"
import { PHASE_DEVELOPMENT_SERVER } from "next/constants"
const webRoot = fileURLToPath(new URL("../", import.meta.url))
const require = createRequire(import.meta.url)
const compiled = buildSync({ entryPoints: [webRoot + "next.config.ts"], bundle: true, write: false, platform: "node", format: "cjs", packages: "external" }).outputFiles[0].text
function loadConfig(initialize: () => Promise<void>) {
  const compiledModule = { exports: {} as { default?: Parameters<typeof normalizeConfig>[1] } }
  runInNewContext(compiled, { module: compiledModule, exports: compiledModule.exports, __dirname: webRoot, process, require: (name: string) => name === "@opennextjs/cloudflare" ? { initOpenNextCloudflareForDev: initialize } : name === "@serwist/turbopack" ? { withSerwist: (config: unknown) => config } : require(name) })
  return compiledModule.exports.default
}
afterEach(() => { vi.unstubAllEnvs() })
it.each([undefined, "1"])("waits for native Cloudflare context initialization before Next gets config: %s", async enabled => {
  vi.stubEnv("ALOOK_DEV_REMOTE_AI", enabled)
  let release!: () => void
  const initialize = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const config = loadConfig(initialize)
  let settled = false
  const pending = normalizeConfig(PHASE_DEVELOPMENT_SERVER, config).then(value => { settled = true; return value })
  await Promise.resolve()
  await Promise.resolve()
  try {
    expect(initialize).toHaveBeenCalledWith({ remoteBindings: enabled === "1" })
    expect(settled).toBe(false)
  } finally { release() }
  const result = await pending
  expect(result.images?.unoptimized).toBe(true)
})
it("propagates native initialization failure before Next can start with a missing context", async () => {
  const failure = Promise.reject(new Error("artificial native initialization failure"))
  void failure.catch(() => undefined)
  const config = loadConfig(() => failure)
  await expect(normalizeConfig(PHASE_DEVELOPMENT_SERVER, config)).rejects.toThrow("artificial native initialization failure")
})
