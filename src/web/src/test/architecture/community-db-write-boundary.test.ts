import { readdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const webSourceRoot = resolve(repositoryRoot, "src/web/src")

function walkSource(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) walkSource(path, files)
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path)
  }
  return files
}

describe("community DB canonical write boundary", () => {
  it("keeps adapter write utilities behind writeCommunityCollectionRows", () => {
    const directWrite = /\.utils\.write(?:Insert|Update|Delete|Upsert)\b/
    expect(walkSource(webSourceRoot)
      .filter((path) => directWrite.test(readFileSync(path, "utf8")))
      .map((path) => relative(repositoryRoot, path).replaceAll("\\", "/")))
      .toEqual([])
  })
})
