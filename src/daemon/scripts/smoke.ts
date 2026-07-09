/**
 * `pnpm run smoke` — multi-agent smoke test with real Claude runtimes.
 *
 * smoke plays the OPERATOR / server-side role (a human provisioning + posting),
 * NOT the daemon. It talks ONLY to the mock-server's ADMIN plane (`/admin/*`):
 * create user/agents/server/channel, post a message, then poll until all agents
 * have replied. The agents' replies are produced by the SEPARATE daemon process
 * over the real credential chain (enroll → voucher → proxy → X-Agent-Id).
 *
 * Against a running mock-server's admin bridge, it:
 *   1. creates a user,
 *   2. creates 3 agents owned by that user (runtime=claude),
 *   3. creates a server + a #general channel,
 *   4. adds all 3 agents into that server,
 *   5. posts a message to #general,
 *   6. polls the transcript until all 3 agents have replied (up to 120s),
 *   7. verifies each agent's reply + timeline file existence.
 *
 * Requires both processes up: `pnpm run mock-server` (the server) and a
 * `pnpm run daemon` connected to it.
 */
import { bridgeCall } from "./localBridge";

const BASE = process.env.ALOOK_BRIDGE_URL || `http://127.0.0.1:${process.env.ALOOK_BRIDGE_PORT || 4517}`;
const admin = <T>(method: string, body: unknown) => bridgeCall<T>(BASE, "admin", method, body);

const AGENT_NAMES = ["cindy", "devon", "echo"];
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 120_000;

async function main(): Promise<number> {
  console.log(`smoke: bridge=${BASE}`);

  const { user } = await admin<{ user: { id: string; name: string } }>("createUser", { name: "me" });
  console.log(`  user: ${user.name} (${user.id})`);

  const agents: { id: string; name: string }[] = [];
  for (const name of AGENT_NAMES) {
    const { agent } = await admin<{ agent: { id: string; name: string } }>("createAgent", {
      userId: user.id,
      name,
      runtime: "claude",
      instruction: "You are a test agent. Reply briefly to any message you receive.",
    });
    agents.push(agent);
    console.log(`  agent: ${agent.name} (${agent.id})`);
  }

  const { server } = await admin<{ server: { id: string; name: string } }>("createServer", { name: "demo" });
  console.log(`  server: ${server.name} (${server.id})`);

  for (const a of agents) await admin("addAgentToServer", { agentId: a.id, server: server.id });
  console.log(`  added ${agents.length} agents → ${server.name}`);

  const { channel } = await admin<{ channel: { id: string; name: string } }>("createChannel", {
    server: server.id,
    name: "general",
  });
  const channelRef = `/${server.id}/general`;
  console.log(`  channel: ${channelRef} (${channel.id})`);

  const commandText = "报数，从1开始，每个人只能报一次就停止自己的报数"
  console.log(`\nposting ${commandText} to ${channelRef} …`);
  await admin("postMessage", { channel: channelRef, sender: "@gustavo", text: commandText });

  // Poll until all agents have replied or timeout.
  console.log(`\nwaiting for ${AGENT_NAMES.length} agent replies (timeout ${MAX_WAIT_MS / 1000}s)…`);
  const start = Date.now();
  let replies = 0;
  const seen = new Set<string>();
  let page: { items: Array<{ seq: string; sender: string; content: { text: string } }> } = { items: [] };

  while (Date.now() - start < MAX_WAIT_MS) {
    page = await admin<typeof page>("readChannel", { channel: channelRef, limit: 50 });
    for (const m of page.items) {
      if (m.sender === "@gustavo") continue;
      if (seen.has(m.sender)) continue;
      seen.add(m.sender);
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`  [${elapsed}s] ${m.sender}: ${m.content.text}`);
    }
    replies = seen.size;
    if (replies >= AGENT_NAMES.length) break;
    await delay(POLL_INTERVAL_MS);
  }

  console.log(`\n${channelRef} transcript:`);
  for (const m of page.items) console.log(`  ${m.seq}  ${m.sender}: ${m.content.text}`);

  console.log(`\nresult: ${replies} agent replies (expected ${AGENT_NAMES.length})`);
  if (replies < AGENT_NAMES.length) {
    console.error("FAIL: not all agents replied within timeout");
    return 1;
  }

  // Verify distinct senders (each agent replied independently).
  const senders = new Set(page.items.filter((m) => m.sender !== "@gustavo").map((m) => m.sender));
  if (senders.size < AGENT_NAMES.length) {
    console.error(`FAIL: only ${senders.size} distinct agent senders (expected ${AGENT_NAMES.length})`);
    return 1;
  }

  console.log("PASS: all agents replied independently ✓");
  return 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(`smoke failed: ${e.message}`);
    console.error("(is `pnpm run mock-server` + `alook daemon start` running in another terminal?)");
    process.exit(1);
  });
