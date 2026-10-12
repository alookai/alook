import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { afterEach, describe, expect, it } from "vitest"

interface ContentUpdate {
  filter: RegExp
  contentFilter: RegExp
  callback: (context: { contents: string }) => Promise<string>
}

interface BuildOptions {
  outputDir: string
  monorepoRoot: string
  appBuildOutputPath: string
}

type PluginName = "patchNextServer" | "patchRouteModules"
type CachePlugin = Record<PluginName, (
  updater: { updateContent: (name: string, updates: ContentUpdate[]) => void },
  options: BuildOptions,
) => void>

interface RuntimeInput {
  fileName: string
  sourcePath: string
  pluginFile: string
  pluginName: PluginName
}

interface CacheOwner {
  loadCustomCacheHandlers: (...parameters: unknown[]) => Promise<void>
}

const repoRoot = resolve(import.meta.dirname, "../..")
const requireFromWeb = createRequire(resolve(repoRoot, "src/web/package.json"))
const cloudflareEntry = requireFromWeb.resolve("@opennextjs/cloudflare")
const pluginDirectory = resolve(dirname(cloudflareEntry), "../cli/build/patches/plugins")
const nativeServerPath = requireFromWeb.resolve("next/dist/server/next-server.js")
const runtimeDirectory = dirname(requireFromWeb.resolve("next/dist/compiled/next-server/app-route-turbo.runtime.prod.js"))
const nativeInput: RuntimeInput = {
  fileName: "next-server.js",
  sourcePath: nativeServerPath,
  pluginFile: "next-server.js",
  pluginName: "patchNextServer",
}
const compiledInputs: RuntimeInput[] = readdirSync(runtimeDirectory)
  .filter((name) => name.endsWith(".runtime.prod.js"))
  .sort()
  .map((fileName) => ({
    fileName,
    sourcePath: join(runtimeDirectory, fileName),
    pluginFile: "route-module.js",
    pluginName: "patchRouteModules",
  }))
const inputs = [nativeInput, ...compiledInputs]
const appRouteInput = compiledInputs.find((input) => input.fileName === "app-route-turbo.runtime.prod.js")
if (!appRouteInput) throw new Error("Installed Next has no app-route-turbo production runtime")
const errorInputs = [nativeInput, appRouteInput]
const appPaths = ["src/web", "src/web/blog"]
const fixtures: { directory: string; modulePath: string }[] = []
const handlersMapSymbol = Symbol.for("@next/cache-handlers-map")
const handlersSetSymbol = Symbol.for("@next/cache-handlers-set")

afterEach(() => {
  for (const { directory, modulePath } of fixtures.splice(0)) {
    delete requireFromWeb.cache[modulePath]
    rmSync(directory, { recursive: true, force: true })
  }
})

function cacheMethod(source: string, fileName: string) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS) as ts.SourceFile & {
    parseDiagnostics: readonly ts.Diagnostic[]
  }
  expect(sourceFile.parseDiagnostics).toHaveLength(0)
  const methods: ts.MethodDeclaration[] = []
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(sourceFile) === "loadCustomCacheHandlers") {
      methods.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  const [method] = methods
  if (methods.length !== 1 || !method?.body) {
    throw new Error("Expected one installed Next cache loader in " + fileName)
  }
  const body = method.body
  return {
    method,
    sourceFile,
    signature: source.slice(method.getStart(sourceFile), body.getStart(sourceFile)),
    body: body.getText(sourceFile),
  }
}

async function createCacheOwner(input: RuntimeInput, appPath: string, throwsOnLoad = false) {
  const directory = mkdtempSync(join(tmpdir(), "alook-composable-cache-"))
  const outputDir = join(directory, ".open-next")
  const modulePath = join(outputDir, "server-functions/default", appPath, "composable-cache.cjs")
  const fixture = { directory, modulePath }
  fixtures.push(fixture)
  mkdirSync(dirname(modulePath), { recursive: true })
  writeFileSync(modulePath, throwsOnLoad
    ? 'throw new Error("fixture handler startup failure")\n'
    : 'module.exports = { default: { marker: "fixture composable handler" } }\n')
  fixture.modulePath = realpathSync(modulePath)

  const updates: ContentUpdate[] = []
  const plugin = await import(pathToFileURL(join(pluginDirectory, input.pluginFile)).href) as Partial<CachePlugin>
  const registerPlugin = plugin[input.pluginName]
  if (!registerPlugin) throw new Error("Installed SDK has no requested cache updater")
  registerPlugin({
    updateContent(_name, entries) {
      updates.push(...entries)
    },
  }, {
    outputDir,
    monorepoRoot: directory,
    appBuildOutputPath: join(directory, appPath),
  })
  const source = readFileSync(input.sourcePath, "utf8")
  const original = cacheMethod(source, input.fileName)
  const matchingUpdates = updates.filter((update) => update.filter.test(input.sourcePath) && update.contentFilter.test(source))
  const [update] = matchingUpdates
  if (matchingUpdates.length !== 1 || !update) throw new Error("Installed cache loader does not match its real SDK updater")
  const transformed = await update.callback({ contents: source })
  const patched = cacheMethod(transformed, input.fileName)
  expect(patched.signature).toBe(original.signature)
  expect(patched.body).not.toContain("Object.entries")
  expect(patched.body).not.toContain("cacheMaxMemorySize")
  expect(patched.body).not.toContain("dynamicImport")

  const requireFromFixture = createRequire(join(directory, "fixture-entry.cjs"))
  const expectedModulePath = modulePath.replace(/\\/g, "/")
  const requestedModules: string[] = []
  let originalLoaderError: unknown
  const staleHandler = { marker: "stale handler" }
  const sandbox = {
    Symbol,
    Map,
    Set,
    require(id: string): unknown {
      requestedModules.push(id)
      if (id !== expectedModulePath) throw new Error("Unexpected composable handler module: " + id)
      try {
        return requireFromFixture(id) as unknown
      } catch (error) {
        originalLoaderError = error
        throw error
      }
    },
  }
  const runtime = runInNewContext(
    "({ Owner: class {" + patched.method.getText(patched.sourceFile) + "}, registry: globalThis })",
    sandbox,
  ) as { Owner: new () => CacheOwner; registry: object }
  Reflect.set(runtime.registry, handlersMapSymbol, new Map([["stale", staleHandler]]))
  Reflect.set(runtime.registry, handlersSetSymbol, new Set([staleHandler]))
  const owner = new runtime.Owner()
  expect(owner.loadCustomCacheHandlers).toHaveLength(original.method.parameters.length)
  return {
    owner,
    registry: runtime.registry,
    requestedModules,
    expectedModulePath,
    expectedHandler: throwsOnLoad ? undefined : (requireFromFixture(modulePath) as { default: unknown }).default,
    loaderError: () => originalLoaderError,
  }
}

describe("OpenNext composable cache loading", () => {
  it.each(appPaths.flatMap((appPath) => inputs.map((input) => ({ ...input, appPath }))))(
    "wires the actual $fileName loader for $appPath",
    async ({ appPath, ...input }) => {
      const { owner, registry, expectedHandler, requestedModules, expectedModulePath } = await createCacheOwner(input, appPath)

      await owner.loadCustomCacheHandlers({}, { cacheHandlers: {} })

      const handlers = Reflect.get(registry, handlersMapSymbol) as Map<string, unknown>
      const uniqueHandlers = Reflect.get(registry, handlersSetSymbol) as Set<unknown>
      expect(handlers).toBeInstanceOf(Map)
      expect([...handlers.keys()]).toEqual(["default", "remote"])
      expect(handlers.get("default")).toBe(expectedHandler)
      expect(handlers.get("remote")).toBe(expectedHandler)
      expect(uniqueHandlers).toBeInstanceOf(Set)
      expect([...uniqueHandlers]).toEqual([expectedHandler])
      expect(requestedModules).toEqual([expectedModulePath, expectedModulePath])
    },
  )

  it.each(appPaths.flatMap((appPath) => errorInputs.map((input) => ({ ...input, appPath }))))(
    "rejects the real static loader error in $fileName for $appPath",
    async ({ appPath, ...input }) => {
      const { owner, loaderError, requestedModules, expectedModulePath } = await createCacheOwner(input, appPath, true)

      const error: unknown = await owner.loadCustomCacheHandlers({}, { cacheHandlers: {} }).then(
        () => { throw new Error("Expected the static handler load to reject") },
        (reason: unknown) => reason,
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBe(loaderError())
      expect(error).toHaveProperty("message", "fixture handler startup failure")
      expect(requestedModules).toEqual([expectedModulePath])
    },
  )
})
