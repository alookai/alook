import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { isServerOwner } from "@alook/shared"
import {
  getActiveAccountUnreadProjection,
  type AccountUnreadSource,
} from "@/hooks/community/account-unread-projection"
import { serverSchema, type ServerRow } from "./schema"

export type RawServerRow = {
  id: string
  name: string
  discriminator: string
  icon: string | null
  official?: boolean
  role?: string
  mentions?: number
  unread?: boolean
  description?: string | null
  ownerId: string
  unreadSources?: Array<{ channelId: string; lastUnreadSeq: number }>
  mentionSources?: Array<{ channelId: string; count: number; lastSeq: number }>
}

export type ServersResponse = {
  servers: ServerRow[]
  unreadSources: AccountUnreadSource[]
}

export function normalizeServersResponse(
  raw: readonly RawServerRow[],
  existing: ReadonlyMap<string, ServerRow> = new Map(),
): ServersResponse {
  const unreadSources: AccountUnreadSource[] = []
  const servers = raw.map((server, position): ServerRow => {
    for (const source of server.unreadSources ?? []) {
      unreadSources.push({ ...source, serverId: server.id })
    }
    for (const source of server.mentionSources ?? []) {
      if (source.count <= 0) continue
      unreadSources.push({
        channelId: source.channelId,
        serverId: server.id,
        lastUnreadSeq: source.lastSeq,
        lastMentionSeq: source.lastSeq,
        isMention: true,
      })
    }
    return serverSchema.parse({
      id: server.id,
      position,
      name: server.name,
      discriminator: server.discriminator,
      description: server.description ?? "",
      ownerId: server.ownerId,
      icon: server.icon ?? null,
      official: server.official === true,
      isOwner: isServerOwner(server.role),
      unread: false,
      mentions: 0,
      detailComplete: existing.get(server.id)?.detailComplete ?? false,
    })
  })
  return { servers, unreadSources }
}

export function createServersQueryFn(
  queryClient: QueryClient,
  existingRows: () => Iterable<ServerRow>,
) {
  return async (context?: QueryFunctionContext): Promise<ServersResponse> => {
    const projection = getActiveAccountUnreadProjection(queryClient)
    const token = projection.beginSnapshot("servers", "channels")
    try {
      const data = await apiFetch<{ servers: RawServerRow[] }>("/api/community/servers", {
        signal: context?.signal,
      })
      const response = normalizeServersResponse(
        data.servers,
        new Map(Array.from(existingRows(), (row) => [row.id, row])),
      )
      projection.absorbSnapshot(token, response.unreadSources, {
        confirmedAccessScopes: response.servers.map((server) => ({
          kind: "server" as const,
          serverId: server.id,
        })),
      })
      return response
    } catch (error) {
      projection.cancelSnapshot(token)
      throw error
    }
  }
}

export const serversCollectionQueryKey = communityKeys.serverRows
