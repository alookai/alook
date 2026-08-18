import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { classifyPaths, parseNameStatus, runCli } from "./changed-scopes.mjs"

describe("classifyPaths", () => {
  it("selects the strict blog fast path for MDX and blog assets", () => {
    const result = classifyPaths([
      "src/web/src/content/example.mdx",
      "src/web/public/blog/example/hero.webp",
    ])

    expect(result.blog_only).toBe(true)
    expect(result.run_code_checks).toBe(false)
    expect(result.run_ui_e2e).toBe(false)
  })

  it("selects no package work for markdown-only changes", () => {
    const result = classifyPaths(["README.md", "docs/operations.md"])

    expect(result.docs_only).toBe(true)
    expect(result.run_code_checks).toBe(false)
  })

  it("disables the blog fast path when content is mixed with docs", () => {
    const result = classifyPaths([
      "src/web/src/content/example.mdx",
      "README.md",
    ])

    expect(result.blog_only).toBe(false)
    expect(result.full).toBe(true)
  })

  it("keeps Windows for shared and CLI changes", () => {
    expect(classifyPaths(["src/shared/src/schema.ts"]).run_windows).toBe(true)
    expect(classifyPaths(["src/cli/src/index.ts"]).run_windows).toBe(true)
    expect(classifyPaths(["src/web/src/app/page.tsx"]).run_windows).toBe(false)
  })

  it("routes agent-driver changes through code, Windows, E2E, and knip without forcing full CI", () => {
    const result = classifyPaths(["src/agent-driver/src/contracts.ts"])

    expect(result.full).toBe(false)
    expect(result.run_code_checks).toBe(true)
    expect(result.run_windows).toBe(true)
    expect(result.run_e2e).toBe(true)
    expect(result.run_knip).toBe(true)
  })

  it("routes web runtime changes through browser and Lighthouse checks", () => {
    const result = classifyPaths(["src/web/src/app/page.tsx"])

    expect(result.run_ui_e2e).toBe(true)
    expect(result.run_lighthouse).toBe(true)
    expect(result.run_e2e).toBe(true)
  })

  it("routes CLI and daemon integration test changes through Linux E2E", () => {
    for (const path of [
      "tests/integration/cli/session-resume.test.ts",
      "tests/integration/daemon/control-plane.test.ts",
    ]) {
      const result = classifyPaths([path])
      expect(result.full).toBe(false)
      expect(result.run_e2e).toBe(true)
    }
  })

  it("only accepts top-level MDX posts for the blog fast path", () => {
    const result = classifyPaths(["src/web/src/content/nested/example.mdx"])

    expect(result.blog_only).toBe(false)
    expect(result.run_code_checks).toBe(true)
    expect(result.run_ui_e2e).toBe(true)
    expect(result.run_lighthouse).toBe(true)
  })

  it("routes desktop-only changes through Rust without UI E2E", () => {
    const result = classifyPaths(["src/desktop/src-tauri/src/lib.rs"])

    expect(result.run_rust).toBe(true)
    expect(result.run_ui_e2e).toBe(false)
  })

  it("fails closed for workflows, root configuration, unknown paths, and empty diffs", () => {
    expect(classifyPaths([".github/workflows/ci.yml"]).full).toBe(true)
    expect(classifyPaths([".github/dependabot.yml"]).full).toBe(true)
    expect(classifyPaths(["scripts/bump-version.mjs"]).full).toBe(true)
    expect(classifyPaths(["pnpm-lock.yaml"]).full).toBe(true)
    expect(classifyPaths(["src/future-package/src/index.ts"]).full).toBe(true)
    expect(classifyPaths(["unexpected/file.txt"]).full).toBe(true)
    expect(classifyPaths([]).full).toBe(true)
  })

  it("honors an explicit full run", () => {
    const result = classifyPaths(["src/web/src/content/example.mdx"], {
      forceFull: true,
    })

    expect(result.full).toBe(true)
    expect(result.blog_only).toBe(false)
    expect(result.run_windows).toBe(true)
  })
})

describe("parseNameStatus", () => {
  it("includes both sides of renames and copies", () => {
    const input = Buffer.from(
      "M\0src/web/src/content/a.mdx\0R100\0src/cli/a.ts\0src/web/src/content/a.mdx\0C090\0old.ts\0new.ts\0"
    )

    expect(parseNameStatus(input)).toEqual([
      "src/web/src/content/a.mdx",
      "src/cli/a.ts",
      "src/web/src/content/a.mdx",
      "old.ts",
      "new.ts",
    ])
  })
})

describe("runCli", () => {
  it("writes full-CI outputs when the diff cannot be resolved", () => {
    const directory = mkdtempSync(join(tmpdir(), "alook-ci-scope-"))
    const output = join(directory, "output")
    try {
      runCli(["--base", "missing-base", "--head", "missing-head", "--output", output])
      const values = readFileSync(output, "utf8")
      expect(values).toContain("full=true")
      expect(values).toContain("run_windows=true")
      expect(values).toContain("run_ui_e2e=true")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
