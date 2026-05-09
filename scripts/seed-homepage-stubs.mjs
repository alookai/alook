import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceSlug = process.env.ALOOK_STUB_WORKSPACE_SLUG || "d1183898546";
const ownerEmail = process.env.ALOOK_STUB_OWNER_EMAIL || "d1183898546@gmail.com";
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const stubOnlineUntil = "strftime('%Y-%m-%dT%H:%M:%SZ','now','+1 hour')";

const workspaceId = `(select id from workspace where slug = '${workspaceSlug.replaceAll("'", "''")}')`;
const ownerId = `(select id from user where email = '${ownerEmail.replaceAll("'", "''")}')`;

const sql = `
PRAGMA foreign_keys=ON;

insert into machine (daemon_id, workspace_id, device_info, last_seen_at, created_at, updated_at)
values
  ('daemon_stub_studio', ${workspaceId}, 'MacBook Studio Stub', ${stubOnlineUntil}, ${now}, ${now}),
  ('daemon_stub_lab', ${workspaceId}, 'Alook Lab Stub', ${stubOnlineUntil}, ${now}, ${now})
on conflict(workspace_id, daemon_id) do update set
  device_info = excluded.device_info,
  last_seen_at = excluded.last_seen_at,
  updated_at = excluded.updated_at;

insert into agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, device_info, metadata, created_at, updated_at)
values
  ('rt_stub_codex_studio', ${workspaceId}, 'daemon_stub_studio', 'local', 'codex', 'MacBook Studio Stub', json('{"version":"stub-codex","stub":true}'), ${now}, ${now}),
  ('rt_stub_claude_lab', ${workspaceId}, 'daemon_stub_lab', 'local', 'claude', 'Alook Lab Stub', json('{"version":"stub-claude","stub":true}'), ${now}, ${now})
on conflict(id) do update set
  daemon_id = excluded.daemon_id,
  runtime_mode = excluded.runtime_mode,
  provider = excluded.provider,
  device_info = excluded.device_info,
  metadata = excluded.metadata,
  updated_at = excluded.updated_at;

insert into agent (id, workspace_id, name, description, instructions, avatar_url, runtime_id, runtime_mode, runtime_config, visibility, status, max_concurrent_tasks, owner_id, tools, triggers, email_handle, created_at, updated_at)
values
  ('ag_stub_mandy', ${workspaceId}, 'Mandy', 'General manager stub for local Homepage testing.', 'Coordinate, summarize, and keep the work moving.', null, 'rt_stub_claude_lab', 'local', json('{"model":"claude-sonnet-4-6","stub":true}'), 'private', 'idle', 6, ${ownerId}, null, null, 'stub-mandy', ${now}, ${now}),
  ('ag_stub_tony', ${workspaceId}, 'Tony', 'Implementation engineer stub.', 'Implement scoped product and infrastructure changes.', null, 'rt_stub_codex_studio', 'local', json('{"model":"gpt-5.3-codex","stub":true}'), 'private', 'idle', 6, ${ownerId}, null, null, 'stub-tony', ${now}, ${now}),
  ('ag_stub_jesse', ${workspaceId}, 'Jesse', 'Adversarial reviewer stub.', 'Challenge assumptions, review edge cases, and verify implementation quality.', null, 'rt_stub_codex_studio', 'local', json('{"model":"gpt-5.3-codex","stub":true}'), 'private', 'idle', 6, ${ownerId}, null, null, 'stub-jesse', ${now}, ${now}),
  ('ag_stub_huzi', ${workspaceId}, 'Huzi', 'MacBook and local execution stub.', 'Handle local MacBook checks, tunnels, and filesystem execution.', null, 'rt_stub_claude_lab', 'local', json('{"model":"claude-sonnet-4-6","stub":true}'), 'private', 'idle', 6, ${ownerId}, null, null, 'stub-huzi', ${now}, ${now}),
  ('ag_stub_fenge', ${workspaceId}, 'Fenge', 'Email operations stub.', 'Handle outbound email drafts, replies, and outreach workflows.', null, 'rt_stub_claude_lab', 'local', json('{"model":"claude-sonnet-4-6","stub":true}'), 'private', 'idle', 6, ${ownerId}, null, null, 'stub-fenge', ${now}, ${now})
on conflict(id, workspace_id) do update set
  name = excluded.name,
  description = excluded.description,
  instructions = excluded.instructions,
  runtime_id = excluded.runtime_id,
  runtime_mode = excluded.runtime_mode,
  runtime_config = excluded.runtime_config,
  owner_id = excluded.owner_id,
  email_handle = excluded.email_handle,
  updated_at = excluded.updated_at;

insert into agent_link (id, workspace_id, source_agent_id, target_agent_id, instruction, created_at, updated_at)
values
  ('al_stub_mandy_tony', ${workspaceId}, 'ag_stub_mandy', 'ag_stub_tony', 'Mandy assigns implementation work to Tony.', ${now}, ${now}),
  ('al_stub_tony_jesse', ${workspaceId}, 'ag_stub_tony', 'ag_stub_jesse', 'Tony sends changes to Jesse for adversarial review.', ${now}, ${now}),
  ('al_stub_jesse_mandy', ${workspaceId}, 'ag_stub_jesse', 'ag_stub_mandy', 'Jesse reports risks back to Mandy for acceptance.', ${now}, ${now}),
  ('al_stub_mandy_huzi', ${workspaceId}, 'ag_stub_mandy', 'ag_stub_huzi', 'Mandy asks Huzi to validate local MacBook workflows.', ${now}, ${now}),
  ('al_stub_fenge_mandy', ${workspaceId}, 'ag_stub_fenge', 'ag_stub_mandy', 'Fenge reports email delivery status to Mandy.', ${now}, ${now})
on conflict(workspace_id, source_agent_id, target_agent_id) do update set
  instruction = excluded.instruction,
  updated_at = excluded.updated_at;

insert into conversation (id, workspace_id, agent_id, user_id, title, type, channel, created_at)
values
  ('conv_stub_tony_working', ${workspaceId}, 'ag_stub_tony', ${ownerId}, 'Stub active task for Homepage PET testing', 'user_dm_message', 'default', ${now})
on conflict(id) do update set
  title = excluded.title,
  channel = excluded.channel;

insert into agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, type, context_key, status, priority, result, context, session_id, created_at, dispatched_at, started_at, completed_at, error, trace_id, parent_task_id)
values
  ('task_stub_tony_running', 'ag_stub_tony', 'rt_stub_codex_studio', ${workspaceId}, 'conv_stub_tony_working', 'Stub running task so PET can react to a working agent on Homepage.', 'user_dm_message', 'stub-homepage-pet', 'running', 0, null, json('{"stub":true}'), 'stub-session', ${now}, ${now}, ${now}, null, null, 'trace_stub_homepage_pet', null)
on conflict(id) do update set
  status = excluded.status,
  prompt = excluded.prompt,
  context = excluded.context,
  dispatched_at = excluded.dispatched_at,
  started_at = excluded.started_at;

select 'workspace' as kind, id, slug as label from workspace where slug = '${workspaceSlug.replaceAll("'", "''")}';
select 'machine_count' as kind, count(*) as id, '' as label from machine where workspace_id = ${workspaceId} and daemon_id like 'daemon_stub_%';
select 'runtime_count' as kind, count(*) as id, '' as label from agent_runtime where workspace_id = ${workspaceId} and id like 'rt_stub_%';
select 'agent_count' as kind, count(*) as id, '' as label from agent where workspace_id = ${workspaceId} and id like 'ag_stub_%';
select 'active_stub_tasks' as kind, count(*) as id, '' as label from agent_task_queue where workspace_id = ${workspaceId} and id = 'task_stub_tony_running' and status = 'running';
`;

const dir = mkdtempSync(join(tmpdir(), "alook-homepage-stubs-"));
const file = join(dir, "seed.sql");
writeFileSync(file, sql);

const result = spawnSync(
  "pnpm",
  ["--filter", "@alook/web", "exec", "wrangler", "d1", "execute", "alook-app", "--local", "--file", file],
  { stdio: "inherit" },
);

rmSync(dir, { recursive: true, force: true });
process.exit(result.status ?? 1);
