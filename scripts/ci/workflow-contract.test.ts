import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const workflowRoot = resolve(import.meta.dirname, "../../.github/workflows")
const repositoryRoot = resolve(import.meta.dirname, "../..")
function normalizeWorkflow(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

const ciWorkflow = normalizeWorkflow(readFileSync(resolve(workflowRoot, "ci.yml"), "utf8"))
const workflow = ciWorkflow
const legacyUiWorkflowPath = resolve(workflowRoot, "e2e-ui.yml")
const playwrightConfig = readFileSync(
  resolve(import.meta.dirname, "../../src/web/playwright.config.ts"),
  "utf8",
)
type WorkerModuleContract = {
  name: string
  packageJson: {
    scripts: Record<string, string>
    devDependencies: Record<string, string>
  }
  nodeConfig: string
  runtimeConfig: string
  workspaceConfig: string
  wranglerConfig: string
}

const directWorkerModules = ["ws-do", "email-worker", "wake-worker", "web"].map((name): WorkerModuleContract => {
  const moduleRoot = resolve(import.meta.dirname, `../../src/${name}`)
  return {
    name,
    packageJson: JSON.parse(readFileSync(resolve(moduleRoot, "package.json"), "utf8")),
    nodeConfig: readFileSync(resolve(moduleRoot, "vitest.config.ts"), "utf8"),
    runtimeConfig: readFileSync(resolve(moduleRoot, "vitest.runtime.config.mts"), "utf8"),
    workspaceConfig: readFileSync(resolve(moduleRoot, "vitest.workspace.config.ts"), "utf8"),
    wranglerConfig: readFileSync(resolve(moduleRoot, "wrangler.toml"), "utf8"),
  }
})
const rootVitestConfig = readFileSync(
  resolve(import.meta.dirname, "../../vitest.config.ts"),
  "utf8",
)
const daemonVitestConfig = readFileSync(
  resolve(import.meta.dirname, "../../src/daemon/vitest.config.ts"),
  "utf8",
)
const rootPackageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
) as {
  scripts: Record<string, string>
  devDependencies: Record<string, string>
}
const autoTagReleaseWorkflow = normalizeWorkflow(
  readFileSync(resolve(workflowRoot, "auto-tag-release.yml"), "utf8"),
)
const desktopReleaseWorkflow = normalizeWorkflow(readFileSync(resolve(workflowRoot, "desktop-release.yml"), "utf8"))
const mobileReleaseWorkflowPath = resolve(workflowRoot, "mobile-release.yml")
const mobileReleaseWorkflow = normalizeWorkflow(readFileSync(mobileReleaseWorkflowPath, "utf8"))
const desktopConfig = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../src/desktop/src-tauri/tauri.conf.json"), "utf8"),
) as {
  build?: { devUrl?: string; frontendDist?: string }
  app?: {
    windows?: Array<{ label?: string; dragDropEnabled?: boolean }>
    security?: { capabilities?: Array<string | Record<string, unknown>> }
  }
  bundle?: { createUpdaterArtifacts?: boolean | string }
  plugins?: { updater?: { endpoints?: string[] } }
}
type ExternalLinksCapability = {
  identifier: string
  windows: string[]
  platforms: string[]
  local: boolean
  remote: { urls: string[] }
  permissions: Array<{
    identifier: string
    allow?: Array<{ url: string }>
  }>
}
const externalLinksCapability = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../src/desktop/src-tauri/capabilities/external-links.json"),
    "utf8",
  ),
) as ExternalLinksCapability
const desktopMacConfig = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../src/desktop/src-tauri/tauri.macos.conf.json"), "utf8"),
) as { bundle?: { macOS?: { entitlements?: string; hardenedRuntime?: boolean; signingIdentity?: string } } }
const desktopIosConfig = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../src/desktop/src-tauri/tauri.ios.conf.json"), "utf8"),
) as { identifier?: string }
const desktopAndroidConfig = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../src/desktop/src-tauri/tauri.android.conf.json"), "utf8"),
) as { identifier?: string }
const androidGradle = readFileSync(
  resolve(import.meta.dirname, "../../src/desktop/src-tauri/gen/android/app/build.gradle.kts"),
  "utf8",
)
const androidMainActivity = readFileSync(
  resolve(
    import.meta.dirname,
    "../../src/desktop/src-tauri/gen/android/app/src/main/java/ai/alook/android/MainActivity.kt",
  ),
  "utf8",
)
const iosExportOptions = readFileSync(
  resolve(import.meta.dirname, "../../src/desktop/src-tauri/gen/apple/ExportOptions.plist"),
  "utf8",
)
const iosProject = readFileSync(
  resolve(import.meta.dirname, "../../src/desktop/src-tauri/gen/apple/project.yml"),
  "utf8",
)
const nativeOauthAasaRoute = readFileSync(
  resolve(import.meta.dirname, "../../src/web/src/app/.well-known/apple-app-site-association/route.ts"),
  "utf8",
)
const nativeOauthAssetLinksRoute = readFileSync(
  resolve(import.meta.dirname, "../../src/web/src/app/.well-known/assetlinks.json/route.ts"),
  "utf8",
)
const nativeOauthWebConfig = readFileSync(
  resolve(import.meta.dirname, "../../src/web/wrangler.toml"),
  "utf8",
)
const nativeOauthContract = readFileSync(
  resolve(import.meta.dirname, "../../src/web/src/lib/native-oauth-host.ts"),
  "utf8",
)
const desktopEntitlementsPath = resolve(
  import.meta.dirname,
  "../../src/desktop/src-tauri/entitlements.plist",
)
const desktopBuildScript = readFileSync(
  resolve(import.meta.dirname, "../../src/desktop/scripts/build.sh"),
  "utf8",
)
const desktopCargoManifest = readFileSync(
  resolve(import.meta.dirname, "../../src/desktop/src-tauri/Cargo.toml"),
  "utf8",
)
const desktopRustEntry = readFileSync(
  resolve(import.meta.dirname, "../../src/desktop/src-tauri/src/lib.rs"),
  "utf8",
)
type DesktopCapability = {
  identifier: string
  windows?: string[]
  platforms?: string[]
  local?: boolean
  remote?: { urls?: string[] }
  permissions: string[]
}
const desktopCapability = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../src/desktop/src-tauri/capabilities/desktop.json"),
  "utf8",
)) as DesktopCapability
const desktopDevConfig = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../src/desktop/src-tauri/tauri.dev.conf.json"),
  "utf8",
)) as {
  app: { security: { capabilities: Array<string | DesktopCapability | ExternalLinksCapability> } }
}
const bumpScript = readFileSync(resolve(import.meta.dirname, "../bump-version.mjs"), "utf8")
const desktopUpdateRoute = readFileSync(
  resolve(import.meta.dirname, "../../src/web/src/app/api/desktop/update/[target]/[arch]/[current_version]/route.ts"),
  "utf8",
)
const publishWorkflows = ["publish-app.yml", "publish-cli.yml", "publish-daemon.yml"]
  .map((name) => normalizeWorkflow(readFileSync(resolve(workflowRoot, name), "utf8")))
const publishDaemonWorkflow = normalizeWorkflow(
  readFileSync(resolve(workflowRoot, "publish-daemon.yml"), "utf8"),
)
const agentDriverPackage = JSON.parse(
  readFileSync(resolve(repositoryRoot, "src/daemon/agent-driver/package.json"), "utf8"),
) as {
  private?: boolean
  publishConfig?: unknown
  scripts: Record<string, string>
  devDependencies: Record<string, string>
}
const daemonPackage = JSON.parse(
  readFileSync(resolve(repositoryRoot, "src/daemon/package.json"), "utf8"),
) as {
  scripts: Record<string, string>
  devDependencies?: Record<string, string>
}
const workspaceManifest = readFileSync(resolve(repositoryRoot, "pnpm-workspace.yaml"), "utf8")
const appPackedArtifactScript = readFileSync(
  resolve(repositoryRoot, "src/app/scripts/app-packed-artifact.mjs"),
  "utf8",
)
const packedArtifactVerifier = readFileSync(
  resolve(repositoryRoot, "src/app/scripts/verify-packed-artifact.mjs"),
  "utf8",
)

function ciJob(name: string): string {
  const start = ciWorkflow.indexOf(`\n  ${name}:\n`)
  if (start < 0) throw new Error(`missing CI job: ${name}`)
  const next = ciWorkflow.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/)
  return next < 0 ? ciWorkflow.slice(start) : ciWorkflow.slice(start, start + 1 + next)
}

describe("E2E UI workflow", () => {
  it("uses the canonical CI scope before merge and removes the second classifier", () => {
    expect(workflow).toMatch(/^  pull_request:/m)
    expect(workflow).toMatch(/^  merge_group:/m)
    expect(workflow).toMatch(/^  workflow_dispatch:/m)
    expect(workflow).toMatch(/^  push:/m)
    expect(workflow).not.toMatch(/^  schedule:/m)
    expect(existsSync(legacyUiWorkflowPath)).toBe(false)
    expect(workflow.match(/^  scope:$/gm)).toHaveLength(1)
    expect(ciJob("e2e-ui")).toContain("needs.scope.outputs.e2e_matrix")
  })

  it("keeps failure diagnostics best-effort and merge inputs strict", () => {
    expect(workflow).toContain("src/web/e2e-service-logs/")
    expect(workflow).toContain("continue-on-error: true")
    expect(workflow).toContain("if-no-files-found: ignore")
    expect(workflow).toContain("retention-days: 7")
    expect(workflow).toContain(
      "name: blob-report-${{ github.run_id }}-${{ matrix.shard }}",
    )
    expect(workflow).toContain(
      "pattern: blob-report-${{ github.run_id }}-*",
    )
    expect(workflow).toContain("overwrite: true")
    expect(workflow).toContain("merge-multiple: false")
    expect(workflow).toContain("actions: read")
    expect(workflow).toContain("verify-artifacts")
    expect(workflow).toContain("verify-merged")
    expect(workflow).toContain("--reporter html,json")
    expect(workflow).not.toContain("playwright-merge-runtime")
    expect(ciJob("e2e-ui").match(/pnpm install --frozen-lockfile/g)).toHaveLength(1)
    expect(ciJob("merge-reports").match(/pnpm install --frozen-lockfile/g)).toHaveLength(1)
    expect(ciJob("e2e-ui").match(/continue-on-error: true/g)).toHaveLength(1)
  })

  it("reports shard failures directly to GitHub Checks", () => {
    expect(playwrightConfig).toContain('[["blob"], ["github"], ["list"]]')
  })

  it("does not install Bun for Node-only browser tests", () => {
    expect(ciJob("e2e-ui")).not.toContain("oven-sh/setup-bun")
    expect(ciJob("merge-reports")).not.toContain("oven-sh/setup-bun")
  })

  it("runs shards in the lockfile-selected Playwright image without host installs", () => {
    expect(workflow).toContain("image: ${{ matrix.image }}")
    expect(workflow).toContain("options: --init --ipc=host --user 1001")
    expect(workflow).toMatch(/defaults:\n      run:\n        shell: bash/)
    expect(ciJob("e2e-ui")).not.toContain("playwright-browser-cache")
    expect(ciJob("e2e-ui")).not.toContain("~/.cache/ms-playwright")
    expect(ciJob("e2e-ui")).not.toContain("playwright install-deps")
    expect(ciJob("e2e-ui")).not.toContain("playwright install chromium")
  })
})

describe("Bun workflow setup", () => {
  it("normalizes Windows checkout line endings before locating jobs", () => {
    expect(normalizeWorkflow("jobs:\r\n  test-linux:\r\n")).toBe("jobs:\n  test-linux:\n")
  })

  it("installs pinned Bun in every CI job that builds a daemon package fixture", () => {
    const bunJobs = ["static-checks", "test-linux", "test-windows", "app-packed-artifact"]
    expect(ciWorkflow.match(/oven-sh\/setup-bun/g)).toHaveLength(bunJobs.length)
    for (const job of bunJobs) {
      expect(ciJob(job)).toContain("oven-sh/setup-bun")
      expect(ciJob(job)).toContain("bun-version: 1.3.11")
    }
    for (const publishWorkflow of publishWorkflows) {
      expect(publishWorkflow).toContain("oven-sh/setup-bun")
      expect(publishWorkflow).toContain("bun-version: 1.3.11")
    }
  })
})

describe("Local package test isolation", () => {
  it("keeps daemon artifact writers serial without flattening ordinary tests", () => {
    const artifactTests = [
      "src/version.packed.test.ts",
      "src/agent-driver-bundle.packed.test.ts",
      "src/cli/daemonSelfUpdate.real.test.ts",
    ]
    expect(daemonPackage.scripts.test).toBe("pnpm test:unit && pnpm test:packed")
    expect(daemonPackage.scripts["test:unit"]).not.toContain("--no-file-parallelism")
    expect(daemonPackage.scripts["test:packed"]).toContain("--no-file-parallelism")
    for (const testPath of artifactTests) {
      expect(daemonPackage.scripts["test:unit"]).toContain(`--exclude ${testPath}`)
      expect(daemonPackage.scripts["test:packed"]).toContain(testPath)
    }

    const rootTest = rootPackageJson.scripts.test
    const driverBuild = rootTest.indexOf("pnpm --filter @alook/agent-driver build")
    const workspaceTests = rootTest.indexOf("turbo run test --filter=!@alook/agent-driver")
    const driverTests = rootTest.indexOf("pnpm --filter @alook/agent-driver test")
    const scriptTests = rootTest.indexOf("vitest run --project ci-scripts")
    expect(driverBuild).toBeGreaterThanOrEqual(0)
    expect(workspaceTests).toBeGreaterThan(driverBuild)
    expect(driverTests).toBeGreaterThan(workspaceTests)
    expect(scriptTests).toBeGreaterThan(driverTests)
  })
})

describe("CI workflow graph", () => {
  it("keeps approved triggers without a daily schedule", () => {
    expect(ciWorkflow).toMatch(/^  push:/m)
    expect(ciWorkflow).toMatch(/^  pull_request:/m)
    expect(ciWorkflow).toMatch(/^  merge_group:/m)
    expect(ciWorkflow).toMatch(/^  workflow_dispatch:/m)
    expect(ciWorkflow).not.toMatch(/^  schedule:/m)
  })

  it("keeps manual dispatch full by default and guards diagnostic fixtures before scoping", () => {
    const scope = ciJob("scope")
    expect(ciWorkflow).toContain("options: [full, characterization]")
    expect(ciWorkflow).toContain("default: full")
    expect(ciWorkflow).toContain("pull-requests: read")
    expect(scope).toContain('gh api "repos/$GITHUB_REPOSITORY/pulls/$CANDIDATE_PR"')
    expect(scope).toContain("node scripts/ci/characterization-guard.mjs")
    expect(scope).toContain('--ref-name "$GITHUB_REF_NAME"')
    expect(scope).toContain('--candidate-sha "$CANDIDATE_SHA"')
    expect(scope).toContain('--fixture-sha "$FIXTURE_SHA"')
    expect(scope).toContain('--expected-class "$EXPECTED_CLASS"')
    expect(scope).toContain('--diagnostic-only')
    expect(scope).toContain('args+=(--base "$EVENT_SHA" --head "$EVENT_SHA" --force-full)')
    expect(scope).not.toContain("ref: ${{ inputs.fixture_sha }}")
  })

  it("publishes one auditable plan and validates its envelope in every consumer", () => {
    const scope = ciJob("scope")
    expect(scope).toContain("--plan-file .ci/execution-plan.json")
    expect(scope).toContain("name: execution-plan-${{ github.run_id }}-${{ github.run_attempt }}")
    for (const job of [
      "blog-build", "static-checks", "test-linux", "test-windows", "app-packed-artifact",
      "e2e", "desktop-rust", "lighthouse", "e2e-ui", "merge-reports", "ci-gate", "ui-e2e-gate",
    ]) {
      const definition = ciJob(job)
      expect(definition, job).toContain("CI_EXECUTION_PLAN: ${{ needs.scope.outputs.execution_plan }}")
      expect(definition, job).toContain("CI_PLAN_HASH: ${{ needs.scope.outputs.plan_hash }}")
      expect(definition, job).toContain("node scripts/ci/validate-execution-plan.mjs")
    }
  })

  it("keeps named Codecov targets, patch enforcement, and changed-file proof auditable", () => {
    const linux = ciJob("test-linux")
    expect(linux).toContain("coverage_include_roots")
    expect(linux).toContain("verify-coverage-plan.mjs")
    expect(linux).toContain("coverage-target-manifest.json")
    expect(linux).toContain("coverage/coverage-final.json")
    expect(readFileSync(resolve(repositoryRoot, "codecov.yml"), "utf8")).toContain("target: 100%")
  })

  it("prepares shared services for every selected integration suite", () => {
    const e2e = ciJob("e2e")
    const webCondition = "if: contains(fromJSON(needs.scope.outputs.integration_suites), 'web')"
    const cliCondition = "if: contains(fromJSON(needs.scope.outputs.integration_suites), 'cli')"
    const daemonCondition = "if: contains(fromJSON(needs.scope.outputs.integration_suites), 'daemon')"

    expect(e2e).toContain("if: needs.scope.outputs.run_e2e == 'true'")
    expect(e2e).toContain("- name: Create local bindings\n        run:")
    expect(e2e).toContain("- run: pnpm run db:migrate")
    expect(e2e).toContain("- name: Start dev servers\n        run: |")
    expect(e2e).toContain("- name: Wait for services\n        run: |")
    expect(e2e.match(new RegExp(webCondition.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")))
      .toHaveLength(1)
    expect(e2e.match(new RegExp(cliCondition.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")))
      .toHaveLength(1)
    expect(e2e.match(new RegExp(daemonCondition.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")))
      .toHaveLength(1)
    expect(e2e).toContain(`${webCondition}\n        run: pnpm test:e2e`)
    expect(e2e).toContain(`${cliCondition}\n        run: pnpm --filter @alook/cli run test:integration`)
    expect(e2e).toContain(`${daemonCondition}\n        run: pnpm --filter @alook/daemon run test:integration`)
  })

  it("consolidates static work and preserves non-blocking Knip steps", () => {
    const staticChecks = ciJob("static-checks")
    expect(ciWorkflow).not.toMatch(/^  quality:/m)
    expect(ciWorkflow).not.toMatch(/^  knip:/m)
    expect(ciWorkflow).not.toMatch(/^  build:/m)
    expect(staticChecks.match(/pnpm install --frozen-lockfile/g)).toHaveLength(1)
    expect(staticChecks.match(/continue-on-error: true/g)).toHaveLength(1)
    expect(staticChecks).toContain("pnpm turbo run typecheck")
    expect(staticChecks).toContain("pnpm turbo run lint")
    expect(staticChecks).toContain("pnpm turbo run build")
    expect(staticChecks).toContain("pnpm turbo run knip")
  })

  it("gates the consolidated jobs under the stable CI Gate", () => {
    const gate = ciJob("ci-gate")
    for (const job of ["static-checks", "test-linux", "test-windows", "app-packed-artifact"]) {
      expect(gate).toContain(`- ${job}`)
      expect(gate).toContain(`"name":"${job}"`)
    }
    for (const removed of ["quality", "knip", "build", "coverage"]) {
      expect(gate).not.toContain(`- ${removed}`)
      expect(gate).not.toContain(`"name":"${removed}"`)
    }
  })

  it("gates the fail-closed exact-tarball app artifact check", () => {
    const scope = ciJob("scope")
    const artifact = ciJob("app-packed-artifact")
    const gate = ciJob("ci-gate")
    expect(scope).toContain(
      "run_app_packed_artifact: ${{ steps.scope.outputs.run_app_packed_artifact }}",
    )
    expect(artifact).toContain("if: needs.scope.outputs.run_app_packed_artifact == 'true'")
    expect(artifact).toContain("timeout-minutes: 15")
    expect(artifact).toContain("node src/app/scripts/app-packed-artifact.mjs --output-dir")
    expect(artifact).toContain("if: always()")
    expect(artifact).toContain("if-no-files-found: error")
    expect(artifact).toContain('tarballs=("$RUNNER_TEMP"/alook-app-packed-artifact/*.tgz)')
    expect(artifact).toContain("[[ ${#tarballs[@]} -eq 1 ]]")
    for (const evidence of [
      "*.tgz",
      "manifest.json",
      "artifact-verification/positive-wrangler.log",
      "artifact-verification/negative-wrangler.log",
    ]) {
      expect(artifact).toContain(evidence)
    }
    for (const excluded of [
      "artifact-verification/extracted",
      "artifact-verification/negative/package",
      "artifact-verification/positive-wrangler/**",
      "artifact-verification/negative-wrangler/**",
    ]) {
      expect(artifact).not.toContain(excluded)
    }
    expect(gate).toContain("- app-packed-artifact")
    expect(gate).toContain('"name":"app-packed-artifact"')
  })
})

describe("App packed artifact CI contract", () => {
  it("packs once and verifies those exact bytes without lifecycle or publishing", () => {
    expect(appPackedArtifactScript.match(/execFileSync\("npm", \[\s*"pack"/g)).toHaveLength(1)
    expect(appPackedArtifactScript).toContain("verifyPackedArtifact(tarball")
    expect(appPackedArtifactScript).not.toContain("self-hosted")
    expect(appPackedArtifactScript).not.toContain("onboard")
    expect(appPackedArtifactScript).not.toContain("npm publish")
  })

  it("derives the negative from the extracted candidate and requires the missing runtime", () => {
    expect(packedArtifactVerifier).toContain("cpSync(packageRoot, negativePackageRoot")
    expect(packedArtifactVerifier).toContain("rmSync(negativeRuntime)")
    expect(packedArtifactVerifier).toContain('negativeOutput.includes("worker-runtime")')
    expect(packedArtifactVerifier).toContain("Packed artifact Wrangler dry-run produced no output")
  })
})

describe("Private agent driver package", () => {
  it("remains an independent private workspace dependency of the daemon", () => {
    expect(agentDriverPackage.private).toBe(true)
    expect(agentDriverPackage).not.toHaveProperty("publishConfig")
    expect(workspaceManifest).toContain('"src/daemon/agent-driver"')
    expect(daemonPackage.devDependencies?.["@alook/agent-driver"]).toBe("workspace:*")
  })

  it("cannot be published by a repository workflow", () => {
    expect(existsSync(resolve(workflowRoot, "publish-agent-driver.yml"))).toBe(false)
  })

  it("builds the workspace driver before a clean daemon publish build", () => {
    const driverBuild = publishDaemonWorkflow.indexOf("pnpm -C src/daemon/agent-driver run build")
    const daemonBuild = publishDaemonWorkflow.indexOf("pnpm -C src/daemon run build")
    expect(driverBuild).toBeGreaterThan(0)
    expect(daemonBuild).toBeGreaterThan(driverBuild)
  })

  it("keeps runtime and artifact contracts without the removed API report mechanism", () => {
    expect(agentDriverPackage.scripts).not.toHaveProperty("api:check")
    expect(agentDriverPackage.scripts).not.toHaveProperty("api:update")
    expect(agentDriverPackage.devDependencies).not.toHaveProperty("@microsoft/api-extractor")
    expect(rootPackageJson.scripts).not.toHaveProperty("api:check")
    expect(rootPackageJson.scripts).not.toHaveProperty("api:update")
    for (const path of [
      ".github/api-surface-owners.json",
      ".github/workflows/api-surface-check.yml",
      ".github/workflows/api-surface-guard.yml",
      "scripts/ci/api-report-contract.test.ts",
      "scripts/ci/api-surface-guard.mjs",
      "scripts/ci/api-surface-guard.test.ts",
      "src/daemon/agent-driver/scripts/api-reports.mjs",
      "src/daemon/agent-driver/etc/api/root.api.md",
      "src/daemon/agent-driver/api-extractor.root.json",
    ]) {
      expect(existsSync(resolve(repositoryRoot, path))).toBe(false)
    }
  })
})

describe("CI test budgets", () => {
  it("gives the slower Windows workspace suite enough job time", () => {
    expect(ciJob("test-windows")).toContain("timeout-minutes: 15")
  })

  it("runs Windows process-authority and full driver fixtures in isolation before the daemon suite", () => {
    const windows = ciJob("test-windows")
    const processAuthority = windows.indexOf(
      "pnpm --filter @alook/agent-driver exec vitest run src/internal/killTree.test.ts",
    )
    const driver = windows.indexOf(
      "pnpm --filter @alook/agent-driver exec vitest run --no-file-parallelism --coverage --coverage.reporter=json --coverage.reporter=text",
    )
    const coverageUpload = windows.indexOf("files: ./src/daemon/agent-driver/coverage/coverage-final.json")
    const focusedAdmission = windows.indexOf(
      "pnpm --filter @alook/daemon exec vitest run src/daemon/createDaemon.test.ts",
    )
    const daemon = windows.indexOf("pnpm --filter @alook/daemon test")
    expect(processAuthority).toBeGreaterThan(0)
    expect(driver).toBeGreaterThan(processAuthority)
    expect(coverageUpload).toBeGreaterThan(driver)
    expect(focusedAdmission).toBeGreaterThan(coverageUpload)
    expect(daemon).toBeGreaterThan(focusedAdmission)
  })

  it("uploads the Windows driver report without accidentally discovering unrelated files", () => {
    const windows = ciJob("test-windows")
    expect(windows).toContain("disable_search: true")
    expect(windows).toContain("name: windows-agent-driver")
    expect(windows).toContain("fail_ci_if_error: true")
  })

  it("runs only Windows-relevant workspace packages after the process-bearing suites", () => {
    const windows = ciJob("test-windows")
    expect(windows).toContain("for suite in app cli shared")
    expect(windows).toContain('filters+=("--filter=@alook/$suite")')
    expect(windows).toContain('pnpm turbo run test "${filters[@]}"')
    expect(windows).not.toContain("--affected")
    for (const packageName of ["web", "email-worker", "ws-do", "wake-worker"]) {
      expect(windows).not.toContain(`--filter=@alook/${packageName}`)
    }
    expect(windows).not.toContain("--project ci-scripts")
  })
})

describe("CI dependency setup", () => {
  it("installs cargo-machete from the pinned release action", () => {
    const desktopRust = ciJob("desktop-rust")
    expect(desktopRust).toContain(
      "taiki-e/install-action@d9585d8b553a3309cc2e7a695952297e311e4c10 # cargo-machete",
    )
    expect(desktopRust).not.toContain("cargo install cargo-machete")
    expect(desktopRust).toContain("run: cargo machete")
  })

  it("caches pnpm and target-specific Rust artifacts for desktop releases", () => {
    const pnpmSetup = desktopReleaseWorkflow.indexOf("pnpm/action-setup@")
    const nodeSetup = desktopReleaseWorkflow.indexOf("actions/setup-node@")
    expect(pnpmSetup).toBeGreaterThan(-1)
    expect(nodeSetup).toBeGreaterThan(pnpmSetup)
    expect(desktopReleaseWorkflow).toContain("cache: pnpm")
    expect(desktopReleaseWorkflow).toContain("cache-dependency-path: pnpm-lock.yaml")
    expect(desktopReleaseWorkflow).toContain(
      "Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2",
    )
    expect(desktopReleaseWorkflow).toContain("key: ${{ matrix.target }}")
  })
})

describe("Native message external-link opener", () => {
  const expectedPlatforms = ["linux", "macOS", "windows", "android", "iOS"]
  const expectedPermission = [{
    identifier: "opener:allow-open-url",
    allow: [{ url: "http://*" }, { url: "https://*" }],
  }]
  const scopedUrlAllowed = (href: string, capability: ExternalLinksCapability) => {
    const patterns = capability.permissions.flatMap((permission) => (
      permission.allow?.map((entry) => entry.url) ?? []
    ))
    return patterns.includes(`${new URL(href).protocol}//*`)
  }

  it("registers the official opener plugin in the common desktop/mobile builder", () => {
    const desktopOnlyDependencies = desktopCargoManifest.indexOf(
      "[target.\"cfg(not(any(target_os = \\\"android\\\", target_os = \\\"ios\\\")))\".dependencies]",
    )
    const dependency = desktopCargoManifest.indexOf('tauri-plugin-opener = "2"')
    const registration = desktopRustEntry.indexOf("plugin(tauri_plugin_opener::init())")
    const desktopOnlyPlugins = desktopRustEntry.indexOf("// Desktop-only plugins")

    expect(dependency).toBeGreaterThan(-1)
    expect(dependency).toBeLessThan(desktopOnlyDependencies)
    expect(registration).toBeGreaterThan(-1)
    expect(registration).toBeLessThan(desktopOnlyPlugins)
  })

  it("grants only scoped HTTP(S) URL opening to the production five-platform app webview", () => {
    expect(externalLinksCapability).toMatchObject({
      identifier: "external-links",
      windows: ["main"],
      platforms: expectedPlatforms,
      local: true,
      remote: { urls: ["https://alook.ai"] },
      permissions: expectedPermission,
    })
    expect(desktopConfig.app?.security?.capabilities).toContain("external-links")
    expect([
      "http://example.com:8080/path/to/story?source=chat#section",
      "https://example.com:9443/a/b?query=yes#fragment",
      "https://alook.ai/c/invite/abcdef?from=dm",
    ].every((href) => scopedUrlAllowed(href, externalLinksCapability))).toBe(true)
    expect([
      "mailto:friend@example.com",
      "tel:+15551234567",
      "file:///tmp/private",
    ].some((href) => scopedUrlAllowed(href, externalLinksCapability))).toBe(false)
  })

  it("reuses the same minimal HTTP(S) scope for the local development app webview", () => {
    const capabilities = desktopDevConfig.app?.security?.capabilities ?? []
    const inlineOpener = capabilities.find((capability): capability is ExternalLinksCapability => (
      typeof capability !== "string"
      && capability.permissions.some((permission) => (
        typeof permission !== "string" && permission.identifier.startsWith("opener:")
      ))
    ))

    expect(capabilities).toContain("external-links")
    expect(capabilities.filter((capability) => capability === "external-links")).toHaveLength(1)
    expect(inlineOpener).toBeUndefined()
  })

  it("does not grant default schemes, paths, reveal, shell, or CSP expansion", () => {
    const capabilityText = JSON.stringify({
      production: externalLinksCapability,
      development: desktopDevConfig.app?.security?.capabilities,
    })
    for (const rejected of [
      "opener:default",
      "opener:allow-default-urls",
      "opener:allow-open-path",
      "opener:allow-reveal-item-in-dir",
      "shell:",
      "mailto:",
      "tel:",
    ]) {
      expect(capabilityText).not.toContain(rejected)
    }
    expect(desktopConfig.app).not.toHaveProperty("security.csp")
  })
})

describe("Turbo CI execution", () => {
  const cachedJobs = ["blog-build", "static-checks", "test-linux", "test-windows"]

  it("persists a task cache isolated by operating system, architecture, and job", () => {
    expect(ciWorkflow.match(/actions\/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9/g))
      .toHaveLength(cachedJobs.length)
    for (const job of cachedJobs) {
      const definition = ciJob(job)
      expect(definition).toContain("path: .turbo/cache")
      expect(definition).toContain(
        "key: turbo-${{ runner.os }}-${{ runner.arch }}-${{ github.job }}-${{ github.sha }}",
      )
      expect(definition).toContain(
        "turbo-${{ runner.os }}-${{ runner.arch }}-${{ github.job }}-",
      )
    }
  })

  it("passes explicit validated manifest selections instead of re-running an affected classifier", () => {
    const scope = ciJob("scope")
    expect(scope).toContain("full: ${{ steps.scope.outputs.full }}")
    expect(scope).toContain("base_sha: ${{ steps.scope.outputs.base_sha }}")
    expect(scope).toContain("head_sha: ${{ steps.scope.outputs.head_sha }}")
    expect(scope).toContain("execution_plan: ${{ steps.scope.outputs.execution_plan }}")
    expect(scope).toContain("plan_hash: ${{ steps.scope.outputs.plan_hash }}")
    expect(ciWorkflow).not.toContain("--affected")
    expect(ciJob("static-checks")).toContain("CI_PROJECTION_NAME: static_packages")
    expect(ciJob("test-windows")).toContain("CI_PROJECTION_NAME: windows_suites")
  })

  it("retains full commands when scope classification fails closed", () => {
    const staticChecks = ciJob("static-checks")
    expect(staticChecks).toContain("pnpm turbo run typecheck")
    expect(staticChecks).toContain("pnpm turbo run lint")
    expect(staticChecks).toContain("pnpm turbo run knip")
    expect(staticChecks).toContain("SELECTED_PACKAGES: ${{ needs.scope.outputs.build_packages }}")
    expect(staticChecks.match(/pnpm install --frozen-lockfile/g)).toHaveLength(1)
    const linux = ciJob("test-linux")
    expect(linux).toContain("--project=daemon-node src/daemon")
    const windows = ciJob("test-windows")
    expect(windows).toContain("run: pnpm --filter @alook/daemon test")
    expect(linux).toContain('vitest_args=("${project_args[@]}")')
    expect(linux).toContain('if (( ${#root_coverage[@]} )); then vitest_args+=("${root_coverage[@]}"); fi')
    expect(linux).toContain('pnpm vitest run "${vitest_args[@]}"')
    expect(windows).toContain("pnpm turbo run test \"${filters[@]}\"")
    expect(linux.match(/VITEST_MAX_WORKERS=1/g)).toHaveLength(1)
    expect(windows.match(/VITEST_MAX_WORKERS: 1/g)).toHaveLength(1)
  })

  it("isolates daemon process-authority tests in root workspace runs", () => {
    expect(daemonVitestConfig).toContain('name: "daemon-node"')
    expect(daemonVitestConfig).toContain("maxWorkers: 1")
    expect(daemonVitestConfig).toContain("sequence: { groupOrder: 2 }")
  })

  it("builds agent-driver before every selected Linux consumer of its dist exports", () => {
    const linux = ciJob("test-linux")
    const buildStart = linux.indexOf("- name: Build selected agent-driver fixture")
    const unitStart = linux.indexOf("- name: Run selected unit tests")
    const realStart = linux.indexOf("- name: Run selected daemon real-process tests")
    const packedStart = linux.indexOf("- name: Run selected package artifact tests")
    const buildStep = linux.slice(buildStart, unitStart)

    expect(buildStart).toBeGreaterThan(-1)
    expect(buildStep).toContain("run: pnpm --filter @alook/agent-driver build")
    for (const selector of [
      "contains(fromJSON(needs.scope.outputs.unit_test_roots), 'src/daemon/agent-driver')",
      "contains(fromJSON(needs.scope.outputs.unit_test_roots), 'src/daemon')",
      "contains(fromJSON(needs.scope.outputs.linux_suites), 'agent-driver-packed')",
      "contains(fromJSON(needs.scope.outputs.linux_suites), 'daemon-packed')",
      "contains(fromJSON(needs.scope.outputs.linux_suites), 'daemon-real')",
    ]) expect(buildStep).toContain(selector)
    expect(buildStep).not.toContain("src/web")
    expect(unitStart).toBeGreaterThan(buildStart)
    expect(realStart).toBeGreaterThan(buildStart)
    expect(packedStart).toBeGreaterThan(buildStart)
  })

  it("runs each direct Worker Node and runtime project once through its standard test task", () => {
    const projectNames: string[] = []
    for (const module of directWorkerModules) {
      expect(module.packageJson.scripts.test).toBe("vitest run --config vitest.workspace.config.ts")
      expect(module.packageJson.scripts).not.toHaveProperty("test:workers")
      expect(module.packageJson.devDependencies["@cloudflare/vitest-plugin"]).toBe("1.0.0")
      expect(module.workspaceConfig.match(/vitest\.config\.ts/g)).toHaveLength(1)
      expect(module.workspaceConfig.match(/vitest\.runtime\.config\.mts/g)).toHaveLength(1)

      const nodeProject = `${module.name}-node`
      const runtimeProject = `${module.name}-runtime`
      expect(module.nodeConfig).toContain(`name: "${nodeProject}"`)
      expect(module.runtimeConfig).toContain(`name: "${runtimeProject}"`)
      expect(module.runtimeConfig).toContain("cloudflareTest({")
      expect(module.runtimeConfig).toContain('wrangler: { configPath: "./wrangler.toml" }')
      expect(module.wranglerConfig).not.toContain("service_binding_extra_handlers")
      projectNames.push(nodeProject, runtimeProject)
    }
    expect(new Set(projectNames).size).toBe(projectNames.length)
    expect(ciJob("test-linux")).toContain("projects=(web-node web-runtime)")
  })

  it("collects Node and workerd projects in one Istanbul report", () => {
    expect(rootPackageJson.devDependencies["@vitest/coverage-istanbul"]).toBe("4.1.10")
    expect(rootPackageJson.devDependencies).not.toHaveProperty("@vitest/coverage-v8")
    expect(rootVitestConfig).toContain('provider: "istanbul"')
    expect(rootVitestConfig).toContain('"src/**/*.{ts,tsx,js,jsx}"')
    expect(rootVitestConfig).toContain('"**/test-runtime/**"')
    expect(rootVitestConfig).toContain('"**/test-harness.ts"')
    for (const project of [
      "src/shared",
      "src/web",
      "src/cli",
      "src/daemon",
      "src/daemon/agent-driver",
      "src/email-worker",
      "src/ws-do",
      "src/wake-worker",
      "src/app",
      "tests/utils",
      "scripts/ci",
    ]) {
      expect(rootVitestConfig).toContain(`"${project}"`)
    }
    for (const [index, module] of directWorkerModules.entries()) {
      expect(rootVitestConfig).toContain(`"src/${module.name}"`)
      expect(
        rootVitestConfig.match(
          new RegExp(`src/${module.name}/vitest\\.runtime\\.config\\.mts`, "g"),
        ),
      ).toHaveLength(1)
      expect(module.runtimeConfig).toContain(`sequence: { groupOrder: ${index + 10} }`)
    }
    expect(directWorkerModules[3].runtimeConfig).toContain('main: "./custom-worker.ts"')
    expect(directWorkerModules[3].runtimeConfig).toContain(
      '"test-runtime/open-next-worker-stub.ts"',
    )
  })

  it("runs selected non-daemon roots in isolated reports with exact coverage includes", () => {
    const linux = ciJob("test-linux")
    expect(linux).toContain('for root in "${non_daemon[@]}"; do')
    expect(linux).toContain('if [[ "$include" == "$root/"* ]]; then')
    expect(linux).toContain('root_coverage+=("--coverage.include=$include")')
    expect(linux).toContain("--coverage.reporter=json")
    expect(linux).toContain(
      '"--coverage.reportsDirectory=$coverage_dir/root-${root_index}-${report_stem}"',
    )
    for (const projects of [
      "projects=(ci-scripts)",
      "projects=(email-worker-node email-worker-runtime)",
      "projects=(wake-worker-node wake-worker-runtime)",
      "projects=(web-node web-runtime)",
      "projects=(ws-do-node ws-do-runtime)",
    ]) expect(linux).toContain(projects)
    expect(linux).toContain('project_args+=("--project=$project")')
    expect(linux).toContain('pnpm vitest run "${vitest_args[@]}"')
    expect(linux).toContain(
      '--outputFile.blob="$report_dir/root-${root_index}-${report_stem}.blob"',
    )
    expect(linux).not.toContain("--project='!daemon-node'")
    expect(linux).not.toContain('"${non_daemon[@]}" "${coverage[@]}"')
    expect(linux).not.toContain(".vitest-reports/non-daemon.blob")
  })

  it("keeps package builds away from dist consumers and uploads one merged Istanbul report", () => {
    const linux = ciJob("test-linux")
    expect(linux).toContain("timeout-minutes: 25")
    expect(linux).toContain(
      "RUN_COVERAGE: ${{ github.event_name != 'push' || startsWith(github.event.head_commit.message, 'release:') }}",
    )
    expect(linux).toContain('pnpm vitest run "${vitest_args[@]}"')
    expect(linux).toContain("pnpm vitest run --project=daemon-node src/daemon")
    expect(linux).toContain(
      '"--coverage.reportsDirectory=$coverage_dir/root-${root_index}-${report_stem}"',
    )
    expect(linux).toContain('coverage=(--coverage)')
    expect(linux).toContain('--reporter=default --reporter=blob')
    expect(linux).toContain('--outputFile.blob="$report_dir/root-${root_index}-${report_stem}.blob"')
    expect(linux).toContain('--outputFile.blob="$report_dir/daemon.blob"')
    expect(linux).toContain("--merge-reports=.vitest-reports")
    expect(linux.match(/codecov\/codecov-action/g)).toHaveLength(1)
    expect(linux).toContain("if: env.RUN_COVERAGE == 'true'")
    expect(linux).toContain("files: ./coverage/coverage-final.json")
    expect(linux).toContain("verify-coverage-plan.mjs")
    for (const testPath of [
      "src/pack.test.ts",
      "src/cli/daemonLifecycle.real.test.ts",
      "src/cli/diagnosticsLifecycle.real.test.ts",
      "src/cli/daemonStop.test.ts",
      "src/version.packed.test.ts",
      "src/agent-driver-bundle.packed.test.ts",
      "src/cli/daemonSelfUpdate.real.test.ts",
    ]) {
      expect(linux).toContain(`--exclude ${testPath}`)
    }
    expect(linux).not.toContain("--exclude src/daemon/")
    expect(linux).toContain("pnpm --filter @alook/daemon exec vitest run --no-file-parallelism")
    for (const testPath of [
      "src/cli/daemonLifecycle.real.test.ts",
      "src/cli/diagnosticsLifecycle.real.test.ts",
      "src/cli/daemonStop.test.ts",
    ]) {
      expect(linux.slice(linux.indexOf("- name: Run selected daemon real-process tests")))
        .toContain(testPath)
    }
    expect(linux).toContain(
      "pnpm --filter @alook/agent-driver exec vitest run --no-file-parallelism src/pack.test.ts",
    )
    expect(linux).toContain(
      "pnpm --filter @alook/daemon exec vitest run --no-file-parallelism src/version.packed.test.ts src/agent-driver-bundle.packed.test.ts src/cli/daemonSelfUpdate.real.test.ts",
    )
    const selectedUnitRun = linux.indexOf("- name: Run selected unit tests")
    const coverageMerge = linux.indexOf("- name: Merge and verify selected coverage")
    const realProcessRuns = linux.indexOf("- name: Run selected daemon real-process tests")
    const packageRuns = linux.indexOf("- name: Run selected package artifact tests")
    const coverageUpload = linux.indexOf("- name: Upload coverage")
    expect(selectedUnitRun).toBeGreaterThan(-1)
    expect(coverageMerge).toBeGreaterThan(selectedUnitRun)
    expect(realProcessRuns).toBeGreaterThan(coverageMerge)
    expect(packageRuns).toBeGreaterThan(realProcessRuns)
    expect(coverageUpload).toBeGreaterThan(packageRuns)
    expect(linux).not.toContain("coverage:workers")
    expect(linux).not.toContain("workers-runtime")
    expect(ciWorkflow).not.toMatch(/^  coverage:/m)
    expect(rootPackageJson.scripts).not.toHaveProperty("coverage:workers")
  })

  it("replaces platform mocks only after stronger workerd coverage exists", () => {
    const readRepo = (path: string) => readFileSync(
      resolve(import.meta.dirname, `../../${path}`),
      "utf8",
    )
    const wsRuntime = readRepo("src/ws-do/test-runtime/worker.runtime.test.ts")
    const webRuntime = readRepo("src/web/test-runtime/worker.runtime.test.ts")
    const emailNode = readRepo("src/email-worker/src/index.test.ts")
    const emailRuntime = readRepo("src/email-worker/test-runtime/worker.runtime.test.ts")
    const wakeNode = readRepo("src/wake-worker/src/index.test.ts")
    const wakeRuntime = readRepo("src/wake-worker/test-runtime/worker.runtime.test.ts")

    expect(existsSync(resolve(import.meta.dirname, "../../src/ws-do/src/rate-limit-do.test.ts"))).toBe(false)
    expect(wsRuntime).toContain("persists the counter across stubs for the same Durable Object id")
    expect(wsRuntime).toContain("resets expired storage and rejects invalid Durable Object requests")

    expect(existsSync(resolve(import.meta.dirname, "../../src/web/src/lib/worker-runtime.test.ts"))).toBe(false)
    expect(webRuntime).toContain("adds browser and CDN revalidation headers to public route %s")
    expect(webRuntime).toContain("forwards WebSocket upgrade %s through the configured service binding")

    expect(emailNode).not.toContain('describe("fetch() routing"')
    expect(emailNode).not.toContain('describe("IMAP management routes"')
    expect(emailRuntime).toContain("forwards status and sync routes to the real IMAP Durable Object")
    expect(emailRuntime).toContain("rejects unsupported methods, paths, and missing IMAP account ids")

    expect(wakeNode).not.toContain("returns 400 on invalid JSON body")
    expect(wakeNode).not.toContain("returns 405 for non-POST methods")
    expect(wakeNode).not.toContain("returns 200 { status: ok } for GET /health")
    expect(wakeRuntime).toContain("rejects invalid JSON and non-POST dev requests at the real entrypoint")
    expect(wakeRuntime).toContain("loads production migrations and serves the production entrypoint")
  })
})

describe("Desktop window contract", () => {
  it("delegates external file drops to the webview attachment lifecycle", () => {
    const mainWindow = desktopConfig.app?.windows?.find((window) => window.label === "main")
    expect(mainWindow?.dragDropEnabled).toBe(false)
  })
})

describe("Desktop updater release", () => {
  it("uploads assets without replacing the auto-tag title or changelog", () => {
    expect(autoTagReleaseWorkflow).toContain('--title "$TAG"')
    expect(desktopReleaseWorkflow).toContain("for attempt in {1..30}")
    expect(desktopReleaseWorkflow).toContain('releases/tags/${TAG}')
    expect(desktopReleaseWorkflow).toContain('releaseId: ${{ steps.release.outputs.id }}')
    expect(desktopReleaseWorkflow).not.toContain("tagName:")
    expect(desktopReleaseWorkflow).not.toContain("releaseName:")
    expect(desktopReleaseWorkflow).not.toContain("releaseBody:")
    expect(desktopReleaseWorkflow).not.toContain("releaseDraft:")
    expect(desktopReleaseWorkflow).not.toContain("prerelease:")
    expect(desktopReleaseWorkflow).toContain('EXISTING=$(gh release view "$TAG" --json body')
    expect(desktopReleaseWorkflow).toContain('gh release edit "$TAG" --notes "${EXISTING}${DOWNLOADS}"')
  })

  it("builds signed updater artifacts and publishes updater metadata", () => {
    expect(desktopConfig.bundle?.createUpdaterArtifacts).toBe(true)
    expect(desktopConfig.plugins?.updater?.endpoints).toEqual([
      "https://alook.ai/api/desktop/update/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}}",
    ])
    expect(desktopReleaseWorkflow).toContain("uploadUpdaterJson: true")
    expect(desktopReleaseWorkflow).not.toContain("includeUpdaterJson")
    expect(desktopReleaseWorkflow).toContain("TAURI_SIGNING_PRIVATE_KEY:")
    expect(desktopUpdateRoute).toContain('"darwin-aarch64-app"')
    expect(desktopUpdateRoute).toContain('"linux-x86_64-appimage"')
    expect(desktopUpdateRoute).toContain('"linux-x86_64-deb"')
    expect(desktopUpdateRoute).toContain('"linux-x86_64-rpm"')
    expect(desktopUpdateRoute).toContain('"windows-x86_64-msi"')
    expect(desktopUpdateRoute).toContain('"windows-x86_64-nsis"')
  })

  it("uses an inline unsigned-build overlay without mutating tracked configuration", () => {
    expect(desktopBuildScript).toContain(
      `--config '{"bundle":{"createUpdaterArtifacts":false}}'`,
    )
    expect(desktopBuildScript).not.toContain("tauri.conf.json")
    expect(desktopBuildScript).not.toMatch(/\b(?:cp|mv|sed)\b/)
    expect(desktopBuildScript).not.toContain(".bak")
  })

  it("keeps local ad-hoc signing while release builds use Developer ID notarization", () => {
    expect(desktopMacConfig.bundle?.macOS?.signingIdentity).toBe("-")
    expect(desktopMacConfig.bundle?.macOS?.hardenedRuntime).toBe(true)
    expect(desktopMacConfig.bundle?.macOS?.entitlements).toBeUndefined()
    expect(existsSync(desktopEntitlementsPath)).toBe(false)
    expect(desktopReleaseWorkflow).toContain("APPLE_CERTIFICATE:")
    expect(desktopReleaseWorkflow).toContain("APPLE_CERTIFICATE_PASSWORD:")
    expect(desktopReleaseWorkflow).toContain("APPLE_SIGNING_IDENTITY:")
    expect(desktopReleaseWorkflow).toContain("APPLE_API_ISSUER:")
    expect(desktopReleaseWorkflow).toContain("APPLE_API_KEY_PATH:")
    expect(desktopReleaseWorkflow).toContain("codesign --verify --deep --strict")
    expect(desktopReleaseWorkflow).toContain("flags=.*runtime")
    expect(desktopReleaseWorkflow).toContain("xcrun stapler validate")
    expect(desktopReleaseWorkflow).toContain("spctl --assess --type execute")
    expect(desktopReleaseWorkflow).toContain("CFBundleShortVersionString")
    expect(desktopReleaseWorkflow).toContain("EXPECTED_VERSION:")
    expect(desktopReleaseWorkflow).toContain("Developer ID signed")
    expect(desktopReleaseWorkflow).not.toContain("ad-hoc signed and are not notarized")
    expect(desktopReleaseWorkflow).not.toContain("Privacy & Security")
    expect(desktopReleaseWorkflow).toContain("not Authenticode code-signed")
    expect(desktopReleaseWorkflow).toContain("More info")
    expect(desktopReleaseWorkflow).toContain("Run anyway")
  })
})

describe("Desktop image clipboard", () => {
  const writeImagePermission = "clipboard-manager:allow-write-image"

  it("registers the maintained plugin only in the desktop dependency chain", () => {
    expect(desktopCargoManifest).toMatch(
      /\[target\."cfg\(not\(any\(target_os = \\"android\\", target_os = \\"ios\\"\)\)\)"\.dependencies\][\s\S]*tauri-plugin-clipboard-manager = "2"/,
    )
    expect(desktopRustEntry).toMatch(
      /#\[cfg\(desktop\)\]\s*\{[\s\S]*\.plugin\(tauri_plugin_clipboard_manager::init\(\)\)[\s\S]*run_desktop\(builder\);/,
    )
    expect(desktopRustEntry.match(/tauri_plugin_clipboard_manager::init/g)).toHaveLength(1)
  })

  it("authorizes configured app documents through one local image-write capability", () => {
    expect(desktopConfig.build).toMatchObject({
      devUrl: "http://localhost:3000/c",
      frontendDist: "https://alook.ai/c",
    })
    expect(desktopCapability).toMatchObject({
      identifier: "desktop-capability",
      windows: ["main"],
      platforms: ["linux", "macOS", "windows"],
      local: true,
      remote: { urls: ["https://alook.ai"] },
      permissions: [writeImagePermission],
    })
    expect(desktopDevConfig.app.security.capabilities).toEqual([
      "desktop-capability",
      "external-links",
    ])
  })
})

describe("Mobile release availability", () => {
  it("publishes --mobile bumps to TestFlight and keeps manual uploads opt-in", () => {
    expect(existsSync(mobileReleaseWorkflowPath)).toBe(true)
    expect(desktopIosConfig.identifier).toBe("ai.alook.ios")
    expect(iosProject).toContain("PRODUCT_BUNDLE_IDENTIFIER: ai.alook.ios")
    expect(iosProject).not.toContain("PRODUCT_BUNDLE_IDENTIFIER: ai.alook.desktop")
    expect(iosProject).toContain("CODE_SIGN_STYLE: Manual")
    expect(iosProject).toContain("CODE_SIGN_IDENTITY: Apple Distribution")
    expect(iosProject).toContain("PROVISIONING_PROFILE_SPECIFIER: Alook iOS App Store Connect")
    expect(iosProject).not.toContain("${FORCE_COLOR}")
    expect(iosExportOptions).toContain("<string>app-store-connect</string>")
    expect(iosExportOptions).toContain("<string>manual</string>")
    expect(iosExportOptions).toContain("<key>ai.alook.ios</key>")
    expect(iosExportOptions).toContain("<string>Alook iOS App Store Connect</string>")
    expect(mobileReleaseWorkflow).toMatch(/^  workflow_dispatch:/m)
    expect(mobileReleaseWorkflow).toMatch(/^  push:/m)
    expect(mobileReleaseWorkflow).toContain('branches: [main]')
    expect(mobileReleaseWorkflow).toContain('src/desktop/.deploy-version-mobile')
    expect(mobileReleaseWorkflow).not.toMatch(/^  pull_request:/m)
    expect(mobileReleaseWorkflow).toContain("default: false")
    expect(mobileReleaseWorkflow).toContain("github.event_name == 'push' || inputs.upload == true")
    expect(mobileReleaseWorkflow).toContain("Verify automatic TestFlight release version")
    expect(mobileReleaseWorkflow).toContain('requested_version=$(tr -d')
    expect(mobileReleaseWorkflow).toContain("APPLE_DEVELOPMENT_TEAM:")
    expect(mobileReleaseWorkflow).toContain("IOS_CERTIFICATE:")
    expect(mobileReleaseWorkflow).toContain("IOS_CERTIFICATE_PASSWORD:")
    expect(mobileReleaseWorkflow).toContain("IOS_MOBILE_PROVISION:")
    expect(mobileReleaseWorkflow).toContain("pnpm tauri ios init --ci --skip-targets-install")
    expect(mobileReleaseWorkflow).toContain('security import "$certificate_path"')
    expect(mobileReleaseWorkflow).toContain('install -m 600 "$profile_source"')
    expect(mobileReleaseWorkflow).toContain("unset IOS_CERTIFICATE IOS_CERTIFICATE_PASSWORD")
    expect(mobileReleaseWorkflow).toContain("pnpm tauri ios build")
    expect(mobileReleaseWorkflow).toContain("--export-method app-store-connect")
    expect(mobileReleaseWorkflow).toContain('bundleVersion\\\":\\\"${GITHUB_RUN_NUMBER}')
    expect(mobileReleaseWorkflow).toContain("CFBundleShortVersionString")
    expect(mobileReleaseWorkflow).toContain("CFBundleVersion")
    expect(mobileReleaseWorkflow).toContain("xcrun altool --upload-app")
    expect(mobileReleaseWorkflow).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
    expect(bumpScript).toContain('args.includes("--mobile")')
    expect(bumpScript).toContain("src/desktop/.deploy-version-mobile")
    expect(bumpScript).toContain("automatic TestFlight upload")
    expect(bumpScript).toContain("iOS CFBundleShortVersionString")
  })

  it("attaches a signed Android APK to --mobile GitHub releases without Google Play", () => {
    expect(desktopAndroidConfig.identifier).toBe("ai.alook.android")
    expect(androidGradle).toContain('namespace = "ai.alook.android"')
    expect(androidGradle).toContain('applicationId = "ai.alook.android"')
    expect(androidGradle).toContain('signingConfig = signingConfigs.getByName("release")')
    expect(androidMainActivity).toContain("package ai.alook.android")
    expect(mobileReleaseWorkflow).toContain("build-android:")
    expect(mobileReleaseWorkflow).toContain("if: github.event_name == 'push'")
    expect(mobileReleaseWorkflow).toContain("ANDROID_KEYSTORE:")
    expect(mobileReleaseWorkflow).toContain("ANDROID_KEYSTORE_PASSWORD:")
    expect(mobileReleaseWorkflow).toContain("ANDROID_KEY_ALIAS:")
    expect(mobileReleaseWorkflow).toContain("ANDROID_KEY_PASSWORD:")
    expect(mobileReleaseWorkflow).toContain("aarch64-linux-android,armv7-linux-androideabi")
    expect(mobileReleaseWorkflow).toContain('"platforms;android-36"')
    expect(mobileReleaseWorkflow).toContain('"build-tools;36.0.0"')
    expect(mobileReleaseWorkflow).toContain('"ndk;29.0.13846066"')
    expect(mobileReleaseWorkflow).toContain("pnpm tauri android init --ci --skip-targets-install")
    expect(mobileReleaseWorkflow).toContain("pnpm tauri android build")
    expect(mobileReleaseWorkflow).toContain("--target aarch64 armv7")
    expect(mobileReleaseWorkflow).toContain("package: name='ai.alook.android'")
    expect(mobileReleaseWorkflow).toContain("apksigner verify --verbose --print-certs")
    expect(mobileReleaseWorkflow).toContain("gh release upload")
    expect(mobileReleaseWorkflow).toContain("Alook_${EXPECTED_VERSION}_android.apk")
    expect(mobileReleaseWorkflow).toContain('gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json body')
    expect(mobileReleaseWorkflow).toContain('cat >> "$notes_file" <<EOF')
    expect(mobileReleaseWorkflow).toContain('<!-- alook-android-download -->')
    expect(mobileReleaseWorkflow).toContain("## Android")
    expect(mobileReleaseWorkflow).toContain("[Download signed APK](${base}/${APK_NAME})")
    expect(mobileReleaseWorkflow).toContain('gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --notes-file "$notes_file"')
    expect(mobileReleaseWorkflow).not.toContain("Google Play")
  })
})

describe("Native OAuth association contract", () => {
  it("keeps the return domain, mobile identities, and source-only Worker route aligned", () => {
    expect(nativeOauthContract).toContain(
      'NATIVE_OAUTH_RETURN_HOST = "auth.alook.ai"',
    )
    expect(nativeOauthContract).toContain(
      'NATIVE_OAUTH_RETURN_PATH = "/auth/native/return"',
    )
    expect(nativeOauthWebConfig).toMatch(
      /\[\[routes\]\][\s\S]*pattern = "auth\.alook\.ai"[\s\S]*custom_domain = true/,
    )

    expect(desktopIosConfig.identifier).toBe("ai.alook.ios")
    expect(iosProject).toContain("DEVELOPMENT_TEAM: 5RF24VHDQB")
    expect(nativeOauthAasaRoute).toContain("5RF24VHDQB.ai.alook.ios")
    expect(nativeOauthAasaRoute).toContain('"/": "/auth/native/return"')

    expect(desktopAndroidConfig.identifier).toBe("ai.alook.android")
    expect(nativeOauthAssetLinksRoute).toContain('package_name: "ai.alook.android"')
    expect(nativeOauthAssetLinksRoute).toContain(
      "9D:C6:ED:E9:4B:A6:63:EE:C9:EC:98:FF:7B:AF:D5:5E:24:8B:6C:4B:C2:15:7F:CF:04:2D:F5:9B:0E:41:08:06",
    )
  })
})
