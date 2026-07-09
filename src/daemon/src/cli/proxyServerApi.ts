/**
 * Proxy-routed `ServerApi` client — the agent's REAL data-plane path.
 *
 * A spawned agent never gets the server's real credential. Instead `cliTransport`
 * injects, into the agent's env:
 *   - `<PREFIX>_PROXY_URL`         — the local credential proxy's URL
 *   - `<PREFIX>_PROXY_TOKEN_FILE`  — a 0600 file holding the per-launch `vch_` voucher
 *
 * This client reads those, then calls `POST <proxyUrl>/api/<method>` carrying
 * `Authorization: Bearer <voucher>`. The proxy validates the voucher, swaps in
 * the real key, stamps `X-Agent-Id` (derived from the voucher — NOT from anything
 * the agent says), and forwards to the data-plane upstream. So the agent's
 * identity is established by the voucher it holds, never self-asserted.
 *
 * This is the code the mock agent reuses verbatim in local dev — the only thing
 * that differs locally is that the proxy's upstream points at the in-process
 * bridge instead of a remote server. The credential + verification path is real.
 */
import * as fs from "fs";
import type {
  ServerApi,
  InboxPullRequest,
  InboxPullResponse,
  InboxSnapshot,
  AckRequest,
  SendRequest,
  SendResponse,
  ReadRequest,
  ResolveRequest,
  ListChannelsRequest,
  Page,
  Message,
  Server,
  Channel,
  AgentId,
} from "../server/contract.js";

export interface ProxyServerApiConfig {
  /** The credential proxy base URL (from `<PREFIX>_PROXY_URL`). */
  proxyUrl: string;
  /** The per-launch voucher string (read from `<PREFIX>_PROXY_TOKEN_FILE`). */
  voucher: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a proxy-routed ServerApi from the agent's injected env. Returns null when
 * the proxy env isn't present (so a caller can decide what to do — the CLI errors).
 */
export function proxyServerApiFromEnv(prefix = "ALOOK", env: NodeJS.ProcessEnv = process.env): ServerApi | null {
  const proxyUrl = env[`${prefix}_PROXY_URL`];
  const tokenFile = env[`${prefix}_PROXY_TOKEN_FILE`];
  if (!proxyUrl || !tokenFile) return null;
  const voucher = fs.readFileSync(tokenFile, "utf8").trim();
  return createProxyServerApi({ proxyUrl, voucher });
}

/** Build a proxy-routed ServerApi from an explicit config (used by tests / hosts). */
export function createProxyServerApi(config: ProxyServerApiConfig): ServerApi {
  const fetchImpl = config.fetchImpl ?? fetch;
  const base = config.proxyUrl.replace(/\/+$/, "");

  async function call<T>(method: string, body: unknown): Promise<T> {
    // Strip any agentId from the wire body: identity travels ONLY as the voucher,
    // which the proxy turns into a trusted X-Agent-Id the bridge injects. Sending
    // an agentId here would be ignored (the bridge overrides it) — we omit it so
    // the wire carries no self-asserted identity at all.
    const { agentId: _omit, ...wire } = (body ?? {}) as Record<string, unknown>;
    const res = await fetchImpl(`${base}/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.voucher}`,
      },
      body: JSON.stringify(wire),
    });
    const json = (await res.json()) as T & { error?: string; code?: string };
    if (!res.ok) {
      const e = new Error(json?.error ?? `proxy api/${method} failed (${res.status})`);
      (e as { code?: string }).code = json?.code;
      throw e;
    }
    return json;
  }

  return {
    listServers: (r: { agentId: AgentId }) => call<{ servers: Server[] }>("listServers", r),
    listChannels: (r: ListChannelsRequest) => call<{ channels: Channel[] }>("listChannels", r),
    inboxPull: (r: InboxPullRequest) => call<InboxPullResponse>("inboxPull", r),
    inboxSnapshot: (r: { agentId: AgentId }) => call<InboxSnapshot>("inboxSnapshot", r),
    ack: (r: AckRequest) => call<void>("ack", r),
    send: (r: SendRequest) => call<SendResponse>("send", r),
    read: (r: ReadRequest) => call<Page<Message>>("read", r),
    resolve: (r: ResolveRequest) => call<{ message: Message }>("resolve", r),
  };
}
