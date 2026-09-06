import {
  COMMUNITY_REPLICA_PROTOCOL_VERSION,
  communityReplicaScopeKey,
  type CommunityReplicaScope,
} from "@alook/shared"
import { openDB, type DBSchema } from "idb"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"
import { COMMUNITY_SHELL_PROTOCOL_VERSION } from "./shell"
import {
  deleteCommunityReplicaAccount,
  readCoveredCommunityReplica,
  readCommunityReplicaSnapshot,
  type CoveredReplicaProjection,
  listCommunityReplicaIntents,
  type ReplicaIntentRow,
} from "./store"

const CONTROL_DB_NAME = "alook-community-replica-control-v1"
const CONTROL_DB_VERSION = 1
const CONTROL_WAL_KEY = "alook-community-replica-control-v1:active"
export const COMMUNITY_REPLICA_SYNC_EVENT = "alook:community-replica-sync"

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
  validUntil: string
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

function readControlWal(): ActiveReplicaSession | null {
  if (typeof localStorage === "undefined") return null
  try {
    const value = JSON.parse(localStorage.getItem(CONTROL_WAL_KEY) ?? "null") as ActiveReplicaSession | null
    if (
      value?.key !== "active"
      || typeof value.accountId !== "string"
      || typeof value.user?.id !== "string"
      || !Array.isArray(value.shellRoutes)
      || typeof value.validUntil !== "string"
    ) return null
    return value
  } catch {
    localStorage.removeItem(CONTROL_WAL_KEY)
    return null
  }
}

function writeControlWal(value: ActiveReplicaSession) {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(CONTROL_WAL_KEY, JSON.stringify(value))
  }
}

function removeControlWal(accountId?: string) {
  const active = readControlWal()
  if (active && (!accountId || active.accountId === accountId)) {
    localStorage.removeItem(CONTROL_WAL_KEY)
  }
}

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

export function hasActiveCommunityReplicaRoute(accountId: string, pathname: string) {
  const active = readControlWal()
  return active?.accountId === accountId
    && active.replicaProtocolVersion === COMMUNITY_REPLICA_PROTOCOL_VERSION
    && active.shellProtocolVersion === COMMUNITY_SHELL_PROTOCOL_VERSION
    && Date.parse(active.validUntil) > Date.now()
    && active.shellRoutes.includes(routePath(pathname))
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
  const db = await connection
  const previous = readControlWal() ?? await db.get("session", "active")
  const shellRoutes = previous?.accountId === user.id
    ? [...new Set([...previous.shellRoutes, path])]
    : [path]
  const requestedCoverage = new Set(scopes.map(communityReplicaScopeKey))
  const validUntil = projection.coverage
    .filter((item) => requestedCoverage.has(communityReplicaScopeKey(item.scope)))
    .map((item) => item.permission.validUntil)
    .reduce((earliest, candidate) => (
      !earliest || Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest
    ), "")
  if (!validUntil) throw new Error("Replica permission lease is missing")
  const active: ActiveReplicaSession = {
    key: "active",
    accountId: user.id,
    user,
    replicaProtocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
    snapshotId: projection.meta.snapshotId,
    shellProtocolVersion: COMMUNITY_SHELL_PROTOCOL_VERSION,
    shellRoutes,
    validUntil,
  }
  // The small control record is a synchronous commit point. IndexedDB remains
  // the mirrored control store, while localStorage closes the browser-kill
  // window between a completed Replica transaction and an async IDB put.
  writeControlWal(active)
  await db.put("session", active)
}

export async function markCommunityReplicaShellRoute(accountId: string, pathname: string) {
  const connection = openControl()
  if (!connection) return
  const db = await connection
  const active = readControlWal() ?? await db.get("session", "active")
  if (!active || active.accountId !== accountId) return
  if (!(Date.parse(active.validUntil) > Date.now())) return
  const path = routePath(pathname)
  if (active.shellRoutes.includes(path)) return
  const updated = { ...active, shellRoutes: [...active.shellRoutes, path] }
  writeControlWal(updated)
  await db.put("session", updated)
}

export async function readActiveCommunityReplicaSession(
  pathname: string,
  now = Date.now(),
): Promise<CommunityReplicaLaunch | null> {
  const connection = openControl()
  if (!connection) return null
  const active = readControlWal() ?? await (await connection).get("session", "active")
  const path = routePath(pathname)
  if (
    !active
    || active.replicaProtocolVersion !== COMMUNITY_REPLICA_PROTOCOL_VERSION
    || active.shellProtocolVersion !== COMMUNITY_SHELL_PROTOCOL_VERSION
    || !active.shellRoutes.includes(path)
    || !(Date.parse(active.validUntil) > now)
  ) return null
  const scopes = communityReplicaRouteScopes(active.accountId, path)
  if (!scopes) return null
  const projection = await readCommunityReplicaSnapshot(active.accountId, now)
  // A newer atomic snapshot may land after the route was published (for
  // example when a visibility/route sync supersedes the bootstrap that made
  // the shell ready). The active record is an account + shell-route grant,
  // not a pin to one snapshot generation. `readCoveredCommunityReplica`
  // already proves that the currently committed generation is coherent,
  // unexpired, and covers every requested scope, so rejecting it solely
  // because its snapshot id advanced creates a false offline miss.
  const coveredScopes = new Set(projection?.coverage.map((item) => communityReplicaScopeKey(item.scope)))
  if (!projection || scopes.some((scope) => !coveredScopes.has(communityReplicaScopeKey(scope)))) return null
  const intents = await listCommunityReplicaIntents(active.accountId)
  return { user: active.user, projection, intents }
}

export async function clearActiveCommunityReplicaSession(accountId?: string) {
  const connection = openControl()
  if (!connection) return
  const db = await connection
  const active = readControlWal() ?? await db.get("session", "active")
  if (!active || (accountId && active.accountId !== accountId)) return
  removeControlWal(accountId)
  await db.delete("session", "active")
  await deleteCommunityReplicaAccount(active.accountId)
}

export async function retireActiveCommunityReplicaScopes(
  accountId: string,
  scopes: CommunityReplicaScope[],
) {
  const connection = openControl()
  if (!connection) return
  const db = await connection
  const active = readControlWal() ?? await db.get("session", "active")
  if (!active || active.accountId !== accountId) return
  const revoked = new Set(scopes.map((scope) => communityReplicaScopeKey(scope)))
  const shellRoutes = active.shellRoutes.filter((path) => {
    const routeScopes = communityReplicaRouteScopes(accountId, path)
    return !routeScopes?.some((scope) => revoked.has(communityReplicaScopeKey(scope)))
  })
  if (shellRoutes.length === active.shellRoutes.length) return
  if (shellRoutes.length === 0) {
    removeControlWal(accountId)
    await db.delete("session", "active")
    return
  }
  const updated = { ...active, shellRoutes }
  writeControlWal(updated)
  await db.put("session", updated)
}
