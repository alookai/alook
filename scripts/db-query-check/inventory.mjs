import { readdirSync, existsSync } from 'node:fs'
import { relative, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const backendRoots = ['src/shared/src', 'src/web/src', 'src/web/auth', 'src/ws-do/src', 'src/email-worker/src', 'src/queue-worker/src', 'src/daemon/src', 'src/app/src']
const operations = new Set(['select', 'selectDistinct', 'insert', 'update', 'delete', 'prepare', 'exec', 'execute', 'run', 'all', 'get', 'findFirst', 'findMany'])

export function productionFile(file) {
  return !/(?:^|\/)(?:node_modules|dist|test|tests|__tests__|test-runtime|test-integration|e2e|e2e-ui|__mocks__|fixtures)(?:\/|$)|\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(file)
}

export function backendFiles(root, includeFixtures = false) {
  function walk(directory) {
    if (!existsSync(directory)) return []
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = resolve(directory, entry.name)
      const path = relative(root, file).replaceAll('\\', '/')
      if (includeFixtures ? /(?:^|\/)(?:node_modules|dist|\.git)(?:\/|$)|\.d\.[cm]?[jt]s$/.test(path) : !productionFile(path)) return []
      return entry.isDirectory() ? walk(file) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : []
    })
  }
  return [...new Set([...backendRoots, ...(includeFixtures ? ['src/shared/test'] : [])].flatMap(directory => walk(resolve(root, directory))))].sort()
}

function enclosingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) return parent.name?.getText() ?? '<anonymous>'
    if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText()
  }
  return '<module>'
}

export function inventoryQueries(root, override, { includeFixtures = false } = {}) {
  const files = override ? Object.keys(override).map(file => resolve(root, file)) : backendFiles(root, includeFixtures)
  const host = ts.createCompilerHost({})
  if (override) {
    const original = host.readFile
    host.readFile = file => override[relative(root, file).replaceAll('\\', '/')] ?? original(file)
  }
  const workerTypes = resolve(root, 'src/shared/node_modules/@cloudflare/workers-types/index.d.ts')
  const program = ts.createProgram(existsSync(workerTypes) ? [...files, workerTypes] : files, { allowJs: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, baseUrl: root, paths: { '@/*': ['src/web/src/*'], '@cloudflare/workers-types': ['src/shared/node_modules/@cloudflare/workers-types/index.ts'] } }, host)
  const checker = program.getTypeChecker()
  const sites = []
  const fixtureSites = []
  const ordinals = new Map()
  for (const file of files) {
    const source = program.getSourceFile(file)
    if (!source) continue
    const path = relative(root, file).replaceAll('\\', '/')
    const fixture = !productionFile(path)
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && operations.has(node.expression.name.text)) {
        const method = node.expression.name.text
        if (fixture && (!includeFixtures || !['select', 'selectDistinct', 'insert', 'update', 'delete', 'prepare'].includes(method))) return ts.forEachChild(node, visit)
        const receiver = node.expression.expression
        const fluentTerminal = ['all', 'get', 'run', 'execute'].includes(method) && ts.isCallExpression(receiver)
        const declarations = fluentTerminal ? [] : checker.getPropertyOfType(checker.getTypeAtLocation(receiver), method)?.declarations ?? []
        const declarationFiles = declarations.map(item => item.getSourceFile().fileName.replaceAll('\\', '/'))
        const isWorkerSql = declarations.some((declaration, index) => declarationFiles[index].includes('@cloudflare/workers-types/') && /^(?:D1Database|D1DatabaseSession|D1PreparedStatement|SqlStorage)$/.test(declaration.parent?.name?.getText() ?? ''))
        const isDb = isWorkerSql || declarationFiles.some(path => /(?:drizzle-orm|better-sqlite3|@types\/node\/sqlite)/.test(path))
        const unknown = !declarations.length
        let fixtureProof
        if (fixture && isDb) {
          if (method === 'prepare' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) fixtureProof = 'literal-sql'
          else if (method !== 'prepare' && declarationFiles.some(path => path.includes('drizzle-orm/'))) fixtureProof = 'orm-builder'
        }
        if ((fixture ? fixtureProof : isDb || unknown) && !fluentTerminal) {
          let chain = node
          while (chain.parent && (ts.isPropertyAccessExpression(chain.parent) || ts.isCallExpression(chain.parent) && chain.parent.expression === chain)) chain = chain.parent
          let builder = node
          while (ts.isPropertyAccessExpression(builder.parent) && ts.isCallExpression(builder.parent.parent) && builder.parent.parent.expression === builder.parent) {
            if (['all', 'get', 'run', 'execute', 'then', 'catch', 'finally'].includes(builder.parent.name.text)) break
            builder = builder.parent.parent
          }
          const functionName = enclosingFunction(node)
          const prefix = `${path}:${functionName}:${method}`
          const ordinal = (ordinals.get(prefix) ?? 0) + 1
          ordinals.set(prefix, ordinal)
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          const endLine = source.getLineAndCharacterOfPosition(chain.getEnd()).line + 1
          const site = { key: `${prefix}:${ordinal}`, file: path, functionName, method, line, endLine, start: node.getStart(), builderEnd: builder.getEnd(), resolution: isDb ? 'database-type' : 'unresolved-receiver', instrumentation: ts.isOptionalChain(builder) ? 'optional-chain-unverified' : 'construction' }
          if (fixture) fixtureSites.push({ ...site, kind: 'test-fixture', proof: fixtureProof, literalSql: fixtureProof === 'literal-sql' ? node.arguments[0].text : undefined })
          else sites.push(site)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { filesScanned: files.filter(file => productionFile(relative(root, file).replaceAll('\\', '/'))).length, sites, fixtureSites }
}

export function sourceFrames(root, stack) {
  const frames = []
  const windows = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\')
  for (const match of stack.matchAll(/\(?((?:file:\/\/\/|[A-Za-z]:[\\/]|\/)[^()\n]+?):(\d+):(\d+)\)?/g)) {
    let file = match[1]
    if (file.startsWith('file:')) {
      try { file = fileURLToPath(file, { windows }) } catch { continue }
    }
    file = (windows ? win32.relative(root, file) : relative(root, file)).replaceAll('\\', '/')
    if (backendRoots.some(directory => file.startsWith(`${directory}/`)) && productionFile(file)) frames.push({ file, line: Number(match[2]), column: Number(match[3]) })
  }
  return frames
}
