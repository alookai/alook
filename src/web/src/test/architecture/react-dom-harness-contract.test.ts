import { readFileSync, readdirSync } from "node:fs"
import { relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const webRoot = resolve(import.meta.dirname, "../../..")
const sourceRoot = resolve(webRoot, "src")

function domTests() {
  const files: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && /\.dom\.test\.tsx?$/.test(entry.name)) files.push(path)
    }
  }
  visit(sourceRoot)
  return files.sort()
}

describe("React DOM harness contract", () => {
  it("routes every DOM test through the canonical harness", () => {
    const files = domTests()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(file, "utf8")
      expect(source, relative(webRoot, file)).toMatch(/from ["'](?:@\/test\/|\.\/)react-dom-harness["']/)
      expect(source, relative(webRoot, file)).not.toMatch(/from ["']@testing-library\/(?:react|user-event)["']/)
      expect(source, relative(webRoot, file)).not.toMatch(/\bcleanup\s*\(/)
      expect(source, relative(webRoot, file)).not.toMatch(/IS_REACT_ACT_ENVIRONMENT\s*=/)
    }
  })

  it("keeps RTL lifecycle ownership in one harness and one setup module", () => {
    const harness = readFileSync(resolve(sourceRoot, "test/react-dom-harness.ts"), "utf8")
    const setup = readFileSync(resolve(sourceRoot, "test/react-dom-setup.ts"), "utf8")
    expect(harness).toContain('from "@testing-library/react"')
    expect(harness).toContain('from "@testing-library/user-event"')
    expect(harness).not.toMatch(/\bcleanup\s*\(/)
    expect(harness).not.toMatch(/IS_REACT_ACT_ENVIRONMENT\s*=/)
    expect(setup.trim()).toBe('import "@testing-library/jest-dom/vitest"')
  })
})
