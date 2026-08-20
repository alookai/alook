import { existsSync, readdirSync, readFileSync } from "node:fs"
import { extname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const THIS_TEST = fileURLToPath(import.meta.url)
const REMOVED_ROUTE = join(
  SRC_ROOT,
  "app/c/channels/[serverId]/[channelId]/[childChannelId]",
)
const REMOVED_PATH_TEST = join(SRC_ROOT, "test/e2e-ui/08-mobile.spec.ts")
const NESTED_CHANNEL_PATH = /\/c\/channels\/[^/?\s"'`\[\]]+\/[^/?\s"'`\[\]]+\/[^/?\s"'`\[\]]+/g

function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sources(path)
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : []
  })
}

describe("flat Community channel route contract", () => {
  it("removes the nested route entry and superseded route helpers", () => {
    expect(existsSync(REMOVED_ROUTE)).toBe(false)

    const forbidden = sources(SRC_ROOT)
      .filter((path) => path !== THIS_TEST)
      .flatMap((path) => {
        const source = readFileSync(path, "utf8")
        return ["child" + "ChannelHref", "routeParent" + "ChannelId"]
          .filter((token) => source.includes(token))
          .map((token) => ({ path: relative(SRC_ROOT, path), token }))
      })
    expect(forbidden).toEqual([])
  })

  it("allows one nested URL only in the removed-path rejection journey", () => {
    const occurrences = sources(SRC_ROOT)
      .filter((path) => path !== THIS_TEST)
      .flatMap((path) => {
        const source = readFileSync(path, "utf8")
        return [...source.matchAll(NESTED_CHANNEL_PATH)]
          .map((match) => ({ path, literal: match[0] }))
      })

    expect(occurrences.map(({ path, literal }) => ({
      path: relative(SRC_ROOT, path),
      literal,
    }))).toEqual([{
      path: relative(SRC_ROOT, REMOVED_PATH_TEST),
      literal: "/c/channels/${serverId}/${channelId}/${childChannelId}",
    }])
  })

  it("keeps last-channel memory flat on both reads and writes", () => {
    const source = readFileSync(
      join(SRC_ROOT, "lib/community/last-channel.ts"),
      "utf8",
    )
    expect(source.match(/includes\("\/"\)/g)).toHaveLength(3)
    expect(source).toContain("clearNavigationMemory(key)")
  })
})
