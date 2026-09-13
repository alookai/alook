import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
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

function resignPlan(value) {
  const { plan_hash: _ignored, ...unsigned } = value
  return {
    ...value,
    plan_hash: createHash("sha256").update(stablePlanJson(unsigned)).digest("hex"),
  }
}

function workspaceFixture({
  codecov = (source: string) => source,
} = {}) {
  const manifest = loadScopeManifest()
  const root = mkdtempSync(join(tmpdir(), "alook-ci-workspace-"))
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    readFileSync("pnpm-workspace.yaml", "utf8"),
  )
  writeFileSync(
    join(root, "codecov.yml"),
    codecov(readFileSync("codecov.yml", "utf8")),
  )
  for (const scopePackage of manifest.packages) {
    const packageRoot = join(root, scopePackage.root)
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(
      join(packageRoot, "package.json"),
      readFileSync(join(scopePackage.root, "package.json"), "utf8"),
    )
  }
  return { manifest, root }
}

function localGitEnvironmentNames() {
  return execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
}

function cleanGitEnvironment() {
  const environment = { ...process.env }
  for (const name of localGitEnvironmentNames()) delete environment[name]
  return environment
}

function gitDiffFixture(changedPath = "src/app/src/commands/inbox.ts") {
  const root = mkdtempSync(join(tmpdir(), "alook-ci-git-"))
  const runGit = (...args: string[]) => execFileSync("git", args, {
    cwd: root,
    env: cleanGitEnvironment(),
    stdio: "ignore",
  })
  const commit = (message: string) => runGit(
    "-c", "user.name=Alook CI",
    "-c", "user.email=ci@alook.local",
    "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", message,
  )

  runGit("init", "--quiet")
  writeFileSync(join(root, "README.md"), "baseline\n")
  runGit("add", "README.md")
  commit("baseline")

  mkdirSync(join(root, changedPath.split("/").slice(0, -1).join("/")), { recursive: true })
  writeFileSync(join(root, changedPath), "export const fixture = true\n")
  runGit("add", changedPath)
  commit("change app")

  return { changedPath, root }
}

describe("canonical execution plan", () => {
  it("keeps benchmark-only changes out of product jobs while retaining diff evidence", () => {
    const changes = [
      { status: "A", path: "src/benchmark/package.json" },
      { status: "M", path: "src/benchmark/README.md" },
      { status: "D", path: "src/benchmark/src/old.mjs" },
      { status: "R100", old_path: "src/benchmark/src/a.mjs", path: "src/benchmark/src/b.mjs" },
    ]
    const result = buildExecutionPlan(changes)
    expect(result.change_class).toBe("benchmark")
    expect(result.full).toBe(false)
    expect(result.paths).toHaveLength(5)
    expect(result.changes).toHaveLength(4)
    expect(Object.values(result.jobs).every((run) => !run)).toBe(true)
    expect(result.packages.affected).toEqual([])
    expect(result.coverage.include_roots).toEqual([])
    expect(Object.entries(projectPlan(result)).filter(([name]) => name.startsWith("run_")).every(([, run]) => run === "false")).toBe(true)
    expect(validateExecutionPlan(result)).toEqual(result)
  })

  it("preserves existing product contracts when benchmark changes are mixed in", () => {
    for (const product of ["src/app/src/commands/inbox.ts", "src/daemon/src/index.ts", "src/web/src/app/page.tsx", "src/web/auth/index.ts", "src/web/blog/src/app/page.tsx", "src/web/blog/src/content/example.mdx", "src/shared/src/schema.ts"]) {
      const expected = plan([product])
      const mixed = plan([product, "src/benchmark/src/runner.mjs"])
      for (const field of ["change_class", "full", "packages", "suites", "jobs", "coverage", "ui", "auth_only", "blog_only"]) expect(mixed[field]).toEqual(expected[field])
    }
    for (const [old_path, path] of [["src/web/auth/index.ts", "src/benchmark/index.ts"], ["src/benchmark/index.ts", "src/web/auth/index.ts"]]) {
      const result = buildExecutionPlan([{ status: "R100", old_path, path }])
      expect(result.jobs).toEqual(plan(["src/web/auth/index.ts"]).jobs)
      expect(result.paths).toEqual(["src/benchmark/index.ts", "src/web/auth/index.ts"])
    }
  })

  it("keeps unknown, policy, empty and explicit full changes fail-closed", () => {
    for (const path of ["src/benchmark-other/new.mjs", "unknown/code.js", ".github/workflows/ci.yml"]) expect(plan([path, "src/benchmark/src/runner.mjs"]).full).toBe(true)
    expect(plan([]).full).toBe(true)
    expect(plan(["src/benchmark/src/runner.mjs"], { forceFull: true }).full).toBe(true)
    expect(plan(["src/benchmark/src/runner.mjs"], { fallbackReason: "diff failed" }).full).toBe(true)
    expect(plan(["src/benchmark/src/runner.mjs"], { fullUnlessBenchmarkOnly: true }).full).toBe(false)
    for (const paths of [[], ["README.md"], ["src/web/auth/index.ts", "src/benchmark/src/runner.mjs"]]) expect(plan(paths, { fullUnlessBenchmarkOnly: true }).full).toBe(true)
  })

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

  it("routes the standalone auth Worker through Web checks and its own dry-run only", () => {
    const result = plan(["src/web/auth/index.ts"])

    expect(result.change_class).toBe("auth")
    expect(result.auth_only).toBe(true)
    expect(result.packages.direct).toEqual(["@alook/web"])
    expect(result.packages.affected).toEqual(["@alook/web"])
    expect(result.suites.static).toEqual(["@alook/web"])
    expect(result.suites.unit).toEqual(["src/web"])
    expect(result.suites.integration).toEqual([])
    expect(result.ui.specs).toEqual([])
    expect(result.jobs.auth_build).toBe(true)
    expect(result.jobs.blog_build).toBe(false)
    expect(result.jobs.lighthouse).toBe(false)
    expect(result.jobs.app_packed_artifact).toBe(false)
  })

  it("selects the active app package without retired CLI suites", () => {
    const result = plan(["src/app/src/commands/inbox.ts"])
    expect(result.change_class).toBe("package")
    expect(result.packages.affected).toEqual(["@alook/app"])
    expect(result.suites.static).toEqual(["@alook/app"])
    expect(result.suites.unit).toEqual(["src/app"])
    expect(result.suites.integration).toEqual([])
    expect(result.suites.windows).toEqual(["app"])
    expect(result.ui.specs).toEqual([])
    expect(result.coverage.targets).toEqual([])
    expect(result.jobs.app_packed_artifact).toBe(true)
  })

  it("routes integration-owned paths without widening to unrelated suites", () => {
    const integration = plan(["tests/integration/daemon/lifecycle.test.ts"])
    expect(integration.suites.integration).toEqual(["daemon"])
    expect(integration.jobs.e2e).toBe(true)
    expect(integration.jobs.static_checks).toBe(false)

    const undeclared = plan(["tests/integration/future/case.test.ts"])
    expect(undeclared.full).toBe(true)
    expect(undeclared.full_reason).toBe("unknown_path")
    expect(undeclared.suites.integration).toEqual(["daemon", "web"])

    const trailingSlashManifest = structuredClone(loadScopeManifest())
    const daemonPathSuite = trailingSlashManifest.path_suites.find((entry) => (
      entry.root === "tests/integration/daemon"
    ))
    expect(daemonPathSuite).toBeDefined()
    daemonPathSuite!.root += "/"
    const canonicalized = buildExecutionPlan(
      modified("tests/integration/daemon/lifecycle.test.ts"),
      {
        baseSha: sha("a"),
        headSha: sha("b"),
        manifest: trailingSlashManifest,
      },
    )
    expect(canonicalized.full).toBe(false)
    expect(canonicalized.suites.integration).toEqual(["daemon"])
  })

  it("expands shared changes through the complete workspace dependent closure", () => {
    const result = plan(["src/shared/src/schema.ts"])

    expect(result.change_class).toBe("shared")
    expect(result.packages.affected).toEqual([
      "@alook/app",
      "@alook/daemon",
      "@alook/email-worker",
      "@alook/queue-worker",
      "@alook/shared",
      "@alook/test-utils",
      "@alook/web",
      "@alook/ws-do",
    ])
    expect(result.suites.integration).toEqual(["daemon", "web"])
    expect(result.suites.windows).toEqual(["app", "daemon", "shared"])
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
      expect(result.suites.integration).toEqual(["daemon", "web"])
      expect(result.suites.windows).toEqual(["agent-driver", "app", "daemon", "shared"])
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
  })

  it("takes a monotonic union for multiple paths", () => {
    const app = plan(["src/app/src/index.ts"])
    const web = plan(["src/web/src/app/page.tsx"])
    const combined = plan(["src/web/src/app/page.tsx", "src/app/src/index.ts"])

    for (const value of app.packages.affected) expect(combined.packages.affected).toContain(value)
    for (const value of web.packages.affected) expect(combined.packages.affected).toContain(value)
    for (const value of app.suites.integration) expect(combined.suites.integration).toContain(value)
    for (const value of web.suites.integration) expect(combined.suites.integration).toContain(value)
  })

  it("produces byte-identical plans, hashes, and mechanical projections", () => {
    const first = plan(["src/app/src/index.ts", "src/web/src/app/page.tsx"])
    const second = plan(["src/web/src/app/page.tsx", "src/app/src/index.ts"])

    expect(first).toEqual(second)
    expect(stablePlanJson(first)).toBe(stablePlanJson(second))
    expect(validateExecutionPlan(first)).toEqual(first)
    const projection = projectPlan(first)
    expect(JSON.parse(projection.execution_plan)).toEqual(first)
    expect(projection.plan_hash).toBe(first.plan_hash)
    expect(JSON.parse(projection.static_packages)).toEqual(first.suites.static)
    expect(JSON.parse(projection.integration_suites)).toEqual(first.suites.integration)

    const auth = projectPlan(plan(["src/web/auth/wrangler.toml"]))
    expect(auth.auth_only).toBe("true")
    expect(auth.run_auth_build).toBe("true")

    expect(() => validateExecutionPlan({ ...first, head_sha: sha("c") })).toThrow("hash")
  })

  it("rejects every stale identifier in an otherwise authentic signed plan", () => {
    const current = plan(["src/shared/src/schema.ts"])
    expect(() => validateExecutionPlan({ ...current, schema_version: 2 }))
      .toThrow("schema/policy")

    for (const [section, key, expected] of [
      ["packages", "direct", "package"],
      ["suites", "windows", "windows suite"],
      ["suites", "integration", "integration suite"],
      ["suites", "linux", "linux suite"],
    ]) {
      const altered = structuredClone(current)
      altered[section][key] = ["future"]
      expect(() => validateExecutionPlan(resignPlan(altered))).toThrow(expected)
    }

    const staleUi = structuredClone(current)
    staleUi.ui.specs = ["future.spec.ts"]
    expect(() => validateExecutionPlan(resignPlan(staleUi))).toThrow("UI spec")
  })
})

describe("coverage name-status contract", () => {
  it("excludes E2E support files according to Web's Vitest project boundary", () => {
    const webConfig = readFileSync("src/web/vitest.config.ts", "utf8")
    expect(webConfig).toContain('"src/test/e2e/**"')
    expect(webConfig).toContain('"src/test/e2e-ui/**"')
    const fixtures = [
      "src/web/src/test/e2e-ui/_fixtures/community-notification-requests.ts",
      "src/web/src/test/e2e-ui/_setup/global-setup.ts",
      "src/web/src/test/e2e/_fixtures/session.ts",
      "src/web/src/test/react-dom-harness.ts",
      "src/web/src/test/react-dom-setup.ts",
    ]
    const product = "src/web/src/lib/community/message-dispatcher.ts"
    const lookalike = "src/web/src/test/e2e-ui-helpers/session.ts"
    const result = plan([...fixtures, product, lookalike])
    expect(result.coverage.required_changed_files).toEqual([product, lookalike])
    expect(result.jobs.ui_e2e).toBe(true)
    expect(result.coverage.targets).toContain("web")
  })

  it("requires surviving A/M and rename/copy new sides but not deleted or old paths", () => {
    const result = buildExecutionPlan([
      { status: "A", path: "src/app/src/added.ts" },
      { status: "M", path: "src/app/src/modified.ts" },
      { status: "D", path: "src/app/src/deleted.ts" },
      { status: "R100", old_path: "src/app/src/old.ts", path: "src/app/src/renamed.ts" },
      { status: "C090", old_path: "src/app/src/source.ts", path: "src/app/src/copied.ts" },
    ], { baseSha: sha("a"), headSha: sha("b") })

    expect(result.coverage.required_changed_files).toEqual([
      "src/app/src/added.ts",
      "src/app/src/copied.ts",
      "src/app/src/modified.ts",
      "src/app/src/renamed.ts",
    ])
  })

  it("requires only files selected by the actual coverage globs", () => {
    for (const path of [
      "src/app/scripts/app-packed-artifact.mjs",
      "src/app/scripts/bundle-daemon.mjs",
      "src/shared/src/index.ts",
      "src/web/auth/vitest.config.ts",
      "src/web/vitest.config.ts",
      "src/web/vitest.runtime.config.mts",
      "src/web/vitest.workspace.config.ts",
      "src/web/src/components/community/bots/bot-list-types.ts",
    ]) {
      expect(plan([path]).coverage.required_changed_files).toEqual([])
    }

    expect(plan(["scripts/ci/changed-scopes.mjs"]).coverage.required_changed_files)
      .toEqual(["scripts/ci/changed-scopes.mjs"])
  })

  it("excludes only the OpenNext config, not config-lookalike runtime files", () => {
    const result = plan([
      "src/web/open-next.config.ts",
      "src/web/src/lib/runtime-lookalike.config.ts",
    ])

    expect(result.packages.affected).toEqual(["@alook/web"])
    expect(result.coverage.targets).toEqual(["web"])
    expect(result.coverage.required_changed_files).toEqual([
      "src/web/src/lib/runtime-lookalike.config.ts",
    ])
  })

  it("parses NUL-delimited statuses without losing rename/copy identity", () => {
    const input = Buffer.from(
      "M\0src/app/src/a.ts\0D\0src/app/src/deleted.ts\0R100\0src/app/src/old.ts\0src/app/src/new.ts\0C090\0src/shared/src/a.ts\0src/shared/src/b.ts\0",
    )

    expect(parseNameStatus(input)).toEqual([
      { status: "M", path: "src/app/src/a.ts" },
      { status: "D", path: "src/app/src/deleted.ts" },
      { status: "R100", old_path: "src/app/src/old.ts", path: "src/app/src/new.ts" },
      { status: "C090", old_path: "src/shared/src/a.ts", path: "src/shared/src/b.ts" },
    ])
  })

  it("rejects truncated NUL-delimited status records", () => {
    expect(() => parseNameStatus(Buffer.from("M\0"))).toThrow("missing path")
    expect(() => parseNameStatus(Buffer.from("R100\0old.ts\0"))).toThrow("missing destination")
  })

  it("sorts equal destination paths by old path and then status", () => {
    const input = Buffer.from([
      "R100", "src/app/src/z.ts", "src/app/src/same.ts",
      "R090", "src/app/src/a.ts", "src/app/src/same.ts",
      "C100", "src/app/src/a.ts", "src/app/src/same.ts",
      "M", "src/app/src/same.ts",
      "A", "src/app/src/same.ts",
      "",
    ].join("\0"))

    expect(parseNameStatus(input)).toEqual([
      { status: "A", path: "src/app/src/same.ts" },
      { status: "M", path: "src/app/src/same.ts" },
      { status: "C100", old_path: "src/app/src/a.ts", path: "src/app/src/same.ts" },
      { status: "R090", old_path: "src/app/src/a.ts", path: "src/app/src/same.ts" },
      { status: "R100", old_path: "src/app/src/z.ts", path: "src/app/src/same.ts" },
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

  it("rejects invalid versions, registries, packages, paths, targets, and specs", () => {
    const manifest = loadScopeManifest()

    expect(() => validateScopeManifest({ ...manifest, schema_version: 2 }))
      .toThrow("schema/policy")
    expect(() => validateScopeManifest({ ...manifest, packages: [] }))
      .toThrow("packages are required")

    const duplicateName = structuredClone(manifest)
    duplicateName.packages[1].name = duplicateName.packages[0].name
    expect(() => validateScopeManifest(duplicateName)).toThrow("names must be unique")

    const brokenSuite = structuredClone(manifest)
    brokenSuite.packages[0].windows_suites = ["future"]
    expect(() => validateScopeManifest(brokenSuite)).toThrow("windows suite")

    const duplicateSuite = structuredClone(manifest)
    duplicateSuite.suites.windows.push(duplicateSuite.suites.windows[0])
    expect(() => validateScopeManifest(duplicateSuite)).toThrow("IDs must be unique")

    const registryDrift = structuredClone(manifest)
    registryDrift.suites.windows.push("future")
    expect(() => validateScopeManifest(registryDrift)).toThrow("registry")

    const duplicateRoot = structuredClone(manifest)
    duplicateRoot.packages[1].root = duplicateRoot.packages[0].root
    expect(() => validateScopeManifest(duplicateRoot)).toThrow("root")

    const duplicatePathRoot = structuredClone(manifest)
    duplicatePathRoot.path_suites.push(structuredClone(duplicatePathRoot.path_suites[0]))
    expect(() => validateScopeManifest(duplicatePathRoot)).toThrow("path suite roots")

    const unknownPathSuite = structuredClone(manifest)
    unknownPathSuite.path_suites[0].integration_suites = ["future"]
    expect(() => validateScopeManifest(unknownPathSuite)).toThrow("path integration suite")

    const missingPackage = structuredClone(manifest)
    missingPackage.packages.pop()
    expect(() => validateScopeManifest(missingPackage)).toThrow("pnpm-workspace")

    const packageMismatch = structuredClone(manifest)
    packageMismatch.packages[0].name = "@alook/future"
    expect(() => validateScopeManifest(packageMismatch)).toThrow("package manifest mismatch")

    const unknownCodecov = structuredClone(manifest)
    const targetPackage = unknownCodecov.packages.find((entry) => entry.codecov_target)
    expect(targetPackage).toBeDefined()
    targetPackage!.codecov_target = "future"
    expect(() => validateScopeManifest(unknownCodecov)).toThrow("unknown Codecov target")

    const codecovDrift = structuredClone(manifest)
    codecovDrift.codecov_targets.shared.target = 51
    expect(() => validateScopeManifest(codecovDrift)).toThrow("Codecov target")

    expect(() => validateScopeManifest(manifest, { specs: [] })).toThrow("unknown UI spec")
  })

  it("validates the same Codecov contracts from a CRLF checkout", () => {
    const { manifest, root } = workspaceFixture({
      codecov: (source) => source.replaceAll(/\r?\n/g, "\r\n"),
    })
    try {
      expect(() => validateScopeManifest(manifest, {
        root,
        specs: manifest.ui.contracts.blog,
      })).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects malformed Codecov sections and package test contracts", () => {
    for (const codecov of [
      (source: string) => source.replace("    project:", "    projects:"),
      (source: string) => source.replace(/^      ([^:\n]+):$/m, "      future:"),
    ]) {
      const { manifest, root } = workspaceFixture({ codecov })
      try {
        expect(() => validateScopeManifest(manifest, {
          root,
          specs: manifest.ui.contracts.blog,
        })).toThrow("codecov.yml")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    const { manifest, root } = workspaceFixture()
    try {
      const unitPackage = manifest.packages.find((entry) => entry.unit_root)
      expect(unitPackage).toBeDefined()
      const packagePath = join(root, unitPackage!.root, "package.json")
      const packageManifest = JSON.parse(readFileSync(packagePath, "utf8"))
      delete packageManifest.scripts.test
      writeFileSync(packagePath, JSON.stringify(packageManifest))
      expect(() => validateScopeManifest(manifest, {
        root,
        specs: manifest.ui.contracts.blog,
      })).toThrow("declares test scope")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
    const summary = join(directory, "summary.md")
    try {
      runCli([
        "--base", "missing-base",
        "--head", "missing-head",
        "--output", output,
        "--plan-file", planFile,
        "--summary", summary,
      ])
      const values = readFileSync(output, "utf8")
      const writtenPlan = JSON.parse(readFileSync(planFile, "utf8"))
      expect(values).toContain("full=true")
      expect(values).toContain("run_ui_e2e=true")
      expect(writtenPlan.full).toBe(true)
      expect(writtenPlan.full_reason).toBe("classifier_error")
      expect(readFileSync(summary, "utf8")).toContain("Fail-closed reason:")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("writes every canonical artifact for an explicit diagnostic full run", () => {
    const directory = mkdtempSync(join(tmpdir(), "alook-ci-scope-"))
    const output = join(directory, "output")
    const planFile = join(directory, "plan.json")
    const summary = join(directory, "summary.md")
    try {
      runCli([
        "--force-full",
        "--diagnostic-only",
        "--output", output,
        "--plan-file", planFile,
        "--summary", summary,
      ])

      const writtenPlan = JSON.parse(readFileSync(planFile, "utf8"))
      expect(writtenPlan).toMatchObject({
        full: true,
        full_reason: "forced",
        diagnostic_only: true,
        changes: [],
      })
      expect(readFileSync(output, "utf8")).toContain(`plan_hash=${writtenPlan.plan_hash}`)
      expect(readFileSync(summary, "utf8")).toContain("- none")
      expect(readFileSync(summary, "utf8")).not.toContain("Fail-closed reason:")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("reads a real Git diff and prints its canonical plan when no output file is requested", () => {
    const fixture = gitDiffFixture()
    const summary = join(fixture.root, "summary.md")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const localEnvironment = localGitEnvironmentNames()
    const previousEnvironment = new Map(
      localEnvironment.map((name) => [name, process.env[name]]),
    )
    try {
      for (const name of localEnvironment) delete process.env[name]
      process.env.GIT_DIR = join(fixture.root, ".git")
      process.env.GIT_WORK_TREE = fixture.root
      runCli(["--base", "HEAD^", "--head", "HEAD", "--full-unless-benchmark-only", "--summary", summary])

      const written = stdout.mock.calls.map(([value]) => String(value)).join("")
      const writtenPlan = JSON.parse(written)
      expect(writtenPlan.full).toBe(true)
      expect(writtenPlan.full_reason).toBe("forced")
      expect(writtenPlan.base_sha).toBe("HEAD^")
      expect(writtenPlan.head_sha).toBe("HEAD")
      expect(writtenPlan.changes).toEqual([{ status: "A", path: fixture.changedPath }])
      expect(readFileSync(summary, "utf8")).toContain(fixture.changedPath)
    } finally {
      for (const name of localEnvironment) delete process.env[name]
      for (const [name, value] of previousEnvironment) {
        if (value !== undefined) process.env[name] = value
      }
      stdout.mockRestore()
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([
    ["src/benchmark/src/runner.mjs", false],
    ["src/web/auth/index.ts", true],
  ])("applies main-push policy through the actual CLI diff for %s", (path, full) => {
    const fixture = gitDiffFixture(String(path))
    const output = join(fixture.root, "projection")
    const planFile = join(fixture.root, "plan.json")
    try {
      execFileSync(process.execPath, ["scripts/ci/changed-scopes.mjs", "--base", "HEAD^", "--head", "HEAD", "--full-unless-benchmark-only", "--output", output, "--plan-file", planFile], {
        env: { ...cleanGitEnvironment(), GIT_DIR: join(fixture.root, ".git"), GIT_WORK_TREE: fixture.root },
      })
      const result = JSON.parse(readFileSync(planFile, "utf8"))
      expect(result.full).toBe(full)
      expect(result.changes).toEqual([{ status: "A", path }])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("fails closed when the CLI SHA boundary is omitted", () => {
    const directory = mkdtempSync(join(tmpdir(), "alook-ci-scope-"))
    const output = join(directory, "output")
    const planFile = join(directory, "plan.json")
    try {
      runCli(["--output", output, "--plan-file", planFile])
      expect(JSON.parse(readFileSync(planFile, "utf8"))).toMatchObject({
        full: true,
        full_reason: "classifier_error",
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
