import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { toId, storyNameFromExport } from "storybook/internal/csf"

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const root = path.resolve(workspace, "../..")
const roots = ["src/web/src/components", "src/web/src/app", "src/web/blog/src/components", "src/web/blog/src/app"]
const mappingsPath = path.join(workspace, "catalog/mappings.json")
const mappings = JSON.parse(fs.readFileSync(mappingsPath, "utf8"))
const list = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? list(path.join(directory, entry.name)) : [path.join(directory, entry.name)])
const relative = (file) => path.relative(root, file).split(path.sep).join("/")
const unwrap = (node) => node && (ts.isSatisfiesExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) ? unwrap(node.expression) : node
const exported = (node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
const parse = (file) => {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  if (source.parseDiagnostics.length) throw new Error(`Invalid source syntax: ${relative(file)}`)
  return source
}
const stories = []
for (const file of list(path.join(workspace, "stories")).filter((file) => /\.stories\.tsx?$/.test(file)).sort()) {
  const source = parse(file)
  const objects = new Map()
  let meta
  for (const node of source.statements) {
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) objects.set(declaration.name.text, unwrap(declaration.initializer))
    if (ts.isExportAssignment(node)) meta = unwrap(node.expression)
  }
  if (meta && ts.isIdentifier(meta)) meta = objects.get(meta.text)
  const titleProperty = meta && ts.isObjectLiteralExpression(meta) ? meta.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "title") : undefined
  if (!titleProperty || !ts.isStringLiteral(titleProperty.initializer)) throw new Error(`A static story title is required: ${relative(file)}`)
  const title = titleProperty.initializer.text
  for (const node of source.statements) if (ts.isVariableStatement(node) && exported(node)) for (const declaration of node.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) continue
    const name = declaration.name.text
    stories.push({ id: toId(title, storyNameFromExport(name)), title, name: storyNameFromExport(name), source: relative(file) })
  }
}
const ids = new Set(stories.map((story) => story.id))
if (ids.size !== stories.length) throw new Error("Story IDs must be unique.")
const kinds = new Set(["direct", "composition", "nonvisual", "environment", "server-output", "pending", "blocked"])
const seenMappings = new Set()
const entries = roots.flatMap((directory) => list(path.join(root, directory))).filter((file) => file.endsWith(".tsx") && !/\.(?:test|spec|stories)\.tsx$/.test(file)).sort().map((file) => {
  const sourcePath = relative(file)
  const source = parse(file)
  const candidates = new Set()
  const visit = (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && /^[A-Z]/.test(node.name.text)) candidates.add(node.name.text)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^[A-Z][a-z]/.test(node.name.text)) candidates.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  const mapping = mappings[sourcePath]
  if (mapping) seenMappings.add(sourcePath)
  const exposure = mapping ?? { kind: "pending", examples: [], reason: "The isolated visual exposure still needs an explicit author mapping." }
  if (!kinds.has(exposure.kind)) throw new Error(`Unknown exposure kind: ${sourcePath}`)
  if (!exposure.reason || exposure.reason.length < 20) throw new Error(`Explain the exposure boundary: ${sourcePath}`)
  if (["direct", "composition"].includes(exposure.kind) && !exposure.examples?.length) throw new Error(`A story is required: ${sourcePath}`)
  for (const example of exposure.examples ?? []) {
    if (!ids.has(example.story)) throw new Error(`Unknown story ${example.story}: ${sourcePath}`)
    if (!example.region?.trim()) throw new Error(`Identify the actual composition region: ${sourcePath}`)
  }
  return { source: sourcePath, application: sourcePath.startsWith("src/web/blog/") ? "Blog" : "Web", candidates: [...candidates].sort(), ...exposure }
})
for (const source of Object.keys(mappings)) if (!seenMappings.has(source)) throw new Error(`Mapping refers to a removed source: ${source}`)
const summary = entries.reduce((counts, entry) => ({ ...counts, [entry.kind]: (counts[entry.kind] ?? 0) + 1 }), {})
const output = JSON.stringify({ boundary: "Declared source-to-story exposures and exclusions. Story registration and dependency scans are not evidence of rendering, interactions or complete runtime coverage.", roots, summary, entries, stories }, null, 2) + "\n"
const target = path.join(workspace, "catalog/catalog.json")
if (process.argv.includes("--check")) {
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== output) throw new Error("Catalog is stale. Run pnpm --filter @alook/storybook catalog.")
} else fs.writeFileSync(target, output)
console.log(JSON.stringify({ candidates: entries.length, stories: stories.length, summary, boundary: "source declarations only" }))
if (process.argv.includes("--complete") && entries.some((entry) => entry.kind === "pending" || entry.kind === "blocked")) throw new Error("The catalog still has pending or blocked visual exposures.")
