import { NextResponse } from "next/server"
import { queries } from "@alook/shared"
import type { Database } from "@alook/shared"

/**
 * A bot must be caught up on a scope before it may post into it: if the scope
 * has messages the bot hasn't consumed (`latestSeq > seen`), the send is
 * refused with a `blocked`/`unaligned` envelope so the bot pulls and re-reads
 * before speaking. There is no bypass — a bot that omits `seenUpToSeq` is
 * checked against its own tracked `lastReadSeq`, never allowed to skip the gate
 * by not sending the field. Humans are not gated (they see the channel and
 * decide for themselves).
 */
interface AlignmentBlocked {
  state: "blocked"
  reason: "unaligned"
  unreadCount: number
  latestSeq: number
}

/**
 * Returns the `seen` waterline the caller passes to `createCommunityMessage`'s
 * `expectedSeq`, plus a pre-built `blocked` response when the scope is already
 * ahead of the bot. `blocked !== null` ⇒ the caller returns it verbatim and
 * does NOT send. `blocked === null` ⇒ aligned; send with `expectedSeq: latestSeq`.
 */
export async function checkBotAlignment(
  db: Database,
  botUserId: string,
  target: { channelId?: string; dmConversationId?: string },
  seenUpToSeq: number | undefined,
): Promise<{ latestSeq: number; seen: number; blocked: NextResponse | null }> {
  const scopeKey = queries.communityMessage.scopeKeyForTarget(target)
  const [latestSeq, readState] = await Promise.all([
    queries.communityAgentInbox.getLatestSeqForScope(db, scopeKey),
    queries.communityReadState.getReadState(db, { userId: botUserId, ...target }),
  ])
  const seen = seenUpToSeq ?? readState?.lastReadSeq ?? 0
  if (latestSeq > seen) {
    const body: AlignmentBlocked = {
      state: "blocked",
      reason: "unaligned",
      unreadCount: latestSeq - seen,
      latestSeq,
    }
    return { latestSeq, seen, blocked: NextResponse.json(body) }
  }
  return { latestSeq, seen, blocked: null }
}

/** Build the `blocked` envelope from a freshly re-read `latestSeq` (409 race). */
export function alignmentBlockedResponse(latestSeq: number, seen: number): NextResponse {
  const body: AlignmentBlocked = {
    state: "blocked",
    reason: "unaligned",
    unreadCount: Math.max(0, latestSeq - seen),
    latestSeq,
  }
  return NextResponse.json(body)
}
