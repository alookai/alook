import { z } from "zod";
import {
  CommunityWsEventSchema,
  isValidCommunityUserTarget,
  utf8ByteLength,
} from "./community-ws-events";
import type {
  CommunityChildChannelUpdate,
  CommunityMessageCreate,
} from "./community-ws-events";

export const MESSAGE_DELIVERY_MAX_USERS = 1_000;
export const MESSAGE_DELIVERY_BODY_MAX_BYTES = 837_347;
export const MESSAGE_DELIVERY_MAX_EVENTS_PER_USER = 5;

export type MessageDeliveryMemberAdded = {
  userId: string;
  serverId: string;
  channelId: string;
};

export type MessageDeliveryBatch = {
  messageId: string;
  messageEvent: CommunityMessageCreate;
  contentUserIds: string[];
  unreadPlainUserIds: string[];
  unreadMentionUserIds: string[];
  mentionUserIds: string[];
  memberAdded?: MessageDeliveryMemberAdded;
  parentProjection?: CommunityChildChannelUpdate;
  parentProjectionUserIds?: string[];
};

export type MessageDeliveryPartial = { failedUserIds: string[] };

const target = z.string().refine(isValidCommunityUserTarget);
const targetList = z.array(target).max(MESSAGE_DELIVERY_MAX_USERS);
const memberAddedSchema = z.strictObject({
  userId: target,
  serverId: z.string().min(1),
  channelId: z.string().min(1),
});

const batchShape = z.strictObject({
  messageId: z.string().min(1),
  messageEvent: z.unknown(),
  contentUserIds: targetList,
  unreadPlainUserIds: targetList,
  unreadMentionUserIds: targetList,
  mentionUserIds: targetList,
  memberAdded: memberAddedSchema.optional(),
  parentProjection: z.unknown().optional(),
  parentProjectionUserIds: targetList.optional(),
});

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function isSubset(values: readonly string[], allowed: ReadonlySet<string>): boolean {
  return values.every((value) => allowed.has(value));
}

export type MessageDeliveryBatchParseResult =
  | { ok: true; batch: MessageDeliveryBatch }
  | { ok: false; reason: "invalid-payload" | "too-many-targets" | "oversized" };

export function parseMessageDeliveryBatch(value: unknown): MessageDeliveryBatchParseResult {
  const outer = batchShape.safeParse(value);
  if (!outer.success) return { ok: false, reason: "invalid-payload" };
  const data = outer.data;
  const message = CommunityWsEventSchema.safeParse(data.messageEvent);
  if (!message.success || message.data.type !== "community:message.create") {
    return { ok: false, reason: "invalid-payload" };
  }
  if (message.data.message.id !== data.messageId) {
    return { ok: false, reason: "invalid-payload" };
  }

  let parentProjection: CommunityChildChannelUpdate | undefined;
  if (data.parentProjection !== undefined) {
    const parsed = CommunityWsEventSchema.safeParse(data.parentProjection);
    if (!parsed.success || parsed.data.type !== "community:channel.child_update") {
      return { ok: false, reason: "invalid-payload" };
    }
    parentProjection = parsed.data;
  }
  if ((parentProjection === undefined) !== (data.parentProjectionUserIds === undefined)) {
    return { ok: false, reason: "invalid-payload" };
  }
  if (
    parentProjection
    && (
      parentProjection.channelId !== message.data.channelId
      || message.data.parentChannelId !== parentProjection.parentChannelId
    )
  ) {
    return { ok: false, reason: "invalid-payload" };
  }

  const lists = [
    data.contentUserIds,
    data.unreadPlainUserIds,
    data.unreadMentionUserIds,
    data.mentionUserIds,
    data.parentProjectionUserIds ?? [],
  ];
  if (lists.some(hasDuplicates)) return { ok: false, reason: "invalid-payload" };
  const content = new Set(data.contentUserIds);
  if (!isSubset(data.unreadPlainUserIds, content)) return { ok: false, reason: "invalid-payload" };
  if (!isSubset(data.unreadMentionUserIds, content)) return { ok: false, reason: "invalid-payload" };
  const unreadMention = new Set(data.unreadMentionUserIds);
  if (data.unreadPlainUserIds.some((id) => unreadMention.has(id))) {
    return { ok: false, reason: "invalid-payload" };
  }
  if (data.memberAdded) {
    if (
      !content.has(data.memberAdded.userId)
      || message.data.serverId === undefined
      || data.memberAdded.channelId !== message.data.channelId
      || data.memberAdded.serverId !== message.data.serverId
    ) {
      return { ok: false, reason: "invalid-payload" };
    }
  }

  const allTargets = new Set(lists.flat());
  if (allTargets.size > MESSAGE_DELIVERY_MAX_USERS) {
    return { ok: false, reason: "too-many-targets" };
  }
  const encoded = JSON.stringify(value);
  if (utf8ByteLength(encoded) > MESSAGE_DELIVERY_BODY_MAX_BYTES) {
    return { ok: false, reason: "oversized" };
  }

  return {
    ok: true,
    batch: {
      messageId: data.messageId,
      messageEvent: message.data,
      contentUserIds: data.contentUserIds,
      unreadPlainUserIds: data.unreadPlainUserIds,
      unreadMentionUserIds: data.unreadMentionUserIds,
      mentionUserIds: data.mentionUserIds,
      ...(data.memberAdded ? { memberAdded: data.memberAdded } : {}),
      ...(parentProjection ? { parentProjection } : {}),
      ...(data.parentProjectionUserIds
        ? { parentProjectionUserIds: data.parentProjectionUserIds }
        : {}),
    },
  };
}

export function serializeMessageDeliveryBatch(batch: MessageDeliveryBatch): string {
  const parsed = parseMessageDeliveryBatch(batch);
  if (!parsed.ok) throw new Error(`invalid message delivery batch: ${parsed.reason}`);
  return JSON.stringify(parsed.batch);
}
