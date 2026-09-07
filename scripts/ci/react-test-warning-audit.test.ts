import { EventEmitter } from "node:events"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import {
  auditExitCode,
  countRendererMounts,
  countWarnings,
  fullAuditCommand,
  loadAuditContract,
  migratedCommand,
  scanRendererInventory,
  streamCommand,
  validateInventory,
  validateWarningBudget,
} from "./react-test-warning-audit.mjs"

const patterns = {
  rendererDeprecation: "renderer warning",
  actEnvironment: "act warning",
}

function contract() {
  return {
    schemaVersion: 1,
    phase: "P0",
    maxWallTimeMs: 1_000,
    patterns,
    fresh: {
      warnings: { rendererDeprecation: 5, actEnvironment: 8 },
    },
    globalWarningReduction: { rendererDeprecation: 2 },
    expected: {
      rendererFiles: 1,
      rendererMounts: 2,
      warnings: { rendererDeprecation: 3 },
      warningExclusiveUpperBounds: { actEnvironment: 8 },
    },
    observedWarnings: { actEnvironment: [5, 7] },
    migratedFiles: ["src/web/src/example.dom.test.ts"],
    residual: [{ path: "src/web/src/example.test.ts", mounts: 2 }],
  }
}

function fakeChild(stdout: string, stderr: string, exitCode: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  queueMicrotask(() => {
    child.stdout.end(stdout)
    child.stderr.end(stderr)
    child.emit("close", exitCode)
  })
  return child
}

describe("react test warning audit", () => {
  it("counts default, namespace, named, aliased, and dynamic renderer mounts", () => {
    expect(countRendererMounts(`
      import TestRenderer, { act } from "react-test-renderer"
      import * as Renderer from "react-test-renderer"
      import { create, create as mount } from "react-test-renderer"
      TestRenderer.create(null)
      Renderer.create(null)
      create(null)
      mount(null)
      const LazyRenderer = await import("react-test-renderer")
      LazyRenderer.create(null)
    `)).toBe(5)
  })

  it("scans exact residual ownership including dynamic imports", () => {
    const root = mkdtempSync(join(tmpdir(), "alook-renderer-audit-"))
    try {
      const directory = join(root, "src/web/src")
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "example.test.ts"), `
        const TestRenderer = await import("react-test-renderer")
        TestRenderer.create(null)
        TestRenderer.create(null)
      `)
      writeFileSync(join(directory, "ignored.test.ts"), "export const value = 1")
      expect(scanRendererInventory(root)).toEqual([
        { path: "src/web/src/example.test.ts", mounts: 2 },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("counts only exact warning strings", () => {
    expect(countWarnings(
      "renderer warning\nrenderer warning extra\nact warning\nnot-act warning",
      patterns,
    )).toEqual({ rendererDeprecation: 2, actEnvironment: 2 })
  })

  it("rejects malformed contracts and exact residual drift", () => {
    const root = mkdtempSync(join(tmpdir(), "alook-renderer-contract-"))
    const validPath = join(root, "valid.json")
    const invalidPath = join(root, "invalid.json")
    const missingPatternPath = join(root, "missing-pattern.json")
    const invalidObservationPath = join(root, "invalid-observation.json")
    try {
      writeFileSync(validPath, JSON.stringify(contract()))
      writeFileSync(invalidPath, JSON.stringify({ schemaVersion: 2 }))
      writeFileSync(missingPatternPath, JSON.stringify({
        ...contract(),
        patterns: { rendererDeprecation: "renderer warning" },
      }))
      writeFileSync(invalidObservationPath, JSON.stringify({
        ...contract(),
        observedWarnings: { actEnvironment: [8] },
      }))
      expect(loadAuditContract(validPath)).toMatchObject({ phase: "P0" })
      expect(() => loadAuditContract(invalidPath)).toThrow("schemaVersion")
      expect(() => loadAuditContract(missingPatternPath)).toThrow("budget keys")
      expect(() => loadAuditContract(invalidObservationPath)).toThrow("observed warnings")
      expect(validateInventory(contract(), contract().residual)).toEqual([])
      expect(validateInventory(contract(), [
        { path: "src/web/src/other.test.ts", mounts: 2 },
      ])).toContain("renderer residual ownership differs from the contract")
      expect(validateInventory(contract(), [
        { path: "src/web/src/example.test.ts", mounts: 3 },
      ])).toContain("renderer mounts: expected 2, received 3")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("enforces exact budgets, exclusive ceilings, timeout, and child failure precedence", () => {
    const output = [
      "renderer warning",
      "renderer warning",
      "renderer warning",
      "act warning",
      "act warning",
      "act warning",
      "act warning",
      "act warning",
    ].join("\n")
    expect(validateWarningBudget(contract(), output, 999, 0)).toMatchObject({
      errors: [],
      exitCode: 0,
    })
    expect(validateWarningBudget(contract(), `${output}\nact warning\nact warning\nact warning`, 1, 0))
      .toMatchObject({
        errors: ["actEnvironment warnings: expected below 8, received 8"],
        exitCode: auditExitCode,
      })
    expect(validateWarningBudget(contract(), output, 1_001, 0)).toMatchObject({
      exitCode: auditExitCode,
    })
    expect(validateWarningBudget(contract(), "", 1, 7)).toMatchObject({ exitCode: 7 })
    const invalid = contract()
    invalid.expected.warnings.rendererDeprecation = 4
    expect(validateWarningBudget(invalid, output, 1, 0).errors)
      .toContain("rendererDeprecation warning budget does not equal fresh minus global reduction")
    const raisedUpperBound = contract()
    raisedUpperBound.expected.warningExclusiveUpperBounds.actEnvironment = 9
    expect(validateWarningBudget(raisedUpperBound, output, 1, 0).errors)
      .toContain("actEnvironment warning upper bound does not equal fresh baseline")
  })

  it("streams child output unchanged and preserves its exit code", async () => {
    const stdout = { write: vi.fn() }
    const stderr = { write: vi.fn() }
    const result = await streamCommand(["ignored"], {
      spawn: () => fakeChild("stdout body\n", "stderr body\n", 9),
      stdout,
      stderr,
    })
    expect(result).toMatchObject({
      exitCode: 9,
      output: "stdout body\nstderr body\n",
    })
    expect(stdout.write).toHaveBeenCalledWith(expect.any(Buffer))
    expect(stderr.write).toHaveBeenCalledWith(expect.any(Buffer))
  })

  it("locks migrated and full command topology", () => {
    expect(migratedCommand("src/web/src/example.dom.test.ts")).toContain("src/example.dom.test.ts")
    expect(() => migratedCommand("src/shared/example.test.ts")).toThrow("outside Web")
    expect(fullAuditCommand()).toEqual([
      "pnpm", "vitest", "run", "--project=web-node", "--project=web-dom",
      "--project=web-runtime", "--project=auth-node", "--project=auth-runtime",
      "--no-file-parallelism",
      "--maxWorkers=1", "--reporter=dot",
    ])
    expect(fullAuditCommand(["--coverage", "--project=web-dom"])).toEqual([
      "pnpm", "vitest", "run", "--no-file-parallelism", "--maxWorkers=1",
      "--reporter=dot", "--coverage", "--project=web-dom",
    ])
  })
})
