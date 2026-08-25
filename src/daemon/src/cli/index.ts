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
import type { ServerApi, Cursor, Message, AckFailure } from "../server/contract.js";
import { parseRef } from "../server/contract.js";
import { proxyServerApiFromEnv } from "./proxyServerApi.js";
import { daemonReconnect, daemonResume, daemonRunFromIpc, daemonStart, daemonStartById, daemonStop, daemonList, daemonStatus, type DaemonInfo } from "./daemonStart.js";
import { daemonReplace } from "./daemonUpdate.js";
import { armMessageReminderFromEnv, parseRemindAfter } from "./messageReminderClient.js";
import { parseInviteToken } from "@alook/shared/lib/invite-link";
import {
  ALLOWED_ICON_MIME_TYPES,
  MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES,
  MAX_EMOJI_BYTES,
  MAX_PROFILE_ABOUT_LENGTH,
  MAX_SERVER_ICON_SIZE_BYTES,
} from "@alook/shared/constants/community";
import { nowLocalISO, toLocalISO } from "../util/localTime.js";
import { MESSAGE_SEND_STDIN_POLICY } from "../drivers/systemPrompt.js";

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
 * stop <id>`), AGENTS (`running/total` — how many manager-owned sessions are
 * live vs total bots bound to the machine), LAST ACTIVE, PID, STATE. Data is
 * per-daemon since C0 (each row reads its own daemon's status.json), so no
 * multi-daemon caveat.
 * NO machine key / hash prefix (credential stays out of human view, red line 2).
 */
export function renderDaemonList(daemons: DaemonInfo[], nowMs: number = Date.now()): string {
  if (daemons.length === 0) return "No daemons running on this machine.";
  const header = ["ID", "AGENTS", "LAST ACTIVE", "PID", "STATE"];
  const rows = daemons.map((d) => [
    d.id,
    // `running/total`: e.g. "2/8" = 2 live, 8 bound. "—" if no snapshot.
    d.agents == null ? "—" : `${d.running ?? 0}/${d.agents}`,
    relTime(d.lastActiveMs, nowMs),
    String(d.pid),
    d.alive ? "● running" : "○ dead",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [fmt(header), ...rows.map(fmt)].join("\n");
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

export interface CliInputStream extends AsyncIterable<string | Uint8Array> {
  isTTY?: boolean;
}

export interface CliIo {
  stdin?: CliInputStream;
}

/**
 * Read a free-form UTF-8 value without putting it in argv. `--stdin` is always
 * explicit so an omitted body can never hang waiting for an interactive
 * terminal. Both sources are byte-literal: validation may inspect `trim()`,
 * but the value returned to the caller is never decoded, trimmed, or rewritten.
 */
async function readLiteralInput(args: {
  command: string;
  stdinSelected: boolean;
  stdin?: CliInputStream;
  filePath?: string;
  fileOption?: string;
}): Promise<string | undefined> {
  const { command, stdinSelected, stdin, filePath, fileOption } = args;
  if (stdinSelected && filePath !== undefined) {
    throw new CliError(`${command}: --stdin and ${fileOption} are mutually exclusive`);
  }

  if (stdinSelected) {
    if (!stdin) throw new CliError(`${command}: stdin is unavailable`);
    if (stdin.isTTY === true) {
      const suffix = fileOption ? `; use ${fileOption} in an interactive terminal` : "";
      throw new CliError(`${command}: --stdin requires piped input${suffix}`);
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of stdin) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch (err) {
      throw new CliError(`${command}: cannot read stdin: ${(err as Error).message}`);
    }
  }

  if (filePath !== undefined) {
    const fs = await import("fs/promises");
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (err) {
      throw new CliError(`${command}: cannot read file: ${(err as Error).message}`);
    }
  }

  return undefined;
}

const MALFORMED_ALOOK_HEREDOC_TAIL =
  /(^|\r?\n)(?:["']ALOOK_MESSAGE_[A-Z0-9_]+["']?|ALOOK_MESSAGE_[A-Z0-9_]+["'])(?:\r?\n)?$/;

function stripMalformedAlookHeredocTail(input: string): string {
  return input.replace(MALFORMED_ALOOK_HEREDOC_TAIL, "$1");
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

const CLIENT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const CLIENT_MAX_MESSAGE_BODY_BYTES = 1024;

/**
 * Guess a content-type from a filename extension. Kept trivial — the server
 * stores MIME as descriptive metadata. Falls back to `application/octet-stream`
 * for unknown extensions.
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
    case "html": case "htm": return "text/html";
    case "txt": case "md": case "log": return "text/plain";
    case "json": return "application/json";
    case "zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

/**
 * Is this a transport-transient mutation error worth retrying?
 *
 * Only true for "the request may or may not have reached/committed on the
 * server, but the RESPONSE was lost" shapes: an upstream 5xx wrapper, a body
 * that couldn't be read, or a network-level fetch failure. Callers must make a
 * committed-but-response-lost retry safe: sends/posts reuse one nonce, while
 * mark set/remove are database-idempotent.
 *
 * NOT transient (never retried here): business outcomes. `blocked`/unaligned is
 * a RETURN value (handled below, never thrown). 4xx business errors (bad
 * attachment, reply-not-found, forbidden) come back as thrown Errors with the
 * server's message and are deterministic — retrying would just re-fail.
 */
function isTransientMutationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status = typeof err === "object" && err !== null && "status" in err
    ? (err as { status?: unknown }).status
    : undefined;
  return (
    (typeof status === "number" && status >= 500 && status <= 599) ||
    /upstream returned 5\d\d/.test(msg) ||
    msg.includes("upstream body read failed") ||
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("socket hang up") ||
    msg.includes("network")
  );
}

async function withTransientMutationRetry<T>(mutation: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 4;
  const BASE_DELAY_MS = 150;
  const MAX_DELAY_MS = 2000;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await mutation();
    } catch (err) {
      lastErr = err;
      if (!isTransientMutationError(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, cap));
    }
  }
  throw lastErr;
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
  return withTransientMutationRetry(() => api.send(req));
}

async function cmdMessageSend(opts: Record<string, unknown>, stdin: CliInputStream): Promise<unknown> {
  // Commander enforces presence via requiredOption. Validate the full duration
  // before any server mutation so a bad value can never send a message first.
  const remindAfterFlag = opts.remindAfter as string;
  const remindAfterMs = parseRemindAfter(remindAfterFlag);
  const api = getApi();
  const agent = agentId(opts);
  const channel = opts.target as string;
  if (!channel) throw new CliError("message send: --target <ref> is required (e.g. /demo-workspace#1234/general)");

  const literalText = await readLiteralInput({
    command: "message send",
    stdinSelected: opts.stdin === true,
    stdin,
  });
  const text = stripMalformedAlookHeredocTail(literalText ?? "");
  const textBytes = Buffer.byteLength(text, "utf8");
  if (textBytes > CLIENT_MAX_MESSAGE_BODY_BYTES) {
    throw new CliError(
      `message send: --stdin body is ${textBytes} bytes; max ${CLIENT_MAX_MESSAGE_BODY_BYTES}. ` +
      `Rewrite it before retrying.\n\n${MESSAGE_SEND_STDIN_POLICY}`,
    );
  }

  // `--attachment` may repeat. Commander wires this via `.option(..., collect, [])`
  // below; treat a missing flag as an empty list.
  const attachmentIds = Array.isArray(opts.attachment) ? (opts.attachment as string[]) : [];

  const hasText = text.trim().length > 0;
  if (!hasText && attachmentIds.length === 0) {
    throw new CliError("message send: --stdin must contain text unless --attachment <id> is present");
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
        `Run \`alook inbox pull\` and READ the new messages before deciding whether to resend, ` +
        `adjust, or skip your message.`,
    );
  }
  // `deduped` (a same-nonce retry matched the already-committed message) is a
  // SUCCESS — the message is in the channel; surface its canonical ref exactly
  // like a fresh send, never as an error.
  const sent = `${res.message.channel}${res.message.seq}`;
  const seqText = res.message.seq.replace(/^#/, "");
  const sentSeq = Number(seqText);
  if (!/^\d+$/.test(seqText) || !Number.isSafeInteger(sentSeq) || sentSeq < 1) {
    return { sent, reminder: { armed: false, reason: "server returned an invalid canonical message seq" } };
  }
  try {
    const reminder = await armMessageReminderFromEnv({
      channel: res.message.channel,
      sentSeq,
      remindAfterMs,
    });
    return { sent, reminder };
  } catch {
    // The send is already committed. Never turn a local arming problem into a
    // command error that invites the agent to re-run and duplicate the send.
    return { sent, reminder: { armed: false, reason: "local reminder request failed" } };
  }
}

async function cmdMessageEmoji(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const target = opts.target as string;
  const emoji = opts.emoji as string;
  if (!target) throw new CliError("message emoji: --target <ref> is required (e.g. /demo#1234/general#42)");
  if (!emoji) throw new CliError("message emoji: --emoji <string> is required");

  const { channel, seq } = parseMessageTarget("message emoji", target);

  if (Buffer.byteLength(emoji, "utf8") > MAX_EMOJI_BYTES) {
    const err = new CliError("emoji is too long");
    (err as { hint?: string }).hint = "use a single emoji, not a phrase";
    throw err;
  }

  const res = await api.reactAdd({ channel, seq, emoji });
  return { target, emoji, duplicate: res.duplicate === true };
}

function parseMessageTarget(command: string, target: string): { channel: string; seq: number } {

  let parsed: ReturnType<typeof parseRef>;
  try {
    parsed = parseRef(target);
  } catch (err) {
    throw new CliError(`${command}: ${(err as Error).message}`);
  }

  if (parsed.seq === undefined) {
    const err = new CliError(`${command} needs a ref with a seq (e.g. ${target}#42)`);
    (err as { hint?: string }).hint =
      "pass --target /<server>/<channel>#N, /<server>/<channel>/#N#M for thread reply, or /.dm/<peer>#N";
    throw err;
  }

  const channel =
    parsed.threadRootSeq !== undefined
      ? `/${parsed.server}/${parsed.channel}/#${parsed.threadRootSeq}`
      : `/${parsed.server}/${parsed.channel}`;
  return { channel, seq: parsed.seq };
}

async function cmdMessageMarkSet(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const target = opts.target as string;
  if (!target) throw new CliError("message mark set: --target <ref> is required");
  const request = parseMessageTarget("message mark set", target);
  await withTransientMutationRetry(() => api.markSet(request));
  return { target, marked: true };
}

async function cmdMessageMarkRemove(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const target = opts.target as string;
  if (!target) throw new CliError("message mark remove: --target <ref> is required");
  const request = parseMessageTarget("message mark remove", target);
  await withTransientMutationRetry(() => api.markRemove(request));
  return { target, marked: false };
}

async function cmdMessageMarkList(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const { marked } = await api.listMarks({ agentId: agentId(opts) });
  return { marked: messagesInLocalTime(marked) };
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

  let thumbnail: { data: Uint8Array; filename: string; contentType: string } | undefined;
  let width: number | undefined;
  let height: number | undefined;
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType)) {
    try {
      const { default: sharp } = await import("sharp");
      const image = sharp(bytes, { failOn: "error" });
      const metadata = await image.metadata();
      if (metadata.width && metadata.height) {
        width = metadata.width;
        height = metadata.height;
      }
      const jpeg = await image
        .resize({ width: 200, height: 200, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      if (jpeg.byteLength <= MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES) {
        thumbnail = {
          data: new Uint8Array(jpeg),
          filename: "thumbnail.jpg",
          contentType: "image/jpeg",
        };
      }
    } catch {
      // Thumbnailing is an optimization. Corrupt/unsupported images still upload.
    }
  }

  const result = await api.attachmentUpload({
    agentId: agent,
    target,
    file: { data: new Uint8Array(bytes), filename, contentType },
    ...(thumbnail ? { thumbnail } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
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

async function cmdSettingProfile(opts: Record<string, unknown>): Promise<unknown> {
  const bio = opts.setBio as string | undefined;
  const avatarPath = opts.setAvatar as string | undefined;
  if (bio === undefined && avatarPath === undefined) {
    throw new CliError("setting profile: --set-bio <text> or --set-avatar <path> is required");
  }
  if (bio !== undefined && bio.length > MAX_PROFILE_ABOUT_LENGTH) {
    throw new CliError(`setting profile: bio must be ≤ ${MAX_PROFILE_ABOUT_LENGTH} characters`);
  }

  let avatar: { filename: string; contentType: string; data: Uint8Array } | undefined;
  if (avatarPath !== undefined) {
    const fs = await import("fs/promises");
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(avatarPath);
    } catch (err) {
      throw new CliError(`setting profile: cannot read avatar: ${(err as Error).message}`);
    }
    if (bytes.byteLength === 0) throw new CliError("setting profile: avatar file is empty");
    if (bytes.byteLength > MAX_SERVER_ICON_SIZE_BYTES) {
      throw new CliError(
        `setting profile: avatar too large — ${bytes.byteLength} bytes, max ${MAX_SERVER_ICON_SIZE_BYTES}`,
      );
    }
    const pathMod = await import("path");
    const filename = pathMod.basename(avatarPath);
    const contentType = contentTypeFromFilename(filename);
    if (!(ALLOWED_ICON_MIME_TYPES as readonly string[]).includes(contentType)) {
      throw new CliError("setting profile: avatar must be png / jpeg / webp / gif");
    }
    avatar = { filename, contentType, data: new Uint8Array(bytes) };
  }

  const api = getApi();
  // updateProfile owns per-step retries so a successful avatar is never
  // replayed merely because the following bio step failed transiently.
  return api.updateProfile({
    ...(bio !== undefined ? { bio } : {}),
    ...(avatar ? { avatar } : {}),
  });
}

async function cmdInboxPull(opts: Record<string, unknown>): Promise<unknown> {
  const api = getApi();
  const agent = agentId(opts);
  const max = opts.max ? Number(opts.max) : undefined;
  const { messages, hasMore, markedCount } = await api.inboxPull({ agentId: agent, max });
  const pulledAt = nowLocalISO();

  let acked = 0;
  let ackError: string | undefined;
  let failed: AckFailure[] | undefined;
  if (opts.ack !== false && messages.length > 0) {
    const latest = new Map<string, Cursor>();
    for (const m of messages) {
      const seqN = Number(m.seq.replace("#", ""));
      const cur = latest.get(m.channel);
      if (!cur || seqN > cur.seq) latest.set(m.channel, { channel: m.channel, seq: seqN });
    }
    try {
      const result = await api.ack({ agentId: agent, cursors: [...latest.values()] });
      acked = result.applied.length;
      failed = result.failed;
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
    ...(failed ? { failed } : {}),
    ...(ackError ? { ackError } : {}),
    ...(markedCount > 0
      ? {
          markedReminder: `You have ${markedCount} marked ${markedCount === 1 ? "message" : "messages"}. Resolve ${markedCount === 1 ? "it" : "them"} before going dark unless blocked.`,
        }
      : {}),
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
  if (!server) throw new CliError("server member: --server <name#discriminator> is required");
  let limit: number | undefined;
  if (opts.limit !== undefined) {
    limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new CliError("server member: --limit must be a positive integer");
    }
  }
  const cursor = opts.cursor as string | undefined;
  const { members, cursor: nextCursor, hasMore } = await api.listMembers({
    agentId: agent,
    server,
    limit,
    cursor,
  });
  return { members, cursor: nextCursor, hasMore };
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
  if (!server) throw new CliError("channel list: --server <name#discriminator> is required");
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
  const handoff = await readLiteralInput({
    command: "nap",
    stdinSelected: false,
    filePath: fileFlag,
    fileOption: "--handoff <file>",
  });
  if (handoff === undefined || handoff.trim().length === 0) {
    throw new CliError("nap: a handoff is required — pass --handoff <file>");
  }
  return await api.nap({ handoff });
}

/* ------------------------------------------------------------------ */
/* Program definition                                                  */
/* ------------------------------------------------------------------ */

function buildProgram(stdin: CliInputStream): Command {
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
    .option("--target <ref>", "destination (path-style ref, e.g. /demo-workspace#1234/general)")
    .requiredOption("--stdin", "read the required UTF-8 message body from non-TTY stdin (max 1 KiB)")
    .option(
      "-a, --attachment <id>",
      "attach an uploaded file by id (repeatable — order = message order)",
      (v, prev: string[] = []) => [...prev, v],
      [] as string[],
    )
    .option("--reply <seq>", 'reply to a message by its seq in --target (e.g. "#37" or 37)')
    .requiredOption(
      "--remind-after <0|Nm|Nh>",
      "required idle follow-up: 0 disables; 1m..24h arms/resets one same-scope timer; a newer message or daemon restart cancels it",
    )
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdMessageSend({ ...globalOpts, ...localOpts }, stdin);
      printEnvelope({ success: result });
    });

  message
    .command("emoji")
    .description("react to a message with a single emoji")
    .requiredOption("--target <ref>", "message ref (path-style, e.g. /demo#1234/general#42 or /.dm/peer#0007#42)")
    .requiredOption("--emoji <string>", "single emoji character")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const globalOpts = program.opts();
      const result = await cmdMessageEmoji({ ...globalOpts, ...localOpts });
      printEnvelope({ success: result });
    });

  const mark = message.command("mark").description("durable message mark operations").exitOverride();
  mark.configureOutput({ writeOut: () => {}, writeErr: () => {} });

  mark
    .command("set")
    .description("mark a message as outstanding work")
    .requiredOption("--target <ref>", "full message ref")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const result = await cmdMessageMarkSet({ ...program.opts(), ...this.opts() });
      printEnvelope({ success: result });
    });

  mark
    .command("remove")
    .description("remove an outstanding-work mark")
    .requiredOption("--target <ref>", "full message ref")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const result = await cmdMessageMarkRemove({ ...program.opts(), ...this.opts() });
      printEnvelope({ success: result });
    });

  mark
    .command("list")
    .description("list all currently visible marked messages")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const result = await cmdMessageMarkList({ ...program.opts(), ...this.opts() });
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
    .description("list members of a server (paginated; each member carries online + status)")
    .option("--server <handle>", "server name#discriminator handle (from `server list`)")
    .option("--limit <n>", "max members per page")
    .option("--cursor <cursor>", "opaque cursor from a prior page's response (omit for the first page)")
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
    .option("--server <handle>", "server name#discriminator handle (from `server list`)")
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

  const setting = program.command("setting").description("account settings").exitOverride();
  setting.configureOutput({ writeOut: () => {}, writeErr: () => {} });

  setting
    .command("profile")
    .description("update your public bio and/or avatar")
    .option("--set-bio <text>", "set public bio; pass an empty string to clear it")
    .option("--set-avatar <path>", "upload a png, jpeg, webp, or gif avatar")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const result = await cmdSettingProfile({ ...program.opts(), ...this.opts() });
      printEnvelope({ success: result });
    });

  program
    .command("nap")
    .description("end your session and start fresh, carrying a handoff to your reborn self (read the nap rule first)")
    .option("--handoff <file>", "path to your handoff note (your note to your reborn self)")
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
    .option("--machine-key <key>", "machine key for first-time pairing")
    .option("--id <machineId>", "restart a previously paired machine by id")
    .option("--server-url <url>", "server HTTP URL (or ALOOK_SERVER_URL; defaults to production)")
    .option("--ws-url <url>", "server WebSocket URL (or ALOOK_SERVER_WS_URL; defaults to production)")
    .option("--base-dir <path>", "data directory for agent workspaces and pidfile (or ALOOK_DATA_DIR env)")
    .option("--foreground", "run in the current process and tee daemon logs to the terminal")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      const machineKey = localOpts.machineKey as string | undefined;
      const id = localOpts.id as string | undefined;
      if ((!machineKey && !id) || (machineKey && id)) {
        throw new CliError("daemon start requires exactly one of --machine-key <key> or --id <machineId>");
      }
      if (id) {
        await daemonStartById({
          id,
          baseDir: localOpts.baseDir as string | undefined,
          foreground: localOpts.foreground === true,
        });
        return;
      }
      await daemonStart({
        machineKey: machineKey!,
        serverUrl: localOpts.serverUrl as string | undefined,
        wsUrl: localOpts.wsUrl as string | undefined,
        baseDir: localOpts.baseDir as string | undefined,
        foreground: localOpts.foreground === true,
      });
    });

  daemon
    .command("run", { hidden: true })
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async () => {
      await daemonRunFromIpc();
    });

  daemon
    .command("reconnect")
    .description("rotate and reconnect one previously paired machine")
    .requiredOption("--id <machineId>", "machine id shown by daemon list")
    .requiredOption("--machine-key <key>", "cmt_ reconnect token")
    .option("--server-url <url>", "server HTTP URL (defaults to the saved launch record)")
    .option("--ws-url <url>", "server WebSocket URL (defaults to the saved launch record)")
    .option("--base-dir <path>", "data directory for agent workspaces and pidfile")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      await daemonReconnect({
        id: localOpts.id as string,
        machineKey: localOpts.machineKey as string,
        serverUrl: localOpts.serverUrl as string | undefined,
        wsUrl: localOpts.wsUrl as string | undefined,
        baseDir: localOpts.baseDir as string | undefined,
      });
    });

  daemon
    .command("resume", { hidden: true })
    .requiredOption("--id <machineId>")
    .requiredOption("--base-dir <path>")
    .requiredOption("--request-id <id>")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      await daemonResume({
        id: localOpts.id as string,
        baseDir: localOpts.baseDir as string,
        requestId: localOpts.requestId as string,
      });
    });

  daemon
    .command("replace", { hidden: true })
    .requiredOption("--id <machineId>")
    .requiredOption("--base-dir <path>")
    .requiredOption("--request-id <id>")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const localOpts = this.opts();
      await daemonReplace({
        id: localOpts.id as string,
        baseDir: localOpts.baseDir as string,
        requestId: localOpts.requestId as string,
      });
    });

  daemon
    .command("stop")
    .argument("<id>", "daemon id from `alook daemon list` (the ID column)")
    .description("stop a daemon by its id (from `alook daemon list`)")
    .option("--base-dir <path>", "data directory (or ALOOK_DATA_DIR env)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command, id: string) {
      const localOpts = this.opts();
      await daemonStop({
        id,
        baseDir: localOpts.baseDir as string | undefined,
      });
    });

  daemon
    .command("list")
    .description("list running daemons on this machine")
    .option("--base-dir <path>", "data directory (or ALOOK_DATA_DIR env)")
    .option("--json", "print a machine-readable JSON envelope")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(function (this: Command) {
      const localOpts = this.opts();
      const daemons = daemonList({ baseDir: localOpts.baseDir as string | undefined });
      if (localOpts.json === true) {
        printEnvelope({ success: { daemons } });
        return;
      }
      // `daemon list` is for a HUMAN operator — print a table, not JSON (the
      // agent-facing commands keep their JSON envelope). The ID column is what
      // you pass to `daemon stop <id>`.
      process.stdout.write(renderDaemonList(daemons) + "\n");
    });

  daemon
    .command("status")
    .argument("[id]", "daemon id from `alook daemon list` (omit if only one daemon)")
    .description("dump each agent's current FSM state from a daemon's status snapshot")
    .option("--base-dir <path>", "data directory (or ALOOK_DATA_DIR env)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(function (this: Command, id: string | undefined) {
      const localOpts = this.opts();
      const status = daemonStatus({ id, baseDir: localOpts.baseDir as string | undefined });
      // Multiple daemons + no id → ambiguous: tell the reader which id to pass
      // (status is per-daemon since C0, so it can't guess which one).
      if (status.ambiguous) {
        printEnvelope({
          error: "multiple daemons on this machine — pass an id: `alook daemon status <id>`",
          hint: `available ids: ${(status.availableIds ?? []).join(", ")} (see \`alook daemon list\`)`,
        });
        return;
      }
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

export async function main(argv = process.argv.slice(2), io: CliIo = {}): Promise<number> {
  const stdin = io.stdin ?? (process.stdin as CliInputStream);
  const program = buildProgram(stdin);
  let internalExitCode = 0;
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.help") {
        // `-h`/`--help` is a HUMAN reading usage in a terminal — print the plain
        // commander usage text, NOT the agent JSON envelope. Help is the one
        // path that's human-facing; every other outcome (success results,
        // errors, unknownCommand) stays a one-JSON-line envelope for agents to
        // consume. (Gus 架构#473: -h wrongly returned `{"success":{"usage":…}}`.)
        process.stdout.write(getHelpText(program, argv) + "\n");
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
    // Public agent-facing commands keep their JSON-only result contract. The
    // two hidden replacement primitives additionally need a process status so
    // the parent helper can distinguish ready from bounded rollback failure.
    if (argv[0] === "daemon" && (argv[1] === "resume" || argv[1] === "replace")) {
      internalExitCode = 1;
    }
  }
  return internalExitCode;
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
