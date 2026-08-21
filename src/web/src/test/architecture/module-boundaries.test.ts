import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, extname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import * as communityClient from "@/modules/community/client"
import * as channelEntry from "@/modules/community/client/channel"

const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

function productionSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return productionSources(path)
    if (![".ts", ".tsx"].includes(extname(entry.name))) return []
    if (entry.name.includes(".test.")) return []
    return [path]
  })
}

function importedSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*(?:\(|\s))["']([^"']+)["']/g)]
    .map((match) => match[1])
}

function resolvedSourceImport(from: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return join(SRC_ROOT, specifier.slice(2))
  if (specifier.startsWith(".")) return resolve(dirname(from), specifier)
  return null
}

describe("Web client architecture boundaries", () => {
  it("keeps platform client independent of product modules", () => {
    const forbidden = productionSources(join(SRC_ROOT, "platform/client"))
      .flatMap((path) => importedSpecifiers(readFileSync(path, "utf8"))
        .map((specifier) => ({ specifier, target: resolvedSourceImport(path, specifier) }))
        .filter(({ target }) => target !== null && [
          join(SRC_ROOT, "modules"),
          join(SRC_ROOT, "lib/community"),
          join(SRC_ROOT, "components/community"),
          join(SRC_ROOT, "hooks/community"),
          join(SRC_ROOT, "stores/community"),
        ].some((root) => target === root || target.startsWith(`${root}/`)))
        .map(({ specifier }) => ({ path, specifier })))

    expect(forbidden).toEqual([])
  })

  it("keeps Community client independent of server and Cloudflare capabilities", () => {
    const forbidden = productionSources(join(SRC_ROOT, "modules/community/client"))
      .flatMap((path) => importedSpecifiers(readFileSync(path, "utf8"))
        .filter((specifier) => {
          const target = resolvedSourceImport(path, specifier)
          return (target !== null && [
            join(SRC_ROOT, "platform/server"),
            join(SRC_ROOT, "modules/community/server"),
          ].some((root) => target === root || target.startsWith(`${root}/`)))
            || specifier.startsWith("cloudflare:")
            || specifier.startsWith("@cloudflare/")
            || specifier === "wrangler"
            || specifier === "@opennextjs/cloudflare"
        })
        .map((specifier) => ({ path, specifier })))

    expect(forbidden).toEqual([])
  })

  it("keeps the Community shell on the module public entry", () => {
    const shell = readFileSync(join(SRC_ROOT, "app/c/community-shell.tsx"), "utf8")

    expect(shell).toMatch(/from ["']@\/modules\/community\/client["']/)
    expect(shell).not.toMatch(/@\/modules\/community\/client\//)
  })

  it("keeps Community root and channel integration entries exact", () => {
    expect(Object.keys(communityClient).sort()).toEqual([
      "ChannelPreview",
      "ChannelScreen",
      "ChannelScreenSkeleton",
      "CommunityQueryProvider",
    ])
    expect(Object.keys(channelEntry).sort()).toEqual([
      "ChannelHeader",
      "ChannelHeaderSkeleton",
      "ChannelPreview",
      "ChannelScreen",
      "ChannelScreenSkeleton",
      "ChannelShell",
    ])
  })

  it("keeps channel Views prop-only and internal owners private", () => {
    const channelRoot = join(SRC_ROOT, "modules/community/client/channel")
    for (const file of ["internal/channel-view.tsx", "internal/text-channel-view.tsx"]) {
      const source = readFileSync(join(channelRoot, file), "utf8")
      expect(source).not.toMatch(/next\/navigation|@tanstack\/react-query|@\/hooks\/community|@\/stores\/community|@\/lib\/api|permission/i)
      expect(source).not.toMatch(/\buse(Query|Mutation|Router|SearchParams|Effect|State|SyncExternalStore)\b/)
    }
    const leaked = productionSources(SRC_ROOT).flatMap((path) => {
      if (path.startsWith(channelRoot)) return []
      return importedSpecifiers(readFileSync(path, "utf8"))
        .filter((specifier) => specifier.includes("modules/community/client/channel/internal/"))
        .map((specifier) => ({ path, specifier }))
    })
    expect(leaked).toEqual([])
  })

  it("removes every superseded channel owner and messaging facade", () => {
    const removed = [
      "components/community/channels/channel-route.tsx",
      "components/community/channels/channel-route.text-scroll-target.test.ts",
      "components/community/channels/text-channel-surface.tsx",
      "components/community/channels/text-channel-surface.test.ts",
      "components/community/channels/channel-header.tsx",
      "components/community/channels/channel-header.title-dialog.test.ts",
      "components/community/channels/channel-shell.tsx",
      "hooks/community/use-channel-route-model.ts",
      "hooks/community/use-channel-route-model.test.ts",
      "hooks/community/use-channel-route-model.subscription.test.ts",
      "components/community/messages/message-list.tsx",
      "components/community/messages/message-row.tsx",
      "components/community/messages/message.tsx",
      "components/community/messages/typing-indicator.tsx",
      "components/community/messages/composer.tsx",
      "components/community/messages/message-channel-controller.tsx",
    ]
    for (const path of removed) expect(existsSync(join(SRC_ROOT, path)), path).toBe(false)

    const oldSpecifiers = [
      "channels/" + "channel-route",
      "channels/" + "text-channel-surface",
      "channels/" + "channel-header",
      "channels/" + "channel-shell",
      "messages/" + "message-list",
      "messages/" + "message-row",
      "messages/" + "message\"",
      "messages/" + "typing-indicator",
      "messages/" + "composer",
      "messages/" + "message-channel-controller",
    ]
    for (const path of productionSources(SRC_ROOT)) {
      const source = readFileSync(path, "utf8")
      for (const specifier of oldSpecifiers) expect(source, `${path}: ${specifier}`).not.toContain(specifier)
    }
  })

  it("keeps lint rules aligned with the source-contract checks", () => {
    const eslintConfig = readFileSync(join(WEB_ROOT, "eslint.config.mjs"), "utf8")

    expect(eslintConfig).toContain('files: ["src/platform/client/**/*.{ts,tsx}"]')
    expect(eslintConfig).toContain('group: ["@/modules/**"')
    expect(eslintConfig).toContain('files: ["src/modules/community/client/**/*.{ts,tsx}"]')
    expect(eslintConfig).toContain('group: ["@/platform/server"')
    expect(eslintConfig).toContain('files: ["src/app/c/community-shell.tsx"]')
    expect(eslintConfig).toContain('group: ["@/modules/community/client/**"]')
    expect(eslintConfig).toContain('files: ["src/modules/community/client/channel/internal/*-view.tsx"]')
    expect(eslintConfig).toContain('group: ["next/navigation", "@tanstack/react-query"')
    expect(eslintConfig).toContain('group: ["@/modules/community/client/**/internal/**"]')
  })
})
