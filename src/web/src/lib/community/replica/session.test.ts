import "fake-indexeddb/auto"
import { afterEach, describe, expect, it } from "vitest"
import { COMMUNITY_REPLICA_PROTOCOL_VERSION } from "@alook/shared"
import { replaceCommunityReplicaBootstrap } from "./store"
import {
  clearActiveCommunityReplicaSession,
  communityReplicaRouteScopes,
  markCommunityReplicaShellRoute,
  publishCommunityReplicaSession,
  readActiveCommunityReplicaSession,
} from "./session"

const user = {
  id: "account-session",
  name: "Ada",
  email: "ada@example.com",
  avatar: "A",
  avatarVersion: 0,
}
const checkedAt = "2026-09-06T03:00:00.000+08:00"
const validUntil = "2026-09-07T03:00:00.000+08:00"
const route = "/c/channels/server-1/channel-1"

function bootstrap() {
  const scopes = communityReplicaRouteScopes(user.id, route)!
  return {
    protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
    snapshotId: "snapshot-session",
    takenAt: checkedAt,
    frontier: scopes.map((scope, index) => ({ scope, revision: index + 1 })),
    coverage: scopes.map((scope, index) => ({
      scope,
      revision: index + 1,
      completeness: scope.kind === "channel" ? "partial" as const : "complete" as const,
      permission: { epoch: `${scope.kind}-lease`, checkedAt, validUntil },
      messageRange: scope.kind === "channel"
        ? { firstSeq: 1, lastSeq: 1, hasOlder: false, hasNewer: false }
        : null,
    })),
    facts: [{
      scope: scopes[2]!,
      entity: { kind: "message" as const, id: "message-1" },
      value: {
        id: "message-1",
        channelId: "channel-1",
        type: "chat" as const,
        authorId: "author-1",
        authorName: "Author",
        authorAvatar: "A",
        authorAvatarVersion: 0,
        seq: 1,
        createdAt: checkedAt,
        content: "hello",
      },
    }],
  }
}

afterEach(async () => {
  await clearActiveCommunityReplicaSession()
})

describe("community Replica session", () => {
  it("derives only the server vertical-slice scopes", () => {
    expect(communityReplicaRouteScopes(user.id, route)).toEqual([
      { kind: "account", id: user.id },
      { kind: "server", id: "server-1" },
      { kind: "channel", id: "channel-1" },
    ])
    expect(communityReplicaRouteScopes(user.id, "/c/me/friends")).toBeNull()
  })

  it("publishes an offline identity only for a ready shell and unexpired coherent projection", async () => {
    await replaceCommunityReplicaBootstrap(user.id, bootstrap())
    await publishCommunityReplicaSession(user, route, Date.parse(checkedAt) + 1)

    const launch = await readActiveCommunityReplicaSession(route, Date.parse(checkedAt) + 1)
    expect(launch?.user).toEqual(user)
    expect(launch?.projection.meta.snapshotId).toBe("snapshot-session")
    await expect(readActiveCommunityReplicaSession(route, Date.parse(validUntil))).resolves.toBeNull()
    await expect(readActiveCommunityReplicaSession("/c/channels/server-1/other", Date.parse(checkedAt) + 1)).resolves.toBeNull()
  })

  it("marks a subsequently cached route without widening data coverage", async () => {
    await replaceCommunityReplicaBootstrap(user.id, bootstrap())
    await publishCommunityReplicaSession(user, route, Date.parse(checkedAt) + 1)
    await markCommunityReplicaShellRoute(user.id, "/c/channels/server-1")
    await publishCommunityReplicaSession(user, route, Date.parse(checkedAt) + 1)

    await expect(readActiveCommunityReplicaSession("/c/channels/server-1", Date.parse(checkedAt) + 1)).resolves.not.toBeNull()
    await expect(readActiveCommunityReplicaSession("/c/channels/server-1/other", Date.parse(checkedAt) + 1)).resolves.toBeNull()
  })

  it("launches from a newer coherent snapshot without requiring a route republish", async () => {
    await replaceCommunityReplicaBootstrap(user.id, bootstrap())
    await publishCommunityReplicaSession(user, route, Date.parse(checkedAt) + 1)
    await replaceCommunityReplicaBootstrap(user.id, {
      ...bootstrap(),
      snapshotId: "snapshot-session-next",
    })

    const launch = await readActiveCommunityReplicaSession(route, Date.parse(checkedAt) + 1)
    expect(launch?.projection.meta.snapshotId).toBe("snapshot-session-next")
  })

  it("makes the old account inaccessible before an account switch", async () => {
    await replaceCommunityReplicaBootstrap(user.id, bootstrap())
    await publishCommunityReplicaSession(user, route, Date.parse(checkedAt) + 1)
    await clearActiveCommunityReplicaSession(user.id)

    await expect(readActiveCommunityReplicaSession(route, Date.parse(checkedAt) + 1)).resolves.toBeNull()
  })
})
