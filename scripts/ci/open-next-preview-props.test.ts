import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it } from "vitest"

interface ManifestUpdate {
  filter: RegExp
  contentFilter: RegExp
  callback: (context: { contents: string }) => Promise<string>
}

interface ManifestPlugin {
  inlineLoadManifest: (
    updater: { updateContent: (name: string, updates: ManifestUpdate[]) => void },
    options: { outputDir: string; monorepoRoot: string; appBuildOutputPath: string },
  ) => void
}

const repoRoot = resolve(import.meta.dirname, "../..")
const requireFromWeb = createRequire(resolve(repoRoot, "src/web/package.json"))
const cloudflareEntry = requireFromWeb.resolve("@opennextjs/cloudflare")
const pluginPath = resolve(dirname(cloudflareEntry), "../cli/build/patches/plugins/load-manifest.js")
const nextLoaderPath = requireFromWeb.resolve("next/dist/server/load-manifest.external.js")
const fixtureDirectories: string[] = []

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function createManifestReader(appPath = "src/web", includePreview = true) {
  const directory = mkdtempSync(join(tmpdir(), "alook-preview-props-"))
  fixtureDirectories.push(directory)
  const outputDir = join(directory, ".open-next")
  const dotNextDir = join(outputDir, "server-functions/default", appPath, ".next")
  mkdirSync(join(dotNextDir, "server"), { recursive: true })
  const previewProps = {
    previewModeId: `fixture-${appPath}`,
    previewModeSigningKey: "fixture-signing-value",
    previewModeEncryptionKey: "fixture-encryption-value",
  }
  if (includePreview) {
    writeFileSync(join(dotNextDir, "server/preview-props.json"), JSON.stringify(previewProps))
  }
  const prerenderManifest = { version: 4, routes: {}, dynamicRoutes: {} }
  writeFileSync(join(dotNextDir, "prerender-manifest.json"), JSON.stringify(prerenderManifest))
  writeFileSync(join(dotNextDir, "server/unrelated-build-data.json"), JSON.stringify({ value: "unrelated" }))

  const updates: ManifestUpdate[] = []
  const plugin = await import(pathToFileURL(pluginPath).href) as ManifestPlugin
  plugin.inlineLoadManifest({
    updateContent(_name, entries) {
      updates.push(...entries)
    },
  }, {
    outputDir,
    monorepoRoot: directory,
    appBuildOutputPath: join(directory, appPath),
  })
  const source = readFileSync(nextLoaderPath, "utf8")
  const update = updates.find((entry) => entry.filter.test(nextLoaderPath) && entry.contentFilter.test(source))
  if (!update) {
    throw new Error("Installed Next manifest loader does not match the adapter transformation")
  }
  const transformed = await update.callback({ contents: source })
  const manifestExports: Record<string, unknown> = {}
  const requireFromNext = createRequire(nextLoaderPath)
  runInNewContext(transformed, {
    exports: manifestExports,
    process: { env: { NEXT_BUILD_ID: "fixture-build" } },
    require(id: string): unknown {
      if (id === "fs" || id === "node:fs") {
        return {
          readFileSync() {
            throw new Error("Worker manifest loading must not read the runtime filesystem")
          },
        }
      }
      return requireFromNext(id) as unknown
    },
  })
  const loadManifest = manifestExports.loadManifest
  if (typeof loadManifest !== "function") throw new Error("Transformed loader has no loadManifest export")
  return {
    loadManifest: loadManifest as (path: string) => unknown,
    previewProps,
    prerenderManifest,
  }
}

describe("OpenNext required preview props", () => {
  it.each(["src/web", "src/web/blog"])("inlines the complete required preview data for %s", async (appPath) => {
    const { loadManifest, previewProps } = await createManifestReader(appPath)

    expect(loadManifest("/.next/server/preview-props.json")).toEqual(previewProps)
  })

  it("retains normal manifest payloads", async () => {
    const { loadManifest, prerenderManifest } = await createManifestReader()

    expect(loadManifest("/.next/prerender-manifest.json")).toEqual(prerenderManifest)
  })

  it("fails when the required preview file is missing", async () => {
    const { loadManifest } = await createManifestReader("src/web", false)

    expect(() => loadManifest("/.next/server/preview-props.json"))
      .toThrow("Unexpected loadManifest(/.next/server/preview-props.json) call!")
  })

  it("keeps an unknown file outside the manifest boundary", async () => {
    const { loadManifest } = await createManifestReader()

    expect(() => loadManifest("/.next/server/unrelated-build-data.json"))
      .toThrow("Unexpected loadManifest(/.next/server/unrelated-build-data.json) call!")
  })
})
