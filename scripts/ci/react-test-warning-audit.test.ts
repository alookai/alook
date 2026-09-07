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
  maxWallTimeMs,
  scanRendererInventory,
  streamCommand,
  validateZeroAudit,
} from "./react-test-warning-audit.mjs"

const patterns = {
  rendererDeprecation: "renderer warning",
  actEnvironment: "act warning",
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

  it("enforces permanent zero inventory, zero warnings, timeout, and child precedence", () => {
    expect(validateZeroAudit([], "clean output", maxWallTimeMs, 0)).toMatchObject({
      errors: [],
      exitCode: 0,
    })
    expect(validateZeroAudit(
      [{ path: "src/web/src/example.test.ts", mounts: 2 }],
      "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer",
      1,
      0,
    )).toMatchObject({
      errors: [
        "renderer files: expected 0, received 1",
        "renderer mounts: expected 0, received 2",
        "rendererDeprecation warnings: expected 0, received 1",
      ],
      exitCode: auditExitCode,
    })
    expect(validateZeroAudit([], "", maxWallTimeMs + 1, 0)).toMatchObject({
      exitCode: auditExitCode,
    })
    expect(validateZeroAudit([], "", 1, 7)).toMatchObject({ exitCode: 7 })
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

  it("locks the full command topology", () => {
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
