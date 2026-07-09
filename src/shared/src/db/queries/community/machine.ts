import { and, eq, gt, desc, isNull, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  communityMachineToken,
  communityMachine,
  communityMachineCredential,
  communityAgentRunnerKey,
  communityBotBinding,
} from "../../community-machine-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { COMMUNITY_MACHINE_PAIR_TOKEN_TTL_MS } from "../../../constants";
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

/**
 * Upsert-by-machine-id — the runtime path used by every `ready` frame and
 * every /activate reconnect. First-pair /activate calls `insertMachineRow`
 * instead (below) so the machine.id is minted by the insert.
 *
 * `markOnline` (default true) gates the `status: "online"` / `lastSeenAt`
 * write. The WS `ready`-frame handler is the only caller that actually KNOWS
 * there's a live socket, so it uses the default. /activate reconnect calls
 * this with `markOnline: false` — HTTP activation happens before the
 * daemon's WS connects, so flipping status here would make the row already
 * "online" by the time the real `ready` frame lands, and the DO's
 * `priorStatus !== 'online'` broadcast guard (which gates the bot-presence
 * fan-out, see `ws-durable.ts` `notifyUserDO`) would silently skip the
 * notification. Leaving status untouched here mirrors `insertMachineRow`,
 * which already withholds `lastSeenAt` for the same reason on first pair.
 */
export async function upsertMachineByMachineId(
  db: Database,
  userId: string,
  machineId: string,
  meta: MachineMetadataInput,
  opts: { markOnline?: boolean } = {}
): Promise<{
  machine: MachineRow;
  priorLastSeenAt: string | null;
  priorAvailableRuntimes: CommunityMachineRuntime[];
  priorStatus: "online" | "offline";
} | null> {
  const markOnline = opts.markOnline ?? true;
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
  const hostname = meta.hostname ?? prior.hostname;
  const nowIso = new Date().toISOString();
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
      availableRuntimes:
        meta.availableRuntimes !== undefined
          ? meta.availableRuntimes
          : prior.availableRuntimes,
      ...(markOnline ? { status: "online" as const, lastSeenAt: nowIso } : {}),
      updatedAt: nowIso,
    })
    .where(eq(communityMachine.id, prior.id))
    .returning();
  return {
    machine: rows[0] as MachineRow,
    priorLastSeenAt: prior.lastSeenAt,
    priorAvailableRuntimes: prior.availableRuntimes,
    priorStatus: (prior.status as "online" | "offline") ?? "offline",
  };
}

/**
 * Insert a brand-new community_machine row and return it. Used by /activate
 * when the pairing token isn't bound to an existing machine.
 */
async function insertMachineRow(
  db: Database,
  userId: string,
  meta: MachineMetadataInput
): Promise<MachineRow> {
  const hostname = meta.hostname ?? "";
  const nowIso = new Date().toISOString();
  const rows = await db
    .insert(communityMachine)
    .values({
      userId,
      displayName: hostname,
      hostname,
      platform: meta.platform ?? "",
      arch: meta.arch ?? "",
      osRelease: meta.osRelease ?? "",
      daemonVersion: meta.daemonVersion ?? "",
      metadata: meta.metadata ?? null,
      availableRuntimes: meta.availableRuntimes ?? [],
      // `lastSeenAt` stays null until the daemon's WS `ready` frame lands.
      // Setting it to `nowIso` here would flash a green "online" chip for
      // ~90s even if the daemon dies between HTTP activate and WS connect.
      lastSeenAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .returning();
  return rows[0] as MachineRow;
}

/**
 * Bump `last_seen_at` for a paired machine. Scopes by `machineId` (the
 * primary key), matching the Bearer-credential dial path.
 */
export async function touchMachineHeartbeat(
  db: Database,
  userId: string,
  machineId: string
): Promise<{ lastSeenAt: string; priorLastSeenAt: string | null } | null> {
  const existing = await db
    .select({ id: communityMachine.id, lastSeenAt: communityMachine.lastSeenAt })
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
  const nowIso = new Date().toISOString();
  await db
    .update(communityMachine)
    .set({ lastSeenAt: nowIso, updatedAt: nowIso })
    .where(eq(communityMachine.id, prior.id));
  return { lastSeenAt: nowIso, priorLastSeenAt: prior.lastSeenAt };
}

// ---------------------------------------------------------------------------
// Credential helpers — long-lived `cmk_` tokens the daemon dials with.
// ---------------------------------------------------------------------------

export interface ActivateMachineCredentialResult {
  credential: string;
  machineId: string;
  userId: string;
}

/**
 * Atomically exchange a pending pairing token for a long-lived credential.
 *
 * D1 has no interactive transactions, so operations are ordered so a
 * mid-way failure leaves recoverable state:
 *   1. verify token is pending + unexpired.
 *   2. atomically flip pending → revoked (racing activates get zero rows).
 *   3. resolve the machine row: reconnect (token.machineId set) reuses the
 *      existing row and revokes prior credentials; first-pair inserts a new
 *      row.
 *   4. insert a new community_machine_credential row, storing sha256(cmk_)
 *      and its first-32-hex do_name prefix. The plaintext `cmk_` is
 *      returned to the caller and never persisted.
 *
 * On any post-flip failure, the token is rolled back to `pending` so the
 * user can retry without regenerating.
 */
export async function activateMachineCredential(
  db: Database,
  tokenId: string,
  meta: MachineMetadataInput
): Promise<ActivateMachineCredentialResult> {
  const nowIso = new Date().toISOString();

  const tokenRows = await db
    .select({
      id: communityMachineToken.id,
      userId: communityMachineToken.userId,
      machineId: communityMachineToken.machineId,
      status: communityMachineToken.status,
      expiresAt: communityMachineToken.expiresAt,
    })
    .from(communityMachineToken)
    .where(eq(communityMachineToken.id, tokenId))
    .limit(1);
  if (tokenRows.length === 0) {
    throw new ActivateCredentialError("unknown", "unknown token");
  }
  const tok = tokenRows[0]!;
  if (tok.status === "revoked") {
    throw new ActivateCredentialError("revoked", "token already revoked");
  }
  if (tok.status === "active") {
    throw new ActivateCredentialError("already_active", "token already activated");
  }
  if (tok.expiresAt <= nowIso) {
    throw new ActivateCredentialError("expired", "token expired");
  }

  const flipped = await db
    .update(communityMachineToken)
    .set({ status: "revoked", lastUsedAt: nowIso })
    .where(
      and(
        eq(communityMachineToken.id, tokenId),
        eq(communityMachineToken.status, "pending")
      )
    )
    .returning({ id: communityMachineToken.id });
  if (flipped.length === 0) {
    throw new ActivateCredentialError("already_active", "token no longer claimable");
  }

  try {
    let machine: MachineRow;
    if (tok.machineId) {
      // `markOnline: false` — this runs before the daemon's WS connects, so
      // the real `ready` frame (not this HTTP call) must be the one that
      // flips status and fires the online/bot-presence broadcast. See
      // `upsertMachineByMachineId`'s doc comment.
      const existing = await upsertMachineByMachineId(db, tok.userId, tok.machineId, meta, {
        markOnline: false,
      });
      if (!existing) {
        // Machine was deleted between mint and activate. Don't roll the
        // token back to `pending` — that would loop the daemon forever and
        // the pending-token unique index blocks the user from minting a
        // fresh pair token for 15 min. Leave it `revoked` and surface a
        // terminal error so the user re-pairs from the UI.
        throw new ReconnectMachineMissingError();
      }
      // Reconnect — revoke every prior credential for this machine so the old
      // daemon dial fails on next upgrade. The new credential inserted below
      // becomes the sole valid one.
      await db
        .update(communityMachineCredential)
        .set({ revokedAt: nowIso })
        .where(
          and(
            eq(communityMachineCredential.machineId, tok.machineId),
            isNull(communityMachineCredential.revokedAt)
          )
        );
      machine = existing.machine;
    } else {
      machine = await insertMachineRow(db, tok.userId, meta);
    }

    // Mint the plaintext bearer, hash it, store the row, return the plaintext.
    const { nanoid } = await import("nanoid");
    const bearer = CREDENTIAL_PREFIX + nanoid(32);
    const credentialHash = await hashCredential(bearer);
    const doName = doNameFromHash(credentialHash);
    await db.insert(communityMachineCredential).values({
      userId: tok.userId,
      machineId: machine.id,
      credentialHash,
      doName,
      createdAt: nowIso,
    });

    return { credential: bearer, machineId: machine.id, userId: tok.userId };
  } catch (err) {
    // Terminal errors (machine deleted mid-reconnect) leave the token
    // revoked so the user can mint a new one immediately. Everything else
    // rolls the token back to `pending` so the caller can retry.
    if (err instanceof ReconnectMachineMissingError) {
      throw new ActivateCredentialError("unknown", err.message);
    }
    await db
      .update(communityMachineToken)
      .set({ status: "pending", lastUsedAt: null })
      .where(eq(communityMachineToken.id, tokenId));
    throw err;
  }
}

class ReconnectMachineMissingError extends Error {
  constructor() {
    super("reconnect token references missing machine");
    this.name = "ReconnectMachineMissingError";
  }
}

export type ActivateCredentialErrorKind =
  | "unknown"
  | "expired"
  | "revoked"
  | "already_active";

export class ActivateCredentialError extends Error {
  constructor(public readonly kind: ActivateCredentialErrorKind, message: string) {
    super(message);
    this.name = "ActivateCredentialError";
  }
}

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
    .where(
      and(
        eq(communityMachineCredential.credentialHash, hash),
        isNull(communityMachineCredential.revokedAt)
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
    .where(
      and(
        eq(communityAgentRunnerKey.runnerKeyHash, hash),
        isNull(communityAgentRunnerKey.revokedAt)
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
 * Flip a machine `online → offline` on WS close, scoped by the credential
 * hash that owns the closing connection. If the credential has been revoked
 * (rotation happened and a new DO instance is now authoritative), the guard
 * subquery trips and this is a no-op — the old DO's late close cannot clobber
 * the freshly-online row written by the new DO. Also a no-op when the row is
 * already offline (idempotent close handler) or belongs to a different user.
 */
export async function markMachineOffline(
  db: Database,
  args: { userId: string; machineId: string; credentialHash: string }
): Promise<MachineRow | null> {
  const nowIso = new Date().toISOString();
  const rows = await db
    .update(communityMachine)
    .set({ status: "offline", lastSeenAt: nowIso, updatedAt: nowIso })
    .where(
      and(
        eq(communityMachine.userId, args.userId),
        eq(communityMachine.id, args.machineId),
        eq(communityMachine.status, "online"),
        sql`EXISTS (SELECT 1 FROM ${communityMachineCredential} c WHERE c.machine_id = ${communityMachine.id} AND c.credential_hash = ${args.credentialHash} AND c.revoked_at IS NULL)`
      )
    )
    .returning();
  return rows.length ? (rows[0] as MachineRow) : null;
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
  return rows.length > 0 && rows[0]!.status === "online";
}

/**
 * Safety-net used by the DO's alarm live-WS branch. If we observe a live
 * community-machine socket for a machine whose row is stale-offline (e.g.
 * hibernated across a deploy where the daemon never re-emitted `ready`),
 * flip it back online so /community reflects reality. Same credential-hash
 * scope as `markMachineOffline` so a revoked-credential DO can't clobber
 * the new DO's state.
 */
export async function markMachineOnlineIfOffline(
  db: Database,
  args: { userId: string; machineId: string; credentialHash: string }
): Promise<MachineRow | null> {
  const nowIso = new Date().toISOString();
  const rows = await db
    .update(communityMachine)
    .set({ status: "online", lastSeenAt: nowIso, updatedAt: nowIso })
    .where(
      and(
        eq(communityMachine.userId, args.userId),
        eq(communityMachine.id, args.machineId),
        eq(communityMachine.status, "offline"),
        sql`EXISTS (SELECT 1 FROM ${communityMachineCredential} c WHERE c.machine_id = ${communityMachine.id} AND c.credential_hash = ${args.credentialHash} AND c.revoked_at IS NULL)`
      )
    )
    .returning();
  return rows.length ? (rows[0] as MachineRow) : null;
}
