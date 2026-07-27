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

  // REST call against a full community path (the bot now shares the user routes).
  // `agentId` is never sent — identity is the voucher the proxy swaps for the
  // real runner key + a trusted X-Agent-Id. `label` is only for error messages.
  async function rest<T>(
    verb: "GET" | "POST" | "PUT",
    path: string,
    label: string,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = {
      method: verb,
      headers: {
        authorization: `Bearer ${config.voucher}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await fetchImpl(`${base}${path}`, init);
    return parseJsonResponse<T>(res, label);
  }

  // The two REST message scopes: a channel id → `/channels/:id`, a DM id →
  // `/dm/:id`. Exactly one must be set (the CLI's --channel/--dm are mutually
  // exclusive); we throw a clear client error otherwise rather than emit a
  // malformed path.
  function scopeBase(t: { channelId?: string; dmConversationId?: string }, label: string): string {
    if (t.channelId) return `/api/community/channels/${encodeURIComponent(t.channelId)}`;
    if (t.dmConversationId) return `/api/community/dm/${encodeURIComponent(t.dmConversationId)}`;
    throw new Error(`${label}: one of channelId / dmConversationId is required`);
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
    const url = `${base}${scopeBase(req, "attachmentUpload")}/upload`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${config.voucher}` },
      body: form,
    });
    return parseJsonResponse<AgentAttachmentUploadResult>(res, "attachmentUpload");
  }

  async function callDownload(req: AttachmentDownloadRequest): Promise<AgentAttachmentDownloadResult> {
    const res = await fetchImpl(`${base}/api/community/attachments/${encodeURIComponent(req.id)}/download`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${config.voucher}`,
      },
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

  // The user messages route returns `{ messages, hasMore?/hasMoreNewer?/
  // hasMoreOlder?, latestSeq }`; the agent `Page<Message>` shape is
  // `{ items, hasMore, latestSeq }`. Map `messages`→`items` and collapse the
  // per-direction "more" flags into one boolean.
  type WireMessagesPage = {
    messages: Message[];
    hasMore?: boolean;
    hasMoreNewer?: boolean;
    hasMoreOlder?: boolean;
    latestSeq?: Seq;
  };
  function toPage(w: WireMessagesPage): Page<Message> {
    const hasMore = w.hasMore ?? w.hasMoreNewer ?? w.hasMoreOlder ?? false;
    return {
      items: w.messages,
      hasMore,
      ...(w.latestSeq !== undefined ? { latestSeq: w.latestSeq } : {}),
    };
  }

  // One unread scope node in the `/inbox/unreads` response — a channel (which
  // may nest thread/post `children`) or a DM. `lastReadSeq` is the bot's read
  // waterline for that scope (null when it has no read-state row yet → 0), the
  // `afterSeq` anchor for paging that scope's unread. `lastMessageSeq` is the
  // scope's newest seq — the two bound the pending window.
  type UnreadScope = {
    channelId: string;
    type?: string;
    lastMessageSeq: number;
    lastReadSeq: number | null;
    mentionCount: number;
    children?: UnreadScope[];
  };
  type UnreadDm = {
    dmConversationId: string;
    lastMessageSeq: number;
    lastReadSeq: number | null;
  };
  type UnreadsResponse = {
    servers: Array<{ serverId: string; serverName: string; channels: UnreadScope[] }>;
    dms: UnreadDm[];
  };

  // A message row as the user messages route emits it (`mapMessageForApi`) —
  // `seq` is a bare number, `createdAt` an ISO string, no path ref / handle.
  type WireUserMessage = {
    id: string;
    authorId: string;
    authorName?: string;
    content: string | null;
    seq: number;
    createdAt: string;
  };
  type WireUserMessagesPage = {
    messages: WireUserMessage[];
    hasMore?: boolean;
    hasMoreNewer?: boolean;
  };

  // Project a user-route message row onto the CLI `Message` contract for the
  // given id-scope. `sender` is best-effort from `authorName` (the user route
  // carries no discriminator); the ack loop keys off `channelId`/
  // `dmConversationId` + `seq`, so those are the load-bearing fields.
  function wireToMessage(
    m: WireUserMessage,
    scope: { channelId: string } | { dmConversationId: string },
  ): Message {
    return {
      seq: `#${m.seq}`,
      sender: `@${m.authorName ?? m.authorId}`,
      content: { text: m.content ?? "" },
      time: m.createdAt,
      id: m.id,
      ...scope,
      authorId: m.authorId,
    };
  }

  // Flatten the unreads tree into an ordered scope list: each server's
  // channels (each followed by its thread/post children), then DMs.
  function flattenUnreadScopes(
    unreads: UnreadsResponse,
  ): Array<{ scope: { channelId: string } | { dmConversationId: string }; afterSeq: number; node: UnreadScope | UnreadDm }> {
    const out: Array<{ scope: { channelId: string } | { dmConversationId: string }; afterSeq: number; node: UnreadScope | UnreadDm }> = [];
    for (const server of unreads.servers ?? []) {
      for (const channel of server.channels ?? []) {
        out.push({ scope: { channelId: channel.channelId }, afterSeq: channel.lastReadSeq ?? 0, node: channel });
        for (const child of channel.children ?? []) {
          out.push({ scope: { channelId: child.channelId }, afterSeq: child.lastReadSeq ?? 0, node: child });
        }
      }
    }
    for (const dm of unreads.dms ?? []) {
      out.push({ scope: { dmConversationId: dm.dmConversationId }, afterSeq: dm.lastReadSeq ?? 0, node: dm });
    }
    return out;
  }

  // Build the `?…Seq=` query for a seq-anchored read (at most one of
  // before/after/around, mirroring the user route's aroundSeq/afterSeq/beforeSeq).
  function readQuery(r: ReadRequest): string {
    const q = new URLSearchParams();
    if (r.around !== undefined) q.set("aroundSeq", String(r.around));
    else if (r.after !== undefined) q.set("afterSeq", String(r.after));
    else if (r.before !== undefined) q.set("beforeSeq", String(r.before));
    if (r.limit !== undefined) q.set("limit", String(r.limit));
    const s = q.toString();
    return s ? `?${s}` : "";
  }

  return {
    listServers: () => rest<{ servers: Server[] }>("GET", "/api/community/servers", "listServers"),
    // Survivor — the agent's category-grouped `{ groups }` (ref + visibility,
    // multi-server) has no user-route twin; the human channel tree is the
    // bootstrap's id-based, unread-enriched, single-server shape. Keep the
    // dedicated agent route (proxy rewrites to /api/community/agent/*).
    listChannels: (r: ListChannelsRequest) => call<{ groups: ChannelGroup[] }>("listChannels", r),
    channelMember: (r: { agentId?: AgentId; channelId: string }) =>
      rest<ChannelMemberResult>("GET", `/api/community/channels/${encodeURIComponent(r.channelId)}/members`, "channelMember"),
    inboxPull: async (r: InboxPullRequest): Promise<InboxPullResponse> => {
      const cap = r.max ?? Infinity;
      const unreads = await rest<UnreadsResponse>("GET", "/api/community/inbox/unreads", "inboxPull");
      const scopes = flattenUnreadScopes(unreads);

      const messages: Message[] = [];
      let hasMore = false;
      for (let i = 0; i < scopes.length; i++) {
        if (messages.length >= cap) {
          // A remaining scope means more unread beyond the cap.
          hasMore = true;
          break;
        }
        const { scope, afterSeq } = scopes[i]!;
        const scopePath = "channelId" in scope
          ? `/api/community/channels/${encodeURIComponent(scope.channelId)}`
          : `/api/community/dm/${encodeURIComponent(scope.dmConversationId)}`;
        const page = await rest<WireUserMessagesPage>(
          "GET",
          `${scopePath}/messages?afterSeq=${afterSeq}`,
          "inboxPull",
        );
        for (const m of page.messages) {
          messages.push(wireToMessage(m, scope));
        }
        // Newer messages remain in this scope beyond the page we fetched.
        if (page.hasMoreNewer ?? page.hasMore ?? false) hasMore = true;
      }

      if (messages.length > cap) {
        messages.length = cap;
        hasMore = true;
      }
      return { messages, hasMore };
    },
    inboxSnapshot: async (_r: { agentId: AgentId }): Promise<InboxSnapshot> => {
      const unreads = await rest<UnreadsResponse>("GET", "/api/community/inbox/unreads", "inboxSnapshot");
      const rows: InboxSnapshot["rows"] = [];
      const projectChannel = (node: UnreadScope) => {
        const lastRead = node.lastReadSeq ?? 0;
        const pendingCount = Math.max(0, node.lastMessageSeq - lastRead);
        rows.push({
          channelId: node.channelId,
          pendingCount,
          firstPendingSeq: lastRead + 1,
          latestSeq: node.lastMessageSeq,
          flags: node.mentionCount > 0 ? ["mention"] : [],
        });
      };
      for (const server of unreads.servers ?? []) {
        for (const channel of server.channels ?? []) {
          projectChannel(channel);
          for (const child of channel.children ?? []) projectChannel(child);
        }
      }
      for (const dm of unreads.dms ?? []) {
        const lastRead = dm.lastReadSeq ?? 0;
        rows.push({
          dmConversationId: dm.dmConversationId,
          pendingCount: Math.max(0, dm.lastMessageSeq - lastRead),
          firstPendingSeq: lastRead + 1,
          latestSeq: dm.lastMessageSeq,
          flags: ["dm"],
        });
      }
      return {
        rows,
        pendingChannels: rows.length,
        pendingMessages: rows.reduce((n, r) => n + r.pendingCount, 0),
      };
    },
    ack: async (r: AckRequest) => {
      // Advance each scope's read waterline via that scope's REST read route.
      for (const c of r.cursors) {
        await rest<{ ok: true }>("PUT", `${scopeBase(c, "ack")}/read`, "ack", { seq: c.seq });
      }
    },
    send: async (r: SendRequest) => {
      // The user route returns `{ message: <row> }` (201) on success, or the
      // bot alignment gate's `{ state: "blocked", … }` (200). Wrap the success
      // shape into the `{ state: "sent", message }` the CLI expects; pass the
      // blocked envelope through unchanged.
      const body = await rest<SendResponse | { message: Message }>(
        "POST",
        `${scopeBase(r, "send")}/messages`,
        "send",
        {
          content: r.content,
          ...(r.attachments ? { attachments: r.attachments } : {}),
          ...(r.seenUpToSeq !== undefined ? { seenUpToSeq: r.seenUpToSeq } : {}),
        },
      );
      if ("state" in body) return body;
      return { state: "sent", message: body.message };
    },
    read: async (r: ReadRequest) =>
      toPage(await rest<WireMessagesPage>("GET", `${scopeBase(r, "read")}/messages${readQuery(r)}`, "read")),
    resolve: async (r: ResolveRequest) => {
      // The user route has no single-message-by-seq endpoint; fetch the 1-wide
      // window centered on `seq` and pick the matching row.
      const page = await rest<WireMessagesPage>(
        "GET",
        `${scopeBase(r, "resolve")}/messages?aroundSeq=${r.seq}&limit=1`,
        "resolve",
      );
      const wanted = `#${r.seq}`;
      const message = page.messages.find((m) => m.seq === wanted) ?? page.messages[0];
      if (!message) {
        const e = new Error(`no message with seq ${wanted}`);
        (e as { code?: string }).code = "not_found";
        throw e;
      }
      return { message };
    },
    listMembers: (r: { agentId: AgentId; server: string }) =>
      rest<{ members: ServerMember[] }>("GET", `/api/community/servers/${encodeURIComponent(r.server)}/members`, "listMembers"),
    joinServer: async (r: { agentId: AgentId; invite: string }) => {
      // The user invite-join route returns `{ member, serverId }`; the CLI
      // contract wants `{ server: { id, name } }`. The route doesn't echo the
      // server name, so surface the id (name isn't shown by the CLI's join
      // output — `{ server }` is passed through, and id is the stable locator).
      const body = await rest<{ member: { userName?: string | null }; serverId: string }>(
        "POST",
        `/api/community/invites/${encodeURIComponent(r.invite)}/join`,
        "joinServer",
      );
      return { server: { id: body.serverId, name: body.serverId } };
    },
    attachmentUpload: callUpload,
    attachmentDownload: callDownload,
    reactAdd: (r: { messageId: string; emoji: string }) =>
      rest<CommunityAgentReactAddResponse>(
        "PUT",
        `/api/community/messages/${encodeURIComponent(r.messageId)}/reactions/${encodeURIComponent(r.emoji)}`,
        "reactAdd",
      ),
    friendRequest: (r: { agentId: AgentId; username: string }) =>
      call<FriendRequestResult>("friendRequest", r),
    listFriends: (r: { agentId: AgentId }) =>
      call<{ accepted: FriendCard[]; pendingOutgoing: FriendCard[]; pendingIncoming: FriendCard[] }>(
        "listFriends",
        r,
      ),
  };
}
