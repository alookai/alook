import type { Query, QueryClient, QueryFunctionContext, QueryKey } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { ApiError } from "@/lib/errors"
import { communityRequestOptions } from "./account-cache-lifecycle"
import { retireBotDirectoryScopes } from "./bot-directory-lifecycle"
import type { AuxiliaryWindowScope } from "./auxiliary-window-contract"
import type { BotReadProof } from "./bot-directory-window"

export async function beginBotDirectoryRead(client: QueryClient, queryKey: QueryKey, signal: AbortSignal) {
  const token = captureCommunityLiveSnapshotToken(client)
  const registry = token.registry!
  const query = client.getQueryCache().find({ queryKey, exact: true })
  const assert = () => {
    assertCommunityLiveSnapshotTokenCurrent(client, token, signal)
    if (query && client.getQueryCache().find({ queryKey, exact: true }) !== query) throw new DOMException("Retired directory request", "AbortError")
  }
  assert()
  const auxiliaryReadEpoch = await registry.captureAuxiliaryReadEpoch()
  assert()
  return { token, registry, query, assert, proof: { observed: true, ...(auxiliaryReadEpoch ? { auxiliaryReadEpoch } : {}) } satisfies BotReadProof }
}

export async function fetchBotDirectory<T extends object>(context: Pick<QueryFunctionContext, "client" | "queryKey" | "signal">, path: string): Promise<T & BotReadProof> {
  const { client, queryKey, signal } = context
  const read = await beginBotDirectoryRead(client, queryKey, signal)
  try {
    const data = await apiFetch<T>(path, communityRequestOptions(client, read.token, signal, read.assert))
    read.assert()
    return { ...data, ...read.proof }
  } catch (error) {
    read.assert()
    const olderPageMissing = (queryKey[3] === "audit-log" || queryKey[3] === "audit-preview") && "pageParam" in context && context.pageParam
      && error instanceof ApiError && error.status === 404 && error.message !== "bot not found"
    if (error instanceof ApiError && [403, 404].includes(error.status) && !olderPageMissing) {
      const scope: AuxiliaryWindowScope | undefined = queryKey[1] === "servers" ? { kind: "server-admin", id: queryKey[2] as string }
        : queryKey[3] === "notification-settings" ? { kind: queryKey[4] === "server" ? "bot-server" : "bot-channel", botId: queryKey[2] as string, id: queryKey[5] as string }
          : { kind: "bot", id: queryKey[2] as string }
      await retireBotDirectoryScopes(read.registry, [scope], read.query).catch(cause => console.error("Bot directory retirement failed", cause))
    }
    throw error
  }
}

export function captureBotDirectoryCommand(client: QueryClient, key: QueryKey) {
  const query = client.getQueryCache().find({ queryKey: key, exact: true })
  if (!query || query.state.status !== "success" || query.state.fetchStatus !== "idle" || (query.state.data as BotReadProof | undefined)?.observed !== true)
    throw new DOMException("Directory read is not confirmed", "AbortError")
  return query
}

export function assertBotDirectoryCommandCurrent(client: QueryClient, query: Query) {
  if (!getCommunityDbRegistry(client)?.runtime.lifecycle.get().active || client.getQueryCache().find({ queryKey: query.queryKey, exact: true }) !== query
    || query.state.status !== "success" || (query.state.data as BotReadProof | undefined)?.observed !== true)
    throw new DOMException("Retired directory command", "AbortError")
}
