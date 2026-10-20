import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"

it("keeps exactly the pinned MIT upstream files, with no owned code in the third-party exclusion", () => {
  const root = resolve(import.meta.dirname, "../public/vendor/trace-waterfall-viewer")
  const manifest = JSON.parse(readFileSync(resolve(root, "upstream-manifest.json"), "utf8")) as {
    commit: string; files: Array<{ path: string; bytes: number; sha256: string; upstream_git_blob: string }>
  }
  expect(manifest.commit).toBe("27adfa3e0d46039bae9a684f88cea542b847b134")
  const actual = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => resolve(entry.parentPath, entry.name).slice(root.length + 1)).filter(path => path !== "upstream-manifest.json").sort()
  expect(actual).toEqual(manifest.files.map(file => file.path).sort())
  expect(actual).toHaveLength(20)
  for (const file of manifest.files) {
    const bytes = readFileSync(resolve(root, file.path))
    expect(bytes.length, file.path).toBe(file.bytes)
    expect(createHash("sha256").update(bytes).digest("hex"), file.path).toBe(file.sha256)
    expect(createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex"), file.path).toBe(file.upstream_git_blob)
  }
  expect(readFileSync(resolve(root, "LICENSE"), "utf8")).toContain("MIT License")
})
