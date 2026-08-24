import { readdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const sharedCommunityQueries = resolve(
  repositoryRoot,
  "src/shared/src/db/queries/community",
)

function walkTypeScript(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) walkTypeScript(path, files)
    else if (entry.name.endsWith(".ts")) files.push(path)
  }
  return files
}

function source(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8")
}

describe("human account read-state writer contract", () => {
  it("keeps every direct read-state writer in the reviewed allowlist", () => {
    const directWriters = walkTypeScript(sharedCommunityQueries)
      .filter((path) => /\.(?:insert|update|delete)\(\s*communityReadState\s*\)/m.test(readFileSync(path, "utf8")))
      .map((path) => relative(repositoryRoot, path).replaceAll("\\", "/"))
      .sort()

    expect(directWriters).toEqual([
      "src/shared/src/db/queries/community/forum-post-delete.ts",
      "src/shared/src/db/queries/community/message.ts",
      "src/shared/src/db/queries/community/notification-setting.ts",
      "src/shared/src/db/queries/community/read-state.ts",
    ])
  })

  it("requires every human-capable writer and FK cascade to mint only bounded revisions", () => {
    const message = source("src/shared/src/db/queries/community/message.ts")
    expect(message).toContain('authorKind?: "human" | "bot"')
    expect(message).toContain("communityReadStateRevision")
    expect(message).toContain("readStateRevision: { userId: msg.authorId")
    expect(message).not.toContain("humanSnapshot")

    const notification = source("src/shared/src/db/queries/community/notification-setting.ts")
    expect(notification).toContain('actorKind: "human" | "bot"')
    expect(notification).toContain("advanceReadStateRevisionBuilder")
    expect(notification).not.toContain("accountReadStateRowsBuilder")

    const forumDelete = source("src/shared/src/db/queries/community/forum-post-delete.ts")
    expect(forumDelete).toContain("advanceReadStateRevisionsForUsersBuilder")
    expect(forumDelete).not.toContain("accountReadStateRowsForUsersBuilder")
    expect(forumDelete).toContain("impactedHumansStable")
    expect(forumDelete).toContain("deleteForumPostAttempt(db, input, attempt + 1)")

    const cascadeDelete = source("src/shared/src/db/queries/community/delete-media.ts")
    expect(cascadeDelete).toContain("advanceReadStateRevisionsForUsersBuilder")
    expect(cascadeDelete).not.toContain("accountReadStateRowsForUsersBuilder")
    expect(cascadeDelete.match(/impactedHumansStable/g)?.length).toBeGreaterThanOrEqual(6)
    expect(cascadeDelete).toContain("deleteChannelWithMediaAttempt(db, input, attempt + 1)")
    expect(cascadeDelete).toContain("deleteServerWithMediaAttempt(db, input, attempt + 1)")

    const event = source("src/shared/src/community-ws-events.ts")
    expect(event).toContain("bounded dirty hint")
    expect(event).not.toContain("readStates: z.array")
    expect(event).not.toContain("advances:")

    const readState = source("src/shared/src/db/queries/community/read-state.ts")
    expect(readState).toContain("getAccountReadStateSnapshot")
    expect(readState).toContain("accountReadStateRowsBuilder(db, userId)")
    expect(readState).not.toContain("accountReadStateRowsForUsersBuilder")
  })

  it("makes every production message door state the author kind explicitly", () => {
    const route = source("src/web/src/app/api/community/channels/[id]/messages/route.ts")
    expect(route.match(/authorKind: "human"/g)).toHaveLength(2)
    expect(route.match(/authorKind: "bot"/g)).toHaveLength(2)

    const botEnrollment = source("src/web/src/app/api/community/servers/[id]/bots/route.ts")
    expect(botEnrollment).toContain('authorKind: "bot"')

    const friendship = source("src/shared/src/db/queries/community/friendship.ts")
    expect(friendship.match(/authorKind: "bot"/g)).toHaveLength(2)
  })
})
