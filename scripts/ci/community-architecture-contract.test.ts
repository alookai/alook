import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, relative, resolve, sep } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

type DependencyKind = "static" | "dynamic" | "type"

type ModuleDependency = {
  kind: DependencyKind
  specifier: string
}

type ModuleEdge = {
  kind: DependencyKind
  target: string
}

type CyclicComponent = {
  nodes: string[]
  edges: string[]
}

const repositoryRoot = resolve(import.meta.dirname, "../..")
const webSourceRoot = resolve(repositoryRoot, "src/web/src")
const communityComponentRoot = resolve(webSourceRoot, "components/community")
const guardedLayerRoots = [
  resolve(webSourceRoot, "lib/community"),
  resolve(webSourceRoot, "hooks/community"),
  resolve(webSourceRoot, "stores/community"),
]
const communityModuleRoots = [communityComponentRoot, ...guardedLayerRoots]
const sourceExtensionPattern = /\.(?:ts|tsx)$/
const testFilePattern = /\.(?:test|spec)\.(?:ts|tsx)$/
const testDirectoryPattern = /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)/

function toPosixPath(path: string) {
  return path.split(sep).join("/")
}

function toRepositoryPath(path: string) {
  return toPosixPath(relative(repositoryRoot, path))
}

function isWithin(path: string, root: string) {
  const child = relative(root, path)
  return child === "" || (!child.startsWith("..") && !child.startsWith(sep))
}

function isProductionSource(path: string) {
  const normalized = toPosixPath(path)
  return (
    sourceExtensionPattern.test(normalized) &&
    !testFilePattern.test(normalized) &&
    !testDirectoryPattern.test(normalized) &&
    !normalized.endsWith("/test-harness.ts")
  )
}

function listProductionSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(root, entry.name)
      return entry.isDirectory() ? listProductionSources(path) : isProductionSource(path) ? [path] : []
    })
    .sort()
}

function stringLiteralText(node: ts.Node | undefined) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null
}

function importDeclarationKind(node: ts.ImportDeclaration): DependencyKind {
  const clause = node.importClause
  if (clause?.isTypeOnly) return "type"
  if (
    clause &&
    !clause.name &&
    clause.namedBindings &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  ) return "type"
  return "static"
}

function exportDeclarationKind(node: ts.ExportDeclaration): DependencyKind {
  if (node.isTypeOnly) return "type"
  if (
    node.exportClause &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  ) return "type"
  return "static"
}

function collectModuleDependencies(source: string) {
  const sourceFile = ts.createSourceFile("contract.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const dependencies: ModuleDependency[] = []

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier)
      if (specifier) {
        dependencies.push({ kind: importDeclarationKind(node), specifier })
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier)
      if (specifier) {
        dependencies.push({ kind: exportDeclarationKind(node), specifier })
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = stringLiteralText(node.moduleReference.expression)
      if (specifier) {
        dependencies.push({ kind: node.isTypeOnly ? "type" : "static", specifier })
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = stringLiteralText(node.argument.literal)
      if (specifier) {
        dependencies.push({ kind: "type", specifier })
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = stringLiteralText(node.arguments[0])
      if (specifier) {
        dependencies.push({ kind: "dynamic", specifier })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return dependencies
}

function resolveModule(importer: string, specifier: string, sourceRoot: string) {
  let unresolved: string
  if (specifier.startsWith("@/")) {
    unresolved = resolve(sourceRoot, specifier.slice(2))
  } else if (specifier.startsWith(".")) {
    unresolved = resolve(dirname(importer), specifier)
  } else {
    return null
  }

  if (!isWithin(unresolved, sourceRoot)) {
    return null
  }

  const withoutRuntimeExtension = unresolved.replace(/\.(?:js|jsx|mjs|cjs)$/, "")
  const candidates = [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    withoutRuntimeExtension,
    `${withoutRuntimeExtension}.ts`,
    `${withoutRuntimeExtension}.tsx`,
    resolve(unresolved, "index.ts"),
    resolve(unresolved, "index.tsx"),
  ]

  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

function readDependencies(path: string, sourceRoot = webSourceRoot) {
  return collectModuleDependencies(readFileSync(path, "utf8"))
    .map((dependency) => ({
      ...dependency,
      target: resolveModule(path, dependency.specifier, sourceRoot),
    }))
    .filter((dependency): dependency is ModuleDependency & { target: string } => Boolean(dependency.target))
}

function collectReverseDependencies(
  layerRoots = guardedLayerRoots,
  componentRoot = communityComponentRoot,
  sourceRoot = webSourceRoot,
) {
  const edges = layerRoots.flatMap((root) =>
    listProductionSources(root).flatMap((source) =>
      readDependencies(source, sourceRoot)
        .filter((dependency) => isWithin(dependency.target, componentRoot))
        .map((dependency) => `${dependency.kind} | ${toRepositoryPath(source)} -> ${toRepositoryPath(dependency.target)}`),
    ),
  )
  return [...new Set(edges)].sort()
}

function buildModuleGraph(
  roots: string[],
  sourceRoot: string,
  includedKinds: ReadonlySet<DependencyKind> = new Set(["static", "dynamic", "type"]),
) {
  const sources = roots.flatMap(listProductionSources)
  const sourceSet = new Set(sources)
  return new Map(
    sources.map((source) => [
      toRepositoryPath(source),
      [...new Map(
        readDependencies(source, sourceRoot)
          .filter((dependency) => includedKinds.has(dependency.kind) && sourceSet.has(dependency.target))
          .map((dependency) => {
            const edge = { kind: dependency.kind, target: toRepositoryPath(dependency.target) }
            return [`${edge.kind}:${edge.target}`, edge] as const
          }),
      ).values()].sort((left, right) =>
        `${left.kind}:${left.target}`.localeCompare(`${right.kind}:${right.target}`),
      ),
    ]),
  )
}

function collectCyclicComponents(graph: ReadonlyMap<string, readonly ModuleEdge[]>) {
  let nextIndex = 0
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: CyclicComponent[] = []

  function visit(node: string) {
    indices.set(node, nextIndex)
    lowLinks.set(node, nextIndex)
    nextIndex += 1
    stack.push(node)
    onStack.add(node)

    for (const edge of graph.get(node) ?? []) {
      if (!indices.has(edge.target)) {
        visit(edge.target)
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(edge.target)!))
      } else if (onStack.has(edge.target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(edge.target)!))
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return

    const nodes: string[] = []
    let member: string
    do {
      member = stack.pop()!
      onStack.delete(member)
      nodes.push(member)
    } while (member !== node)
    nodes.sort()

    const nodeSet = new Set(nodes)
    const hasSelfLoop = nodes.some((source) =>
      (graph.get(source) ?? []).some((edge) => edge.target === source),
    )
    const edges = nodes.flatMap((source) =>
      (graph.get(source) ?? [])
        .filter((edge) => nodeSet.has(edge.target))
        .map((edge) => `${source} -[${edge.kind}]-> ${edge.target}`),
    ).sort()
    if (nodes.length > 1 || hasSelfLoop) {
      components.push({ nodes, edges })
    }
  }

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) {
      visit(node)
    }
  }

  return components.sort((left, right) => left.nodes.join("\n").localeCompare(right.nodes.join("\n")))
}

const allowedReverseDependencies: string[] = []
const allowedFullDependencyComponents: CyclicComponent[] = []
const allowedRuntimeDependencyComponents: CyclicComponent[] = []

describe("community architecture contract", () => {
  it("recognizes every supported module dependency syntax", () => {
    expect(
      collectModuleDependencies(`
        import value from "@/components/community/value"
        import type { Model } from "@/components/community/model"
        export { view } from "@/components/community/view"
        export type { Model as ExportedModel } from "@/components/community/export-model"
        type LazyModel = import("@/components/community/lazy-model").LazyModel
        const lazy = import("@/components/community/lazy")
      `),
    ).toEqual([
      { kind: "static", specifier: "@/components/community/value" },
      { kind: "type", specifier: "@/components/community/model" },
      { kind: "static", specifier: "@/components/community/view" },
      { kind: "type", specifier: "@/components/community/export-model" },
      { kind: "type", specifier: "@/components/community/lazy-model" },
      { kind: "dynamic", specifier: "@/components/community/lazy" },
    ])
  })

  it("detects dynamic cycles and changes the signature when a chord is added", () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "community-architecture-"))
    try {
      writeFileSync(resolve(fixtureRoot, "a.ts"), 'import "./b"\n')
      writeFileSync(resolve(fixtureRoot, "b.ts"), 'export { value } from "@/c"\n')
      writeFileSync(resolve(fixtureRoot, "c.ts"), 'void import("./a")\nexport const value = 1\n')

      const a = toRepositoryPath(resolve(fixtureRoot, "a.ts"))
      const b = toRepositoryPath(resolve(fixtureRoot, "b.ts"))
      const c = toRepositoryPath(resolve(fixtureRoot, "c.ts"))
      const withoutChord = collectCyclicComponents(buildModuleGraph([fixtureRoot], fixtureRoot))
      expect(withoutChord).toEqual([{
        nodes: [a, b, c],
        edges: [
          `${a} -[static]-> ${b}`,
          `${b} -[static]-> ${c}`,
          `${c} -[dynamic]-> ${a}`,
        ].sort(),
      }])

      writeFileSync(resolve(fixtureRoot, "a.ts"), 'import "./b"\nvoid import("./c")\n')
      const withChord = collectCyclicComponents(buildModuleGraph([fixtureRoot], fixtureRoot))
      expect(withChord).toEqual([{
        nodes: [a, b, c],
        edges: [
          `${a} -[dynamic]-> ${c}`,
          `${a} -[static]-> ${b}`,
          `${b} -[static]-> ${c}`,
          `${c} -[dynamic]-> ${a}`,
        ].sort(),
      }])
      expect(withChord).not.toEqual(withoutChord)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it("changes the reverse-edge signature when a type import becomes runtime", () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "community-reverse-edge-"))
    const components = resolve(fixtureRoot, "components/community")
    const hooks = resolve(fixtureRoot, "hooks/community")
    try {
      mkdirSync(components, { recursive: true })
      mkdirSync(hooks, { recursive: true })
      const target = resolve(components, "model.ts")
      const importer = resolve(hooks, "use-model.ts")
      writeFileSync(target, "export type Model = { id: string }\nexport const value = 1\n")
      writeFileSync(importer, 'import type { Model } from "@/components/community/model"\nexport type Result = Model\n')

      const typeOnly = collectReverseDependencies([hooks], components, fixtureRoot)
      expect(typeOnly).toEqual([
        `type | ${toRepositoryPath(importer)} -> ${toRepositoryPath(target)}`,
      ])

      writeFileSync(importer, 'import { value } from "@/components/community/model"\nexport const result = value\n')
      const runtime = collectReverseDependencies([hooks], components, fixtureRoot)
      expect(runtime).toEqual([
        `static | ${toRepositoryPath(importer)} -> ${toRepositoryPath(target)}`,
      ])
      expect(runtime).not.toEqual(typeOnly)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it("does not add lower-layer imports from community components", () => {
    expect(collectReverseDependencies()).toEqual(allowedReverseDependencies)
  })

  it("does not add production community dependency cycles", () => {
    expect(collectCyclicComponents(buildModuleGraph(communityModuleRoots, webSourceRoot))).toEqual(
      allowedFullDependencyComponents,
    )
  })

  it("does not add production community runtime dependency cycles", () => {
    expect(
      collectCyclicComponents(
        buildModuleGraph(communityModuleRoots, webSourceRoot, new Set(["static", "dynamic"])),
      ),
    ).toEqual(allowedRuntimeDependencyComponents)
  })
})
