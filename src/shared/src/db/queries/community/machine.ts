import { and, eq, gt, desc, isNull, exists, inArray, sql } from "drizzle-orm";
import {
  communityMachineToken,
  communityMachine,
  communityMachineCredential,
  communityAgentRunnerKey,
  communityBotBinding,
} from "../../community-machine-schema";
import { user } from "../../schema";
import { communityUserProfile } from "../../community-schema";
import type { Database } from "../../index";
import { BOT_ACTIVITY_PRESETS, isBotActivityStatus } from "../../../community/bot-activity-presets";
import { COMMUNITY_MACHINE_PAIR_TOKEN_TTL_MS } from "../../../constants";
import { isPresenceOnline } from "../../../utils/status";
import type {
  CommunityMachineRuntime,
  CommunityMachineSummary,
} from "../../../community-ws-events";

// ---------------------------------------------------------------------------
// Credential hashing
// ---------------------------------------------------------------------------

const CREDENTIAL_PREFIX = "cmk_";
const RUNNER_KEY_PREFIX = "crk_";

/**
 * SHA-256 of the bearer, returned as lowercase hex (64 chars).
 *
 * The server stores this hash and never the plaintext bearer; the plaintext
 * only exists on the wire (Authorization header) and on the daemon's local
 * disk (credential.json). No KDF: the bearer is nanoid(32) ≈ 190 bits of
 * entropy, so a hash suffices for lookup — brute-force resistance from the
 * bearer itself.
 */
export async function hashCredential(bearer: string): Promise<string> {
  const bytes = new TextEncoder().encode(bearer);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * DO name suffix (first 32 hex chars of the credential hash = 128 bits).
 * Router uses this to name the Durable Object without a D1 lookup; the DO
 * still validates the full 64-hex hash on first accept.
 */
export function doNameFromHash(hash: string): string {
  return hash.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/**
 * Mint a fresh pending pairing token for a user (first pair) or bind it to
 * an existing machine (reconnect). Any prior pending token for the same user
 * is revoked first — the sheet auto-mints on open, and the user's latest
 * click is authoritative. `cmk_` credentials are unaffected; only the
 * ephemeral `cmt_` row is replaced.
 *
 * `machineId` — when set, /activate will treat this as a reconnect and reuse
 * the existing machine row. When null, /activate creates a fresh row.
 */
export async function createPairingToken(
  db: Database,
  userId: string,
  opts: { machineId?: string | null } = {}
): Promise<{ tokenId: string; expiresAt: string }> {
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
      machineId: opts.machineId ?? null,
      status: "pending",
      expiresAt,
    })
    .returning();
  const row = rows[0]!;
  return { tokenId: row.id, expiresAt: row.expiresAt };
}

/**
 * Reconnect flow — mint a new pending token bound to an existing machine
 * so /activate reuses the machine row instead of creating a new one.
 *
 * Preconditions: caller must have already verified the machine belongs to
 * the user; this function checks again to fail closed.
 */
export async function createReconnectPairingToken(
  db: Database,
  userId: string,
  machineId: string
): Promise<{ tokenId: string; expiresAt: string }> {
  const owned = await db
    .select({ id: communityMachine.id })
    .from(communityMachine)
    .where(
      and(
        eq(communityMachine.userId, userId),
        eq(communityMachine.id, machineId)
      )
    )
    .limit(1);
  if (owned.length === 0) {
    throw new Error("createReconnectPairingToken: machine not owned by user");
  }
  return createPairingToken(db, userId, { machineId });
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
  machineId: string | null;
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
  return {
    tokenId: r.id,
    userId: r.userId,
    machineId: r.machineId ?? null,
    status: r.status,
    expiresAt: r.expiresAt,
  };
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
  /** Agent CLIs detected on the host. Pass `undefined` to leave unchanged. */
  availableRuntimes?: CommunityMachineRuntime[];
}

export interface MachineRow {
  id: string;
  userId: string;
  displayName: string;
  hostname: string;
  platform: string;
  arch: string;
  osRelease: string;
  daemonVersion: string;
  metadata: string | null;
  availableRuntimes: CommunityMachineRuntime[];
  /** Source of truth for machine presence — written by WsDurableObject. */
  status: "online" | "offline";
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Bot activity telemetry — see plans/community-bot-status-telemetry.md.
//
// Bot activity is stored on `community_user_profile.status_emoji`/`status_text`,
// the same fields humans set via `StatusEditor`. This is deliberate: consumers
// on the client never branch on "is this a bot" — one status pipeline covers
// both. The distinction is server-only: humans PATCH `/api/community/users/me/
// profile`, bots are written here by the WS DO on `agent_activity` frames.
// ---------------------------------------------------------------------------

/**
 * Coarse safety net for `agent_activity` frames dropped mid-disconnect: for
 * every bot bound to `machineId`, if the bot's persisted status currently
 * looks like a system-written bot-activity pill AND the daemon reports it is
 * NOT in `runningAgents`, flip its status to `Idle`. This only clears stuck
 * "still running" pills — the `running`-side transitions are covered by the
 * live `agent_activity` push on reconnect. Returns the list of bots that
 * actually changed, so the caller only fans out real transitions.
 *
 * Owner-set custom statuses on a bot (a hypothetical future feature) are NOT
 * touched — the `isBotActivityStatus` check requires an exact match against
 * the known emoji+text pairs the WS DO writes.
 */
export async function reconcileBotActivityFromRunningAgents(
  db: Database,
  machineId: string,
  runningAgentIds: string[]
): Promise<Array<{ botUserId: string; statusEmoji: string; statusText: string }>> {
  const rows = await db
    .select({
      userId: communityBotBinding.userId,
      statusEmoji: communityUserProfile.statusEmoji,
      statusText: communityUserProfile.statusText,
    })
    .from(communityBotBinding)
    .innerJoin(
      communityUserProfile,
      eq(communityUserProfile.userId, communityBotBinding.userId)
    )
    .where(eq(communityBotBinding.machineId, machineId));
  if (rows.length === 0) return [];

  const runningSet = new Set(runningAgentIds);
  const idle = BOT_ACTIVITY_PRESETS.idle;
  const stale = rows.filter((r) => {
    if (runningSet.has(r.userId)) return false;
    if (r.statusEmoji === idle.emoji && r.statusText === idle.text) return false;
    return isBotActivityStatus(r.statusEmoji, r.statusText);
  });
  if (stale.length === 0) return [];

  const staleStatuses = db.$with("stale_bot_statuses").as(
    db
      .select({
        userId: sql<string>`CAST(json_extract(value, '$[0]') AS TEXT)`.as("user_id"),
        statusEmoji: sql<string>`CAST(json_extract(value, '$[1]') AS TEXT)`.as("status_emoji"),
        statusText: sql<string>`CAST(json_extract(value, '$[2]') AS TEXT)`.as("status_text"),
      })
      .from(sql`json_each(${JSON.stringify(
        stale.map((row) => [row.userId, row.statusEmoji, row.statusText])
      )})`)
  );
  const updated = await db
    .with(staleStatuses)
    .update(communityUserProfile)
    .set({ statusEmoji: idle.emoji, statusText: idle.text })
    .where(
      exists(
        db
          .select({ one: sql<number>`1` })
          .from(staleStatuses)
          .where(
            and(
              eq(staleStatuses.userId, communityUserProfile.userId),
              eq(staleStatuses.statusEmoji, communityUserProfile.statusEmoji),
              eq(staleStatuses.statusText, communityUserProfile.statusText)
            )
          )
      )
    )
    .returning({ userId: communityUserProfile.userId });

  return updated.map((r) => ({
    botUserId: r.userId,
    statusEmoji: idle.emoji,
    statusText: idle.text,
  }));
}

// ---------------------------------------------------------------------------
// Credential helpers — long-lived `cmk_` tokens the daemon dials with.
// ---------------------------------------------------------------------------

/**
 * Look up a credential by its sha256 hash (full 64 hex chars). Returns
 * null if unknown or revoked. Bumps `last_used_at` on hit (best-effort).
 */
export async function findCredentialByHash(
  db: Database,
  hash: string
): Promise<{
  credentialId: string;
  userId: string;
  machineId: string;
  credentialHash: string;
  doName: string;
} | null> {
  const rows = await db
    .select({
      id: communityMachineCredential.id,
      userId: communityMachineCredential.userId,
      machineId: communityMachineCredential.machineId,
      credentialHash: communityMachineCredential.credentialHash,
      doName: communityMachineCredential.doName,
    })
    .from(communityMachineCredential)
    .innerJoin(user, eq(user.id, communityMachineCredential.userId))
    .where(
      and(
        eq(communityMachineCredential.credentialHash, hash),
        isNull(communityMachineCredential.revokedAt),
        isNull(user.deletedAt)
      )
    )
    .limit(1);
  if (rows.length === 0) return null;
  const nowIso = new Date().toISOString();
  await db
    .update(communityMachineCredential)
    .set({ lastUsedAt: nowIso })
    .where(eq(communityMachineCredential.id, rows[0]!.id));
  return {
    credentialId: rows[0]!.id,
    userId: rows[0]!.userId,
    machineId: rows[0]!.machineId,
    credentialHash: rows[0]!.credentialHash,
    doName: rows[0]!.doName,
  };
}

/**
 * Convenience: verify a plaintext bearer by hashing it and looking up.
 * Callers should prefer `findCredentialByHash` when the hash is already
 * on hand (router path).
 */
export async function findActiveCredentialByBearer(
  db: Database,
  bearer: string
): Promise<{
  credentialId: string;
  userId: string;
  machineId: string;
  credentialHash: string;
  doName: string;
} | null> {
  if (!bearer.startsWith(CREDENTIAL_PREFIX)) return null;
  const hash = await hashCredential(bearer);
  return findCredentialByHash(db, hash);
}

/**
 * Return the live DO-name suffixes for a machine (typically one, but robust
 * to N historical credentials). Used by the WS DO push router when it needs
 * to route `bot:*` frames to the daemon's current DO.
 */
export async function getActiveDoNamesForMachine(
  db: Database,
  machineId: string
): Promise<string[]> {
  const rows = await db
    .select({ doName: communityMachineCredential.doName })
    .from(communityMachineCredential)
    .where(
      and(
        eq(communityMachineCredential.machineId, machineId),
        isNull(communityMachineCredential.revokedAt)
      )
    );
  return rows.map((r) => r.doName);
}

/** Soft-revoke a single credential by opaque id. */
export async function revokeCredential(
  db: Database,
  credentialId: string
): Promise<void> {
  await db
    .update(communityMachineCredential)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(communityMachineCredential.id, credentialId),
        isNull(communityMachineCredential.revokedAt)
      )
    );
}

/**
 * Soft-revoke every active credential for a machine. Returns the DO-name
 * suffixes of the revoked credentials so the caller can force-close each
 * live WS Durable Object (the DO is keyed by `sha256(bearer).slice(0,32)`).
 */
export async function revokeCredentialsForMachine(
  db: Database,
  userId: string,
  machineId: string
): Promise<{ doNames: string[] }> {
  const rows = await db
    .update(communityMachineCredential)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(communityMachineCredential.userId, userId),
        eq(communityMachineCredential.machineId, machineId),
        isNull(communityMachineCredential.revokedAt)
      )
    )
    .returning({ doName: communityMachineCredential.doName });
  return { doNames: rows.map((r) => r.doName) };
}

/**
 * Mint a per-agent runner key.
 *
 * Idempotency caveat: because the server only stores sha256(bearer), a
 * prior plaintext bearer for (machineId, agentId) can't be handed back on
 * a repeat call. Instead this function hard-deletes any prior row for the
 * scope and inserts a fresh bearer — so each call yields a usable
 * plaintext. Callers that had a stale bearer cached will need to re-cache.
 */
export async function mintAgentRunnerKey(
  db: Database,
  { userId, machineId, agentId }: { userId: string; machineId: string; agentId: string }
): Promise<{ runnerKey: string; existed: boolean }> {
  // Scope by userId — a cross-owner call for (machineId, agentId) that
  // belong to a different user must not touch the victim's row. Combined
  // with the partial unique (machineId, agentId) WHERE revoked_at IS NULL,
  // this makes the dedupe safe against cross-owner collisions.
  const existing = await db
    .select({ id: communityAgentRunnerKey.id })
    .from(communityAgentRunnerKey)
    .where(
      and(
        eq(communityAgentRunnerKey.userId, userId),
        eq(communityAgentRunnerKey.machineId, machineId),
        eq(communityAgentRunnerKey.agentId, agentId),
        isNull(communityAgentRunnerKey.revokedAt)
      )
    )
    .limit(1);
  if (existing.length > 0) {
    // Row exists but plaintext is unrecoverable — hard-delete so we can
    // insert a fresh bearer without hitting the UNIQUE do_name index.
    // No audit loss worth preserving: runner keys are ephemeral in v1 and
    // scoped to (machineId, agentId).
    await db
      .delete(communityAgentRunnerKey)
      .where(eq(communityAgentRunnerKey.id, existing[0]!.id));
  }

  const { nanoid } = await import("nanoid");
  const bearer = RUNNER_KEY_PREFIX + nanoid(32);
  const runnerKeyHash = await hashCredential(bearer);
  const doName = doNameFromHash(runnerKeyHash);
  await db.insert(communityAgentRunnerKey).values({
    userId,
    machineId,
    agentId,
    runnerKeyHash,
    doName,
    createdAt: new Date().toISOString(),
  });
  return { runnerKey: bearer, existed: existing.length > 0 };
}

/**
 * Soft-revoke every active `crk_` for a machine. Called from machine delete
 * and reconnect (where `cmk_` is rotated but `machineId` stays stable) so
 * stale runner keys don't outlive the credential that authorized them.
 */
export async function revokeRunnerKeysForMachine(
  db: Database,
  machineId: string
): Promise<{ doNames: string[] }> {
  const rows = await db
    .update(communityAgentRunnerKey)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(communityAgentRunnerKey.machineId, machineId),
        isNull(communityAgentRunnerKey.revokedAt)
      )
    )
    .returning({ doName: communityAgentRunnerKey.doName });
  return { doNames: rows.map((r) => r.doName) };
}

/**
 * Statement-returning variant scoped by owner via subquery. Composed into
 * `db.batch([...])` inside the bot soft-delete flow so the revoke commits
 * atomically with the user-flag and member-row updates.
 *
 * Uses a subquery on `user.ownerUserId` rather than a plain `agentId = :id`
 * predicate — the batch must be a no-op against a cross-owner bot id, per
 * §Ownership scoping invariant in plans/community-bots.md.
 */
export function revokeRunnerKeysForAgentStatement(
  db: Database,
  agentUserId: string,
  ownerId: string
) {
  return db
    .update(communityAgentRunnerKey)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(communityAgentRunnerKey.agentId, agentUserId),
        isNull(communityAgentRunnerKey.revokedAt),
        inArray(
          communityAgentRunnerKey.userId,
          db
            .select({ id: user.id })
            .from(user)
            .where(
              and(
                eq(user.id, agentUserId),
                eq(user.ownerUserId, ownerId),
                eq(user.isBot, true)
              )
            )
        )
      )
    );
}

export async function findActiveAgentRunnerKeyByBearer(
  db: Database,
  bearer: string
): Promise<{
  userId: string;
  machineId: string;
  agentId: string;
  runnerKeyHash: string;
  doName: string;
} | null> {
  if (!bearer.startsWith(RUNNER_KEY_PREFIX)) return null;
  const hash = await hashCredential(bearer);
  const rows = await db
    .select({
      userId: communityAgentRunnerKey.userId,
      machineId: communityAgentRunnerKey.machineId,
      agentId: communityAgentRunnerKey.agentId,
      runnerKeyHash: communityAgentRunnerKey.runnerKeyHash,
      doName: communityAgentRunnerKey.doName,
    })
    .from(communityAgentRunnerKey)
    .innerJoin(user, eq(user.id, communityAgentRunnerKey.userId))
    .where(
      and(
        eq(communityAgentRunnerKey.runnerKeyHash, hash),
        isNull(communityAgentRunnerKey.revokedAt),
        isNull(user.deletedAt)
      )
    )
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// Machine listing / delete
// ---------------------------------------------------------------------------

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
  return rows.map((r) => toSummary(r as MachineRow));
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
    status: (row.status as "online" | "offline") ?? "offline",
    availableRuntimes: row.availableRuntimes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Read-path counterpart to `listBotsForMachine` (`bot.ts`) — given a bot's
 * `user.id`, answer whether it's currently online by following its
 * `communityBotBinding` to the bound machine's `status` column. A bot has no
 * WebSocket of its own (see `ws-durable.ts`'s `/check-user-online`), so
 * `status` on the bound machine IS the bot's presence, unlike a human where
 * presence is a live-socket check.
 */
export async function isBotOnline(db: Database, botUserId: string): Promise<boolean> {
  const rows = await db
    .select({ status: communityMachine.status })
    .from(communityBotBinding)
    .innerJoin(communityMachine, eq(communityMachine.id, communityBotBinding.machineId))
    .innerJoin(user, eq(user.id, communityBotBinding.userId))
    // Mirrors `listBotsForMachine`'s guards: a tombstoned or non-bot user
    // must never read back as online even if the binding row is still live.
    // The `isBot=true` check is defense-in-depth against a data-integrity
    // slip (nanoid re-issue, migration bug) putting a human user id into
    // `communityBotBinding` — the binding rows are supposed to be
    // bot-only, and this predicate should fail-closed if that invariant
    // ever slips rather than silently misattributing machine presence to
    // a human.
    .where(
      and(
        eq(communityBotBinding.userId, botUserId),
        isNull(user.deletedAt),
        eq(user.isBot, true),
      ),
    )
    .limit(1);
  return rows.length > 0 && isPresenceOnline(rows[0]!.status);
}
