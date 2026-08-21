import { existsSync, readFileSync, readdirSync } from "node:fs"
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
      "Composer",
      "ComposerSkeleton",
      "MessageChannelController",
      "MessageList",
      "MessageRow",
      "TypingIndicator",
    ])
    const entry = readFileSync(join(MESSAGING_ROOT, "index.ts"), "utf8")
    expect(entry).not.toMatch(/internal\//)
    expect(entry).not.toMatch(
      /MessageRowProps|ResolvedMessageListProps|MessageChannelControllerProps|ComposerViewProps|MessageActionContext|clipboardFiles|pendingFilesToSendAttachments/,
    )
  })

  it("removes all six legacy messaging facades", () => {
    const files = [
      "composer.tsx",
      "message-channel-controller.tsx",
      "message-list.tsx",
      "message-row.tsx",
      "message.tsx",
      "typing-indicator.tsx",
    ]
    for (const file of files) {
      expect(existsSync(join(SRC_ROOT, "components/community/messages", file))).toBe(false)
    }
  })

  it("keeps all four Views free of client capability ownership", () => {
    const views = [
      "internal/composer-view.tsx",
      "internal/message-list-view.tsx",
      "internal/message-channel-controller-view.ts",
      "internal/message-row-view.tsx",
    ]
    for (const file of views) {
      const source = readFileSync(join(MESSAGING_ROOT, file), "utf8")
      expect(source).not.toMatch(/use(Query|Mutation|Router|SearchParams|State|Effect|LayoutEffect|Ref|SyncExternalStore)\b/)
      expect(source).not.toMatch(/QueryClient|apiFetch|useCommunityWs|permission|@\/stores\//i)
    }
  })

  it("keeps the new owner independent of superseded production paths", () => {
    const forbidden = /components\/community\/messages\/(composer(?:-types|-view|-suggestion-popups|-file-utils)?|use-composer-(?:controller|suggestions)|message-channel-controller(?:-state|-types|-actions|-send|-view)?|message-list(?:-controller|-types|-row|-view)?|message-row|message|typing-indicator|virtual-cursor-list)(?:["']|$)/
    for (const path of productionSources(MESSAGING_ROOT)) {
      expect(readFileSync(path, "utf8")).not.toMatch(forbidden)
    }
  })

  it("keeps Composer and MessageChannelController internals private to messaging", () => {
    const forbiddenInternal = /modules\/community\/client\/messaging\/internal\/(?:composer|use-composer|message-channel-controller)/
    for (const path of productionSources(SRC_ROOT)) {
      if (path.startsWith(MESSAGING_ROOT)) continue
      expect(readFileSync(path, "utf8"), path).not.toMatch(forbiddenInternal)
    }
  })

  it("keeps compact search results free of dead thread controls", () => {
    const source = readFileSync(
      join(SRC_ROOT, "components/community/shell/right-panel.tsx"),
      "utf8",
    )
    expect(source).toContain("const { thread: _thread, ...compactMessage } = m")
    expect(source).toContain("const renderMsg: RenderMsg = { ...compactMessage, grouped: false }")
    expect(source).toContain("m={renderMsg}")
  })
})
