import { describe, it, expect, vi, beforeEach } from "vitest"
import { existsSync } from "node:fs"
import { execSync } from "node:child_process"
import { findChrome, hasChromeInstalled, ensureChrome } from "./chrome-finder"

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}))
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}))

const mockExistsSync = vi.mocked(existsSync)
const mockExecSync = vi.mocked(execSync) as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
})

describe("findChrome", () => {
  it("returns first matching path on macOS", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "darwin" })

    mockExistsSync.mockImplementation((p) =>
      p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    )

    expect(findChrome()).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("tries linux which fallback when no path matches", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux" })

    mockExistsSync.mockReturnValue(false)
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("which")) return "/usr/local/bin/google-chrome"
      return ""
    })

    expect(findChrome()).toBe("/usr/local/bin/google-chrome")

    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("returns null when nothing found", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux" })

    mockExistsSync.mockReturnValue(false)
    mockExecSync.mockImplementation(() => { throw new Error("not found") })

    expect(findChrome()).toBeNull()

    Object.defineProperty(process, "platform", { value: originalPlatform })
  })
})

describe("hasChromeInstalled", () => {
  it("returns true when findChrome returns a path", () => {
    mockExistsSync.mockImplementation((p) =>
      p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    )
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "darwin" })

    expect(hasChromeInstalled()).toBe(true)

    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("returns false when no Chrome found", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux" })

    mockExistsSync.mockReturnValue(false)
    mockExecSync.mockImplementation(() => { throw new Error("not found") })

    expect(hasChromeInstalled()).toBe(false)

    Object.defineProperty(process, "platform", { value: originalPlatform })
  })
})

describe("ensureChrome", () => {
  it("returns existing Chrome without installing", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "darwin" })

    mockExistsSync.mockImplementation((p) =>
      p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    )

    expect(ensureChrome()).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining("playwright install"),
      expect.anything(),
    )

    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("installs Chromium when Chrome not found and returns path", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "darwin" })

    let installCalled = false
    mockExistsSync.mockImplementation((p) => {
      if (!installCalled) return false
      return p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    })
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("playwright install chromium")) {
        installCalled = true
        return ""
      }
      if (typeof cmd === "string" && cmd.includes("dry-run")) return ""
      throw new Error("not found")
    })

    expect(ensureChrome()).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("throws when install fails", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux" })

    mockExistsSync.mockReturnValue(false)
    mockExecSync.mockImplementation(() => { throw new Error("install failed") })

    expect(() => ensureChrome()).toThrow()

    Object.defineProperty(process, "platform", { value: originalPlatform })
  })
})
