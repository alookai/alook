import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { createRequire } from "node:module"
import ts from "typescript"

export const LOCAL_WORKER_ENDPOINTS = Object.freeze({
  main: Object.freeze({
    port: 3001,
    inspectorPort: 9229,
    persistTo: ".wrangler/state",
  }),
  blog: Object.freeze({
    port: 3002,
    inspectorPort: 9231,
    persistTo: "blog/.wrangler/state",
  }),
})

export function wranglerDevArgs(configPaths, endpoint) {
  const configs = Array.isArray(configPaths) ? configPaths : [configPaths]
  return [
    "dev",
    ...configs.flatMap((configPath) => ["--config", configPath]),
    "--local",
    "--persist-to",
    endpoint.persistTo,
    "--ip",
    "127.0.0.1",
    "--port",
    String(endpoint.port),
    "--inspector-port",
    String(endpoint.inspectorPort),
    "--show-interactive-dev-session=false",
  ]
}

export function workerDevArgs(configPaths, endpoint) {
  return ["exec", "wrangler", ...wranglerDevArgs(configPaths, endpoint)]
}

export function exactWorkerDevArgs(wranglerEntry, configPaths, endpoint) {
  return [wranglerEntry, ...wranglerDevArgs(configPaths, endpoint)]
}


export const PUBLIC_STATIC_RELEASES = Object.freeze(["N", "Nplus1"])

export function publicStaticParserIdentity() {
  const parserRequire = createRequire(resolve(process.cwd(), "package.json"))
  if (parserRequire("typescript") !== ts) throw new Error("Parser identity resolved a different TypeScript instance from the loaded parser")
  const path = realpathSync(parserRequire.resolve("typescript"))
  const bytes = readFileSync(path)
  return { version: ts.version, path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
}

function requireString(value, label, pattern) {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    throw new Error(`Invalid public static QA ${label}`)
  }
  return value
}

export function containedPath(root, path) {
  const target = resolve(root, path)
  const suffix = relative(root, target)
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error("Public static QA path escapes its owned root")
  }
  return target
}

export function canonicalPhasePath(path) {
  const absolute = resolve(path)
  if (existsSync(absolute)) return realpathSync(absolute)
  const parent = dirname(absolute)
  if (parent === absolute) throw new Error("Cannot resolve public static QA owned path")
  return resolve(canonicalPhasePath(parent), relative(parent, absolute))
}

function isWithin(root, path) {
  const suffix = relative(root, path)
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

export function assertPublicStaticWriteSeparation(manifest, mutablePaths) {
  const writes = [...mutablePaths, manifest.controlDirectory].map(canonicalPhasePath)
  for (const release of Object.values(manifest.releases)) {
    const root = canonicalPhasePath(release.root)
    if (writes.some(write => isWithin(write, root))) throw new Error("Release root is inside a mutable/reset area")
    for (const input of release.inputs) {
      const file = canonicalPhasePath(containedPath(root, input.path))
      if (writes.some(write => isWithin(write, file) || isWithin(file, write))) throw new Error("Bound release input intersects a mutable/reset area")
    }
    for (const output of ["src/web/.open-next", "src/web/.next", "src/web/public", "src/web/blog/.open-next", "src/web/blog/.next", "src/web/blog/public"]) {
      const sealed = canonicalPhasePath(resolve(root, output))
      if (writes.some(write => isWithin(sealed, write) || isWithin(write, sealed))) throw new Error("Mutable area intersects sealed release output")
    }
  }
}

export function validatePublicStaticManifest(value, ownedRoot) {
  if (!value || value.schema !== 1) throw new Error("Invalid public static QA manifest schema")
  const runId = requireString(value.runId, "run ID", /^[a-zA-Z0-9_-]{8,80}$/)
  const owner = canonicalPhasePath(ownedRoot)
  const controlDirectory = canonicalPhasePath(containedPath(resolve(ownedRoot), requireString(value.controlDirectory, "control directory")))
  containedPath(owner, controlDirectory)
  if (!PUBLIC_STATIC_RELEASES.includes(value.defaultRelease)) throw new Error("Invalid default QA release")
  if (!value.releases || Object.keys(value.releases).sort().join(",") !== "N,Nplus1") {
    throw new Error("Public static QA requires exactly N and Nplus1")
  }
  const releases = Object.fromEntries(PUBLIC_STATIC_RELEASES.map(name => {
    const release = value.releases[name]
    const root = requireString(release?.root, `${name} root`)
    if (!isAbsolute(root)) throw new Error("Release root must be absolute")
    requireString(release.head, `${name} head`, /^[0-9a-f]{40}$/)
    requireString(release.tree, `${name} tree`, /^[0-9a-f]{40}$/)
    requireString(release.swSha256, `${name} worker digest`, /^[0-9a-f]{64}$/)
    for (const field of ["mainBuildId", "blogBuildId"]) requireString(release[field], `${name} ${field}`, /^[a-zA-Z0-9_-]+$/)
    if (!Array.isArray(release.inputs) || release.inputs.length === 0) throw new Error("Release inputs are required")
    const paths = new Set()
    for (const input of release.inputs) {
      requireString(input.path, "input path")
      containedPath(root, input.path)
      if (isAbsolute(input.path) || paths.has(input.path)) throw new Error("Release input paths must be relative and unique")
      paths.add(input.path)
      requireString(input.sha256, "input digest", /^[0-9a-f]{64}$/)
      if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) throw new Error("Invalid release input byte count")
    }
    for (const path of ["src/web/wrangler.toml", "src/web/blog/wrangler.toml", "src/web/custom-worker.ts", "src/web/blog/custom-worker.ts", "src/web/.open-next/worker.js", "src/web/blog/.open-next/worker.js", "src/web/public/sw.js", "src/web/.open-next/assets/sw.js"]) {
      if (!paths.has(path)) throw new Error(`Missing required release input: ${path}`)
    }
    if (release.inputs.find(input => input.path === "src/web/public/sw.js").sha256 !== release.swSha256
      || release.inputs.find(input => input.path === "src/web/.open-next/assets/sw.js").sha256 !== release.swSha256) {
      throw new Error("Release SW inputs do not match its declared digest")
    }
    if (!Array.isArray(release.assets) || release.assets.length === 0) throw new Error("Release asset catalogue is required")
    const urls = new Set()
    for (const asset of release.assets) {
      if (typeof asset.url !== "string" || !asset.url.startsWith("/") || asset.url.startsWith("//") || /[?#]/.test(asset.url) || urls.has(asset.url)) throw new Error("Invalid or duplicate release asset URL")
      urls.add(asset.url)
      const input = release.inputs.find(input => input.path === asset.path)
      if (!input || asset.sha256 !== input.sha256 || asset.bytes !== input.bytes || !["main", "blog"].includes(asset.zone)) throw new Error("Asset is not bound to a release input")
      if (asset.kind !== undefined && !["code", "fonts", "images"].includes(asset.kind)) throw new Error("Invalid runtime asset kind")
      if (asset.precache !== undefined && typeof asset.precache !== "boolean") throw new Error("Invalid precache marker")
      if (asset.precache && asset.revision !== null && (typeof asset.revision !== "string" || !asset.revision)) throw new Error("A precache asset requires its actual emitted revision or null")
    }
    for (const [zone, buildId] of [["main", release.mainBuildId], ["blog", release.blogBuildId]]) {
      for (const helper of ["_buildManifest.js", "_clientMiddlewareManifest.js", "_ssgManifest.js"]) {
        if (!release.assets.some(asset => asset.zone === zone && asset.url === `${zone === "blog" ? "/blog-static" : ""}/_next/static/${buildId}/${helper}`)) throw new Error("Release catalogue is missing an actual build helper")
      }
    }
    return [name, { ...release, root: resolve(root) }]
  }))
  const manifest = { schema: 1, runId, controlDirectory, defaultRelease: value.defaultRelease, releases }
  assertPublicStaticWriteSeparation(manifest, [owner])
  return manifest
}

export function assertPublicStaticInputs(manifest) {
  for (const release of Object.values(manifest.releases)) {
    for (const input of release.inputs) {
      const path = containedPath(release.root, input.path)
      containedPath(realpathSync(release.root), realpathSync(path))
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== input.bytes
        || createHash("sha256").update(readFileSync(path)).digest("hex") !== input.sha256) {
        throw new Error(`Public static QA input changed: ${input.path}`)
      }
    }
    const emitted = builtPrecacheEntries(readFileSync(resolve(release.root, "src/web/public/sw.js"), "utf8"))
    const declared = release.assets.filter(asset => asset.precache).map(({ url, revision }) => ({ url, revision }))
    const normalized = entries => JSON.stringify(entries.toSorted((a, b) => a.url.localeCompare(b.url)))
    if (normalized(emitted) !== normalized(declared)) throw new Error("Release precache catalogue does not match its actual emitted worker entries")
  }
}

export function builtPrecacheEntries(source) {
  const fileName = "/frozen-public-worker.js"
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  if (ast.parseDiagnostics.length) throw new Error("Frozen worker has invalid JavaScript syntax")
  const options = { allowJs: true, noLib: true, noResolve: true, noEmit: true, target: ts.ScriptTarget.Latest }
  const host = { ...ts.createCompilerHost(options), getSourceFile: file => file === fileName ? ast : undefined, fileExists: file => file === fileName, readFile: file => file === fileName ? source : undefined }
  const checker = ts.createProgram([fileName], options, host).getTypeChecker()
  const nodes = []
  const visit = node => { nodes.push(node); ts.forEachChild(node, visit) }
  visit(ast)
  const nameOf = node => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined
  const candidates = nodes.filter(node => ts.isPropertyAssignment(node) && nameOf(node.name) === "precacheEntries" && ts.isNewExpression(node.parent.parent))
  if (candidates.length !== 1) throw new Error("Frozen worker must expose exactly one unambiguous precache constructor input")
  const fail = () => { throw new Error("Frozen precache input is not an unambiguous static array binding") }
  const statement = node => {
    let current = node
    while (current && !ts.isStatement(current)) current = current.parent
    return current
  }
  const directAssignment = node => {
    let current = node
    while (current.parent && !ts.isExpressionStatement(current.parent)) {
      const parent = current.parent
      if (!ts.isParenthesizedExpression(parent) && !(ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.CommaToken)) return false
      current = parent
    }
    return ts.isExpressionStatement(current.parent)
  }
  const linearScope = scope => {
    if (!scope) return false
    if (ts.isSourceFile(scope)) return true
    if (!ts.isBlock(scope) || (!ts.isArrowFunction(scope.parent) && !ts.isFunctionExpression(scope.parent))) return false
    if (scope.parent.asteriskToken || scope.parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false
    let expression = scope.parent
    while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent
    const call = expression.parent
    return ts.isCallExpression(call) && call.expression === expression && ts.isExpressionStatement(call.parent) && linearScope(call.parent.parent)
  }
  const candidate = candidates[0]
  const optionsObject = candidate.parent
  const optionNames = new Set()
  for (const property of optionsObject.properties) {
    if (!ts.isPropertyAssignment(property)) return fail()
    const name = nameOf(property.name)
    if (!name || optionNames.has(name)) return fail()
    optionNames.add(name)
  }
  const constructor = optionsObject.parent
  let consumer = constructor
  while (ts.isParenthesizedExpression(consumer.parent)) consumer = consumer.parent
  const parent = consumer.parent
  if (!(ts.isVariableDeclaration(parent) && parent.initializer === consumer) && !(ts.isExpressionStatement(parent) && parent.expression === consumer)) return fail()
  if (!linearScope(statement(consumer)?.parent)) return fail()
  const linearBefore = node => {
    const current = statement(node), scope = current?.parent
    if (!scope || (!ts.isSourceFile(scope) && !ts.isBlock(scope))) return false
    const index = scope.statements.indexOf(current)
    return index >= 0 && scope.statements.slice(0, index).every(value => ts.isVariableStatement(value) || ts.isExpressionStatement(value) || ts.isClassDeclaration(value) || ts.isFunctionDeclaration(value) || ts.isEmptyStatement(value))
  }
  if (!linearBefore(consumer)) return fail()
  if (nodes.some(node => ts.isWithStatement(node) || (ts.isIdentifier(node) && node.text === "eval"))) return fail()
  const symbolFor = node => ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node)
  const references = symbol => nodes.filter(node => ts.isIdentifier(node) && symbolFor(node) === symbol)
  const shape = root => {
    const names = new Map()
    const encode = node => {
      let value
      if (ts.isIdentifier(node)) { if (!names.has(node.text)) names.set(node.text, names.size); value = names.get(node.text) }
      else if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) value = node.text
      const children = []
      ts.forEachChild(node, child => { children.push(encode(child)) })
      return [node.kind, value, children]
    }
    return JSON.stringify(encode(root))
  }
  const template = ts.createSourceFile("initializer.js", "var init=(e,t,s)=>()=>{if(s)throw s[0];try{return e&&(t=e(e=0)),t}catch(r){throw s=[r],r}}", ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const initializerShape = shape(template.statements[0].declarationList.declarations[0].initializer)
  const emittedInitialization = (assignment, scope, use) => {
    const body = statement(assignment)?.parent, callback = body?.parent
    if (!body || !ts.isBlock(body) || body.statements.length !== 1 || !callback || !ts.isArrowFunction(callback) || callback.modifiers?.length || callback.parameters.length) return false
    const onlyStatement = body.statements[0]
    if (!ts.isExpressionStatement(onlyStatement)) return false
    let expression = onlyStatement.expression
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression
    if (expression !== assignment) return false
    const factoryCall = callback.parent
    if (!ts.isCallExpression(factoryCall) || factoryCall.arguments.length !== 1 || factoryCall.arguments[0] !== callback || !ts.isIdentifier(factoryCall.expression)) return false
    const initialized = factoryCall.parent
    if (!ts.isVariableDeclaration(initialized) || initialized.initializer !== factoryCall || !ts.isIdentifier(initialized.name) || statement(initialized)?.parent !== scope) return false
    const factorySymbol = symbolFor(factoryCall.expression), initSymbol = symbolFor(initialized.name)
    const factory = factorySymbol?.declarations?.length === 1 ? factorySymbol.declarations[0] : undefined
    if (!factory || !ts.isVariableDeclaration(factory) || !factory.initializer || factory.initializer.end >= factoryCall.pos || shape(factory.initializer) !== initializerShape || statement(factory)?.parent !== scope) return false
    if (!references(factorySymbol).every(node => node === factory.name || (ts.isCallExpression(node.parent) && node.parent.expression === node))) return false
    const calls = references(initSymbol).filter(node => node !== initialized.name)
    if (!calls.length || !calls.every(node => ts.isCallExpression(node.parent) && node.parent.expression === node && !node.parent.arguments.length)) return false
    return calls.some(node => node.pos > initialized.end && node.pos < use.pos && directAssignment(node.parent) && statement(node)?.parent === scope && linearBefore(node))
  }
  const arrayFor = (input, seen = new Set()) => {
    if (ts.isParenthesizedExpression(input)) return arrayFor(input.expression, seen)
    if (ts.isArrayLiteralExpression(input)) return input
    if (!ts.isIdentifier(input)) return fail()
    const symbol = symbolFor(input)
    if (!symbol || seen.has(symbol) || symbol.declarations?.length !== 1) return fail()
    const declaration = symbol.declarations[0]
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return fail()
    const scope = statement(declaration)?.parent
    if (!scope || ts.isSourceFile(scope) || scope !== statement(input)?.parent || !linearScope(scope)) return fail()
    const writes = declaration.initializer ? [{ value: declaration.initializer, position: declaration.pos }] : []
    for (const node of nodes) {
      if (!ts.isIdentifier(node) || symbolFor(node) !== symbol || node === input || node === declaration.name) continue
      const parent = node.parent
      if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && directAssignment(parent)
        && (statement(parent)?.parent === scope || emittedInitialization(parent, scope, input))) writes.push({ value: parent.right, position: parent.pos })
      else return fail()
    }
    if (writes.length !== 1 || writes[0].position >= input.pos) return fail()
    return arrayFor(writes[0].value, new Set([...seen, symbol]))
  }
  const array = arrayFor(candidate.initializer)
  const entries = array.elements.map(element => {
    if (!ts.isObjectLiteralExpression(element)) return fail()
    const fields = new Map()
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property)) return fail()
      const name = nameOf(property.name)
      if (!name || !["url", "revision", "integrity"].includes(name) || fields.has(name)) return fail()
      fields.set(name, property.initializer)
    }
    const url = fields.get("url"), revision = fields.get("revision")
    if (!url || !ts.isStringLiteral(url) || !url.text || !revision || (revision.kind !== ts.SyntaxKind.NullKeyword && !ts.isStringLiteral(revision))) return fail()
    if (fields.has("integrity") && !ts.isStringLiteral(fields.get("integrity"))) return fail()
    return { url: url.text, revision: revision.kind === ts.SyntaxKind.NullKeyword ? null : revision.text }
  })
  if (!entries.length || new Set(entries.map(entry => entry.url)).size !== entries.length) return fail()
  return entries
}

export function readPublicStaticManifest(path, ownedRoot, verify = true) {
  const bytes = readFileSync(path)
  const manifest = validatePublicStaticManifest(JSON.parse(bytes.toString("utf8")), ownedRoot)
  if (verify) assertPublicStaticInputs(manifest)
  return { ...manifest, digest: createHash("sha256").update(bytes).digest("hex") }
}

export function writePhaseFile(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export function readPhaseFile(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null
}

export function validatePhaseCommand(command, manifest, receipt, now = Date.now()) {
  if (!command || command.runId !== manifest.runId || command.manifestDigest !== manifest.digest
    || !Number.isSafeInteger(command.sequence) || command.sequence !== receipt.sequence + 1
    || command.from !== receipt.release || !PUBLIC_STATIC_RELEASES.includes(command.to)
    || !["switch", "release"].includes(command.action) || typeof command.caseId !== "string" || !command.caseId
    || (receipt.caseId !== undefined && command.caseId !== receipt.caseId)
    || (command.action === "switch" && command.to === command.from)
    || (command.action === "release" && (receipt.caseId !== command.caseId || command.to !== command.from || command.to !== manifest.defaultRelease))
    || !Number.isSafeInteger(command.deadline) || command.deadline <= now || command.deadline - now > 60_000
    || receipt.status !== "ready") throw new Error("Invalid, expired or foreign public static QA phase command")
  return command
}

export function phaseCommandDigest(command) {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex")
}

export function phaseWorkerDefinitions(manifest, releaseName, wranglerEntry, runtimeRoot) {
  if (!PUBLIC_STATIC_RELEASES.includes(releaseName)) throw new Error("Unknown public static QA release")
  const release = manifest.releases[releaseName]
  return ["main", "blog"].map(zone => ({
    label: zone === "main" ? "main backend" : "Blog backend",
    command: process.execPath,
    args: exactWorkerDevArgs(wranglerEntry,
      [resolve(release.root, zone === "main" ? "src/web/wrangler.toml" : "src/web/blog/wrangler.toml")],
      { ...LOCAL_WORKER_ENDPOINTS[zone], persistTo: resolve(runtimeRoot, zone === "main" ? "src/web/.wrangler/state" : "src/web/blog/.wrangler/state") }),
  }))
}
