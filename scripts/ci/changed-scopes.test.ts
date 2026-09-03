import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildExecutionPlan,
  classifyPaths,
  loadScopeManifest,
  parseNameStatus,
  projectPlan,
  runCli,
  stablePlanJson,
  validateExecutionPlan,
  validateScopeManifest,
} from "./changed-scopes.mjs"

const sha = (character: string) => character.repeat(40)
const modified = (...paths: string[]) => paths.map((path) => ({ status: "M", path }))

function plan(paths: string[], options = {}) {
  return buildExecutionPlan(modified(...paths), {
    baseSha: sha("a"),
    headSha: sha("b"),
    ...options,
  })
}

describe("canonical execution plan", () => {
  it("routes Blog runtime through the complete Web contract and only UI spec 54", () => {
    const result = plan(["src/web/blog/src/app/page.tsx"])

    expect(result.change_class).toBe("blog")
    expect(result.packages.direct).toEqual(["@alook/web"])
    expect(result.packages.affected).toEqual(["@alook/web"])
    expect(result.suites.unit).toEqual(["src/web"])
    expect(result.coverage.targets).toEqual(["web"])
    expect(result.coverage.include_roots).toEqual(["src/web/**/*.{ts,tsx,js,jsx}"])
    expect(result.ui.specs).toEqual(["54-blog-multizone.spec.ts"])
    expect(result.suites.integration).toEqual([])
    expect(result.suites.windows).toEqual([])
    expect(result.jobs.blog_build).toBe(true)
    expect(result.jobs.lighthouse).toBe(true)
    expect(result.jobs.app_packed_artifact).toBe(false)
  })

  it("keeps Blog content on build and its cross-worker contract without package coverage", () => {
    const result = plan([
      "src/web/blog/src/content/example.mdx",
      "src/web/blog/public/blog/example/hero.webp",
    ])

    expect(result.change_class).toBe("blog")
    expect(result.blog_only).toBe(true)
    expect(result.packages.direct).toEqual(["@alook/web"])
    expect(result.packages.affected).toEqual([])
    expect(result.suites.unit).toEqual([])
    expect(result.coverage.include_roots).toEqual([])
    expect(result.ui.specs).toEqual(["54-blog-multizone.spec.ts"])
    expect(result.jobs.blog_build).toBe(true)
  })

  it("selects only the CLI package and its explicit platform suites", () => {
    const result = plan(["src/cli/src/commands/inbox.ts"])

    expect(result.change_class).toBe("package")
    expect(result.packages.affected).toEqual(["@alook/cli"])
    expect(result.suites.static).toEqual(["@alook/cli"])
    expect(result.suites.unit).toEqual(["src/cli"])
    expect(result.suites.integration).toEqual(["cli"])
    expect(result.suites.windows).toEqual(["cli"])
    expect(result.ui.specs).toEqual([])
    expect(result.coverage.targets).toEqual(["cli"])
    expect(result.jobs.app_packed_artifact).toBe(false)
  })

  it("routes integration-owned paths without widening to unrelated suites", () => {
    const cli = plan(["tests/integration/cli/session-resume.test.ts"])
    expect(cli.suites.integration).toEqual(["cli"])
    expect(cli.jobs.e2e).toBe(true)
    expect(cli.jobs.static_checks).toBe(false)

    const daemon = plan(["tests/integration/daemon/lifecycle.test.ts"])
    expect(daemon.suites.integration).toEqual(["daemon"])
  })

  it("expands shared changes through the complete workspace dependent closure", () => {
    const result = plan(["src/shared/src/schema.ts"])

    expect(result.change_class).toBe("shared")
    expect(result.packages.affected).toEqual([
      "@alook/app",
      "@alook/cli",
      "@alook/daemon",
      "@alook/email-worker",
      "@alook/shared",
      "@alook/test-utils",
      "@alook/wake-worker",
      "@alook/web",
      "@alook/ws-do",
    ])
    expect(result.suites.integration).toEqual(["cli", "daemon", "web"])
    expect(result.suites.windows).toEqual(["app", "cli", "daemon", "shared"])
    expect(result.ui.specs).toEqual(["all"])
    expect(result.jobs.app_packed_artifact).toBe(true)
    expect(result.jobs.rust).toBe(false)
  })

  it("fails closed for CI policy, root config, unknown paths, empty diffs, and force full", () => {
    for (const paths of [
      [".github/workflows/ci.yml"],
      ["pnpm-lock.yaml"],
      ["docs/architecture.png"],
      [".claude/settings.json"],
      ["src/future-package/src/index.ts"],
      ["unexpected/file.txt"],
      [],
    ]) {
      const result = plan(paths)
      expect(result.full, paths.join(",") || "empty").toBe(true)
      expect(result.ui.specs).toEqual(["all"])
      expect(result.suites.integration).toEqual(["cli", "daemon", "web"])
      expect(result.suites.windows).toEqual(["agent-driver", "app", "cli", "daemon", "shared"])
    }

    expect(plan(["README.md"], { forceFull: true }).full).toBe(true)
    expect(plan([".github/workflows/ci.yml"]).full_reason).toBe("policy_change")
  })

  it("keeps Markdown-only changes empty and mixed content fail-closed", () => {
    const docs = plan(["README.md", "docs/operations.md"])
    expect(docs.docs_only).toBe(true)
    expect(Object.values(docs.jobs).some(Boolean)).toBe(false)

    const mixed = plan(["README.md", "src/web/blog/src/content/example.mdx"])
    expect(mixed.full).toBe(true)
    expect(mixed.full_reason).toBe("mixed_content")
  })

  it("preserves the packed app contract for package-local Markdown", () => {
    expect(plan(["src/app/README.md"]).jobs.app_packed_artifact).toBe(true)
    expect(plan(["src/daemon/README.md"]).jobs.app_packed_artifact).toBe(true)
    expect(plan(["src/shared/README.md"]).jobs.app_packed_artifact).toBe(true)
    expect(plan(["src/cli/README.md"]).jobs.app_packed_artifact).toBe(false)
  })

  it("takes a monotonic union for multiple paths", () => {
    const cli = plan(["src/cli/src/index.ts"])
    const web = plan(["src/web/src/app/page.tsx"])
    const combined = plan(["src/web/src/app/page.tsx", "src/cli/src/index.ts"])

    for (const value of cli.packages.affected) expect(combined.packages.affected).toContain(value)
    for (const value of web.packages.affected) expect(combined.packages.affected).toContain(value)
    for (const value of cli.suites.integration) expect(combined.suites.integration).toContain(value)
    for (const value of web.suites.integration) expect(combined.suites.integration).toContain(value)
  })

  it("produces byte-identical plans, hashes, and mechanical projections", () => {
    const first = plan(["src/cli/src/index.ts", "src/web/src/app/page.tsx"])
    const second = plan(["src/web/src/app/page.tsx", "src/cli/src/index.ts"])

    expect(first).toEqual(second)
    expect(stablePlanJson(first)).toBe(stablePlanJson(second))
    expect(validateExecutionPlan(first)).toEqual(first)
    const projection = projectPlan(first)
    expect(JSON.parse(projection.execution_plan)).toEqual(first)
    expect(projection.plan_hash).toBe(first.plan_hash)
    expect(JSON.parse(projection.static_packages)).toEqual(first.suites.static)
    expect(JSON.parse(projection.integration_suites)).toEqual(first.suites.integration)

    expect(() => validateExecutionPlan({ ...first, head_sha: sha("c") })).toThrow("hash")
  })
})

describe("coverage name-status contract", () => {
  it("requires surviving A/M and rename/copy new sides but not deleted or old paths", () => {
    const result = buildExecutionPlan([
      { status: "A", path: "src/cli/src/added.ts" },
      { status: "M", path: "src/cli/src/modified.ts" },
      { status: "D", path: "src/cli/src/deleted.ts" },
      { status: "R100", old_path: "src/cli/src/old.ts", path: "src/cli/src/renamed.ts" },
      { status: "C090", old_path: "src/cli/src/source.ts", path: "src/cli/src/copied.ts" },
    ], { baseSha: sha("a"), headSha: sha("b") })

    expect(result.coverage.required_changed_files).toEqual([
      "src/cli/src/added.ts",
      "src/cli/src/copied.ts",
      "src/cli/src/modified.ts",
      "src/cli/src/renamed.ts",
    ])
  })

  it("parses NUL-delimited statuses without losing rename/copy identity", () => {
    const input = Buffer.from(
      "M\0src/cli/src/a.ts\0D\0src/cli/src/deleted.ts\0R100\0src/cli/src/old.ts\0src/cli/src/new.ts\0C090\0src/shared/src/a.ts\0src/shared/src/b.ts\0",
    )

    expect(parseNameStatus(input)).toEqual([
      { status: "M", path: "src/cli/src/a.ts" },
      { status: "D", path: "src/cli/src/deleted.ts" },
      { status: "R100", old_path: "src/cli/src/old.ts", path: "src/cli/src/new.ts" },
      { status: "C090", old_path: "src/shared/src/a.ts", path: "src/shared/src/b.ts" },
    ])
  })
})

describe("scope manifest", () => {
  it("matches workspace package manifests and the complete UI inventory", () => {
    const manifest = loadScopeManifest()
    expect(() => validateScopeManifest(manifest)).not.toThrow()
    expect(manifest.schema_version).toBe(1)
    expect(manifest.ui.contracts.blog).toEqual(["54-blog-multizone.spec.ts"])
  })

  it("rejects unknown suites and duplicate package roots", () => {
    const manifest = loadScopeManifest()
    const brokenSuite = structuredClone(manifest)
    brokenSuite.packages[0].windows_suites = ["future"]
    expect(() => validateScopeManifest(brokenSuite)).toThrow("windows suite")

    const duplicateRoot = structuredClone(manifest)
    duplicateRoot.packages[1].root = duplicateRoot.packages[0].root
    expect(() => validateScopeManifest(duplicateRoot)).toThrow("root")

    const missingPackage = structuredClone(manifest)
    missingPackage.packages.pop()
    expect(() => validateScopeManifest(missingPackage)).toThrow("pnpm-workspace")

    const codecovDrift = structuredClone(manifest)
    codecovDrift.codecov_targets.shared.target = 51
    expect(() => validateScopeManifest(codecovDrift)).toThrow("Codecov target")
  })
})

describe("compatibility and CLI fail-closed behavior", () => {
  it("keeps classifyPaths as a canonical-plan adapter", () => {
    const result = classifyPaths(["src/desktop/src-tauri/src/lib.rs"])
    expect(result.jobs.rust).toBe(true)
    expect(result.ui.specs).toEqual([])
  })

  it("writes a full plan when the diff cannot be resolved", () => {
    const directory = mkdtempSync(join(tmpdir(), "alook-ci-scope-"))
    const output = join(directory, "output")
    const planFile = join(directory, "plan.json")
    try {
      runCli([
        "--base", "missing-base",
        "--head", "missing-head",
        "--output", output,
        "--plan-file", planFile,
      ])
      const values = readFileSync(output, "utf8")
      const writtenPlan = JSON.parse(readFileSync(planFile, "utf8"))
      expect(values).toContain("full=true")
      expect(values).toContain("run_ui_e2e=true")
      expect(writtenPlan.full).toBe(true)
      expect(writtenPlan.full_reason).toBe("classifier_error")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
