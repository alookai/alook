import { execFileSync } from "node:child_process"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("service test project ownership", () => {
  it("discovers each service in its own project without duplicate files", () => {
    const root = path.resolve(import.meta.dirname, "../../../../..")
    const source = [
      'import { createVitest } from "vitest/node"',
      'import { relative, sep } from "node:path"',
      'const ctx = await createVitest({root:process.cwd(),watch:false,project:["web-node","web-dom","web-contracts","web-tooling","web-runtime","blog-node","blog-dom","auth-node","auth-runtime"]})',
      'try { const specs=await ctx.globTestSpecifications(); process.stdout.write(JSON.stringify(specs.map(spec=>({project:spec.project.name,file:relative(process.cwd(),spec.moduleId).split(sep).join("/")})))) } finally { await ctx.close() }',
    ].join("\n")
    const files = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    })) as { project: string; file: string }[]
    expect(new Set(files.map(file => file.file)).size).toBe(files.length)
    expect(files).toEqual(expect.arrayContaining([
      { project: "web-node", file: "src/web/src/components/community/bots/bot-list-facade.contract.test.ts" },
      { project: "web-dom", file: "src/web/src/components/community/bots/bot-list-card.dom.test.ts" },
      { project: "web-contracts", file: "src/web/src/test/architecture/react-dom-harness-contract.test.ts" },
      { project: "web-tooling", file: "src/web/app-store-capture/config.test.ts" },
      { project: "blog-node", file: "src/web/blog/src/lib/public-page-metadata.test.ts" },
      { project: "blog-dom", file: "src/web/blog/src/app/guides/page.dom.test.tsx" },
      { project: "auth-node", file: "src/web/auth/index.test.ts" },
    ]))
    for (const project of ["web-runtime", "auth-runtime"]) {
      expect(files.some(file => file.project === project && file.file.includes("/test-runtime/"))).toBe(true)
    }
    expect(files.filter(file => file.file.startsWith("src/web/blog/")).every(file => file.project.startsWith("blog-"))).toBe(true)
    expect(files.filter(file => file.file.startsWith("src/web/auth/")).every(file => file.project.startsWith("auth-"))).toBe(true)
  })
})
