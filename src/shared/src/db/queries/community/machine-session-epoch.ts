import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  communityAgentRunnerKey,
  communityMachine,
  communityMachineCredential,
  communityMachineToken,
} from "../../community-machine-schema";
import type { Database } from "../../index";
import {
  doNameFromHash,
  hashCredential,
  type MachineMetadataInput,
  type MachineRow,
} from "./machine";

const CREDENTIAL_PREFIX = "cmk_";

export type MachineSessionEpochCommand =
  | {
      type: "rotate";
      tokenId: string;
      expectedMachineId?: string;
      metadata: MachineMetadataInput;
    }
  | {
      type: "ready";
      epoch: MachineSessionEpoch;
      metadata: MachineMetadataInput;
    }
  | { type: "renew"; epoch: MachineSessionEpoch }
  | { type: "close"; epoch: MachineSessionEpoch }
  | { type: "expire"; epoch: MachineSessionEpoch };

export interface MachineSessionEpoch {
  userId: string;
  machineId: string;
  credentialHash: string;
}

export type MachineSessionEpochResult =
  | {
      type: "rotated";
      credential: string;
      machineId: string;
      userId: string;
      revokedDoNames: string[];
    }
  | {
      type: "transitioned";
      machine: MachineRow;
      priorLastSeenAt: string | null;
      priorAvailableRuntimes: MachineRow["availableRuntimes"];
      priorDaemonVersion: string;
      priorStatus: "online" | "offline";
    }
  | { type: "stale_epoch" };

/**
 * The sole state-transition boundary for a daemon's server-side session.
 * Rotation replaces the credential epoch atomically; every live-lease write
 * is fenced by that epoch, so delayed work from a revoked DO is a no-op.
 */
export function transitionMachineSessionEpoch(
  db: Database,
  command: Extract<MachineSessionEpochCommand, { type: "rotate" }>,
): Promise<Extract<MachineSessionEpochResult, { type: "rotated" }>>;
export function transitionMachineSessionEpoch(
  db: Database,
  command: Exclude<MachineSessionEpochCommand, { type: "rotate" }>,
): Promise<Exclude<MachineSessionEpochResult, { type: "rotated" }>>;
export async function transitionMachineSessionEpoch(
  db: Database,
  command: MachineSessionEpochCommand,
): Promise<MachineSessionEpochResult> {
  if (command.type === "rotate") return rotateMachineSessionEpoch(db, command);
  return transitionLiveLease(db, command);
}

async function transitionLiveLease(
  db: Database,
  command: Exclude<MachineSessionEpochCommand, { type: "rotate" }>,
): Promise<MachineSessionEpochResult> {
  const { epoch } = command;
  const existing = await db
    .select()
    .from(communityMachine)
    .where(
      and(
        eq(communityMachine.userId, epoch.userId),
        eq(communityMachine.id, epoch.machineId),
      ),
    )
    .limit(1);
  if (existing.length === 0) return { type: "stale_epoch" };

  const prior = existing[0]!;
  const nowIso = new Date().toISOString();
  const values = command.type === "ready"
    ? {
        hostname: command.metadata.hostname ?? prior.hostname,
        displayName: command.metadata.hostname ?? prior.hostname,
        platform: command.metadata.platform ?? prior.platform,
        arch: command.metadata.arch ?? prior.arch,
        osRelease: command.metadata.osRelease ?? prior.osRelease,
        daemonVersion: command.metadata.daemonVersion ?? prior.daemonVersion,
        timeZone: command.metadata.timeZone ?? prior.timeZone,
        metadata: command.metadata.metadata !== undefined
          ? command.metadata.metadata
          : prior.metadata,
        availableRuntimes: command.metadata.availableRuntimes !== undefined
          ? command.metadata.availableRuntimes
          : prior.availableRuntimes,
        status: "online" as const,
        lastSeenAt: nowIso,
        updatedAt: nowIso,
      }
    : command.type === "renew"
      ? { status: "online" as const, lastSeenAt: nowIso, updatedAt: nowIso }
      : { status: "offline" as const, lastSeenAt: nowIso, updatedAt: nowIso };
  const statusGuard = command.type === "close" || command.type === "expire"
    ? eq(communityMachine.status, "online")
    : undefined;
  const currentEpochMachineIds = db
    .select({ machineId: communityMachineCredential.machineId })
    .from(communityMachineCredential)
    .where(
      and(
        eq(communityMachineCredential.credentialHash, epoch.credentialHash),
        isNull(communityMachineCredential.revokedAt),
      ),
    );
  const rows = await db
    .update(communityMachine)
    .set(values)
    .where(
      and(
        eq(communityMachine.id, prior.id),
        statusGuard,
        inArray(communityMachine.id, currentEpochMachineIds),
      ),
    )
    .returning();
  if (rows.length === 0) return { type: "stale_epoch" };

  return {
    type: "transitioned",
    machine: rows[0] as MachineRow,
    priorLastSeenAt: prior.lastSeenAt,
    priorAvailableRuntimes: prior.availableRuntimes,
    priorDaemonVersion: prior.daemonVersion,
    priorStatus: (prior.status as "online" | "offline") ?? "offline",
  };
}

async function rotateMachineSessionEpoch(
  db: Database,
  command: Extract<MachineSessionEpochCommand, { type: "rotate" }>,
): Promise<Extract<MachineSessionEpochResult, { type: "rotated" }>> {
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
    .where(eq(communityMachineToken.id, command.tokenId))
    .limit(1);
  if (tokenRows.length === 0) {
    throw new MachineSessionRotationError("unknown", "unknown token", "not_committed");
  }
  const token = tokenRows[0]!;
  if (token.status === "revoked") {
    throw new MachineSessionRotationError("revoked", "token already revoked", "unknown");
  }
  if (token.status === "active") {
    throw new MachineSessionRotationError("already_active", "token already activated", "unknown");
  }
  if (token.expiresAt <= nowIso) {
    throw new MachineSessionRotationError("expired", "token expired", "not_committed");
  }
  if (token.machineId && !command.expectedMachineId) {
    throw new MachineSessionRotationError(
      "expected_machine_required",
      "reconnect requires an explicit expected machine id; update @alook/daemon and retry",
      "not_committed",
    );
  }
  if (command.expectedMachineId !== undefined && token.machineId !== command.expectedMachineId) {
    throw new MachineSessionRotationError(
      "machine_mismatch",
      "reconnect token does not match the expected machine",
      "not_committed",
    );
  }

  const claimed = await db
    .update(communityMachineToken)
    .set({ status: "revoked", lastUsedAt: nowIso })
    .where(
      and(
        eq(communityMachineToken.id, command.tokenId),
        eq(communityMachineToken.status, "pending"),
      ),
    )
    .returning({ id: communityMachineToken.id });
  if (claimed.length === 0) {
    throw new MachineSessionRotationError(
      "already_active",
      "token no longer claimable",
      "unknown",
    );
  }

  let credential: Awaited<ReturnType<typeof mintCredential>>;
  try {
    credential = await mintCredential();
  } catch (error) {
    await restoreClaimedToken(db, command.tokenId);
    throw error;
  }

  if (!token.machineId) {
    let machine: MachineRow;
    try {
      machine = await insertOfflineMachine(db, token.userId, command.metadata, nowIso);
      await db.insert(communityMachineCredential).values({
        userId: token.userId,
        machineId: machine.id,
        credentialHash: credential.hash,
        doName: credential.doName,
        createdAt: nowIso,
      });
    } catch (error) {
      await restoreClaimedToken(db, command.tokenId);
      throw error;
    }
    return {
      type: "rotated",
      credential: credential.bearer,
      machineId: machine.id,
      userId: token.userId,
      revokedDoNames: [],
    };
  }

  let prior: MachineRow;
  let revokedDoNames: string[];
  try {
    const existing = await db
      .select()
      .from(communityMachine)
      .where(
        and(
          eq(communityMachine.userId, token.userId),
          eq(communityMachine.id, token.machineId),
        ),
      )
      .limit(1);
    if (existing.length === 0) {
      throw new MachineSessionRotationError(
        "unknown",
        "reconnect token references missing machine",
        "unknown",
      );
    }
    prior = existing[0] as MachineRow;
    const priorCredentials = await db
      .select({ doName: communityMachineCredential.doName })
      .from(communityMachineCredential)
      .where(
        and(
          eq(communityMachineCredential.machineId, token.machineId),
          isNull(communityMachineCredential.revokedAt),
        ),
      );
    revokedDoNames = priorCredentials.map((row) => row.doName);
  } catch (error) {
    if (error instanceof MachineSessionRotationError && error.sessionOutcome === "unknown") {
      throw error;
    }
    await restoreClaimedToken(db, command.tokenId);
    throw error;
  }

  const hostname = command.metadata.hostname ?? prior.hostname;
  const updateMachine = db
    .update(communityMachine)
    .set({
      hostname,
      displayName: hostname,
      platform: command.metadata.platform ?? prior.platform,
      arch: command.metadata.arch ?? prior.arch,
      osRelease: command.metadata.osRelease ?? prior.osRelease,
      daemonVersion: command.metadata.daemonVersion ?? prior.daemonVersion,
      timeZone: command.metadata.timeZone ?? prior.timeZone,
      metadata: command.metadata.metadata !== undefined ? command.metadata.metadata : prior.metadata,
      availableRuntimes: command.metadata.availableRuntimes !== undefined
        ? command.metadata.availableRuntimes
        : prior.availableRuntimes,
      status: "offline",
      lastSeenAt: null,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(communityMachine.userId, token.userId),
        eq(communityMachine.id, token.machineId),
      ),
    )
    .returning();
  const revokeCredentials = db
    .update(communityMachineCredential)
    .set({ revokedAt: nowIso })
    .where(
      and(
        eq(communityMachineCredential.machineId, token.machineId),
        isNull(communityMachineCredential.revokedAt),
      ),
    );
  const insertCredential = db.insert(communityMachineCredential).values({
    userId: token.userId,
    machineId: token.machineId,
    credentialHash: credential.hash,
    doName: credential.doName,
    createdAt: nowIso,
  });
  const revokeRunnerKeys = db
    .update(communityAgentRunnerKey)
    .set({ revokedAt: nowIso })
    .where(
      and(
        eq(communityAgentRunnerKey.machineId, token.machineId),
        isNull(communityAgentRunnerKey.revokedAt),
      ),
    );
  // Once the batch is dispatched, a binding rejection is ambiguous: D1 may
  // have committed and the Worker may only have lost the response. Never
  // reopen the one-time token after dispatch; the client must fail closed and
  // mint a fresh reconnect token.
  await db.batch([
    updateMachine,
    revokeCredentials,
    insertCredential,
    revokeRunnerKeys,
  ]);

  // Commit boundary: after the batch resolves, do not await or inspect any
  // fallible result before reporting the newly committed epoch.
  return {
    type: "rotated",
    credential: credential.bearer,
    machineId: token.machineId,
    userId: token.userId,
    revokedDoNames,
  };
}

async function restoreClaimedToken(db: Database, tokenId: string): Promise<void> {
  await db
    .update(communityMachineToken)
    .set({ status: "pending", lastUsedAt: null })
    .where(eq(communityMachineToken.id, tokenId));
}

async function mintCredential(): Promise<{ bearer: string; hash: string; doName: string }> {
  const { nanoid } = await import("nanoid");
  const bearer = CREDENTIAL_PREFIX + nanoid(32);
  const hash = await hashCredential(bearer);
  return { bearer, hash, doName: doNameFromHash(hash) };
}

async function insertOfflineMachine(
  db: Database,
  userId: string,
  metadata: MachineMetadataInput,
  nowIso: string,
): Promise<MachineRow> {
  const hostname = metadata.hostname ?? "";
  const rows = await db
    .insert(communityMachine)
    .values({
      userId,
      displayName: hostname,
      hostname,
      platform: metadata.platform ?? "",
      arch: metadata.arch ?? "",
      osRelease: metadata.osRelease ?? "",
      daemonVersion: metadata.daemonVersion ?? "",
      timeZone: metadata.timeZone ?? null,
      metadata: metadata.metadata ?? null,
      availableRuntimes: metadata.availableRuntimes ?? [],
      status: "offline",
      lastSeenAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .returning();
  return rows[0] as MachineRow;
}

export type MachineSessionRotationErrorKind =
  | "unknown"
  | "expired"
  | "revoked"
  | "already_active"
  | "expected_machine_required"
  | "machine_mismatch";

export class MachineSessionRotationError extends Error {
  constructor(
    public readonly kind: MachineSessionRotationErrorKind,
    message: string,
    public readonly sessionOutcome: "not_committed" | "unknown",
  ) {
    super(message);
    this.name = "MachineSessionRotationError";
  }
}
