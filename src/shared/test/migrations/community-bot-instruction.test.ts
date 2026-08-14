import Sqlite from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  testDirectory,
  "../../../web/migrations/0086_community_bot_instruction.sql",
);

describe("0086 community bot instruction migration", () => {
  let sqlite: Sqlite.Database | undefined;

  afterEach(() => sqlite?.close());

  it("preserves each existing public bio exactly and uses an empty fallback without a profile row", () => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE community_bot_binding (
        user_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        model_name TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE community_user_profile (
        user_id TEXT PRIMARY KEY,
        about_me TEXT
      );
    `);

    const exactBio = "  Exact owner role\nwith spacing  ";
    sqlite.prepare(`
      INSERT INTO community_bot_binding (user_id, machine_id, runtime, created_at)
      VALUES (?, 'machine_1', 'codex', '2026-01-01'), (?, 'machine_2', 'codex', '2026-01-01')
    `).run("bot_with_profile", "bot_without_profile");
    sqlite.prepare(`
      INSERT INTO community_user_profile (user_id, about_me) VALUES (?, ?)
    `).run("bot_with_profile", exactBio);

    sqlite.exec(readFileSync(migrationPath, "utf8"));

    expect(sqlite.prepare(`
      SELECT user_id, instruction FROM community_bot_binding ORDER BY user_id
    `).all()).toEqual([
      { user_id: "bot_with_profile", instruction: exactBio },
      { user_id: "bot_without_profile", instruction: "" },
    ]);
  });
});
