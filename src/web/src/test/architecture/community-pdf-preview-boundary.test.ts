import { readdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const webSourceRoot = resolve(repositoryRoot, "src/web/src")

function walkTypeScript(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) walkTypeScript(path, files)
    else if (/\.tsx?$/.test(entry.name)) files.push(path)
  }
  return files
}

function source(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8")
}

describe("community PDF preview boundary", () => {
  it("keeps PDF.js owned by one client-only lazy module", () => {
    const productionOwners = walkTypeScript(webSourceRoot)
      .filter((path) => !path.includes("/test/") && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      .filter((path) => /from "pdfjs-dist(?:\/[^"\n]+)?"/.test(readFileSync(path, "utf8")))
      .map((path) => relative(repositoryRoot, path).replaceAll("\\", "/"))

    expect(productionOwners).toEqual([
      "src/web/src/components/community/messages/pdf-preview.tsx",
    ])
    const sheet = source("src/web/src/components/community/messages/attachment-preview-sheet.tsx")
    expect(sheet).toContain('import("./pdf-preview")')
    expect(sheet).toContain("ssr: false")
    expect(sheet).not.toContain('from "pdfjs-dist"')
    const preview = source("src/web/src/components/community/messages/pdf-preview.tsx")
    expect(preview).toContain('from "pdfjs-dist/legacy/build/pdf.mjs"')
  })

  it("keeps the PDF worker lazy and cleanup generation-owned", () => {
    const preview = source("src/web/src/components/community/messages/pdf-preview.tsx")
    expect(preview).toContain('"pdfjs-dist/legacy/build/pdf.worker.min.mjs"')
    expect(preview).toContain("data: data.slice()")
    expect(preview).toContain("renderTask?.cancel()")
    expect(preview).toContain("page?.cleanup()")
    expect(preview).toContain("loadingTask.destroy()")
    expect(preview).toContain("worker.destroy()")
  })
})
