import { beforeEach, afterEach, describe, expect, it } from "vitest";
import Sqlite from "better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { userBilling, billingPrice } from "../../src/db/billing-schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import type { Database } from "../../src/db";
import * as billing from "../../src/db/queries/billing";
import { assignUserPlan, getBotCapacitySummary } from "../../src/db/queries/product-plan";

type Statement = { toSQL(): { sql: string }; all(): unknown[]; run(): unknown };
let sqlite: Sqlite.Database;
let db: Database;

beforeEach(() => {
  sqlite = new Sqlite(":memory:");
  sqlite.pragma("foreign_keys=ON");
  sqlite.exec(`
    CREATE TABLE user(id TEXT PRIMARY KEY, isBot INTEGER NOT NULL DEFAULT 0,
      ownerUserId TEXT, createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deletedAt TEXT);
    CREATE TABLE community_bot_binding(user_id TEXT PRIMARY KEY REFERENCES user(id), machine_id TEXT);
    INSERT INTO user(id) VALUES ('founder');
  `);
  sqlite.exec(readFileSync(new URL("../../../web/migrations/0098_product_plan_bot_active.sql", import.meta.url), "utf8"));
  sqlite.exec("INSERT INTO user(id) VALUES('new-user')");
  sqlite.exec(readFileSync(new URL("../../../web/migrations/0099_billing_founder.sql", import.meta.url), "utf8"));
  db = drizzle(sqlite) as unknown as Database;
  db.batch = (async (statements: Statement[]) => sqlite.transaction(() => statements.map((s) =>
    /^select\b|\breturning\b/i.test(s.toSQL().sql.trim()) ? s.all() : s.run(),
  ))()) as Database["batch"];
});
afterEach(() => sqlite.close());

const snapshot = {
  plan: { id: "house", displayName: "House" }, status: "active",
  currentPeriodEnd: null, cancelAt: null, scheduledChange: null,
};

async function ownerWithBots() {
  await assignUserPlan(db, "new-user", "house");
  for (let i = 0; i < 5; i++) {
    sqlite.prepare("INSERT INTO user(id,isBot,ownerUserId,createdAt) VALUES(?,1,'new-user',?)").run(`bot${i}`, `2026-01-0${i+1}`);
    sqlite.prepare("INSERT INTO community_bot_binding(user_id,machine_id) VALUES(?,'m')").run(`bot${i}`);
  }
  return (await billing.ensureBilling(db, "new-user"))!;
}

describe("billing transactional boundaries", () => {
  async function founderAttempt() {
    const row = (await billing.ensureBilling(db, "founder", true))!;
    return (await billing.updateBilling(db, row, { customerId: "cus-founder", checkoutAttempt: {
      id: "confirmed", priceId: "studio-price", email: "founder@example.test", origin: "http://localhost:3000",
      startedAt: 1, sessionId: "cs-founder", founderAcknowledged: true,
    } }, true))!;
  }

  it("requires explicit consent for Founder billing reservation", async () => {
    expect(await billing.ensureBilling(db, "founder")).toBeNull();
    const row = await founderAttempt();
    expect(row.checkoutAttempt?.founderAcknowledged).toBe(true);
    expect(await getBotCapacitySummary(db, "founder")).toMatchObject({ isFounder: true, limit: 40 });
  });

  it("converts a confirmed Founder atomically and never restores Founder after cancellation", async () => {
    sqlite.exec("INSERT INTO billing_price(price_id,plan_id) VALUES('studio-price','studio')");
    const row = await founderAttempt();
    for (let i = 0; i < 12; i++) {
      sqlite.prepare("INSERT INTO user(id,isBot,ownerUserId,createdAt) VALUES(?,1,'founder',?)").run(`fbot${i}`, `2026-01-${String(i+1).padStart(2,'0')}`);
      sqlite.prepare("INSERT INTO community_bot_binding(user_id,machine_id) VALUES(?,'m')").run(`fbot${i}`);
    }
    const patch = { subscriptionId: "sub-founder", subscription: { ...snapshot, plan: { id: "studio", displayName: "Studio" } }, checkoutAttempt: null };
    expect(await billing.applyBillingPlan(db, row, patch, "studio")).toEqual({ applied: false, deactivatedBotIds: [] });
    expect(await billing.applyBillingPlan(db, row, patch, "house", "confirmed")).toEqual({ applied: false, deactivatedBotIds: [] });
    expect(await billing.applyBillingPlan(db, row, patch, "studio", "wrong")).toEqual({ applied: false, deactivatedBotIds: [] });
    expect(await billing.applyBillingPlan(db, row, patch, "studio", "confirmed")).toEqual({ applied: true, deactivatedBotIds: ["fbot10", "fbot11"] });
    expect(await getBotCapacitySummary(db, "founder")).toMatchObject({ isFounder: false, plan: { id: "studio" }, ownedCount: 12, activeCount: 10 });
    expect(await billing.applyBillingPlan(db, row, patch, "studio", "confirmed")).toEqual({ applied: false, deactivatedBotIds: [] });
    const current = (await billing.getBilling(db, "founder"))!;
    await billing.applyBillingPlan(db, current, { subscription: null }, "free");
    expect(await getBotCapacitySummary(db, "founder")).toMatchObject({ isFounder: false, plan: { id: "free" }, ownedCount: 12, activeCount: 3 });
  });

  it("rolls back Founder removal if any later conversion statement fails", async () => {
    sqlite.exec("INSERT INTO billing_price(price_id,plan_id) VALUES('studio-price','studio')");
    const row = await founderAttempt();
    sqlite.exec("CREATE TRIGGER fail_founder_plan BEFORE UPDATE OF plan_id ON user_product_plan BEGIN SELECT RAISE(ABORT,'injected'); END");
    await expect(billing.applyBillingPlan(db, row, { subscriptionId: "sub-founder", subscription: snapshot, checkoutAttempt: null }, "studio", "confirmed")).rejects.toThrow("injected");
    expect(await getBotCapacitySummary(db, "founder")).toMatchObject({ isFounder: true, plan: { id: "house" } });
    expect(await billing.getBilling(db, "founder")).toMatchObject({ revision: row.revision, checkoutAttempt: { id: "confirmed" } });
  });

  it("reads public Free allowance from the active default entitlement without writes", async () => {
    const before = sqlite.prepare("SELECT total_changes() AS changes").get();
    expect(await billing.getDefaultPlanOffer(db)).toEqual({ plan: { id: "free", displayName: "Free" }, botLimit: 3 });
    expect(sqlite.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
    sqlite.exec("UPDATE product_plan_entitlement SET value_json='7' WHERE plan_id='free' AND entitlement_key='bots.max'");
    expect(await billing.getDefaultPlanOffer(db)).toMatchObject({ botLimit: 7 });
    sqlite.exec("UPDATE product_plan SET is_active=0 WHERE id='free'");
    await expect(billing.getDefaultPlanOffer(db)).rejects.toThrow("DEFAULT_PLAN_UNAVAILABLE");
  });

  it("backfills only prior House human assignments and keeps later humans Free", async () => {
    expect(await getBotCapacitySummary(db, "founder")).toMatchObject({ isFounder: true, plan: { id: "house" }, limit: 40 });
    expect(await getBotCapacitySummary(db, "new-user")).toMatchObject({ isFounder: false, plan: { id: "free" }, limit: 3 });
    expect(await billing.ensureBilling(db, "founder")).toBeNull();
  });

  it("updates the billing projection, assignment and deterministic overflow atomically", async () => {
    const row = await ownerWithBots();
    expect(await billing.applyBillingPlan(db, row, { subscriptionId: "sub1", subscription: snapshot }, "free"))
      .toEqual({ applied: true, deactivatedBotIds: ["bot3", "bot4"] });
    expect(await getBotCapacitySummary(db, "new-user")).toMatchObject({ plan: { id: "free" }, ownedCount: 5, activeCount: 3 });
    expect(await billing.getBilling(db, "new-user")).toMatchObject({ revision: 1, subscriptionId: "sub1" });
  });

  it("a stale snapshot loses every statement, including overflow", async () => {
    const old = await ownerWithBots();
    await billing.applyBillingPlan(db, old, { subscriptionId: "new-sub", subscription: snapshot }, "house");
    expect(await billing.applyBillingPlan(db, old, { subscriptionId: "old-sub" }, "free"))
      .toEqual({ applied: false, deactivatedBotIds: [] });
    expect(await getBotCapacitySummary(db, "new-user")).toMatchObject({ plan: { id: "house" }, activeCount: 5 });
    expect(await billing.getBilling(db, "new-user")).toMatchObject({ revision: 1, subscriptionId: "new-sub" });
  });

  it("rolls projection and assignment back when a trailing write fails", async () => {
    const row = await ownerWithBots();
    sqlite.exec("CREATE TRIGGER fail_deactivation BEFORE UPDATE OF is_active ON community_bot_binding BEGIN SELECT RAISE(ABORT,'injected'); END;");
    await expect(billing.applyBillingPlan(db, row, { subscriptionId: "sub1" }, "free")).rejects.toThrow("injected");
    expect(await billing.getBilling(db, "new-user")).toMatchObject({ revision: 0, subscriptionId: null });
    expect(await getBotCapacitySummary(db, "new-user")).toMatchObject({ plan: { id: "house" }, activeCount: 5 });
  });

  it("guards a concurrent Founder transition at batch execution", async () => {
    const row = await ownerWithBots();
    sqlite.exec("UPDATE user_product_plan SET is_founder=1 WHERE user_id='new-user'");
    expect(await billing.applyBillingPlan(db, row, { subscriptionId: "sub1" }, "free"))
      .toEqual({ applied: false, deactivatedBotIds: [] });
    await expect(assignUserPlan(db, "new-user", "free")).rejects.toThrow("PLAN_ASSIGNMENT_PROTECTED");
    expect(await getBotCapacitySummary(db, "new-user")).toMatchObject({ isFounder: true, activeCount: 5 });
    expect(await billing.updateBilling(db, row, { customerId: "cus-blocked" })).toBeNull();
  });

  it("does not apply a billing snapshot after its owner is deleted", async () => {
    const row = await ownerWithBots();
    sqlite.exec("UPDATE user SET deletedAt='2026-09-10' WHERE id='new-user'");
    expect(await billing.applyBillingPlan(db, row, { subscriptionId: "sub1" }, "free"))
      .toEqual({ applied: false, deactivatedBotIds: [] });
    expect(await billing.getBilling(db, "new-user")).toMatchObject({ revision: 0 });
  });

  it("reserves only one owner attempt and enforces unique customer mapping", async () => {
    const row = (await billing.ensureBilling(db, "new-user"))!;
    const attempt = { id: "attempt1", priceId: "price1", email: "qa@example.test", origin: "http://localhost:3000", startedAt: 1, sessionId: null };
    expect(await billing.updateBilling(db, row, { customerId: "cus1", checkoutAttempt: attempt })).toMatchObject({ revision: 1, checkoutAttempt: attempt });
    expect(await billing.updateBilling(db, row, { checkoutAttempt: { ...attempt, id: "attempt2" } })).toBeNull();
    sqlite.exec("INSERT INTO user(id) VALUES('other')");
    const other = (await billing.ensureBilling(db, "other"))!;
    await expect(billing.updateBilling(db, other, { customerId: "cus1" })).rejects.toThrow();
    expect((await billing.getBillingByCustomer(db, "cus1"))?.userId).toBe("new-user");
  });
});

describe("billing catalog persistence", () => {
  it("filters sales catalog while retaining disabled mappings for reconciliation", async () => {
    sqlite.exec("INSERT INTO billing_price(price_id,plan_id,enabled) VALUES('studio-on','studio',1),('house-off','house',0),('free-price','free',1)");
    expect((await billing.listPrices(db)).map((p) => p.priceId)).toEqual(["studio-on"]);
    expect((await billing.listPrices(db, true)).map((p) => p.priceId)).toEqual(["studio-on", "house-off"]);
    sqlite.exec("UPDATE product_plan SET is_active=0 WHERE id='studio'");
    expect(await billing.listPrices(db)).toEqual([]);
    expect((await billing.listPrices(db, true)).map((p) => p.priceId)).toEqual(["house-off"]);
  });

  it("requires an active default plan for billing fallback", async () => {
    expect(await billing.getDefaultPlan(db)).toEqual({ id: "free", displayName: "Free" });
    sqlite.exec("UPDATE product_plan SET is_active=0 WHERE id='free'");
    await expect(billing.getDefaultPlan(db)).rejects.toThrow("DEFAULT_PLAN_UNAVAILABLE");
  });

  it("rejects unavailable target allowances without changing billing state", async () => {
    const row = (await billing.ensureBilling(db, "new-user"))!;
    sqlite.exec("UPDATE product_plan_entitlement SET value_json='-1' WHERE plan_id='studio' AND entitlement_key='bots.max'");
    await expect(billing.applyBillingPlan(db, row, { subscriptionId: "sub" }, "studio")).rejects.toThrow("BILLING_PLAN_UNAVAILABLE");
    expect(await billing.getBilling(db, "new-user")).toEqual(row);
  });

  it("declares required foreign keys and unique Stripe identities, with a generated update timestamp", async () => {
    const prices = getTableConfig(billingPrice);
    const billingTable = getTableConfig(userBilling);
    expect(prices.foreignKeys.map((key) => ({ column: key.reference().columns[0].name, target: key.reference().foreignColumns[0].name, onDelete: key.onDelete })))
      .toEqual([{ column: "plan_id", target: "id", onDelete: "restrict" }]);
    expect(billingTable.foreignKeys.map((key) => ({ column: key.reference().columns[0].name, onDelete: key.onDelete })))
      .toEqual([{ column: "user_id", onDelete: "cascade" }]);
    expect(billingTable.indexes.map((index) => ({ name: index.config.name, unique: index.config.unique })))
      .toEqual([{ name: "uq_user_billing_customer", unique: true }, { name: "uq_user_billing_subscription", unique: true }]);
    const inserted = await db.insert(userBilling).values({ userId: "new-user" }).returning();
    expect(inserted[0]).toMatchObject({ userId: "new-user", revision: 0, customerId: null, subscriptionId: null });
    expect(Number.isFinite(Date.parse(inserted[0].updatedAt))).toBe(true);
    await expect(db.insert(billingPrice).values({ priceId: "bad", planId: "missing" })).rejects.toThrow();
  });
});
