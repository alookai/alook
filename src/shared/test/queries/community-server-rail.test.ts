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
    expect(statements.length).toBeLessThanOrEqual(13);
    const reorder = statements.find((statement) => statement.toSQL().sql.includes(
      'update "community_server_member"',
    ));
    expect(reorder).toBeDefined();
    const query = reorder!.toSQL();
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
    expect(statements.length).toBeLessThanOrEqual(13);
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

  it("projects around legacy invalid rows and atomically self-heals only the caller on the first legal write", async () => {
    const { sqlite, db } = createDatabase();
    sqlite.exec(`
      INSERT INTO community_server (id) VALUES ('a'), ('b'), ('x');
      INSERT INTO community_server_member (id, server_id, user_id, rail_order, joined_at)
      VALUES
        ('u1-a', 'a', 'u1', 0, '2026-01-01T00:00:00.000Z'),
        ('u1-b', 'b', 'u1', 1, '2026-01-01T00:00:01.000Z'),
        ('u2-x', 'x', 'u2', 0, '2026-01-01T00:00:00.000Z');
      INSERT INTO community_server_folder (id, user_id, name, position)
      VALUES
        ('u1-empty', 'u1', 'Empty', 0),
        ('u1-a-locale-first', 'u1', 'Locale first', NULL),
        ('u1-Z-binary-first', 'u1', 'Binary first', 0),
        ('u1-dangling', 'u1', 'Dangling', 6),
        ('u2-empty', 'u2', 'Foreign empty', 0),
        ('u2-first', 'u2', 'Foreign first', 1),
        ('u2-second', 'u2', 'Foreign second', 2);
      INSERT INTO community_server_folder_item (folder_id, server_id, position)
      VALUES
        ('u1-a-locale-first', 'a', 7),
        ('u1-Z-binary-first', 'a', 0),
        ('u1-dangling', 'x', 0),
        ('u2-first', 'x', 3),
        ('u2-second', 'x', 0);
    `);
    const d1Db = Object.assign(db as any, {
      batch: async (statements: any[]) => statements.map((statement) => statement.all()),
    });

    const snapshot = await readServerRailSnapshot(d1Db, "u1");
    expect(snapshot).toEqual({
      serverOrder: ["a", "b"],
      folderOrder: ["u1-Z-binary-first"],
      folders: {
        "u1-Z-binary-first": {
          id: "u1-Z-binary-first",
          name: "Binary first",
          serverIds: ["a"],
        },
      },
    });
    const projection = projectServerRailCommit(snapshot, {
      commands: [{ kind: "reorder-servers", serverIds: ["b", "a"] }],
    }, () => "unused");
    expect(projection.ok).toBe(true);
    if (!projection.ok) throw new Error(projection.error);
    const statements = buildServerRailWriteStatements(db as any, "u1", projection.value);
    expect(() => sqlite.transaction(() => statements.forEach((statement) => statement.run()))())
      .not.toThrow();

    expect(sqlite.prepare(`
      SELECT id, position FROM community_server_folder WHERE user_id = 'u1' ORDER BY id
    `).all()).toEqual([{ id: "u1-Z-binary-first", position: 0 }]);
    expect(sqlite.prepare(`
      SELECT folder_id AS folderId, server_id AS serverId, position
      FROM community_server_folder_item WHERE folder_id = 'u1-Z-binary-first'
    `).all()).toEqual([{ folderId: "u1-Z-binary-first", serverId: "a", position: 0 }]);
    expect(sqlite.prepare(`
      SELECT id, position FROM community_server_folder WHERE user_id = 'u2' ORDER BY id
    `).all()).toEqual([
      { id: "u2-empty", position: 0 },
      { id: "u2-first", position: 1 },
      { id: "u2-second", position: 2 },
    ]);
    expect(sqlite.prepare(`
      SELECT folder_id AS folderId, server_id AS serverId, position
      FROM community_server_folder_item WHERE folder_id LIKE 'u2-%'
      ORDER BY folder_id
    `).all()).toEqual([
      { folderId: "u2-first", serverId: "x", position: 3 },
      { folderId: "u2-second", serverId: "x", position: 0 },
    ]);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("recovers a legacy folder overflow through a count-reducing delete before normal mutations resume", async () => {
    const { sqlite, db } = createDatabase();
    const ids = Array.from({ length: 11 }, (_, index) => `s${index}`);
    seedMemberships(sqlite, ids);
    ids.forEach((serverId, index) => {
      sqlite.prepare(`
        INSERT INTO community_server_folder (id, user_id, name, position)
        VALUES (?, 'u1', ?, ?)
      `).run(`f${index}`, `Folder ${index}`, index);
      sqlite.prepare(`
        INSERT INTO community_server_folder_item (folder_id, server_id, position)
        VALUES (?, ?, 0)
      `).run(`f${index}`, serverId);
    });
    const d1Db = Object.assign(db as any, {
      batch: async (statements: any[]) => statements.map((statement) => statement.all()),
    });
    const overflow = await readServerRailSnapshot(d1Db, "u1");
    expect(overflow.folderOrder).toHaveLength(11);
    expect(projectServerRailCommit(overflow, {
      commands: [{ kind: "reorder-servers", serverIds: [...ids].reverse() }],
    }, () => "unused")).toMatchObject({ ok: false });

    const recovery = projectServerRailCommit(overflow, {
      commands: [{ kind: "delete-folder", folderId: "f10" }],
    }, () => "unused");
    expect(recovery.ok).toBe(true);
    if (!recovery.ok) throw new Error(recovery.error);
    const recoveryStatements = buildServerRailWriteStatements(db as any, "u1", recovery.value);
    sqlite.transaction(() => recoveryStatements.forEach((statement) => statement.run()))();
    expect(sqlite.prepare(`
      SELECT id, position FROM community_server_folder WHERE user_id = 'u1' ORDER BY position
    `).all()).toEqual(Array.from({ length: 10 }, (_, index) => ({ id: `f${index}`, position: index })));

    const recovered = await readServerRailSnapshot(d1Db, "u1");
    const next = projectServerRailCommit(recovered, {
      commands: [{ kind: "reorder-servers", serverIds: [...ids].reverse() }],
    }, () => "unused");
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error(next.error);
    const nextStatements = buildServerRailWriteStatements(db as any, "u1", next.value);
    expect(() => sqlite.transaction(() => nextStatements.forEach((statement) => statement.run()))())
      .not.toThrow();
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

  it.each([
    ["first then second", ["x", "y"]],
    ["second then first", ["y", "x"]],
  ] as const)("removes the folder emptied by a concurrent same-server create: %s", async (_name, order) => {
    const { sqlite, db } = createDatabase();
    seedMemberships(sqlite, ["a", "b"]);
    const stale: ServerRailState = { serverOrder: ["a", "b"], folderOrder: [], folders: {} };
    const projections = Object.fromEntries(["x", "y"].map((id) => {
      const result = projectServerRailCommit(stale, {
        commands: [{ kind: "create-folder", clientId: id, name: id, serverIds: ["a"] }],
      }, () => id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      return [id, result.value];
    }));

    for (const id of order) {
      const statements = buildServerRailWriteStatements(db as any, "u1", projections[id]!);
      sqlite.transaction(() => statements.forEach((statement) => statement.run()))();
    }

    const d1Db = Object.assign(db as any, {
      batch: async (statements: any[]) => statements.map((statement) => statement.all()),
    });
    const snapshot = await readServerRailSnapshot(d1Db, "u1");
    expect(snapshot.folderOrder).toEqual([order[1]]);
    expect(snapshot.folders[order[1]]?.serverIds).toEqual(["a"]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_server_folder").get())
      .toEqual({ count: 1 });

    const next = projectServerRailCommit(snapshot, {
      commands: [{ kind: "delete-folder", folderId: order[1] }],
    }, () => "unused");
    expect(next.ok).toBe(true);
  });

  it.each([
    ["first then second", ["x", "y"]],
    ["second then first", ["y", "x"]],
  ] as const)("enforces the folder cap at write time for either completion order: %s", async (_name, order) => {
    const { sqlite, db } = createDatabase();
    const ids = [...Array.from({ length: 9 }, (_, index) => `s${index}`), "a", "b"];
    seedMemberships(sqlite, ids);
    for (let index = 0; index < 9; index += 1) {
      sqlite.prepare(`
        INSERT INTO community_server_folder (id, user_id, name, position) VALUES (?, 'u1', ?, ?)
      `).run(`f${index}`, `Folder ${index}`, index);
      sqlite.prepare(`
        INSERT INTO community_server_folder_item (folder_id, server_id, position) VALUES (?, ?, 0)
      `).run(`f${index}`, `s${index}`);
    }
    const d1Db = Object.assign(db as any, {
      batch: async (statements: any[]) => statements.map((statement) => statement.all()),
    });
    const stale = await readServerRailSnapshot(d1Db, "u1");
    const projections = Object.fromEntries(["x", "y"].map((id, index) => {
      const result = projectServerRailCommit(stale, {
        commands: [{ kind: "create-folder", clientId: id, name: id, serverIds: [index ? "b" : "a"] }],
      }, () => id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      return [id, result.value];
    }));

    const firstStatements = buildServerRailWriteStatements(db as any, "u1", projections[order[0]]!);
    sqlite.transaction(() => firstStatements.forEach((statement) => statement.run()))();
    const secondStatements = buildServerRailWriteStatements(db as any, "u1", projections[order[1]]!);
    expect(() => sqlite.transaction(() => secondStatements.forEach((statement) => statement.run()))())
      .toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_server_folder").get())
      .toEqual({ count: 10 });

    const finalSnapshot = await readServerRailSnapshot(d1Db, "u1");
    const next = projectServerRailCommit(finalSnapshot, {
      commands: [{ kind: "reorder-servers", serverIds: [...finalSnapshot.serverOrder].reverse() }],
    }, () => "unused");
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error(next.error);
    const nextStatements = buildServerRailWriteStatements(db as any, "u1", next.value);
    expect(() => sqlite.transaction(() => nextStatements.forEach((statement) => statement.run()))())
      .not.toThrow();
  });
});
