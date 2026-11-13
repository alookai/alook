import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db";
import { submitFeedback } from "../../src/db/queries/community/feedback";
import { BotFeedbackSchema } from "../../src/community-feedback";

const migration = readFileSync(new URL("../../../web/migrations/0116_community_bot_feedback.sql", import.meta.url), "utf8");
describe("bot feedback migration, validation and persistence", () => {
  let sqlite: Sqlite.Database;
  let db: Database;
  let queries: { sql: string; params: unknown[] }[];
  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec("CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('owner'), ('bot');");
    sqlite.exec(migration);
    queries = [];
    db = drizzle(sqlite, { logger: { logQuery(sql, params) { queries.push({ sql, params }); } } }) as unknown as Database;
  });
  afterEach(() => sqlite.close());
  it.each(["a".repeat(10240), "😀".repeat(2560), "中".repeat(3413) + "a", "a" + "\u0000".repeat(10239)])("stores a full 10 KiB body with literal text and server identity", async (text) => {
    const result = await submitFeedback(db, "owner", "bot", { text });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('insert into "community_bot_feedback"');
    expect(queries[0]!.params).toEqual([expect.any(String), "owner", "bot", text, result.createdAt]);
    expect(sqlite.prepare("SELECT * FROM community_bot_feedback").get()).toEqual({
      id: expect.any(String), owner_id: "owner", bot_id: "bot", text, created_at: result.createdAt,
    });
  });
  it("rejects blank, oversized Unicode and injected identity fields without writing", async () => {
    for (const input of [{ text: " \n\t" }, { text: "😀".repeat(2560) + "a" }, { text: "中".repeat(3414) }, { text: "hello", ownerId: "other" }, { text: "hello", botId: "other" }]) {
      expect(BotFeedbackSchema.safeParse(input).success).toBe(false);
      await expect(submitFeedback(db, "owner", "bot", input)).rejects.toThrow();
    }
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_bot_feedback").get()).toEqual({ n: 0 });
  });
  it("enforces the migration byte constraint and foreign keys independently", () => {
    const insert = sqlite.prepare("INSERT INTO community_bot_feedback VALUES (?, ?, ?, ?, ?)");
    expect(() => insert.run("too-big", "owner", "bot", "😀".repeat(2561), "now")).toThrow(/CHECK/);
    expect(() => insert.run("empty", "owner", "bot", "", "now")).toThrow(/CHECK/);
    expect(() => insert.run("unknown", "owner", "unknown", "feedback", "now")).toThrow(/FOREIGN KEY/);
  });
});
