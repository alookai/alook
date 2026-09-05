import { and, eq, gt, inArray, lt, or } from "drizzle-orm";
import {
  nativeOauthAttempt,
  type NativeOauthFailureCode,
  type NativeOauthPlatform,
  type NativeOauthProvider,
} from "../schema";
import type { Database } from "../index";

const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 2 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export type NativeOauthAttempt = typeof nativeOauthAttempt.$inferSelect;

export type NativeOauthRegistration = {
  id: string;
  instanceKeyHash: string;
  stateHash: string;
  pkceChallenge: string;
  provider: NativeOauthProvider;
  platform: NativeOauthPlatform;
  redirectPath: string;
};

export async function registerAttempt(
  db: Database,
  data: NativeOauthRegistration,
  now = Date.now(),
): Promise<NativeOauthAttempt> {
  const cleanupBefore = now - RETENTION_MS;
  const cleanup = db
    .delete(nativeOauthAttempt)
    .where(
      or(
        and(
          inArray(nativeOauthAttempt.status, [
            "consumed",
            "failed",
            "cancelled",
            "replaced",
          ]),
          lt(nativeOauthAttempt.updatedAt, cleanupBefore),
        ),
        lt(nativeOauthAttempt.attemptExpiresAt, cleanupBefore),
      ),
    );
  const replace = db
    .update(nativeOauthAttempt)
    .set({ status: "replaced", replacedAt: now, updatedAt: now })
    .where(
      and(
        eq(nativeOauthAttempt.instanceKeyHash, data.instanceKeyHash),
        inArray(nativeOauthAttempt.status, [
          "pending",
          "opened",
          "ready",
          "exchanging",
        ]),
      ),
    );
  const insert = db
    .insert(nativeOauthAttempt)
    .values({
      ...data,
      status: "pending",
      attemptExpiresAt: now + ATTEMPT_TTL_MS,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const results = await db.batch([cleanup, replace, insert]);
  const rows = results[2] as NativeOauthAttempt[];
  const row = rows[0];
  if (!row) throw new Error("native oauth registration did not return a row");
  return row;
}

export async function claimStart(
  db: Database,
  attemptId: string,
  now = Date.now(),
): Promise<NativeOauthAttempt | null> {
  const rows = await db
    .update(nativeOauthAttempt)
    .set({ status: "opened", openedAt: now, updatedAt: now })
    .where(
      and(
        eq(nativeOauthAttempt.id, attemptId),
        eq(nativeOauthAttempt.status, "pending"),
        gt(nativeOauthAttempt.attemptExpiresAt, now),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function getOpenedAttempt(
  db: Database,
  attemptId: string,
  now = Date.now(),
): Promise<NativeOauthAttempt | null> {
  const rows = await db
    .select()
    .from(nativeOauthAttempt)
    .where(
      and(
        eq(nativeOauthAttempt.id, attemptId),
        eq(nativeOauthAttempt.status, "opened"),
        gt(nativeOauthAttempt.attemptExpiresAt, now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function attachHandoff(
  db: Database,
  data: {
    attemptId: string;
    handoffCodeHash: string;
    authKind: "signin" | "signup";
  },
  now = Date.now(),
): Promise<NativeOauthAttempt | null> {
  const rows = await db
    .update(nativeOauthAttempt)
    .set({
      status: "ready",
      handoffCodeHash: data.handoffCodeHash,
      handoffExpiresAt: now + HANDOFF_TTL_MS,
      authKind: data.authKind,
      readyAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(nativeOauthAttempt.id, data.attemptId),
        eq(nativeOauthAttempt.status, "opened"),
        gt(nativeOauthAttempt.attemptExpiresAt, now + HANDOFF_TTL_MS),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function failOpenedAttempt(
  db: Database,
  attemptId: string,
  failureCode: Extract<
    NativeOauthFailureCode,
    "access_denied" | "provider_error" | "oauth_callback_failed" | "start_failed"
  >,
  now = Date.now(),
): Promise<NativeOauthAttempt | null> {
  const rows = await db
    .update(nativeOauthAttempt)
    .set({ status: "failed", failureCode, failedAt: now, updatedAt: now })
    .where(
      and(
        eq(nativeOauthAttempt.id, attemptId),
        eq(nativeOauthAttempt.status, "opened"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function claimExchange(
  db: Database,
  data: {
    attemptId: string;
    stateHash: string;
    pkceChallenge: string;
    handoffCodeHash: string;
  },
  now = Date.now(),
): Promise<NativeOauthAttempt | null> {
  const rows = await db
    .update(nativeOauthAttempt)
    .set({ status: "exchanging", updatedAt: now })
    .where(
      and(
        eq(nativeOauthAttempt.id, data.attemptId),
        eq(nativeOauthAttempt.stateHash, data.stateHash),
        eq(nativeOauthAttempt.pkceChallenge, data.pkceChallenge),
        eq(nativeOauthAttempt.handoffCodeHash, data.handoffCodeHash),
        eq(nativeOauthAttempt.status, "ready"),
        gt(nativeOauthAttempt.attemptExpiresAt, now),
        gt(nativeOauthAttempt.handoffExpiresAt, now),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function finishExchange(
  db: Database,
  data: {
    attemptId: string;
    stateHash: string;
    pkceChallenge: string;
    handoffCodeHash: string;
  },
  now = Date.now(),
): Promise<NativeOauthAttempt | null> {
  const rows = await db
    .update(nativeOauthAttempt)
    .set({ status: "consumed", consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(nativeOauthAttempt.id, data.attemptId),
        eq(nativeOauthAttempt.stateHash, data.stateHash),
        eq(nativeOauthAttempt.pkceChallenge, data.pkceChallenge),
        eq(nativeOauthAttempt.handoffCodeHash, data.handoffCodeHash),
        eq(nativeOauthAttempt.status, "exchanging"),
        gt(nativeOauthAttempt.attemptExpiresAt, now),
        gt(nativeOauthAttempt.handoffExpiresAt, now),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function failExchange(
  db: Database,
  attemptId: string,
  now = Date.now(),
): Promise<NativeOauthAttempt | null> {
  const rows = await db
    .update(nativeOauthAttempt)
    .set({
      status: "failed",
      failureCode: "invalid_handoff",
      failedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(nativeOauthAttempt.id, attemptId),
        eq(nativeOauthAttempt.status, "exchanging"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function cancelAttempt(
  db: Database,
  data: {
    attemptId: string;
    stateHash: string;
    pkceChallenge: string;
  },
  now = Date.now(),
): Promise<NativeOauthAttempt | null> {
  const rows = await db
    .update(nativeOauthAttempt)
    .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
    .where(
      and(
        eq(nativeOauthAttempt.id, data.attemptId),
        eq(nativeOauthAttempt.stateHash, data.stateHash),
        eq(nativeOauthAttempt.pkceChallenge, data.pkceChallenge),
        inArray(nativeOauthAttempt.status, [
          "pending",
          "opened",
          "ready",
          "exchanging",
        ]),
        gt(nativeOauthAttempt.attemptExpiresAt, now),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function getAttemptStatus(
  db: Database,
  data: {
    attemptId: string;
    stateHash: string;
    pkceChallenge: string;
  },
): Promise<NativeOauthAttempt | null> {
  const rows = await db
    .select()
    .from(nativeOauthAttempt)
    .where(
      and(
        eq(nativeOauthAttempt.id, data.attemptId),
        eq(nativeOauthAttempt.stateHash, data.stateHash),
        eq(nativeOauthAttempt.pkceChallenge, data.pkceChallenge),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export const nativeOauthDurations = {
  attemptTtlMs: ATTEMPT_TTL_MS,
  handoffTtlMs: HANDOFF_TTL_MS,
  retentionMs: RETENTION_MS,
} as const;
