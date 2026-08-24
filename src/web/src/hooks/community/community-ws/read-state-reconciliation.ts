import { notifyManager, type QueryClient, type QueryKey } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

type AccountReadState = {
  channelId: string
  lastReadMessageId: string | null
  lastReadAt: string
  lastReadSeq: number
}

export type AccountReadStateSnapshot = {
  revision: number
  readStates: AccountReadState[]
}

export type ReadStateEnvelope = {
  revision: number
  inboxChanged: true
}

const emptyReadState = {
  lastReadMessageId: null,
  lastReadAt: null,
  lastReadSeq: 0,
}

function cachedReadStateTarget(key: QueryKey) {
  if (
    key[0] === "community"
    && (key[1] === "channel" || key[1] === "dm")
    && typeof key[2] === "string"
    && key[3] === "read-state-snapshot"
  ) {
    return { kind: key[1], channelId: key[2] }
  }
  return null
}

function projectReadStateRows(queryClient: QueryClient, snapshot: AccountReadStateSnapshot) {
  const byChannel = new Map(snapshot.readStates.map((row) => [row.channelId, row]))
  for (const query of queryClient.getQueryCache().getAll()) {
    const target = cachedReadStateTarget(query.queryKey)
    if (!target) continue
    const row = byChannel.get(target.channelId)
    queryClient.setQueryData(query.queryKey, row
      ? {
          lastReadMessageId: row.lastReadMessageId,
          lastReadAt: row.lastReadAt,
          lastReadSeq: row.lastReadSeq,
        }
      : emptyReadState)
  }
}

function applyAccountReadStateSnapshot(
  queryClient: QueryClient,
  snapshot: AccountReadStateSnapshot,
) {
  const current = queryClient.getQueryData<AccountReadStateSnapshot>(
    communityKeys.accountReadStateSnapshot(),
  )
  if (current && snapshot.revision < current.revision) return "stale" as const
  if (current?.revision === snapshot.revision) {
    // Same revision is the same authoritative account snapshot by contract.
    // Re-project leaf caches in case one mounted after the first application,
    // but do not trigger a second round of derived-surface refetches when
    // concurrent auth/live reconciliations joined the same HTTP request.
    projectReadStateRows(queryClient, snapshot)
    return "stale" as const
  }
  notifyManager.batch(() => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), snapshot)
    projectReadStateRows(queryClient, snapshot)
  })
  return "applied" as const
}

async function invalidateReadStateSurfaces(queryClient: QueryClient) {
  const serverIds = new Set<string>()
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey
    if (
      key[0] === "community"
      && key[1] === "servers"
      && typeof key[2] === "string"
      && key[2] !== "__none__"
      && key.length === 3
    ) serverIds.add(key[2])
  }
  const settled = await Promise.allSettled([
    queryClient.invalidateQueries({ queryKey: communityKeys.inbox(), refetchType: "active" }),
    queryClient.invalidateQueries({ queryKey: communityKeys.dms(), refetchType: "active" }),
    queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true, refetchType: "active" }),
    ...[...serverIds].map((serverId) => queryClient.invalidateQueries({
      queryKey: communityKeys.server(serverId),
      exact: true,
      refetchType: "active",
    })),
  ])
  if (settled.some((result) => result.status === "rejected")) {
    throw new Error("read-state surface reconciliation failed")
  }
}

export async function reconcileAccountReadState(
  queryClient: QueryClient,
  options: { invalidateSurfaces?: boolean; targetRevision?: number } = {},
) {
  let applied = false
  let snapshot: AccountReadStateSnapshot
  do {
    let request = inFlightReconciliations.get(queryClient)
    if (!request) request = startAccountReadStateRequest(queryClient)
    snapshot = await request
    if (applyAccountReadStateSnapshot(queryClient, snapshot) === "applied") applied = true
    const currentRevision = queryClient.getQueryData<AccountReadStateSnapshot>(
      communityKeys.accountReadStateSnapshot(),
    )?.revision ?? -1
    if (options.targetRevision === undefined || currentRevision >= options.targetRevision) break
    // A live hint can arrive while auth/reconnect is fetching an older
    // revision. The settled request has been removed from the WeakMap, so the
    // next iteration is a genuinely fresh primary read rather than another
    // join of the stale in-flight promise.
  } while (true)

  if (applied && options.invalidateSurfaces !== false) {
    await invalidateReadStateSurfaces(queryClient)
  }
  return queryClient.getQueryData<AccountReadStateSnapshot>(
    communityKeys.accountReadStateSnapshot(),
  ) ?? snapshot
}

const inFlightReconciliations = new WeakMap<
  QueryClient,
  Promise<AccountReadStateSnapshot>
>()

function startAccountReadStateRequest(queryClient: QueryClient) {
  const controller = new AbortController()
  const request = apiFetch<AccountReadStateSnapshot>(
    "/api/community/users/me/read-state",
    { signal: controller.signal },
  ).finally(() => {
    if (inFlightReconciliations.get(queryClient) === request) {
      inFlightReconciliations.delete(queryClient)
    }
  })
  inFlightReconciliations.set(queryClient, request)
  return request
}

export function projectReadStateEnvelope(
  queryClient: QueryClient,
  envelope: ReadStateEnvelope,
) {
  const snapshot = queryClient.getQueryData<AccountReadStateSnapshot>(
    communityKeys.accountReadStateSnapshot(),
  )
  if (!snapshot) return "gap" as const
  if (envelope.revision <= snapshot.revision) return "stale" as const
  return "gap" as const
}
