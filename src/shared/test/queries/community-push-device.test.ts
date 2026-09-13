import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as coreSchema from "../../src/db/schema";
import * as communitySchema from "../../src/db/community-schema";
import type { Database } from "../../src/db";
import {
  disablePushDevice,
  listActivePushDevices,
  registerPushDevice,
  type RegisterPushDeviceInput,
} from "../../src/db/queries/community/push-device";

const schema = { ...coreSchema, ...communitySchema };

describe("community push device queries", () => {
  let sqlite: Sqlite.Database;
  let db: Database;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec("CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL)");
    sqlite.exec(`
      CREATE TABLE community_push_device (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        installation_id TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        provider_environment TEXT NOT NULL,
        provider_token_encrypted TEXT NOT NULL,
        provider_token_hash TEXT NOT NULL,
        app_version TEXT,
        last_seen_at TEXT NOT NULL,
        disabled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    sqlite.prepare("INSERT INTO user (id) VALUES (?), (?)").run("user-a", "user-b");
    db = drizzle(sqlite, { schema }) as unknown as Database;
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  function registration(
    overrides: Partial<RegisterPushDeviceInput> = {},
  ): RegisterPushDeviceInput {
    return {
      userId: "user-a",
      installationId: "installation-1",
      platform: "ios",
      providerEnvironment: "sandbox",
      providerTokenEncrypted: "fake-ciphertext-1",
      providerTokenHash: "a".repeat(64),
      appVersion: "1.0.0",
      now: "2026-09-12T00:00:00.000Z",
      ...overrides,
    };
  }

  function storedRow(): Record<string, unknown> {
    return sqlite.prepare(
      "SELECT * FROM community_push_device WHERE installation_id = ?",
    ).get("installation-1") as Record<string, unknown>;
  }

  it("declares the user cascade and applies timestamp defaults", async () => {
    const userForeignKey = getTableConfig(communitySchema.communityPushDevice)
      .foreignKeys[0]!;
    expect(userForeignKey.reference()).toMatchObject({
      columns: [{ name: "user_id" }],
      foreignColumns: [{ name: "id" }],
    });
    expect(userForeignKey.onDelete).toBe("cascade");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T04:05:06.000Z"));
    await db.insert(communitySchema.communityPushDevice).values({
      userId: "user-a",
      installationId: "installation-1",
      platform: "ios",
      providerEnvironment: "sandbox",
      providerTokenEncrypted: "fake-ciphertext-1",
      providerTokenHash: "a".repeat(64),
    });

    expect(storedRow()).toMatchObject({
      last_seen_at: "2026-09-12T04:05:06.000Z",
      created_at: "2026-09-12T04:05:06.000Z",
      updated_at: "2026-09-12T04:05:06.000Z",
    });
  });

  it("inserts, replays idempotently, and refreshes same-account metadata", async () => {
    const first = await registerPushDevice(db, registration());
    expect(first).toEqual({
      ok: true,
      device: {
        installationId: "installation-1",
        platform: "ios",
        providerEnvironment: "sandbox",
        appVersion: "1.0.0",
        lastSeenAt: "2026-09-12T00:00:00.000Z",
        disabledAt: null,
      },
    });
    expect(Object.keys(first.ok ? first.device : {})).not.toEqual(expect.arrayContaining([
      "userId",
      "providerTokenEncrypted",
      "providerTokenHash",
    ]));

    const originalId = storedRow().id;
    await registerPushDevice(db, registration({
      platform: "android",
      providerEnvironment: "production",
      providerTokenEncrypted: "fake-ciphertext-2",
      providerTokenHash: "b".repeat(64),
      appVersion: "2.0.0",
      now: "2026-09-12T01:00:00.000Z",
    }));

    expect(storedRow()).toMatchObject({
      id: originalId,
      user_id: "user-a",
      platform: "android",
      provider_environment: "production",
      provider_token_encrypted: "fake-ciphertext-2",
      provider_token_hash: "b".repeat(64),
      app_version: "2.0.0",
      last_seen_at: "2026-09-12T01:00:00.000Z",
      created_at: "2026-09-12T00:00:00.000Z",
      updated_at: "2026-09-12T01:00:00.000Z",
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM community_push_device",
    ).get()).toEqual({ count: 1 });
  });

  it("permits cross-account transfer only with current or previous token proof", async () => {
    await registerPushDevice(db, registration());

    await expect(registerPushDevice(db, registration({
      userId: "user-b",
      providerTokenEncrypted: "fake-current-proof-ciphertext",
    }))).resolves.toMatchObject({ ok: true });
    expect(storedRow()).toMatchObject({ user_id: "user-b" });

    await registerPushDevice(db, registration({
      userId: "user-b",
      providerTokenEncrypted: "fake-rotated-ciphertext",
      providerTokenHash: "b".repeat(64),
    }));
    await expect(registerPushDevice(db, registration({
      userId: "user-a",
      providerTokenEncrypted: "fake-new-account-ciphertext",
      providerTokenHash: "c".repeat(64),
      previousProviderTokenHash: "b".repeat(64),
    }))).resolves.toMatchObject({ ok: true });
    expect(storedRow()).toMatchObject({
      user_id: "user-a",
      provider_token_hash: "c".repeat(64),
    });
  });

  it("rejects an installation-id-only hijack without changing the row", async () => {
    await registerPushDevice(db, registration());
    const before = storedRow();

    await expect(registerPushDevice(db, registration({
      userId: "user-b",
      providerTokenEncrypted: "fake-attacker-ciphertext",
      providerTokenHash: "d".repeat(64),
      appVersion: "9.9.9",
      now: "2026-09-12T02:00:00.000Z",
    }))).resolves.toEqual({ ok: false, reason: "ownership-conflict" });

    expect(storedRow()).toEqual(before);
  });

  it("soft-disables only the owner and reactivates on registration", async () => {
    await registerPushDevice(db, registration());

    await expect(disablePushDevice(db, {
      userId: "user-b",
      installationId: "installation-1",
      now: "2026-09-12T01:00:00.000Z",
    })).resolves.toBe(false);
    await expect(disablePushDevice(db, {
      userId: "user-a",
      installationId: "missing-installation",
      now: "2026-09-12T01:00:00.000Z",
    })).resolves.toBe(false);
    await expect(disablePushDevice(db, {
      userId: "user-a",
      installationId: "installation-1",
      now: "2026-09-12T01:00:00.000Z",
    })).resolves.toBe(true);
    await expect(disablePushDevice(db, {
      userId: "user-a",
      installationId: "installation-1",
      now: "2026-09-12T02:00:00.000Z",
    })).resolves.toBe(false);
    expect(storedRow()).toMatchObject({
      disabled_at: "2026-09-12T01:00:00.000Z",
      updated_at: "2026-09-12T01:00:00.000Z",
    });

    await expect(registerPushDevice(db, registration({
      now: "2026-09-12T03:00:00.000Z",
    }))).resolves.toMatchObject({
      ok: true,
      device: { disabledAt: null },
    });
    expect(storedRow()).toMatchObject({ disabled_at: null });
  });

  it("returns every active device for one user without plaintext token fields", async () => {
    await registerPushDevice(db, registration());
    await registerPushDevice(db, registration({
      installationId: "installation-2",
      platform: "android",
      providerEnvironment: "production",
      providerTokenEncrypted: "fake-ciphertext-2",
      providerTokenHash: "b".repeat(64),
      now: "2026-09-12T01:00:00.000Z",
    }));
    await registerPushDevice(db, registration({
      userId: "user-b",
      installationId: "installation-3",
      providerTokenEncrypted: "fake-ciphertext-3",
      providerTokenHash: "c".repeat(64),
    }));
    await disablePushDevice(db, {
      userId: "user-a",
      installationId: "installation-2",
      now: "2026-09-12T02:00:00.000Z",
    });

    const devices = await listActivePushDevices(db, "user-a");

    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      installationId: "installation-1",
      platform: "ios",
      providerEnvironment: "sandbox",
      providerTokenEncrypted: "fake-ciphertext-1",
    });
    expect(devices[0]).not.toHaveProperty("providerTokenHash");
    expect(devices[0]).not.toHaveProperty("userId");
  });
});
