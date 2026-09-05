import { beforeEach, describe, expect, it } from "vitest"
import {
  getMessageOverlay,
  useMessageStreamStore,
} from "@/stores/community/message-stream"
import { materializeMessageStream } from "@/lib/community/message-stream"
import { hydrateCommunityReplicaIntents } from "./intent-hydration"
import type { ReplicaIntentRow } from "./store"

const user = {
  id: "viewer",
  name: "Ada",
  email: "ada@example.com",
  avatar: "A",
  avatarVersion: 0,
}

function row(channelId: string): ReplicaIntentRow {
  return {
    intentId: `intent-${channelId}`,
    intent: {
      intentId: `intent-${channelId}`,
      kind: "message.send",
      scope: { kind: "channel", id: channelId },
      createdAt: "2026-09-06T03:00:00.000+08:00",
      payload: { content: `message ${channelId}` },
    },
    state: "local-committed",
    outcome: null,
  }
}

beforeEach(() => {
  useMessageStreamStore.getState().resetAll()
})

describe("community Replica intent hydration", () => {
  it("hydrates only channels proven to belong to the current server projection", () => {
    hydrateCommunityReplicaIntents(
      user,
      [row("covered"), row("other-server")],
      "server-1",
      new Set(["covered"]),
    )

    const entries = useMessageStreamStore.getState().entries
    expect([...entries.keys()]).toEqual(["channel:covered"])
    expect(entries.get("channel:covered")?.scope).toEqual({
      kind: "channel",
      id: "covered",
      serverId: "server-1",
    })
  })

  it("hydrates a canonical rejection as terminal and preserves the server reason", () => {
    const rejected = row("covered")
    rejected.state = "canonical-rejected"
    rejected.outcome = {
      intentId: rejected.intentId,
      status: "rejected",
      code: "permission-denied",
      reason: "Channel access was revoked",
    }

    hydrateCommunityReplicaIntents(user, [rejected], "server-1", new Set(["covered"]))

    const scope = { kind: "channel" as const, id: "covered", serverId: "server-1" }
    const stream = useMessageStreamStore.getState()
    expect(stream.getRetryPayload(scope, rejected.intentId)).toBeUndefined()
    expect(materializeMessageStream([], getMessageOverlay(scope))[0]).toEqual(expect.objectContaining({
      content: "message covered",
      failed: false,
      sendError: "Channel access was revoked",
    }))
  })
})
