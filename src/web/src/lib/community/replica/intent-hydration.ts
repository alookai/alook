import { tempMessageId } from "@/hooks/community/mutations"
import { isMentionType } from "@alook/shared"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import type { ReplicaSessionUser } from "./session"
import type { ReplicaIntentRow } from "./store"

export function hydrateCommunityReplicaIntents(
  user: ReplicaSessionUser,
  intents: ReplicaIntentRow[],
  serverId: string,
  coveredChannelIds: ReadonlySet<string>,
) {
  const stream = useMessageStreamStore.getState()
  for (const row of intents) {
    const intent = row.intent
    if (!coveredChannelIds.has(intent.scope.id)) continue
    const scope = { kind: "channel" as const, id: intent.scope.id, serverId }
    const accepted = stream.accept(scope, {
      nonce: intent.intentId,
      tempId: tempMessageId(),
      message: {
        type: "chat",
        authorId: user.id,
        authorName: user.name,
        authorAvatar: user.avatar,
        content: intent.payload.content,
        createdAt: intent.createdAt,
      },
      localUploads: [],
      mentionType: isMentionType(intent.payload.mentionType)
        ? intent.payload.mentionType
        : undefined,
    })
    if (accepted && row.state === "canonical-rejected") {
      stream.dispatch(scope, {
        type: "canonicalReject",
        nonce: intent.intentId,
        reason: row.outcome?.status === "rejected"
          ? row.outcome.reason
          : "Message was rejected",
      })
    }
  }
}
