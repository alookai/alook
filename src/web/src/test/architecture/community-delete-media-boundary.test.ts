import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const c1Sources = [
  "src/shared/src/db/queries/community/attachment.ts",
  "src/shared/src/db/queries/community/delete-media.ts",
  "src/shared/src/db/queries/community/server.ts",
  "src/web/src/app/api/community/channels/[id]/route.ts",
  "src/web/src/app/api/community/servers/[id]/route.ts",
  "src/web/src/app/api/community/servers/[id]/icon/route.ts",
  "src/web/src/lib/community/community-media-cleanup.ts",
] as const

describe("existing delete media C1 boundary", () => {
  it("cannot cross into bot, machine, diagnostic, or BUG_REPORTS storage", () => {
    const source = c1Sources
      .map((path) => readFileSync(resolve(repositoryRoot, path), "utf8"))
      .join("\n")

    for (const forbidden of [
      "BUG_REPORTS",
      "communityDiagnosticReport",
      "bot-avatar/",
      "communityMachine",
      "deleteMachine",
      ".list(",
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })
})
