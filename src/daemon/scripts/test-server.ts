/**
 * `pnpm run test-server -- <cmd> [flags]` — terminal 2.
 *
 * A thin ADMIN client against the mock-server's admin bridge — it simulates a
 * user/server-side operator provisioning and posting. It is intentionally NOT
 * part of the `alook` CLI (production source stays clean) and only reaches admin
 * routes the daemon process can never call.
 *
 * Commands:
 *   create-user   --name me
 *   create-agent  --user <userId> --name cindy --runtime claude
 *   create-server --name demo
 *   add-agent     --agent <agentId> --server <serverId>
 *   create-channel --server <serverId> --name general
 *   post          --channel /demo/general --text "hi" [--sender @gustavo]
 *   read          --channel /demo/general            (data-plane convenience)
 */
import { bridgeCall } from "./localBridge";

const BASE = process.env.ALOOK_BRIDGE_URL || `http://127.0.0.1:${process.env.ALOOK_BRIDGE_PORT || 4517}`;

function parse(argv: string[]): { cmd: string; flags: Record<string, string>; pos: string[] } {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      flags[rest[i].slice(2)] = rest[i + 1] ?? "";
      i++;
    } else {
      pos.push(rest[i]);
    }
  }
  return { cmd: cmd ?? "", flags, pos };
}

async function main(): Promise<number> {
  const { cmd, flags, pos } = parse(process.argv.slice(2));
  const admin = <T>(method: string, body: unknown) => bridgeCall<T>(BASE, "admin", method, body);
  // Accept both `--flag value` and bare positionals (npm strips flags without `--`).
  const arg = (flag: string, posIdx: number): string | undefined => flags[flag] ?? pos[posIdx];

  switch (cmd) {
    case "create-user": {
      const name = need(arg("name", 0), "name");
      const r = await admin<{ user: { id: string; name: string } }>("createUser", { name });
      console.log(`created user: ${r.user.name} (${r.user.id})`);
      return 0;
    }
    case "create-agent": {
      const userId = need(arg("user", 0), "user");
      const name = need(arg("name", 1), "name");
      const r = await admin<{ agent: { id: string; name: string } }>("createAgent", {
        userId,
        name,
        runtime: need(arg("runtime", 2), "runtime"),
      });
      console.log(`created agent: ${r.agent.name} (${r.agent.id})  [owner=${userId}]`);
      return 0;
    }
    case "create-server": {
      const name = need(arg("name", 0), "name");
      const r = await admin<{ server: { id: string; name: string } }>("createServer", { name });
      console.log(`created server: ${r.server.name} (${r.server.id})`);
      return 0;
    }
    case "add-agent": {
      const agentId = need(arg("agent", 0), "agent");
      const server = need(arg("server", 1), "server");
      await admin("addAgentToServer", { agentId, server });
      console.log(`added agent ${agentId} → server ${server}`);
      return 0;
    }
    case "create-channel": {
      const server = need(arg("server", 0), "server");
      const name = need(arg("name", 1), "name");
      const r = await admin<{ channel: { id: string; name: string } }>("createChannel", { server, name });
      console.log(`created channel: /${server}/${r.channel.name}  (${r.channel.id})`);
      return 0;
    }
    case "post": {
      const channel = need(arg("channel", 0), "channel");
      const text = need(arg("text", 1), "text");
      const r = await admin<{ message: { channel: string; seq: string } }>("postMessage", {
        channel,
        sender: flags.sender || "@gustavo",
        text,
      });
      console.log(`posted: ${r.message.channel}${r.message.seq}`);
      return 0;
    }
    case "read": {
      const channel = need(arg("channel", 0), "channel");
      // Observability read via the ADMIN plane (no agent identity); the agent
      // data plane now requires a proxy-stamped X-Agent-Id.
      const r = await admin<{ items: Array<{ channel: string; seq: string; sender: string; content: { text: string } }> }>(
        "readChannel",
        { channel, limit: 50 },
      );
      for (const m of r.items) console.log(`  ${m.channel}${m.seq}  ${m.sender}: ${m.content.text}`);
      if (r.items.length === 0) console.log("  (empty)");
      return 0;
    }
    default:
      console.error(
        "usage: pnpm run test-server -- <create-user|create-agent|create-server|add-agent|create-channel|post|read> [args]",
      );
      return 2;
  }
}

/** Require a value (from flag or positional), else fail with a clear message. */
function need(v: string | undefined, label: string): string {
  if (v === undefined || v === "") throw new Error(`missing "${label}" (pass --${label} <value> or as a positional)`);
  return v;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
