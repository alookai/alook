import Sqlite from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";
import type { Database } from "../index";
import {
  attachHandoff,
  cancelAttempt,
  claimExchange,
  claimStart,
  failExchange,
  failOpenedAttempt,
  finishExchange,
  getAttemptStatus,
  getOpenedAttempt,
  registerAttempt,
} from "./native-oauth";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../web/migrations/0095_native_oauth_attempt.sql",
);

const NOW = 1_788_531_200_000;
const STATE_HASH = "a".repeat(64);
const INSTANCE_HASH = "b".repeat(64);
const CHALLENGE = "c".repeat(43);
const CODE_HASH = "d".repeat(64);

type BatchStatement = { all(): unknown; run(): unknown };

function createTestDb(sqlite: Sqlite.Database): Database {
  const db = drizzle(sqlite, { schema });
  Object.assign(db, {
    batch: async (statements: BatchStatement[]) =>
      sqlite.transaction(() =>
        statements.map((statement, index) =>
          index === statements.length - 1 ? statement.all() : statement.run(),
        ),
      )(),
  });
  return db as unknown as Database;
}

function registration(id: string, instanceKeyHash = INSTANCE_HASH) {
  return {
    id,
    instanceKeyHash,
    stateHash: STATE_HASH,
    pkceChallenge: CHALLENGE,
    provider: "github" as const,
    platform: "macos" as const,
    redirectPath: "/c/me",
  };
}

describe("native oauth attempt queries", () => {
  let sqlite: Sqlite.Database;
  let db: Database;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(readFileSync(migrationPath, "utf8"));
    db = createTestDb(sqlite);
  });

  afterEach(() => sqlite.close());

  it("atomically replaces the prior live attempt for an installation", async () => {
    const oldId = "old_attempt_123456789012";
    const newId = "new_attempt_123456789012";
    await registerAttempt(db, registration(oldId), NOW);
    await registerAttempt(db, registration(newId), NOW + 1);

    expect(sqlite.prepare(
      "SELECT id, status FROM native_oauth_attempt ORDER BY created_at",
    ).all()).toEqual([
      { id: oldId, status: "replaced" },
      { id: newId, status: "pending" },
    ]);
  });

  it("fails closed when registration does not return the inserted row", async () => {
    const statement = {
      where: vi.fn(() => statement),
      set: vi.fn(() => statement),
      values: vi.fn(() => statement),
      returning: vi.fn(() => statement),
    };
    const emptyDb = {
      delete: vi.fn(() => statement),
      update: vi.fn(() => statement),
      insert: vi.fn(() => statement),
      batch: vi.fn(async () => [[], [], []]),
    } as unknown as Database;

    await expect(
      registerAttempt(
        emptyDb,
        registration("missing_attempt_123456789"),
        NOW,
      ),
    ).rejects.toThrow("native oauth registration did not return a row");
  });

  it("reads and fails only a live opened attempt", async () => {
    const id = "opened_attempt_1234567890";
    await registerAttempt(db, registration(id), NOW);
    await claimStart(db, id, NOW + 1);

    await expect(getOpenedAttempt(db, id, NOW + 2)).resolves.toMatchObject({
      id,
      status: "opened",
    });
    await expect(
      failOpenedAttempt(db, id, "provider_error", NOW + 3),
    ).resolves.toMatchObject({ status: "failed", failureCode: "provider_error" });
    await expect(getOpenedAttempt(db, id, NOW + 4)).resolves.toBeNull();
    await expect(
      failOpenedAttempt(db, id, "provider_error", NOW + 4),
    ).resolves.toBeNull();
  });

  it("does not mutate ready state for a wrong handoff hash", async () => {
    const id = "exchange_attempt_12345678";
    await registerAttempt(db, registration(id), NOW);
    await claimStart(db, id, NOW + 1);
    await attachHandoff(db, {
      attemptId: id,
      handoffCodeHash: CODE_HASH,
      authKind: "signin",
    }, NOW + 2);

    await expect(claimExchange(db, {
      attemptId: id,
      stateHash: STATE_HASH,
      pkceChallenge: CHALLENGE,
      handoffCodeHash: "e".repeat(64),
    }, NOW + 3)).resolves.toBeNull();
    expect(sqlite.prepare(
      "SELECT status, updated_at FROM native_oauth_attempt WHERE id = ?",
    ).get(id)).toEqual({ status: "ready", updated_at: NOW + 2 });
  });

  it("claims and consumes a handoff exactly once", async () => {
    const id = "replay_attempt_1234567890";
    await registerAttempt(db, registration(id), NOW);
    await claimStart(db, id, NOW + 1);
    await attachHandoff(db, {
      attemptId: id,
      handoffCodeHash: CODE_HASH,
      authKind: "signin",
    }, NOW + 2);
    const proof = {
      attemptId: id,
      stateHash: STATE_HASH,
      pkceChallenge: CHALLENGE,
      handoffCodeHash: CODE_HASH,
    };

    await expect(claimExchange(db, proof, NOW + 3)).resolves.toMatchObject({
      status: "exchanging",
    });
    await expect(claimExchange(db, proof, NOW + 3)).resolves.toBeNull();
    await expect(finishExchange(db, proof, NOW + 4)).resolves.toMatchObject({
      status: "consumed",
    });
    await expect(finishExchange(db, proof, NOW + 4)).resolves.toBeNull();
  });

  it("fails only a claimed exchange", async () => {
    const id = "failed_exchange_123456789";
    await registerAttempt(db, registration(id), NOW);
    await claimStart(db, id, NOW + 1);
    await attachHandoff(db, {
      attemptId: id,
      handoffCodeHash: CODE_HASH,
      authKind: "signin",
    }, NOW + 2);
    await claimExchange(db, {
      attemptId: id,
      stateHash: STATE_HASH,
      pkceChallenge: CHALLENGE,
      handoffCodeHash: CODE_HASH,
    }, NOW + 3);

    await expect(failExchange(db, id, NOW + 4)).resolves.toMatchObject({
      status: "failed",
      failureCode: "invalid_handoff",
    });
    await expect(failExchange(db, id, NOW + 5)).resolves.toBeNull();
  });

  it("rejects expired starts and handoffs that cannot retain a full two minutes", async () => {
    const expiredId = "expired_attempt_123456789";
    await registerAttempt(db, registration(expiredId), NOW);
    await expect(
      claimStart(db, expiredId, NOW + 10 * 60 * 1000),
    ).resolves.toBeNull();

    const shortId = "short_attempt_12345678901";
    await registerAttempt(db, registration(shortId, "f".repeat(64)), NOW);
    await claimStart(db, shortId, NOW + 1);
    await expect(attachHandoff(db, {
      attemptId: shortId,
      handoffCodeHash: CODE_HASH,
      authKind: "signin",
    }, NOW + 8 * 60 * 1000 + 1)).resolves.toBeNull();
    await expect(getAttemptStatus(db, {
      attemptId: shortId,
      stateHash: STATE_HASH,
      pkceChallenge: CHALLENGE,
    })).resolves.toMatchObject({ status: "opened" });
  });

  it("lets cancellation beat a claimed exchange and withholds consumption", async () => {
    const id = "cancel_attempt_1234567890";
    await registerAttempt(db, registration(id), NOW);
    await claimStart(db, id, NOW + 1);
    await attachHandoff(db, {
      attemptId: id,
      handoffCodeHash: CODE_HASH,
      authKind: "signup",
    }, NOW + 2);
    await claimExchange(db, {
      attemptId: id,
      stateHash: STATE_HASH,
      pkceChallenge: CHALLENGE,
      handoffCodeHash: CODE_HASH,
    }, NOW + 3);

    await expect(cancelAttempt(db, {
      attemptId: id,
      stateHash: STATE_HASH,
      pkceChallenge: CHALLENGE,
    }, NOW + 4)).resolves.toMatchObject({ status: "cancelled" });
    await expect(finishExchange(db, {
      attemptId: id,
      stateHash: STATE_HASH,
      pkceChallenge: CHALLENGE,
      handoffCodeHash: CODE_HASH,
    }, NOW + 5)).resolves.toBeNull();
  });

  it("rejects stale proof after a newer registration", async () => {
    const oldId = "stale_attempt_12345678901";
    const newId = "fresh_attempt_12345678901";
    await registerAttempt(db, registration(oldId), NOW);
    await registerAttempt(db, registration(newId), NOW + 1);

    await expect(cancelAttempt(db, {
      attemptId: oldId,
      stateHash: STATE_HASH,
      pkceChallenge: CHALLENGE,
    }, NOW + 2)).resolves.toBeNull();
    await expect(getAttemptStatus(db, {
      attemptId: newId,
      stateHash: STATE_HASH,
      pkceChallenge: CHALLENGE,
    })).resolves.toMatchObject({ status: "pending" });
  });
});
