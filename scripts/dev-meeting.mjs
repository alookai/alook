#!/usr/bin/env node
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const WEB_DIR = new URL("../src/web", import.meta.url).pathname;
const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

function d1(sql) {
  const cmd = `npx wrangler d1 execute alook-app --local --json --command "${sql.replace(/"/g, '\\"')}"`;
  const out = execSync(cmd, { cwd: WEB_DIR, stdio: "pipe" }).toString();
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

const code = process.argv[2];
if (!code) {
  console.error("Usage: pnpm dev:meeting <meet-code|url> [title]");
  console.error("  e.g. pnpm dev:meeting wjp-qpjv-kfj");
  console.error("  e.g. pnpm dev:meeting https://meet.google.com/wjp-qpjv-kfj");
  process.exit(1);
}

const meetingUrl = MEET_CODE_RE.test(code)
  ? `https://meet.google.com/${code}`
  : code;

if (!/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(meetingUrl)) {
  console.error(`Invalid meet URL/code: ${code}`);
  process.exit(1);
}

const title = process.argv[3] || "Dev Meeting";

const agents = d1("SELECT id, workspace_id FROM agent LIMIT 1");
if (!agents.length) {
  console.error("No agent found in local DB. Run dev:web first and create an agent.");
  process.exit(1);
}

const { id: agentId, workspace_id: workspaceId } = agents[0];
const meetingId = `ms_${randomUUID().replace(/-/g, "").slice(0, 21)}`;
const now = new Date().toISOString();

d1(`INSERT INTO meeting_session (id, agent_id, workspace_id, title, meeting_url, status, is_whitelisted, participants, scheduled_at, created_at, updated_at) VALUES ('${meetingId}', '${agentId}', '${workspaceId}', '${title}', '${meetingUrl}', 'scheduled', 1, '[]', '${now}', '${now}', '${now}')`);

console.log(`✓ Meeting created: ${meetingId}`);
console.log(`  URL:    ${meetingUrl}`);
console.log(`  Agent:  ${agentId}`);
console.log(`  Status: scheduled (daemon will claim on next poll)`);
