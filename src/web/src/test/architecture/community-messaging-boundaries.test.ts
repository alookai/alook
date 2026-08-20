import { readFileSync, readdirSync } from "node:fs"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as messaging from "@/modules/community/client/messaging"

const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const MESSAGING_ROOT = join(SRC_ROOT, "modules/community/client/messaging")

function productionSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return productionSources(path)
    if (![".ts", ".tsx"].includes(extname(entry.name))) return []
    return entry.name.includes(".test.") ? [] : [path]
  })
}

describe("Community messaging boundaries", () => {
  it("keeps the stable value allowlist exact and hides internal owners", () => {
    expect(Object.keys(messaging).sort()).toEqual([
      "MessageList",
      "MessageRow",
      "TypingIndicator",
    ])
    const entry = readFileSync(join(MESSAGING_ROOT, "index.ts"), "utf8")
    expect(entry).not.toMatch(/internal\//)
    expect(entry).not.toMatch(/MessageRowProps/)
  })

  it("keeps all four legacy files as re-export-only facades", () => {
    const files = ["message-list.tsx", "message-row.tsx", "message.tsx", "typing-indicator.tsx"]
    for (const file of files) {
      const source = readFileSync(join(SRC_ROOT, "components/community/messages", file), "utf8")
      expect(source).toMatch(/^export\s+\{/)
      expect(source).not.toMatch(/\b(import|function|const|let|class|use[A-Z]\w*)\b/)
      expect(source).not.toMatch(/<\w|=>/)
    }
  })

  it("keeps both Views free of client capability ownership", () => {
    const views = [
      "internal/message-list-view.tsx",
      "internal/message-row-view.tsx",
    ]
    for (const file of views) {
      const source = readFileSync(join(MESSAGING_ROOT, file), "utf8")
      expect(source).not.toMatch(/use(Query|Mutation|Router|SearchParams|State|Effect|LayoutEffect|Ref|SyncExternalStore)\b/)
      expect(source).not.toMatch(/QueryClient|apiFetch|useCommunityWs|permission|@\/stores\//i)
    }
  })

  it("keeps the new owner independent of superseded production paths", () => {
    const forbidden = /components\/community\/messages\/(message-list(?:-controller|-types|-row|-view)?|message-row|message|typing-indicator|virtual-cursor-list)(?:["']|$)/
    for (const path of productionSources(MESSAGING_ROOT)) {
      expect(readFileSync(path, "utf8")).not.toMatch(forbidden)
    }
  })
})
