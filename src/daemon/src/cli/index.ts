#!/usr/bin/env node
/**
 * `alook` — the agent-facing CLI.
 *
 * Built on commander; each subcommand is registered once and `-h` is auto-generated.
 *
 * OUTPUT CONTRACT (mandatory for EVERY agent-facing command): exactly one JSON
 * object on stdout, shape `{ success?, error?, hint? }`:
 *   - `success` carries the command's structured result;
 *   - `error` is a human-readable failure message (mutually exclusive with success);
 *   - `hint` is an optional "what to do next" recovery hint, surfaced when a
 *     rejected command carries one (e.g. `server join`'s owner-mismatch);
 *   - NULL fields are OMITTED, never printed (no wasted tokens).
 * There is no meaningful exit code — the process exits 0 and the JSON envelope is
 * the sole result channel.
 */
import { Command, CommanderError } from "commander";
import type { ServerApi, Cursor, Message } from "../server/contract.js";
import { proxyServerApiFromEnv } from "./proxyServerApi.js";
import { daemonStart, daemonStop, daemonList } from "./daemonStart.js";
import { parseInviteToken } from "@alook/shared/lib/invite-link";

/** The mandatory output envelope. Null/undefined fields are stripped on print. */
interface Envelope {
  success?: unknown;
  error?: string;
  hint?: string;
}

/** A command failure with a human-readable message destined for `error`. */
class CliError extends Error {}

function printEnvelope(env: Envelope): void {
  const out: Record<string, unknown> = {};
  if (env.success !== undefined && env.success !== null) out.success = env.success;
  if (env.error !== undefined && env.error !== null) out.error = env.error;
  if (env.hint !== undefined && env.hint !== null) out.hint = env.hint;
  process.stdout.write(JSON.stringify(out) + "\n");
}

/* ------------------------------------------------------------------ */
/* API resolution                                                      */
/* ------------------------------------------------------------------ */

let injectedApi: ServerApi | null = null;
export function setApiForTesting(api: ServerApi | null): void {
  injectedApi = api;
}
function getApi(): ServerApi {
  if (injectedApi) return injectedApi;
  const fromEnv = proxyServerApiFromEnv();
  if (fromEnv) return fromEnv;
  throw new CliError("no ServerApi available — ALOOK_PROXY_URL + ALOOK_PROXY_TOKEN_FILE must be set");
}

function agentId(opts: Record<string, unknown>): string {
  const id = (opts.agent as string) || process.env.ALOOK_AGENT_ID || process.env.ALOOK_ID;
  if (!id) throw new CliError("agent identity required — pass --agent <id> or set ALOOK_AGENT_ID");
  return id;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdMessageSend(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const channel = opts.target as string;
  if (!channel) throw new CliError("message send: --target <ref> is required (e.g. /demo-workspace/general)");

  let text: string | undefined;
  const fileFlag = opts.file as string | undefined;
  const textFlag = opts.text as string | undefined;
  if (fileFlag) {
    const fs = await import("fs");
    if (!fs.existsSync(fileFlag)) throw new CliError(`message send: file not found: ${fileFlag}`);
    text = fs.readFileSync(fileFlag, "utf8").trim();
  } else if (typeof textFlag === "string") {
    text = textFlag;
  }
  if (!text) {
    throw new CliError("message send: --text <text> or --file <path> is required");
  }

  const res = await api.send({ agentId: agent, channel, content: { text } });
  if (res.state === "blocked") {
    throw new CliError(
      `channel not aligned: ${res.unreadCount} unread message(s) in ${channel} (latest #${res.latestSeq}). ` +
        `Run \`alook inbox pull\` to align, then resend.`,
    );
  }
  return { sent: `${res.message.channel}${res.message.seq}` };
}

async function cmdInboxPull(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const max = opts.max ? Number(opts.max) : undefined;
  const { messages, hasMore } = await api.inboxPull({ agentId: agent, max });

  let acked = 0;
  if (opts.ack !== false && messages.length > 0) {
    const latest = new Map<string, Cursor>();
    for (const m of messages) {
      const seqN = Number(m.seq.replace("#", ""));
      const cur = latest.get(m.channel);
      if (!cur || seqN > cur.seq) latest.set(m.channel, { channel: m.channel, seq: seqN });
    }
    await api.ack({ agentId: agent, cursors: [...latest.values()] });
    acked = latest.size;
  }

  return { messages: messages as Message[], hasMore, acked };
}

async function cmdServerList(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const { servers } = await api.listServers({ agentId: agent });
  return { servers };
}

async function cmdServerMember(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const server = opts.server as string;
  if (!server) throw new CliError("server member: --server <name> is required");
  const { members } = await api.listMembers({ agentId: agent, server });
  return { members };
}

async function cmdServerJoin(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const raw = opts.invite as string;
  if (!raw) throw new CliError("server join: --invite <link> is required");
  const token = parseInviteToken(raw);
  if (!token) throw new CliError(`server join: could not find an invite token in "${raw}"`);
  const { server } = await api.joinServer({ agentId: agent, invite: token });
  return { server };
}

async function cmdChannelList(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const server = opts.server as string;
  if (!server) throw new CliError("channel list: --server <id-or-name> is required");
  const { channels } = await api.listChannels({ agentId: agent, server });
  return { channels };
}

async function cmdChannelHistory(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const channel = opts.channel as string;
  if (!channel) throw new CliError("channel history: --channel <ref> is required");
  const toSeq = (v: unknown): number | undefined => (v === undefined ? undefined : Number(v));
  const { items, hasMore, latestSeq } = await api.read({
    agentId: agent,
    channel,
    before: toSeq(opts.before),
    after: toSeq(opts.after),
    around: toSeq(opts.around),
    limit: toSeq(opts.limit),
  });
  return { items, hasMore, ...(latestSeq !== undefined ? { latestSeq } : {}) };
}

/* ------------------------------------------------------------------ */
/* Program definition                                                  */
/* ------------------------------------------------------------------ */

function buildProgram(): Command {
  const program = new Command("alook")
    .description("agent CLI")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    })
    .option("--agent <id>", "agent identity (or ALOOK_AGENT_ID env)");

  const message = program.command("message").description("message operations").exitOverride();
  message.configureOutput({ writeOut: () => {}, writeErr: () => {} });

  message
    .command("send")
    .description("send a message to a channel, DM, or thread")
    .option("--target <ref>", "destination (path-style ref, e.g. /demo-workspace/general)")
    .option("--text <text>", "inline message body (short messages)")
    .option("--file <path>", "read message body from a file (long messages)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdMessageSend({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  const inbox = program.command("inbox").description("inbox operations").exitOverride();
  inbox.configureOutput({ writeOut: () => {}, writeErr: () => {} });

  inbox
    .command("pull")
    .description("fetch unread messages from all channels")
    .option("--max <n>", "max messages to return")
    .option("--no-ack", "do not advance read waterlines (peek only)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdInboxPull({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  const server = program.command("server").description("server operations").exitOverride();
  server.configureOutput({ writeOut: () => {}, writeErr: () => {} });

  server
    .command("list")
    .description("list servers this agent is a member of")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdServerList({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  server
    .command("member")
    .description("list members of a server")
    .option("--server <id-or-name>", "server id or name (from `server list`)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdServerMember({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  server
    .command("join")
    .description("join a server via an invite link or token")
    .option("--invite <link>", "invite URL or bare token")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdServerJoin({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  const channel = program.command("channel").description("channel operations").exitOverride();
  channel.configureOutput({ writeOut: () => {}, writeErr: () => {} });

  channel
    .command("list")
    .description("list top-level channels visible to this agent in one server")
    .option("--server <id-or-name>", "server id or name (from `server list`)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdChannelList({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  channel
    .command("history")
    .description("fetch a page of messages from a channel, thread, or DM")
    .option("--channel <ref>", "channel/thread/DM ref (path-style)")
    .option("--before <seq>", "messages before this seq")
    .option("--after <seq>", "messages after this seq")
    .option("--around <seq>", "messages around this seq")
    .option("--limit <n>", "max messages to return")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdChannelHistory({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  const daemon = program.command("daemon").description("daemon operations").exitOverride();
  daemon.configureOutput({ writeOut: () => {}, writeErr: () => {} });

  daemon
    .command("start")
    .description("start the daemon (connects to server, manages agent lifecycles)")
    .requiredOption("--machine-key <key>", "machine key for server authentication")
    .option("--server-url <url>", "server HTTP URL (or ALOOK_SERVER_URL env)")
    .option("--ws-url <url>", "server WebSocket URL (or ALOOK_SERVER_WS_URL env)")
    .option("--base-dir <path>", "data directory for agent workspaces and pidfile (or ALOOK_DATA_DIR env)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      await daemonStart({
        machineKey: localOpts.machineKey as string,
        serverUrl: localOpts.serverUrl as string | undefined,
        wsUrl: localOpts.wsUrl as string | undefined,
        baseDir: localOpts.baseDir as string | undefined,
      });
    });

  daemon
    .command("stop")
    .description("stop the daemon for a specific machine key")
    .requiredOption("--machine-key <key>", "machine key identifying which daemon to stop")
    .option("--base-dir <path>", "data directory (or ALOOK_DATA_DIR env)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(function (this: Command) {
      const localOpts = this.opts();
      daemonStop({
        machineKey: localOpts.machineKey as string,
        baseDir: localOpts.baseDir as string | undefined,
      });
    });

  daemon
    .command("list")
    .description("list running daemons on this machine")
    .option("--base-dir <path>", "data directory (or ALOOK_DATA_DIR env)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(function (this: Command) {
      const localOpts = this.opts();
      const daemons = daemonList({ baseDir: localOpts.baseDir as string | undefined });
      printEnvelope({ success: { daemons } });
    });

  return program;
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.help") {
        // Help requested — find the relevant command and output its help text
        const helpText = getHelpText(program, argv);
        printEnvelope({ success: { usage: helpText } });
      } else if (err.code === "commander.unknownCommand") {
        printEnvelope({ error: `unknown command: ${argv.join(" ") || "(none)"}. Run \`alook help\`.` });
      } else {
        printEnvelope({ error: err.message });
      }
    } else if (err instanceof CliError) {
      printEnvelope({ error: err.message, hint: (err as { hint?: string }).hint });
    } else {
      printEnvelope({ error: (err as Error).message, hint: (err as { hint?: string }).hint });
    }
  }
  return 0;
}

function getHelpText(program: Command, argv: string[]): string {
  const args = argv.filter((a) => a !== "-h" && a !== "--help");
  let cmd: Command = program;
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    const sub = cmd.commands.find((c) => c.name() === arg);
    if (sub) cmd = sub;
    else break;
  }
  return cmd.helpInformation();
}

// Run when invoked directly (not when imported via test/vitest).
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /(?:^|[\\/])(?:cli[\\/]index\.[jt]s|alook)$/.test(process.argv[1]) &&
  !process.argv[1].includes("vitest") &&
  !process.argv[1].includes("node_modules");
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
