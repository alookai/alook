import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashCredential } from "../../src/db/queries/community/machine";
import { transitionMachineSessionEpoch } from "../../src/db/queries/community/machine-session-epoch";

const OLD_HASH = "a".repeat(64);
const OLD_DO = "a".repeat(32);

describe("machine session epoch SQL transaction", () => {
  let sqlite: Sqlite.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE community_machine_token (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        machine_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE community_machine (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        hostname TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        arch TEXT NOT NULL DEFAULT '',
        os_release TEXT NOT NULL DEFAULT '',
        daemon_version TEXT NOT NULL DEFAULT '',
        metadata TEXT,
        available_runtimes TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE community_machine_credential (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE,
        do_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE community_agent_runner_key (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        runner_key_hash TEXT NOT NULL UNIQUE,
        do_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
    `);
    db = drizzle(sqlite);
    // Match D1's all-or-nothing batch contract using real generated SQL.
    (db as any).batch = (statements: Array<{ toSQL: () => { sql: string; params: unknown[] } }>) =>
      sqlite.transaction(() => statements.map((statement) => {
        const query = statement.toSQL();
        const prepared = sqlite.prepare(query.sql);
        return prepared.reader ? prepared.all(...query.params) : prepared.run(...query.params);
      }))();
    seedCurrentEpoch();
  });

  afterEach(() => sqlite.close());

  function seedCurrentEpoch() {
    sqlite.prepare(`
      INSERT INTO community_machine
        (id, user_id, display_name, hostname, platform, arch, os_release,
         daemon_version, metadata, available_runtimes, status, last_seen_at,
         created_at, updated_at)
      VALUES
        ('cm_machine', 'u_1', 'old-host', 'old-host', 'darwin', 'arm64', '23',
         '0.1.0', NULL, '[]', 'online', '2026-08-18T00:00:00.000Z',
         '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')
    `).run();
    sqlite.prepare(`
      INSERT INTO community_machine_token
        (id, user_id, machine_id, status, expires_at, created_at)
      VALUES ('cmt_rotate', 'u_1', 'cm_machine', 'pending', '9999-01-01', '2026-08-18')
    `).run();
    sqlite.prepare(`
      INSERT INTO community_machine_credential
        (id, user_id, machine_id, credential_hash, do_name, created_at)
      VALUES ('cred_old', 'u_1', 'cm_machine', ?, ?, '2026-08-18')
    `).run(OLD_HASH, OLD_DO);
    sqlite.prepare(`
      INSERT INTO community_agent_runner_key
        (id, user_id, machine_id, agent_id, runner_key_hash, do_name, created_at)
      VALUES ('runner_old', 'u_1', 'cm_machine', 'bot_1', ?, ?, '2026-08-18')
    `).run("b".repeat(64), "b".repeat(32));
  }

  async function rotate() {
    return transitionMachineSessionEpoch(db as never, {
      type: "rotate",
      tokenId: "cmt_rotate",
      expectedMachineId: "cm_machine",
      metadata: {
        hostname: "new-host",
        platform: "darwin",
        arch: "arm64",
        daemonVersion: "0.1.12",
        availableRuntimes: [],
      },
    });
  }

  it("commits credential, runner, and offline projection together and fences the old epoch", async () => {
    const result = await rotate();
    const newHash = await hashCredential(result.credential);

    expect(sqlite.prepare(`
      SELECT status, last_seen_at AS lastSeenAt, hostname
      FROM community_machine WHERE id = 'cm_machine'
    `).get()).toEqual({ status: "offline", lastSeenAt: null, hostname: "new-host" });
    expect(sqlite.prepare(`
      SELECT credential_hash AS credentialHash, revoked_at AS revokedAt
      FROM community_machine_credential ORDER BY id
    `).all()).toEqual(expect.arrayContaining([
      { credentialHash: OLD_HASH, revokedAt: expect.any(String) },
      { credentialHash: newHash, revokedAt: null },
    ]));
    expect(sqlite.prepare(`
      SELECT revoked_at AS revokedAt FROM community_agent_runner_key WHERE id = 'runner_old'
    `).get()).toEqual({ revokedAt: expect.any(String) });
    expect(sqlite.prepare(`
      SELECT status FROM community_machine_token WHERE id = 'cmt_rotate'
    `).get()).toEqual({ status: "revoked" });

    const oldEpoch = { userId: "u_1", machineId: "cm_machine", credentialHash: OLD_HASH };
    await expect(transitionMachineSessionEpoch(db as never, {
      type: "ready",
      epoch: oldEpoch,
      metadata: { hostname: "stale-host" },
    })).resolves.toEqual({ type: "stale_epoch" });

    const currentEpoch = { userId: "u_1", machineId: "cm_machine", credentialHash: newHash };
    await expect(transitionMachineSessionEpoch(db as never, {
      type: "ready",
      epoch: currentEpoch,
      metadata: { hostname: "current-host" },
    })).resolves.toMatchObject({ type: "transitioned", machine: { status: "online" } });
    for (const type of ["renew", "close", "expire"] as const) {
      await expect(transitionMachineSessionEpoch(db as never, {
        type,
        epoch: oldEpoch,
      })).resolves.toEqual({ type: "stale_epoch" });
    }
    expect(sqlite.prepare(`
      SELECT status, hostname FROM community_machine WHERE id = 'cm_machine'
    `).get()).toEqual({ status: "online", hostname: "current-host" });
  });

  it("rolls back DB state but keeps the token consumed when a dispatched batch rejects", async () => {
    sqlite.exec(`
      CREATE TRIGGER reject_new_machine_credential
      BEFORE INSERT ON community_machine_credential
      BEGIN
        SELECT RAISE(ABORT, 'injected credential insert failure');
      END;
    `);

    await expect(rotate()).rejects.toThrow("injected credential insert failure");

    expect(sqlite.prepare(`
      SELECT status, last_seen_at AS lastSeenAt, hostname
      FROM community_machine WHERE id = 'cm_machine'
    `).get()).toEqual({
      status: "online",
      lastSeenAt: "2026-08-18T00:00:00.000Z",
      hostname: "old-host",
    });
    expect(sqlite.prepare(`
      SELECT credential_hash AS credentialHash, revoked_at AS revokedAt
      FROM community_machine_credential
    `).all()).toEqual([{ credentialHash: OLD_HASH, revokedAt: null }]);
    expect(sqlite.prepare(`
      SELECT revoked_at AS revokedAt FROM community_agent_runner_key WHERE id = 'runner_old'
    `).get()).toEqual({ revokedAt: null });
    expect(sqlite.prepare(`
      SELECT status, last_used_at AS lastUsedAt FROM community_machine_token WHERE id = 'cmt_rotate'
    `).get()).toEqual({ status: "revoked", lastUsedAt: expect.any(String) });
  });
});
