import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  projectServerRailCommit,
  type ServerRailCommitRequest,
  type ServerRailState,
} from "../../src/community-server-rail";
import {
  buildServerRailWriteStatements,
  readServerRailSnapshot,
} from "../../src/db/queries/community/server-rail";

function createDatabase() {
  const sqlite = new Sqlite(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE community_server (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE community_server_member (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      rail_order INTEGER DEFAULT 0,
      joined_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX uq_server_member_server_user
      ON community_server_member(server_id, user_id);
    CREATE TABLE community_server_folder (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0
    );
    CREATE TABLE community_server_folder_item (
      folder_id TEXT NOT NULL REFERENCES community_server_folder(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
      position INTEGER DEFAULT 0,
      PRIMARY KEY(folder_id, server_id)
    );
  `);
  return { sqlite, db: drizzle(sqlite) };
}

function runProjection(
  sqlite: Sqlite.Database,
  db: ReturnType<typeof drizzle>,
  state: ServerRailState,
  request: ServerRailCommitRequest,
  createId = () => "created",
) {
  const result = projectServerRailCommit(state, request, createId);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  const statements = buildServerRailWriteStatements(db as any, "u1", result.value);
  sqlite.transaction(() => {
    for (const statement of statements) statement.run();
  })();
  return { projection: result.value, statements };
}

function seedMemberships(sqlite: Sqlite.Database, ids: string[]) {
  const server = sqlite.prepare("INSERT INTO community_server (id) VALUES (?)");
  const member = sqlite.prepare(`
    INSERT INTO community_server_member (id, server_id, user_id, rail_order, joined_at)
    VALUES (?, ?, 'u1', ?, ?)
  `);
  ids.forEach((id, index) => {
    server.run(id);
    member.run(`member-${id}`, id, index, `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`);
  });
}

describe("community server rail D1 statements", () => {
  it("reads memberships, folders, and items in one consistent three-statement batch", async () => {
    const statementRows = [
      [{ serverId: "s1" }, { serverId: "s2" }],
      [{ id: "f1", name: "One" }],
      [{ folderId: "f1", serverId: "s2" }],
    ];
    const db: any = {
      select: () => {
        const chain: any = {};
        for (const name of ["from", "innerJoin", "where", "orderBy"]) {
          chain[name] = () => chain;
        }
        return chain;
      },
      batch: async (statements: unknown[]) => {
        expect(statements).toHaveLength(3);
        return statementRows;
      },
    };
    await expect(readServerRailSnapshot(db, "u1")).resolves.toEqual({
      serverOrder: ["s1", "s2"],
      folderOrder: ["f1"],
      folders: { f1: { id: "f1", name: "One", serverIds: ["s2"] } },
    });
  });

  it("reorders 125 memberships with one JSON expansion and fixed bind count", () => {
    const { sqlite, db } = createDatabase();
    const ids = Array.from({ length: 125 }, (_, index) => `s${index}`);
    seedMemberships(sqlite, ids);
    const state: ServerRailState = { serverOrder: ids, folderOrder: [], folders: {} };
    const { statements } = runProjection(sqlite, db, state, {
      commands: [{ kind: "reorder-servers", serverIds: [...ids].reverse() }],
    });
    expect(statements).toHaveLength(1);
    const query = statements[0].toSQL();
    expect(query.sql).toContain("json_each");
    expect(query.params).toHaveLength(2);
    expect(query.params.every((param: unknown) => typeof param === "string")).toBe(true);
    const order = sqlite.prepare(`
      SELECT server_id AS id FROM community_server_member
      WHERE user_id = 'u1' ORDER BY rail_order, server_id
    `).all().map((row: any) => row.id);
    expect(order).toEqual([...ids].reverse());
  });

  it("inserts 125 guarded folder items from one JSON statement", () => {
    const { sqlite, db } = createDatabase();
    const ids = Array.from({ length: 125 }, (_, index) => `s${index}`);
    seedMemberships(sqlite, ids);
    const state: ServerRailState = { serverOrder: ids, folderOrder: [], folders: {} };
    const { statements } = runProjection(sqlite, db, state, {
      commands: [{ kind: "create-folder", clientId: "tmp", name: "Group", serverIds: ids }],
    });
    expect(statements.length).toBeLessThanOrEqual(9);
    const itemInsert = statements.find((statement) => {
      const query = statement.toSQL();
      return query.sql.includes("insert into \"community_server_folder_item\"");
    });
    expect(itemInsert).toBeDefined();
    const itemQuery = itemInsert!.toSQL();
    expect(itemQuery.sql).toContain("json_each");
    expect(itemQuery.params.length).toBeLessThanOrEqual(100);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM community_server_folder_item WHERE folder_id = 'created'
    `).get()).toEqual({ count: 125 });
    const positions = sqlite.prepare(`
      SELECT position FROM community_server_folder_item
      WHERE folder_id = 'created' ORDER BY position
    `).all().map((row: any) => row.position);
    expect(positions).toEqual(Array.from({ length: 125 }, (_, index) => index));
  });

  it("rolls back the whole write when membership disappears before guarded insert", () => {
    const { sqlite, db } = createDatabase();
    seedMemberships(sqlite, ["a", "b"]);
    const state: ServerRailState = { serverOrder: ["a", "b"], folderOrder: [], folders: {} };
    const result = projectServerRailCommit(state, {
      commands: [{ kind: "create-folder", clientId: "tmp", name: "Group", serverIds: ["a", "b"] }],
    }, () => "created");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const statements = buildServerRailWriteStatements(db as any, "u1", result.value);
    sqlite.prepare("DELETE FROM community_server_member WHERE user_id = 'u1' AND server_id = 'b'").run();
    expect(() => sqlite.transaction(() => {
      for (const statement of statements) statement.run();
    })()).toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_server_folder").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_server_folder_item").get()).toEqual({ count: 0 });
  });

  it("lets a stale same-folder reorder win without leaving a duplicate in another folder", () => {
    const { sqlite, db } = createDatabase();
    seedMemberships(sqlite, ["a", "b", "c"]);
    sqlite.exec(`
      INSERT INTO community_server_folder (id, user_id, name, position)
      VALUES ('one', 'u1', 'One', 0), ('two', 'u1', 'Two', 1);
      INSERT INTO community_server_folder_item (folder_id, server_id, position)
      VALUES ('one', 'a', 0), ('one', 'b', 1), ('two', 'c', 0);
    `);
    const stale: ServerRailState = {
      serverOrder: ["a", "b", "c"],
      folderOrder: ["one", "two"],
      folders: {
        one: { id: "one", name: "One", serverIds: ["a", "b"] },
        two: { id: "two", name: "Two", serverIds: ["c"] },
      },
    };

    runProjection(sqlite, db, stale, {
      commands: [
        { kind: "replace-folder-items", folderId: "one", serverIds: ["b"] },
        { kind: "replace-folder-items", folderId: "two", serverIds: ["c", "a"] },
      ],
    });
    runProjection(sqlite, db, stale, {
      commands: [{ kind: "replace-folder-items", folderId: "one", serverIds: ["b", "a"] }],
    });

    const rows = sqlite.prepare(`
      SELECT folder_id AS folderId, server_id AS serverId, position
      FROM community_server_folder_item
      ORDER BY folder_id, position
    `).all();
    expect(rows).toEqual([
      { folderId: "one", serverId: "b", position: 0 },
      { folderId: "one", serverId: "a", position: 1 },
      { folderId: "two", serverId: "c", position: 0 },
    ]);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM community_server_folder_item WHERE server_id = 'a'
    `).get()).toEqual({ count: 1 });
  });
});
