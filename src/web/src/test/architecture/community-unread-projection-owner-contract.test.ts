import { readdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))

function source(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8")
}

function walkTypeScript(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) walkTypeScript(path, files)
    else if (/\.tsx?$/.test(entry.name)) files.push(path)
  }
  return files
}

describe("community unread projection owner contract", () => {
  it("creates the authenticated account owner only at the query boundary", () => {
    const webSourceRoot = resolve(repositoryRoot, "src/web/src")
    const constructors = walkTypeScript(webSourceRoot)
      .filter((path) => !path.includes("/test/") && !path.endsWith(".test.ts"))
      .filter((path) => /new AccountUnreadProjection\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(repositoryRoot, path).replaceAll("\\", "/"))

    expect(constructors).toEqual([
      "src/web/src/hooks/community/account-unread-projection.ts",
    ])
    expect(source("src/web/src/app/c/QueryProvider.tsx"))
      .toContain("getAccountUnreadProjection(queryClient, userId)")
  })

  it("keeps dot components presentation-only", () => {
    const consumers = [
      "src/web/src/components/community/shell/community-inbox-popover.tsx",
      "src/web/src/components/community/shell/community-inbox-surface.tsx",
      "src/web/src/components/community/shell/rail-folder.tsx",
      "src/web/src/components/community/shell/sortable-server.tsx",
      "src/web/src/components/community/channels/channel-sidebar.tsx",
      "src/web/src/components/community/channels/sortable-channel.tsx",
      "src/web/src/components/community/channels/dm-sidebar.tsx",
    ]

    for (const path of consumers) {
      expect(source(path)).not.toMatch(
        /\b(?:useInboxUnreads|useInboxMentions|useServers|useServer|useDms)\s*\(/,
      )
      expect(source(path)).not.toContain("communityKeys.")
      expect(source(path)).not.toContain("getActiveAccountUnreadProjection")
    }
  })

  it("requires projected inbox dot state without raw row-count fallback", () => {
    const popover = source(
      "src/web/src/components/community/shell/community-inbox-popover.tsx",
    )
    expect(popover).toContain("hasProjectedUnreads: boolean")
    expect(popover).toContain("hasProjectedMentions: boolean")
    expect(popover).toContain("const hasUnreads = hasProjectedUnreads")
    expect(popover).toContain("const hasMentions = hasProjectedMentions")
    expect(popover).not.toMatch(/hasProjectedUnreads\s*\?\?/)
    expect(popover).not.toMatch(/hasProjectedMentions\s*\?\?/)

    const surface = source(
      "src/web/src/components/community/shell/community-inbox-surface.tsx",
    )
    expect(surface).toContain("hasUnread: boolean")
  })
})
