import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import type { ReadStateClockRow, ReadStateRow } from "./schema"

export type AccountReadStateSnapshot = {
  revision: number
  readStates: ReadStateRow[]
}

export type ReadStateResource = AccountReadStateSnapshot & {
  clock: ReadStateClockRow[]
}

export function readStateResourceKey(accountId: string) {
  return ["community", "db", accountId, "read-state-resource"] as const
}

export function createReadStateResourceQueryFn(
  queryClient: QueryClient,
  accountId: string,
) {
  return ({ signal }: QueryFunctionContext) => (
    fetchReadStateResource(queryClient, accountId, signal)
  )
}

export async function fetchReadStateResource(
  queryClient: QueryClient,
  accountId: string,
  signal: AbortSignal,
): Promise<ReadStateResource> {
  const snapshot = await apiFetch<AccountReadStateSnapshot>(
    "/api/community/users/me/read-state",
    { signal },
  )
  const current = queryClient.getQueryData<ReadStateResource>(readStateResourceKey(accountId))
  if (current && snapshot.revision < current.revision) return current
  return {
    revision: snapshot.revision,
    readStates: snapshot.readStates,
    clock: [{ id: "account", revision: snapshot.revision }],
  }
}

export function selectReadStateRows(resource: ReadStateResource) {
  return resource.readStates
}

export function selectReadStateClock(resource: ReadStateResource) {
  return resource.clock
}
