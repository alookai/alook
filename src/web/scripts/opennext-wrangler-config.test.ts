import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { lockedDependency, parsePnpmLock, projectDependencies } from "../../../scripts/ci/pnpm-lock.mjs"

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
  it("uses one exact Wrangler dependency identity across the workspace", () => {
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
    expect(dependency("src/web/package.json", "wrangler-e2e")).toBeUndefined()
  })

  it("binds selected OpenNext resolutions to their declared patches and keeps one Workers types range", () => {
    const lock = parsePnpmLock(readRepositoryFile("pnpm-lock.yaml"))
    const selected = lockedDependency(lock, "src/web", "@opennextjs/cloudflare")
    expect(selected.specifier).toBe(dependency("src/web/package.json", "@opennextjs/cloudflare"))
    const requireFromWeb = createRequire(new URL("src/web/package.json", repositoryRoot))
    const cloudflareRoot = join(dirname(requireFromWeb.resolve("@opennextjs/cloudflare")), "../..")
    const installed = JSON.parse(readFileSync(join(cloudflareRoot, "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> }
    expect(selected.version.split("(")[0]).toBe(installed.version)
    const requireFromCloudflare = createRequire(join(cloudflareRoot, "package.json"))
    const aws = JSON.parse(readFileSync(join(dirname(requireFromCloudflare.resolve("@opennextjs/aws/index.js")), "../package.json"), "utf8")) as { version: string }
    const projection = projectDependencies(lock, [{ importer: "src/web", name: "@opennextjs/cloudflare" }])
    expect(Object.keys(projection)).toContain(`package:@opennextjs/aws@${aws.version}`)
    expect(installed.dependencies["@opennextjs/aws"]).toBeTruthy()
    const rootManifest = readPackage("package.json")
    const patches = rootManifest.pnpm?.patchedDependencies
    expect(patches).toBeDefined()
    const selectedPatch = patches?.[`@opennextjs/cloudflare@${installed.version}`]
    expect(selectedPatch).toBeTruthy()
    for (const [identity, path] of Object.entries(patches ?? {})) {
      expect(lock.packages.has(identity), identity).toBe(true)
      expect(lock.patches.get(identity), identity).toContain(`path: ${path}`)
      expect(existsSync(new URL(path, repositoryRoot)), path).toBe(true)
      expect(fileURLToPath(new URL(path, repositoryRoot))).toMatch(/\.patch$/)
    }

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

  })

  it("minifies the Web Worker with keep_names disabled and bundling enabled", () => {
    const webTopLevel = readRepositoryFile("src/web/wrangler.toml").split(/^[ \t]*\[/m)[0]
    expect(webTopLevel.match(/^[ \t]*minify[ \t]*=.*$/gm)).toEqual(["minify = true"])
    expect(webTopLevel.match(/^[ \t]*keep_names[ \t]*=.*$/gm)).toEqual(["keep_names = false"])
    expect(webTopLevel).not.toMatch(/^[ \t]*no_bundle[ \t]*=[ \t]*true\b/m)
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
