import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repositoryRoot = resolve(import.meta.dirname, "../..")
const declarations = [
  "package.json",
  "src/app/package.json",
  "src/email-worker/package.json",
  "src/wake-worker/package.json",
  "src/web/package.json",
  "src/ws-do/package.json",
]

describe("Wrangler compatibility pin", () => {
  it("pins every direct declaration and importer to 4.113.0", () => {
    for (const path of declarations) {
      const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8")) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      expect(
        packageJson.dependencies?.wrangler ?? packageJson.devDependencies?.wrangler,
        path,
      ).toBe("4.113.0")
    }

    const lockfile = readFileSync(resolve(repositoryRoot, "pnpm-lock.yaml"), "utf8")
    const pinnedImporters = lockfile.match(
      /wrangler:\n\s+specifier: 4\.113\.0\n\s+version: 4\.113\.0\([^\n]+\)/g,
    ) ?? []
    expect(pinnedImporters).toHaveLength(declarations.length)
  })
})
