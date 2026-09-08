import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import {
  account,
  agent,
  agentRuntime,
  artifact,
  conversation,
  emails,
  issueComment,
  machine,
  machineToken,
  meetingSession,
  member,
  session,
  user,
  verification,
  workspace,
} from "../schema"
import {
  communityAttachment,
  communityChannel,
  communityFriendship,
  communityMention,
  communityMessage,
  communityReadState,
  communityServer,
  communityServerMember,
} from "../community-schema"
import {
  communityBotBinding,
  communityDiagnosticReport,
  communityMachineCredential,
} from "../community-machine-schema"
import type { Database } from "../index"
import { advanceReadStateRevisionsForUsersBuilder } from "./community/read-state"

const deviceCode = sqliteTable("deviceCode", {
  id: text("id").primaryKey(),
  userId: text("userId"),
})

export type DeletionChallenge = typeof verification.$inferSelect

export async function upsertDeletionChallenge(
  db: Database,
  input: DeletionChallenge,
): Promise<DeletionChallenge> {
  const rows = await db
    .insert(verification)
    .values(input)
    .onConflictDoUpdate({
      target: verification.id,
      set: {
        identifier: input.identifier,
        value: input.value,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      },
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error("account deletion challenge was not persisted")
  return row
}

export async function takeDeletionChallenge(
  db: Database,
  input: { id: string; identifier: string },
): Promise<DeletionChallenge | null> {
  const rows = await db
    .delete(verification)
    .where(and(
      eq(verification.id, input.id),
      eq(verification.identifier, input.identifier),
    ))
    .returning()
  return rows[0] ?? null
}

export async function restoreDeletionChallenge(
  db: Database,
  challenge: DeletionChallenge,
): Promise<boolean> {
  const rows = await db
    .insert(verification)
    .values(challenge)
    .onConflictDoNothing({ target: verification.id })
    .returning({ id: verification.id })
  return rows.length > 0
}

export async function deleteDeletionChallengeIfMatches(
  db: Database,
  challenge: DeletionChallenge,
): Promise<boolean> {
  const rows = await db
    .delete(verification)
    .where(and(
      eq(verification.id, challenge.id),
      eq(verification.identifier, challenge.identifier),
      eq(verification.value, challenge.value),
      eq(verification.expiresAt, challenge.expiresAt),
    ))
    .returning({ id: verification.id })
  return rows.length > 0
}

export type AccountDeletionIdentity = {
  id: string
  email: string
  isBot: boolean
  avatarObjectKey: string | null
}

export type AccountDeletionSnapshot = {
  identity: AccountDeletionIdentity
  identities: AccountDeletionIdentity[]
  providers: Array<{
    accountId: string
    providerId: string
    accessToken: string | null
    refreshToken: string | null
  }>
  ownedWorkspaceIds: string[]
  ownedAgentIds: string[]
  legacyDaemons: Array<{ workspaceId: string; daemonId: string }>
  machineTokens: string[]
  machineDoNames: string[]
  botBindings: Array<{ botId: string; machineId: string }>
  ownedServers: Array<{ id: string; icon: string | null; memberIds: string[] }>
  readStateUserIds: string[]
  media: {
    communityExactKeys: string[]
    communityPrefixes: string[]
    emailExactKeys: string[]
    emailPrefixes: string[]
    deletingEmailAttachments: string[]
    survivingEmailAttachments: string[]
    bugReportExactKeys: string[]
    bugReportPrefixes: string[]
  }
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))]
}

export async function getAccountDeletionSnapshot(
  db: Database,
  userId: string,
): Promise<AccountDeletionSnapshot | null> {
  const identitiesQuery = db
    .select({ id: user.id })
    .from(user)
    .where(or(
      eq(user.id, userId),
      and(eq(user.ownerUserId, userId), eq(user.isBot, true)),
    ))
  const ownedWorkspaceIdsQuery = db
    .select({ id: member.workspaceId })
    .from(member)
    .where(and(inArray(member.userId, identitiesQuery), eq(member.role, "owner")))
  const ownedAgentRowsQuery = db
    .select({ id: agent.id, workspaceId: agent.workspaceId })
    .from(agent)
    .where(or(
      inArray(agent.workspaceId, ownedWorkspaceIdsQuery),
      inArray(agent.ownerId, identitiesQuery),
    ))
  const ownedAgentIdsQuery = ownedAgentRowsQuery.as("owned_agent")
  const ownedServerIdsQuery = db
    .select({ id: communityServer.id })
    .from(communityServer)
    .where(inArray(communityServer.ownerId, identitiesQuery))
  const authoredMessageIdsQuery = db
    .select({ id: communityMessage.id })
    .from(communityMessage)
    .where(inArray(communityMessage.authorId, identitiesQuery))
  const authoredChannelIdsQuery = db
    .selectDistinct({ id: communityMessage.channelId })
    .from(communityMessage)
    .where(inArray(communityMessage.authorId, identitiesQuery))
  const doomedChannelIdsQuery = db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .where(or(
      inArray(communityChannel.serverId, ownedServerIdsQuery),
      inArray(communityChannel.parentMessageId, authoredMessageIdsQuery),
    ))
  const doomedMessageIdsQuery = db
    .select({ id: communityMessage.id })
    .from(communityMessage)
    .where(or(
      inArray(communityMessage.authorId, identitiesQuery),
      inArray(communityMessage.channelId, doomedChannelIdsQuery),
    ))
  const ownedConversationIdsQuery = db
    .select({ id: conversation.id })
    .from(conversation)
    .where(or(
      inArray(conversation.userId, identitiesQuery),
      inArray(conversation.workspaceId, ownedWorkspaceIdsQuery),
      inArray(conversation.agentId, db.select({ id: ownedAgentIdsQuery.id }).from(ownedAgentIdsQuery)),
    ))
  const affectedArtifactCondition = or(
    inArray(artifact.workspaceId, ownedWorkspaceIdsQuery),
    inArray(artifact.agentId, db.select({ id: ownedAgentIdsQuery.id }).from(ownedAgentIdsQuery)),
    inArray(artifact.conversationId, ownedConversationIdsQuery),
  )!
  const affectedEmailCondition = or(
    inArray(emails.workspaceId, ownedWorkspaceIdsQuery),
    inArray(emails.agentId, db.select({ id: ownedAgentIdsQuery.id }).from(ownedAgentIdsQuery)),
  )!
  const affectedMeetingCondition = or(
    inArray(meetingSession.workspaceId, ownedWorkspaceIdsQuery),
    inArray(meetingSession.agentId, db.select({ id: ownedAgentIdsQuery.id }).from(ownedAgentIdsQuery)),
  )!

  const [
    identities,
    providers,
    ownedWorkspaceRows,
    ownedAgentRows,
    legacyDaemons,
    machineTokens,
    machineCredentials,
    botBindings,
    serverRows,
    serverMemberRows,
    channelRows,
    impactedReadStateRows,
    impactedMentionRows,
    attachmentRows,
    artifactRows,
    deletingEmailRows,
    meetingRows,
    diagnosticRows,
  ] = await Promise.all([
    db.select({
      id: user.id,
      email: user.email,
      isBot: user.isBot,
      avatarObjectKey: user.avatarObjectKey,
    }).from(user).where(or(
      eq(user.id, userId),
      and(eq(user.ownerUserId, userId), eq(user.isBot, true)),
    )),
    db.select({
      accountId: account.accountId,
      providerId: account.providerId,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
    }).from(account).where(inArray(account.userId, identitiesQuery)),
    ownedWorkspaceIdsQuery,
    ownedAgentRowsQuery,
    db.select({ workspaceId: machine.workspaceId, daemonId: machine.daemonId })
      .from(machine)
      .where(or(
        inArray(machine.workspaceId, ownedWorkspaceIdsQuery),
        inArray(machine.ownerId, identitiesQuery),
      )),
    db.select({ token: machineToken.token })
      .from(machineToken)
      .where(or(
        inArray(machineToken.userId, identitiesQuery),
        inArray(machineToken.workspaceId, ownedWorkspaceIdsQuery),
      )),
    db.select({ doName: communityMachineCredential.doName })
      .from(communityMachineCredential)
      .where(inArray(communityMachineCredential.userId, identitiesQuery)),
    db.select({ botId: communityBotBinding.userId, machineId: communityBotBinding.machineId })
      .from(communityBotBinding)
      .where(inArray(communityBotBinding.userId, identitiesQuery)),
    db.select({ id: communityServer.id, icon: communityServer.icon })
      .from(communityServer)
      .where(inArray(communityServer.ownerId, identitiesQuery)),
    db.select({ serverId: communityServerMember.serverId, userId: communityServerMember.userId })
      .from(communityServerMember)
      .where(inArray(communityServerMember.serverId, ownedServerIdsQuery)),
    db.select({ id: communityChannel.id, type: communityChannel.type })
      .from(communityChannel)
      .where(inArray(communityChannel.id, doomedChannelIdsQuery)),
    db.selectDistinct({ userId: communityReadState.userId })
      .from(communityReadState)
      .innerJoin(user, eq(user.id, communityReadState.userId))
      .where(and(
        eq(user.isBot, false),
        isNull(user.deletedAt),
        or(
          inArray(communityReadState.channelId, doomedChannelIdsQuery),
          inArray(communityReadState.channelId, authoredChannelIdsQuery),
          inArray(communityReadState.lastReadMessageId, doomedMessageIdsQuery),
        ),
      )),
    db.selectDistinct({ userId: communityMention.userId })
      .from(communityMention)
      .innerJoin(user, eq(user.id, communityMention.userId))
      .where(and(
        eq(user.isBot, false),
        isNull(user.deletedAt),
        inArray(communityMention.messageId, doomedMessageIdsQuery),
      )),
    db.select({
      r2Key: communityAttachment.r2Key,
      thumbnailR2Key: communityAttachment.thumbnailR2Key,
    }).from(communityAttachment).where(or(
      inArray(communityAttachment.uploaderId, identitiesQuery),
      inArray(communityAttachment.targetId, doomedChannelIdsQuery),
      inArray(communityAttachment.messageId, doomedMessageIdsQuery),
    )),
    db.select({ r2Key: artifact.r2Key, thumbnailR2Key: artifact.thumbnailR2Key })
      .from(artifact)
      .where(affectedArtifactCondition),
    db.select({ r2Key: emails.r2Key, attachments: emails.attachments })
      .from(emails)
      .where(affectedEmailCondition),
    db.select({ transcriptR2Key: meetingSession.transcriptR2Key })
      .from(meetingSession)
      .where(affectedMeetingCondition),
    db.select({ r2Key: communityDiagnosticReport.r2Key })
      .from(communityDiagnosticReport)
      .where(inArray(communityDiagnosticReport.ownerUserId, identitiesQuery)),
  ])

  const candidateAttachmentKeys = unique(deletingEmailRows.flatMap((row) => {
    try {
      const parsed: unknown = JSON.parse(row.attachments)
      return Array.isArray(parsed)
        ? parsed.map((value) => value && typeof value === "object" && "key" in value
          ? (value as { key?: unknown }).key
          : null).filter((value): value is string => typeof value === "string")
        : []
    } catch {
      return []
    }
  }))
  const survivingEmailRows = candidateAttachmentKeys.length > 0
    ? await db.select({ attachments: emails.attachments })
      .from(emails)
      .where(and(
        sql<boolean>`NOT (${affectedEmailCondition})`,
        sql<boolean>`EXISTS (
          SELECT 1 FROM json_each(${emails.attachments}) AS attachment
          WHERE json_extract(attachment.value, '$.key') IN (
            SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(candidateAttachmentKeys)})
          )
        )`,
      ))
    : []

  const identity = identities.find((row) => row.id === userId)
  if (!identity || identity.isBot) return null
  const membersByServer = new Map<string, string[]>()
  for (const row of serverMemberRows) {
    const members = membersByServer.get(row.serverId) ?? []
    members.push(row.userId)
    membersByServer.set(row.serverId, members)
  }

  return {
    identity,
    identities,
    providers,
    ownedWorkspaceIds: ownedWorkspaceRows.map((row) => row.id),
    ownedAgentIds: ownedAgentRows.map((row) => row.id),
    legacyDaemons,
    machineTokens: unique(machineTokens.map((row) => row.token)),
    machineDoNames: unique(machineCredentials.map((row) => row.doName)),
    botBindings,
    ownedServers: serverRows.map((row) => ({
      ...row,
      memberIds: unique(membersByServer.get(row.id) ?? []),
    })),
    readStateUserIds: unique([
      ...impactedReadStateRows.map((row) => row.userId),
      ...impactedMentionRows.map((row) => row.userId),
    ]).filter((id) => id !== userId),
    media: {
      communityExactKeys: unique([
        ...identities.map((row) => `${row.isBot ? "bot" : "user"}-avatar/${row.id}`),
        ...identities.map((row) => row.avatarObjectKey),
        ...serverRows.map((row) => row.icon),
        ...attachmentRows.flatMap((row) => [row.r2Key, row.thumbnailR2Key]),
      ]),
      communityPrefixes: unique([
        ...identities.map((row) => `${row.isBot ? "bot" : "user"}-avatar/${row.id}/`),
        ...serverRows.map((row) => `server-icon/${row.id}/`),
        ...channelRows.map((row) => `${row.type === "dm" ? "dm" : row.type === "thread" ? "thread" : "channel"}/${row.id}/`),
      ]),
      emailExactKeys: unique([
        ...artifactRows.flatMap((row) => [row.r2Key, row.thumbnailR2Key]),
        ...deletingEmailRows.map((row) => row.r2Key),
        ...meetingRows.map((row) => row.transcriptR2Key),
      ]),
      emailPrefixes: ownedWorkspaceRows.map((row) => `artifacts/${row.id}/`),
      deletingEmailAttachments: deletingEmailRows.map((row) => row.attachments),
      survivingEmailAttachments: survivingEmailRows.map((row) => row.attachments),
      bugReportExactKeys: unique(diagnosticRows.map((row) => row.r2Key)),
      bugReportPrefixes: identities.map((row) => `bug-reports/${row.id}/`),
    },
  }
}

export async function deleteAccountRows(
  db: Database,
  snapshot: AccountDeletionSnapshot,
): Promise<{ deleted: boolean; readStateRevisions: Array<{ userId: string; revision: number }> }> {
  const userId = snapshot.identity.id
  const identitiesQuery = db
    .select({ id: user.id })
    .from(user)
    .where(or(
      eq(user.id, userId),
      and(eq(user.ownerUserId, userId), eq(user.isBot, true)),
    ))
  const ownedWorkspaceIdsQuery = db
    .select({ id: member.workspaceId })
    .from(member)
    .where(and(inArray(member.userId, identitiesQuery), eq(member.role, "owner")))
  const ownedAgentIdsQuery = db
    .select({ id: agent.id })
    .from(agent)
    .where(or(
      inArray(agent.workspaceId, ownedWorkspaceIdsQuery),
      inArray(agent.ownerId, identitiesQuery),
    ))
  const ownedServerIdsQuery = db
    .select({ id: communityServer.id })
    .from(communityServer)
    .where(inArray(communityServer.ownerId, identitiesQuery))
  const authoredMessagesQuery = db
    .select({ id: communityMessage.id })
    .from(communityMessage)
    .where(inArray(communityMessage.authorId, identitiesQuery))
  const doomedChannelIdsQuery = db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .where(or(
      inArray(communityChannel.serverId, ownedServerIdsQuery),
      inArray(communityChannel.parentMessageId, authoredMessagesQuery),
    ))
  const affectedChannelIdsQuery = db
    .select({ id: communityMessage.channelId })
    .from(communityMessage)
    .where(inArray(communityMessage.authorId, identitiesQuery))
  const ownedRuntimeIdsQuery = db
    .select({ id: agentRuntime.id })
    .from(agentRuntime)
    .innerJoin(machine, and(
      eq(machine.workspaceId, agentRuntime.workspaceId),
      eq(machine.daemonId, agentRuntime.daemonId),
    ))
    .where(inArray(machine.ownerId, identitiesQuery))

  const statements = [
    db.update(communityChannel).set({
      messageCount: sql<number>`(
        SELECT COUNT(*) FROM ${communityMessage} AS remaining_message
        WHERE remaining_message.channel_id = ${communityChannel.id}
          AND remaining_message.author_id NOT IN (${identitiesQuery})
      )`,
      lastMessageAt: sql<string | null>`(
        SELECT MAX(remaining_message.created_at) FROM ${communityMessage} AS remaining_message
        WHERE remaining_message.channel_id = ${communityChannel.id}
          AND remaining_message.author_id NOT IN (${identitiesQuery})
      )`,
    }).where(and(
      inArray(communityChannel.id, affectedChannelIdsQuery),
      or(isNull(communityChannel.serverId), sql`${communityChannel.serverId} NOT IN (${ownedServerIdsQuery})`),
    )),
    db.update(communityReadState).set({
      lastReadMessageId: sql<string>`(
        SELECT remaining_message.id FROM ${communityMessage} AS remaining_message
        WHERE remaining_message.channel_id = ${communityReadState.channelId}
          AND remaining_message.seq <= ${communityReadState.lastReadSeq}
          AND remaining_message.author_id NOT IN (${identitiesQuery})
        ORDER BY remaining_message.seq DESC LIMIT 1
      )`,
      lastReadSeq: sql<number>`(
        SELECT remaining_message.seq FROM ${communityMessage} AS remaining_message
        WHERE remaining_message.channel_id = ${communityReadState.channelId}
          AND remaining_message.seq <= ${communityReadState.lastReadSeq}
          AND remaining_message.author_id NOT IN (${identitiesQuery})
        ORDER BY remaining_message.seq DESC LIMIT 1
      )`,
      lastReadAt: sql<string>`(
        SELECT remaining_message.created_at FROM ${communityMessage} AS remaining_message
        WHERE remaining_message.channel_id = ${communityReadState.channelId}
          AND remaining_message.seq <= ${communityReadState.lastReadSeq}
          AND remaining_message.author_id NOT IN (${identitiesQuery})
        ORDER BY remaining_message.seq DESC LIMIT 1
      )`,
    }).where(and(
      inArray(communityReadState.lastReadMessageId, authoredMessagesQuery),
      sql<boolean>`EXISTS (
        SELECT 1 FROM ${communityMessage} AS remaining_message
        WHERE remaining_message.channel_id = ${communityReadState.channelId}
          AND remaining_message.seq <= ${communityReadState.lastReadSeq}
          AND remaining_message.author_id NOT IN (${identitiesQuery})
      )`,
    )),
    db.delete(communityReadState).where(and(
      inArray(communityReadState.lastReadMessageId, authoredMessagesQuery),
      sql<boolean>`NOT EXISTS (
        SELECT 1 FROM ${communityMessage} AS remaining_message
        WHERE remaining_message.channel_id = ${communityReadState.channelId}
          AND remaining_message.seq <= ${communityReadState.lastReadSeq}
          AND remaining_message.author_id NOT IN (${identitiesQuery})
      )`,
    )),
    ...(snapshot.readStateUserIds.length > 0
      ? [advanceReadStateRevisionsForUsersBuilder(
        db,
        snapshot.readStateUserIds,
        sql<boolean>`EXISTS (
          SELECT 1 FROM ${user} AS revision_user
          WHERE revision_user.id = CAST(value AS TEXT)
            AND revision_user.isBot = 0
            AND revision_user.deletedAt IS NULL
        )`,
      )]
      : []),
    db.delete(issueComment).where(or(
      and(eq(issueComment.authorType, "user"), inArray(issueComment.authorId, identitiesQuery)),
      and(eq(issueComment.authorType, "agent"), inArray(issueComment.authorId, ownedAgentIdsQuery)),
    )),
    db.update(agent).set({ runtimeId: null }).where(inArray(agent.runtimeId, ownedRuntimeIdsQuery)),
    db.delete(agentRuntime).where(inArray(agentRuntime.id, ownedRuntimeIdsQuery)),
    db.delete(machine).where(inArray(machine.ownerId, identitiesQuery)),
    db.delete(workspace).where(inArray(workspace.id, ownedWorkspaceIdsQuery)),
    db.delete(agent).where(inArray(agent.ownerId, identitiesQuery)),
    db.delete(communityAttachment).where(and(
      isNull(communityAttachment.messageId),
      inArray(communityAttachment.targetId, doomedChannelIdsQuery),
    )),
    db.delete(communityServer).where(inArray(communityServer.ownerId, identitiesQuery)),
    db.delete(communityAttachment).where(inArray(communityAttachment.uploaderId, identitiesQuery)),
    db.delete(communityDiagnosticReport).where(inArray(communityDiagnosticReport.ownerUserId, identitiesQuery)),
    db.delete(communityFriendship).where(inArray(communityFriendship.needsOwnerApproval, identitiesQuery)),
    db.delete(deviceCode).where(inArray(deviceCode.userId, identitiesQuery)),
    db.delete(verification).where(or(
      inArray(verification.identifier, db
        .select({ identifier: sql<string>`'sign-in-otp-' || lower(${user.email})` })
        .from(user)
        .where(inArray(user.id, identitiesQuery))),
      inArray(verification.identifier, db
        .select({ identifier: sql<string>`'email-verification-otp-' || lower(${user.email})` })
        .from(user)
        .where(inArray(user.id, identitiesQuery))),
      inArray(verification.identifier, db
        .select({ identifier: sql<string>`'forget-password-otp-' || lower(${user.email})` })
        .from(user)
        .where(inArray(user.id, identitiesQuery))),
      inArray(verification.identifier, db
        .select({ identifier: sql<string>`'change-email-otp-' || lower(${user.email})` })
        .from(user)
        .where(inArray(user.id, identitiesQuery))),
      inArray(verification.identifier, db
        .select({ identifier: sql<string>`'account-deletion-otp:' || ${user.id} || ':' || lower(${user.email})` })
        .from(user)
        .where(inArray(user.id, identitiesQuery))),
      and(
        sql<boolean>`${verification.identifier} LIKE 'one-time-token:%'`,
        inArray(verification.value, db
          .select({ token: session.token })
          .from(session)
          .where(inArray(session.userId, identitiesQuery))),
      ),
    )),
    db.delete(user).where(and(eq(user.ownerUserId, userId), eq(user.isBot, true))),
    db.delete(user).where(and(eq(user.id, userId), eq(user.isBot, false))).returning({ id: user.id }),
  ]

  const results = await db.batch(statements as any) as unknown[]
  const revisionIndex = 3
  const deleteIndex = statements.length - 1
  const deletedRows = results[deleteIndex] as Array<{ id: string }>
  return {
    deleted: deletedRows.length > 0,
    readStateRevisions: snapshot.readStateUserIds.length > 0
      ? results[revisionIndex] as Array<{ userId: string; revision: number }>
      : [],
  }
}
