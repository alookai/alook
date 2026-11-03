import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { basename, dirname, relative, resolve, sep } from "node:path"
import ts from "typescript"

type Alias = { duplicate: string; canonical: string }

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression
  return expression
}

function hasWrapperCapture(node: ts.Node, ownsContext = false, parent?: ts.Node): boolean {
  if (node.kind === ts.SyntaxKind.ThisKeyword && !ownsContext) return true
  if (ts.isIdentifier(node)) {
    const isProperty = parent && ((ts.isPropertyAccessExpression(parent) && parent.name === node)
      || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isGetAccessor(parent)
        || ts.isSetAccessor(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node))
    if (!isProperty && ["module", "exports", "require", "__filename", "__dirname", "eval"].includes(node.text)) return true
    if (node.text === "arguments" && !ownsContext) return true
  }
  const ownsChildContext = ownsContext || (ts.isFunctionLike(node) && !ts.isArrowFunction(node))
    || ts.isPropertyDeclaration(node) || ts.isClassStaticBlockDeclaration(node)
  return ts.forEachChild(node, child => hasWrapperCapture(child,
    ts.isComputedPropertyName(child) ? ownsContext : ownsChildContext, node) || undefined) ?? false
}

function isFactoryArray(array: ts.ArrayLiteralExpression): boolean {
  let index = 0
  if (array.elements[0] && ts.isArrayLiteralExpression(array.elements[0])) {
    if (!isFactoryArray(array.elements[0])) return false
    index++
  }
  while (index < array.elements.length) {
    const start = index
    while (index < array.elements.length && (ts.isNumericLiteral(array.elements[index]) || ts.isStringLiteral(array.elements[index]))) index++
    const factory = array.elements[index]
    if (index === start || !factory || !ts.isArrowFunction(factory) || hasWrapperCapture(factory)) return false
    index++
  }
  return array.elements.length > 0
}

function staticFactoryAssignment(statements: readonly ts.Statement[]): ts.ArrayLiteralExpression | undefined {
  const body = statements.filter(statement => !(ts.isExpressionStatement(statement)
    && ts.isStringLiteral(statement.expression) && statement.expression.text === "use strict"))
  if (body.length !== 1 || !ts.isExpressionStatement(body[0])) return
  const expression = unwrap(body[0].expression)
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return
  const left = expression.left
  if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.expression)
    || left.expression.text !== "module" || left.name.text !== "exports" || !ts.isArrayLiteralExpression(expression.right)) return
  return expression.right
}

function isStaticFactoryChunk(code: string, filename: string): boolean {
  const parsed = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  if ((parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return false
  let array = staticFactoryAssignment(parsed.statements)
  if (!array && parsed.statements.length === 1 && ts.isExpressionStatement(parsed.statements[0])) {
    const call = unwrap(parsed.statements[0].expression)
    if (!ts.isCallExpression(call) || call.arguments.length) return false
    const factory = unwrap(call.expression)
    if (!ts.isArrowFunction(factory) || factory.parameters.length || factory.modifiers?.length || !ts.isBlock(factory.body)) return false
    array = staticFactoryAssignment(factory.body.statements)
  }
  return !!array && isFactoryArray(array)
}

function filesIn(directory: string): string[] {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return []
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap(entry => entry.isDirectory() ? filesIn(resolve(directory, entry.name))
      : entry.isFile() ? [resolve(directory, entry.name)] : [])
}

function executableChunk(source: string, filename: string): string | undefined {
  const marker = "\n//# sourceMappingURL="
  const offset = source.lastIndexOf(marker)
  const code = offset >= 0 && source.slice(offset + marker.length).trimEnd() === `${basename(filename)}.map`
    ? source.slice(0, offset) : source
  if (!code.includes("module.exports")) return
  if (!isStaticFactoryChunk(code, filename)) return
  return code
}

function traceUpdates(nextRoot: string, aliases: Alias[]): Map<string, string> {
  const aliasesBySource = new Map(aliases.map(alias => [alias.duplicate, alias.canonical]))
  const changes = new Map<string, string>()
  const traces = filesIn(resolve(nextRoot, "server")).filter(filename => filename.endsWith(".nft.json"))
  for (const name of readdirSync(nextRoot)) {
    const filename = resolve(nextRoot, name)
    if (name.endsWith(".nft.json") && lstatSync(filename).isFile()) traces.push(filename)
  }
  for (const filename of traces) {
    const trace = JSON.parse(readFileSync(filename, "utf8")) as { files?: unknown }
    if (!Array.isArray(trace.files) || !trace.files.every((file): file is string => typeof file === "string")) {
      throw new Error(`Invalid Next file trace: ${filename}`)
    }
    const files = new Set(trace.files)
    let changed = false
    for (const file of trace.files) {
      const canonical = aliasesBySource.get(resolve(dirname(filename), file))
      if (!canonical) continue
      const dependency = relative(dirname(filename), canonical).split(sep).join("/")
      if (!files.has(dependency)) {
        files.add(dependency)
        changed = true
      }
    }
    if (changed) changes.set(filename, JSON.stringify({ ...trace, files: [...files] }))
  }
  return changes
}

export function dedupeServerChunks(webRoot: string): { aliases: number; savedBytes: number; updatedTraces: number } {
  const nextRoot = resolve(webRoot, ".next")
  const standaloneNext = resolve(nextRoot, "standalone/src/web/.next")
  const chunksRoot = resolve(standaloneNext, "server/chunks")
  const canonicalByCode = new Map<string, string>()
  const writes = new Map<string, string>()
  const aliases: Alias[] = []
  let savedBytes = 0
  for (const filename of filesIn(chunksRoot)) {
    if (!filename.endsWith(".js")) continue
    const source = readFileSync(filename, "utf8")
    const code = executableChunk(source, filename)
    if (!code) continue
    const key = `${dirname(filename)}\0${code}`
    const canonical = canonicalByCode.get(key)
    if (!canonical) {
      canonicalByCode.set(key, filename)
      continue
    }
    const replacement = `module.exports = require(${JSON.stringify(`./${basename(canonical)}`)});\n`
    if (Buffer.byteLength(replacement) >= Buffer.byteLength(source)) continue
    writes.set(filename, replacement)
    savedBytes += Buffer.byteLength(source) - Buffer.byteLength(replacement)
    aliases.push({
      duplicate: resolve(nextRoot, relative(standaloneNext, filename)),
      canonical: resolve(nextRoot, relative(standaloneNext, canonical)),
    })
  }
  const traces = aliases.length ? traceUpdates(nextRoot, aliases) : new Map<string, string>()
  for (const [filename, source] of writes) writeFileSync(filename, source)
  for (const [filename, source] of traces) writeFileSync(filename, source)
  return { aliases: aliases.length, savedBytes, updatedTraces: traces.size }
}
