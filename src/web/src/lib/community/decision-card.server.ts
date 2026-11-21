import {
  DECISION_CARD_MESSAGE_TYPE,
  buildDecisionCardEmbed,
  formatDecisionCardSummary,
  formatHandle,
  parseNameAndTag,
  queries,
  toDecisionCardAgentPayload,
  withD1Retry,
  type Database,
  type DecisionCardAgentPayload,
  type DecisionCardAssignee,
  type DecisionCardInput,
} from "@alook/shared"
import type { MessageTarget } from "./message-handler"
import { readCommunityResourceProfiles } from "./resource-profiles.server"

export type PreparedBotDecisionCard =
  | {
    ok: true
    content: string
    embeds: string
    type: typeof DECISION_CARD_MESSAGE_TYPE
    explicitMentionedUserIds: string[]
    questionPayload: DecisionCardAgentPayload
  }
  | { ok: false; status: 400; error: string }

function parseMentionHandle(raw: string): { name: string; discriminator: string; key: string } | null {
  const trimmed = raw.trim()
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed
  const parsed = parseNameAndTag(withoutAt)
  if (!parsed) return null
  return {
    name: parsed.name,
    discriminator: parsed.discriminator,
    key: `${parsed.name.toLowerCase()}#${parsed.discriminator}`,
  }
}

export async function prepareBotDecisionCard(
  db: Database,
  target: MessageTarget,
  question: DecisionCardInput,
): Promise<PreparedBotDecisionCard> {
  if (target.kind === "forum") {
    return {
      ok: false,
      status: 400,
      error: "decision cards cannot open a forum post; send inside the post thread instead",
    }
  }

  let assignees: DecisionCardAssignee[] = []
  let explicitMentionedUserIds: string[] = []

  if (target.kind === "dm") {
    const profiles = await withD1Retry(
      () => readCommunityResourceProfiles(db, [target.otherUserId]),
      { route: "decision-card:dm-peer" },
    )
    const peer = profiles[0]
    const handle = peer?.name && peer.discriminator
      ? formatHandle(peer.name, peer.discriminator)
      : target.otherUserId
    assignees = [{ userId: target.otherUserId, handle }]
  } else if (question.mentions && question.mentions.length > 0) {
    const parsedMentions: Array<{ raw: string; name: string; discriminator: string; key: string }> = []
    for (const rawMention of question.mentions) {
      const parsed = parseMentionHandle(rawMention)
      if (!parsed) {
        return {
          ok: false,
          status: 400,
          error: `mention "${rawMention}" must be a handle like "@alice#0001"`,
        }
      }
      parsedMentions.push({ raw: rawMention, ...parsed })
    }

    const candidates = await withD1Retry(
      () => queries.communityMember.findServerMembersByHandles(db, target.serverId, parsedMentions),
      { route: "decision-card:find-members-by-handles" },
    )
    const visibleUserIds = await withD1Retry(
      () => queries.communityChannel.filterChannelVisibleUserIds(
        db,
        target.channelId,
        candidates.map((candidate) => candidate.userId),
      ),
      { route: "decision-card:filter-channel-visible" },
    )

    const byHandle = new Map<string, DecisionCardAssignee>()
    for (const member of candidates) {
      if (!visibleUserIds.has(member.userId)) continue
      const handle = formatHandle(member.userName, member.discriminator)
      const key = handle.toLowerCase()
      if (!byHandle.has(key)) byHandle.set(key, { userId: member.userId, handle })
    }

    const seen = new Set<string>()
    for (const mention of parsedMentions) {
      const match = byHandle.get(mention.key)
      if (!match) {
        return {
          ok: false,
          status: 400,
          error: `mention "${mention.raw}" is not a member of this channel`,
        }
      }
      if (!seen.has(match.userId)) {
        seen.add(match.userId)
        assignees.push(match)
      }
    }
    explicitMentionedUserIds = assignees.map((assignee) => assignee.userId)
  }

  const embed = buildDecisionCardEmbed(question, assignees)
  return {
    ok: true,
    content: formatDecisionCardSummary(embed),
    embeds: JSON.stringify([embed]),
    type: DECISION_CARD_MESSAGE_TYPE,
    explicitMentionedUserIds,
    questionPayload: toDecisionCardAgentPayload(embed),
  }
}
