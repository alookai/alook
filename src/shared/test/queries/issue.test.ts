import { readFileSync } from "node:fs";
import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db";
import { issue } from "../../src/db/schema";
import * as issueQueries from "../../src/db/queries/issue";

let sqlite: Sqlite.Database;
let db: Database;

beforeEach(() => {
  sqlite = new Sqlite(":memory:");
  sqlite.pragma("foreign_keys=ON");
  sqlite.exec(`
    CREATE TABLE workspace(id TEXT PRIMARY KEY);
    CREATE TABLE user(id TEXT PRIMARY KEY);
    CREATE TABLE agent(id TEXT, workspace_id TEXT, PRIMARY KEY(id, workspace_id));
    CREATE TABLE conversation(id TEXT PRIMARY KEY);
    CREATE TABLE agent_task_queue(id TEXT PRIMARY KEY);
    INSERT INTO workspace VALUES('w'), ('other');
    INSERT INTO user VALUES('u1'), ('u2');
    INSERT INTO agent VALUES('a1','w'), ('a2','w');
    INSERT INTO conversation VALUES('c1'), ('c2');
    INSERT INTO agent_task_queue VALUES('t1');
  `);
  for (const name of ["0022_issues.sql", "0025_issue_nullable_agent.sql"]) {
    sqlite.exec(readFileSync(new URL(`../../../web/migrations/${name}`, import.meta.url), "utf8"));
  }
  db = drizzle(sqlite) as unknown as Database;
});
afterEach(() => sqlite.close());

async function seed(id: string, values: Partial<typeof issue.$inferInsert> = {}) {
  await db.insert(issue).values({
    id, workspaceId: "w", creatorUserId: "u1", title: id,
    agentId: null, conversationId: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...values,
  }).run();
}

async function ids(options: Parameters<typeof issueQueries.listIssues>[2]) {
  return (await issueQueries.listIssues(db, "w", options)).map(row => row.id);
}

describe("createIssue", () => {
  it("persists the default todo status and supplied ownership", async () => {
    const created = await issueQueries.createIssue(db, {
      workspaceId: "w", agentId: "a1", creatorUserId: "u1", conversationId: "c1", title: "T", description: "D",
    });
    expect(created).toMatchObject({ id: expect.any(String), workspaceId: "w", creatorUserId: "u1", status: "todo", title: "T" });
    expect(await issueQueries.getIssue(db, created.id, "w")).toEqual(created);
  });
  it("persists custom status with nullable agent and conversation", async () => {
    const created = await issueQueries.createIssue(db, {
      workspaceId: "w", agentId: null, creatorUserId: "u1", conversationId: null, title: "T", description: "D", status: "in_progress",
    });
    expect(await issueQueries.getIssue(db, created.id, "w")).toMatchObject({ status: "in_progress", agentId: null, conversationId: null });
  });
});

describe("getIssue", () => {
  it("returns null when not found", async () => {
    expect(await issueQueries.getIssue(db, "missing", "w")).toBeNull();
  });
  it("returns an issue without requiring the optional userId", async () => {
    await seed("i");
    expect(await issueQueries.getIssue(db, "i", "w")).toMatchObject({ id: "i", creatorUserId: "u1" });
  });
  it("filters a stored issue by both workspace and optional owner", async () => {
    await seed("i");
    expect(await issueQueries.getIssue(db, "i", "w", "u1")).toMatchObject({ id: "i" });
    expect(await issueQueries.getIssue(db, "i", "w", "u2")).toBeNull();
    expect(await issueQueries.getIssue(db, "i", "other", "u1")).toBeNull();
  });
});

describe("getIssueByConversation", () => {
  it("returns null when not found", async () => {
    expect(await issueQueries.getIssueByConversation(db, "missing", "w")).toBeNull();
  });
  it("returns the matching conversation only in its workspace", async () => {
    await seed("i", { conversationId: "c1" });
    expect(await issueQueries.getIssueByConversation(db, "c1", "w")).toMatchObject({ id: "i" });
    expect(await issueQueries.getIssueByConversation(db, "c1", "other")).toBeNull();
  });
});

describe("listIssues", () => {
  it("filters workspace and owner before ordering newest first", async () => {
    await seed("older");
    await seed("newer", { updatedAt: "2026-01-02T00:00:00.000Z" });
    await seed("other-owner", { creatorUserId: "u2" });
    await seed("other-workspace", { workspaceId: "other" });
    expect(await ids({ userId: "u1" })).toEqual(["newer", "older"]);
  });
  it("filters by agentId", async () => {
    await seed("a", { agentId: "a1" });
    await seed("b", { agentId: "a2" });
    await seed("unassigned");
    expect(await ids({ userId: "u1", agentId: "a1" })).toEqual(["a"]);
  });
  it("filters by status", async () => {
    await seed("todo");
    await seed("active", { status: "in_progress" });
    expect(await ids({ userId: "u1", status: "todo" })).toEqual(["todo"]);
  });
  it("filters terminal=true", async () => {
    for (const status of ["todo", "in_progress", "review", "done", "closed", "canceled", "failed"]) await seed(status, { status });
    expect((await ids({ userId: "u1", terminal: true })).sort()).toEqual(["canceled", "closed", "done", "failed"]);
  });
  it("filters terminal=false", async () => {
    for (const status of ["todo", "in_progress", "review", "done", "closed", "canceled", "failed"]) await seed(status, { status });
    expect((await ids({ userId: "u1", terminal: false })).sort()).toEqual(["in_progress", "review", "todo"]);
  });
});

describe("updateIssue", () => {
  it("cannot update an absent or foreign-workspace issue", async () => {
    await seed("i");
    expect(await issueQueries.updateIssue(db, "missing", "w", { title: "T" })).toBeNull();
    expect(await issueQueries.updateIssue(db, "i", "other", { title: "T" })).toBeNull();
    expect(await issueQueries.getIssue(db, "i", "w")).toMatchObject({ title: "i" });
  });
  it("returns and persists the updated issue", async () => {
    await seed("i");
    const updated = await issueQueries.updateIssue(db, "i", "w", { title: "T" });
    expect(updated).toMatchObject({ id: "i", title: "T" });
    expect(await issueQueries.getIssue(db, "i", "w")).toEqual(updated);
  });
  it("persists completedAt for a terminal status", async () => {
    await seed("i");
    await issueQueries.updateIssue(db, "i", "w", { status: "done" });
    expect(await issueQueries.getIssue(db, "i", "w")).toMatchObject({ status: "done", completedAt: expect.any(String) });
  });
  it("clears persisted completedAt when the issue becomes active", async () => {
    await seed("i", { status: "done", completedAt: "2026-01-01T00:00:00.000Z" });
    await issueQueries.updateIssue(db, "i", "w", { status: "todo" });
    expect(await issueQueries.getIssue(db, "i", "w")).toMatchObject({ status: "todo", completedAt: null });
  });
});

describe("setLatestTask", () => {
  it("persists and clears the task link only within the workspace", async () => {
    await seed("i");
    await issueQueries.setLatestTask(db, "i", "w", "t1");
    expect(await issueQueries.getIssue(db, "i", "w")).toMatchObject({ latestTaskId: "t1" });
    expect(await issueQueries.setLatestTask(db, "i", "other", null)).toBeNull();
    expect(await issueQueries.getIssue(db, "i", "w")).toMatchObject({ latestTaskId: "t1" });
    await issueQueries.setLatestTask(db, "i", "w", null);
    expect(await issueQueries.getIssue(db, "i", "w")).toMatchObject({ latestTaskId: null });
  });
});

describe("deleteIssue", () => {
  it("cannot delete an absent or foreign-workspace issue", async () => {
    await seed("i");
    expect(await issueQueries.deleteIssue(db, "missing", "w")).toBeNull();
    expect(await issueQueries.deleteIssue(db, "i", "other")).toBeNull();
    expect(await issueQueries.getIssue(db, "i", "w")).toMatchObject({ id: "i" });
  });
  it("returns and removes the deleted issue", async () => {
    await seed("i");
    expect(await issueQueries.deleteIssue(db, "i", "w")).toMatchObject({ id: "i" });
    expect(await issueQueries.getIssue(db, "i", "w")).toBeNull();
  });
});

describe("listIssueMessages", () => {
  it("returns null when issue not found", async () => {
    expect(await issueQueries.listIssueMessages(db, "missing", "w")).toBeNull();
  });
  it("returns empty when no conversationId exists", async () => {
    await seed("i");
    expect(await issueQueries.listIssueMessages(db, "i", "w")).toEqual([]);
  });
});
