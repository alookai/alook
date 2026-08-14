/**
 * Credential proxy — zero-trust credential isolation for spawned agents.
 *
 * THE PROBLEM. A runtime child process (Claude, Codex, …) needs *some* credential
 * to call back to the server ("I am agent X, send this message"). The naive way is
 * to hand the child the real API key in an env var — but then the agent process
 * (and any code/tool it runs) can read the real key, use it for anything, can't be
 * scoped down, and a leak forces a key rotation. So `cliTransport` does NOT do
 * that: it requires this proxy and gives the child only a voucher.
 *
 * THE FIX (vouchers, not cash). The host never gives the child the real key.
 * Instead:
 *
 *   1. A local HTTP proxy listens on `127.0.0.1:<port>` (loopback only).
 *   2. For each agent launch, the broker mints a short-lived **voucher** —
 *      `vch_` + random — written to a per-launch 0600 file, BOUND to that agent's
 *      tier-2 **runner key**. The child is given the proxy URL, the voucher file
 *      path, and its capability set. **No real key ever enters the child's env.**
 *   3. The child's CLI calls the proxy with `Authorization: Bearer vch_…`.
 *   4. The proxy validates the voucher, then **swaps the header for that voucher's
 *      runner key** (`Authorization: Bearer <reg.runnerKey>`), stamps identity/
 *      capability headers (`X-Agent-Id`, `X-Client`, `X-Agent-Active-Capabilities`),
 *      and forwards to the host-supplied upstream.
 *
 * Three-tier model: machine master key → per-agent **runner key** (tier 2, minted
 * by the server's enrollment from the daemon's machine key) → `vch_` voucher
 * (tier 3, this broker). The broker stores the runner key PER VOUCHER (not one
 * global key), so each agent's voucher swaps to ITS OWN runner key.
 *
 * What that buys: credential isolation (the agent only ever holds a voucher),
 * capability scoping (the proxy can reject endpoints outside the voucher's caps),
 * and revocability (vouchers are per-launch and individually revocable; rotating
 * a leaked voucher never touches a real key).
 *
 * HOST-NEUTRAL. This module hardcodes no platform. The runner key (per `mint`),
 * the upstream base URL, the voucher prefix, and the header names all come from
 * the host via `mint(...)` / `CredentialBrokerConfig`. The defaults are generic
 * (`vch_`, `X-Agent-*`); an Alook deployment passes its own.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { URL } from "url";
import { formatRef, parseRef, type Message } from "../server/contract.js";
import { parseNameAndTag } from "@alook/shared/lib/discriminator";

export const LOCAL_MESSAGE_REMINDER_PATH = "/__alook/local/message-reminder";
const LOCAL_MESSAGE_REMINDER_BODY_MAX_BYTES = 4 * 1024;
const LOCAL_MESSAGE_REMINDER_MIN_MS = 60_000;
const LOCAL_MESSAGE_REMINDER_MAX_MS = 24 * 60 * 60_000;

export interface LocalMessageReminderArmInput {
  agentId: string;
  channel: string;
  sentSeq: number;
  remindAfterMs: number;
}

export type LocalMessageReminderArmResult =
  | { armed: true; dueAt: number }
  | { armed: false; reason: string };

/** A capability token gating which actions a voucher may perform. */
export type Capability = string;

/** Header names the proxy stamps onto the upstream request. Host-overridable. */
export interface ProxyHeaderNames {
  /** Carries the agent id the voucher belongs to. */
  agentId: string;
  /** Marks the request as coming through the CLI/proxy path. */
  client: string;
  /** Comma-joined capability set the upstream may enforce against. */
  capabilities: string;
}

const DEFAULT_HEADER_NAMES: ProxyHeaderNames = {
  agentId: "X-Agent-Id",
  client: "X-Client",
  capabilities: "X-Agent-Active-Capabilities",
};

export interface CredentialBrokerConfig {
  /** Upstream base URL the proxy forwards to, e.g. "https://api.example.com". */
  upstreamBaseUrl: string;
  /** Value stamped into the `client` header (default "cli"). */
  clientLabel?: string;
  /** Voucher string prefix (default "vch_"). */
  voucherPrefix?: string;
  /** Override the stamped header names (default generic `X-Agent-*`). */
  headerNames?: ProxyHeaderNames;
  /**
   * Directory under which per-launch voucher files are written. Each launch gets
   * `<dir>/<agentId>/<launchId>.token` (0600). Defaults to the OS temp dir.
   */
  voucherDir?: string;
}

/** A minted voucher and where its file lives. */
export interface VoucherRegistration {
  voucher: string;
  agentId: string;
  launchId: string;
  capabilities: Capability[];
  /** Absolute path to the 0600 file holding the voucher string. */
  voucherFile: string;
}

interface InternalRegistration {
  agentId: string;
  launchId: string;
  capabilities: Set<Capability>;
  voucherFile: string;
  /**
   * The per-agent runner credential the proxy swaps IN for THIS voucher. In the
   * three-tier model (machine master key → per-agent runner key → voucher) this
   * is tier 2 — minted by the server's enrollment from the daemon's machine key.
   * Stored per-voucher (not one global key) so each agent's voucher swaps to its
   * OWN runner key.
   */
  runnerKey: string;
}

/** Result of validating an inbound proxy request's voucher + capability. */
export type VoucherCheck =
  | { ok: true; reg: InternalRegistration }
  | { ok: false; status: number; code: string; error: string };

function randomVoucher(prefix: string): string {
  return prefix + crypto.randomBytes(32).toString("base64url");
}

function sanitizeIdSegment(id: string): string {
  // Keep filenames safe across platforms; collapse anything unusual to "_".
  return id.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
}

/**
 * Mints, tracks, and revokes per-launch vouchers, and answers voucher/capability
 * checks for the proxy. Pure in-memory + 0600 voucher files; holds the real key
 * only in its own closure, never writes it to disk or env.
 */
export class CredentialBroker {
  private readonly registrations = new Map<string, InternalRegistration>();
  private readonly voucherPrefix: string;
  private readonly voucherDir: string;
  readonly upstreamBaseUrl: string;
  readonly clientLabel: string;
  readonly headerNames: ProxyHeaderNames;

  constructor(config: CredentialBrokerConfig) {
    if (!config.upstreamBaseUrl) throw new Error("CredentialBroker: upstreamBaseUrl is required");
    this.upstreamBaseUrl = config.upstreamBaseUrl.replace(/\/+$/, "");
    this.voucherPrefix = config.voucherPrefix ?? "vch_";
    this.clientLabel = config.clientLabel ?? "cli";
    this.headerNames = config.headerNames ?? DEFAULT_HEADER_NAMES;
    this.voucherDir = config.voucherDir ?? path.join(os.tmpdir(), "agent-vouchers");
  }

  /**
   * Mint a voucher for one agent launch, bound to that agent's `runnerKey` (the
   * tier-2 per-agent credential the server's enrollment minted from the daemon's
   * machine key). Writes a 0600 file holding the voucher string and returns the
   * registration (including the file path to inject as a `*_PROXY_TOKEN_FILE`
   * env var). The proxy later swaps THIS voucher for THIS `runnerKey`.
   */
  mint(agentId: string, launchId: string, capabilities: Capability[], runnerKey: string): VoucherRegistration {
    if (!runnerKey) throw new Error("CredentialBroker.mint: runnerKey is required (per-agent tier-2 credential)");
    const voucher = randomVoucher(this.voucherPrefix);
    const dir = path.join(this.voucherDir, sanitizeIdSegment(agentId));
    fs.mkdirSync(dir, { recursive: true });
    const voucherFile = path.join(dir, `${sanitizeIdSegment(launchId)}.token`);
    fs.writeFileSync(voucherFile, voucher, { mode: 0o600 });

    this.registrations.set(voucher, {
      agentId,
      launchId,
      capabilities: new Set(capabilities),
      voucherFile,
      runnerKey,
    });
    return { voucher, agentId, launchId, capabilities: [...capabilities], voucherFile };
  }

  /** Revoke a single voucher (e.g. when its launch ends). Removes the file too. */
  revoke(voucher: string): boolean {
    const reg = this.registrations.get(voucher);
    if (!reg) return false;
    this.registrations.delete(voucher);
    try {
      fs.rmSync(reg.voucherFile, { force: true });
    } catch {
      /* best-effort */
    }
    return true;
  }

  /** Revoke every voucher minted for an agent (e.g. agent shutdown). */
  revokeAgent(agentId: string): number {
    let n = 0;
    for (const [voucher, reg] of this.registrations) {
      if (reg.agentId === agentId && this.revoke(voucher)) n++;
    }
    return n;
  }

  /** Number of live vouchers (for tests / introspection). */
  get size(): number {
    return this.registrations.size;
  }

  /**
   * Validate the `Authorization` header of an inbound proxy request and, if a
   * `requiredCapability` is given, that the voucher carries it.
   */
  check(authHeader: string | undefined, requiredCapability?: Capability): VoucherCheck {
    const voucher = parseBearer(authHeader);
    if (!voucher) {
      return { ok: false, status: 401, code: "missing_voucher", error: "missing bearer voucher" };
    }
    const reg = this.registrations.get(voucher);
    if (!reg) {
      return { ok: false, status: 401, code: "invalid_proxy_token", error: "invalid local agent proxy token" };
    }
    if (requiredCapability && !reg.capabilities.has(requiredCapability)) {
      return {
        ok: false,
        status: 403,
        code: "capability_denied",
        error: `capability '${requiredCapability}' not granted to this voucher`,
      };
    }
    return { ok: true, reg };
  }
}

function parseBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1].trim() : null;
}

/**
 * Map an inbound request path to the capability it requires, so the proxy can
 * enforce scoping. Host-overridable; the default maps the common Alook endpoints.
 * Returns `undefined` when a path needs no specific capability.
 */
export type CapabilityResolver = (method: string, pathname: string) => Capability | undefined;

export const DEFAULT_CAPABILITY_RESOLVER: CapabilityResolver = (method, pathname) => {
  if (
    ((method === "GET" || method === "PATCH") && pathname === "/api/community/users/me/profile")
    || (method === "POST" && pathname === "/api/community/users/me/avatar")
  ) return "profile";
  // Match `/attachmentUpload` and `/attachmentDownload` (pre-rewrite pathname
  // — the credential proxy inspects the client's `/api/...` path here). Both
  // endpoints share the `"attach"` capability so a voucher can be scoped to
  // attach-only without granting `send`/`read`.
  if (pathname.includes("/attachment")) return "attach";
  // Friend surfaces: the per-bucket sub-resource endpoints (/friends,
  // /friends/accepted, /friends/pending, /friends/request). /friends/blocked is
  // bot-403 at the route (owner-only) so a bot voucher never reaches it
  // regardless of cap. The flat /friendRequest and /listFriends verbs are
  // deleted (flat-delete step) — no substring rule for them anymore.
  if (/\/friends(\/|$|\?)/.test(pathname)) return "friend";

  // ── Canonical id-in-path message door (route/disc trunk). Matched by METHOD +
  //    path SHAPE, before the flat-verb substring rules below, because the
  //    substring rules can't tell a canonical shape apart: `/channels/{id}/…`
  //    contains the literal `channel`, which the legacy `/server|/channel →
  //    "server"` rule (kept at the bottom) would grab FIRST — mis-scoping a
  //    bot send/read to the `server` capability. Shape+method disambiguates:
  //    the same `channels/{id}/messages` path is `read` on GET, `send` on POST.
  //      - GET  channels/{id}/messages           → read  (list, folds `read`)
  //      - POST channels/{id}/messages           → send  (create, folds `send`)
  //      - GET  channels/{id}/messages/seq/{seq}  → read  (folds `resolve`'s seq→id)
  //      - PUT/DELETE messages/{id}/reactions/…   → send  (write, folds `reactAdd`)
  const isMessagesDoor = /\/channels\/[^/]+\/messages(\/|$|\?)/.test(pathname)
  if (isMessagesDoor) return method === "GET" ? "read" : "send";
  if (/\/messages\/[^/]+\/reactions\//.test(pathname)) return "send";
  if (
    (method === "PUT" || method === "DELETE")
    && /\/messages\/[^/]+\/marks(\/|$|\?)/.test(pathname)
  ) return "send";
  if (method === "GET" && /\/users\/me\/marks(\/|$|\?)/.test(pathname)) return "read";
  // Single-message hydrate door GET messages/{id} (folds the `resolve` verb — a
  // read). Matched AFTER the message-keyed write doors above so their more
  // specific `/reactions|/threads` sub-paths win first.
  if (method === "GET" && /\/messages\/[^/]+(\?|$)/.test(pathname)) return "read";

  // ── Remaining generic read/server families. ──
  // send/read/reactAdd/resolve/channelMember flat routes are DELETED (folded into
  // the canonical doors above), so their substring rules are gone.
  if (pathname.includes("/history") || pathname.includes("/search") || pathname.includes("/inbox"))
    return "read";
  if (pathname.includes("/server") || pathname.includes("/channel")) return "server";
  return undefined;
};

/** Default cap on how long a forwarded upstream request may stay open. */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 20_000;

export interface CredentialProxyOptions {
  /** Bind host (default loopback). Keep it loopback in production. */
  host?: string;
  /** Port (default 0 ⇒ OS picks a free port). */
  port?: number;
  /** Path → capability mapping for scoping. Default `DEFAULT_CAPABILITY_RESOLVER`. */
  capabilityResolver?: CapabilityResolver;
  /**
   * Called after a successful inboxPull response is forwarded back to the agent.
   * The proxy knows the agentId (from voucher) and can parse the response body to
   * surface the pulled messages — used by the daemon to write timeline entries
   * regardless of whether the agent is an in-process stub or a real subprocess.
   */
  onInboxPullResponse?: (agentId: string, messages: Message[]) => void;
  /**
   * Called once per successfully-authorized upstream proxy request, BEFORE the
   * upstream is dispatched. Fires only on `verdict.ok === true` — never on
   * failed/expired-voucher attempts (those short-circuit with a 401/403 and
   * MUST NOT be surfaced as bot activity). Purely observational: the daemon
   * uses this to emit a `cli_invocation` bot audit event derived from the
   * pathname. Host-neutral by design — no bodies, no upstream response
   * details.
   */
  onProxyRequest?: (agentId: string, method: string, pathname: string) => void;
  /** Consume an authenticated reminder arm request locally; never forwarded. */
  onMessageReminderArm?: (
    input: LocalMessageReminderArmInput,
  ) => LocalMessageReminderArmResult | Promise<LocalMessageReminderArmResult>;
  /**
   * Max time (ms) a forwarded upstream request may stay open before the proxy
   * gives up on it. Without this, a slow/hung upstream (or an agent that
   * abandons its own request early) leaks the outbound connection FOREVER —
   * there is nothing else in this handler that ever times it out. Enough of
   * these piling up exhausts the daemon process's fds/sockets, at which point
   * the proxy can't accept ANY new local connection — surfacing to every
   * agent's CLI as a raw `fetch failed`, daemon-wide, until old leaked
   * connections eventually get reclaimed. Default 20s.
   */
  upstreamTimeoutMs?: number;
}

export interface RunningProxy {
  url: string;
  port: number;
  close(): Promise<void>;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isCanonicalChannelScope(channel: string): boolean {
  try {
    const parsed = parseRef(channel);
    if (!parsed.channel || parsed.seq !== undefined) return false;
    if (parsed.threadRootSeq !== undefined && (!Number.isSafeInteger(parsed.threadRootSeq) || parsed.threadRootSeq < 1)) {
      return false;
    }
    const handle = parseNameAndTag(parsed.server === ".dm" ? parsed.channel : parsed.server);
    if (!handle || `${handle.name}#${handle.discriminator}` !== (parsed.server === ".dm" ? parsed.channel : parsed.server)) {
      return false;
    }
    return formatRef(parsed) === channel;
  } catch {
    return false;
  }
}

function parseLocalMessageReminderBody(body: Buffer, agentId: string): LocalMessageReminderArmInput | null {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "channel,remindAfterMs,sentSeq") return null;
  if (typeof record.channel !== "string" || !isCanonicalChannelScope(record.channel)) return null;
  if (!Number.isSafeInteger(record.sentSeq) || (record.sentSeq as number) < 1) return null;
  if (
    !Number.isSafeInteger(record.remindAfterMs) ||
    (record.remindAfterMs as number) < LOCAL_MESSAGE_REMINDER_MIN_MS ||
    (record.remindAfterMs as number) > LOCAL_MESSAGE_REMINDER_MAX_MS
  ) return null;
  return {
    agentId,
    channel: record.channel,
    sentSeq: record.sentSeq as number,
    remindAfterMs: record.remindAfterMs as number,
  };
}

async function handleLocalMessageReminder(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentId: string,
  onArm: NonNullable<CredentialProxyOptions["onMessageReminderArm"]> | undefined,
): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    writeJson(res, 415, { error: "content-type must be application/json", code: "unsupported_media_type" });
    req.resume();
    return;
  }
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (!Number.isFinite(declaredLength) || declaredLength > LOCAL_MESSAGE_REMINDER_BODY_MAX_BYTES) {
    writeJson(res, 413, { error: "request body too large", code: "body_too_large" });
    req.resume();
    return;
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  await new Promise<void>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > LOCAL_MESSAGE_REMINDER_BODY_MAX_BYTES) {
        tooLarge = true;
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", resolve);
    req.on("error", resolve);
  });
  if (tooLarge) {
    writeJson(res, 413, { error: "request body too large", code: "body_too_large" });
    return;
  }
  const input = parseLocalMessageReminderBody(Buffer.concat(chunks), agentId);
  if (!input) {
    writeJson(res, 400, { error: "invalid local message reminder request", code: "invalid_request" });
    return;
  }
  if (!onArm) {
    writeJson(res, 503, { error: "local message reminder unavailable", code: "reminder_unavailable" });
    return;
  }
  try {
    writeJson(res, 200, await onArm(input));
  } catch {
    writeJson(res, 500, { error: "local message reminder failed", code: "reminder_failed" });
  }
}

/**
 * Start the local credential proxy. It validates the inbound voucher against the
 * broker, swaps in the real key, stamps identity/capability headers, and forwards
 * the request to the broker's upstream. Returns the bound URL (with the real port
 * when `port: 0` was used) and a `close()`.
 */
export async function startCredentialProxy(
  broker: CredentialBroker,
  options: CredentialProxyOptions = {},
): Promise<RunningProxy> {
  const host = options.host ?? "127.0.0.1";
  const resolveCap = options.capabilityResolver ?? DEFAULT_CAPABILITY_RESOLVER;
  const upstream = new URL(broker.upstreamBaseUrl);
  const upstreamClient = upstream.protocol === "https:" ? https : http;

  const onPull = options.onInboxPullResponse;
  const onProxyRequest = options.onProxyRequest;

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
    if (pathname.startsWith("/__alook/local/")) {
      if (req.url !== LOCAL_MESSAGE_REMINDER_PATH) {
        writeJson(res, 404, { error: "unknown local route", code: "not_found" });
        req.resume();
        return;
      }
      if (req.method !== "PUT") {
        writeJson(res, 405, { error: "method not allowed", code: "method_not_allowed" });
        req.resume();
        return;
      }
      // This local-only endpoint deliberately bypasses the generic resolver:
      // its send capability check must stay explicit and cannot regress to
      // resolver(undefined) if the path catalog changes.
      const localVerdict = broker.check(req.headers["authorization"], "send");
      if (!localVerdict.ok) {
        writeJson(res, localVerdict.status, { error: localVerdict.error, code: localVerdict.code });
        req.resume();
        return;
      }
      void handleLocalMessageReminder(
        req,
        res,
        localVerdict.reg.agentId,
        options.onMessageReminderArm,
      );
      return;
    }
    const requiredCap = resolveCap(req.method ?? "GET", pathname);
    const verdict = broker.check(req.headers["authorization"], requiredCap);

    if (!verdict.ok) {
      res.writeHead(verdict.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: verdict.error, code: verdict.code }));
      // Drain the request body so the socket can close cleanly.
      req.resume();
      return;
    }

    // Bot traffic has one canonical REST namespace. The deleted flat
    // `/api/<verb>` surface must fail at this boundary rather than reaching an
    // upstream that might accidentally grow a matching route later.
    const canonicalCommunityDoor = /^\/api\/community\/(channels|messages|servers|invites|friends|users|bots)(\/|$)/.test(pathname);
    if (pathname === "/api" || (pathname.startsWith("/api/") && !canonicalCommunityDoor)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown API route", code: "not_found" }));
      req.resume();
      return;
    }

    const reg = verdict.reg;
    // Tightened from `.endsWith("/inboxPull")` — the attachment-download
    // endpoint returns raw binary, and a loose match here would try to JSON-
    // parse it as an inbox response. Exact-path match the canonical inbox-pull
    // door that returns the `{ messages }` shape the timeline recorder
    // consumes: `/api/community/users/me/inbox/pull` (route/disc 轴3;
    // `callInboxPull` sends this full path directly, no rewrite). The flat
    // `/api/inboxPull` verb is deleted (flat-delete step). inboxSnapshot is
    // deliberately EXCLUDED (peek, no `{ messages }` to record).
    const isInboxPull = onPull && pathname === "/api/community/users/me/inbox/pull";

    if (onProxyRequest) {
      try {
        onProxyRequest(reg.agentId, req.method ?? "GET", pathname);
      } catch {
        // observational callback — never disrupt the proxy.
      }
    }

    // Build the upstream request: same method/path, this voucher's per-agent
    // runner key swapped in, identity + capability headers stamped, hop-specific
    // headers stripped.
    const outHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    delete outHeaders["authorization"];
    delete outHeaders["host"];
    outHeaders["authorization"] = `Bearer ${reg.runnerKey}`;
    outHeaders[broker.headerNames.agentId.toLowerCase()] = reg.agentId;
    outHeaders[broker.headerNames.client.toLowerCase()] = broker.clientLabel;
    outHeaders[broker.headerNames.capabilities.toLowerCase()] = [...reg.capabilities].join(",");

    // `responded` guards only against writing a second response to the
    // DOWNSTREAM client (writeHead/end can't fire twice) — it does NOT gate
    // upstream socket cleanup. Those are two separate concerns: headers can
    // arrive from upstream (responded=true) while the body is still
    // streaming, and a stall or client disconnect at that point is just as
    // much of a leak as one before headers ever arrived. `upstreamRes` is
    // tracked so close/timeout can destroy it too once it exists — an
    // in-flight `.pipe(res)` doesn't end `res` on a non-graceful destroy.
    let responded = false;
    let upstreamRes: http.IncomingMessage | undefined;

    const upstreamReq = upstreamClient.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: joinPath(upstream.pathname, req.url ?? "/"),
        headers: outHeaders,
      },
      (res_) => {
        responded = true;
        upstreamRes = res_;
        // `.pipe()` does NOT forward source errors to the destination, and a
        // hard upstream reset/crash mid-body (unlike a mere stall) fires
        // 'error'/'close' on `res_` immediately rather than waiting for the
        // idle timer above — without this, `res` would hang forever on a
        // reset exactly like it would on a stall. `res_.complete` is set by
        // Node once `'end'` has actually fired, so this is a no-op on the
        // normal successful-completion path.
        const destroyResIfIncomplete = () => {
          if (!res_.complete) res.destroy();
        };
        res_.on("error", destroyResIfIncomplete);
        res_.on("close", destroyResIfIncomplete);
        if (isInboxPull && res_.statusCode && res_.statusCode < 300) {
          // Buffer the inboxPull response to surface pulled messages to the daemon.
          const chunks: Buffer[] = [];
          res_.on("data", (chunk: Buffer) => chunks.push(chunk));
          res_.on("end", () => {
            const body = Buffer.concat(chunks);
            res.writeHead(res_.statusCode!, res_.headers);
            res.end(body);
            try {
              const parsed = JSON.parse(body.toString()) as { messages?: Message[] };
              if (parsed.messages) onPull(reg.agentId, parsed.messages);
            } catch { /* best-effort */ }
          });
        } else {
          res.writeHead(res_.statusCode ?? 502, res_.headers);
          res_.pipe(res);
        }
      },
    );
    upstreamReq.on("error", (err) => {
      if (responded) return;
      responded = true;
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `upstream error: ${err.message}`, code: "upstream_error" }));
    });
    // Without a timeout, a slow/hung upstream (or one that stalls mid-body
    // after headers) leaks this outbound connection forever — nothing else
    // here ever destroys it. Enough of these pile up and the daemon can't
    // accept ANY new local connection (see module doc comment) — this is the
    // actual fix, not just cosmetic. `setTimeout` is a socket-idle timeout,
    // so it keeps firing across the whole exchange, not just while waiting
    // for headers — always destroy, but only write a 504 if we haven't
    // already committed to a response.
    const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    upstreamReq.setTimeout(upstreamTimeoutMs, () => {
      upstreamReq.destroy();
      upstreamRes?.destroy();
      if (responded) {
        // Headers already went out (e.g. `res_.pipe(res)` is mid-flight and
        // stalled, or the inboxPull buffering never saw an `'end'`) — we
        // can't writeHead/end a response that's already started, but `res`
        // would otherwise hang on the destroyed source forever (destroying
        // `upstreamReq`/`upstreamRes` does NOT auto-end a stream piped FROM
        // them). `res.destroy()` is safe/idempotent, so unblock the agent's
        // own client the same way a downstream disconnect would.
        res.destroy();
        return;
      }
      responded = true;
      res.writeHead(504, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `upstream request timed out after ${upstreamTimeoutMs}ms`, code: "upstream_timeout" }));
    });
    // If the agent gives up (its own fetch aborts/times out) at ANY point —
    // before upstream responds, or mid-body after it started — stop pumping
    // into/from a request nobody's waiting on anymore. `.destroy()` on an
    // already-finished request/response is a safe no-op, so this can fire
    // unconditionally on every close, including the normal success path.
    res.on("close", () => {
      upstreamReq.destroy();
      upstreamRes?.destroy();
    });
    req.pipe(upstreamReq);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (options.port ?? 0);
  const url = `http://${host}:${port}`;

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Join an upstream base path with an incoming request path, avoiding `//`. */
function joinPath(basePath: string, reqUrl: string): string {
  const base = basePath.replace(/\/+$/, "");
  const reqPath = reqUrl.startsWith("/") ? reqUrl : `/${reqUrl}`;
  return (base + reqPath) || "/";
}
