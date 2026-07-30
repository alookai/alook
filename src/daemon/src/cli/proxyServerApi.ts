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
 * This is the code the integration-test harness reuses verbatim — the only
 * thing that differs is that the proxy's upstream points at a local `wrangler
 * dev` instance instead of a deployed server. The credential + verification
 * path is real.
 */
import * as fs from "fs";
import * as path from "path";
import type {
  AgentAttachmentDownloadResult,
  AgentAttachmentUploadResult,
  AttachmentDownloadRequest,
  AttachmentUploadRequest,
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
  ChannelGroup,
  ChannelMemberResult,
  ChannelRef,
  CommunityAgentReactAddResponse,
  ServerMember,
  Page,
  Message,
  Seq,
  Server,
  AgentId,
  FriendRequestResult,
  FriendCard,
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

  // Empty body + res.ok → undefined (204 / empty-200 like `ack`).
  // Empty body + !res.ok → structured "upstream ... non-JSON body" (the empty-500 class).
  // Non-empty non-JSON → same non-JSON message (truncated HTML 502 is "upstream broken", not client bug).
  // JSON parse: res.ok → parsed T; !res.ok → Error with .code/.hint from the structured error body.
  // res.text() throwing (RST after headers, TypeError: terminated) → surfaces as
  // "upstream body read failed" so callers see a meaningful message instead of
  // the bare TypeError.
  async function parseJsonResponse<T>(res: Response, method: string): Promise<T> {
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`upstream body read failed from /api/${method} (${res.status}): ${cause}`);
    }
    if (text.length === 0) {
      if (res.ok) return undefined as T;
      throw new Error(`upstream returned ${res.status} with non-JSON body from /api/${method}`);
    }
    let json: (T & { error?: string; code?: string; hint?: string }) | undefined;
    try {
      json = JSON.parse(text) as T & { error?: string; code?: string; hint?: string };
    } catch {
      throw new Error(`upstream returned ${res.status} with non-JSON body from /api/${method}`);
    }
    if (!res.ok) {
      const e = new Error(json?.error ?? `proxy api/${method} failed (${res.status})`);
      // Only attach when present — assigning `undefined` would leave an own
      // property that trips `"code" in err` / `hasOwnProperty` checks in
      // callers that use those as feature-tests.
      if (json?.code !== undefined) (e as { code?: string }).code = json.code;
      // Copy `hint` onto the thrown Error the same way `.code` is copied —
      // without this the owner-mismatch hint never leaves this file (see
      // plan's "Hint propagation" note).
      if (json?.hint !== undefined) (e as { hint?: string }).hint = json.hint;
      throw e;
    }
    return json as T;
  }

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
    return parseJsonResponse<T>(res, method);
  }

  async function callUpload(req: AttachmentUploadRequest): Promise<AgentAttachmentUploadResult> {
    const form = new FormData();
    // The Blob's `type` becomes `File.type` on the server after multipart parsing;
    // without it, the server's MIME allowlist rejects every upload with 400.
    const blobType = req.file.contentType ?? "application/octet-stream";
    const bytes =
      req.file.data instanceof Uint8Array
        ? new Blob([new Uint8Array(req.file.data)], { type: blobType })
        : req.file.data;
    form.append("file", bytes as Blob, req.file.filename);
    const url = `${base}/api/attachmentUpload?target=${encodeURIComponent(req.target)}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${config.voucher}` },
      body: form,
    });
    return parseJsonResponse<AgentAttachmentUploadResult>(res, "attachmentUpload");
  }

  async function callDownload(req: AttachmentDownloadRequest): Promise<AgentAttachmentDownloadResult> {
    const res = await fetchImpl(`${base}/api/attachmentDownload`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.voucher}`,
      },
      body: JSON.stringify({ id: req.id }),
    });
    if (!res.ok) {
      // Error responses ARE JSON. Streaming success responses are binary.
      // Route through the shared helper so empty/HTML-502/read-fail all
      // surface as the same "upstream ..." message the other calls use.
      // parseJsonResponse ALWAYS throws when `!res.ok` (empty→non-JSON msg,
      // parse-fail→non-JSON msg, structured JSON→Error carrying .code/.hint).
      await parseJsonResponse<never>(res, "attachmentDownload");
      throw new Error("unreachable: parseJsonResponse must throw on !res.ok");
    }
    const encoded = res.headers.get("x-alook-filename");
    const filename = encoded ? decodeURIComponent(encoded) : path.basename(req.destPath);
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const size = Number(res.headers.get("content-length") ?? "0");
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(req.destPath), { recursive: true });
    const tmp = `${req.destPath}.tmp`;
    try {
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, req.destPath);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
      throw err;
    }
    return { path: req.destPath, filename, contentType, size: size || buf.byteLength };
  }

  // --- Folded verbs: real REST paths, not flat `/api/<verb>` ---------------
  // listServers and joinServer FOLDED onto the human routes (GET /servers,
  // POST /invites/<token>/join). The unified route returns a SUPERSET; the lean
  // contract projection (Fork C — Aigneis condition 1) happens HERE, at the
  // single proxy response boundary, NOT per CLI command. These hit
  // `/api/community/...` directly; `rewriteAgentPath` is idempotent so the path
  // passes through unprefixed. Mirrors the existing callUpload/callDownload
  // custom-path pattern.

  /** Project a superset server row down to the lean `Server` ({id,name}). */
  function projectServer(row: { id: string; name: string }): Server {
    return { id: row.id, name: row.name };
  }

  async function callListServers(): Promise<{ servers: Server[] }> {
    const res = await fetchImpl(`${base}/api/community/servers`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.voucher}` },
    });
    const body = await parseJsonResponse<{ servers: Array<{ id: string; name: string }> }>(
      res,
      "listServers",
    );
    // Superset in → lean out: drop icon/ownerId/etc., emit only {id,name}.
    return { servers: body.servers.map(projectServer) };
  }

  async function callJoinServer(req: { agentId: AgentId; invite: string }): Promise<{ server: Server }> {
    // The invite token is a ROUTE PARAM on the folded route (POST
    // /invites/<token>/join), not a body field. Body is empty; identity rides
    // the voucher as everywhere else.
    const res = await fetchImpl(
      `${base}/api/community/invites/${encodeURIComponent(req.invite)}/join`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.voucher}`,
        },
        body: "{}",
      },
    );
    const body = await parseJsonResponse<{ server?: { id: string; name: string } }>(res, "joinServer");
    // Superset {member,serverId,server} in → lean {server:{id,name}} out.
    if (!body.server) {
      throw new Error("joinServer: upstream response missing server");
    }
    return { server: projectServer(body.server) };
  }

  return {
    listServers: (_r: { agentId: AgentId }) => callListServers(),
    joinServer: callJoinServer,
    listChannels: (r: ListChannelsRequest) => call<{ groups: ChannelGroup[] }>("listChannels", r),
    channelMember: (r: { agentId?: AgentId; channel: ChannelRef }) =>
      call<ChannelMemberResult>("channelMember", r),
    inboxPull: (r: InboxPullRequest) => call<InboxPullResponse>("inboxPull", r),
    inboxSnapshot: (r: { agentId: AgentId }) => call<InboxSnapshot>("inboxSnapshot", r),
    ack: (r: AckRequest) => call<void>("ack", r),
    send: (r: SendRequest) => call<SendResponse>("send", r),
    read: (r: ReadRequest) => call<Page<Message>>("read", r),
    resolve: (r: ResolveRequest) => call<{ message: Message }>("resolve", r),
    listMembers: (r: { agentId: AgentId; server: string }) => call<{ members: ServerMember[] }>("listMembers", r),
    attachmentUpload: callUpload,
    attachmentDownload: callDownload,
    reactAdd: (r: { channel: ChannelRef; seq: Seq; emoji: string }) =>
      call<CommunityAgentReactAddResponse>("reactAdd", r),
    friendRequest: (r: { agentId: AgentId; username: string }) =>
      call<FriendRequestResult>("friendRequest", r),
    listFriends: (r: { agentId: AgentId }) =>
      call<{ accepted: FriendCard[]; pendingOutgoing: FriendCard[]; pendingIncoming: FriendCard[] }>(
        "listFriends",
        r,
      ),
    nap: (r: { handoff: string }) => call<{ napped: boolean }>("nap", r),
  };
}
