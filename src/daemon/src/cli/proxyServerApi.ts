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
  CreatePostRequest,
  CreatePostResponse,
  ReadRequest,
  ResolveRequest,
  ListChannelsRequest,
  ChannelGroup,
  ChannelMemberResult,
  ChannelRef,
  CommunityAgentReactAddResponse,
  ServerMemberListResult,
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

  // --- Canonical id-in-path message door (route/disc trunk) -----------------
  // send/read RETARGETED off the flat verbs (`/api/send`, `/api/read`) onto the
  // one canonical door `channels/{id}/messages`. The bot holds a REF, not an id,
  // and a ref carries `/` so it can't sit in a path segment — so the bot uses
  // the `resolve` placeholder id and passes the ref as body (POST) / query
  // (GET), which the door resolves server-side (resolveMessageTarget). Same wire
  // BODY as before (the door's bot arm parses the identical send/read schema);
  // only the PATH + verb-shape change. Mirrors callUpload/callListServers'
  // bespoke real-path pattern; `rewriteAgentPath` is idempotent on
  // `/api/community/...` so these pass through un-prefixed.
  const REF_PLACEHOLDER_ID = "resolve";

  async function callSend(req: SendRequest): Promise<SendResponse> {
    // agentId stripped like `call()` does — identity rides the voucher only.
    // Route through `unknown` first: SendRequest is a typed shape with no index
    // signature, so a direct `as Record<string, unknown>` is rejected (call()
    // gets this for free because its param is already `unknown`).
    const { agentId: _omit, ...wire } = (req ?? {}) as unknown as Record<string, unknown>;
    const res = await fetchImpl(`${base}/api/community/channels/${REF_PLACEHOLDER_ID}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.voucher}`,
      },
      body: JSON.stringify(wire),
    });
    return parseJsonResponse<SendResponse>(res, "send");
  }

  async function callRead(req: ReadRequest): Promise<Page<Message>> {
    // The ref + seq anchors go on the query string (a GET has no body). Encode
    // the ref — it carries `/` and can carry `#`/`@` in DM handles. Precedent:
    // callUpload's `?target=${encodeURIComponent(...)}`.
    const q = new URLSearchParams()
    q.set("ref", req.channel)
    if (req.before !== undefined) q.set("before", String(req.before))
    if (req.after !== undefined) q.set("after", String(req.after))
    if (req.around !== undefined) q.set("around", String(req.around))
    if (req.limit !== undefined) q.set("limit", String(req.limit))
    const res = await fetchImpl(
      `${base}/api/community/channels/${REF_PLACEHOLDER_ID}/messages?${q.toString()}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${config.voucher}` },
      },
    );
    return parseJsonResponse<Page<Message>>(res, "read");
  }

  async function callChannelMember(
    req: { agentId?: AgentId; channel: ChannelRef },
  ): Promise<ChannelMemberResult> {
    // Canonical members door: GET channels/{id}/members. The bot holds a ref
    // (not an id), so it uses the `resolve` placeholder id and carries the ref on
    // the query; the door resolves it server-side (member-scoped → 404, ①-C) and
    // returns the lean `ChannelMemberResult` (visibility + members/hint).
    const res = await fetchImpl(
      `${base}/api/community/channels/${REF_PLACEHOLDER_ID}/members?ref=${encodeURIComponent(req.channel)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${config.voucher}` },
      },
    );
    return parseJsonResponse<ChannelMemberResult>(res, "channelMember");
  }

  async function callResolve(req: ResolveRequest): Promise<{ message: Message }> {
    // Canonical hydrate door: GET messages/{id}. The bot holds a ref+seq (not a
    // messageId), so it uses the `resolve` placeholder id and carries ref+seq on
    // the query; the door resolves ref+seq → message server-side (member-scoped
    // → 404, ①-C) and returns the `{ message }` agent shape. Encode the ref (it
    // carries `/`, and `#`/`@` in DM handles). resolve is locate∘hydrate — a
    // SEPARATE door from the seq→id lookup (which returns `{ id }`), NOT folded.
    const q = new URLSearchParams()
    q.set("ref", req.channel)
    q.set("seq", String(req.seq))
    const res = await fetchImpl(
      `${base}/api/community/messages/${REF_PLACEHOLDER_ID}?${q.toString()}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${config.voucher}` },
      },
    );
    return parseJsonResponse<{ message: Message }>(res, "resolve");
  }

  async function callReactAdd(
    req: { channel: ChannelRef; seq: Seq; emoji: string },
  ): Promise<CommunityAgentReactAddResponse> {
    // Canonical reaction door: PUT messages/{id}/reactions/{emoji}. The bot
    // holds a ref+seq (not a messageId), so it uses the `resolve` placeholder id
    // and carries `{ channel, seq }` in the body; the door resolves ref+seq →
    // messageId server-side (member-scoped → 404, ①-C). The emoji is a PATH
    // segment (URL-encoded) — reactions are keyed by (message, emoji).
    const res = await fetchImpl(
      `${base}/api/community/messages/${REF_PLACEHOLDER_ID}/reactions/${encodeURIComponent(req.emoji)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.voucher}`,
        },
        body: JSON.stringify({ channel: req.channel, seq: req.seq }),
      },
    );
    // Response projection (Fork C, at the single proxy boundary): the canonical
    // route returns the reaction ROW (or `{ ok, duplicate }` on a dup); the lean
    // agent contract is `{ ok: true, duplicate? }`. A 200 with a `duplicate`
    // flag maps straight through; any other 200 is a fresh add → `{ ok: true }`.
    const body = await parseJsonResponse<{ duplicate?: boolean }>(res, "reactAdd");
    return body?.duplicate ? { ok: true, duplicate: true } : { ok: true };
  }

  async function callListMembers(
    req: { agentId?: AgentId; server: string; limit?: number; cursor?: string },
  ): Promise<ServerMemberListResult> {
    // Canonical server-member door: GET servers/{id}/members. RETARGETED off the
    // flat `listMembers` verb. The bot addresses by server ref/name (not id), so
    // it uses the `resolve` placeholder id and carries the ref on `?server=`
    // (plus optional `limit`/`cursor` for the paginated roster); the door
    // resolves it member-scoped (→ 404, ①-C) and returns the lean
    // `{ members: [{handle, role, online, status}], hasMore, cursor? }` shape.
    // Encode the ref (server names can carry `#`/spaces).
    const q = new URLSearchParams()
    q.set("server", req.server)
    if (req.limit !== undefined) q.set("limit", String(req.limit))
    if (req.cursor !== undefined) q.set("cursor", req.cursor)
    const res = await fetchImpl(
      `${base}/api/community/servers/${REF_PLACEHOLDER_ID}/members?${q.toString()}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${config.voucher}` },
      },
    );
    return parseJsonResponse<ServerMemberListResult>(res, "listMembers");
  }

  async function callListChannels(req: ListChannelsRequest): Promise<{ groups: ChannelGroup[] }> {
    // Canonical channel-list doors: single server → GET servers/{id}/channels
    // (ref on `?server=`, `resolve` placeholder id, member-scoped → 404 ①-C);
    // all servers (server omitted) → GET servers/channels (collection-level
    // aggregate, no id). RETARGETED off the flat `listChannels` verb. Both return
    // the same `{ groups: ChannelGroup[] }`.
    const url = req.server
      ? `${base}/api/community/servers/${REF_PLACEHOLDER_ID}/channels?server=${encodeURIComponent(req.server)}`
      : `${base}/api/community/servers/channels`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${config.voucher}` },
    });
    return parseJsonResponse<{ groups: ChannelGroup[] }>(res, "listChannels");
  }

  async function callListFriends(): Promise<{
    accepted: FriendCard[];
    pendingOutgoing: FriendCard[];
    pendingIncoming: FriendCard[];
  }> {
    // RETARGETED off the flat `listFriends` verb onto the per-bucket friends
    // sub-resource endpoints (route/disc 轴3): accepted from GET friends/accepted,
    // pending from GET friends/pending. The bot NEVER calls friends/blocked
    // (owner-only, bot-403). Compose the 3-bucket shape `alook friend list`
    // renders — CLI output unchanged. Both endpoints are self-scoped to the
    // voucher's bot (no target-user param), so no addressing goes on the wire.
    const get = async (path: string) => {
      const res = await fetchImpl(`${base}/api/community/friends/${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${config.voucher}` },
      });
      return res;
    };
    const [acceptedRes, pendingRes] = await Promise.all([get("accepted"), get("pending")]);
    const acceptedBody = await parseJsonResponse<{ accepted: FriendCard[] }>(acceptedRes, "listFriends");
    const pendingBody = await parseJsonResponse<{
      pendingIncoming: FriendCard[];
      pendingOutgoing: FriendCard[];
    }>(pendingRes, "listFriends");
    return {
      accepted: acceptedBody.accepted ?? [],
      pendingIncoming: pendingBody.pendingIncoming ?? [],
      pendingOutgoing: pendingBody.pendingOutgoing ?? [],
    };
  }

  async function callInboxPull(req: InboxPullRequest): Promise<InboxPullResponse> {
    // RETARGETED off the flat `inboxPull` verb onto the caller's own inbox
    // resource POST users/me/inbox/pull (route/disc 轴3). Self-scoped to the
    // voucher's bot — no target-user param on the wire (users/me/* family). The
    // flat /inboxPull route stays alive through deploy (daemon is non-hot-reload;
    // deleting it same-commit would 404 the whole fleet during the restart
    // window) — its deletion is deferred to the flat-delete step, after daemon
    // is confirmed on this new target. Same optional `{max?}` body.
    const { agentId: _omit, ...wire } = (req ?? {}) as unknown as Record<string, unknown>;
    const res = await fetchImpl(`${base}/api/community/users/me/inbox/pull`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.voucher}`,
      },
      body: JSON.stringify(wire),
    });
    return parseJsonResponse<InboxPullResponse>(res, "inboxPull");
  }

  async function callAck(req: AckRequest): Promise<void> {
    // RETARGETED off the flat `ack` verb onto POST users/me/inbox/ack (route/disc
    // 接口树统一, Gener #215 乙) — ack is the ADVANCE operation of the inbox
    // fetch↔advance trinity (snapshot=peek / pull=fetch / ack=advance, Aigneis
    // #41). Self-scoped to the voucher's bot — the wire carries only the cursors,
    // no target-user param (users/me/* family). Body byte-identical to the flat
    // verb (the endpoint is a MOVE-FLAT, same seq-native/failed[]-batch/no-create
    // shape — only the URL moved). The flat /ack route stays alive through deploy
    // (daemon is non-hot-reload; deleting it same-commit would 404 the fleet
    // during the restart window) — deletion deferred to the flat-delete step,
    // after the daemon is confirmed on this new target. Returns void (the daemon
    // fire-and-forgets the {ok,applied,failed} body, same as the flat verb).
    const { agentId: _omit, ...wire } = (req ?? {}) as unknown as Record<string, unknown>;
    const res = await fetchImpl(`${base}/api/community/users/me/inbox/ack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.voucher}`,
      },
      body: JSON.stringify(wire),
    });
    return parseJsonResponse<void>(res, "ack");
  }

  async function callFriendRequest(req: { agentId: AgentId; username: string }): Promise<FriendRequestResult> {
    // RETARGETED off the flat `friendRequest` verb onto POST friends/request
    // (route/disc 接口树统一, Melly #540) — the friend-request door is dual-actor
    // (human/bot on one URL, dispatched to independent handlers). The bot arm
    // keeps its distinct semantics (sibling-auto-accept, always-owner-gated, lean
    // {friendshipId,status,hint}). Self-scoped: the wire carries only `username`,
    // never a requesterId (that's the credential's botUserId server-side). Body
    // byte-identical to the flat verb. The flat /friendRequest route stays alive
    // through deploy (daemon non-hot-reload) → flat-delete step.
    const { agentId: _omit, ...wire } = (req ?? {}) as unknown as Record<string, unknown>;
    const res = await fetchImpl(`${base}/api/community/friends/request`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.voucher}`,
      },
      body: JSON.stringify(wire),
    });
    return parseJsonResponse<FriendRequestResult>(res, "friendRequest");
  }

  async function callNap(req: { handoff: string }): Promise<{ napped: boolean }> {
    // RETARGETED off the flat `nap` verb onto POST bots/me/nap (route/disc
    // 接口树统一, Gener #215 乙; Blondie #527). nap is a bot-qua-bot self
    // lifecycle action — the agent resets its OWN session — so it lives under
    // bots/me/* (self-scope, "me" = the credential-authenticated bot, no target
    // id). Self-scoped to the voucher's bot: the wire carries only the handoff,
    // never a target-bot param (bots/me/* family invariant, same as users/me).
    // Body byte-identical to the flat verb (MOVE-FLAT, only the URL moved). The
    // flat /nap route stays alive through deploy (daemon non-hot-reload) —
    // deletion deferred to the flat-delete step, after the daemon is on the new
    // target.
    const { agentId: _omit, ...wire } = (req ?? {}) as unknown as Record<string, unknown>;
    const res = await fetchImpl(`${base}/api/community/bots/me/nap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.voucher}`,
      },
      body: JSON.stringify(wire),
    });
    return parseJsonResponse<{ napped: boolean }>(res, "nap");
  }

  async function callInboxSnapshot(): Promise<InboxSnapshot> {
    // RETARGETED off the flat `inboxSnapshot` verb onto GET users/me/inbox/snapshot
    // (route/disc 轴3). A GET — snapshot is a pure peek (never advances the read
    // waterline, unlike pull), so the fetch↔advance decoupling is explicit in the
    // verb. Self-scoped, no target-user param. Flat route stays through deploy.
    const res = await fetchImpl(`${base}/api/community/users/me/inbox/snapshot`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.voucher}` },
    });
    return parseJsonResponse<InboxSnapshot>(res, "inboxSnapshot");
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
    listChannels: callListChannels,
    channelMember: callChannelMember,
    inboxPull: callInboxPull,
    inboxSnapshot: (_r: { agentId: AgentId }) => callInboxSnapshot(),
    ack: callAck,
    send: callSend,
    createPost: (r: CreatePostRequest) => call<CreatePostResponse>("createPost", r),
    read: callRead,
    resolve: callResolve,
    listMembers: callListMembers,
    attachmentUpload: callUpload,
    attachmentDownload: callDownload,
    reactAdd: callReactAdd,
    friendRequest: callFriendRequest,
    listFriends: (_r: { agentId: AgentId }) => callListFriends(),
    nap: callNap,
  };
}
