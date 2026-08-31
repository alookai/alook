import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cliCmd,
  daemonStartCmd,
  getAppMode,
  isLocalServiceEnvironment,
} from "./utils"

const originalWindow = globalThis.window

function setBrowser(hostname: string, tauri = false) {
  vi.stubGlobal("window", {
    ...(tauri ? { __TAURI__: {} } : {}),
    location: { hostname },
  })
}

describe("browser runtime and service environment", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    if (originalWindow === undefined) vi.unstubAllGlobals()
    else vi.stubGlobal("window", originalWindow)
  })

  it("keeps hosted Tauri in desktop mode while using production services", () => {
    setBrowser("alook.ai", true)

    expect(getAppMode()).toBe("desktop")
    expect(isLocalServiceEnvironment()).toBe(false)
    expect(cliCmd()).toBe("npx @alook/cli")
    expect(daemonStartCmd()).toBe("npx @alook/cli daemon start")
  })

  it("keeps localhost Tauri in desktop mode while using local services", () => {
    setBrowser("localhost", true)

    expect(getAppMode()).toBe("desktop")
    expect(isLocalServiceEnvironment()).toBe(true)
  })

  it("uses production services in a normal hosted browser", () => {
    setBrowser("alook.ai")

    expect(getAppMode()).toBe("production")
    expect(isLocalServiceEnvironment()).toBe(false)
  })

  it("uses production services during server rendering", () => {
    vi.unstubAllGlobals()

    expect(isLocalServiceEnvironment()).toBe(false)
  })

  it.each(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])(
    "uses local services for %s",
    (hostname) => {
      setBrowser(hostname)
      expect(isLocalServiceEnvironment()).toBe(true)
    },
  )

  it("uses local services for a development build independently of runtime mode", () => {
    vi.stubEnv("NODE_ENV", "development")
    setBrowser("alook.ai", true)

    expect(getAppMode()).toBe("desktop")
    expect(isLocalServiceEnvironment()).toBe(true)
  })
})
