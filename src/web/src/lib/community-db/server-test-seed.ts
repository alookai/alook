import type { Server } from "@/lib/community/models/navigation"
import type { CommunityDbRegistry } from "./collections"
import { writeCommunityCollectionRows } from "./collection-mutations"
import { purgeCommunityServer } from "./sync"
import {
  serverMembershipKey,
  serverMembershipSchema,
  type ServerMembershipRow,
  type ServerRow,
} from "./schema"

export function seedCommunityServers(
  registry: CommunityDbRegistry,
  response: { servers: Server[] },
  mode: "authoritative" | "merge" = "authoritative",
) {
  const collection = registry.collections.servers
  const incomingIds = new Set(response.servers.map((server) => server.id))
  writeCommunityCollectionRows(registry, "servers", () => {
    const existing = new Map(Array.from(collection.values(), (row) => [row.id, row]))
    if (mode === "authoritative") {
      for (const id of collection.keys()) {
        if (!incomingIds.has(id)) purgeCommunityServer(registry, id)
      }
    }
    const rows: ServerRow[] = response.servers.map((server, position) => ({
      id: server.id,
      position,
      name: server.name,
      discriminator: server.discriminator ?? "",
      description: server.description ?? "",
      ownerId: server.ownerId ?? "",
      icon: server.icon ?? null,
      official: server.official === true,
      isOwner: server.isOwner === true,
      unread: server.unread,
      mentions: server.mentions,
      detailComplete: existing.get(server.id)?.detailComplete ?? false,
    }))
    const next = mode === "merge" ? existing : new Map<string, ServerRow>()
    for (const row of rows) next.set(row.id, row)
    return [...next.values()]
  }, (row) => row.id)
  if (!registry.accountId) return
  const viewerId = registry.accountId
  const memberships: ServerMembershipRow[] = response.servers.map((server) => ({
    id: serverMembershipKey(server.id, viewerId),
    serverId: server.id,
    userId: viewerId,
    role: server.isOwner ? "owner" : "member",
    viewer: true,
  }))
  const currentMemberships = Array.from(
    registry.collections.serverMemberships.values(),
    (row) => serverMembershipSchema.parse(row),
  )
  const retained = mode === "merge"
    ? currentMemberships
    : currentMemberships.filter((row) => !row.viewer)
  const byId = new Map(retained.map((row) => [row.id, row]))
  for (const row of memberships) byId.set(row.id, row)
  writeCommunityCollectionRows(
    registry,
    "serverMemberships",
    [...byId.values()],
    (row) => row.id,
  )
}
