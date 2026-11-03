import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { projectFullReason, selectUnitSpecifications, unitProjects } from "./run-unit-tests.mjs"

const spec = (project: string, file: string) => ({ project: { name: project }, moduleId: resolve(file) })
const plan = (path: string, status = "M") => ({
  full: false, plan_hash: "selection-fixture", paths: [path],
  changes: [{ path, status }], suites: { unit_tasks: ["@alook/web#test"], smoke: [] },
})

describe("native unit selection boundary", () => {
  it("admits the App filesystem contract when the native import graph has no related files", async () => {
    const app = { ...plan("src/web/src/lib/worker-runtime.ts"), suites: { unit_tasks: ["@alook/app#test"], smoke: [] } }
    const packed = spec("@alook/app", "src/app/test/packed-artifact.test.ts")
    const ordinary = spec("@alook/app", "src/app/test/index.test.ts")
    const ctx = { globTestSpecifications: async () => [packed, ordinary, spec("web-node", "src/web/src/lib/worker-runtime.test.ts")], getRelevantTestSpecifications: async () => [] }
    const selected = await selectUnitSpecifications(ctx, app, unitProjects(app))
    expect(selected.specs).toEqual(expect.arrayContaining([packed, ordinary]))
    expect(selected.specs).toHaveLength(2)
    expect(selected.receipt.fallback).toBeNull()
  })

  it("delegates the seven process and package cases only in CI", async () => {
    const files = [
      "src/daemon/agent-driver/src/pack.test.ts",
      "src/daemon/src/cli/daemonLifecycle.real.test.ts",
      "src/daemon/src/cli/diagnosticsLifecycle.real.test.ts",
      "src/daemon/src/cli/daemonStop.test.ts",
      "src/daemon/src/version.packed.test.ts",
      "src/daemon/src/agent-driver-bundle.packed.test.ts",
      "src/daemon/src/cli/daemonSelfUpdate.real.test.ts",
    ]
    const ordinary = spec("daemon-node", "src/daemon/src/config.test.ts")
    const all = [...files.map(file => spec(file.includes("agent-driver/src") ? "@alook/agent-driver" : "daemon-node", file)), ordinary]
    const ctx = { globTestSpecifications: async () => all }
    const scope = { projects: ["daemon-node", "@alook/agent-driver"], fullProjects: [], smoke: [] }
    const full = { ...plan("source.ts"), full: true }
    const selected = await selectUnitSpecifications(ctx, full, scope, { ci: true })
    expect(selected.specs).toEqual([ordinary])
    expect(selected.receipt.delegated_files.map(file => file.file).sort()).toEqual(files.sort())
    expect((await selectUnitSpecifications(ctx, full, scope)).specs).toHaveLength(8)
  })

  it("keeps native related, direct changed tests, and project contracts once per identity", async () => {
    const direct = spec("web-node", "direct.test.ts")
    const related = spec("web-dom", "related.dom.test.ts")
    const contract = spec("web-contracts", "architecture.test.ts")
    const unrelated = spec("web-node", "unrelated.test.ts")
    const ctx = {
      globTestSpecifications: vi.fn(async () => [direct, related, contract, unrelated, spec("blog-node", "foreign.test.ts")]),
      getRelevantTestSpecifications: vi.fn(async () => [related, related, spec("blog-node", "foreign.test.ts")]),
    }
    const result = await selectUnitSpecifications(ctx, plan("direct.test.ts"), {
      projects: ["web-node", "web-dom", "web-contracts"], fullProjects: ["web-contracts"], smoke: [],
    })
    expect(result.specs).toEqual(expect.arrayContaining([direct, related, contract]))
    expect(result.specs).toHaveLength(3)
    expect(result.receipt.fallback).toBeNull()
    expect(result.receipt.discovered_files).toBe(4)
  })

  it("reports a graph error and keeps the complete affected project set", async () => {
    const files = [spec("web-node", "a.test.ts"), spec("blog-node", "b.test.ts")]
    const ctx = { globTestSpecifications: async () => files, getRelevantTestSpecifications: async () => { throw new Error("MDX graph rejected") } }
    const result = await selectUnitSpecifications(ctx, plan("source.ts"), { projects: ["web-node", "blog-node"], fullProjects: [], smoke: [] })
    expect(result.specs).toHaveLength(2)
    expect(result.receipt).toMatchObject({ mode: "project_full", fallback: { reason: "native_related_analysis_failed", detail: "MDX graph rejected" } })
  })

  it.each(["A", "D", "R100"])("keeps project scope for %s rather than losing old/new paths", async status => {
    const ctx = { globTestSpecifications: async () => [spec("web-node", "a.test.ts")], getRelevantTestSpecifications: vi.fn() }
    const result = await selectUnitSpecifications(ctx, plan("source.ts", status), { projects: ["web-node"], fullProjects: [], smoke: [] })
    expect(result.receipt.mode).toBe("added_deleted_or_renamed_input")
    expect(result.specs).toHaveLength(1)
    expect(ctx.getRelevantTestSpecifications).not.toHaveBeenCalled()
  })

  it.each(["post.mdx", "migrations/001.sql", "vitest.shared.ts", "react-dom-setup.ts", "next.config.ts", ".env"])("keeps project scope for nonmodule/config input %s", path => {
    expect(projectFullReason(plan(path))).toBe("nonmodule_input")
  })

  it("distinguishes a valid zero related result from a failed analysis", async () => {
    const ctx = { globTestSpecifications: async () => [spec("web-node", "a.test.ts")], getRelevantTestSpecifications: async () => [] }
    const result = await selectUnitSpecifications(ctx, plan("source.ts"), { projects: ["web-node"], fullProjects: [], smoke: [] })
    expect(result.receipt).toMatchObject({ mode: "native_related", fallback: null, selected_files: 0 })
  })

  it("rejects an unmapped native unit task and retains structural project execution", () => {
    const unknown = plan("source.ts")
    unknown.suites.unit_tasks = ["@alook/web#test:unknown"]
    expect(() => unitProjects(unknown)).toThrow("no execution project")
    const contracts = plan("source.ts")
    contracts.suites.unit_tasks = ["@alook/web#test:contracts"]
    expect(unitProjects(contracts)).toEqual({ projects: ["web-contracts"], fullProjects: ["web-contracts"], smoke: [] })
  })
})
