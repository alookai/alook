import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  buildExecutionPlan as createExecutionPlan,
  queryNativeTasks,
  loadScopeManifest,
  packageDependencyVersionChanged,
  parseNameStatus,
  projectPlan,
  stablePlanJson,
  validateExecutionPlan,
  validateScopeManifest,
} from "./changed-scopes.mjs"
import { queryNativeUiFacts, validateNativeUiFacts } from "./e2e-shards.mjs"

let nativeFixture: { root: string; base: string; compatibilityBase: string } | undefined
let nativeInventory: ReturnType<typeof queryNativeTasks>["inventory"]

function nativeRepository() {
  if (nativeFixture) return nativeFixture
  const source = resolve(import.meta.dirname, "../..")
  const { root } = workspaceFixture()
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: source, encoding: "utf8", env: cleanGitEnvironment() }).split("\0").filter(Boolean)
  for (const file of paths) {
    if (!existsSync(join(source, file))) continue
    const target = join(root, file)
    mkdirSync(dirname(target), { recursive: true })
    const metadata = /(?:^|\/)package\.json$/.test(file) || /\.json$/.test(file)
      || ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", ".gitignore", "codecov.yml"].includes(file)
      || /^scripts\/ci\/.*\.mjs$/.test(file) || file === "scripts/workspace-packages.mjs"
    writeFileSync(target, metadata ? readFileSync(join(source, file)) : "")
  }
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  symlinkSync(join(source, "src/web/node_modules"), join(root, "src/web/node_modules"), process.platform === "win32" ? "junction" : "dir")
  writeFileSync(join(root, "src/web/playwright.config.ts"), 'export default { testDir: "./src/test/e2e-ui", fullyParallel: false, workers: 1, retries: 0, projects: [{ name: "chromium" }] }')
  for (const file of paths.filter(path => /^src\/web\/src\/test\/e2e-ui\/.+\.spec\.ts$/.test(path))) {
    if (existsSync(join(source, file))) writeFileSync(join(root, file), 'import { test } from "@playwright/test"; test(' + JSON.stringify(file) + ', () => {})')
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: cleanGitEnvironment() })
  git("init", "--quiet")
  writeFileSync(join(root, ".git/info/exclude"), "/node_modules\n/src/web/node_modules\n")
  git("config", "user.name", "Native task fixture")
  git("config", "user.email", "native-tasks@example.test")
  git("config", "commit.gpgsign", "false")
  mkdirSync(join(root, "fixture-hooks"))
  git("config", "core.hooksPath", join(root, "fixture-hooks"))
  git("add", ".")
  git("commit", "--quiet", "-m", "native task input baseline")
  const base = git("rev-parse", "HEAD").trim()
  nativeFixture = { root, base, compatibilityBase: base }
  const packagePath = join(root, "src/web/package.json")
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"))
  pkg.dependencies["react-resizable-panels"] = "4.12.3"
  writeFileSync(packagePath, JSON.stringify(pkg))
  git("add", "src/web/package.json")
  git("commit", "--quiet", "-m", "baseline compatibility version")
  nativeFixture.compatibilityBase = git("rev-parse", "HEAD").trim()
  git("reset", "--hard", "--quiet", base)
  nativeInventory = queryNativeTasks({ root, baseSha: base, headSha: base }).inventory
  return nativeFixture
}

const nativeObservations = new Map<string, ReturnType<typeof queryNativeTasks>>()
function nativeFacts(changes) {
  const observationKey = JSON.stringify(changes)
  if (nativeObservations.has(observationKey)) return structuredClone(nativeObservations.get(observationKey))
  const { root, base } = nativeRepository()
  const saved = new Map<string, Buffer | null>()
  try {
    for (const change of changes) {
      for (const original of [change.old_path, change.path].filter(Boolean)) {
        const file = resolve(root, String(original).replaceAll("\\", "/"))
        if (!file.startsWith(root + "/")
          || ["turbo.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].some(name => file === join(root, name))) continue
        if (!saved.has(file)) saved.set(file, existsSync(file) ? readFileSync(file) : null)
        if (original === change.old_path || change.status?.startsWith("D")) {
          if (existsSync(file)) unlinkSync(file)
        } else {
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, file.endsWith("/package.json") ? JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), nativeFixtureChange: true }) : "native task fixture changed bytes\n")
        }
      }
    }
    const facts = queryNativeTasks({ root, baseSha: base, headSha: base })
    nativeObservations.set(observationKey, structuredClone(facts))
    return facts
  } finally {
    for (const [file, bytes] of saved) {
      if (bytes) writeFileSync(file, bytes)
      else if (existsSync(file)) unlinkSync(file)
    }
  }
}

// Policy projections share one real observation of this immutable one-case-per-file,
// single-partition fixture. Native selection and CLI integration tests below still
// invoke the collector independently; this helper does not predict native shards.
let browserFacts: ReturnType<typeof queryNativeUiFacts>
function buildExecutionPlan(changes, options = {}) {
  const settings = { nativeTasks: nativeFacts(changes), ...options }
  const draft = createExecutionPlan(changes, settings)
  if (!draft.jobs.ui_e2e) return draft
  const selection = [...draft.ui.specs].sort()
  const files = selection[0] === "all" ? browserFacts.files : selection
  const cases = browserFacts.cases.filter(test => files.includes(test.file))
  const nativeUi = validateNativeUiFacts({
    ...browserFacts,
    selection,
    files,
    cases,
    shards: [{ current: 1, total: 1, files, cases: cases.map(test => test.key) }],
  }, draft.ui.specs)
  return createExecutionPlan(changes, { ...settings, nativeUi })
}

function classifyPaths(paths, options = {}) {
  return buildExecutionPlan(paths.map(path => ({ status: "M", path })), options)
}

beforeAll(() => {
  browserFacts = queryNativeUiFacts(["all"], { root: nativeRepository().root, shardCount: 1 })
})
afterAll(() => { if (nativeFixture) rmSync(nativeFixture.root, { recursive: true, force: true }) })

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
  for (const path of manifest.smoke_tests) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), "")
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

function runFixtureCli(args: string[], root = nativeRepository().root) {
  return execFileSync(process.execPath, [realpathSync(join(root, "scripts/ci/changed-scopes.mjs")), ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  })
}

function gitDiffFixture(changedPath = "src/app/src/commands/inbox.ts") {
  const baseline = nativeRepository()
  const root = mkdtempSync(join(tmpdir(), "alook-ci-git-"))
  execFileSync("git", ["worktree", "add", "--quiet", "--detach", root, baseline.compatibilityBase], { cwd: baseline.root, env: cleanGitEnvironment(), stdio: "ignore" })
  if (!existsSync(join(root, "node_modules"))) symlinkSync(resolve(import.meta.dirname, "../../node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  symlinkSync(resolve(import.meta.dirname, "../../src/web/node_modules"), join(root, "src/web/node_modules"), process.platform === "win32" ? "junction" : "dir")
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, env: cleanGitEnvironment(), stdio: "ignore" })
  const commit = (message: string) => runGit("-c", "user.name=Alook CI", "-c", "user.email=ci@alook.local",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message)
  const packagePath = join(root, "src/web/package.json")
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"))
  if (changedPath === "src/web/package.json") {
    pkg.dependencies["react-resizable-panels"] = "4.12.4"
    writeFileSync(packagePath, JSON.stringify(pkg))
  } else {
    mkdirSync(dirname(join(root, changedPath)), { recursive: true })
    writeFileSync(join(root, changedPath), "export const fixture = true\\n")
  }
  runGit("add", changedPath)
  commit("changed input")
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, env: cleanGitEnvironment(), encoding: "utf8" }).trim()
  return { changedPath, root, gitDir, cleanup: () => execFileSync("git", ["worktree", "remove", "--force", root], { cwd: baseline.root, env: cleanGitEnvironment(), stdio: "ignore" }) }
}

describe("canonical execution plan", () => {
  it("builds the cold service dependency for Web contracts without daemon unit selection", () => {
    const result = plan(["src/web/src/components/home/landing-content.ts"])
    expect(result.full).toBe(false)
    expect(result.suites.unit_tasks).toContain("@alook/web#test:contracts")
    expect(result.suites.unit_tasks).not.toContain("@alook/daemon#test")
    expect(result.suites.unit_build_tasks).toContain("@alook/agent-driver#build")
  })

  it.each([
    {
      path: "src/web/src/hooks/community/use-friends.ts",
      owner: "@alook/web",
      unitRoot: "src/web",
      consumers: ["04-dm.spec.ts", "07-invite.spec.ts"],
    },
    {
      path: "src/web/src/hooks/community/community-ws/presence-machine-events.ts",
      owner: "@alook/web",
      unitRoot: "src/web",
      consumers: ["07-invite.spec.ts", "30-bot-profile-bounds.spec.ts"],
    },
    {
      path: "src/ws-do/src/ws-durable/presence-typing.ts",
      owner: "@alook/ws-do",
      unitRoot: "src/ws-do",
      consumers: ["07-invite.spec.ts"],
    },
  ])("keeps cross-feature browser consumers for $path through the existing full UI fallback", ({ path, owner, unitRoot, consumers }) => {
    const result = plan([path])
    expect(result.full).toBe(false)
    expect(result.execution_mode).toBe("affected")
    expect(result.packages.direct).toEqual([owner])
    expect(result.suites.unit).toContain(unitRoot)
    expect(result.ui.specs).toEqual(["all"])
    const matrix = JSON.parse(projectPlan(result).e2e_matrix)
    expect(matrix.include.flatMap((entry) => entry.specs)).toEqual(expect.arrayContaining(
      consumers.map((spec) => `src/test/e2e-ui/${spec}`),
    ))
    expect(plan(["src/web/src/components/community/shell/user-bar.tsx", path]).ui.specs).toEqual(["all"])
    const main = plan([path], { mainSmoke: true })
    expect(main.execution_mode).toBe("main-smoke")
    expect(main.ui.specs).toEqual([...loadScopeManifest().ui.contracts.smoke].sort())
  })

  it.each([
    ["src/web/src/components/authenticated-context-menu-boundary.tsx", "54-authenticated-context-menu-policy.spec.ts"],
    ["src/web/src/app/(auth)/sign-in/sign-in-client.tsx", "10-eject-nav-auth.spec.ts"],
    ["src/web/src/components/download/download-current-platform.tsx", "19-marketing-seo.spec.ts"],
    ["src/web/src/app/(home)/page.tsx", "19-marketing-seo.spec.ts"],
    ["src/web/src/app/og/route.tsx", "51-share-image-assets.spec.ts"],
    ["src/web/src/app/_og/render-og-image.tsx", "51-share-image-assets.spec.ts"],
    ["src/web/src/app/api/community/billing/route.ts", "64-billing-contact.spec.ts"],
    ["src/web/src/hooks/community/use-billing.ts", "64-billing-contact.spec.ts"],
    ["src/web/src/app/contact/page.tsx", "64-billing-contact.spec.ts"],
  ])("maps real feature path %s to its existing HTTP/browser journey", (path, consumer) => {
    const result = plan([path])
    expect(result.full).toBe(false)
    expect(result.ui.specs).not.toContain("all")
    expect(result.ui.specs).toContain(consumer)
    expect(JSON.parse(projectPlan(result).e2e_matrix).include.flatMap(entry => entry.specs)).toContain("src/test/e2e-ui/" + consumer)
    expect(plan([path, "src/web/src/lib/billing/service.ts"]).ui.specs).toEqual(["all"])
  })

  it("selects the real invite journey for the localized invitation dialog", () => {
    const result = plan(["src/web/src/components/community/social/invite-dialog.tsx"])
    expect(result.full).toBe(false)
    expect(result.ui.specs).not.toContain("all")
    expect(result.ui.specs).toContain("07-invite.spec.ts")
    expect(JSON.parse(projectPlan(result).e2e_matrix).include.flatMap((entry) => entry.specs))
      .toContain("src/test/e2e-ui/07-invite.spec.ts")
  })

  it("unions localized UI features with key journeys without selecting unrelated browser groups", () => {
    const source = "src/web/src/components/community/shell/user-bar.tsx"
    const result = plan([source])
    expect(result.full).toBe(false)
    expect(result.ui.specs).toEqual(expect.arrayContaining([
      "01-auth.spec.ts", "03-realtime-multiuser.spec.ts", "06-channel-member-admin.spec.ts",
      "50-daemon-update-notice.spec.ts", "53-mobile-inbox-surface.spec.ts", "60-desktop-default-user-bar-width.spec.ts",
    ]))
    expect(result.ui.specs).not.toContain("all")
    expect(result.ui.specs.some(spec => spec.startsWith("55-"))).toBe(false)
    const mixed = plan([source, "src/web/src/components/home/landing-workspace-skeleton.tsx"])
    expect(mixed.ui.specs).toEqual(expect.arrayContaining([
      ...result.ui.specs, "19-marketing-seo.spec.ts", "51-share-image-assets.spec.ts",
    ]))
    expect(new Set(mixed.ui.specs).size).toBe(mixed.ui.specs.length)
    expect(projectPlan(mixed).e2e_matrix).not.toContain('"all"')
  })

  it("keeps direct browser edits and expands removed specs, shared helpers and unclassified runtime inputs", () => {
    const spec = "src/web/src/test/e2e-ui/64-billing-contact.spec.ts"
    const nativeTasks = nativeFacts(modified(spec))
    const uiPlan = (changes) => createExecutionPlan(changes, { nativeTasks })
    expect(uiPlan(modified(spec)).ui.specs).toContain("64-billing-contact.spec.ts")
    expect(uiPlan(modified("src/web/src/components/community/shell/user-bar.test.ts")).ui.specs).toEqual([])
    for (const path of [
      "src/web/src/test/e2e-ui/_fixtures/actions.ts",
      "src/web/src/test/e2e-ui/community-cache-first-warm-reload.journey.ts",
      "src/web/src/lib/community/community-db/sync.ts",
      "src/web/src/components/community/messages/message-list.tsx",
      "src/web/src/app/api/community/channels/[id]/messages/route.ts",
      "src/web/src/app/globals.css",
      "src/shared/src/schema.ts",
    ]) expect(uiPlan(modified(path)).ui.specs, path).toEqual(["all"])
    const removed = uiPlan([{ status: "D", path: "src/web/src/test/e2e-ui/retired.spec.ts" }])
    expect(removed.ui.specs).toEqual(["all"])
    const renamed = uiPlan([{ status: "R100", old_path: spec, path: "src/web/src/lib/moved-runtime.ts" }])
    expect(renamed.ui.specs).toEqual(["all"])
  })

  it("starts Blog for the native partition containing66 and keeps Web-only consumers isolated", () => {
    const blog = plan(["src/web/src/test/e2e-ui/66-public-static-resource-cache.spec.ts"])
    expect(blog.ui.zones).toEqual(["web", "blog"])
    expect(JSON.parse(projectPlan(blog).e2e_matrix).include).toEqual([
      expect.objectContaining({ specs: expect.arrayContaining(["src/test/e2e-ui/66-public-static-resource-cache.spec.ts"]), zones: ["web", "blog"] }),
    ])
    const web = plan(["src/web/src/test/e2e-ui/64-billing-contact.spec.ts"])
    expect(web.ui.zones).toEqual(["web"])
    expect(JSON.parse(projectPlan(web).e2e_matrix).include).toEqual([
      expect.objectContaining({ specs: expect.arrayContaining(["src/test/e2e-ui/64-billing-contact.spec.ts"]), zones: ["web"] }),
    ])
  })

  it("runs the complete small main smoke set without repeating full package or platform suites", () => {
    const result = plan(["src/web/src/components/community/shell/user-bar.tsx"], { mainSmoke: true })
    const manifest = loadScopeManifest()
    expect(result.execution_mode).toBe("main-smoke")
    expect(result.suites.smoke).toEqual(manifest.smoke_tests)
    for (const kind of ["static", "build", "knip", "unit", "windows", "integration", "linux"]) {
      expect(result.suites[kind], kind).toEqual([])
    }
    expect(result.ui.specs).toEqual([...manifest.ui.contracts.smoke].sort())
    expect(result.jobs.test_linux).toBe(true)
    expect(result.jobs.ui_e2e).toBe(true)
    expect(result.jobs.e2e).toBe(false)
    expect(result.jobs.lighthouse).toBe(false)
    expect(result.coverage.targets).toEqual([])
    expect(result.coverage.required_changed_files).toEqual([])
    expect(validateExecutionPlan(result)).toEqual(result)
    expect(projectPlan(result).smoke_test_files).toBe(JSON.stringify(manifest.smoke_tests))
    expect(plan(["src/web/src/components/community/shell/user-bar.test.ts"], { mainSmoke: true }).ui.specs).toEqual([])
    expect(plan(["src/web/blog/src/content/example.mdx"], { mainSmoke: true }).ui.specs).toEqual(manifest.ui.contracts.blog)
  })

  it("preserves full fallback and explicit release/manual regression instead of labelling it smoke", () => {
    for (const options of [{ forceFull: true }, { mainSmoke: true, fallbackReason: "diff failed" }]) {
      const result = plan(["src/web/src/components/home/hero.tsx"], options)
      expect(result.execution_mode).toBe("full")
      expect(result.ui.specs).toEqual(["all"])
      expect(result.suites.integration).toContain("web")
      expect(result.suites.smoke).toEqual([])
    }
    for (const path of ["unknown/runtime.ts", "scripts/ci/changed-scopes.mjs", "pnpm-lock.yaml"]) {
      expect(plan([path], { mainSmoke: true }).execution_mode).toBe("full")
    }
  })

  it("rejects a correctly rehashed plan that drops smoke or claims an inconsistent execution mode", () => {
    const original = plan(["src/web/src/components/home/hero.tsx"], { mainSmoke: true })
    const dropped = structuredClone(original)
    dropped.suites.smoke.pop()
    expect(() => validateExecutionPlan(resignPlan(dropped))).toThrow("complete smoke set")
    const wrongMode = { ...original, execution_mode: "full" }
    expect(() => validateExecutionPlan(resignPlan(wrongMode))).toThrow("mode")
    const unknown = structuredClone(original)
    unknown.suites.smoke.push("unknown.test.ts")
    expect(() => validateExecutionPlan(resignPlan(unknown))).toThrow("smoke tests")
    const skipped = structuredClone(original)
    skipped.jobs.test_linux = false
    expect(() => validateExecutionPlan(resignPlan(skipped))).toThrow("complete selected behavior")
  })

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

  it.each([
    "src/app/src/commands/inbox.ts", "src/daemon/src/index.ts", "src/web/src/app/page.tsx",
    "src/web/auth/index.ts", "src/web/blog/src/app/page.tsx", "src/web/blog/src/content/example.mdx", "src/shared/src/schema.ts",
  ])("preserves the product contract for %s when benchmark changes are mixed in", (product) => {
    const expected = plan([product])
    const mixed = plan([product, "src/benchmark/src/runner.mjs"])
    for (const field of ["change_class", "full", "packages", "suites", "jobs", "coverage", "ui", "auth_only", "blog_only"]) expect(mixed[field]).toEqual(expected[field])
  })

  it.each([
    ["src/web/auth/index.ts", "src/benchmark/index.ts"],
    ["src/benchmark/index.ts", "src/web/auth/index.ts"],
  ])("preserves both sides of a product/benchmark rename from %s to %s", (old_path, path) => {
    const result = buildExecutionPlan([{ status: "R100", old_path, path }])
    expect(result.jobs).toEqual(plan(["src/web/auth/index.ts"]).jobs)
    expect(result.paths).toEqual(["src/benchmark/index.ts", "src/web/auth/index.ts"])
  })

  it("keeps unknown, policy, empty and explicit full changes fail-closed", () => {
    for (const path of ["src/benchmark-other/new.mjs", "unknown/code.js", ".github/workflows/ci.yml"]) expect(plan([path, "src/benchmark/src/runner.mjs"]).full).toBe(true)
    expect(plan([]).full).toBe(true)
    expect(plan(["src/benchmark/src/runner.mjs"], { forceFull: true }).full).toBe(true)
    expect(plan(["src/benchmark/src/runner.mjs"], { fallbackReason: "diff failed" }).full).toBe(true)
    expect(plan(["src/benchmark/src/runner.mjs"], { mainSmoke: true }).full).toBe(false)
    expect(plan(["README.md"], { mainSmoke: true }).suites.smoke).toEqual([])
  })

  it("routes Blog runtime through its independent tasks and cross-zone consumers", () => {
    const result = plan(["src/web/blog/src/app/page.tsx"])

    expect(result.change_class).toBe("blog")
    expect(result.packages.direct).toEqual(["@alook/web"])
    expect(result.packages.affected).toEqual(["@alook/agent-driver", "@alook/storybook", "@alook/web"])
    expect(result.suites.unit_build_tasks).toEqual(["@alook/agent-driver#build"])
    expect(result.suites.unit_tasks).not.toContain("@alook/agent-driver#test")
    expect(result.suites.unit).toEqual(["src/web"])
    expect(result.coverage.targets).toEqual(["web"])
    expect(result.coverage.include_roots).toEqual(["src/web/**/*.{ts,tsx,js,jsx}"])
    expect(result.ui.specs).toEqual(["54-blog-multizone.spec.ts", "66-public-static-resource-cache.spec.ts"])
    expect(result.suites.integration).toEqual([])
    expect(result.suites.windows).toEqual([])
    expect(result.suites.build_tasks).toContain("@alook/web#build:blog")
    expect(result.suites.knip_tasks).toContain("@alook/web#knip")
    expect(result.jobs.blog_build).toBe(true)
    expect(result.jobs.lighthouse).toBe(true)
    expect(result.jobs.app_packed_artifact).toBe(false)
  })

  it("selects Blog unit tasks and its cross-worker contract for content", () => {
    const result = plan([
      "src/web/blog/src/content/example.mdx",
      "src/web/blog/public/blog/example/hero.webp",
    ])

    expect(result.change_class).toBe("blog")
    expect(result.blog_only).toBe(true)
    expect(result.packages.direct).toEqual(["@alook/web"])
    expect(result.packages.affected).toEqual(["@alook/agent-driver", "@alook/storybook", "@alook/web"])
    expect(result.suites.unit_build_tasks).toEqual(["@alook/agent-driver#build"])
    expect(result.suites.unit_tasks).not.toContain("@alook/agent-driver#test")
    expect(result.suites.unit).toEqual(["src/web"])
    expect(result.suites.unit_tasks).toContain("@alook/web#test:blog")
    expect(result.suites.unit_tasks).not.toContain("@alook/web#test")
    expect(result.coverage.include_roots).toEqual(["src/web/**/*.{ts,tsx,js,jsx}"])
    expect(result.ui.specs).toEqual(["54-blog-multizone.spec.ts", "66-public-static-resource-cache.spec.ts"])
    expect(result.jobs.blog_build).toBe(true)
  })

  it("routes the standalone auth Worker through Web checks and its own dry-run only", () => {
    const result = plan(["src/web/auth/index.ts"])

    expect(result.native_tasks.affected.find(task => task.fullName === "@alook/web#build:blog").reason).toEqual({
      __typename: "TaskAllChanged", description: "required by an affected task",
    })
    expect(result.change_class).toBe("auth")
    expect(result.auth_only).toBe(true)
    expect(result.packages.direct).toEqual(["@alook/web"])
    expect(result.packages.affected).toEqual(["@alook/agent-driver", "@alook/storybook", "@alook/web"])
    expect(result.suites.unit_build_tasks).toEqual(["@alook/agent-driver#build"])
    expect(result.suites.unit_tasks).not.toContain("@alook/agent-driver#test")
    expect(result.suites.static).toEqual(["@alook/storybook", "@alook/web"])
    expect(result.suites.build_tasks).toEqual(["@alook/web#build:auth"])
    expect(result.suites.knip_tasks).toEqual(["@alook/web#knip"])
    expect(result.suites.unit).toEqual(["src/web"])
    expect(result.coverage.targets).toEqual(["web"])
    expect(result.suites.integration).toEqual([])
    expect(result.ui.specs).toEqual([])
    expect(result.jobs.auth_build).toBe(true)
    expect(result.jobs.blog_build).toBe(false)
    expect(result.jobs.lighthouse).toBe(false)
    expect(result.jobs.app_packed_artifact).toBe(false)
    expect(result.artifacts.worker_zones).toEqual([])
  })

  it("checks standalone workbench source without scheduling product execution", () => {
    const result = plan(["src/storybook/stories/foundations/button.stories.tsx"])

    expect(result.full).toBe(false)
    expect(result.packages.direct).toEqual(["@alook/storybook"])
    expect(result.packages.affected).toEqual(["@alook/storybook"])
    expect(result.suites.static_tasks).toEqual(["@alook/storybook#typecheck", "@alook/storybook#lint"])
    expect(result.suites.unit_tasks).toEqual([])
    expect(result.suites.unit_build_tasks).toEqual([])
    expect(result.coverage.targets).toEqual([])
    expect(result.suites.build_tasks).toEqual([])
    expect(result.suites.knip_tasks).toEqual([])
    expect(result.suites.integration).toEqual([])
    expect(result.suites.windows).toEqual([])
    expect(result.ui.specs).toEqual([])
    expect(result.jobs.app_packed_artifact).toBe(false)
    expect(result.jobs.blog_build).toBe(false)
    expect(result.jobs.auth_build).toBe(false)
  })

  it("selects the active app package without retired CLI suites", () => {
    const result = plan(["src/app/src/commands/inbox.ts"])
    expect(result.change_class).toBe("package")
    expect(result.packages.affected).toEqual(["@alook/agent-driver", "@alook/app", "@alook/daemon"])
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

  it("uses native shared task owners and their declared build prerequisites", () => {
    const result = plan(["src/shared/src/schema.ts"])

    expect(result.change_class).toBe("shared")
    expect(result.packages.affected).toEqual([
      "@alook/agent-driver",
      "@alook/app",
      "@alook/daemon",
      "@alook/email-worker",
      "@alook/queue-worker",
      "@alook/shared",
      "@alook/storybook",
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
    expect(projection.plan_hash).toBe(first.plan_hash)
    expect(JSON.parse(projection.static_packages)).toEqual(first.suites.static)
    expect(JSON.parse(projection.integration_suites)).toEqual(first.suites.integration)

    const auth = projectPlan(plan(["src/web/auth/wrangler.toml"]))
    expect(auth.auth_only).toBe("true")
    expect(auth.run_auth_build).toBe("true")

    expect(() => validateExecutionPlan({ ...first, head_sha: sha("c") })).toThrow("hash")
  })

  it("projects the resizable-panels compatibility gate from the dependency diff", () => {
    const unchanged = plan(["src/web/package.json"])
    expect(unchanged.compatibility.resizable_panels).toBe(false)
    expect(unchanged.jobs.resizable_panels_compat).toBe(false)
    expect(projectPlan(unchanged).run_resizable_panels_compat).toBe("false")

    const changed = plan(["src/web/package.json"], { resizablePanelsChanged: true })
    expect(changed.compatibility.resizable_panels).toBe(true)
    expect(changed.jobs.resizable_panels_compat).toBe(true)
    expect(projectPlan(changed).run_resizable_panels_compat).toBe("true")

    const altered = structuredClone(changed)
    altered.jobs.resizable_panels_compat = false
    expect(() => validateExecutionPlan(resignPlan(altered)))
      .toThrow("does not match")

    const missingFlag = structuredClone(changed)
    delete missingFlag.compatibility.resizable_panels
    expect(() => validateExecutionPlan(resignPlan(missingFlag)))
      .toThrow("compatibility flag is required")
  })

  it("rejects every stale identifier in an otherwise authentic signed plan", () => {
    const current = plan(["src/shared/src/schema.ts"])
    expect(() => validateExecutionPlan({ ...current, schema_version: current.schema_version + 1 }))
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
    const coveragePlan = (path: string) => createExecutionPlan(modified(path), {
      forceFull: true, nativeTasks: { inventory: nativeInventory, affected: nativeInventory },
    })
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
      expect(coveragePlan(path).coverage.required_changed_files).toEqual([])
    }

    expect(coveragePlan("scripts/ci/changed-scopes.mjs").coverage.required_changed_files)
      .toEqual(["scripts/ci/changed-scopes.mjs"])
  })

  it("excludes only the OpenNext config, not config-lookalike runtime files", () => {
    const result = plan([
      "src/web/open-next.config.ts",
      "src/web/src/lib/runtime-lookalike.config.ts",
    ])

    expect(result.packages.affected).toEqual(["@alook/agent-driver", "@alook/app", "@alook/storybook", "@alook/web"])
    expect(result.suites.unit_build_tasks).toEqual(["@alook/agent-driver#build"])
    expect(result.suites.unit_tasks).not.toContain("@alook/agent-driver#test")
    expect(result.suites.unit).toEqual(["src/app", "src/web"])
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
  it("rejects broken smoke and feature definitions before selecting jobs", () => {
    const original = loadScopeManifest()
    const noFallback = structuredClone(original)
    noFallback.ui.full_prefixes = []
    expect(() => validateScopeManifest(noFallback)).toThrow("full-scope prefixes")
    const missingSpec = structuredClone(original)
    missingSpec.ui.groups[0].specs.push("missing.spec.ts")
    expect(() => validateScopeManifest(missingSpec)).toThrow("unknown UI spec")
    const duplicatedGroup = structuredClone(original)
    duplicatedGroup.ui.groups.push(structuredClone(duplicatedGroup.ui.groups[0]))
    expect(() => validateScopeManifest(duplicatedGroup)).toThrow("group names")
    const outside = structuredClone(original)
    outside.smoke_tests.push("../outside.test.ts")
    expect(() => validateScopeManifest(outside)).toThrow("main smoke tests")
    const missingSmoke = structuredClone(original)
    missingSmoke.smoke_tests.push("src/web/src/missing-main-smoke.test.ts")
    expect(() => validateScopeManifest(missingSmoke)).toThrow("missing main smoke test")
  })
  it("matches workspace package manifests and the complete UI inventory", () => {
    const manifest = loadScopeManifest()
    expect(() => validateScopeManifest(manifest)).not.toThrow()
    expect(manifest.schema_version).toBe(2)
  })

  it("rejects invalid versions, registries, packages, paths, targets, and specs", () => {
    const manifest = loadScopeManifest()

    expect(() => validateScopeManifest({ ...manifest, schema_version: manifest.schema_version + 1 }))
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
    codecovDrift.codecov_targets.shared.path = "src/other-shared"
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
        specs: [...Object.values(manifest.ui.contracts).flat(), ...manifest.ui.groups.flatMap((group) => group.specs)],
      })).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects malformed Codecov sections and package test contracts", () => {
    for (const codecov of [
      (source: string) => source.replace("    project:", "    projects:"),
      (source: string) => source.replace(/^      ([^:\n]+):$/m, "      future:"),
      (source: string) => source.replace("informational: true", "informational: false"),
    ]) {
      const { manifest, root } = workspaceFixture({ codecov })
      try {
        expect(() => validateScopeManifest(manifest, {
          root,
          specs: [...Object.values(manifest.ui.contracts).flat(), ...manifest.ui.groups.flatMap((group) => group.specs)],
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
        specs: [...Object.values(manifest.ui.contracts).flat(), ...manifest.ui.groups.flatMap((group) => group.specs)],
      })).toThrow("declares test scope")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("compatibility and CLI fail-closed behavior", () => {
  it("orders Web Knip after Blog generation and keeps non-Web Knip independent", () => {
    const fixture = gitDiffFixture()
    const previous = process.env.WORKERS_CI_COMMIT_SHA
    const dry = (task: string) => JSON.parse(execFileSync(process.execPath, [realpathSync(join(fixture.root, "scripts/ci/run-turbo.mjs")), "run", task, "--dry=json"], { cwd: fixture.root, env: cleanGitEnvironment(), encoding: "utf8" })).tasks
    try {
      process.env.WORKERS_CI_COMMIT_SHA = "a".repeat(40)
      const web = dry("@alook/web#knip")
      const unrelated = dry("@alook/agent-driver#knip")
      const knip = web.find(task => task.taskId === "@alook/web#knip")
      expect(web.map(task => task.taskId)).toContain("@alook/web#build:blog")
      expect(knip.dependencies).toContain("@alook/web#build:blog")
      expect(unrelated.map(task => task.taskId)).not.toContain("@alook/web#build:blog")
      expect(unrelated.map(task => task.taskId)).not.toContain("@alook/web#knip")
      process.env.WORKERS_CI_COMMIT_SHA = "b".repeat(40)
      expect(dry("@alook/web#knip").find(task => task.taskId === "@alook/web#knip").hash).not.toBe(knip.hash)
      expect(dry("@alook/agent-driver#knip").find(task => task.taskId === "@alook/agent-driver#knip").hash).toBe(unrelated.find(task => task.taskId === "@alook/agent-driver#knip").hash)
    } finally {
      if (previous === undefined) delete process.env.WORKERS_CI_COMMIT_SHA
      else process.env.WORKERS_CI_COMMIT_SHA = previous
      fixture.cleanup()
    }
  })

  it("keeps Blog hashes independent of generated images while retaining canonical image inputs", () => {
    const fixture = gitDiffFixture()
    const dry = () => JSON.parse(execFileSync(process.execPath, [realpathSync(join(fixture.root, "scripts/ci/run-turbo.mjs")), "run", "@alook/web#build:blog", "--dry=json"], { cwd: fixture.root, env: cleanGitEnvironment(), encoding: "utf8" })).tasks.find(task => task.taskId === "@alook/web#build:blog")
    try {
      const before = dry()
      const generated = join(fixture.root, "src/web/blog/public/blog/_generated")
      const manifest = join(fixture.root, "src/web/blog/src/lib/blog/image-assets.json")
      const canonical = Object.keys(JSON.parse(readFileSync(manifest, "utf8")))[0]!
      mkdirSync(generated, { recursive: true })
      writeFileSync(join(generated, "derived.webp"), "generated output bytes")
      writeFileSync(manifest, '{"derived":true}\n')
      expect(dry().hash).toBe(before.hash)
      writeFileSync(join(fixture.root, "src/web/blog/public", canonical), "changed canonical image bytes")
      expect(dry().hash).not.toBe(before.hash)
    } finally { fixture.cleanup() }
  })

  it.each([
    "src/web/src/lib/worker-runtime.ts",
    "src/web/src/lib/observability/trace-response.ts",
    "src/web/package.json",
  ])("selects and invalidates the App filesystem contract for %s", path => {
    const fixture = gitDiffFixture()
    const dry = () => JSON.parse(execFileSync(process.execPath, [realpathSync(join(fixture.root, "scripts/ci/run-turbo.mjs")), "run", "@alook/app#test", "--dry=json"], { cwd: fixture.root, env: cleanGitEnvironment(), encoding: "utf8" })).tasks.find(task => task.taskId === "@alook/app#test")
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.root, env: cleanGitEnvironment(), encoding: "utf8" }).trim()
      const before = dry()
      const file = join(fixture.root, path)
      const bytes = readFileSync(file, "utf8")
      writeFileSync(file, path.endsWith("package.json") ? JSON.stringify({ ...JSON.parse(bytes), nativeAppContractFixture: true }) : bytes + "\n// changed borrowed runtime source\n")
      const facts = queryNativeTasks({ root: fixture.root, baseSha: head, headSha: head })
      expect(facts.reason).toBeNull()
      expect(facts.affected.map(task => task.fullName)).toContain("@alook/app#test")
      expect(dry().hash).not.toBe(before.hash)
      expect(createExecutionPlan([{ status: "M", path }], { nativeTasks: facts }).suites.unit_tasks).toContain("@alook/app#test")
    } finally { fixture.cleanup() }
  })

  it("keeps an unrelated Web component outside the App filesystem task and cache", () => {
    const fixture = gitDiffFixture()
    const dry = () => JSON.parse(execFileSync(process.execPath, [realpathSync(join(fixture.root, "scripts/ci/run-turbo.mjs")), "run", "@alook/app#test", "--dry=json"], { cwd: fixture.root, env: cleanGitEnvironment(), encoding: "utf8" })).tasks.find(task => task.taskId === "@alook/app#test")
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.root, env: cleanGitEnvironment(), encoding: "utf8" }).trim()
      const before = dry()
      writeFileSync(join(fixture.root, "src/web/src/components/home/landing-content.ts"), "export const unrelated = true\n")
      const facts = queryNativeTasks({ root: fixture.root, baseSha: head, headSha: head })
      expect(facts.reason).toBeNull()
      expect(facts.affected.map(task => task.fullName)).not.toContain("@alook/app#test")
      expect(dry().hash).toBe(before.hash)
    } finally { fixture.cleanup() }
  })

  it("hashes the real Worker-CI telemetry release input in both builds", () => {
    const fixture = gitDiffFixture("src/web/src/lib/worker-source-input-fixture.ts")
    const previous = process.env.WORKERS_CI_COMMIT_SHA
    const dry = () => JSON.parse(execFileSync(process.execPath, [realpathSync(join(fixture.root, "scripts/ci/run-turbo.mjs")), "run", "@alook/web#build", "@alook/web#build:blog", "--dry=json"], { cwd: fixture.root, env: cleanGitEnvironment(), encoding: "utf8" })).tasks
    try {
      process.env.WORKERS_CI_COMMIT_SHA = "a".repeat(40)
      const before = dry()
      process.env.WORKERS_CI_COMMIT_SHA = "b".repeat(40)
      const after = dry()
      for (const id of ["@alook/web#build", "@alook/web#build:blog"]) {
        expect(after.find(task => task.taskId === id).hash).not.toBe(before.find(task => task.taskId === id).hash)
      }
    } finally {
      if (previous === undefined) delete process.env.WORKERS_CI_COMMIT_SHA
      else process.env.WORKERS_CI_COMMIT_SHA = previous
      fixture.cleanup()
    }
  })

  it("invalidates builds when their shared repository Git policy changes", () => {
    const fixture = gitDiffFixture("src/app/src/policy-input-fixture.ts")
    const tasks = ["@alook/agent-driver#build", "@alook/web#build"]
    const dry = () => JSON.parse(execFileSync(process.execPath, [realpathSync(join(fixture.root, "scripts/ci/run-turbo.mjs")), "run", ...tasks, "--dry=json"], { cwd: fixture.root, env: cleanGitEnvironment(), encoding: "utf8" })).tasks
    try {
      const before = dry()
      const path = join(fixture.root, "scripts/ci/repository-git.mjs")
      writeFileSync(path, readFileSync(path, "utf8") + "\n")
      const after = dry()
      for (const id of tasks) expect(after.find(task => task.taskId === id).hash).not.toBe(before.find(task => task.taskId === id).hash)
    } finally { fixture.cleanup() }
  })

  it("invalidates the driver build for root LICENSE and declares its ignored license output", () => {
    const fixture = gitDiffFixture("src/daemon/agent-driver/src/license-input-fixture.ts")
    const dry = () => JSON.parse(execFileSync(process.execPath, [realpathSync(join(fixture.root, "scripts/ci/run-turbo.mjs")), "run", "@alook/agent-driver#build", "--dry=json"], { cwd: fixture.root, env: cleanGitEnvironment(), encoding: "utf8" })).tasks.find(task => task.taskId === "@alook/agent-driver#build")
    try {
      const before = dry()
      writeFileSync(join(fixture.root, "LICENSE"), "changed root license input")
      const after = dry()
      expect(after.hash).not.toBe(before.hash)
      expect(after.outputs).toEqual(expect.arrayContaining(["dist/**", "LICENSE"]))
    } finally { fixture.cleanup() }
  })

  it("reports native conservative fallback as full instead of a successful localized query", () => {
    const fixture = gitDiffFixture("src/web/src/lib/native-fallback-fixture.ts")
    try {
      const file = join(fixture.root, "turbo.json")
      const config = JSON.parse(readFileSync(file, "utf8"))
      config.tasks["@alook/web#test"].inputs.push("!public/{sw.js,sw.js.map,community-shell/**}")
      writeFileSync(file, JSON.stringify(config))
      const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.root, env: cleanGitEnvironment(), encoding: "utf8" })
      git("add", "turbo.json")
      git("-c", "user.name=Native fallback fixture", "-c", "user.email=native@example.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "native invalid glob input")
      const head = git("rev-parse", "HEAD").trim()
      const nativeTasks = queryNativeTasks({ root: fixture.root, baseSha: head, headSha: head })
      expect(nativeTasks.reason).toBe("native_affected_fallback")
      const result = createExecutionPlan([{ status: "M", path: "src/web/src/lib/native-fallback-fixture.ts" }], { baseSha: head, headSha: head, nativeTasks })
      expect(result).toMatchObject({ full: true, full_reason: "native_affected_fallback" })
    } finally { fixture.cleanup() }
  })

  describe("workflow scope events", () => {
    let fixture: ReturnType<typeof gitDiffFixture>
    beforeAll(() => {
      fixture = gitDiffFixture("src/web/src/components/community/shell/user-bar.tsx")
    })
    afterAll(() => { fixture?.cleanup() })

    it.each([
      ["pull_request", "change", "affected"],
      ["merge_group", "change", "affected"],
      ["push", "fix: localized user bar", "main-smoke"],
      ["push", "release: v0.1.64", "full"],
      ["workflow_dispatch", "change", "full"],
    ])("runs the actual workflow scope entry for %s / %s", (event, message, mode) => {
      try {
        const workflow = readFileSync(join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8").replaceAll("\r\n", "\n")
        const scope = workflow.slice(workflow.indexOf("\n  scope:\n"), workflow.indexOf("\n  auth-build:\n"))
        const body = scope.slice(scope.indexOf("      - id: scope\n")).match(/        run: \|\n([\s\S]*?)(?=^      - uses:)/m)?.[1]
        expect(body).toBeTruthy()
        const script = body!.replace(/^ {10}/gm, "").replaceAll(
          "node scripts/ci/changed-scopes.mjs", '"$CLASSIFIER_NODE" "$CLASSIFIER_SCRIPT" --ui-shards 1',
        ).replaceAll(".ci/execution-plan.json", '"$SCOPE_PLAN_FILE"').replace("mkdir -p .ci", 'mkdir -p "$SCOPE_DIR"')
        const workflowOutput = execFileSync("bash", ["-c", script], {
          cwd: fixture.root,
          env: {
            ...cleanGitEnvironment(),
            GIT_DIR: fixture.gitDir, GIT_WORK_TREE: fixture.root,
            CLASSIFIER_NODE: process.execPath, CLASSIFIER_SCRIPT: realpathSync(join(fixture.root, "scripts/ci/changed-scopes.mjs")),
            SCOPE_DIR: join(fixture.root, ".ci"), SCOPE_PLAN_FILE: join(fixture.root, ".ci/execution-plan.json"),
            EVENT_NAME: event, EVENT_SHA: "HEAD", PR_BASE_SHA: "HEAD^", PR_HEAD_SHA: "HEAD",
            MERGE_BASE_SHA: "HEAD^", PUSH_BASE_SHA: "HEAD^", HEAD_COMMIT_MESSAGE: message,
            DISPATCH_MODE: "full", GITHUB_OUTPUT: join(fixture.root, "outputs"),
            GITHUB_STEP_SUMMARY: join(fixture.root, "summary"),
          },
        })
        expect(existsSync(join(fixture.root, ".ci/execution-plan.json")), workflowOutput.toString()).toBe(true)
        const result = JSON.parse(readFileSync(join(fixture.root, ".ci/execution-plan.json"), "utf8"))
        expect(result.execution_mode).toBe(mode)
        expect(validateExecutionPlan(result)).toEqual(result)
        if (mode === "full") {
          expect(result.ui.specs).toEqual(["all"])
          expect(result.suites.integration).toContain("web")
        } else if (mode === "main-smoke") {
          expect(result.suites.unit).toEqual([])
          expect(result.suites.smoke).toEqual(loadScopeManifest().smoke_tests)
          expect(result.ui.specs).toEqual([...loadScopeManifest().ui.contracts.smoke].sort())
        } else {
          expect(result.ui.specs).toContain("60-desktop-default-user-bar-width.spec.ts")
          expect(result.ui.specs).not.toContain("all")
        }
        expect(readFileSync(join(fixture.root, "outputs"), "utf8")).toContain(`execution_mode=${mode}\n`)
      } finally {
        for (const path of [".ci", "outputs", "summary"]) {
          rmSync(join(fixture.root, path), { recursive: true, force: true })
        }
      }
    })

  })

  it("detects dependency changes from package manifests instead of branch names", () => {
    const manifest = (version?: string) => JSON.stringify({
      dependencies: version ? { "react-resizable-panels": version } : {},
    })

    expect(packageDependencyVersionChanged(
      manifest("4.12.3"),
      manifest("4.12.3"),
      "react-resizable-panels",
    )).toBe(false)
    expect(packageDependencyVersionChanged(
      manifest("4.12.3"),
      manifest("4.13.3"),
      "react-resizable-panels",
    )).toBe(true)
    expect(packageDependencyVersionChanged(
      manifest(),
      manifest("4.13.3"),
      "react-resizable-panels",
    )).toBe(true)
  })

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
      runFixtureCli(["--ui-shards", "1",
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
      expect(values).toContain("run_resizable_panels_compat=true")
      expect(writtenPlan.full).toBe(true)
      expect(writtenPlan.full_reason).toBe("classifier_error")
      expect(writtenPlan.suites.static_tasks.length).toBeGreaterThan(0)
      expect(writtenPlan.suites.unit_build_tasks).toContain("@alook/agent-driver#build")
      expect(writtenPlan.compatibility.resizable_panels).toBe(true)
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
      runFixtureCli(["--ui-shards", "1",
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
    try {
      const written = runFixtureCli(["--ui-shards", "1", "--base", "HEAD^", "--head", "HEAD", "--main-smoke", "--summary", summary], fixture.root)
      const writtenPlan = JSON.parse(written)
      expect(writtenPlan.full).toBe(false)
      expect(writtenPlan.execution_mode).toBe("main-smoke")
      expect(writtenPlan.base_sha).toBe("HEAD^")
      expect(writtenPlan.head_sha).toBe("HEAD")
      expect(writtenPlan.changes).toEqual([{ status: "A", path: fixture.changedPath }])
      expect(readFileSync(summary, "utf8")).toContain(fixture.changedPath)
    } finally {
      fixture.cleanup()
    }
  })

  it.each([
    ["src/benchmark/src/runner.mjs", false],
    ["src/web/auth/index.ts", false],
  ])("applies main-push policy through the actual CLI diff for %s", (path, full) => {
    const fixture = gitDiffFixture(String(path))
    const output = join(fixture.root, "projection")
    const planFile = join(fixture.root, "plan.json")
    try {
      execFileSync(process.execPath, [realpathSync(join(fixture.root, "scripts/ci/changed-scopes.mjs")), "--ui-shards", "1", "--base", "HEAD^", "--head", "HEAD", "--main-smoke", "--output", output, "--plan-file", planFile], {
        cwd: fixture.root,
        env: cleanGitEnvironment(),
      })
      const result = JSON.parse(readFileSync(planFile, "utf8"))
      expect(result.full).toBe(full)
      expect(result.changes).toEqual([{ status: "M", path }])
    } finally {
      fixture.cleanup()
    }
  })

  describe("actual package-version diff", () => {
    let fixture: ReturnType<typeof gitDiffFixture>
    beforeAll(() => { fixture = gitDiffFixture("src/web/package.json") })
    afterAll(() => { fixture?.cleanup() })

    it("enables the compatibility gate", () => {
      const output = join(fixture.root, "projection")
      const planFile = join(fixture.root, "plan.json")
      execFileSync(process.execPath, [realpathSync(join(fixture.root, "scripts/ci/changed-scopes.mjs")), "--ui-shards", "1", "--base", "HEAD^", "--head", "HEAD", "--output", output, "--plan-file", planFile], {
        cwd: fixture.root,
        env: cleanGitEnvironment(),
      })
      const result = JSON.parse(readFileSync(planFile, "utf8"))
      expect(result.compatibility.resizable_panels).toBe(true)
      expect(result.jobs.resizable_panels_compat).toBe(true)
      expect(readFileSync(output, "utf8")).toContain("run_resizable_panels_compat=true")
    })
  })

  it("fails closed when the CLI SHA boundary is omitted", () => {
    const directory = mkdtempSync(join(tmpdir(), "alook-ci-scope-"))
    const output = join(directory, "output")
    const planFile = join(directory, "plan.json")
    try {
      runFixtureCli(["--ui-shards", "1", "--output", output, "--plan-file", planFile])
      expect(JSON.parse(readFileSync(planFile, "utf8"))).toMatchObject({
        full: true,
        full_reason: "classifier_error",
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
