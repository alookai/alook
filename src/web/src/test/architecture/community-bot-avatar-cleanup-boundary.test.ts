import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const c2Sources = [
  "src/shared/src/db/queries/community/bot.ts",
  "src/web/src/lib/community/bot-avatar-persistence.ts",
  "src/web/src/app/api/community/bots/[id]/avatar/route.ts",
  "src/web/src/app/api/community/bots/[id]/route.ts",
  "src/web/src/app/api/community/machines/[id]/route.ts",
  "src/web/src/app/api/community/users/me/avatar/route.ts",
] as const

function source(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8")
}

describe("bot and machine-cascade avatar cleanup C2 boundary", () => {
  it("cannot touch diagnostics, BUG_REPORTS, or unrelated media namespaces", () => {
    const combined = c2Sources.map(source).join("\n")
    for (const forbidden of [
      "BUG_REPORTS",
      "communityDiagnosticReport",
      "user-avatar/",
      "server-icon/",
      "communityAttachment",
      "deleteChannelWithMedia",
      "deleteServerWithMedia",
      ".list(",
    ]) {
      expect(combined).not.toContain(forbidden)
    }
  })

  it("deletes only an authoritative owned child and the exact stable alias", () => {
    for (const path of c2Sources.slice(1)) {
      expect(source(path)).not.toContain("bot-avatar/")
    }
    const persistence = source("src/web/src/lib/community/bot-avatar-persistence.ts")
    expect(persistence).toContain("cleanupAvatarCandidate(")
    expect(persistence).toContain("objectKey: input.objectKey")

    for (const path of [
      "src/web/src/app/api/community/bots/[id]/route.ts",
      "src/web/src/app/api/community/machines/[id]/route.ts",
    ]) {
      const deletion = source(path)
      expect(deletion).toContain("isOwnedBotAvatarObjectKey")
      expect(deletion).toContain("before.avatarObjectKey")
      expect(deletion).toContain("buildBotAvatarKey(")
      expect(deletion).not.toContain(".list(")
    }
  })

  it("keeps the human self-avatar branch on Better Auth and user storage", () => {
    const meAvatar = source("src/web/src/app/api/community/users/me/avatar/route.ts")
    expect(meAvatar).toContain("handleUserAvatarUpload(req, ctx.env, userId)")
    expect(meAvatar).toContain("const auth = createAuth(ctx.env)")
    expect(meAvatar).toContain("auth.api.updateUser")
    expect(meAvatar).toContain("userAvatarUrl(userId)")
  })
})
