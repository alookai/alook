import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repositoryRoot = resolve(import.meta.dirname, "../..")
const launcherPath = resolve(repositoryRoot, "scripts/dev-with-wrangler-registry.mjs")
const packagePaths = [
  "src/web/package.json",
  "src/ws-do/package.json",
  "src/wake-worker/package.json",
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

  it("executes native package-manager launchers directly", () => {
    const launcher = readFileSync(launcherPath, "utf8").replaceAll("\r\n", "\n")

    expect(launcher).toContain('spawn(\n  packageManagerCli,\n  ["exec", command, ...args]')
    expect(launcher).not.toContain("process.execPath")
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
