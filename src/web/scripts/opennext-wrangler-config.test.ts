import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

type PackageJson = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  pnpm?: { patchedDependencies?: Record<string, string> }
}

const repositoryRoot = new URL("../../../", import.meta.url)

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(path, repositoryRoot), "utf8")
}

function readPackage(path: string): PackageJson {
  return JSON.parse(readRepositoryFile(path)) as PackageJson
}

function dependency(path: string, name: string): string | undefined {
  const manifest = readPackage(path)
  return manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]
}

function bindingNames(toml: string): string[] {
  return [...toml.matchAll(/^binding\s*=\s*"([^"]+)"$/gm)].map((match) => match[1])
}

describe("OpenNext and Wrangler refresh", () => {
  it("uses one exact Wrangler version and keeps the Web alias aligned", () => {
    const manifests = [
      "package.json",
      "src/app/package.json",
      "src/email-worker/package.json",
      "src/queue-worker/package.json",
      "src/web/package.json",
      "src/ws-do/package.json",
    ]
    const wranglerVersion = dependency(manifests[0], "wrangler")
    expect(wranglerVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)

    for (const manifest of manifests) {
      expect(dependency(manifest, "wrangler"), manifest).toBe(wranglerVersion)
    }
    expect(dependency("src/web/package.json", "wrangler-e2e"))
      .toBe(`npm:wrangler@${wranglerVersion}`)
  })

  it("locks the OpenNext AWS patch and keeps one Workers types range", () => {
    expect(dependency("src/web/package.json", "@opennextjs/cloudflare")).toBe("^1.20.6")

    const rootManifest = readPackage("package.json")
    expect(rootManifest.pnpm?.patchedDependencies).toEqual({
      "@opennextjs/aws@4.1.4": "patches/@opennextjs__aws@4.1.4.patch",
    })
    expect(existsSync(new URL("patches/@opennextjs__aws@4.1.4.patch", repositoryRoot))).toBe(true)
    expect(existsSync(new URL("patches/@opennextjs__aws@4.1.0.patch", repositoryRoot))).toBe(false)

    const workerManifests = [
      "src/email-worker/package.json",
      "src/shared/package.json",
      "src/queue-worker/package.json",
      "src/ws-do/package.json",
    ]
    const workersTypesRange = dependency(workerManifests[0], "@cloudflare/workers-types")
    expect(workersTypesRange).toMatch(/^\^5\.\d{8}\.\d+$/)
    for (const manifest of workerManifests) {
      expect(dependency(manifest, "@cloudflare/workers-types"), manifest)
        .toBe(workersTypesRange)
    }

    const lockfile = readRepositoryFile("pnpm-lock.yaml")
    expect(lockfile).toContain("'@opennextjs/aws@4.1.4':")
    expect(lockfile).toContain("'@opennextjs/cloudflare@1.20.6':")
    expect(lockfile).not.toContain("'@opennextjs/aws@4.1.0':")
  })

  it("enables strict public global fetch without forbidden module registry flags", () => {
    for (const path of ["src/web/wrangler.toml", "src/web/blog/wrangler.toml"]) {
      const toml = readRepositoryFile(path)
      expect(toml.match(/^compatibility_flags\s*=.*$/gm), path).toEqual([
        'compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]',
      ])
      expect(toml.match(/global_fetch_strictly_public/g), path).toHaveLength(1)
      expect(toml, path).not.toContain("new_module_registry")
    }
  })

  it("keeps the Web queue wiring and the Blog ASSETS-only contract", () => {
    const webToml = readRepositoryFile("src/web/wrangler.toml")
    expect(webToml.match(/name\s*=\s*"NEXT_CACHE_DO_QUEUE"/g)).toHaveLength(1)
    expect(webToml).toMatch(/name\s*=\s*"NEXT_CACHE_DO_QUEUE"\nclass_name\s*=\s*"DOQueueHandler"/)
    expect(webToml).toContain('new_sqlite_classes = ["DOQueueHandler"]')
    expect(webToml).toContain('binding = "WORKER_SELF_REFERENCE"')
    expect(webToml).toContain('binding = "WS_DO_WORKER"')
    expect(webToml).toContain('binding = "BLOG_WORKER"')

    const blogToml = readRepositoryFile("src/web/blog/wrangler.toml")
    expect(bindingNames(blogToml)).toEqual(["ASSETS"])
    expect(blogToml).toContain('html_handling = "none"')
    expect(blogToml).toContain("run_worker_first = true")
    for (const forbidden of [
      "NEXT_CACHE_DO_QUEUE",
      "NEXT_TAG_CACHE_D1",
      "NEXT_INC_CACHE_R2_BUCKET",
      "WORKER_SELF_REFERENCE",
      "BLOG_WORKER",
    ]) {
      expect(blogToml).not.toContain(forbidden)
    }
  })
})
