import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { isBuiltin } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { lockedDependency, parsePnpmLock, projectDependencies } from "../../../scripts/ci/pnpm-lock.mjs"

const directory = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.dirname(directory)
const repositoryRoot = path.resolve(webRoot, "../..")
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const packageName = specifier => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")

// Follow the gallery's local imports rather than hashing all Web source or the
// whole workspace lock. External packages retain their complete locked closure.
export function sourceInputs(initialFiles) {
  const files = new Set(), roots = new Map()
  const config = ts.readConfigFile(path.join(webRoot, "tsconfig.json"), ts.sys.readFile)
  if (config.error) throw new Error("Cannot read capture TypeScript configuration")
  const { options, errors } = ts.parseJsonConfigFileContent(config.config, ts.sys, webRoot)
  if (errors.length) throw new Error("Cannot resolve capture TypeScript configuration")
  const lock = parsePnpmLock(readFileSync(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8"))
  function external(name, owner) {
    let current = path.dirname(owner)
    while (current.startsWith(repositoryRoot)) {
      const importer = path.relative(repositoryRoot, current).split(path.sep).join("/") || "."
      if (lock.importers.has(importer)) {
        const dependency = lockedDependency(lock, importer, name)
        if (!dependency.version.startsWith("link:")) roots.set(`${importer}:${name}`, { importer, name })
        return dependency
      }
      current = path.dirname(current)
    }
    throw new Error(`No workspace importer for ${owner}`)
  }
  function reference(specifier, owner) {
    if (isBuiltin(specifier) || /^(?:data:|https?:|#)/.test(specifier)) return
    const local = specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("/")
    if (!local) {
      const name = packageName(specifier)
      const dependency = external(name, owner)
      if (!dependency.version.startsWith("link:")) return
    }
    const resolved = ts.resolveModuleName(specifier, owner, options, ts.sys).resolvedModule?.resolvedFileName
      ?? (specifier.startsWith("/") ? path.join(directory, "public", specifier) : path.resolve(path.dirname(owner), specifier))
    if (!existsSync(resolved)) throw new Error(`Unresolved capture input: ${specifier} from ${path.relative(repositoryRoot, owner)}`)
    visit(resolved)
  }
  function visit(filename) {
    filename = realpathSync(filename)
    if (files.has(filename)) return
    files.add(filename)
    if (/\.[cm]?[jt]sx?$/.test(filename)) {
      const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true)
      function inspect(node) {
        if (ts.isImportDeclaration(node) && node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
          const bindings = node.importClause?.namedBindings
          if (bindings && ts.isNamedImports(bindings) && bindings.elements.length && bindings.elements.every(item => item.isTypeOnly) && !node.importClause.name) return
          reference(node.moduleSpecifier.text, filename)
        } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
          reference(node.moduleSpecifier.text, filename)
        } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require") && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
          reference(node.arguments[0].text, filename)
        }
        ts.forEachChild(node, inspect)
      }
      inspect(source)
    } else if (filename.endsWith(".css")) {
      const css = readFileSync(filename, "utf8")
      for (const match of css.matchAll(/@import\s+["']([^"']+)["']/g)) reference(match[1], filename)
      for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)) reference((match[1] ?? match[2] ?? match[3]).trim(), filename)
      // Tailwind's explicit package source directives also affect the output.
      for (const match of css.matchAll(/@source\s+["'][^"']*node_modules\/(@[^/]+\/[^/]+|[^/]+)\//g)) external(match[1], filename)
    }
  }
  for (const filename of initialFiles) visit(filename)
  return { files: [...files], roots: [...roots.values()] }
}

export function artworkInputHashes(files, roots, lockText = readFileSync(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8")) {
  const lock = parsePnpmLock(lockText)
  const projection = projectDependencies(lock, roots)
  const inputs = Object.fromEntries([...new Set([...files, fileURLToPath(import.meta.url), path.join(repositoryRoot, "scripts/ci/pnpm-lock.mjs")])].sort().map(filename => [
    path.relative(repositoryRoot, filename).split(path.sep).join("/"), hash(readFileSync(filename)),
  ]))
  inputs["renderer:pnpm-dependencies"] = hash(JSON.stringify(projection))
  for (const [key, record] of Object.entries(projection)) {
    if (key.startsWith("patch:")) {
      const patchPath = /^ {4}path: (.+)$/m.exec(record)?.[1]
      if (!patchPath) throw new Error(`Missing renderer patch file: ${key}`)
      inputs[patchPath] = hash(readFileSync(path.join(repositoryRoot, patchPath)))
    }
  }
  return inputs
}
