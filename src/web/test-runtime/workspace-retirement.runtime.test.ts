/// <reference types="@cloudflare/vitest-plugin/types" />
import type { D1Migration } from "@cloudflare/vitest-plugin"
import { env } from "cloudflare:workers"
import { applyD1Migrations } from "cloudflare:test"
import { expect, it } from "vitest"

const retired = ["workspace", "member", "workspace_invite", "agent_access", "agent_pin", "agent_sidebar_order", "machine", "agent_runtime", "agent", "agent_whitelist", "channel", "conversation", "message", "agent_task_queue", "issue", "issue_comment", "task_message", "emails", "calendar_event", "artifact", "agent_email_account", "meeting_session", "machine_token", "message_flag", "conversation_map", "agent_link", "conversation_read_state", "workspace_file_request", "agent_skill", "inbox_unread"]

it("upgrades populated pre-0119 data, retires only /w tables and preserves current rows and constraints", async () => {
  const runtime = env as unknown as { MIGRATION_REVIEW_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
  const raw = runtime.MIGRATION_REVIEW_DB
  const indexMigration = runtime.TEST_MIGRATIONS.find(m => m.name.startsWith("0119"))!
  const retirement = runtime.TEST_MIGRATIONS.find(m => m.name.startsWith("0120"))!
  expect(indexMigration).toBeDefined()
  expect(retirement).toBeDefined()
  await applyD1Migrations(raw, runtime.TEST_MIGRATIONS.filter(m => m.name < indexMigration.name))
  await raw.batch([
    raw.prepare("INSERT INTO user(id,name,email,discriminator) VALUES('m119_owner','MigrationOwner','migration-owner@test.example','9911'),('m119_other','MigrationOther','migration-other@test.example','9912')"),
    raw.prepare("INSERT INTO community_machine(id,user_id,status,created_at,updated_at) VALUES('m119_machine','m119_owner','online','2026-01-01','2026-01-01')"),
    raw.prepare("INSERT INTO user(id,name,email,discriminator,isBot,ownerUserId,deletedAt) VALUES('m119_bot','MigrationBot','migration-bot@test.example','9913',1,'m119_owner',NULL),('m119_deleted','MigrationDeleted','migration-deleted@test.example','9914',1,'m119_owner','2026-01-02')"),
    raw.prepare("INSERT INTO community_bot_binding(user_id,machine_id,runtime,is_active,created_at,model_observation) VALUES('m119_bot','m119_machine','codex-cli',1,'2026-01-01','{\"retained\":true}')"),
    raw.prepare("INSERT INTO user_product_plan(user_id,plan_id,is_founder) VALUES('m119_other','free',1)"),
    raw.prepare("INSERT INTO community_server(id,name,discriminator,owner_id,created_at) VALUES('m119_server','MigrationServer','9911','m119_owner','2026-01-01')"),
    raw.prepare("INSERT INTO community_channel(id,server_id,type,created_at,message_count) VALUES('m119_channel','m119_server','text','2026-01-01',2)"),
    raw.prepare("INSERT INTO community_message(id,channel_id,author_id,content,created_at,seq) VALUES('m119_message','m119_channel','m119_owner','retained body','2026-01-01',1),('m119_legacy','m119_channel','m119_bot','legacy body','2026-01-01',0)"),
    raw.prepare("INSERT INTO community_read_state(id,user_id,channel_id,last_read_message_id,last_read_seq,last_read_at) VALUES('m119_read','m119_other','m119_channel','m119_message',1,'2026-01-01')"),
    raw.prepare("INSERT INTO community_bot_approval_request(id,bot_id,kind,server_id,requested_by_user_id,dm_message_id,status,created_at) VALUES('m119_approval','m119_bot','join_server','m119_server','m119_other','m119_message','approved','2026-01-01')"),
    raw.prepare("INSERT INTO product_analytics_event(id,event_name,actor_user_id,server_id,dedupe_key,client_id,session_id,created_at) VALUES('m119_event','test','m119_owner','m119_server','m119_dedupe','test','test','2026-01-01'),('m119_nullable','test',NULL,NULL,'m119_null_dedupe','test','test','2026-01-01')"),
    raw.prepare("INSERT INTO verification(id,identifier,value,expiresAt) VALUES('m119_verification','duplicate-test','retained-value','2000-01-01'),('m119_verification2','duplicate-test','retained-value','2000-01-01')"),
  ])

  await raw.batch([
    raw.prepare("INSERT INTO workspace(id,name,slug,created_at,updated_at) VALUES('retired_workspace','Old workspace','old-workspace','2026-01-01','2026-01-01')"),
    raw.prepare("INSERT INTO member(id,workspace_id,user_id,role,created_at) VALUES('retired_member','retired_workspace','m119_other','owner','2026-01-01')"),
    raw.prepare("INSERT INTO machine(daemon_id,workspace_id,owner_id,created_at,updated_at) VALUES('retired_machine','retired_workspace','m119_other','2026-01-01','2026-01-01')"),
    raw.prepare("INSERT INTO agent_runtime(id,workspace_id,daemon_id,provider,created_at,updated_at) VALUES('retired_runtime','retired_workspace','retired_machine','codex','2026-01-01','2026-01-01')"),
    raw.prepare("INSERT INTO agent(id,workspace_id,name,runtime_id,owner_id,created_at,updated_at) VALUES('retired_agent','retired_workspace','Old agent','retired_runtime','m119_other','2026-01-01','2026-01-01')"),
    raw.prepare("INSERT INTO conversation(id,workspace_id,agent_id,user_id,title,type,channel,created_at) VALUES('retired_conversation','retired_workspace','retired_agent','m119_owner','','user_dm_message','default','2026-01-01')"),
    raw.prepare("INSERT INTO emails(id,agent_id,workspace_id,from_email,to_email,r2_key,attachments,created_at) VALUES('retired_email','retired_agent','retired_workspace','old@example.test','other@example.test','emails/retained/raw','[{\"key\":\"emails/drafts/shared\"}]','2026-01-01')"),
    raw.prepare("INSERT INTO artifact(id,conversation_id,agent_id,workspace_id,filename,size,r2_key,created_at) VALUES('retired_artifact','retired_conversation','retired_agent','retired_workspace','old.txt',1,'artifacts/retained','2026-01-01')"),
    raw.prepare("INSERT INTO machine_token(id,user_id,workspace_id,token,name,status,created_at) VALUES('retired_token','m119_other','retired_workspace','retired-test-token','Old','active','2026-01-01')"),
  ])
  const tables = async () => (await raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,4) <> '_cf_' AND name <> 'd1_migrations' ORDER BY name").all<{name:string}>()).results.map(r => r.name)
  const snapshot = async (names: string[]) => {
    const data: Record<string, string[]> = {}
    for (const name of names) data[name] = (await raw.prepare(`SELECT * FROM "${name}"`).all()).results.map(row => JSON.stringify(row)).sort()
    return data
  }
  const ddl = async () => (await raw.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view') AND name NOT LIKE 'sqlite_%' AND substr(name,1,4) <> '_cf_' AND name <> 'd1_migrations' ORDER BY type,name").all<{type:string;name:string;tbl_name:string;sql:string}>()).results
  const beforeTables = await tables()
  expect(beforeTables).toHaveLength(84)
  const before = await snapshot(beforeTables)
  const beforeDdl = await ddl()
  const oldIndexes = (await raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()).results.length
  await applyD1Migrations(raw, [indexMigration])
  expect(await snapshot(beforeTables)).toEqual(before)
  expect(await ddl()).toEqual(beforeDdl)
  expect((await raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()).results.length - oldIndexes).toBe(36)
  expect((await raw.prepare("PRAGMA foreign_key_check").all()).results).toEqual([])
  await applyD1Migrations(raw, [retirement])
  const retainedTables = beforeTables.filter(name => !retired.includes(name))
  expect(await tables()).toEqual(retainedTables)
  expect(retainedTables).toHaveLength(54)
  expect(await snapshot(retainedTables)).toEqual(Object.fromEntries(Object.entries(before).filter(([name]) => !retired.includes(name))))
  expect(await ddl()).toEqual(beforeDdl.filter(row => !retired.includes(row.tbl_name)))
  expect((await raw.prepare("PRAGMA foreign_key_check").all()).results).toEqual([])
  expect((await raw.prepare("PRAGMA quick_check").all()).results).toEqual([{ quick_check: "ok" }])
  const history = (await raw.prepare("SELECT name FROM d1_migrations ORDER BY name").all()).results
  expect(history.filter(row => row.name === indexMigration.name)).toHaveLength(1)
  expect(history.filter(row => row.name === retirement.name)).toHaveLength(1)
  await applyD1Migrations(raw, [indexMigration, retirement])
  expect((await raw.prepare("SELECT name FROM d1_migrations ORDER BY name").all()).results).toEqual(history)
  expect(await snapshot(retainedTables)).toEqual(Object.fromEntries(Object.entries(before).filter(([name]) => !retired.includes(name))))
  console.info("workspace-retirement", JSON.stringify({ beforeTables:84, retainedTables:54, retiredTables:30, currentPopulatedTables:retainedTables.filter(name=>before[name]!.length).length, currentRows:retainedTables.reduce((n,name)=>n+before[name]!.length,0), retiredSeedRows:retired.reduce((n,name)=>n+before[name]!.length,0), indexAdditions:36, currentRowsAndDdlUnchanged:true, fkViolations:0, repeatedApplicationSkipped:true }))
})
