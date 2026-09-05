import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createE2eMatrix, discoverE2eSpecs } from "./e2e-shards.mjs"

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const MANIFEST_URL = new URL("./change-scope-manifest.json", import.meta.url)
const BLOG_ROOT = /^src\/web\/blog(?:\/|$)/
const AUTH_ROOT = /^src\/web\/auth(?:\/|$)/
const BLOG_CONTENT = /^src\/web\/blog\/src\/content\/[^/]+\.mdx$/
const BLOG_ASSET = /^src\/web\/blog\/public\/blog(?:\/|$)/
const MARKDOWN = /(?:^|\/)\w[^/]*\.md$/i
const WORKFLOW = /^\.github\/workflows\//
const GLOBAL_PATHS = new Set([
  "codecov.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  "vitest.config.ts",
])
const KNOWN_PREFIXES = [".claude/", ".openai/", "docs/"]
const COVERAGE_EXCLUDES = [
  /(?:^|\/)\w[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /(?:^|\/)node_modules\//,
  /(?:^|\/)(?:\.next|\.open-next|\.wrangler|dist|bundled|__mocks__)\//,
  /(?:^|\/)test-runtime\//,
  /(?:^|\/)test-harness\.ts$/,
  /\.d\.ts$/,
  /^src\/cli\/src\/index\.ts$/,
  /^src\/shared\/src\/index\.ts$/,
  /^src\/web\/scripts\//,
  /^src\/web\/readme-capture\//,
  /^src\/web\/src\/.*\.tsx$/,
  /^src\/web\/src\/test\/fixtures\//,
  /^src\/web\/src\/hooks\/(?:use-agent-chat|use-chat-sheets|use-file-attachments|use-message-flags|use-text-selection-quote)\.ts$/,
  /^src\/web\/src\/components\/agent-chat\/use-rotating-placeholder\.ts$/,
]

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
}

function sorted(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))].sort()
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    )
  }
  return value
}

export function stablePlanJson(plan) {
  return JSON.stringify(stableValue(plan))
}

function hashPlan(plan) {
  const { plan_hash: _ignored, ...unsigned } = plan
  return createHash("sha256").update(stablePlanJson(unsigned)).digest("hex")
}

function isBlogContent(path) {
  return BLOG_CONTENT.test(path) || BLOG_ASSET.test(path)
}

function isMarkdown(path) {
  return MARKDOWN.test(path)
}

function pathWithin(path, root) {
  return path === root || path.startsWith(`${root}/`)
}

function coverageRootPrefix(glob) {
  return glob.split("/**")[0]
}

function coverageRootMatches(path, glob) {
  if (!pathWithin(path, coverageRootPrefix(glob))) return false
  const extensionSet = glob.match(/\.\{([^}]+)\}$/)?.[1]
  if (extensionSet) {
    return extensionSet.split(",").some((extension) => path.endsWith(`.${extension}`))
  }
  const extension = glob.match(/\.([0-9A-Za-z]+)$/)?.[1]
  return extension ? path.endsWith(`.${extension}`) : false
}

function isCoverable(path, coverageRoots) {
  return coverageRoots.some((root) => coverageRootMatches(path, root))
    && COVERAGE_EXCLUDES.every((pattern) => !pattern.test(path))
}

function changePaths(change) {
  return change.old_path ? [change.old_path, change.path] : [change.path]
}

function normalizedChanges(changes) {
  return changes
    .map((change) => ({
      status: String(change.status || "M"),
      ...(change.old_path ? { old_path: normalizePath(change.old_path) } : {}),
      path: normalizePath(change.path),
    }))
    .filter((change) => change.path)
    .sort((left, right) => (
      left.path.localeCompare(right.path)
      || (left.old_path || "").localeCompare(right.old_path || "")
      || left.status.localeCompare(right.status)
    ))
}

export function loadScopeManifest(path = MANIFEST_URL) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function packageManifest(scopePackage, root = ROOT) {
  return JSON.parse(readFileSync(resolve(root, scopePackage.root, "package.json"), "utf8"))
}

function workspaceGraph(manifest, root = ROOT) {
  const names = new Set(manifest.packages.map((entry) => entry.name))
  const dependents = new Map(manifest.packages.map((entry) => [entry.name, new Set()]))
  for (const entry of manifest.packages) {
    const workspacePackage = packageManifest(entry, root)
    const dependencies = {
      ...workspacePackage.dependencies,
      ...workspacePackage.devDependencies,
      ...workspacePackage.optionalDependencies,
      ...workspacePackage.peerDependencies,
    }
    for (const [dependency, version] of Object.entries(dependencies)) {
      if (names.has(dependency) && String(version).startsWith("workspace:")) {
        dependents.get(dependency).add(entry.name)
      }
    }
  }
  return dependents
}

function validateCodecovTargets(manifest, root) {
  const source = readFileSync(resolve(root, "codecov.yml"), "utf8").replaceAll("\r\n", "\n")
  const projectSection = source.match(/^[ ]{4}project:\n([\s\S]*?)^[ ]{4}patch:/m)?.[1]
  if (!projectSection) throw new Error("codecov.yml project status section is missing")
  const configuredNames = [...projectSection.matchAll(/^[ ]{6}([^\s:\n][^:\n]*):$/gm)]
    .map((match) => match[1])
    .sort()
  const manifestNames = Object.keys(manifest.codecov_targets).sort()
  if (JSON.stringify(configuredNames) !== JSON.stringify(manifestNames)) {
    throw new Error("scope manifest Codecov project target names do not match codecov.yml")
  }
  for (const [name, target] of Object.entries(manifest.codecov_targets)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const escapedPath = target.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const contract = new RegExp(
      `^[ ]{6}${escapedName}:\\n[ ]{8}target: ${target.target}%\\n[ ]{8}paths:\\n[ ]{10}- ${escapedPath}/\\*\\*$`,
      "m",
    )
    if (!contract.test(projectSection)) {
      throw new Error(`scope manifest Codecov target does not match codecov.yml: ${name}`)
    }
  }
}

export function validateScopeManifest(manifest, options = {}) {
  const root = options.root || ROOT
  if (manifest.schema_version !== 1 || manifest.policy_version !== 1) {
    throw new Error("scope manifest schema/policy version must be 1")
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error("scope manifest packages are required")
  }

  const names = manifest.packages.map((entry) => entry.name)
  const roots = manifest.packages.map((entry) => normalizePath(entry.root))
  if (new Set(names).size !== names.length) throw new Error("package names must be unique")
  if (new Set(roots).size !== roots.length) throw new Error("package root must be unique")
  const workspaceRoots = [...readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8")
    .matchAll(/^[ ]{2}- ["']([^"']+)["']$/gm)]
    .map((match) => normalizePath(match[1]))
    .sort()
  if (JSON.stringify([...roots].sort()) !== JSON.stringify(workspaceRoots)) {
    throw new Error("scope manifest package roots must exactly match pnpm-workspace.yaml")
  }

  for (const [kind, registry] of Object.entries(manifest.suites)) {
    if (new Set(registry).size !== registry.length) throw new Error(`${kind} suite IDs must be unique`)
    for (const entry of manifest.packages) {
      for (const suite of entry[`${kind}_suites`]) {
        if (!registry.includes(suite)) throw new Error(`unknown ${kind} suite: ${suite}`)
      }
    }
    const declared = sorted(manifest.packages.flatMap((entry) => entry[`${kind}_suites`]))
    if (JSON.stringify([...registry].sort()) !== JSON.stringify(declared)) {
      throw new Error(`${kind} suite registry must exactly match package declarations`)
    }
  }
  const pathSuiteRoots = manifest.path_suites.map((entry) => normalizePath(entry.root))
  if (new Set(pathSuiteRoots).size !== pathSuiteRoots.length) {
    throw new Error("path suite roots must be unique")
  }
  for (const entry of manifest.path_suites) {
    for (const suite of entry.integration_suites) {
      if (!manifest.suites.integration.includes(suite)) {
        throw new Error(`unknown path integration suite: ${suite}`)
      }
    }
  }

  for (const entry of manifest.packages) {
    const workspacePackage = packageManifest(entry, root)
    if (workspacePackage.name !== entry.name) {
      throw new Error(`package manifest mismatch for ${entry.root}`)
    }
    if (entry.codecov_target && !manifest.codecov_targets[entry.codecov_target]) {
      throw new Error(`unknown Codecov target: ${entry.codecov_target}`)
    }
    for (const script of entry.unit_root ? ["test"] : []) {
      if (!workspacePackage.scripts?.[script]) {
        throw new Error(`${entry.name} declares ${script} scope without a package script`)
      }
    }
  }

  const specs = options.specs || discoverE2eSpecs(resolve(root, manifest.ui.root))
  for (const contractSpecs of Object.values(manifest.ui.contracts)) {
    for (const spec of contractSpecs) {
      if (!specs.includes(spec)) throw new Error(`unknown UI spec: ${spec}`)
    }
  }
  validateCodecovTargets(manifest, root)
  sorted(manifest.integrity_paths)
  workspaceGraph(manifest, root)
  return manifest
}

function findPackage(path, manifest) {
  return [...manifest.packages]
    .sort((left, right) => right.root.length - left.root.length)
    .find((entry) => pathWithin(path, entry.root))
}

function affectedClosure(directNames, manifest) {
  const graph = workspaceGraph(manifest)
  const affected = new Set(directNames)
  const queue = [...directNames]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const dependent of graph.get(current) || []) {
      if (affected.has(dependent)) continue
      affected.add(dependent)
      queue.push(dependent)
    }
  }
  return sorted([...affected])
}

function loadBlogSharedInputs() {
  const sourcePaths = JSON.parse(
    readFileSync(resolve(ROOT, "src/web/blog/shared-build-inputs.json"), "utf8"),
  ).sourcePaths
  return sourcePaths.map((path) => `src/web/${path}`)
}

function isBlogBuildInput(path, sharedInputs) {
  return BLOG_ROOT.test(path) || sharedInputs.some((input) => (
    input.endsWith("/") ? path.startsWith(input) : path === input
  ))
}

function isKnownPath(path, manifest) {
  return isMarkdown(path)
    || GLOBAL_PATHS.has(path)
    || manifest.packages.some((entry) => pathWithin(path, entry.root))
    || manifest.path_suites.some((entry) => pathWithin(path, normalizePath(entry.root)))
    || KNOWN_PREFIXES.some((prefix) => path.startsWith(prefix))
}

function fullReason(paths, { forceFull, fallbackReason }) {
  if (fallbackReason) return "classifier_error"
  if (forceFull) return "forced"
  if (paths.length === 0) return "empty_diff"
  const docsOnly = paths.every(isMarkdown)
  const blogOnly = paths.every(isBlogContent)
  if (!docsOnly && !blogOnly && paths.every((path) => isMarkdown(path) || isBlogContent(path))) {
    return "mixed_content"
  }
  if (paths.some((path) => WORKFLOW.test(path) || GLOBAL_PATHS.has(path) || path.startsWith("scripts/") || (path.startsWith(".github/") && !isMarkdown(path)))) {
    return "policy_change"
  }
  if (paths.some((path) => [".claude/", ".openai/", "docs/"]
    .some((prefix) => path.startsWith(prefix)) && !isMarkdown(path))) return "policy_change"
  return null
}

function emptyJobs() {
  return {
    app_packed_artifact: false,
    auth_build: false,
    blog_build: false,
    e2e: false,
    lighthouse: false,
    merge_reports: false,
    rust: false,
    static_checks: false,
    test_linux: false,
    test_windows: false,
    ui_e2e: false,
  }
}

function packageSets(packages) {
  return {
    static: sorted(packages.filter((entry) => entry.static).map((entry) => entry.name)),
    build: sorted(packages.filter((entry) => entry.build).map((entry) => entry.name)),
    knip: sorted(packages.filter((entry) => entry.knip).map((entry) => entry.name)),
    unit: sorted(packages.map((entry) => entry.unit_root).filter(Boolean)),
    windows: sorted(packages.flatMap((entry) => entry.windows_suites)),
    integration: sorted(packages.flatMap((entry) => entry.integration_suites)),
    linux: sorted(packages.flatMap((entry) => entry.linux_suites)),
  }
}

function coverageSets(packages) {
  return {
    targets: sorted(packages.map((entry) => entry.codecov_target).filter(Boolean)),
    include_roots: sorted(packages.flatMap((entry) => entry.coverage_roots)),
  }
}

function requiredCoverageFiles(changes, coverageRoots) {
  return sorted(changes.flatMap((change) => {
    const status = change.status[0]
    if (!["A", "M", "R", "C"].includes(status)) return []
    return isCoverable(change.path, coverageRoots) ? [change.path] : []
  }))
}

function planClass({ full, docsOnly, blogPathsOnly, authPathsOnly, direct }) {
  if (full) return "full"
  if (docsOnly) return "docs"
  if (blogPathsOnly) return "blog"
  if (authPathsOnly) return "auth"
  if (direct.length === 1 && direct[0] === "@alook/shared") return "shared"
  if (direct.length === 1) return "package"
  return "mixed"
}

export function buildExecutionPlan(inputChanges, options = {}) {
  const manifest = validateScopeManifest(options.manifest || loadScopeManifest())
  const changes = normalizedChanges(inputChanges)
  const paths = sorted(changes.flatMap(changePaths))
  const docsOnly = paths.length > 0 && paths.every(isMarkdown)
  const blogContentOnly = paths.length > 0 && paths.every(isBlogContent)
  const blogPathsOnly = paths.length > 0 && paths.every((path) => BLOG_ROOT.test(path))
  const authPathsOnly = paths.length > 0 && paths.every((path) => AUTH_ROOT.test(path))
  const unknown = paths.some((path) => !isKnownPath(path, manifest))
  const reason = fullReason(paths, options) || (unknown ? "unknown_path" : null)
  const full = reason !== null
  const direct = sorted(paths.map((path) => findPackage(path, manifest)?.name).filter(Boolean))

  let affectedNames
  if (full) affectedNames = sorted(manifest.packages.map((entry) => entry.name))
  else if (docsOnly || blogContentOnly) affectedNames = []
  else affectedNames = affectedClosure(direct, manifest)

  const byName = new Map(manifest.packages.map((entry) => [entry.name, entry]))
  const affectedPackages = affectedNames.map((name) => byName.get(name))
  const suites = packageSets(affectedPackages)
  const coverage = coverageSets(affectedPackages)
  suites.integration = sorted([
    ...suites.integration,
    ...manifest.path_suites
      .filter((entry) => paths.some((path) => pathWithin(path, normalizePath(entry.root))))
      .flatMap((entry) => entry.integration_suites),
  ])
  if (full) {
    suites.unit = sorted([...suites.unit, "scripts/ci"])
    coverage.include_roots = sorted([...coverage.include_roots, "scripts/ci/**/*.mjs"])
  }
  const jobs = emptyJobs()
  const sharedInputs = loadBlogSharedInputs()
  let uiSpecs = []

  if (full) {
    uiSpecs = [manifest.ui.all]
  } else if (blogContentOnly || blogPathsOnly) {
    uiSpecs = [...manifest.ui.contracts.blog]
    suites.integration = blogPathsOnly && !blogContentOnly ? [] : suites.integration
  } else if (authPathsOnly) {
    suites.integration = []
  } else if (affectedPackages.some((entry) => entry.ui)) {
    uiSpecs = [manifest.ui.all]
  }

  if (blogPathsOnly && !blogContentOnly) {
    suites.integration = []
    suites.windows = []
    suites.linux = []
  }

  const authBuild = full || paths.some((path) => AUTH_ROOT.test(path))
  const blogBuild = full || paths.some((path) => isBlogBuildInput(path, sharedInputs))
  const directWebRuntime = paths.some((path) => (
    pathWithin(path, "src/web") && !BLOG_ROOT.test(path) && !AUTH_ROOT.test(path)
  ))
  const lighthouse = full || (blogPathsOnly && !blogContentOnly) || directWebRuntime
  const rust = full || affectedPackages.some((entry) => entry.rust)
  const directPackages = direct.map((name) => byName.get(name))
  const appArtifact = full || (!blogPathsOnly && !authPathsOnly && [...affectedPackages, ...directPackages]
    .some((entry) => entry.app_artifact))
  const requiredChangedFiles = requiredCoverageFiles(changes, coverage.include_roots)

  jobs.auth_build = authBuild
  jobs.blog_build = blogBuild
  jobs.static_checks = suites.static.length > 0
  jobs.test_linux = suites.unit.length > 0 || suites.linux.length > 0
  jobs.test_windows = suites.windows.length > 0
  jobs.app_packed_artifact = appArtifact
  jobs.e2e = suites.integration.length > 0
  jobs.rust = rust
  jobs.lighthouse = lighthouse
  jobs.ui_e2e = uiSpecs.length > 0
  jobs.merge_reports = jobs.ui_e2e

  const basePlan = {
    schema_version: manifest.schema_version,
    policy_version: manifest.policy_version,
    base_sha: options.baseSha || "",
    head_sha: options.headSha || "",
    diagnostic_only: options.diagnosticOnly === true,
    changes,
    paths,
    change_class: planClass({ full, docsOnly, blogPathsOnly, authPathsOnly, direct }),
    full,
    full_reason: reason,
    docs_only: docsOnly && !full,
    auth_only: authPathsOnly && !full,
    blog_only: blogContentOnly && !full,
    workflow_changed: paths.some((path) => WORKFLOW.test(path)),
    packages: {
      direct,
      affected: affectedNames,
    },
    suites,
    ui: { specs: sorted(uiSpecs) },
    coverage: {
      ...coverage,
      required_changed_files: requiredChangedFiles,
    },
    jobs,
  }
  return { ...basePlan, plan_hash: hashPlan(basePlan) }
}

export function classifyPaths(inputPaths, options = {}) {
  return buildExecutionPlan(
    inputPaths.map((path) => ({ status: "M", path })),
    options,
  )
}

export function validateExecutionPlan(plan, options = {}) {
  const manifest = validateScopeManifest(options.manifest || loadScopeManifest())
  if (plan.schema_version !== manifest.schema_version || plan.policy_version !== manifest.policy_version) {
    throw new Error("execution plan schema/policy version mismatch")
  }
  if (hashPlan(plan) !== plan.plan_hash) throw new Error("execution plan hash mismatch")

  const packageNames = new Set(manifest.packages.map((entry) => entry.name))
  for (const name of [...plan.packages.direct, ...plan.packages.affected, ...plan.suites.static, ...plan.suites.build, ...plan.suites.knip]) {
    if (!packageNames.has(name)) throw new Error(`unknown execution-plan package: ${name}`)
  }
  for (const suite of plan.suites.windows) {
    if (!manifest.suites.windows.includes(suite)) throw new Error(`unknown execution-plan windows suite: ${suite}`)
  }
  for (const suite of plan.suites.integration) {
    if (!manifest.suites.integration.includes(suite)) throw new Error(`unknown execution-plan integration suite: ${suite}`)
  }
  for (const suite of plan.suites.linux) {
    if (!manifest.suites.linux.includes(suite)) throw new Error(`unknown execution-plan linux suite: ${suite}`)
  }
  const inventory = discoverE2eSpecs(resolve(ROOT, manifest.ui.root))
  for (const spec of plan.ui.specs) {
    if (spec !== manifest.ui.all && !inventory.includes(spec)) throw new Error(`unknown execution-plan UI spec: ${spec}`)
  }
  return plan
}

export function projectPlan(plan) {
  validateExecutionPlan(plan)
  const uiSpecs = plan.ui.specs.includes("all") ? discoverE2eSpecs() : plan.ui.specs
  const e2eMatrix = uiSpecs.length > 0 ? createE2eMatrix(uiSpecs) : { include: [] }
  return {
    execution_plan: stablePlanJson(plan),
    plan_hash: plan.plan_hash,
    plan_schema_version: String(plan.schema_version),
    full: String(plan.full),
    base_sha: plan.base_sha,
    head_sha: plan.head_sha,
    auth_only: String(plan.auth_only),
    blog_only: String(plan.blog_only),
    run_auth_build: String(plan.jobs.auth_build),
    run_blog_build: String(plan.jobs.blog_build),
    run_code_checks: String(plan.jobs.static_checks || plan.jobs.test_linux),
    run_static_checks: String(plan.jobs.static_checks),
    run_linux: String(plan.jobs.test_linux),
    run_windows: String(plan.jobs.test_windows),
    run_e2e: String(plan.jobs.e2e),
    run_ui_e2e: String(plan.jobs.ui_e2e),
    run_rust: String(plan.jobs.rust),
    run_lighthouse: String(plan.jobs.lighthouse),
    run_knip: String(plan.suites.knip.length > 0),
    run_app_packed_artifact: String(plan.jobs.app_packed_artifact),
    static_packages: JSON.stringify(plan.suites.static),
    build_packages: JSON.stringify(plan.suites.build),
    knip_packages: JSON.stringify(plan.suites.knip),
    unit_test_roots: JSON.stringify(plan.suites.unit),
    windows_suites: JSON.stringify(plan.suites.windows),
    integration_suites: JSON.stringify(plan.suites.integration),
    linux_suites: JSON.stringify(plan.suites.linux),
    coverage_targets: JSON.stringify(plan.coverage.targets),
    coverage_include_roots: JSON.stringify(plan.coverage.include_roots),
    coverage_required_changed_files: JSON.stringify(plan.coverage.required_changed_files),
    ui_specs: JSON.stringify(plan.ui.specs),
    e2e_matrix: JSON.stringify(e2eMatrix),
  }
}

export function parseNameStatus(buffer) {
  const fields = buffer.toString("utf8").split("\0")
  const changes = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    if (!status) continue
    const firstPath = fields[index++]
    if (!firstPath) throw new Error(`missing path for git status ${status}`)
    if (status.startsWith("R") || status.startsWith("C")) {
      const secondPath = fields[index++]
      if (!secondPath) throw new Error(`missing destination for git status ${status}`)
      changes.push({ status, old_path: firstPath, path: secondPath })
    } else {
      changes.push({ status, path: firstPath })
    }
  }
  return normalizedChanges(changes)
}

function readChangedFiles(args) {
  if (args.forceFull) return []
  if (!args.base || !args.head) throw new Error("Both --base and --head are required")
  const diff = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", "--find-copies", `${args.base}...${args.head}`],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  )
  return parseNameStatus(diff)
}

function parseArgs(argv) {
  const args = { forceFull: false, diagnosticOnly: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--force-full") {
      args.forceFull = true
      continue
    }
    if (arg === "--diagnostic-only") {
      args.diagnosticOnly = true
      continue
    }
    const key = arg.replace(/^--/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    args[key] = argv[++index]
  }
  return args
}

function writeOutputs(path, projection) {
  appendFileSync(path, `${Object.entries(projection).map(([key, value]) => `${key}=${value}`).join("\n")}\n`)
}

function writeSummary(path, plan, fallbackReason) {
  const projection = projectPlan(plan)
  const flags = Object.entries(projection)
    .filter(([key]) => key.startsWith("run_") || key === "full" || key === "plan_hash")
    .map(([key, value]) => `| \`${key}\` | \`${value}\` |`)
    .join("\n")
  const changed = plan.changes.map((change) => (
    `- \`${change.status}\` ${change.old_path ? `\`${change.old_path}\` → ` : ""}\`${change.path}\``
  )).join("\n") || "- none"
  const fallback = fallbackReason ? `\nFail-closed reason: ${fallbackReason}\n` : ""
  appendFileSync(
    path,
    `## CI execution plan\n${fallback}\nSchema/policy: \`${plan.schema_version}/${plan.policy_version}\`  \nPlan hash: \`${plan.plan_hash}\`  \nClass: \`${plan.change_class}\`  \nDiagnostic only: \`${plan.diagnostic_only}\`\n\n| Projection | Value |\n| --- | --- |\n${flags}\n\n<details><summary>Changed paths</summary>\n\n${changed}\n\n</details>\n`,
  )
}

export function runCli(argv) {
  const args = parseArgs(argv)
  let plan
  let fallbackReason = ""
  try {
    plan = buildExecutionPlan(readChangedFiles(args), {
      baseSha: args.base || "",
      headSha: args.head || "",
      forceFull: args.forceFull,
      diagnosticOnly: args.diagnosticOnly,
    })
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : String(error)
    plan = buildExecutionPlan([], {
      baseSha: args.base || "",
      headSha: args.head || "",
      forceFull: true,
      fallbackReason,
      diagnosticOnly: args.diagnosticOnly,
    })
  }
  validateExecutionPlan(plan)
  const projection = projectPlan(plan)
  if (args.output) writeOutputs(args.output, projection)
  if (args.planFile) writeFileSync(resolve(args.planFile), `${stablePlanJson(plan)}\n`)
  if (args.summary) writeSummary(args.summary, plan, fallbackReason)
  if (!args.output) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2))
}
