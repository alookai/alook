import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("service test project ownership", () => {
  it("discovers each service in its own project without duplicate files", () => {
    const root = path.resolve(import.meta.dirname, "../../../../..")
    const source = [
      'import { createVitest } from "vitest/node"',
      'import { relative, sep } from "node:path"',
      'const ctx = await createVitest({root:process.cwd(),watch:false})',
      'try { const specs=await ctx.globTestSpecifications(); process.stdout.write(JSON.stringify({files:specs.map(spec=>({project:spec.project.name,file:relative(process.cwd(),spec.moduleId).split(sep).join("/")})),projects:ctx.projects.map(project=>({name:project.name,group:project.config.sequence.groupOrder??0,maxWorkers:project.config.maxWorkers}))})) } finally { await ctx.close() }',
    ].join("\n")
    const { files, projects } = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    })) as { files: { project: string; file: string }[]; projects: { name: string; group: number; maxWorkers: number }[] }
    const workersByGroup = new Map<number, Set<number>>()
    for (const project of projects) {
      if (!workersByGroup.has(project.group)) workersByGroup.set(project.group, new Set())
      workersByGroup.get(project.group)!.add(project.maxWorkers)
    }
    for (const workers of workersByGroup.values()) expect(workers.size).toBe(1)
    expect(projects.find(project => project.name === "daemon-node")?.maxWorkers).toBe(1)
    expect(new Set(files.map(file => file.file)).size).toBe(files.length)
    expect(files).toEqual(expect.arrayContaining([
      { project: "web-node", file: "src/web/src/components/community/bots/bot-list-facade.contract.test.ts" },
      { project: "web-dom", file: "src/web/src/components/community/bots/bot-list-card.dom.test.ts" },
      { project: "web-contracts", file: "src/web/src/test/architecture/react-dom-harness-contract.test.ts" },
      { project: "web-tooling", file: "src/web/app-store-capture/config.test.ts" },
      { project: "blog-node", file: "src/web/blog/src/lib/public-page-metadata.test.ts" },
      { project: "blog-dom", file: "src/web/blog/src/app/guides/page.dom.test.tsx" },
      { project: "auth-node", file: "src/web/auth/index.test.ts" },
    ]))
    for (const project of ["web-runtime", "auth-runtime"]) {
      expect(files.some(file => file.project === project && file.file.includes("/test-runtime/"))).toBe(true)
    }
    expect(files.filter(file => file.file.startsWith("src/web/blog/")).every(file => file.project.startsWith("blog-"))).toBe(true)
    expect(files.filter(file => file.file.startsWith("src/web/auth/")).every(file => file.project.startsWith("auth-"))).toBe(true)
  })

  it("executes cold service contracts through the canonical CI unit entry", () => {
    const root = path.resolve(import.meta.dirname, "../../../../..")
    const scratch = mkdtempSync(path.join(tmpdir(), "alook-mixed-unit-contract-"))
    const receipt = path.join(scratch, "execution.json")
    const planFile = path.join(scratch, "plan.json")
    const files = ["src/web/auth/index.test.ts", "src/daemon/src/logger.test.ts", "src/daemon/src/cli/daemonRefresh.test.ts", "src/web/src/lib/middleware/request-logger.test.ts", "src/web/src/lib/apple-oauth-hardening.test.ts"]
    const env = { ...process.env }
    for (const key of ["TEST", "VITEST", "NODE_ENV"]) delete env[key]
    const source = [
      'import { queryNativeTasks, buildExecutionPlan } from "./scripts/ci/changed-scopes.mjs"',
      'import { writeFileSync } from "node:fs"',
      'const {inventory}=queryNativeTasks(); const affected=inventory.filter(task=>["@alook/web#test:auth","@alook/web#test","@alook/daemon#test"].includes(task.fullName))',
      `const plan=buildExecutionPlan(${JSON.stringify(files)}.map(path=>({status:"M",path})),{nativeTasks:{inventory,affected}})`,
      'writeFileSync(process.argv[1],JSON.stringify(plan))',
    ].join("\n")
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", source, planFile], { cwd: root, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
      execFileSync(process.execPath, ["scripts/ci/run-unit-tests.mjs", "--ci", "--plan", planFile, "--receipt", receipt], { cwd: root, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
      const result = JSON.parse(readFileSync(receipt, "utf8")) as {
        fallback: unknown
        execution: { unhandled_errors: number; files: { file: string; ok: boolean }[] }
      }
      expect(result.fallback).toBeNull()
      expect(result.execution.unhandled_errors).toBe(0)
      expect(result.execution.files).toHaveLength(files.length)
      for (const file of files) {
        expect(result.execution.files.find(entry => entry.file === file)?.ok).toBe(true)
      }
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })
})
