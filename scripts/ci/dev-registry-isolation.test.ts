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

function devScript(packagePath: string): string {
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, packagePath), "utf8")) as {
    scripts?: { dev?: unknown }
  }
  expect(typeof packageJson.scripts?.dev).toBe("string")
  return packageJson.scripts?.dev as string
}

function resolvedRegistryPath(root: string, packagePath: string): string {
  const matches = [...devScript(packagePath).matchAll(registryLauncher)]
  expect(matches).toHaveLength(1)
  return resolve(root, dirname(packagePath), matches[0][1])
}

describe("local Wrangler registry isolation", () => {
  it("sets Wrangler's registry to the absolute worktree-local path before spawning", () => {
    const launcher = readFileSync(launcherPath, "utf8")

    expect(launcher).toContain("WRANGLER_REGISTRY_PATH: resolve(process.cwd(), registryPath)")
  })

  it("uses one shared registry inside the current worktree for every dev entrypoint", () => {
    const paths = packagePaths.map((packagePath) => resolvedRegistryPath(repositoryRoot, packagePath))

    expect(new Set(paths)).toEqual(new Set([resolve(repositoryRoot, ".wrangler/registry")]))
  })

  it("resolves identical Worker names to different registries in separate worktrees", () => {
    const firstRoot = "/tmp/alook-primary"
    const secondRoot = "/tmp/alook-disposable"
    const firstPaths = packagePaths.map((packagePath) => resolvedRegistryPath(firstRoot, packagePath))
    const secondPaths = packagePaths.map((packagePath) => resolvedRegistryPath(secondRoot, packagePath))

    expect(new Set(firstPaths)).toEqual(new Set([resolve(firstRoot, ".wrangler/registry")]))
    expect(new Set(secondPaths)).toEqual(new Set([resolve(secondRoot, ".wrangler/registry")]))
    expect(firstPaths[0]).not.toBe(secondPaths[0])
  })
})
