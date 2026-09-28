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
  it("keeps direct adapter writes inside the official server ownership boundary", () => {
    const directWrite = /\.utils\.write(?:Insert|Update|Delete|Upsert)\b/
    const allowed = new Set([
      "src/web/src/hooks/community/mutations/server-rail.ts",
      "src/web/src/hooks/community/mutations/servers.ts",
      "src/web/src/lib/community-db/collections.ts",
      "src/web/src/lib/community-db/server-test-seed.ts",
      "src/web/src/lib/community-db/sync.ts",
    ])
    expect(walkSource(webSourceRoot)
      .filter((path) => !/\.test\.[tj]sx?$/.test(path))
      .filter((path) => directWrite.test(readFileSync(path, "utf8")))
      .map((path) => relative(repositoryRoot, path).replaceAll("\\", "/"))
      .filter((path) => !allowed.has(path)))
      .toEqual([])
  })

  it("has no server-list publication or DB shadow reader", () => {
    const production = walkSource(webSourceRoot)
      .filter((path) => !/\.test\.[tj]sx?$/.test(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n")
    expect(production).not.toContain("serversProjectedQueryFn")
    expect(production).not.toContain("liveServerListAuthority")
    expect(production).not.toMatch(/communityDbCollection\([^\n]*["']servers["']/)
    expect(production).not.toContain('kind: "servers"')
  })
})
