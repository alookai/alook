import { readFileSync } from "node:fs";
import Sqlite from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../web/migrations/0102_community_push_device.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("community push device migration", () => {
  let sqlite: Sqlite.Database;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec("CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL)");
    sqlite.exec(migration);
  });

  afterEach(() => sqlite.close());

  function insertDevice(
    overrides: Partial<Record<string, string | null>> = {},
  ): void {
    const row = {
      id: "device-row-1",
      user_id: "user-1",
      installation_id: "installation-1",
      platform: "ios",
      provider_environment: "sandbox",
      provider_token_encrypted: "fake-ciphertext",
      provider_token_hash: "a".repeat(64),
      app_version: null,
      last_seen_at: "2026-09-12T00:00:00.000Z",
      disabled_at: null,
      created_at: "2026-09-12T00:00:00.000Z",
      updated_at: "2026-09-12T00:00:00.000Z",
      ...overrides,
    };

    sqlite
      .prepare(
        `INSERT INTO community_push_device (
          id, user_id, installation_id, platform, provider_environment,
          provider_token_encrypted, provider_token_hash, app_version,
          last_seen_at, disabled_at, created_at, updated_at
        ) VALUES (
          @id, @user_id, @installation_id, @platform, @provider_environment,
          @provider_token_encrypted, @provider_token_hash, @app_version,
          @last_seen_at, @disabled_at, @created_at, @updated_at
        )`,
      )
      .run(row);
  }

  it("creates the exact one-table, zero-trigger contract", () => {
    const columns = sqlite
      .prepare("PRAGMA table_info(community_push_device)")
      .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;

    expect(columns.map(({ name, notnull, dflt_value }) => ({
      name,
      notnull,
      default: dflt_value,
    }))).toEqual([
      { name: "id", notnull: 1, default: null },
      { name: "user_id", notnull: 1, default: null },
      { name: "installation_id", notnull: 1, default: null },
      { name: "platform", notnull: 1, default: null },
      { name: "provider_environment", notnull: 1, default: null },
      { name: "provider_token_encrypted", notnull: 1, default: null },
      { name: "provider_token_hash", notnull: 1, default: null },
      { name: "app_version", notnull: 0, default: null },
      { name: "last_seen_at", notnull: 1, default: null },
      { name: "disabled_at", notnull: 0, default: null },
      { name: "created_at", notnull: 1, default: null },
      { name: "updated_at", notnull: 1, default: null },
    ]);

    const indexes = sqlite
      .prepare("PRAGMA index_list(community_push_device)")
      .all() as Array<{ name: string; unique: number }>;
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "uq_push_device_installation", unique: 1 }),
      expect.objectContaining({ name: "idx_push_device_user_active", unique: 0 }),
      expect.objectContaining({ name: "idx_push_device_token_hash", unique: 0 }),
    ]));
    expect(sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger'",
    ).all()).toEqual([]);
  });

  it("enforces platform, environment, token-hash, and required fields", () => {
    sqlite.prepare("INSERT INTO user (id) VALUES (?)").run("user-1");

    expect(() => insertDevice({ platform: "web" })).toThrow();
    expect(() => insertDevice({ provider_environment: "development" })).toThrow();
    expect(() => insertDevice({ platform: "android" })).toThrow();
    expect(() => insertDevice({ provider_token_hash: "A".repeat(64) })).toThrow();
    expect(() => insertDevice({ provider_token_hash: "a".repeat(63) })).toThrow();
    expect(() => insertDevice({ provider_token_encrypted: null })).toThrow();

    expect(() => insertDevice({
      platform: "android",
      provider_environment: "production",
    })).not.toThrow();
  });

  it("keeps installation ids global and cascades account deletion", () => {
    sqlite.prepare("INSERT INTO user (id) VALUES (?)").run("user-1");
    insertDevice();

    expect(() => insertDevice({ id: "device-row-2" })).toThrow();
    sqlite.prepare("DELETE FROM user WHERE id = ?").run("user-1");

    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM community_push_device",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
