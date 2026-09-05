import { COMMUNITY_REPLICA_PROTOCOL_VERSION, type CommunityReplicaScope } from "@alook/shared"
import { openDB, type DBSchema } from "idb"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"
import { COMMUNITY_SHELL_PROTOCOL_VERSION } from "./shell"
import {
  deleteCommunityReplicaAccount,
  readCoveredCommunityReplica,
  type CoveredReplicaProjection,
  listCommunityReplicaIntents,
  type ReplicaIntentRow,
} from "./store"

const CONTROL_DB_NAME = "alook-community-replica-control-v1"
const CONTROL_DB_VERSION = 1

export type ReplicaSessionUser = {
  id: string
  name: string
  email: string
  avatar: string
  avatarVersion: number
}

type ActiveReplicaSession = {
  key: "active"
  accountId: string
  user: ReplicaSessionUser
  replicaProtocolVersion: number
  snapshotId: string
  shellProtocolVersion: number
  shellRoutes: string[]
}

interface ReplicaControlDB extends DBSchema {
  session: { key: string; value: ActiveReplicaSession }
}

export type CommunityReplicaLaunch = {
  user: ReplicaSessionUser
  projection: CoveredReplicaProjection
  intents: ReplicaIntentRow[]
}

let controlConnection: ReturnType<typeof openDB<ReplicaControlDB>> | null = null

function openControl() {
  if (typeof indexedDB === "undefined") return null
  if (!controlConnection) {
    controlConnection = openDB<ReplicaControlDB>(CONTROL_DB_NAME, CONTROL_DB_VERSION, {
      upgrade(db) {
        db.createObjectStore("session", { keyPath: "key" })
      },
    })
  }
  return controlConnection
}

function routePath(input: string) {
  try {
    const url = new URL(input, "https://local.alook")
    return url.pathname
  } catch {
    return input.split(/[?#]/, 1)[0] || "/"
  }
}

export function communityReplicaRouteScopes(
  accountId: string,
  pathname: string,
): CommunityReplicaScope[] | null {
  const plan = resolveCommunityModulePlan(pathname)
  if (plan.main.kind === "server-landing") {
    return [
      { kind: "account", id: accountId },
      { kind: "server", id: plan.main.serverId },
    ]
  }
  if (plan.main.kind === "server-conversation") {
    return [
      { kind: "account", id: accountId },
      { kind: "server", id: plan.main.serverId },
      { kind: "channel", id: plan.main.leafId },
    ]
  }
  return null
}

export async function publishCommunityReplicaSession(
  user: ReplicaSessionUser,
  pathname: string,
  now = Date.now(),
) {
  const scopes = communityReplicaRouteScopes(user.id, pathname)
  if (!scopes) throw new Error("route is outside Replica v1 coverage")
  const projection = await readCoveredCommunityReplica(user.id, scopes, now)
  if (!projection) throw new Error("Replica coverage is missing or expired")
  const connection = openControl()
  if (!connection) throw new Error("IndexedDB is unavailable")
  const path = routePath(pathname)
  await (await connection).put("session", {
    key: "active",
    accountId: user.id,
    user,
    replicaProtocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
    snapshotId: projection.meta.snapshotId,
    shellProtocolVersion: COMMUNITY_SHELL_PROTOCOL_VERSION,
    shellRoutes: [path],
  })
}

export async function markCommunityReplicaShellRoute(accountId: string, pathname: string) {
  const connection = openControl()
  if (!connection) return
  const db = await connection
  const active = await db.get("session", "active")
  if (!active || active.accountId !== accountId) return
  const path = routePath(pathname)
  if (active.shellRoutes.includes(path)) return
  await db.put("session", { ...active, shellRoutes: [...active.shellRoutes, path] })
}

export async function readActiveCommunityReplicaSession(
  pathname: string,
  now = Date.now(),
): Promise<CommunityReplicaLaunch | null> {
  const connection = openControl()
  if (!connection) return null
  const active = await (await connection).get("session", "active")
  const path = routePath(pathname)
  if (
    !active
    || active.replicaProtocolVersion !== COMMUNITY_REPLICA_PROTOCOL_VERSION
    || active.shellProtocolVersion !== COMMUNITY_SHELL_PROTOCOL_VERSION
    || !active.shellRoutes.includes(path)
  ) return null
  const scopes = communityReplicaRouteScopes(active.accountId, path)
  if (!scopes) return null
  const projection = await readCoveredCommunityReplica(active.accountId, scopes, now)
  if (!projection || projection.meta.snapshotId !== active.snapshotId) return null
  const intents = await listCommunityReplicaIntents(active.accountId)
  return { user: active.user, projection, intents }
}

export async function clearActiveCommunityReplicaSession(accountId?: string) {
  const connection = openControl()
  if (!connection) return
  const db = await connection
  const active = await db.get("session", "active")
  if (!active || (accountId && active.accountId !== accountId)) return
  await db.delete("session", "active")
  await deleteCommunityReplicaAccount(active.accountId)
}
