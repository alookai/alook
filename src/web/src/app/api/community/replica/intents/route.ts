import { NextRequest, NextResponse } from "next/server";
import {
  COMMUNITY_REPLICA_PROTOCOL_VERSION,
  communityReplicaIntentRequestSchema,
  communityReplicaIntentResponseSchema,
  queries,
  type CommunityReplicaIntentOutcome,
  type CommunityReplicaTextSendIntent,
} from "@alook/shared";
import { getPrimaryDb } from "@/lib/db";
import { withCommunityActor, rejectBot } from "@/lib/middleware/community-actor";
import { parseBody } from "@/lib/middleware/helpers";
import { resolveMessageTarget } from "@/lib/community/message-door";
import { createCommunityMessage } from "@/lib/community/message-handler";
import { checkRateLimit } from "@/lib/rate-limit";

function responseJson(data: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", ...headers },
  });
}

async function requestHash(intent: CommunityReplicaTextSendIntent): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(intent));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function conflictOutcome(intentId: string): CommunityReplicaIntentOutcome {
  return {
    intentId,
    status: "rejected",
    code: "conflict",
    reason: "intentId was already used for a different request",
  };
}

function outcomeFromRow(
  row: Awaited<ReturnType<typeof queries.communityReplicaStore.getReplicaIntent>>,
): CommunityReplicaIntentOutcome {
  if (!row) throw new Error("Replica intent outcome missing");
  if (row.status === "rejected") {
    return {
      intentId: row.intentId,
      status: "rejected",
      code: row.rejectionCode as "permission-denied" | "target-not-found" | "invalid" | "conflict",
      reason: row.reason ?? "intent rejected",
    };
  }
  if (
    (row.status !== "accepted" && row.status !== "transformed")
    || !row.causalId
    || !row.messageId
    || row.revision === null
    || row.seq === null
  ) {
    throw new Error("invalid persisted Replica intent outcome");
  }
  const canonical = {
    scope: { kind: "channel" as const, id: row.channelId },
    revision: row.revision,
    messageId: row.messageId,
    seq: row.seq,
  };
  return row.status === "transformed"
    ? {
        intentId: row.intentId,
        status: "transformed",
        causalId: row.causalId,
        canonical,
        reason: row.reason ?? "intent transformed",
      }
    : {
        intentId: row.intentId,
        status: "accepted",
        causalId: row.causalId,
        canonical,
      };
}

export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const denied = rejectBot(ctx.actor);
  if (denied) return denied;
  const [input, invalid] = await parseBody(req, communityReplicaIntentRequestSchema);
  if (invalid) return invalid;

  for (const _intent of input.intents) {
    const rateLimit = await checkRateLimit(ctx.env, "community:msgSend", ctx.actor.userId);
    if (!rateLimit.allowed) {
      return responseJson(
        { error: "rate limited" },
        429,
        { "Retry-After": String(rateLimit.retryAfterSec) },
      );
    }
  }

  const db = getPrimaryDb(ctx.env.DB);
  const outcomes: CommunityReplicaIntentOutcome[] = [];
  for (const intent of input.intents) {
    const hash = await requestHash(intent);
    const existing = await queries.communityReplicaStore.getReplicaIntent(
      db,
      ctx.actor.userId,
      intent.intentId,
    );
    if (existing) {
      outcomes.push(existing.requestHash === hash ? outcomeFromRow(existing) : conflictOutcome(intent.intentId));
      continue;
    }

    const resolved = await resolveMessageTarget(
      db,
      ctx.actor.userId,
      { id: intent.scope.id },
      "human",
    );
    if (!resolved.ok) {
      const stored = await queries.communityReplicaStore.rejectReplicaTextIntent(db, {
        actorId: ctx.actor.userId,
        intentId: intent.intentId,
        requestHash: hash,
        channelId: intent.scope.id,
        code: "permission-denied",
        reason: "target is no longer available",
        now: new Date().toISOString(),
      });
      outcomes.push(stored.requestHash === hash ? outcomeFromRow(stored) : conflictOutcome(intent.intentId));
      continue;
    }
    if (resolved.value.target.kind === "forum" || resolved.value.isDm) {
      const stored = await queries.communityReplicaStore.rejectReplicaTextIntent(db, {
        actorId: ctx.actor.userId,
        intentId: intent.intentId,
        requestHash: hash,
        channelId: intent.scope.id,
        code: "invalid",
        reason: "Replica v1 text send supports text channels and existing threads",
        now: new Date().toISOString(),
      });
      outcomes.push(stored.requestHash === hash ? outcomeFromRow(stored) : conflictOutcome(intent.intentId));
      continue;
    }

    const priorMessage = await queries.communityMessage.getMessageByAuthorAndNonce(
      db,
      ctx.actor.userId,
      intent.intentId,
    );
    if (
      priorMessage
      && (
        priorMessage.channelId !== intent.scope.id
        || priorMessage.content !== intent.payload.content
        || (priorMessage.replyToId ?? undefined) !== intent.payload.replyToId
        || (priorMessage.mentionType ?? undefined) !== intent.payload.mentionType
      )
    ) {
      const stored = await queries.communityReplicaStore.rejectReplicaTextIntent(db, {
        actorId: ctx.actor.userId,
        intentId: intent.intentId,
        requestHash: hash,
        channelId: intent.scope.id,
        code: "conflict",
        reason: "intentId collides with an existing message request",
        now: new Date().toISOString(),
      });
      outcomes.push(stored.requestHash === hash ? outcomeFromRow(stored) : conflictOutcome(intent.intentId));
      continue;
    }

    let replyToId = intent.payload.replyToId;
    let transformedReason: string | undefined;
    if (replyToId) {
      const reply = await queries.communityMessage.getMessageInScope(
        db,
        replyToId,
        { channelId: intent.scope.id },
      );
      if (!reply) {
        replyToId = undefined;
        transformedReason = "reply target was unavailable; sent as a plain message";
      }
    }
    const now = new Date().toISOString();
    const acceptedIntent = queries.communityReplicaStore.acceptReplicaTextIntentBuilder(db, {
      actorId: ctx.actor.userId,
      intentId: intent.intentId,
      requestHash: hash,
      channelId: intent.scope.id,
      status: transformedReason ? "transformed" : "accepted",
      reason: transformedReason,
      now,
    });

    if (!priorMessage) {
      const result = await createCommunityMessage({
        db,
        authorId: ctx.actor.userId,
        authorKind: "human",
        target: resolved.value.target,
        body: {
          content: intent.payload.content,
          ...(replyToId ? { replyToId } : {}),
          ...(intent.payload.mentionType ? { mentionType: intent.payload.mentionType } : {}),
        },
        source: "web",
        clientNonce: intent.intentId,
        extraStatements: [acceptedIntent],
      });
      if (!result.ok) {
        const code = result.status === 409 ? "conflict" : "invalid";
        const stored = await queries.communityReplicaStore.rejectReplicaTextIntent(db, {
          actorId: ctx.actor.userId,
          intentId: intent.intentId,
          requestHash: hash,
          channelId: intent.scope.id,
          code,
          reason: result.error,
          now,
        });
        outcomes.push(stored.requestHash === hash ? outcomeFromRow(stored) : conflictOutcome(intent.intentId));
        continue;
      }
    } else {
      try {
        await acceptedIntent;
      } catch (error) {
        const raced = await queries.communityReplicaStore.getReplicaIntent(
          db,
          ctx.actor.userId,
          intent.intentId,
        );
        if (!raced) throw error;
      }
    }

    const stored = await queries.communityReplicaStore.getReplicaIntent(
      db,
      ctx.actor.userId,
      intent.intentId,
    );
    if (!stored) throw new Error("Replica intent committed without an outcome");
    outcomes.push(stored.requestHash === hash ? outcomeFromRow(stored) : conflictOutcome(intent.intentId));
  }

  return responseJson(communityReplicaIntentResponseSchema.parse({
    protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
    outcomes,
  }));
});
