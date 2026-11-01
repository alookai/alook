import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
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
  it("keeps every unread fact in canonical DB instead of a parallel owner", () => {
    const production = walkTypeScript(resolve(repositoryRoot, "src/web/src"))
      .filter((path) => !path.includes("/test/") && !/\.test\.tsx?$/.test(path))
    for (const path of production) expect(readFileSync(path, "utf8")).not.toContain("account-unread-projection")
    const schema = source("src/web/src/lib/community-db/schema.ts")
    expect(schema).not.toMatch(/(?:unread|baseUnread|lastUnreadSeq|mentions): z\./)
    expect(source("src/web/src/hooks/community/read-coordinator.ts")).toContain("publishCommunityConversationReadState")
    expect(source("src/web/src/hooks/community/community-ws/read-state-reconciliation.ts")).not.toContain("setTimeout")
  })

  it("keeps dot components presentation-only", () => {
    const consumers = [
      "src/web/src/components/community/shell/community-inbox-popover.tsx",
      "src/web/src/components/community/shell/user-bar.tsx",
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
      "src/web/src/components/community/shell/user-bar.tsx",
    )
    expect(surface).toContain("hasUnread: boolean")
  })
})
