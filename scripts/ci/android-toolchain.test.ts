import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

const { readFileSync: actualReadFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs")
const helper = fileURLToPath(new URL("./android-toolchain.mjs", import.meta.url))
const policyPath = fileURLToPath(new URL("../../src/desktop/src-tauri/gen/android/gradle.properties", import.meta.url))
const policy = actualReadFileSync(policyPath, "utf8")
let originalArgv: string[]
let originalExitCode: typeof process.exitCode

function captureOutput() {
  return {
    stdout: vi.spyOn(process.stdout, "write").mockImplementation(() => true),
    stderr: vi.spyOn(process.stderr, "write").mockImplementation(() => true),
  }
}

beforeEach(() => {
  originalArgv = [...process.argv]
  originalExitCode = process.exitCode
  vi.resetModules()
  vi.mocked(readFileSync).mockReset().mockImplementation(actualReadFileSync)
})

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv)
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
  vi.mocked(readFileSync).mockReset()
})

describe("Android toolchain CLI entry", () => {
  it.each([undefined, `${helper}.other`])("does not run for another entry path: %s", async argvPath => {
    process.argv.splice(0, process.argv.length, process.execPath, ...(argvPath ? [argvPath] : []))
    process.exitCode = 17
    const { stdout, stderr } = captureOutput()

    await import("./android-toolchain.mjs")

    expect(readFileSync).not.toHaveBeenCalled()
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(17)
  })

  it("prints the tracked SDK components from the actual direct entry", async () => {
    process.argv.splice(0, process.argv.length, process.execPath, helper)
    process.exitCode = undefined
    const { stdout, stderr } = captureOutput()
    const value = (name: string) => policy.match(new RegExp(`^alook\\.${name}=(.+)$`, "m"))![1]

    await import("./android-toolchain.mjs")

    expect(readFileSync).toHaveBeenCalledExactlyOnceWith(policyPath, "utf8")
    expect(stdout).toHaveBeenCalledExactlyOnceWith(`platforms;android-${value("compileSdk")}\nbuild-tools;${value("buildTools")}\nndk;${value("ndk")}\n`)
    expect(stderr).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it.each([
    { name: "compileSdk", replacement: "36.0" },
    { name: "gradle", replacement: "9" },
    { name: "ndk", replacement: undefined },
  ])("rejects an invalid or missing $name without partial SDK output", async ({ name, replacement }) => {
    const invalidPolicy = policy.replace(new RegExp(`^alook\\.${name}=.*$`, "m"), replacement === undefined ? "" : `alook.${name}=${replacement}`)
    vi.mocked(readFileSync).mockReturnValueOnce(invalidPolicy)
    process.argv.splice(0, process.argv.length, process.execPath, helper)
    process.exitCode = undefined
    const { stdout, stderr } = captureOutput()

    await import("./android-toolchain.mjs")

    expect(readFileSync).toHaveBeenCalledExactlyOnceWith(policyPath, "utf8")
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledExactlyOnceWith(`Invalid supported Android selection: alook.${name}\n`)
    expect(process.exitCode).toBe(1)
  })

  it("reports a policy read failure with a failing exit code", async () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error("Android policy unavailable") })
    process.argv.splice(0, process.argv.length, process.execPath, helper)
    process.exitCode = undefined
    const { stdout, stderr } = captureOutput()

    await import("./android-toolchain.mjs")

    expect(readFileSync).toHaveBeenCalledExactlyOnceWith(policyPath, "utf8")
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledExactlyOnceWith("Android policy unavailable\n")
    expect(process.exitCode).toBe(1)
  })
})
