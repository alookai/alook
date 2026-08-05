import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"

/**
 * ③ shrink-gate (route/disc trunk — flat-tree deletion). `createCommunityMessage`
 * is the single write funnel; every caller must be an INTENDED door. This test
 * enumerates the actual direct callers across the whole source tree and asserts
 * the set equals a hand-maintained allowlist — a NEW caller (e.g. a re-added flat
 * verb, or a route that should have folded into the canonical door) fails the
 * test until it's consciously added here. That's the point: the allowlist is the
 * positive proof that the flat tree stayed deleted and no fourth door-bypass
 * caller crept in (Melly #346 / Aigneis ③).
 *
 * Paths are repo-relative to src/web (the vitest cwd). `message-handler.ts` is
 * excluded — it DEFINES createCommunityMessage, it doesn't call it.
 */
const ALLOWLIST = [
  // The canonical id-in-path message door (human + bot, folds flat `send`).
  "src/app/api/community/channels/[id]/messages/route.ts",
  // The DM message door (human web client; a future step folds it into the
  // canonical channels/{id} tree, but it is a LIVE human route today).
  "src/app/api/community/dm/[id]/messages/route.ts",
  // Bot enrollment welcome message (server owner adds a bot → greeting).
  "src/app/api/community/servers/[id]/bots/route.ts",
  // Forum post creation (its first message); folds into send-with-title at the
  // forum≡thread step.
  "src/lib/community/create-forum-post.ts",
].sort()

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue
      walk(full, acc)
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(full)
    }
  }
  return acc
}

describe("createCommunityMessage caller allowlist (③ shrink-gate)", () => {
  it("only the intended doors call createCommunityMessage — no flat-verb / bypass caller", () => {
    // Resolve @alook/web's `src` regardless of vitest cwd (repo root vs package).
    // This file is at src/lib/community/, so climb two levels to `src`.
    const srcRoot = join(__dirname, "..", "..")
    const files = walk(srcRoot)
    const callers: string[] = []
    for (const file of files) {
      if (file.endsWith("lib/community/message-handler.ts")) continue // defines it
      // Strip `//` line comments and `/* */` block comments so a doc mention of
      // the funnel (e.g. "the MessageTarget for createCommunityMessage") is not
      // counted as a caller — only a real invocation `createCommunityMessage(`.
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
      // A direct call: `createCommunityMessage(` with no intervening space (a
      // call site, not the import binding or a JSDoc reference).
      if (/\bcreateCommunityMessage\(/.test(src)) {
        // Normalize to a `src/`-relative path stable across cwd.
        callers.push("src/" + file.slice(srcRoot.length + 1))
      }
    }
    expect(callers.sort()).toEqual(ALLOWLIST)
  })
})
