/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, queries } from "@alook/shared";

const runtimeEnv = env as unknown as CloudflareEnv;
const prefixes: string[] = [];

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

afterEach(async () => {
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

});
