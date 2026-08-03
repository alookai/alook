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
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ServerApi, Cursor, Message } from "../server/contract.js";
import { parseRef } from "../server/contract.js";
import { proxyServerApiFromEnv } from "./proxyServerApi.js";
import { daemonStart, daemonStop, daemonList, daemonStatus, type DaemonInfo } from "./daemonStart.js";
import { parseInviteToken } from "@alook/shared/lib/invite-link";
import { MAX_EMOJI_BYTES } from "@alook/shared/constants/community";
import { nowLocalISO, toLocalISO } from "../util/localTime.js";

/**
 * Rewrite every message's UTC `.time` (server-stamped) into local-tz ISO with
 * offset, so the agent sees timestamps in its own timezone throughout the CLI
 * envelope. Server truth stays untouched — we only reformat at the boundary.
 */
function messagesInLocalTime(messages: Message[]): Message[] {
  return messages.map((m) => ({ ...m, time: toLocalISO(m.time) }));
}

/** The mandatory output envelope. Null/undefined fields are stripped on print. */
interface Envelope {
  success?: unknown;
  error?: string;
  hint?: string;
  /** Stable machine code carried up from an upstream error body (e.g.
   *  `already_friends`, `blocked`). Present only on the error envelope. */
  code?: string;
}

/** A command failure with a human-readable message destined for `error`. */
class CliError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

function printEnvelope(env: Envelope): void {
  const out: Record<string, unknown> = {};
  if (env.success !== undefined && env.success !== null) out.success = env.success;
  if (env.error !== undefined && env.error !== null) out.error = env.error;
  if (env.code !== undefined && env.code !== null) out.code = env.code;
  if (env.hint !== undefined && env.hint !== null) out.hint = env.hint;
  process.stdout.write(JSON.stringify(out) + "\n");
}

/** "just now (12s)" / "3m ago" / "2h ago" — human relative time from an ms epoch. */
function relTime(ms: number | null, nowMs: number): string {
  if (ms == null) return "—";
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `just now (${s}s)`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/**
 * Render `daemon list` as a human table (C2/C3). Columns: ID (pass to `daemon
 * stop <id>`), AGENTS + LAST ACTIVE (from the global status.json — accurate at
 * one-daemon-per-machine, a footnote flags the multi-daemon caveat, red line 5),
 * PID, STATE. NO machine key / hash prefix (credential stays out of human view).
 */
export function renderDaemonList(daemons: DaemonInfo[], nowMs: number = Date.now()): string {
  if (daemons.length === 0) return "No daemons running on this machine.";
  const header = ["ID", "AGENTS", "LAST ACTIVE", "PID", "STATE"];
  const rows = daemons.map((d) => [
    d.id,
    d.agents == null ? "—" : String(d.agents),
    relTime(d.lastActiveMs, nowMs),
    String(d.pid),
    d.alive ? "● running" : "○ dead",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const lines = [fmt(header), ...rows.map(fmt)];
  // Footnote the global-status caveat only when it could mislead (>1 daemon).
  if (daemons.length > 1) {
    lines.push("");
    lines.push("Note: AGENTS/LAST ACTIVE come from a per-machine snapshot; with multiple daemons they reflect the last writer, not each row.");
  }
  return lines.join("\n");
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

const TEXT_ESCAPE_MAP: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\" };

/**
 * Decode the standard backslash escapes an agent types into `--text`
 * (`\n`→newline, `\t`→tab, `\r`→CR, `\\`→one backslash). Single left-to-right
 * pass via one regex so `\\` is consumed as a unit BEFORE its following char —
 * sequential `.replace` calls would turn `\\n` (an escaped backslash + n) into
 * a newline, which is wrong. Unknown escapes (`\q`) and a trailing lone `\`
 * pass through unchanged (backslash kept) — conservative, never drops data.
 * Only applied to `--text`; `--file` content stays byte-literal.
 */
export function decodeTextEscapes(s: string): string {
  return s.replace(/\\(.)/g, (m, c: string) => TEXT_ESCAPE_MAP[c] ?? m);
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

const CLIENT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const CLIENT_ALLOWED_MIME_PREFIXES: readonly string[] = [
  "image/",
  "video/",
  "audio/",
  "text/",
  "application/pdf",
  "application/json",
  "application/zip",
  "application/octet-stream",
];

function mimeAllowed(contentType: string): boolean {
  if (!contentType) return false;
  return CLIENT_ALLOWED_MIME_PREFIXES.some((entry) =>
    entry.endsWith("/") ? contentType.startsWith(entry) : contentType === entry,
  );
}

/**
 * Guess a content-type from a filename extension. Kept trivial — the server
 * re-validates with its own MIME allowlist. Falls back to
 * `application/octet-stream` so an unknown extension still uploads.
 */
function contentTypeFromFilename(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "pdf": return "application/pdf";
    case "txt": case "md": case "log": return "text/plain";
    case "json": return "application/json";
    case "zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

/**
 * Is this a TRANSPORT-transient error worth retrying with the SAME nonce?
 *
 * Only true for "the request may or may not have reached/committed on the
 * server, but the RESPONSE was lost" shapes: an upstream 5xx wrapper, a body
 * that couldn't be read, or a network-level fetch failure. These are exactly
 * the errors behind the duplicate-send bug — the server often already
 * committed, so a same-nonce retry either gets the real response (fresh write)
 * or the deduped canonical (already-committed), never a second row.
 *
 * NOT transient (never retried here): business outcomes. `blocked`/unaligned is
 * a RETURN value (handled below, never thrown). 4xx business errors (bad
 * attachment, reply-not-found, forbidden) come back as thrown Errors with the
 * server's message and are deterministic — retrying would just re-fail.
 */
function isTransientSendError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /upstream returned 5\d\d/.test(msg) ||
    msg.includes("upstream body read failed") ||
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("socket hang up") ||
    msg.includes("network")
  );
}

/**
 * Send with a bounded, same-nonce internal retry (mutation-idempotency plan,
 * ② CLI). The `nonce` is generated ONCE by the caller and reused across every
 * attempt, so a "committed-but-response-lost" send is absorbed here — the
 * server dedupes on (author, nonce) and returns the canonical message — instead
 * of surfacing as an error the agent would naively re-run (creating a
 * duplicate). Only transient TRANSPORT errors are retried; business outcomes
 * (blocked return / thrown 4xx) pass straight through. Bounded so a genuinely
 * down gateway can't hang the agent: after the attempts are spent we throw the
 * real error and the agent's own rerun (with a fresh nonce) is then safe.
 */
async function sendWithRetry(
  api: ServerApi,
  req: Parameters<ServerApi["send"]>[0],
): Promise<Awaited<ReturnType<ServerApi["send"]>>> {
  const MAX_ATTEMPTS = 4;
  const BASE_DELAY_MS = 150;
  const MAX_DELAY_MS = 2000;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await api.send(req);
    } catch (err) {
      lastErr = err;
      if (!isTransientSendError(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
      // Deterministic-enough backoff; a small offset per attempt avoids a
      // thundering retry but doesn't need crypto randomness here.
      await new Promise((r) => setTimeout(r, cap));
    }
  }
  throw lastErr;
}

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
    // `--file` content is already-real bytes — never escape-decode it, or a
    // literal `\n` in a pasted code snippet / log would get corrupted.
    text = fs.readFileSync(fileFlag, "utf8").trim();
  } else if (typeof textFlag === "string") {
    // `--text` is a shell arg where agents naturally type `\n` for a newline;
    // decode the standard escapes so it doesn't land as a literal backslash-n.
    text = decodeTextEscapes(textFlag);
  }

  // `--attachment` may repeat. Commander wires this via `.option(..., collect, [])`
  // below; treat a missing flag as an empty list.
  const attachmentIds = Array.isArray(opts.attachment) ? (opts.attachment as string[]) : [];

  const hasText = typeof text === "string" && text.trim().length > 0;
  if (!hasText && attachmentIds.length === 0) {
    throw new CliError("message send: --text <text>, --file <path>, or --attachment <id> is required");
  }

  // `--reply` accepts the hash form the agent already sees in payloads (`"#37"`)
  // or a bare number; strip the leading `#` and require a positive integer.
  let replyToSeq: number | undefined;
  const replyFlag = opts.reply as string | number | undefined;
  if (replyFlag !== undefined && replyFlag !== "") {
    const raw = String(replyFlag).trim();
    const stripped = raw.startsWith("#") ? raw.slice(1) : raw;
    // Require a plain decimal seq. `Number("0x25")`/`Number("1e3")` would
    // otherwise coerce hex/exponential forms to a silently-wrong seq.
    const n = Number(stripped);
    if (!/^\d+$/.test(stripped) || !Number.isInteger(n) || n < 1) {
      throw new CliError('message send: --reply must be a message seq like "#37"');
    }
    replyToSeq = n;
  }

  // One idempotency nonce per logical send, reused across sendWithRetry's
  // internal attempts. A "committed-but-response-lost" 5xx is absorbed by the
  // same-nonce retry (server returns the canonical/deduped message) so the
  // agent never sees a false failure and never naively re-runs — the root of
  // the duplicate-send bug. A brand-new invocation gets a fresh nonce, so two
  // genuinely-distinct identical sends are never collapsed.
  const nonce = randomUUID();
  const res = await sendWithRetry(api, {
    agentId: agent,
    channel,
    content: { text: text ?? "" },
    attachments: attachmentIds.length > 0 ? attachmentIds : undefined,
    replyToSeq,
    nonce,
  });
  if (res.state === "blocked") {
    throw new CliError(
      `channel not aligned: ${res.unreadCount} unread message(s) in ${channel} (latest #${res.latestSeq}). ` +
        `Run \`alook inbox pull\` to align, then resend.`,
    );
  }
  // `deduped` (a same-nonce retry matched the already-committed message) is a
  // SUCCESS — the message is in the channel; surface its canonical ref exactly
  // like a fresh send, never as an error.
  return { sent: `${res.message.channel}${res.message.seq}` };
}

async function cmdMessageEmoji(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const target = opts.target as string;
  const emoji = opts.emoji as string;
  if (!target) throw new CliError("message emoji: --target <ref> is required (e.g. /demo/general#42)");
  if (!emoji) throw new CliError("message emoji: --emoji <string> is required");

  let parsed: ReturnType<typeof parseRef>;
  try {
    parsed = parseRef(target);
  } catch (err) {
    throw new CliError(`message emoji: ${(err as Error).message}`);
  }

  if (parsed.seq === undefined) {
    const err = new CliError(`message emoji needs a ref with a seq (e.g. ${target}#42)`);
    (err as { hint?: string }).hint =
      "pass --target /<server>/<channel>#N, /<server>/<channel>/#N#M for thread reply, or /.dm/<peer>#N";
    throw err;
  }
  if (Buffer.byteLength(emoji, "utf8") > MAX_EMOJI_BYTES) {
    const err = new CliError("emoji is too long");
    (err as { hint?: string }).hint = "use a single emoji, not a phrase";
    throw err;
  }

  // Rebuild the SCOPE ref (no pin-seq — that's passed separately as `seq`).
  // A forum-post target (`/server/forum/post#N`) must keep its childChannelName
  // so the reaction lands on the post, not its parent forum.
  const channel =
    parsed.childChannelName !== undefined
      ? `/${parsed.server}/${parsed.channel}/${parsed.childChannelName}`
      : parsed.threadRootSeq !== undefined
        ? `/${parsed.server}/${parsed.channel}/#${parsed.threadRootSeq}`
        : `/${parsed.server}/${parsed.channel}`;
  const res = await api.reactAdd({ channel, seq: parsed.seq, emoji });
  return { target, emoji, duplicate: res.duplicate === true };
}

async function cmdAttachmentUpload(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const target = opts.target as string;
  const filePath = opts.file as string;
  if (!target) throw new CliError("message attachment upload: --target <ref> is required");
  if (!filePath) throw new CliError("message attachment upload: --file <path> is required");

  const fs = await import("fs/promises");
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch (err) {
    throw new CliError(`message attachment upload: cannot read file: ${(err as Error).message}`);
  }
  if (bytes.byteLength > CLIENT_MAX_ATTACHMENT_BYTES) {
    throw new CliError(
      `message attachment upload: file too large — ${bytes.byteLength} bytes, max ${CLIENT_MAX_ATTACHMENT_BYTES}`,
    );
  }
  const pathMod = await import("path");
  const filename = pathMod.basename(filePath);
  const contentType = contentTypeFromFilename(filename);
  if (!mimeAllowed(contentType)) {
    throw new CliError(`message attachment upload: content type not allowed: ${contentType}`);
  }

  const result = await api.attachmentUpload({
    agentId: agent,
    target,
    file: { data: new Uint8Array(bytes), filename, contentType },
  });
  return result;
}

async function cmdAttachmentDownload(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const id = opts.id as string;
  if (!id) throw new CliError("message attachment download: --id <id> is required");

  const outFlag = opts.out as string | undefined;
  const os = await import("os");
  const pathMod = await import("path");
  const destPath = outFlag ?? pathMod.join(os.tmpdir(), "alook-attachments", agent, id, "file");

  const result = await api.attachmentDownload({ agentId: agent, id, destPath });
  if (!outFlag) {
    const fs = await import("fs/promises");
    const destDir = pathMod.dirname(destPath);
    // The server-supplied filename is untrusted: another user's attachment
    // could be named `../../etc/foo`. `path.basename` collapses any path
    // separators / traversal segments so the rename target stays inside
    // `destDir`.
    const safeName = pathMod.basename(result.filename) || "file";
    const renamed = pathMod.join(destDir, safeName);
    if (renamed !== destPath) {
      try {
        await fs.rename(destPath, renamed);
        return { ...result, path: renamed };
      } catch {
        return { ...result, path: destPath };
      }
    }
  }
  return result;
}

async function cmdInboxPull(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const max = opts.max ? Number(opts.max) : undefined;
  const { messages, hasMore } = await api.inboxPull({ agentId: agent, max });
  const pulledAt = nowLocalISO();

  let acked = 0;
  let ackError: string | undefined;
  if (opts.ack !== false && messages.length > 0) {
    const latest = new Map<string, Cursor>();
    for (const m of messages) {
      const seqN = Number(m.seq.replace("#", ""));
      const cur = latest.get(m.channel);
      if (!cur || seqN > cur.seq) latest.set(m.channel, { channel: m.channel, seq: seqN });
    }
    try {
      await api.ack({ agentId: agent, cursors: [...latest.values()] });
      acked = latest.size;
    } catch (err) {
      // Do NOT rethrow: the pull already succeeded, and if ack fails on a
      // single scope (e.g. a stale visibility mismatch) the whole envelope
      // would otherwise collapse to a bare error, wiping the messages the
      // agent needs. Surface the ack failure separately so the agent (or a
      // human debugging) sees BOTH the delivered messages AND that the
      // waterline didn't move.
      ackError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    messages: messagesInLocalTime(messages),
    hasMore,
    acked,
    pulledAt,
    ...(ackError ? { ackError } : {}),
  };
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
  return await api.listChannels({ agentId: agent, server });
}

async function cmdChannelMember(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const channel = opts.channel as string;
  if (!channel) throw new CliError("channel member: --channel <ref> is required");
  return await api.channelMember({ agentId: agent, channel });
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
  return { items: messagesInLocalTime(items), hasMore, ...(latestSeq !== undefined ? { latestSeq } : {}) };
}

async function cmdFriendRequest(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const username = opts.username as string;
  if (!username) throw new CliError("friend request: --username <name#0042> is required");
  // Pass the envelope through verbatim — the discriminated union
  // (`{ status: 'pending', hint }` | `{ status: 'accepted', hint: null }`) is
  // the agent-facing contract; do not collapse `hint: null`.
  return await api.friendRequest({ agentId: agent, username });
}

async function cmdFriendList(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  return await api.listFriends({ agentId: agent });
}

async function cmdNap(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const fileFlag = opts.handoff as string | undefined;
  const textFlag = opts.text as string | undefined;
  let handoff: string | undefined;
  if (fileFlag) {
    const fs = await import("fs");
    if (!fs.existsSync(fileFlag)) throw new CliError(`nap: handoff file not found: ${fileFlag}`);
    handoff = fs.readFileSync(fileFlag, "utf8").trim();
  } else if (typeof textFlag === "string") {
    handoff = decodeTextEscapes(textFlag).trim();
  }
  if (!handoff) {
    throw new CliError("nap: a handoff is required — pass --handoff <file> or --text <note>");
  }
  return await api.nap({ handoff });
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
    .option(
      "-a, --attachment <id>",
      "attach an uploaded file by id (repeatable — order = message order)",
      (v, prev: string[] = []) => [...prev, v],
      [] as string[],
    )
    .option("--reply <seq>", 'reply to a message by its seq in --target (e.g. "#37" or 37)')
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdMessageSend({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  message
    .command("emoji")
    .description("react to a message with a single emoji")
    .requiredOption("--target <ref>", "message ref (path-style, e.g. /demo/general#42 or /.dm/peer#7)")
    .requiredOption("--emoji <string>", "single emoji character")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdMessageEmoji({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  const attachment = message.command("attachment").description("attachment operations").exitOverride();
  attachment.configureOutput({ writeOut: () => {}, writeErr: () => {} });

  attachment
    .command("upload")
    .description("upload a local file as a pending attachment for a future send")
    .option("--target <ref>", "destination (channel, DM, or thread ref)")
    .option("--file <path>", "local file to upload")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdAttachmentUpload({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  attachment
    .command("download")
    .description("download an attachment by id to disk")
    .option("--id <id>", "attachment id (from inbox pull / send response)")
    .option("--out <path>", "explicit output path (default: /tmp/alook-attachments/<agent>/<id>/<filename>)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdAttachmentDownload({ ...globalOpts, ...localOpts });
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

  channel
    .command("member")
    .description("fetch the followed members of a channel or thread; public channels return a hint pointing at `alook server member`")
    .option("--channel <ref>", "channel/thread ref (path-style)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdChannelMember({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  const friend = program.command("friend").description("friend operations").exitOverride();
  friend.configureOutput({ writeOut: () => {}, writeErr: () => {} });

  friend
    .command("request")
    .description("send a friend request to a user by handle (owner-approval required)")
    .option("--username <name#0042>", "the target's global handle, e.g. Alice#0042")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdFriendRequest({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  friend
    .command("list")
    .description("list your friends and pending requests (accepted, pendingOutgoing, pendingIncoming)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdFriendList({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  program
    .command("nap")
    .description("end your session and start fresh, carrying a handoff to your reborn self (read the nap rule first)")
    .option("--handoff <file>", "path to your handoff note (your note to your reborn self)")
    .option("--text <note>", "inline handoff note (alternative to --handoff)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdNap({ ...globalOpts, ...localOpts });
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
    .argument("[id]", "daemon id from `alook daemon list` (the ID column)")
    .description("stop a daemon by its id (from `alook daemon list`)")
    .option("--machine-key <key>", "legacy: identify the daemon by full machine key instead of id")
    .option("--base-dir <path>", "data directory (or ALOOK_DATA_DIR env)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command, id: string | undefined) {
      const localOpts = this.opts();
      await daemonStop({
        id,
        machineKey: localOpts.machineKey as string | undefined,
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
      // `daemon list` is for a HUMAN operator — print a table, not JSON (the
      // agent-facing commands keep their JSON envelope). The ID column is what
      // you pass to `daemon stop <id>`.
      process.stdout.write(renderDaemonList(daemons) + "\n");
    });

  daemon
    .command("status")
    .description("dump each agent's current FSM state from the daemon's status snapshot")
    .option("--base-dir <path>", "data directory (or ALOOK_DATA_DIR env)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(function (this: Command) {
      const localOpts = this.opts();
      const status = daemonStatus({ baseDir: localOpts.baseDir as string | undefined });
      // ALWAYS surface freshness — a stale snapshot must never read as live
      // truth (the "state unsynced" blind spot this feature kills). The reader
      // gets the raw fields + an explicit freshness verdict + snapshot age.
      printEnvelope({ success: { status } });
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
      // Upstream API errors (thrown by proxyServerApi) may carry a stable
      // `.code` and `.hint` — surface both so agent prompts can discriminate.
      printEnvelope({
        error: (err as Error).message,
        code: (err as { code?: string }).code,
        hint: (err as { hint?: string }).hint,
      });
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

let isMainModule = false;
try {
  if (typeof process !== "undefined" && process.argv[1]) {
    isMainModule =
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  }
} catch {
  // Any realpath failure (argv[1] not a real file — worker threads, `node --eval`,
  // exotic sandboxes; or EACCES/EIO/ELOOP on a real path) falls through to not-main.
}

if (isMainModule) {
  main().then((code) => process.exit(code));
}
