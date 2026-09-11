import { readFileSync } from "node:fs";
import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db";
import * as plans from "../../src/db/queries/product-plan";
import * as billing from "../../src/db/queries/billing";
import { createPairingToken, createReconnectPairingToken, hashCredential } from "../../src/db/queries/community/machine";
import { transitionMachineSessionEpoch } from "../../src/db/queries/community/machine-session-epoch";
import { createMachinePlanTables } from "./machine-plan-fixture";

let sqlite: Sqlite.Database;
let db: Database;
beforeEach(() => {
  sqlite = new Sqlite(":memory:");
  sqlite.exec(`CREATE TABLE user(id TEXT PRIMARY KEY, isBot INTEGER NOT NULL DEFAULT 0, ownerUserId TEXT, createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deletedAt TEXT);
    CREATE TABLE community_bot_binding(user_id TEXT PRIMARY KEY, machine_id TEXT);
    CREATE TABLE community_machine_token(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, machine_id TEXT, status TEXT NOT NULL DEFAULT 'pending', expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
    CREATE UNIQUE INDEX one_pending_token_per_owner ON community_machine_token(user_id) WHERE status='pending';`);
  createMachinePlanTables(sqlite);
  for (const migration of ["0098_product_plan_bot_active", "0099_billing_founder", "0101_machine_plan_limits"]) {
    sqlite.exec(readFileSync(new URL(`../../../web/migrations/${migration}.sql`, import.meta.url), "utf8"));
  }
  sqlite.exec("INSERT INTO user(id) VALUES('owner'),('other')");
  db = drizzle(sqlite) as unknown as Database;
  db.batch = (async (statements: Array<{ toSQL(): { sql: string; params: unknown[] }; all(): unknown[]; run(): unknown }>) =>
    sqlite.transaction(() => statements.map((s) => {
      const query = s.toSQL();
      const prepared = sqlite.prepare(query.sql);
      return prepared.reader ? s.all() : s.run();
    }))()) as Database["batch"];
});
afterEach(() => sqlite.close());

function machine(id: string, status = "offline", owner = "owner", createdAt = id) {
  sqlite.prepare("INSERT INTO community_machine(id,user_id,status,created_at) VALUES(?,?,?,?)").run(id, owner, status, createdAt);
  sqlite.prepare("INSERT INTO community_machine_credential(id,user_id,machine_id,credential_hash,do_name) VALUES(?,?,?,?,?)")
    .run(`cred-${id}`, owner, id, `hash-${id}`, `do-${id}`);
  sqlite.prepare("INSERT INTO community_agent_runner_key(id,user_id,machine_id,agent_id,runner_key_hash,do_name) VALUES(?,?,?,?,?,?)")
    .run(`key-${id}`, owner, id, `bot-${id}`, `keyhash-${id}`, `runner-${id}`);
}
function token(id: string, machineId: string | null = null, owner = "owner") {
  sqlite.prepare("INSERT INTO community_machine_token(id,user_id,machine_id,expires_at,created_at) VALUES(?,?,?,'9999-01-01','2026-01-01')").run(id, owner, machineId);
}
function ready(id: string, type: "ready" | "renew" = "ready") {
  return transitionMachineSessionEpoch(db, { type, epoch: { userId: "owner", machineId: id, credentialHash: `hash-${id}` }, metadata: { hostname: id } });
}
function rotate(id: string, expectedMachineId?: string) {
  return transitionMachineSessionEpoch(db, { type: "rotate", tokenId: id, expectedMachineId, metadata: { hostname: "test-host" } });
}

describe("machine plan SQL boundaries", () => {
  it("restores the pairing token and preserves a non-quota machine insert error", async () => {
    token("pending");
    sqlite.exec("CREATE TRIGGER fail_machine_insert BEFORE INSERT ON community_machine BEGIN SELECT RAISE(ABORT,'machine storage failure'); END");
    await expect(rotate("pending")).rejects.toThrow("machine storage failure");
    expect(sqlite.prepare("SELECT status FROM community_machine_token WHERE id='pending'").get()).toEqual({ status: "pending" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_machine").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_machine_credential").get()).toEqual({ n: 0 });
    sqlite.exec("DROP TRIGGER fail_machine_insert");
    await expect(rotate("pending")).resolves.toMatchObject({ type: "rotated" });
  });

  it("resolves Free/Studio/House and counts offline ownership without writes or owner leakage", async () => {
    machine("a"); machine("other-a", "online", "other");
    const before = sqlite.prepare("SELECT total_changes() AS n").get();
    expect(await plans.getMachineCapacitySummary(db, "owner")).toMatchObject({ limit: 1, ownedCount: 1, onlineCount: 0, isFounder: false });
    expect(sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    await plans.assignUserPlan(db, "owner", "studio");
    expect(await plans.getMachineCapacitySummary(db, "owner")).toMatchObject({ limit: 5 });
    await plans.assignUserPlan(db, "owner", "house");
    sqlite.exec("UPDATE user_product_plan SET is_founder=1 WHERE user_id='owner'");
    expect(await plans.getMachineCapacitySummary(db, "owner")).toMatchObject({ limit: 10, isFounder: true });
  });

  it("rejects pair and preissued activation at owned cap without consuming the pending token", async () => {
    token("pending"); machine("a");
    await expect(createPairingToken(db, "owner")).rejects.toBeInstanceOf(plans.MachineLimitReachedError);
    await expect(rotate("pending")).rejects.toBeInstanceOf(plans.MachineLimitReachedError);
    expect(sqlite.prepare("SELECT status FROM community_machine_token").get()).toEqual({ status: "pending" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_machine_credential").get()).toEqual({ n: 1 });
    sqlite.exec("DELETE FROM community_machine WHERE id='a'");
    await expect(createPairingToken(db, "owner")).resolves.toBeDefined();
  });

  it("atomically admits only one of two preissued activations into the last owned slot", async () => {
    token("left");
    const first = rotate("left");
    while ((sqlite.prepare("SELECT status FROM community_machine_token WHERE id='left'").get() as { status: string }).status === "pending") await Promise.resolve();
    token("right");
    const results = await Promise.allSettled([first, rotate("right")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(plans.MachineLimitReachedError);
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_machine WHERE user_id='owner'").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_machine_credential").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT status,count(*) AS n FROM community_machine_token GROUP BY status ORDER BY status").all())
      .toEqual([{ status: "pending", n: 1 }, { status: "revoked", n: 1 }]);
  });

  it("reconnects the same machine at owned cap, but rejects an offline reconnect at online cap", async () => {
    await plans.assignUserPlan(db, "owner", "house"); machine("a", "online"); machine("b");
    await plans.assignUserPlan(db, "owner", "free");
    await expect(createReconnectPairingToken(db, "owner", "b")).rejects.toBeInstanceOf(plans.MachineLimitReachedError);
    token("b-reconnect", "b");
    await expect(rotate("b-reconnect", "b")).rejects.toBeInstanceOf(plans.MachineLimitReachedError);
    expect(sqlite.prepare("SELECT status FROM community_machine_token WHERE id='b-reconnect'").get()).toEqual({ status: "pending" });
    expect(sqlite.prepare("SELECT revoked_at FROM community_machine_credential WHERE machine_id='b'").get()).toEqual({ revoked_at: null });
    await expect(createReconnectPairingToken(db, "owner", "a")).resolves.toBeDefined();
    const pending = sqlite.prepare("SELECT id FROM community_machine_token WHERE machine_id='a'").get() as { id: string };
    expect(await rotate(pending.id, "a")).toMatchObject({ machineId: "a" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_machine").get()).toEqual({ n: 2 });
  });

  it("serializes ready/renew admission and still permits the admitted machine heartbeat", async () => {
    await plans.assignUserPlan(db, "owner", "house"); machine("a"); machine("b");
    await plans.assignUserPlan(db, "owner", "free");
    const results = await Promise.all([ready("a"), ready("b", "renew")]);
    expect(results.map((r) => r.type).sort()).toEqual(["stale_epoch", "transitioned"]);
    expect(await ready("a", "renew")).toMatchObject({ type: "transitioned" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_machine WHERE status='online'").get()).toEqual({ n: 1 });
  });

  it("retains oldest machines with stable ID ties, preserving machines/bindings while revoking overflow epochs", async () => {
    await plans.assignUserPlan(db, "owner", "house");
    machine("b", "online", "owner", "same"); machine("a", "online", "owner", "same"); machine("c", "online", "owner", "z");
    sqlite.exec("INSERT INTO user(id,isBot,ownerUserId) VALUES('bot',1,'owner'); INSERT INTO community_bot_binding(user_id,machine_id) VALUES('bot','b')");
    const row = (await billing.ensureBilling(db, "owner"))!;
    const result = await billing.applyBillingPlan(db, row, { subscriptionId: "sub" }, "free");
    expect(result.disconnectedMachines).toEqual([{ machineId: "b", userId: "owner", doName: "do-b" }, { machineId: "c", userId: "owner", doName: "do-c" }]);
    expect(sqlite.prepare("SELECT id,status FROM community_machine ORDER BY id").all()).toEqual([{ id: "a", status: "online" }, { id: "b", status: "offline" }, { id: "c", status: "offline" }]);
    expect(sqlite.prepare("SELECT machine_id,is_active FROM community_bot_binding").get()).toEqual({ machine_id: "b", is_active: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_machine_credential WHERE revoked_at IS NOT NULL").get()).toEqual({ n: 2 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_agent_runner_key WHERE revoked_at IS NOT NULL").get()).toEqual({ n: 2 });
    expect(await ready("b")).toEqual({ type: "stale_epoch" });
    expect(await billing.applyBillingPlan(db, row, { subscriptionId: "stale" }, "free")).toMatchObject({ applied: false, disconnectedMachines: [] });
  });

  it("stale billing replay preserves a manually reconnected newer epoch", async () => {
    await plans.assignUserPlan(db, "owner", "house"); machine("a", "online"); machine("b", "online");
    const row = (await billing.ensureBilling(db, "owner"))!;
    await billing.applyBillingPlan(db, row, {}, "free");
    await transitionMachineSessionEpoch(db, { type: "close", epoch: { userId: "owner", machineId: "a", credentialHash: "hash-a" } });
    const pairing = await createReconnectPairingToken(db, "owner", "b");
    const rotated = await rotate(pairing.tokenId, "b");
    const hash = await hashCredential(rotated.credential);
    await transitionMachineSessionEpoch(db, { type: "ready", epoch: { userId: "owner", machineId: "b", credentialHash: hash }, metadata: { hostname: "fresh" } });
    expect(await billing.applyBillingPlan(db, row, {}, "free")).toMatchObject({ applied: false, disconnectedMachines: [] });
    expect(sqlite.prepare("SELECT status FROM community_machine WHERE id='b'").get()).toEqual({ status: "online" });
    expect(sqlite.prepare("SELECT revoked_at FROM community_machine_credential WHERE credential_hash=?").get(hash)).toEqual({ revoked_at: null });
  });

  it("changing a default machine allowance reconciles unassigned owners but not another plan", async () => {
    await plans.setPlanEntitlement(db, "free", "machines.max", 2);
    machine("a", "online"); machine("b", "online");
    await plans.assignUserPlan(db, "other", "studio"); machine("other-a", "online", "other"); machine("other-b", "online", "other");
    expect(await plans.setPlanEntitlement(db, "free", "machines.max", 1)).toMatchObject({ disconnectedMachines: [{ machineId: "b" }] });
    expect(await plans.getMachineCapacitySummary(db, "other")).toMatchObject({ onlineCount: 2, limit: 5 });
    await expect(plans.setPlanEntitlement(db, "free", "machines.max", "invalid")).rejects.toBeInstanceOf(plans.ProductEntitlementUnavailableError);
    expect(await plans.getMachineCapacitySummary(db, "owner")).toMatchObject({ limit: 1 });
  });

  it("rolls back billing, assignment, credential and runner writes when offline projection fails", async () => {
    await plans.assignUserPlan(db, "owner", "house"); machine("a", "online"); machine("b", "online");
    const row = (await billing.ensureBilling(db, "owner"))!;
    sqlite.exec("CREATE TRIGGER fail_offline BEFORE UPDATE OF status ON community_machine BEGIN SELECT RAISE(ABORT,'offline failure'); END");
    await expect(billing.applyBillingPlan(db, row, {}, "free")).rejects.toThrow("offline failure");
    expect(await plans.getMachineCapacitySummary(db, "owner")).toMatchObject({ limit: 10, onlineCount: 2 });
    expect((await billing.getBilling(db, "owner"))!.revision).toBe(row.revision);
    for (const table of ["community_machine_credential", "community_agent_runner_key"]) {
      expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE revoked_at IS NOT NULL`).get()).toEqual({ n: 0 });
    }
  });

  it("rejects malformed allowances before pair mutation and actual machine insertion", async () => {
    token("pending");
    sqlite.exec("UPDATE product_plan_entitlement SET value_json='\"unlimited\"' WHERE plan_id='free' AND entitlement_key='machines.max'");
    await expect(createPairingToken(db, "owner")).rejects.toBeInstanceOf(plans.ProductEntitlementUnavailableError);
    expect(() => machine("a")).toThrow("MACHINE_LIMIT_REACHED");
    expect(sqlite.prepare("SELECT status FROM community_machine_token").get()).toEqual({ status: "pending" });
  });
});
