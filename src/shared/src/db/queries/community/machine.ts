import { and, eq, gt, desc } from "drizzle-orm";
import {
  communityMachineToken,
  communityMachine,
} from "../../community-machine-schema";
import type { Database } from "../../index";
import {
  COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS,
  COMMUNITY_MACHINE_PAIR_TOKEN_TTL_MS,
} from "../../../constants";
import type { CommunityMachineSummary } from "../../../community-ws-events";

// ---------------------------------------------------------------------------
// Token <-> machine_uuid derivation
//   token id   :  "cmt_<nanoid>"
//   machine_uuid: "cmu_<nanoid>"
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = "cmt_";
const MACHINE_UUID_PREFIX = "cmu_";

export function machineUuidFromTokenId(tokenId: string): string {
  if (!tokenId.startsWith(TOKEN_PREFIX)) {
    throw new Error(`expected ${TOKEN_PREFIX} prefix on token id: ${tokenId}`);
  }
  return MACHINE_UUID_PREFIX + tokenId.slice(TOKEN_PREFIX.length);
}

export function tokenIdFromMachineUuid(machineUuid: string): string {
  if (!machineUuid.startsWith(MACHINE_UUID_PREFIX)) {
    throw new Error(`expected ${MACHINE_UUID_PREFIX} prefix on machine_uuid: ${machineUuid}`);
  }
  return TOKEN_PREFIX + machineUuid.slice(MACHINE_UUID_PREFIX.length);
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

export async function createPairingToken(
  db: Database,
  userId: string
): Promise<{ tokenId: string; expiresAt: string }> {
  // Auto-revoke any prior pending tokens for the same user — keeps one active
  // pending row at a time and prevents orphaned-pending accumulation.
  await db
    .update(communityMachineToken)
    .set({ status: "revoked" })
    .where(
      and(
        eq(communityMachineToken.userId, userId),
        eq(communityMachineToken.status, "pending")
      )
    );

  const expiresAt = new Date(Date.now() + COMMUNITY_MACHINE_PAIR_TOKEN_TTL_MS).toISOString();
  const rows = await db
    .insert(communityMachineToken)
    .values({
      userId,
      status: "pending",
      expiresAt,
    })
    .returning();
  const row = rows[0]!;
  return { tokenId: row.id, expiresAt: row.expiresAt };
}

/**
 * Atomic pending → active transition. Returns the row data if it was the
 * only winner; throws if the token isn't pending/expired/unknown.
 */
export async function claimPairingToken(
  db: Database,
  tokenId: string
): Promise<{ tokenId: string; userId: string }> {
  const nowIso = new Date().toISOString();
  const rows = await db
    .update(communityMachineToken)
    .set({ status: "active", lastUsedAt: nowIso })
    .where(
      and(
        eq(communityMachineToken.id, tokenId),
        eq(communityMachineToken.status, "pending"),
        gt(communityMachineToken.expiresAt, nowIso)
      )
    )
    .returning({ id: communityMachineToken.id, userId: communityMachineToken.userId });
  if (rows.length !== 1) {
    throw new Error("claimPairingToken: token not claimable");
  }
  return { tokenId: rows[0]!.id, userId: rows[0]!.userId };
}

export async function findActiveToken(
  db: Database,
  tokenId: string
): Promise<{ tokenId: string; userId: string } | null> {
  const rows = await db
    .select({ id: communityMachineToken.id, userId: communityMachineToken.userId })
    .from(communityMachineToken)
    .where(
      and(
        eq(communityMachineToken.id, tokenId),
        eq(communityMachineToken.status, "active")
      )
    )
    .limit(1);
  if (rows.length === 0) return null;
  return { tokenId: rows[0]!.id, userId: rows[0]!.userId };
}

export async function findTokenById(
  db: Database,
  tokenId: string
): Promise<{
  tokenId: string;
  userId: string;
  status: string;
  expiresAt: string;
} | null> {
  const rows = await db
    .select()
    .from(communityMachineToken)
    .where(eq(communityMachineToken.id, tokenId))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return { tokenId: r.id, userId: r.userId, status: r.status, expiresAt: r.expiresAt };
}

export async function touchTokenLastUsed(
  db: Database,
  tokenId: string
): Promise<void> {
  await db
    .update(communityMachineToken)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(communityMachineToken.id, tokenId));
}

export async function revokeToken(db: Database, tokenId: string): Promise<void> {
  await db
    .update(communityMachineToken)
    .set({ status: "revoked" })
    .where(eq(communityMachineToken.id, tokenId));
}

/**
 * Mint a fresh pending pairing token for an existing machine row and rotate
 * the row's machine_uuid to match. The old token is revoked. Used by the
 * reconnect flow: the daemon re-pairs with the new token and ends up bound to
 * the same machine record (preserving hostname/platform history).
 */
export async function rotatePairingTokenForMachine(
  db: Database,
  userId: string,
  machineId: string
): Promise<{ tokenId: string; expiresAt: string; oldTokenId: string } | null> {
  const existing = await db
    .select()
    .from(communityMachine)
    .where(
      and(
        eq(communityMachine.userId, userId),
        eq(communityMachine.id, machineId)
      )
    )
    .limit(1);
  if (existing.length === 0) return null;
  const prior = existing[0]!;
  const oldTokenId = tokenIdFromMachineUuid(prior.machineUuid);

  await db
    .update(communityMachineToken)
    .set({ status: "revoked" })
    .where(eq(communityMachineToken.id, oldTokenId));

  const expiresAt = new Date(Date.now() + COMMUNITY_MACHINE_PAIR_TOKEN_TTL_MS).toISOString();
  const rows = await db
    .insert(communityMachineToken)
    .values({ userId, status: "pending", expiresAt })
    .returning();
  const newTokenId = rows[0]!.id;
  const newMachineUuid = machineUuidFromTokenId(newTokenId);

  await db
    .update(communityMachine)
    .set({ machineUuid: newMachineUuid, updatedAt: new Date().toISOString() })
    .where(eq(communityMachine.id, prior.id));

  return { tokenId: newTokenId, expiresAt, oldTokenId };
}

// ---------------------------------------------------------------------------
// Machine helpers
// ---------------------------------------------------------------------------

export interface MachineMetadataInput {
  hostname?: string;
  platform?: string;
  arch?: string;
  osRelease?: string;
  daemonVersion?: string;
  metadata?: string | null;
}

export interface MachineRow {
  id: string;
  userId: string;
  machineUuid: string;
  displayName: string;
  hostname: string;
  platform: string;
  arch: string;
  osRelease: string;
  daemonVersion: string;
  metadata: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function upsertMachineForUser(
  db: Database,
  userId: string,
  tokenId: string,
  meta: MachineMetadataInput
): Promise<{ machine: MachineRow; priorLastSeenAt: string | null }> {
  const machineUuid = machineUuidFromTokenId(tokenId);
  const nowIso = new Date().toISOString();
  const existing = await db
    .select()
    .from(communityMachine)
    .where(
      and(
        eq(communityMachine.userId, userId),
        eq(communityMachine.machineUuid, machineUuid)
      )
    )
    .limit(1);

  if (existing.length === 0) {
    const hostname = meta.hostname ?? "";
    const rows = await db
      .insert(communityMachine)
      .values({
        userId,
        machineUuid,
        displayName: hostname,
        hostname,
        platform: meta.platform ?? "",
        arch: meta.arch ?? "",
        osRelease: meta.osRelease ?? "",
        daemonVersion: meta.daemonVersion ?? "",
        metadata: meta.metadata ?? null,
        lastSeenAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .returning();
    return { machine: rows[0] as MachineRow, priorLastSeenAt: null };
  }

  const prior = existing[0]!;
  const hostname = meta.hostname ?? prior.hostname;
  // v1 has no rename path — display_name tracks hostname.
  const rows = await db
    .update(communityMachine)
    .set({
      hostname,
      displayName: hostname,
      platform: meta.platform ?? prior.platform,
      arch: meta.arch ?? prior.arch,
      osRelease: meta.osRelease ?? prior.osRelease,
      daemonVersion: meta.daemonVersion ?? prior.daemonVersion,
      metadata: meta.metadata !== undefined ? meta.metadata : prior.metadata,
      lastSeenAt: nowIso,
      updatedAt: nowIso,
    })
    .where(eq(communityMachine.id, prior.id))
    .returning();
  return { machine: rows[0] as MachineRow, priorLastSeenAt: prior.lastSeenAt };
}

export async function touchMachineHeartbeat(
  db: Database,
  userId: string,
  machineUuid: string
): Promise<{ lastSeenAt: string; priorLastSeenAt: string | null } | null> {
  const existing = await db
    .select({ id: communityMachine.id, lastSeenAt: communityMachine.lastSeenAt })
    .from(communityMachine)
    .where(
      and(
        eq(communityMachine.userId, userId),
        eq(communityMachine.machineUuid, machineUuid)
      )
    )
    .limit(1);
  if (existing.length === 0) return null;
  const prior = existing[0]!;
  const nowIso = new Date().toISOString();
  await db
    .update(communityMachine)
    .set({ lastSeenAt: nowIso, updatedAt: nowIso })
    .where(eq(communityMachine.id, prior.id));
  return { lastSeenAt: nowIso, priorLastSeenAt: prior.lastSeenAt };
}

export async function getMachineByIdForUser(
  db: Database,
  userId: string,
  machineId: string
): Promise<MachineRow | null> {
  const rows = await db
    .select()
    .from(communityMachine)
    .where(
      and(
        eq(communityMachine.userId, userId),
        eq(communityMachine.id, machineId)
      )
    )
    .limit(1);
  return rows.length ? (rows[0] as MachineRow) : null;
}

export async function listMachinesForUser(
  db: Database,
  userId: string
): Promise<CommunityMachineSummary[]> {
  const rows = await db
    .select()
    .from(communityMachine)
    .where(eq(communityMachine.userId, userId))
    .orderBy(desc(communityMachine.updatedAt));
  return rows.map(toSummary);
}

export async function deleteMachineForUser(
  db: Database,
  userId: string,
  machineId: string
): Promise<MachineRow | null> {
  const rows = await db
    .delete(communityMachine)
    .where(
      and(
        eq(communityMachine.userId, userId),
        eq(communityMachine.id, machineId)
      )
    )
    .returning();
  return rows.length ? (rows[0] as MachineRow) : null;
}

export function toSummary(row: MachineRow): CommunityMachineSummary {
  return {
    id: row.id,
    hostname: row.hostname,
    displayName: row.displayName,
    platform: row.platform,
    arch: row.arch,
    osRelease: row.osRelease,
    daemonVersion: row.daemonVersion,
    lastSeenAt: row.lastSeenAt,
    status: computeStatus(row.lastSeenAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function computeStatus(lastSeenAt: string | null): "online" | "offline" {
  if (!lastSeenAt) return "offline";
  const ms = Date.parse(lastSeenAt);
  if (Number.isNaN(ms)) return "offline";
  return Date.now() - ms < COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS ? "online" : "offline";
}
