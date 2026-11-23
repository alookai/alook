import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { relative, resolve, sep } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

type RatchetFixture = {
  schemaVersion: number
  policy: string
  guardedRoots: string[]
  compatOverrides?: Record<string, string>
  maxEffectsByFile: Record<string, number>
}

const repositoryRoot = resolve(import.meta.dirname, "../..")
const fixturePath = resolve(import.meta.dirname, "fixtures/web-view-effect-ratchet.json")
const sourceExtensionPattern = /\.(?:ts|tsx)$/
const testFilePattern = /\.(?:test|spec)\.(?:ts|tsx)$/
const testDirectoryPattern = /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)/
const guardedEffectNames = new Set(["useEffect", "useLayoutEffect"])

function toPosixPath(path: string) {
  return path.split(sep).join("/")
}

function isProductionViewSource(path: string) {
  const normalized = toPosixPath(path)
  return (
    sourceExtensionPattern.test(normalized) &&
    !testFilePattern.test(normalized) &&
    !testDirectoryPattern.test(normalized) &&
    !normalized.endsWith("/test-harness.ts")
  )
}

function listProductionViewSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(root, entry.name)
      return entry.isDirectory()
        ? listProductionViewSources(path)
        : isProductionViewSource(path)
          ? [path]
          : []
    })
    .sort()
}

function countRawEffectsInSource(source: string, fileName = "view.tsx") {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind)
  let count = 0

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)
          ? node.expression.name.text
          : null
      if (name && guardedEffectNames.has(name)) {
        count += 1
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return count
}

function collectViewEffectCounts(roots: readonly string[], baseRoot = repositoryRoot) {
  const counts = new Map<string, number>()
  for (const root of roots) {
    for (const file of listProductionViewSources(root)) {
      const count = countRawEffectsInSource(readFileSync(file, "utf8"), file)
      if (count > 0) {
        counts.set(toPosixPath(relative(baseRoot, file)), count)
      }
    }
  }
  return counts
}

function validateViewEffectRatchet(
  actualCounts: ReadonlyMap<string, number>,
  baseline: Readonly<Record<string, number>>,
) {
  const violations: string[] = []
  const baselineKeys = Object.keys(baseline)
  const sortedKeys = [...baselineKeys].sort((left, right) => left.localeCompare(right))
  if (JSON.stringify(baselineKeys) !== JSON.stringify(sortedKeys)) {
    violations.push("web-view-effect-ratchet.json keys must remain sorted lexicographically.")
  }

  for (const [path, maxAllowed] of Object.entries(baseline)) {
    if (!Number.isInteger(maxAllowed) || maxAllowed <= 0) {
      violations.push(`Invalid baseline cap for ${path}: expected positive integer, received ${String(maxAllowed)}.`)
    }
  }

  for (const [path, actual] of [...actualCounts.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const allowed = baseline[path]
    if (allowed === undefined) {
      violations.push(
        `New view-layer raw useEffect/useLayoutEffect forbidden in ${path} (${actual} call${actual === 1 ? "" : "s"}). Move external-system synchronization into src/web/src/hooks/** or src/web/src/lib/**.`,
      )
    } else if (actual > allowed) {
      violations.push(
        `Raw useEffect/useLayoutEffect count increased in ${path}: actual=${actual}, allowed=${allowed}. Move new external-system synchronization into src/web/src/hooks/** or src/web/src/lib/**.`,
      )
    }
  }

  return violations
}

function loadRatchetFixture(): RatchetFixture {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as RatchetFixture
}

describe("web view-layer bare effect ratchet contract", () => {
  it("counts direct and member-expression useEffect/useLayoutEffect calls while ignoring comments, strings, and types", () => {
    const count = countRawEffectsInSource(`
      import * as React from "react"
      import { useEffect, useLayoutEffect } from "react"
      // useEffect(() => {}, [])
      /* useLayoutEffect(() => {}, []) */
      type EffectLike = typeof useEffect
      const note = "useEffect(() => {}, []) useLayoutEffect(() => {}, [])"
      export function Sample() {
        useEffect(() => {}, [])
        useLayoutEffect(() => {}, [])
        React.useEffect(() => {}, [])
        React.useLayoutEffect(() => {}, [])
        return <div>{note}</div>
      }
    `)
    expect(count).toBe(4)
  })

  it("ignores test files and rejects both new view files and count increases while permitting monotonic reductions", () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "web-view-effect-ratchet-"))
    const componentsDir = resolve(fixtureRoot, "src/web/src/components")
    const testDir = resolve(componentsDir, "__tests__")
    try {
      mkdirSync(testDir, { recursive: true })
      writeFileSync(
        resolve(componentsDir, "legacy.tsx"),
        `import { useEffect } from "react"\nexport function Legacy() { useEffect(() => {}, []); return null }\n`,
      )
      writeFileSync(
        resolve(componentsDir, "legacy.dom.test.tsx"),
        `import { useEffect } from "react"\nexport function TestHarness() { useEffect(() => {}, []); return null }\n`,
      )
      writeFileSync(
        resolve(testDir, "helper.tsx"),
        `import { useLayoutEffect } from "react"\nexport function Helper() { useLayoutEffect(() => {}, []); return null }\n`,
      )

      const counts = collectViewEffectCounts([componentsDir], fixtureRoot)
      expect([...counts.entries()]).toEqual([["src/web/src/components/legacy.tsx", 1]])

      // Exact match and monotonic shrink both pass.
      expect(validateViewEffectRatchet(counts, { "src/web/src/components/legacy.tsx": 1 })).toEqual([])
      expect(validateViewEffectRatchet(counts, { "src/web/src/components/legacy.tsx": 2 })).toEqual([])
      expect(validateViewEffectRatchet(new Map(), { "src/web/src/components/legacy.tsx": 1 })).toEqual([])

      // Increasing count in an allowlisted file fails.
      writeFileSync(
        resolve(componentsDir, "legacy.tsx"),
        `import { useEffect, useLayoutEffect } from "react"\nexport function Legacy() { useEffect(() => {}, []); useLayoutEffect(() => {}, []); return null }\n`,
      )
      const increased = collectViewEffectCounts([componentsDir], fixtureRoot)
      expect(validateViewEffectRatchet(increased, { "src/web/src/components/legacy.tsx": 1 })).toEqual([
        expect.stringContaining("count increased in src/web/src/components/legacy.tsx: actual=2, allowed=1"),
      ])

      // Adding a new view file with raw effect fails.
      writeFileSync(
        resolve(componentsDir, "new-card.tsx"),
        `import { useEffect } from "react"\nexport function NewCard() { useEffect(() => {}, []); return null }\n`,
      )
      const withNewFile = collectViewEffectCounts([componentsDir], fixtureRoot)
      expect(validateViewEffectRatchet(withNewFile, { "src/web/src/components/legacy.tsx": 2 })).toEqual([
        expect.stringContaining("New view-layer raw useEffect/useLayoutEffect forbidden in src/web/src/components/new-card.tsx"),
      ])
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it("forbids adding new raw useEffect/useLayoutEffect calls in guarded web and blog view layers", () => {
    const fixture = loadRatchetFixture()
    expect(fixture.schemaVersion).toBe(1)
    expect(fixture.policy).toBe("monotonic_non_increasing")
    expect(fixture.guardedRoots).toEqual([
      "src/web/src/components",
      "src/web/src/app",
      "src/web/blog/src/app",
      "src/web/blog/src/components",
    ])

    const roots = fixture.guardedRoots.map((root) => resolve(repositoryRoot, root))
    const actualCounts = collectViewEffectCounts(roots, repositoryRoot)
    expect(validateViewEffectRatchet(actualCounts, fixture.maxEffectsByFile)).toEqual([])
  })
})
