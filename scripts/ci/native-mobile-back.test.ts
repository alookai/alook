import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../../src/desktop/src-tauri")
const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"))
const production = read("tauri.conf.json")
const development = read("tauri.dev.conf.json")
const capability = read("capabilities/native-back-mobile.json")
const listenerPermissions = ["core:app:allow-register-listener", "core:app:allow-remove-listener"]

describe("native Android Back listener capability", () => {
  it("restricts production listener commands to the trusted Android main document", () => {
    expect(production.app.withGlobalTauri).toBe(true)
    expect(production.app.security.capabilities).toContain("native-back-mobile")
    expect(capability).toMatchObject({
      identifier: "native-back-mobile",
      windows: ["main"],
      platforms: ["android"],
      local: false,
      remote: { urls: ["https://alook.ai"] },
      permissions: listenerPermissions,
    })
  })

  it("keeps development origin access separate and preserves the same command boundary", () => {
    const dev = development.app.security.capabilities.find((entry: { identifier?: string } | string) => (
      typeof entry !== "string" && entry.identifier === "native-back-dev"
    ))
    expect(dev).toMatchObject({
      windows: ["main"],
      platforms: ["android"],
      local: true,
      remote: { urls: ["http://localhost:3000"] },
      permissions: listenerPermissions,
    })
    expect(production.app.security.capabilities).not.toContain("native-back-dev")
    expect(development.app.security.capabilities).not.toContain("native-back-mobile")
  })
})
