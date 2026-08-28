import Sqlite from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  testDirectory,
  "../../../web/migrations/0091_community_bot_reasoning_effort.sql",
);

describe("0091 community bot reasoning effort migration", () => {
  let sqlite: Sqlite.Database | undefined;

  afterEach(() => sqlite?.close());

  it("preserves existing bindings with Default effort and revision zero", () => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE community_bot_binding (
        user_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        model_name TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO community_bot_binding (
        user_id, machine_id, runtime, instruction, model_name, created_at
      ) VALUES ('bot_1', 'machine_1', 'codex', 'role', 'gpt-5', '2026-08-29');
    `);

    sqlite.exec(readFileSync(migrationPath, "utf8"));

    expect(sqlite.prepare(`
      SELECT user_id, reasoning_effort, runtime_config_revision
      FROM community_bot_binding
    `).get()).toEqual({
      user_id: "bot_1",
      reasoning_effort: null,
      runtime_config_revision: 0,
    });
  });
});
