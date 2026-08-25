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

function selectorViolations(source: string): string[] {
  const rules = [
    { label: "literal getByTestId", pattern: /getByTestId\s*\(\s*[`"']/ },
    {
      label: "hard-coded data-testid selector",
      pattern: /data-testid(?:[\^$*~|])?\s*=\s*\\?["'](?!\$\{)/,
    },
    {
      label: "hard-coded unquoted data-testid selector",
      pattern: /data-testid(?:[\^$*~|])?\s*=\s*(?!\\?["']|\$\{)[^\s\]]+/,
    },
    { label: "bare data-testid selector", pattern: /\[\s*data-testid\s*\]/ },
  ]
  return rules.filter(({ pattern }) => pattern.test(source)).map(({ label }) => label)
}

describe("E2E selector contract", () => {
  it("derives every test ID from the canonical registry", () => {
    const violations = sourceFiles(e2eRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8")
      return selectorViolations(source).map((label) => `${path.slice(e2eRoot.length + 1)}: ${label}`)
    })

    expect(violations).toEqual([])
  })

  it.each([
    ["arbitrary quoted value", `page.locator('[data-testid="rogue-id"]')`],
    ["arbitrary escaped value", `document.querySelector("[data-testid=\\"rogue-id\\"]")`],
    ["arbitrary prefix value", `page.locator('[data-testid^="rogue-"]')`],
    ["arbitrary unquoted value", `page.locator('[data-testid=rogue-id]')`],
    ["bare attribute lookup", `page.locator('[data-testid]')`],
  ])("rejects %s", (_label, fixture) => {
    expect(selectorViolations(fixture)).not.toEqual([])
  })

  it("allows canonical registry values to be interpolated or passed into evaluate", () => {
    const fixture = `
      page.getByTestId(tid.messageScroller)
      page.locator(\`[data-testid="\${tid.messageScroller}"]\`)
      page.evaluate((id) => document.querySelector(\`[data-testid="\${id}"]\`), tid.messageScroller)
    `

    expect(selectorViolations(fixture)).toEqual([])
  })
})
