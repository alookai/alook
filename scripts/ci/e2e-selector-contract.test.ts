import { readdirSync, readFileSync } from "node:fs"
import { extname, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const e2eRoot = resolve(import.meta.dirname, "../../src/web/src/test/e2e-ui")

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : []
  })
}

describe("E2E selector contract", () => {
  it("derives every test ID from the canonical registry", () => {
    const violations = sourceFiles(e2eRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8")
      return [
        { label: "literal getByTestId", index: source.search(/getByTestId\s*\(\s*[`"']/) },
        {
          label: "hard-coded data-testid selector",
          index: source.search(/data-testid(?:\^)?\s*=\s*\\?["'](?:community|bot)-/),
        },
      ].flatMap(({ label, index }) => index === -1
        ? []
        : [`${path.slice(e2eRoot.length + 1)}: ${label}`])
    })

    expect(violations).toEqual([])
  })
})
