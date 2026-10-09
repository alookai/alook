/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, queries } from "@alook/shared";

const runtimeEnv = env as unknown as CloudflareEnv;
const prefixes: string[] = [];
const triggers: string[] = [];
const evidence: { label: string; statements: { sql: string; bindings: unknown[] }[]; batches: number[] }[] = [];
const baseline = "2026-09-01T00:00:00.000Z";
const later = "2026-09-02T00:00:00.000Z";

function fixturePrefix(label: string) {
  const prefix = `sql171_${label.slice(0, 8)}_${crypto.randomUUID().replaceAll("-", "")}`;
  prefixes.push(prefix);
  return prefix;
}

async function run(sql: string, ...bindings: unknown[]) {
  return runtimeEnv.DB.prepare(sql).bind(...bindings).run();
}

async function rows<T>(sql: string, ...bindings: unknown[]) {
  return (await runtimeEnv.DB.prepare(sql).bind(...bindings).all<T>()).results;
}

async function seedBatch(statements: D1PreparedStatement[]) {
  for (let i = 0; i < statements.length; i += 50) await runtimeEnv.DB.batch(statements.slice(i, i + 50));
}

function recordedDb(label: string, beforeBatch?: (attempt: number, statements: { sql: string; bindings: unknown[] }[]) => Promise<void>) {
  const record = { label, statements: [] as { sql: string; bindings: unknown[] }[], batches: [] as number[] };
  evidence.push(record);
  const d1 = new Proxy(runtimeEnv.DB, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => new Proxy(target.prepare(sql), {
        get(statement, method) {
          if (method === "bind") return (...bindings: unknown[]) => {
            record.statements.push({ sql, bindings: [...bindings] });
            expect(bindings.length, `${label}: complete D1 binding array`).toBeLessThanOrEqual(100);
            return statement.bind(...bindings);
          };
          const value = Reflect.get(statement, method, statement);
          return typeof value === "function" ? value.bind(statement) : value;
        },
      });
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        record.batches.push(statements.length);
        await beforeBatch?.(record.batches.length, record.statements.slice(-statements.length));
        return target.batch(statements);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: createDb(d1), record };
}

function statementCount(record: ReturnType<typeof recordedDb>["record"], fragment: string, count: number) {
  const selected = record.statements.filter(({ sql }) => sql.includes(fragment));
  expect(selected.length).toBeGreaterThan(0);
  for (const statement of selected) expect(statement.bindings).toHaveLength(count);
}

async function seedUser(id: string, name = id, discriminator = "1710") {
  await run("INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, ?, ?)", id, `${id}@example.com`, name, discriminator);
}

async function seedCommunity(label: string, count = 125) {
  const prefix = fixturePrefix(label);
  const viewer = `${prefix}_viewer`;
  const sender = `${prefix}_sender`;
  const other = `${prefix}_other`;
  const server = `${prefix}_server`;
  await seedUser(viewer);
  await seedUser(sender, `${prefix}Alice`, "1711");
  await seedUser(other, `${prefix}Bob`, "1712");
  await run("INSERT INTO community_server (id, name, discriminator, owner_id, created_at) VALUES (?, ?, '1710', ?, ?)", server, prefix, viewer, baseline);
  await run("INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES (?, ?, ?, 'owner', ?)", `${prefix}_member`, server, viewer, baseline);
  const channels = Array.from({ length: count }, (_, i) => `${prefix}_channel_${String(i).padStart(3, "0")}`);
  await seedBatch(channels.map((id, i) => runtimeEnv.DB.prepare("INSERT INTO community_channel (id, server_id, name, type, created_at) VALUES (?, ?, ?, 'text', ?)").bind(id, server, `channel-${i}`, baseline)));
  return { prefix, viewer, sender, other, server, channels };
}

async function seedWorkspace(label: string) {
  const prefix = fixturePrefix(label);
  const viewer = `${prefix}_viewer`;
  const workspace = `${prefix}_workspace`;
  const runtime = `${prefix}_runtime`;
  const agent = `${prefix}_agent`;
  const conversation = `${prefix}_conversation`;
  await seedUser(viewer);
  await run("INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Workspace', ?, ?, ?)", workspace, prefix, baseline, baseline);
  await run("INSERT INTO agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, device_info, created_at, updated_at) VALUES (?, ?, 'sql171', 'local', 'codex', '', ?, ?)", runtime, workspace, baseline, baseline);
  await run("INSERT INTO agent (id, workspace_id, name, runtime_id, owner_id, created_at, updated_at) VALUES (?, ?, 'Agent', ?, ?, ?, ?)", agent, workspace, runtime, viewer, baseline, baseline);
  await run("INSERT INTO conversation (id, workspace_id, agent_id, user_id, title, type, channel, created_at) VALUES (?, ?, ?, ?, 'Conversation', 'user_dm_message', 'default', ?)", conversation, workspace, agent, viewer, baseline);
  return { prefix, viewer, workspace, runtime, agent, conversation };
}

async function graph(name: string) {
  return rows<{ servers: number; categories: number; channels: number; access: number; members: number }>(`
    SELECT
      (SELECT COUNT(*) FROM community_server WHERE name = ?) AS servers,
      (SELECT COUNT(*) FROM community_category c JOIN community_server s ON s.id = c.server_id WHERE s.name = ?) AS categories,
      (SELECT COUNT(*) FROM community_channel c JOIN community_server s ON s.id = c.server_id WHERE s.name = ?) AS channels,
      (SELECT COUNT(*) FROM community_channel_member m JOIN community_channel c ON c.id = m.channel_id JOIN community_server s ON s.id = c.server_id WHERE s.name = ?) AS access,
      (SELECT COUNT(*) FROM community_server_member m JOIN community_server s ON s.id = m.server_id WHERE s.name = ?) AS members
  `, name, name, name, name, name);
}

afterEach(async () => {
  for (const trigger of triggers.splice(0)) await run(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const prefix of prefixes.splice(0)) {
    await run("DELETE FROM community_server WHERE name GLOB ? OR id GLOB ?", `${prefix}*`, `${prefix}*`);
    await run("DELETE FROM community_channel WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM agent_task_queue WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM conversation WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM agent WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM agent_runtime WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM workspace WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM user WHERE id GLOB ?", `${prefix}*`);
  }
  expect(await rows("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'sql171_*'")).toEqual([]);
  for (const record of evidence.splice(0)) console.log("SQL171_NATIVE_BINDINGS", JSON.stringify(record));
});

describe("whole-statement SQL correctness on native D1", () => {
  it("hydrates 98/99/100 roots without cross-workspace or kill-task contamination", async () => {
    const f = await seedWorkspace("traces");
    const decoy = await seedWorkspace("trace_decoy");
    await seedBatch(Array.from({ length: 101 }, (_, i) => runtimeEnv.DB.prepare("INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, type, status, created_at, trace_id) VALUES (?, ?, ?, ?, ?, ?, 'user_dm_message', 'completed', ?, ?)").bind(`${f.prefix}_task_${i}`, f.agent, f.runtime, f.workspace, f.conversation, `root-${i}`, `2026-09-02T00:00:${String(i).padStart(3, "0")}Z`, `${f.prefix}_trace_${i}`)));
    await run("INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, type, status, trace_id, parent_task_id) VALUES (?, ?, ?, ?, ?, 'kill decoy', 'kill_task', 'running', ?, ?)", `${f.prefix}_kill`, f.agent, f.runtime, f.workspace, f.conversation, `${f.prefix}_trace_100`, `${f.prefix}_task_100`);
    await run("INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, type, status, trace_id) VALUES (?, ?, ?, ?, ?, 'workspace decoy', 'user_dm_message', 'running', ?)", `${decoy.prefix}_task`, decoy.agent, decoy.runtime, decoy.workspace, decoy.conversation, `${f.prefix}_trace_100`);
    const helper = `${f.prefix}_helper_agent`;
    await run("INSERT INTO agent (id, workspace_id, name, runtime_id, owner_id, created_at, updated_at) VALUES (?, ?, 'Helper', ?, ?, ?, ?)", helper, f.workspace, f.runtime, f.viewer, baseline, baseline);
    await run("INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, type, status, trace_id, parent_task_id) VALUES (?, ?, ?, ?, ?, 'helper', 'user_dm_message', 'failed', ?, ?)", `${f.prefix}_helper_task`, helper, f.runtime, f.workspace, f.conversation, `${f.prefix}_trace_100`, `${f.prefix}_task_100`);
    const { db, record } = recordedDb("K1");
    for (const limit of [1, 98, 99, 100]) {
      const result = await queries.task.listTraces(db, f.workspace, { limit });
      expect(result.hasMore).toBe(true);
      expect(result.traces).toHaveLength(limit);
      expect(result.traces[0]).toMatchObject({ traceId: `${f.prefix}_trace_100`, status: "failed", taskCount: 2, helperAgentIds: [helper] });
    }
    expect((await queries.task.listTraces(db, f.workspace, { agentId: f.agent, channel: "default", status: "failed", multiAgent: true })).traces).toMatchObject([{ traceId: `${f.prefix}_trace_100` }]);
    expect(await queries.task.listTraces(db, f.workspace, { agentId: helper })).toEqual({ traces: [], hasMore: false });
    expect(await queries.task.listTraces(db, f.workspace, { channel: "absent" })).toEqual({ traces: [], hasMore: false });
    expect(await queries.task.listTraces(db, f.workspace, { limit: 0 })).toEqual({ traces: [], hasMore: false });
    expect(await queries.task.listTraces(db, f.workspace, { before: baseline })).toEqual({ traces: [], hasMore: false });
    statementCount(record, 'json_each', 3);
  });

  it("preserves task cursor ties, empty filters, unknown filters and chronological output with 125 filter values", async () => {
    const f = await seedWorkspace("history");
    await seedBatch(["a", "b", "c", "kill"].map((suffix) => runtimeEnv.DB.prepare("INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?)").bind(`${f.prefix}_${suffix}`, f.agent, f.runtime, f.workspace, f.conversation, suffix, suffix === "kill" ? "kill_task" : "user_dm_message", later)));
    const { db, record } = recordedDb("K2");
    const result = await queries.task.listTaskHistory(db, f.agent, f.workspace, {
      status: Array(125).fill("completed"), type: Array(125).fill("user_dm_message"), before: later, beforeId: `${f.prefix}_c`, limit: 1,
    });
    expect(result).toMatchObject({ hasMore: true, tasks: [{ id: `${f.prefix}_b` }] });
    statementCount(record, "json_each", 9);
    expect((await queries.task.listTaskHistory(db, f.agent, f.workspace, { status: [], type: [], limit: 2 })).tasks.map(({ prompt }) => prompt)).toEqual(["b", "c"]);
    expect((await queries.task.listTaskHistory(db, f.agent, f.workspace, { type: ["unknown"] })).tasks).toEqual([]);
    expect((await queries.task.listTaskHistory(db, f.agent, f.workspace, { status: ["unknown"] })).tasks).toEqual([]);
    expect((await queries.task.listTaskHistory(db, f.agent, `${f.prefix}_absent`)).tasks).toEqual([]);
  });

  it("uses all three inbox types in one raw SQL subquery and keeps defaults, scope and limit+1", async () => {
    const f = await seedWorkspace("inbox");
    const peer = `${f.prefix}_peer`;
    await seedUser(peer, "Peer", "1713");
    const types = ["user_dm_message", "email_notification", "calendar_event"];
    await seedBatch(types.flatMap((type, i) => {
      const conversation = `${f.prefix}_conversation_${i}`;
      return [
        runtimeEnv.DB.prepare("INSERT INTO conversation (id, workspace_id, agent_id, user_id, title, type, channel, created_at) VALUES (?, ?, ?, ?, ?, ?, 'default', ?)").bind(conversation, f.workspace, f.agent, f.viewer, type, type, later),
        runtimeEnv.DB.prepare("INSERT INTO inbox_unread (id, conversation_id, user_id, workspace_id, agent_id, task_id, task_type, task_status, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?)").bind(`${f.prefix}_inbox_${i}`, conversation, f.viewer, f.workspace, f.agent, `${f.prefix}_task_${i}`, type, `2026-09-02T00:00:0${i}.000Z`),
      ];
    }));
    await run("INSERT INTO inbox_unread (id, conversation_id, user_id, workspace_id, agent_id, task_id, task_type, task_status, completed_at) VALUES (?, ?, ?, ?, ?, 'decoy', 'user_dm_message', 'completed', ?)", `${f.prefix}_other_user`, `${f.prefix}_conversation_0`, peer, f.workspace, f.agent, later);
    await run("INSERT INTO inbox_unread (id, conversation_id, user_id, workspace_id, agent_id, task_id, task_type, task_status, completed_at) VALUES (?, ?, ?, ?, ?, 'decoy', 'calendar_event', 'completed', ?)", `${f.prefix}_other_workspace`, f.conversation, f.viewer, `${f.prefix}_wrong`, f.agent, later);
    const { db, record } = recordedDb("K3-K4");
    const filter = Array.from({ length: 126 }, (_, i) => types[i % 3]);
    const page = await queries.inbox.listUnreadConversations(db, f.viewer, f.workspace, { types: filter, limit: 2 });
    expect(page.hasMore).toBe(true);
    expect(page.items.map(({ root_task_type }) => root_task_type)).toEqual(["calendar_event", "email_notification"]);
    expect(await queries.inbox.getUnreadCount(db, f.viewer, f.workspace, filter)).toBe(3);
    expect(await queries.inbox.getUnreadCount(db, f.viewer, f.workspace, [])).toBe(1);
    expect(await queries.inbox.getUnreadCount(db, f.viewer, f.workspace, ["unknown"])).toBe(0);
    expect((await queries.inbox.listUnreadConversations(db, f.viewer, f.workspace)).items).toHaveLength(1);
    const before = await queries.inbox.listUnreadConversations(db, f.viewer, f.workspace, { types: filter, before: "2026-09-02T00:00:02.000Z" });
    expect(before.items.map(({ root_task_type }) => root_task_type)).toEqual(["email_notification", "user_dm_message"]);
    for (const statement of record.statements) expect(statement.bindings).toHaveLength(statement.sql.includes("COUNT(*)") ? 3 : statement.sql.includes("u.completed_at <") ? 5 : 4);
  });

  it("joins the latest eligible snapshot sender across 87/88/90/125 scopes and preserves read, join, policy and notify gates", async () => {
    const f = await seedCommunity("snapshot");
    await seedBatch(f.channels.map((id, i) => runtimeEnv.DB.prepare("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'pending', ?, ?, 1)").bind(`${f.prefix}_message_${i}`, i === 2 ? f.viewer : f.sender, i === 1 ? baseline : later, id)));
    await run("INSERT INTO community_read_state (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq) VALUES (?, ?, ?, ?, ?, 1)", `${f.prefix}_read`, f.viewer, f.channels[0], later, `${f.prefix}_message_0`);
    await run("INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES (?, ?, ?, 'access', 'added', ?)", `${f.prefix}_access`, f.channels[6], f.viewer, "2026-09-03T00:00:00.000Z");
    await seedBatch([3, 4, 5].map((i) => runtimeEnv.DB.prepare("INSERT INTO community_notification_setting (id, user_id, channel_id, level) VALUES (?, ?, ?, ?)").bind(`${f.prefix}_policy_${i}`, f.viewer, f.channels[i], i === 3 ? "none" : "mentions")));
    await seedBatch([4, 5].flatMap((i) => [
      runtimeEnv.DB.prepare("INSERT INTO community_mention (id, message_id, user_id, kind) VALUES (?, ?, ?, ?)").bind(`${f.prefix}_mention_${i}`, `${f.prefix}_message_${i}`, f.viewer, i === 4 ? "mention" : "reply"),
      runtimeEnv.DB.prepare("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'newer ineligible', ?, ?, 2)").bind(`${f.prefix}_new_${i}`, f.other, later, f.channels[i]),
    ]));
    await run("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'legacy zero', ?, ?, 0)", `${f.prefix}_zero`, f.other, later, f.channels[7]);
    const privateId = `${f.prefix}_private`;
    await run("INSERT INTO community_category (id, server_id, name, private) VALUES (?, ?, 'Private', 1)", `${f.prefix}_category`, f.server);
    await run("INSERT INTO community_channel (id, server_id, category_id, name, type, created_at) VALUES (?, ?, ?, 'hidden', 'text', ?)", privateId, f.server, `${f.prefix}_category`, baseline);
    await run("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'hidden', ?, ?, 1)", `${f.prefix}_hidden_msg`, f.sender, later, privateId);
    const excluded = new Set([0, 1, 2, 3, 6].map((i) => f.channels[i]));
    const { db, record } = recordedDb("K5");
    for (const count of [1, 87, 88, 90, 125]) {
      const ids = f.channels.slice(0, count);
      const out = await queries.communityAgentInbox.getInboxSnapshotForAgent(db, f.viewer, { accessVisibleChannelIds: [...ids, ...ids] });
      expect(new Set(out.map(({ channelId }) => channelId))).toEqual(new Set(ids.filter((id) => !excluded.has(id))));
      if (count > 5) {
        expect(out.find(({ channelId }) => channelId === f.channels[4])).toMatchObject({ pendingCount: 1, latestSeq: 1, latestSender: `@${f.prefix}Alice#1711`, hasMention: true });
        expect(out.find(({ channelId }) => channelId === f.channels[5])).toMatchObject({ pendingCount: 1, latestSeq: 1, latestSender: `@${f.prefix}Alice#1711`, hasMention: false });
      }
    }
    expect(await queries.communityAgentInbox.getInboxSnapshotForAgent(db, f.viewer, { accessVisibleChannelIds: [] })).toEqual([]);
    const defaultOut = await queries.communityAgentInbox.getInboxSnapshotForAgent(db, f.viewer);
    expect(defaultOut.some(({ channelId }) => channelId === privateId)).toBe(false);
    expect(defaultOut.find(({ channelId }) => channelId === f.channels[7])).toMatchObject({ pendingCount: 1, firstPendingSeq: 1, latestSeq: 1 });
    await seedBatch([2, 3].map((seq) => runtimeEnv.DB.prepare("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'more pending', ?, ?, ?)").bind(`${f.prefix}_extra_${seq}`, f.other, later, f.channels[8], seq)));
    expect(await queries.communityAgentInbox.getInboxSnapshotForAgent(db, f.viewer, { accessVisibleChannelIds: [f.channels[8]] })).toMatchObject([{ pendingCount: 3, firstPendingSeq: 1, latestSeq: 3, latestSender: `@${f.prefix}Bob#1712` }]);
    const thread = `${f.prefix}_thread`;
    await run("INSERT INTO community_channel (id, server_id, parent_channel_id, name, type, created_at) VALUES (?, ?, ?, 'thread', 'thread', ?)", thread, f.server, f.channels[8], baseline);
    await run("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'thread', ?, ?, 1)", `${f.prefix}_thread_msg`, f.sender, later, thread);
    expect(await queries.communityAgentInbox.getInboxSnapshotForAgent(db, f.viewer, { accessVisibleChannelIds: [thread] })).toEqual([]);
    await run("INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES (?, ?, ?, 'notify', 'added', ?)", `${f.prefix}_notify`, thread, f.viewer, baseline);
    expect(await queries.communityAgentInbox.getInboxSnapshotForAgent(db, f.viewer, { accessVisibleChannelIds: [thread] })).toMatchObject([{ channelId: thread, pendingCount: 1 }]);
    statementCount(record, 'pending_inbox', 14);
    expect(await rows("SELECT last_read_seq FROM community_read_state WHERE id = ?", `${f.prefix}_read`)).toEqual([{ last_read_seq: 1 }]);
  });

  it("keeps authorized forum/thread metadata and stable ordering across 88/89/90/125 IDs", async () => {
    const f = await seedCommunity("openers");
    await run("UPDATE community_channel SET type = 'forum' WHERE server_id = ?", f.server);
    const children = f.channels.map((_, i) => `${f.prefix}_child_${i}`);
    await seedBatch(f.channels.flatMap((parent, i) => [
      runtimeEnv.DB.prepare("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, ?, ?, ?, 1)").bind(`${f.prefix}_opener_${i}`, f.sender, i === 6 ? "  " : `title-${i}`, i === 5 ? baseline : later, parent),
      runtimeEnv.DB.prepare("INSERT INTO community_channel (id, server_id, parent_channel_id, parent_message_id, name, type, created_at) VALUES (?, ?, ?, ?, ?, 'thread', ?)").bind(children[i], f.server, parent, `${f.prefix}_opener_${i}`, i === 6 ? "fallback" : `child-${i}`, later),
    ]));
    await run("UPDATE community_channel SET archived = 1 WHERE id IN (?, ?)", f.channels[0], children[1]);
    await run("UPDATE community_channel SET type = 'text' WHERE id IN (?, ?)", f.channels[2], children[3]);
    await run("INSERT INTO community_read_state (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq) VALUES (?, ?, ?, ?, ?, 1)", `${f.prefix}_read`, f.viewer, f.channels[4], later, `${f.prefix}_opener_4`);
    await run("INSERT INTO community_notification_setting (id, user_id, channel_id, level) VALUES (?, ?, ?, 'none')", `${f.prefix}_mute`, f.viewer, f.channels[7]);
    const { db, record } = recordedDb("K6-K7");
    for (const count of [1, 88, 89, 90, 125]) {
      const parents = f.channels.slice(0, count);
      const childIds = children.slice(0, count);
      const forum = await queries.communityInbox.listUnreadForumOpeners(db, f.viewer, [...parents, ...parents]);
      const thread = await queries.communityInbox.listThreadOpenersByChildIds(db, f.viewer, [...childIds, ...childIds]);
      expect(new Set(forum.map(({ openerMessageId }) => openerMessageId))).toEqual(new Set(parents.flatMap((_, i) => [0, 1, 2, 4, 5, 7].includes(i) ? [] : [`${f.prefix}_opener_${i}`])));
      expect(new Set(thread.map(({ childChannelId }) => childChannelId))).toEqual(new Set(childIds.filter((_, i) => ![0, 1, 3].includes(i))));
      expect(forum.map(({ openerMessageId }) => openerMessageId)).toEqual([...forum.map(({ openerMessageId }) => openerMessageId)].sort((a, b) => b.localeCompare(a)));
      if (count > 7) {
        expect(forum.find(({ childChannelId }) => childChannelId === children[6])).toMatchObject({ title: "fallback", forumChannelId: f.channels[6] });
        expect(thread.find(({ childChannelId }) => childChannelId === children[4])).toMatchObject({ openerUnread: false });
        expect(thread.find(({ childChannelId }) => childChannelId === children[7])).toMatchObject({ openerUnread: false });
      }
    }
    expect(await queries.communityInbox.listUnreadForumOpeners(db, f.viewer, [])).toEqual([]);
    expect(await queries.communityInbox.listThreadOpenersByChildIds(db, f.viewer, [])).toEqual([]);
    statementCount(record, 'forum_inbox_child', 13);
    statementCount(record, 'thread_inbox_child_lookup', 13);
  });

  it("selects newest scoped search rows before the global limit and escapes literal LIKE input", async () => {
    const f = await seedCommunity("search");
    await seedBatch(Array.from({ length: 60 }, (_, i) => runtimeEnv.DB.prepare("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'needle old', ?, ?, ?)").bind(`${f.prefix}_old_${i}`, f.sender, baseline, f.channels[0], i + 1)));
    await seedBatch(f.channels.map((channel, i) => runtimeEnv.DB.prepare("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'needle new', ?, ?, ?)").bind(`${f.prefix}_new_${i}`, f.sender, `2026-09-02T00:00:${String(i).padStart(3, "0")}Z`, channel, i === 0 ? 61 : 1)));
    const decoy = await seedCommunity("search_decoy", 1);
    await run("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'needle hidden', '2099-01-01', ?, 1)", `${decoy.prefix}_msg`, decoy.sender, decoy.channels[0]);
    await run("INSERT INTO community_category (id, server_id, name, private) VALUES (?, ?, 'Hidden', 1)", `${f.prefix}_hidden_category`, f.server);
    await run("INSERT INTO community_channel (id, server_id, category_id, name, type, created_at) VALUES (?, ?, ?, 'hidden', 'text', ?)", `${f.prefix}_hidden`, f.server, `${f.prefix}_hidden_category`, baseline);
    await run("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'needle private', '2099-01-01', ?, 1)", `${f.prefix}_hidden_msg`, f.sender, `${f.prefix}_hidden`);
    const { db, record } = recordedDb("search");
    const ids = f.channels.slice(0, 124);
    const serverResult = await queries.communitySearch.searchMessagesInServer(db, { query: "needle", serverId: f.server, visibleChannelIds: [...ids, ...ids], limit: 3 });
    expect(serverResult.map(({ message }) => message.id)).toEqual([123, 122, 121].map((i) => `${f.prefix}_new_${i}`));
    expect(await queries.communitySearch.searchMessagesInServer(db, { query: "needle", serverId: f.server, visibleChannelIds: [] })).toEqual([]);
    expect((await queries.communitySearch.searchMessagesInServer(db, { query: "needle", serverId: f.server, visibleChannelIds: f.channels })).map(({ message }) => message.id)).toEqual(Array.from({ length: 50 }, (_, i) => `${f.prefix}_new_${124 - i}`));
    expect((await queries.communitySearch.searchMessages(db, { query: "needle", channelId: f.channels[0], limit: 1 }))[0].message.id).toBe(`${f.prefix}_new_0`);
    statementCount(record, "json_each", 4);
    const literal = String.raw`100%_\end`;
    await run("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, ?, '2099-01-01', ?, 62)", `${f.prefix}_literal`, f.sender, literal, f.channels[0]);
    expect((await queries.communitySearch.searchMessages(db, { query: literal, channelId: f.channels[0] })).map(({ message }) => message.id)).toEqual([`${f.prefix}_literal`]);
    const dm = `${f.prefix}_dm`;
    await run("INSERT INTO community_channel (id, type, created_at) VALUES (?, 'dm', ?)", dm, baseline);
    await seedBatch([1, 2].map((seq) => runtimeEnv.DB.prepare("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'needle dm', ?, ?, ?)").bind(`${f.prefix}_dm_${seq}`, f.sender, seq === 1 ? baseline : later, dm, seq)));
    expect((await queries.communitySearch.searchMessages(db, { query: "needle", channelId: dm, limit: 1 }))[0].message.id).toBe(`${f.prefix}_dm_2`);
    const tied = [3, 4].map((seq) => `${f.prefix}_tie_${seq}`);
    await seedBatch(tied.map((id, i) => runtimeEnv.DB.prepare("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'tie', ?, ?, ?)").bind(id, f.sender, later, dm, i + 3)));
    expect(new Set((await queries.communitySearch.searchMessages(db, { query: "tie", channelId: dm, limit: 2 })).map(({ message }) => message.id))).toEqual(new Set(tied));
  });

  it("creates exactly one complete graph with a single native seven-statement batch", async () => {
    const prefix = fixturePrefix("server_success");
    const owner = `${prefix}_owner`;
    await seedUser(owner);
    const { db, record } = recordedDb("server-success");
    const result = await queries.communityServer.createServer(db, { name: prefix, ownerId: owner, description: "description" });
    expect(record.batches).toEqual([7]);
    expect(result.server).toMatchObject({ name: prefix, ownerId: owner, description: "description" });
    expect(result.ownerMember).toMatchObject({ userId: owner, userName: owner, userImage: null, userAvatarVersion: 0, userDiscriminator: "1710" });
    expect(await graph(prefix)).toEqual([{ servers: 1, categories: 2, channels: 2, access: 1, members: 1 }]);
    expect(await rows("SELECT c.name, k.name AS category, k.private FROM community_channel c JOIN community_category k ON k.id = c.category_id WHERE c.server_id = ? ORDER BY k.position", result.server.id)).toEqual([{ name: "all", category: "Public", private: 0 }, { name: "room", category: "Private", private: 1 }]);
    expect(await rows("SELECT role, rail_order FROM community_server_member WHERE server_id = ?", result.server.id)).toEqual([{ role: "owner", rail_order: 0 }]);
  });

  it.each([2, 3, 4, 5, 6, 7])("rolls back every graph row after a native failure at seed step %i", async (step) => {
    const prefix = fixturePrefix(`rollback_${step}`);
    const owner = `${prefix}_owner`;
    await seedUser(owner);
    const trigger = `${prefix}_trigger`;
    const table = step === 2 || step === 4 ? "community_category" : step === 3 || step === 5 ? "community_channel" : step === 6 ? "community_channel_member" : "community_server_member";
    const scope = step === 6 ? "(SELECT server_id FROM community_channel WHERE id = NEW.channel_id)" : "NEW.server_id";
    const extra = step === 2 ? "AND NEW.name = 'Public'" : step === 4 ? "AND NEW.name = 'Private'" : step === 3 ? "AND NEW.name = 'all'" : step === 5 ? "AND NEW.name = 'room'" : "";
    triggers.push(trigger);
    await run(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} WHEN ${scope} IN (SELECT id FROM community_server WHERE name = '${prefix}') ${extra} BEGIN SELECT RAISE(ABORT, 'sql171 injected step${step}'); END`);
    const { db, record } = recordedDb(`server-rollback-${step}`);
    await expect(queries.communityServer.createServer(db, { name: prefix, ownerId: owner })).rejects.toThrow(`sql171 injected step${step}`);
    expect(record.batches).toEqual([7]);
    expect(await graph(prefix)).toEqual([{ servers: 0, categories: 0, channels: 0, access: 0, members: 0 }]);
  });

  it("retries the complete batch only after a real server handle UNIQUE collision", async () => {
    const prefix = fixturePrefix("collision");
    const owner = `${prefix}_owner`;
    await seedUser(owner);
    let firstDiscriminator: unknown;
    const { db, record } = recordedDb("server-collision", async (attempt, statements) => {
      if (attempt !== 1) return;
      const insert = statements[0];
      expect(insert.sql).toContain('insert into "community_server" ("id", "name", "discriminator"');
      expect(insert.bindings[1]).toBe(prefix);
      firstDiscriminator = insert.bindings[2];
      await run("INSERT INTO community_server (id, name, discriminator, owner_id, created_at) VALUES (?, ?, ?, ?, ?)", `${prefix}_competitor`, prefix, firstDiscriminator, owner, baseline);
    });
    const result = await queries.communityServer.createServer(db, { name: prefix, ownerId: owner });
    expect(record.batches.length).toBeGreaterThanOrEqual(2);
    expect(record.batches.every((size) => size === 7)).toBe(true);
    expect(result.server.discriminator).not.toBe(firstDiscriminator);
    expect(await graph(prefix)).toEqual([{ servers: 2, categories: 2, channels: 2, access: 1, members: 1 }]);
    expect(await rows("SELECT COUNT(*) AS total FROM community_category WHERE server_id = ?", `${prefix}_competitor`)).toEqual([{ total: 0 }]);
  });

  it("propagates a real child UNIQUE error without salt retry or partial rows", async () => {
    const f = await seedCommunity("child_unique", 1);
    await run("INSERT INTO community_category (id, server_id, name) VALUES (?, ?, 'Existing')", `${f.prefix}_existing_category`, f.server);
    const name = `${f.prefix}_target`;
    const trigger = `${f.prefix}_trigger`;
    triggers.push(trigger);
    await run(`CREATE TRIGGER ${trigger} BEFORE INSERT ON community_category WHEN NEW.server_id IN (SELECT id FROM community_server WHERE name = '${name}') BEGIN INSERT INTO community_category (id, server_id, name) VALUES ('${f.prefix}_duplicate_category', '${f.server}', 'Existing'); END`);
    const { db, record } = recordedDb("server-child-unique");
    await expect(queries.communityServer.createServer(db, { name, ownerId: f.viewer })).rejects.toThrow("UNIQUE constraint failed: community_category.server_id, community_category.name");
    expect(record.batches).toEqual([7]);
    expect(await graph(name)).toEqual([{ servers: 0, categories: 0, channels: 0, access: 0, members: 0 }]);
  });

  it("propagates a native foreign-key failure without retry", async () => {
    const name = fixturePrefix("server_fk");
    const { db, record } = recordedDb("server-fk");
    await expect(queries.communityServer.createServer(db, { name, ownerId: `${name}_absent` })).rejects.toThrow("FOREIGN KEY constraint failed");
    expect(record.batches).toEqual([7]);
    expect(await graph(name)).toEqual([{ servers: 0, categories: 0, channels: 0, access: 0, members: 0 }]);
  });
});
