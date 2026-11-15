import { spawnSync } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/mobile-release.yml"), "utf8").replace(/\r\n/g, "\n")
const iosJob = workflow.split("  build-ios:\n")[1].split("\n  build-android:")[0]
const verificationName = "Verify Rust LLVM tools"

function verificationScript(): string {
  const start = iosJob.indexOf(`      - name: ${verificationName}\n`)
  const end = iosJob.indexOf("      - name:", start + 1)
  const step = iosJob.slice(start, end < 0 ? undefined : end)
  const body = step.split("        run: |\n")[1]
  if (start < 0 || !body) throw new Error("Missing active Rust LLVM tool verification")
  return body.replace(/^          /gm, "")
}

type FixtureObservation = {
  directory: string
  phases: Array<{ phase: string; elapsedMs: number }>
  child?: { pid: number; status: number | null; signal: string | null; errorClass: string | null }
}

function observePhase<T>(observation: FixtureObservation | undefined, phase: string, operation: () => T): T {
  if (!observation) return operation()
  const started = performance.now()
  try { return operation() }
  finally {
    try { observation.phases.push({ phase, elapsedMs: performance.now() - started }) } catch {}
  }
}

function writeObservation(observation: FixtureObservation | undefined, host: string, state: string): void {
  if (!observation) return
  try {
    appendFileSync(join(observation.directory, `llvm-fixture-${process.pid}.jsonl`), JSON.stringify({
      scope: "test-local workflow shell observation",
      pid: process.pid, execPath: process.execPath, node: process.version,
      worker: process.env.VITEST_WORKER_ID ?? null, host, state,
      phases: observation.phases, child: observation.child,
    }) + "\n")
  } catch {}
}

it("installs the iOS LLVM prerequisite and checks it before caches or Swift builds", () => {
  const rust = iosJob.slice(iosJob.indexOf("      - name: Install Rust stable"), iosJob.indexOf(`      - name: ${verificationName}`))
  expect(rust).toMatch(/uses: dtolnay\/rust-toolchain@[a-f0-9]{40}(?:\s+#.*)?$/m)
  expect(rust).toMatch(/^          components: llvm-tools$/m)
  expect(rust).toContain("targets: aarch64-apple-ios,aarch64-apple-ios-sim")
  const verify = iosJob.indexOf(`      - name: ${verificationName}`)
  expect(verify).toBeGreaterThan(iosJob.indexOf("      - name: Install Rust stable"))
  const verification = iosJob.slice(verify, iosJob.indexOf("      - name: Restore Rust cache"))
  expect(verification).toContain("shell: bash")
  expect(verification).not.toMatch(/continue-on-error:|\sif:/)
  for (const name of ["Restore Rust cache", "Generate Xcode project", "Build signed App Store Connect IPA"]) {
    expect(iosJob.indexOf(`      - name: ${name}`)).toBeGreaterThan(verify)
  }
})

describe.skipIf(process.platform === "win32")("actual iOS LLVM prerequisite shell", () => {
  it.each([
    { host: "aarch64-apple-darwin", state: "available", status: 0 },
    { host: "x86_64-apple-darwin", state: "available", status: 0 },
    { host: "aarch64-apple-darwin", state: "missing", status: 1 },
    { host: "aarch64-apple-darwin", state: "not-executable", status: 1 },
    { host: "aarch64-apple-darwin", state: "broken", status: 29 },
  ])("uses the active $host sysroot with a $state tool", ({ host, state, status }) => {
    const directory = process.env.ALOOK_LLVM_PHASE_DIR
    const observation: FixtureObservation | undefined = directory ? { directory, phases: [] } : undefined
    const root = observePhase(observation, "temporary-root", () => mkdtempSync(join(tmpdir(), "alook-ios-llvm-")))
    try {
      const bin = join(root, "bin")
      const sysroot = join(root, "active toolchain with spaces")
      const toolDirectory = join(sysroot, "lib/rustlib", host, "bin")
      const foreignToolDirectory = join(root, "other toolchain/lib/rustlib", host, "bin")
      observePhase(observation, "setup", () => {
        for (const directory of [bin, toolDirectory, foreignToolDirectory]) mkdirSync(directory, { recursive: true })
        writeFileSync(join(bin, "rustc"), `#!/bin/sh
case "$*" in
  '--print sysroot') printf '%s\\n' "$FIXTURE_SYSROOT" ;;
  '-vV') printf 'host: %s\\n' "$FIXTURE_HOST" ;;
  *) exit 31 ;;
esac
`, { mode: 0o755 })
        const foreignTool = "#!/bin/sh\nprintf 'FOREIGN_OBJCOPY\\n'\n"
        writeFileSync(join(bin, "llvm-objcopy"), foreignTool, { mode: 0o755 })
        writeFileSync(join(foreignToolDirectory, "llvm-objcopy"), foreignTool, { mode: 0o755 })
        if (state !== "missing") {
          writeFileSync(join(toolDirectory, "llvm-objcopy"), `#!/bin/sh
test "$1" = '--version' || exit 32
printf 'ACTIVE_OBJCOPY\\n'
exit "$FIXTURE_TOOL_STATUS"
`, { mode: state === "not-executable" ? 0o644 : 0o755 })
        }
      })
      const result = observePhase(observation, "bash", () => spawnSync("bash", ["-c", verificationScript()], {
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          FIXTURE_SYSROOT: sysroot,
          FIXTURE_HOST: host,
          FIXTURE_TOOL_STATUS: state === "broken" ? "29" : "0",
        },
        encoding: "utf8",
        timeout: 10_000,
      }))
      if (observation) observation.child = { pid: result.pid, status: result.status, signal: result.signal, errorClass: result.error?.name ?? null }
      observePhase(observation, "assertions", () => {
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(status)
        expect(result.stdout).not.toContain("FOREIGN_OBJCOPY")
        if (state === "available" || state === "broken") expect(result.stdout).toContain("ACTIVE_OBJCOPY")
        else expect(result.stdout).not.toContain("ACTIVE_OBJCOPY")
      })
    } finally {
      try { observePhase(observation, "cleanup", () => rmSync(root, { recursive: true, force: true })) }
      finally { writeObservation(observation, host, state) }
    }
  })
})
