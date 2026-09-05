import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sqlQuery, sqlRun } from "@alook/test-utils";

const TABLE = "native_oauth_attempt";
const NOW = 1_788_531_200_000;
const INSTANCE = "a".repeat(64);

function insertPending(id: string, instanceKeyHash = INSTANCE): void {
  sqlRun(
    `INSERT INTO ${TABLE} (
      id, instance_key_hash, state_hash, pkce_challenge, provider, platform,
      redirect_path, status, attempt_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'github', 'ios', '/c/me', 'pending', ?, ?, ?)`,
    id,
    instanceKeyHash,
    "b".repeat(64),
    "c".repeat(43),
    NOW + 600_000,
    NOW,
    NOW,
  );
}

beforeEach(() => sqlRun(`DELETE FROM ${TABLE}`));
afterAll(() => sqlRun(`DELETE FROM ${TABLE}`));

describe("native_oauth_attempt migration parity", () => {
  it("installs the frozen lifecycle columns and indexes", () => {
    const columns = sqlQuery<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>(`PRAGMA table_info(${TABLE})`);
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "instance_key_hash",
      "state_hash",
      "pkce_challenge",
      "provider",
      "platform",
      "redirect_path",
      "status",
      "handoff_code_hash",
      "handoff_expires_at",
      "auth_kind",
      "failure_code",
      "attempt_expires_at",
      "created_at",
      "updated_at",
      "opened_at",
      "ready_at",
      "consumed_at",
      "failed_at",
      "cancelled_at",
      "replaced_at",
    ]);
    expect(columns[0]).toMatchObject({
      name: "id",
      type: "TEXT",
      notnull: 1,
      pk: 1,
    });
    expect(
      sqlQuery<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name`,
        TABLE,
      ).map((row) => row.name),
    ).toEqual([
      "idx_native_oauth_attempt_id_status_expiry",
      "idx_native_oauth_attempt_instance_status",
      "idx_native_oauth_attempt_terminal_cleanup",
      "uq_native_oauth_attempt_handoff_hash",
      "uq_native_oauth_attempt_instance_live",
    ]);
  });

  it("enforces one live attempt per installation while permitting replacement", () => {
    insertPending("attempt_old_123456789012");
    expect(() => insertPending("attempt_new_123456789012")).toThrow(
      /UNIQUE constraint failed/i,
    );

    sqlRun(
      `UPDATE ${TABLE}
         SET status='replaced', replaced_at=?, updated_at=?
       WHERE id='attempt_old_123456789012'`,
      NOW + 1,
      NOW + 1,
    );
    expect(() => insertPending("attempt_new_123456789012")).not.toThrow();
  });

  it("rejects malformed hashes, unsafe redirects, invalid enums, and bad epochs", () => {
    expect(() => insertPending("too_short")).toThrow(/CHECK constraint failed/i);
    expect(() => {
      insertPending("attempt_bad_hash_12345678", "not-a-hash");
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      sqlRun(
        `INSERT INTO ${TABLE} (
          id, instance_key_hash, state_hash, pkce_challenge, provider, platform,
          redirect_path, status, attempt_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'twitter', 'ios', '//evil.example', 'pending', ?, ?, ?)`,
        "attempt_invalid_1234567890",
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(43),
        NOW + 1,
        NOW,
        NOW,
      );
    }).toThrow(/CHECK constraint failed/i);
  });
});
