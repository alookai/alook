/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, queries } from "@alook/shared";

const runtimeEnv = env as unknown as CloudflareEnv;
const prefixes: string[] = [];
const triggers: string[] = [];

function fixturePrefix(label: string) {
  const prefix = `bind_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
  prefixes.push(prefix);
  return prefix;
}

async function run(sql: string, ...bindings: unknown[]) {
  await runtimeEnv.DB.prepare(sql).bind(...bindings).run();
}

async function runBatched(statements: D1PreparedStatement[]) {
  for (let offset = 0; offset < statements.length; offset += 50) {
    await runtimeEnv.DB.batch(statements.slice(offset, offset + 50));
  }
}

async function first<T>(sql: string, ...bindings: unknown[]): Promise<T | null> {
  return runtimeEnv.DB.prepare(sql).bind(...bindings).first<T>();
}

afterEach(async () => {
  for (const trigger of triggers.splice(0)) {
    await run(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  for (const prefix of prefixes.splice(0)) {
    await run("DELETE FROM agent_task_queue WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM meeting_session WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM conversation WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM agent WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM agent_runtime WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM workspace WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM user WHERE id GLOB ?", `${prefix}*`);
  }
});

describe("workspace and daemon high-cardinality D1 queries", () => {
  it("preserves global overview/task/trace ordering and fixed-bind claims at 125", async () => {
    const prefix = fixturePrefix("workspace");
    const userId = `${prefix}_user`;
    const workspaceId = `${prefix}_workspace`;
    const now = "2026-08-28T04:00:00.000Z";
    await run(
      "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Owner', '7000')",
      userId,
      `${userId}@example.com`,
    );
    await run(
      "INSERT INTO workspace (id, name, slug, onboarded, created_at, updated_at) VALUES (?, 'Workspace', ?, 1, ?, ?)",
      workspaceId,
      `${prefix}-workspace`,
      now,
      now,
    );

    const runtimeIds = Array.from({ length: 125 }, (_, index) => `${prefix}_runtime_${index}`);
    const agentIds = Array.from({ length: 125 }, (_, index) => `${prefix}_agent_${index}`);
    const conversationIds = Array.from({ length: 125 }, (_, index) => `${prefix}_conversation_${index}`);
    const terminalTaskIds = Array.from({ length: 125 }, (_, index) => `${prefix}_terminal_${index}`);
    const queuedTaskIds = Array.from({ length: 125 }, (_, index) => `${prefix}_queued_${index}`);
    await runBatched(agentIds.flatMap((agentId, index) => {
      const completedAt = `2026-08-28T04:${String(index % 60).padStart(2, "0")}:${String(index).padStart(3, "0")}Z`;
      return [
        runtimeEnv.DB.prepare(
          "INSERT INTO agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, device_info, created_at, updated_at) VALUES (?, ?, 'daemon-main', 'local', ?, '', ?, ?)",
        ).bind(runtimeIds[index], workspaceId, `provider-${index}`, now, now),
        runtimeEnv.DB.prepare(
          "INSERT INTO agent (id, workspace_id, name, runtime_id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(agentId, workspaceId, `Agent ${index}`, runtimeIds[index], userId, now, now),
        runtimeEnv.DB.prepare(
          "INSERT INTO conversation (id, workspace_id, agent_id, user_id, title, type, channel, created_at) VALUES (?, ?, ?, ?, '', 'user_dm_message', 'default', ?)",
        ).bind(conversationIds[index], workspaceId, agentId, userId, now),
        runtimeEnv.DB.prepare(
          "INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, type, status, priority, created_at, completed_at, trace_id) VALUES (?, ?, ?, ?, ?, ?, 'user_dm_message', 'completed', 0, ?, ?, ?)",
        ).bind(terminalTaskIds[index], agentId, runtimeIds[index], workspaceId, conversationIds[index], `terminal-${index}`, now, completedAt, `${prefix}_trace_${index}`),
        runtimeEnv.DB.prepare(
          "INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, type, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, 'user_dm_message', 'queued', ?, ?)",
        ).bind(queuedTaskIds[index], agentId, runtimeIds[index], workspaceId, conversationIds[index], `queued-${index}`, index, now),
      ];
    }));

    const db = createDb(runtimeEnv.DB);
    const recent = await queries.overview.getRecentTerminalTasks(db, workspaceId, agentIds, 15);
    expect(recent).toHaveLength(15);
    expect(recent.map((task) => task.completedAt)).toEqual(
      [...recent.map((task) => task.completedAt)].sort().reverse(),
    );
    expect(await queries.overview.getConversationCountsByAgent(db, workspaceId, agentIds)).toHaveLength(125);
    expect(await queries.task.listActiveTaskCountsByWorkspace(db, workspaceId, agentIds, userId)).toHaveLength(125);
    expect(await queries.task.listActiveTasksByWorkspace(db, workspaceId, agentIds, userId)).toHaveLength(50);
    expect(await queries.task.listPendingTasksByRuntimes(db, runtimeIds, workspaceId)).toHaveLength(125);
    const traceAgents = await queries.task.getTraceAgentsByTaskIds(db, terminalTaskIds, workspaceId);
    expect(traceAgents.size).toBe(125);
    terminalTaskIds.forEach((taskId, index) => expect(traceAgents.get(taskId)).toEqual([agentIds[index]]));

    const killIds = Array.from({ length: 60 }, (_, index) => `${prefix}_kill_${index}`);
    await runBatched(killIds.map((taskId, index) =>
      runtimeEnv.DB.prepare(
        "INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, type, status, priority, created_at) VALUES (?, ?, ?, ?, ?, 'kill', 'kill_task', 'queued', 0, ?)",
      ).bind(taskId, agentIds[index], runtimeIds[index], workspaceId, conversationIds[index], now),
    ));
    expect(await queries.task.claimKillTasks(db, runtimeIds, workspaceId, 50)).toHaveLength(50);
    expect(await first<{ total: number }>(
      "SELECT COUNT(*) AS total FROM agent_task_queue WHERE id GLOB ? AND type = 'kill_task' AND status = 'queued'",
      `${prefix}_kill_*`,
    )).toEqual({ total: 10 });
  });

  it("claims around 125 blocked conversations and fails stale running tasks atomically", async () => {
    const prefix = fixturePrefix("blocked");
    const userId = `${prefix}_user`;
    const workspaceId = `${prefix}_workspace`;
    const runtimeId = `${prefix}_runtime`;
    const agentId = `${prefix}_agent`;
    const now = "2026-08-28T05:00:00.000Z";
    const staleStart = "2026-08-27T00:00:00.000Z";
    await run("INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Owner', '7100')", userId, `${userId}@example.com`);
    await run("INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Workspace', ?, ?, ?)", workspaceId, `${prefix}-workspace`, now, now);
    await run("INSERT INTO agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, device_info, created_at, updated_at) VALUES (?, ?, 'daemon-blocked', 'local', 'codex', '', ?, ?)", runtimeId, workspaceId, now, now);
    await run("INSERT INTO agent (id, workspace_id, name, runtime_id, owner_id, created_at, updated_at) VALUES (?, ?, 'Agent', ?, ?, ?, ?)", agentId, workspaceId, runtimeId, userId, now, now);

    const blockedConversationIds = Array.from({ length: 125 }, (_, index) => `${prefix}_blocked_conversation_${index}`);
    await runBatched(blockedConversationIds.flatMap((conversationId, index) => [
      runtimeEnv.DB.prepare(
        "INSERT INTO conversation (id, workspace_id, agent_id, user_id, title, type, channel, created_at) VALUES (?, ?, ?, ?, '', 'user_dm_message', 'default', ?)",
      ).bind(conversationId, workspaceId, agentId, userId, now),
      runtimeEnv.DB.prepare(
        "INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, type, status, priority, created_at, started_at) VALUES (?, ?, ?, ?, ?, 'running', 'user_dm_message', 'running', 0, ?, ?)",
      ).bind(`${prefix}_running_${index}`, agentId, runtimeId, workspaceId, conversationId, now, staleStart),
    ]));
    const freeConversationId = `${prefix}_free_conversation`;
    await run(
      "INSERT INTO conversation (id, workspace_id, agent_id, user_id, title, type, channel, created_at) VALUES (?, ?, ?, ?, '', 'user_dm_message', 'default', ?)",
      freeConversationId,
      workspaceId,
      agentId,
      userId,
      now,
    );
    await run(
      "INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, type, status, priority, created_at) VALUES (?, ?, ?, ?, ?, 'free', 'user_dm_message', 'queued', 1, ?)",
      `${prefix}_free_task`,
      agentId,
      runtimeId,
      workspaceId,
      freeConversationId,
      now,
    );

    const db = createDb(runtimeEnv.DB);
    expect((await queries.task.claimTask(db, agentId, workspaceId))?.id).toBe(`${prefix}_free_task`);
    expect(await queries.task.failStaleRunningTasks(db, workspaceId, 60)).toHaveLength(125);
    expect(await queries.task.failStaleRunningTasks(db, workspaceId, 60)).toEqual([]);
  });

  it("drains 125 due meetings in stable 50/50/25 pages", async () => {
    const prefix = fixturePrefix("meetings");
    const userId = `${prefix}_user`;
    const workspaceId = `${prefix}_workspace`;
    const runtimeId = `${prefix}_runtime`;
    const agentId = `${prefix}_agent`;
    const now = "2026-08-28T06:00:00.000Z";
    await run("INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Owner', '7200')", userId, `${userId}@example.com`);
    await run("INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Workspace', ?, ?, ?)", workspaceId, `${prefix}-workspace`, now, now);
    await run("INSERT INTO agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, device_info, created_at, updated_at) VALUES (?, ?, 'daemon-meeting', 'local', 'codex', '', ?, ?)", runtimeId, workspaceId, now, now);
    await run("INSERT INTO agent (id, workspace_id, name, runtime_id, owner_id, created_at, updated_at) VALUES (?, ?, 'Agent', ?, ?, ?, ?)", agentId, workspaceId, runtimeId, userId, now, now);
    await runBatched(Array.from({ length: 125 }, (_, index) =>
      runtimeEnv.DB.prepare(
        "INSERT INTO meeting_session (id, agent_id, workspace_id, title, meeting_url, status, is_whitelisted, participants, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'scheduled', 1, '[]', ?, ?, ?)",
      ).bind(`${prefix}_meeting_${String(index).padStart(3, "0")}`, agentId, workspaceId, `Meeting ${index}`, `https://example.com/${index}`, now, now, now),
    ));

    const db = createDb(runtimeEnv.DB);
    const claimedIds: string[] = [];
    for (const expected of [50, 50, 25]) {
      const due = await queries.meetingSession.listScheduledMeetings(db, workspaceId, now);
      expect(due).toHaveLength(expected);
      const claimed = await queries.meetingSession.claimMeetingSessions(db, due.map((meeting) => meeting.id), workspaceId, now);
      expect(claimed).toHaveLength(expected);
      claimedIds.push(...claimed.map((meeting) => meeting.id));
    }
    expect(new Set(claimedIds).size).toBe(125);
    expect(await queries.meetingSession.listScheduledMeetings(db, workspaceId, now)).toEqual([]);
  });

  it("deletes 125 daemon runtimes atomically and rolls back detach on failure", async () => {
    const prefix = fixturePrefix("runtime_delete");
    const userId = `${prefix}_user`;
    const workspaceId = `${prefix}_workspace`;
    const now = "2026-08-28T07:00:00.000Z";
    await run("INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Owner', '7300')", userId, `${userId}@example.com`);
    await run("INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Workspace', ?, ?, ?)", workspaceId, `${prefix}-workspace`, now, now);

    const runtimeIds = Array.from({ length: 125 }, (_, index) => `${prefix}_runtime_${index}`);
    const agentIds = Array.from({ length: 125 }, (_, index) => `${prefix}_agent_${index}`);
    await runBatched(runtimeIds.flatMap((runtimeId, index) => [
      runtimeEnv.DB.prepare(
        "INSERT INTO agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, device_info, created_at, updated_at) VALUES (?, ?, 'daemon-delete', 'local', ?, '', ?, ?)",
      ).bind(runtimeId, workspaceId, `provider-${index}`, now, now),
      runtimeEnv.DB.prepare(
        "INSERT INTO agent (id, workspace_id, name, runtime_id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(agentIds[index], workspaceId, `Agent ${index}`, runtimeId, userId, now, now),
    ]));
    const db = createDb(runtimeEnv.DB);
    await queries.runtime.deleteRuntimesByDaemonId(db, "daemon-delete", workspaceId);
    expect(await first<{ total: number }>("SELECT COUNT(*) AS total FROM agent_runtime WHERE workspace_id = ?", workspaceId)).toEqual({ total: 0 });
    expect(await first<{ total: number }>("SELECT COUNT(*) AS total FROM agent WHERE workspace_id = ? AND runtime_id IS NULL", workspaceId)).toEqual({ total: 125 });

    const rollbackRuntime = `${prefix}_rollback_runtime`;
    const rollbackAgent = `${prefix}_rollback_agent`;
    await run("INSERT INTO agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, device_info, created_at, updated_at) VALUES (?, ?, 'daemon-rollback', 'local', 'rollback-provider', '', ?, ?)", rollbackRuntime, workspaceId, now, now);
    await run("INSERT INTO agent (id, workspace_id, name, runtime_id, owner_id, created_at, updated_at) VALUES (?, ?, 'Rollback Agent', ?, ?, ?, ?)", rollbackAgent, workspaceId, rollbackRuntime, userId, now, now);
    const trigger = `abort_runtime_delete_${crypto.randomUUID().replaceAll("-", "")}`;
    triggers.push(trigger);
    await run(`CREATE TRIGGER ${trigger} BEFORE DELETE ON agent_runtime BEGIN SELECT RAISE(ABORT, 'forced runtime delete failure'); END`);

    await expect(queries.runtime.deleteRuntimesByDaemonId(db, "daemon-rollback", workspaceId)).rejects.toThrow(/forced runtime delete failure/);
    expect(await first<{ runtimeId: string }>("SELECT runtime_id AS runtimeId FROM agent WHERE id = ?", rollbackAgent)).toEqual({ runtimeId: rollbackRuntime });
    expect(await first<{ total: number }>("SELECT COUNT(*) AS total FROM agent_runtime WHERE id = ?", rollbackRuntime)).toEqual({ total: 1 });
  });
});
