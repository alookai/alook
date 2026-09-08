import { createLogger, queries, WS_EVENTS, type Database } from "@alook/shared"
import { cacheKeys, invalidateMany } from "@/lib/cache"
import { getPrimaryDb } from "@/lib/db"
import { broadcastToDaemon } from "@/lib/broadcast"
import { pushBotEventToMachine } from "@/lib/community/bot-push"
import { fanOutToUsers, broadcastToUserSafe } from "@/lib/community/fanout"
import { forceCloseCommunityMachinesByDoNames } from "@/lib/community/machine-disconnect"
import { deleteAccountStorage } from "./storage"
import { revokeProviderAccount } from "./provider-revocation"

const log = createLogger({ service: "account-deletion" })

export type ExecuteAccountDeletionResult =
  | { kind: "deleted" }
  | { kind: "missing" }
  | { kind: "failed" }

async function invalidateMachineTokens(tokens: string[]): Promise<void> {
  await invalidateMany(tokens.map((token) => cacheKeys.machineToken(token))).catch(() => {})
}

function scheduleAfterCommit(
  env: Env,
  executionContext: Pick<ExecutionContext, "waitUntil">,
  snapshot: queries.accountDeletion.AccountDeletionSnapshot,
  readStateRevisions: Array<{ userId: string; revision: number }>,
): void {
  const work = Promise.allSettled([
    forceCloseCommunityMachinesByDoNames(env, snapshot.machineDoNames),
    ...snapshot.botBindings.map((binding) => pushBotEventToMachine(env, binding.machineId, {
      type: "bot:removed",
      botId: binding.botId,
    })),
    ...snapshot.legacyDaemons.map((daemon) => broadcastToDaemon(daemon.daemonId, {
      type: "daemon.evict",
      workspaceId: daemon.workspaceId,
    })),
    ...snapshot.ownedServers.map((server) => fanOutToUsers(server.memberIds, {
      type: WS_EVENTS.SERVER_DELETE,
      serverId: server.id,
    })),
    ...readStateRevisions.map((revision) => broadcastToUserSafe(revision.userId, {
      type: WS_EVENTS.READ_STATE_ADVANCED,
      revision: revision.revision,
      inboxChanged: true,
    })),
    ...snapshot.providers
      .filter((provider) => provider.providerId !== "apple")
      .map((provider) => revokeProviderAccount(env, provider)),
  ]).then((results) => {
    const failures = results.filter((result) => result.status === "rejected").length
    if (failures > 0) log.warn("account_deletion_post_commit_effects_failed", { failures })
  })
  try {
    executionContext.waitUntil(work)
  } catch {
    log.warn("account_deletion_wait_until_unavailable")
  }
}

export async function executeAccountDeletion(
  db: Database,
  env: Env,
  executionContext: Pick<ExecutionContext, "waitUntil">,
  userId: string,
): Promise<ExecuteAccountDeletionResult> {
  try {
    const firstSnapshot = await queries.accountDeletion.getAccountDeletionSnapshot(db, userId)
    if (!firstSnapshot) return { kind: "missing" }
    await deleteAccountStorage(env, firstSnapshot)

    const finalDb = getPrimaryDb(env.DB)
    const finalSnapshot = await queries.accountDeletion.getAccountDeletionSnapshot(finalDb, userId)
    if (!finalSnapshot) {
      await invalidateMachineTokens(firstSnapshot.machineTokens)
      return { kind: "missing" }
    }
    const machineTokens = [...new Set([
      ...firstSnapshot.machineTokens,
      ...finalSnapshot.machineTokens,
    ])]
    await deleteAccountStorage(env, finalSnapshot)
    await Promise.all(
      finalSnapshot.providers
        .filter((provider) => provider.providerId === "apple")
        .map((provider) => revokeProviderAccount(env, provider)),
    )

    let deletion: Awaited<ReturnType<typeof queries.accountDeletion.deleteAccountRows>>
    try {
      deletion = await queries.accountDeletion.deleteAccountRows(finalDb, finalSnapshot)
    } catch (error) {
      const remaining = await queries.user.getUserInternal(getPrimaryDb(env.DB), userId)
      if (remaining) throw error
      await invalidateMachineTokens(machineTokens)
      scheduleAfterCommit(env, executionContext, finalSnapshot, [])
      return { kind: "deleted" }
    }
    if (!deletion.deleted) {
      const remaining = await queries.user.getUserInternal(getPrimaryDb(env.DB), userId)
      if (remaining) return { kind: "failed" }
    }

    await invalidateMachineTokens(machineTokens)
    scheduleAfterCommit(env, executionContext, finalSnapshot, deletion.readStateRevisions)
    return { kind: "deleted" }
  } catch (error) {
    log.warn("account_deletion_failed", {
      errorCategory: error instanceof Error ? error.name : "NonError",
    })
    return { kind: "failed" }
  }
}
