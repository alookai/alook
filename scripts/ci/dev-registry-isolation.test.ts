import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repositoryRoot = resolve(import.meta.dirname, "../..")
const launcherPath = resolve(repositoryRoot, "scripts/dev-with-wrangler-registry.mjs")
const packagePaths = [
  "src/web/package.json",
  "src/ws-do/package.json",
  "src/queue-worker/package.json",
  "src/email-worker/package.json",
]
const registryLauncher = /(?:^|\s)node\s+\.\.\/\.\.\/scripts\/dev-with-wrangler-registry\.mjs\s+([^\s]+)/g

function devScripts(packagePath: string): string[] {
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, packagePath), "utf8")) as {
    scripts?: Record<string, unknown>
  }
  const scripts = Object.entries(packageJson.scripts ?? {})
    .filter(([name, script]) =>
      name.startsWith("dev") &&
      typeof script === "string" &&
      script.includes("dev-with-wrangler-registry.mjs"),
    )
    .map(([, script]) => script as string)
  expect(scripts.length).toBeGreaterThan(0)
  return scripts
}

function resolvedRegistryPaths(root: string, packagePath: string): string[] {
  return devScripts(packagePath).map((script) => {
    const matches = [...script.matchAll(registryLauncher)]
    expect(matches).toHaveLength(1)
    return resolve(root, dirname(packagePath), matches[0][1])
  })
}

describe("local Wrangler registry isolation", () => {
  it("sets Wrangler's registry to the absolute worktree-local path before spawning", () => {
    const launcher = readFileSync(launcherPath, "utf8")

    expect(launcher).toContain("WRANGLER_REGISTRY_PATH: resolve(process.cwd(), registryPath)")
  })

  it.skipIf(process.platform === "win32")("executes a native package-manager launcher directly and preserves Worker argv", () => {
    const root = realpathSync(mkdtempSync(resolve(tmpdir(), "alook-native-registry-")))
    try {
      const packageManager = resolve(root, "native-pnpm")
      const cwd = resolve(root, "src/web")
      mkdirSync(cwd, { recursive: true })
      writeFileSync(packageManager, '#!/bin/sh\nprintf \'%s\\n\' "$WRANGLER_REGISTRY_PATH"\nprintf \'%s\\n\' "$@"\n')
      chmodSync(packageManager, 0o755)
      const result = spawnSync(process.execPath, [launcherPath, "../../.wrangler/registry", "wrangler", "dev", "--local"], {
        cwd, env: { ...process.env, npm_execpath: packageManager }, encoding: "utf8", timeout: 5000,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim().split("\n")).toEqual([resolve(root, ".wrangler/registry"), "exec", "wrangler", "dev", "--local"])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it("uses one shared registry inside the current worktree for every dev entrypoint", () => {
    const paths = packagePaths.flatMap((packagePath) =>
      resolvedRegistryPaths(repositoryRoot, packagePath),
    )

    expect(new Set(paths)).toEqual(new Set([resolve(repositoryRoot, ".wrangler/registry")]))
  })

  it("resolves identical Worker names to different registries in separate worktrees", () => {
    const firstRoot = "/tmp/alook-primary"
    const secondRoot = "/tmp/alook-disposable"
    const firstPaths = packagePaths.flatMap((packagePath) =>
      resolvedRegistryPaths(firstRoot, packagePath),
    )
    const secondPaths = packagePaths.flatMap((packagePath) =>
      resolvedRegistryPaths(secondRoot, packagePath),
    )

    expect(new Set(firstPaths)).toEqual(new Set([resolve(firstRoot, ".wrangler/registry")]))
    expect(new Set(secondPaths)).toEqual(new Set([resolve(secondRoot, ".wrangler/registry")]))
    expect(firstPaths[0]).not.toBe(secondPaths[0])
  })
})
