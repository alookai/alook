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
import type { Message } from "../server/contract.js";

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

export const DEFAULT_CAPABILITY_RESOLVER: CapabilityResolver = (_method, pathname) => {
  if (pathname.includes("/send")) return "send";
  if (pathname.includes("/history") || pathname.includes("/search") || pathname.includes("/inbox"))
    return "read";
  if (pathname.includes("/tasks")) return "tasks";
  if (pathname.includes("/react")) return "reactions";
  if (pathname.includes("/server") || pathname.includes("/channel")) return "server";
  return undefined;
};

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
}

export interface RunningProxy {
  url: string;
  port: number;
  close(): Promise<void>;
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

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
    const requiredCap = resolveCap(req.method ?? "GET", pathname);
    const verdict = broker.check(req.headers["authorization"], requiredCap);

    if (!verdict.ok) {
      res.writeHead(verdict.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: verdict.error, code: verdict.code }));
      // Drain the request body so the socket can close cleanly.
      req.resume();
      return;
    }

    const reg = verdict.reg;
    const isInboxPull = onPull && pathname.endsWith("/inboxPull");

    // Build the upstream request: same method/path, this voucher's per-agent
    // runner key swapped in, identity + capability headers stamped, hop-specific
    // headers stripped.
    const outHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    delete outHeaders["authorization"];
    delete outHeaders["host"];
    delete outHeaders["content-length"]; // recomputed by the upstream client
    outHeaders["authorization"] = `Bearer ${reg.runnerKey}`;
    outHeaders[broker.headerNames.agentId.toLowerCase()] = reg.agentId;
    outHeaders[broker.headerNames.client.toLowerCase()] = broker.clientLabel;
    outHeaders[broker.headerNames.capabilities.toLowerCase()] = [...reg.capabilities].join(",");

    const upstreamReq = upstreamClient.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: joinPath(upstream.pathname, req.url ?? "/"),
        headers: outHeaders,
      },
      (upstreamRes) => {
        if (isInboxPull && upstreamRes.statusCode && upstreamRes.statusCode < 300) {
          // Buffer the inboxPull response to surface pulled messages to the daemon.
          const chunks: Buffer[] = [];
          upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
          upstreamRes.on("end", () => {
            const body = Buffer.concat(chunks);
            res.writeHead(upstreamRes.statusCode!, upstreamRes.headers);
            res.end(body);
            try {
              const parsed = JSON.parse(body.toString()) as { messages?: Message[] };
              if (parsed.messages) onPull(reg.agentId, parsed.messages);
            } catch { /* best-effort */ }
          });
        } else {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        }
      },
    );
    upstreamReq.on("error", (err) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `upstream error: ${err.message}`, code: "upstream_error" }));
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
