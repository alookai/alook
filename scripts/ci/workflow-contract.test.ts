import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const workflowRoot = resolve(import.meta.dirname, "../../.github/workflows")
function normalizeWorkflow(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

const workflow = normalizeWorkflow(readFileSync(resolve(workflowRoot, "e2e-ui.yml"), "utf8"))
const ciWorkflow = normalizeWorkflow(readFileSync(resolve(workflowRoot, "ci.yml"), "utf8"))
const autoTagReleaseWorkflow = normalizeWorkflow(
  readFileSync(resolve(workflowRoot, "auto-tag-release.yml"), "utf8"),
)
const desktopReleaseWorkflow = normalizeWorkflow(readFileSync(resolve(workflowRoot, "desktop-release.yml"), "utf8"))
const desktopConfig = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../src/desktop/src-tauri/tauri.conf.json"), "utf8"),
) as {
  bundle?: { createUpdaterArtifacts?: boolean | string }
  plugins?: { updater?: { endpoints?: string[] } }
}
const desktopMacConfig = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../src/desktop/src-tauri/tauri.macos.conf.json"), "utf8"),
) as { bundle?: { macOS?: { entitlements?: string; signingIdentity?: string } } }
const desktopEntitlementsPath = resolve(
  import.meta.dirname,
  "../../src/desktop/src-tauri/entitlements.plist",
)
const desktopBuildScript = readFileSync(
  resolve(import.meta.dirname, "../../src/desktop/scripts/build.sh"),
  "utf8",
)
const bumpScript = readFileSync(resolve(import.meta.dirname, "../bump-version.mjs"), "utf8")
const mobileReleaseWorkflow = resolve(workflowRoot, "mobile-release.yml")
const desktopUpdateRoute = readFileSync(
  resolve(import.meta.dirname, "../../src/web/src/app/api/desktop/update/[target]/[arch]/[current_version]/route.ts"),
  "utf8",
)
const publishWorkflows = ["publish-app.yml", "publish-cli.yml", "publish-daemon.yml", "publish-agent-driver.yml"]
  .map((name) => normalizeWorkflow(readFileSync(resolve(workflowRoot, name), "utf8")))
const publishAgentDriverWorkflow = normalizeWorkflow(
  readFileSync(resolve(workflowRoot, "publish-agent-driver.yml"), "utf8"),
)
const publishDaemonWorkflow = normalizeWorkflow(
  readFileSync(resolve(workflowRoot, "publish-daemon.yml"), "utf8"),
)

function ciJob(name: string): string {
  const start = ciWorkflow.indexOf(`\n  ${name}:\n`)
  if (start < 0) throw new Error(`missing CI job: ${name}`)
  const next = ciWorkflow.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/)
  return next < 0 ? ciWorkflow.slice(start) : ciWorkflow.slice(start, start + 1 + next)
}

describe("E2E UI workflow", () => {
  it("runs before merge without running on main pushes", () => {
    expect(workflow).toMatch(/^  pull_request:/m)
    expect(workflow).toMatch(/^  merge_group:/m)
    expect(workflow).not.toMatch(/^  push:/m)
  })

  it("uploads service logs when a Playwright shard fails", () => {
    expect(workflow).toContain("src/web/e2e-service-logs/")
  })

  it("does not install Bun for Node-only browser tests", () => {
    expect(workflow).not.toContain("oven-sh/setup-bun")
  })

  it("runs shards in the lockfile-selected Playwright image without host installs", () => {
    expect(workflow).toContain("image: ${{ matrix.image }}")
    expect(workflow).toContain("options: --init --ipc=host --user 1001")
    expect(workflow).toMatch(/defaults:\n      run:\n        shell: bash/)
    expect(workflow).not.toContain("playwright-browser-cache")
    expect(workflow).not.toContain("~/.cache/ms-playwright")
    expect(workflow).not.toContain("playwright install-deps")
    expect(workflow).not.toContain("playwright install chromium")
  })
})

describe("Bun workflow setup", () => {
  it("normalizes Windows checkout line endings before locating jobs", () => {
    expect(normalizeWorkflow("jobs:\r\n  test-linux:\r\n")).toBe("jobs:\n  test-linux:\n")
  })

  it("installs pinned Bun in every CI job that builds a daemon package fixture", () => {
    const bunJobs = ["test-linux", "test-windows", "build", "coverage"]
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

describe("Agent driver publishing", () => {
  it("publishes independently when its unified version changes", () => {
    expect(publishAgentDriverWorkflow).toContain("paths: [src/daemon/agent-driver/package.json]")
    expect(publishAgentDriverWorkflow).toContain("Publish @alook/agent-driver to npm")
    expect(publishAgentDriverWorkflow).toContain("pnpm -C src/daemon/agent-driver run build")
    expect(publishAgentDriverWorkflow).toContain("npm publish --access public")
    expect(publishAgentDriverWorkflow).toContain("id-token: write")
  })

  it("builds the workspace driver before a clean daemon publish build", () => {
    const driverBuild = publishDaemonWorkflow.indexOf("pnpm -C src/daemon/agent-driver run build")
    const daemonBuild = publishDaemonWorkflow.indexOf("pnpm -C src/daemon run build")
    expect(driverBuild).toBeGreaterThan(0)
    expect(daemonBuild).toBeGreaterThan(driverBuild)
  })
})

describe("CI test budgets", () => {
  it("gives the slower Windows workspace suite enough job time", () => {
    expect(ciJob("test-windows")).toContain("timeout-minutes: 15")
  })

  it("runs Windows process-authority fixtures before the daemon suite", () => {
    const windows = ciJob("test-windows")
    const processAuthority = windows.indexOf(
      "pnpm --filter @alook/agent-driver exec vitest run src/internal/killTree.test.ts",
    )
    const focusedAdmission = windows.indexOf(
      "pnpm --filter @alook/daemon exec vitest run src/daemon/createDaemon.test.ts",
    )
    const daemon = windows.indexOf("pnpm --filter @alook/daemon test")
    expect(processAuthority).toBeGreaterThan(0)
    expect(focusedAdmission).toBeGreaterThan(processAuthority)
    expect(daemon).toBeGreaterThan(focusedAdmission)
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

describe("Turbo CI execution", () => {
  const cachedJobs = ["blog-content", "quality", "knip", "test-linux", "test-windows", "build"]
  const affectedJobs = ["quality", "knip", "test-linux", "test-windows", "build"]

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

  it("provides complete history and explicit comparison commits to affected jobs", () => {
    const scope = ciJob("scope")
    expect(scope).toContain("full: ${{ steps.scope.outputs.full }}")
    expect(scope).toContain("base_sha: ${{ steps.scope.outputs.base_sha }}")
    expect(scope).toContain("head_sha: ${{ steps.scope.outputs.head_sha }}")

    for (const job of affectedJobs) {
      const definition = ciJob(job)
      expect(definition).toContain("fetch-depth: 0")
      expect(definition).toContain("needs.scope.outputs.full == 'true'")
      expect(definition).toContain("needs.scope.outputs.full != 'true'")
      expect(definition).toContain("TURBO_SCM_BASE: ${{ needs.scope.outputs.base_sha }}")
      expect(definition).toContain("TURBO_SCM_HEAD: ${{ needs.scope.outputs.head_sha }}")
      expect(definition).toContain("--affected")
    }
  })

  it("retains full commands when scope classification fails closed", () => {
    expect(ciJob("quality")).toContain("run: pnpm typecheck")
    expect(ciJob("quality")).toContain("run: pnpm lint")
    expect(ciJob("knip")).toContain("run: pnpm knip")
    const linux = ciJob("test-linux")
    expect(linux).toContain("run: pnpm turbo run test --filter=@alook/daemon")
    const windows = ciJob("test-windows")
    expect(windows).toContain("run: pnpm --filter @alook/daemon test")
    for (const definition of [linux, windows]) {
      expect(definition).toContain("run: pnpm turbo run test --filter='!@alook/daemon'")
      expect(definition.match(/VITEST_MAX_WORKERS: 1/g)).toHaveLength(2)
    }
    expect(ciJob("build")).toContain(
      "run: pnpm build --filter=@alook/shared --filter=@alook/web --filter=@alook/cli --filter=@alook/email-worker --filter=@alook/ws-do --filter=@alook/wake-worker",
    )
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

  it("ad-hoc signs unnotarized macOS builds and discloses manual approval", () => {
    expect(desktopMacConfig.bundle?.macOS?.signingIdentity).toBe("-")
    expect(desktopMacConfig.bundle?.macOS?.entitlements).toBeUndefined()
    expect(existsSync(desktopEntitlementsPath)).toBe(false)
    expect(desktopReleaseWorkflow).toContain("ad-hoc signed and are not notarized")
    expect(desktopReleaseWorkflow).toContain("Privacy & Security")
    expect(desktopReleaseWorkflow).toContain("not Authenticode code-signed")
    expect(desktopReleaseWorkflow).toContain("More info")
    expect(desktopReleaseWorkflow).toContain("Run anyway")
    expect(desktopReleaseWorkflow).not.toContain("APPLE_CERTIFICATE:")
  })
})

describe("Mobile release availability", () => {
  it("fails closed until store signing accounts and a current workflow exist", () => {
    expect(existsSync(mobileReleaseWorkflow)).toBe(false)
    expect(bumpScript).not.toContain("deploy-version-mobile")
    expect(bumpScript).toContain("Mobile releases are not configured")
  })
})
