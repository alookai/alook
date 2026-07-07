/**
 * Server API contract — the agent ⇄ server boundary.
 *
 * This is the single shared contract that BOTH sides implement against:
 *   - the **agent CLI** (the client) calls these methods;
 *   - a **server** (real Alook, or the local mock for tests) answers them.
 *
 * Defining it here lets the CLI and the mock server be built independently and
 * integration-tested against the same types.
 *
 * Domain model (server/channel/message hierarchy):
 *   User ──< Agent ──< (participates in) Server/workspace ──< Channel ──< Message
 *   - one User owns many Agents;
 *   - one Agent participates in many Servers (workspaces);
 *   - one Server has many Channels (+ DMs + threads);
 *   => because an agent spans multiple servers, **every Target carries a
 *      `server` reference** (a bare `#channel` would be ambiguous across servers).
 *
 * IDs are **nanoid** strings (not UUIDs).
 */

/* ------------------------------------------------------------------ */
/* Identifiers                                                         */
/* ------------------------------------------------------------------ */

/** All ids are nanoid strings. Aliased for intent at call sites. */
export type Id = string;
export type UserId = Id;
export type AgentId = Id;
export type ServerId = Id;
export type ChannelId = Id;
export type MessageId = Id;

/**
 * Per-target monotonically increasing sequence number. Unique and ordered
 * WITHIN a target (channel/dm/thread), not globally. Used for ordering,
 * pagination anchors, and ack waterlines.
 */
export type Seq = number;

/* ------------------------------------------------------------------ */
/* Entity hierarchy                                                    */
/* ------------------------------------------------------------------ */

export interface User {
  id: UserId;
  name: string;
}

export interface Agent {
  id: AgentId;
  name: string;
  /** The User that owns this agent. */
  userId: UserId;
}

/** A server == a workspace. An agent participates in many of these. */
export interface Server {
  id: ServerId;
  name: string;
}

export type ChannelKind = "channel" | "dm";

export interface Channel {
  id: ChannelId;
  /** The server this channel belongs to — always present. */
  serverId: ServerId;
  name: string;
  kind: ChannelKind;
  visibility?: "public" | "private";
  description?: string;
}

export type SenderType = "human" | "agent" | "system";

export interface Sender {
  id: Id;
  type: SenderType;
  name: string;
  /** Optional title/role text. */
  description?: string;
}

/* ------------------------------------------------------------------ */
/* Target — path-style, server-scoped addressing                      */
/* ------------------------------------------------------------------ */

/**
 * The DM pseudo-server segment. DMs are standalone and global — not under any
 * real server. In a path ref the DM "server" segment is `.dm`.
 */
export const DM_SERVER = ".dm";

/**
 * A path-style channel/target ref string — the ONE addressing grammar exposed
 * to the agent. Plain and direct:
 *
 *     /<server>/<channel>            a channel
 *     /<server>/<channel>#N          the N-th message (seq) in that channel
 *     /<server>/<channel>/#N         the thread rooted at message #N
 *     /.dm/<peer>                    a DM (DM is the standalone `.dm` server)
 *     /.dm/<peer>#N , /.dm/<peer>/#N a DM message / DM thread
 *
 * A message is located by **channel + seq** (`<channelRef>#N`) — there is no id.
 */
export type ChannelRef = string;

/**
 * Structured form of a target, kept for internal routing/resolution. The wire/
 * agent-facing form is the `ChannelRef` path string above; `parseRef`/`formatRef`
 * convert between them.
 */
export type Target =
  | { server: ServerId; kind: "channel"; channel: ChannelId | string }
  | { server: typeof DM_SERVER; kind: "dm"; peer: AgentId | UserId | string }
  | {
      server: ServerId | typeof DM_SERVER;
      kind: "thread";
      /** The parent channel (or DM peer) the thread hangs under. */
      parentChannel: ChannelId | string;
      /** Seq of the root message the thread is rooted at. */
      rootSeq: Seq;
    };

/* ------------------------------------------------------------------ */
/* Message                                                             */
/* ------------------------------------------------------------------ */

/**
 * The flat, agent-facing message. This is exactly what the agent sees (one JSON
 * object per line, JSONL). Deliberately minimal:
 *   - `seq`     — "#N", the per-channel sequence (locate via channel + seq).
 *   - `channel` — the path ref, e.g. "/demo-workspace/general" or "/.dm/gustavo".
 *   - `sender`  — "@handle" (no id, no human/agent/system type).
 *   - `content` — `{ text }` today; an object (not a bare string) so future
 *                 content kinds (attachments, embeds, …) can be added without
 *                 breaking the shape.
 *   - `time`    — ISO-8601 timestamp.
 * No `id`, no `type`.
 */
export interface MessageContent {
  text: string;
  /** Future: attachments, embeds, etc. — added without breaking `text`. */
  [extra: string]: unknown;
}

export interface Message {
  /** Per-channel sequence in display form, e.g. "#12". */
  seq: string;
  /** Path ref of the containing channel/DM. */
  channel: ChannelRef;
  /** Sender handle, e.g. "@gustavo". */
  sender: string;
  content: MessageContent;
  /** ISO-8601. */
  time: string;
}

/* ------------------------------------------------------------------ */
/* Cursors & pagination                                                */
/* ------------------------------------------------------------------ */

/**
 * Per-channel read/ack waterline. `channel` is the path ref; `seq` is the
 * numeric high-water mark consumed.
 */
export interface Cursor {
  channel: ChannelRef;
  seq: Seq;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  /** Seq of the newest item in this page, for advancing a cursor. */
  latestSeq?: Seq;
}

/* ------------------------------------------------------------------ */
/* Inbox projection                                                    */
/* ------------------------------------------------------------------ */

export type InboxFlag = "dm" | "thread" | "mention" | "task";

/** One per channel with pending unread, summarizing the unread without bodies. */
export interface InboxRow {
  channel: ChannelRef;
  pendingCount: number;
  firstPendingSeq?: Seq;
  latestSeq?: Seq;
  latestSender?: string;
  flags: InboxFlag[];
}

export interface InboxSnapshot {
  rows: InboxRow[];
  /** rows.length. */
  pendingChannels: number;
  /** Sum of pendingCount across rows. */
  pendingMessages: number;
}

/* ------------------------------------------------------------------ */
/* Request / response shapes                                           */
/* ------------------------------------------------------------------ */

export interface InboxPullRequest {
  agentId: AgentId;
  /** Optional: limit how many full messages to drain (inbox notice is unbounded). */
  max?: number;
}
export interface InboxPullResponse {
  /** Flat agent-facing messages drained this pull (JSONL on the wire). */
  messages: Message[];
  /** Whether more unread remain beyond `max`. */
  hasMore: boolean;
}

export interface AckRequest {
  agentId: AgentId;
  /** Per-channel waterlines consumed; server advances each channel's read marker. */
  cursors: Cursor[];
}

export interface SendRequest {
  agentId: AgentId;
  /** Path ref of the destination channel/DM/thread. */
  channel: ChannelRef;
  content: MessageContent;
  /**
   * Last seq the agent had seen for this channel — the CHANNEL ALIGNMENT signal.
   * If the server has newer messages the agent hasn't seen, the send is BLOCKED
   * (see below): the agent must `inboxPull`/`read` to align, then resend. There
   * is no bypass — alignment is a hard precondition, so a blanket "force" flag
   * can't render it moot.
   */
  seenUpToSeq?: Seq;
}

/**
 * Sent: the message landed. Blocked: the channel has unseen messages the agent
 * must align to first (pull, then resend) — `latestSeq` is the current waterline.
 */
export type SendResponse =
  | { state: "sent"; message: Message }
  | { state: "blocked"; reason: "unaligned"; unreadCount: number; latestSeq: Seq };

export interface ReadRequest {
  agentId: AgentId;
  channel: ChannelRef;
  /** Anchor by seq; pick at most one of before/after/around. */
  before?: Seq;
  after?: Seq;
  around?: Seq;
  limit?: number;
}

/** Locate one message by channel + seq (there is no message id). */
export interface ResolveRequest {
  agentId: AgentId;
  channel: ChannelRef;
  seq: Seq;
}

export interface ListChannelsRequest {
  agentId: AgentId;
  /** Restrict to one server; omit to list across all servers the agent is in. */
  server?: ServerId;
}

/* ------------------------------------------------------------------ */
/* The ServerApi contract                                              */
/* ------------------------------------------------------------------ */

/**
 * What the CLI calls and the (real or mock) server implements. All methods are
 * async (network on the real side, in-memory on the mock).
 *
 * MVP = inboxPull / ack / send / read / listServers / listChannels.
 * Everything else (tasks, attachments, reminders, search, profile, reactions)
 * is deferred — add to this interface as needed.
 *
 * Channels are addressed by `ChannelRef` path strings (see `parseRef`/`formatRef`);
 * messages by channel + seq. No structured Target or message id crosses the wire.
 */
export interface ServerApi {
  /** Which servers/workspaces this agent participates in. */
  listServers(req: { agentId: AgentId }): Promise<{ servers: Server[] }>;

  /** Channels (and DMs) visible to the agent, optionally scoped to one server. */
  listChannels(req: ListChannelsRequest): Promise<{ channels: Channel[] }>;

  /** Drain unread messages for this agent (across all its servers), flat JSONL. */
  inboxPull(req: InboxPullRequest): Promise<InboxPullResponse>;

  /** A bodiless summary of pending unread, bucketed per channel. */
  inboxSnapshot(req: { agentId: AgentId }): Promise<InboxSnapshot>;

  /** Advance per-channel read waterlines (so drained messages stop reappearing). */
  ack(req: AckRequest): Promise<void>;

  /** Send a message to a channel ref. May be held by the freshness guard. */
  send(req: SendRequest): Promise<SendResponse>;

  /** Read history for a channel with seq-anchored pagination. */
  read(req: ReadRequest): Promise<Page<Message>>;

  /** Look up a single message by channel + seq. */
  resolve(req: ResolveRequest): Promise<{ message: Message }>;
}

/* ------------------------------------------------------------------ */
/* Control plane — server → host commands                              */
/* ------------------------------------------------------------------ */

/**
 * Commands the SERVER pushes DOWN to a host (daemon). This is the control plane —
 * distinct from the agent-initiated data plane (`ServerApi`). The server owns
 * ADDRESSING: every `agent:deliver` already names its recipient `agentId`; the
 * host never fans out by channel membership.
 */
export type HostCommand =
  | {
      type: "agent:start";
      agentId: AgentId;
      /**
       * The full structured runtime configuration the server stores for this
       * agent (runtime / model / provider / mode / effort). The host resolves it
       * into launch fields — see `src/runtimeConfig.ts`.
       */
      config: import("../runtimeConfig").RuntimeConfig;
      /** Resume an existing runtime session, if any (separate from RuntimeConfig). */
      sessionId?: string;
      /** Optional triggering message delivered with the start. */
      wakeMessage?: Message;
      /**
       * Delivery id for `wakeMessage` (when present), so the host can ack it and
       * the server can redeliver the same id on no-ack (at-least-once + dedup).
       */
      deliveryId?: string;
      /** Unique id for this launch (correlates host↔server). */
      launchId: string;
    }
  | { type: "agent:stop"; agentId: AgentId }
  | {
      type: "agent:deliver";
      /** Pre-addressed by the server — host delivers to exactly this agent. */
      agentId: AgentId;
      message: Message;
      /**
       * At-least-once delivery id. The host acks it (`agent:deliver:ack`) once the
       * message is accepted; the server redelivers the SAME id until acked, and the
       * host dedups by id so the agent never sees a duplicate wake.
       */
      deliveryId: string;
    }
  // ─── Bot lifecycle events (server → daemon) ────────────────────────────
  // Colon-namespaced to match the agent:* naming convention. Delivered to
  // the specific machine's daemon connection via the WS DO. On the daemon,
  // these mutate the in-memory `botsById` cache and trigger `manager.stop`
  // when a running bot's config changes.
  | {
      type: "bot:added";
      botId: AgentId;
      name: string;
      description?: string;
    }
  | {
      type: "bot:updated";
      botId: AgentId;
      name: string;
      description?: string;
    }
  | {
      type: "bot:removed";
      botId: AgentId;
    };

/**
 * Runtime descriptor carried by every `ready` frame. `status` defaults to
 * "healthy" on the wire schema (see CommunityMachineRuntimeSchema) so an
 * older daemon that only sends {id, version} still parses; a newer daemon
 * carries per-runtime health so /community can flag broken runtimes without
 * a machine-level offline signal.
 */
export interface HostReadyRuntime {
  id: string;
  version?: string;
  status?: "healthy" | "unhealthy";
  lastError?: string;
  lastErrorAt?: string;
}

/** What the host reports to the server on connect (the registration handshake). */
export interface HostReady {
  /**
   * Runtime descriptors. Legacy `runtimes: string[]` has been dropped from
   * the wire — `MIN_CLI_VERSION` gates old daemons off. The daemon MUST ship
   * every runtime it knows about (healthy AND unhealthy) — filtering is a
   * reader-side concern (server-side bot-create validator, client picker).
   */
  runtimeReport: HostReadyRuntime[];
  /** Agents currently running on this host. */
  runningAgents: AgentId[];
  hostname?: string;
  /** `process.platform` value (darwin/linux/win32). Named `platform` to match the shared wire schema. */
  platform?: string;
  arch?: string;
  osRelease?: string;
  daemonVersion?: string;
}

/**
 * `session.error` frame — daemon → server. Currently used by the daemon's
 * agent router when a runtime isn't available on the host.
 */
export interface SessionErrorFrame {
  type: "session.error";
  code: "runtime_not_available";
  agentId?: AgentId;
  payload?: Record<string, unknown>;
}

/**
 * The host's view of the control connection: subscribe to server commands, and
 * report readiness / session state up. A local mock host and a real WebSocket
 * host both implement this.
 */
export interface HostControlChannel {
  /** Register the handler for inbound server→host commands. */
  onCommand(cb: (cmd: HostCommand) => void | Promise<void>): void;
  /** Announce this host + its agents to the server (on connect AND on reconnect). */
  reportReady(ready: HostReady): Promise<void>;
  /**
   * On-demand resend of the current `ready` snapshot. Used by AgentRouter's
   * runtime-health mutations to push an updated report without waiting for a
   * reconnect. No-ops when the socket isn't open — the next resyncOnConnect
   * emits the live snapshot anyway. Optional so LocalControlChannel can omit.
   */
  sendReady?(ready: HostReady): void;
  /** Report an agent's runtime session id (after it starts / resumes). */
  reportAgentSession(info: { agentId: AgentId; sessionId: string; launchId: string }): Promise<void>;
  /**
   * Acknowledge an at-least-once delivery so the server stops redelivering it.
   * `status`/`error` are additive — existing callers passing only
   * `{ agentId, deliveryId }` still work; the server side reads them when
   * present to report an error inline.
   */
  reportDeliverAck(info: {
    agentId: AgentId;
    deliveryId: string;
    status?: "ok" | "error";
    error?: { code: string; message: string };
  }): Promise<void>;
  /**
   * Reply to an `agent:start` command with the launch outcome. New in v0.2.
   * Optional so the local mock channel can omit it.
   */
  reportStartedAck?(info: {
    agentId: AgentId;
    launchId: string;
    status: "ok" | "error";
    error?: { code: string; message: string };
  }): Promise<void>;
  /**
   * Reply to an `agent:stop` command with the stop outcome. New in v0.2.
   */
  reportStoppedAck?(info: {
    agentId: AgentId;
    status: "ok" | "error";
    error?: { code: string; message: string };
  }): Promise<void>;
  /**
   * Report a `session.error` upward. Used by `AgentRouter` when a driver
   * can't fulfil an `agent:start` (e.g. runtime not installed) — the server
   * routes the frame through the machine DO which stashes it as an overlay
   * on the machine summary so the web card renders it inline.
   */
  reportSessionError?(frame: SessionErrorFrame): Promise<void>;
  /**
   * Register a resync provider invoked on every (re)connect: it returns the
   * host's current `ready` snapshot + live agent sessions, which the channel
   * re-sends so the server can recover this host's state after a drop. Optional
   * so the in-process `LocalControlChannel` (no reconnect) can omit it.
   */
  onResync?(provider: () => { ready: HostReady; sessions: AgentSessionReport[] }): void;
}

/** A live agent session the host replays to the server on (re)connect. */
export interface AgentSessionReport {
  agentId: AgentId;
  sessionId: string;
  launchId: string;
}

/* ------------------------------------------------------------------ */
/* WebSocket transport shim (shared by the ws control channel/server)  */
/* ------------------------------------------------------------------ */

/**
 * The minimal subset of a WebSocket both ws transports use — a single canonical
 * shape so the channel (client) and server side don't each redeclare it. Matches
 * the `ws` package's socket. `open`/`pong`/`ping` are only used by the client
 * side; a server-accepted socket simply never emits/needs them.
 */
export interface WebSocketLike {
  on(
    event: "open" | "close" | "error" | "message" | "pong" | "unexpected-response",
    cb: (...args: any[]) => void
  ): void;
  send(data: string): void;
  close(): void;
  ping?(): void;
}

/** Builds a client `WebSocketLike` for a url + headers (injected; no hard `ws` dep). */
export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

/* ------------------------------------------------------------------ */
/* Admin / test surface — provisioning (server-side)                   */
/* ------------------------------------------------------------------ */

/**
 * Server-side provisioning, separate from the agent's daily `ServerApi`. Used by
 * the test-server command surface (and, in production, by privileged callers) to
 * create servers/agents/channels and inject messages. `postMessage` is what
 * drives the control plane: the server computes recipients and emits
 * `agent:deliver` (preceded by `agent:start` for any agent not yet running).
 */
export interface AdminApi {
  /** Create a user (owner of agents). */
  createUser(req: { name: string }): Promise<{ user: User }>;
  /**
   * Create an agent. An agent is a USER's asset and exists independently of any
   * server — it joins servers later via `addAgentToServer`. No server here.
   */
  createAgent(req: { userId: UserId; name: string; runtime?: string; instruction?: string }): Promise<{ agent: Agent }>;
  createServer(req: { name: string }): Promise<{ server: Server }>;
  /** Membership is a separate agent↔server relation; an agent may join many. */
  addAgentToServer(req: { agentId: AgentId; server: ServerId }): Promise<void>;
  createChannel(req: { server: ServerId; name: string; kind?: ChannelKind }): Promise<{ channel: Channel }>;
  /** Inject a message into a channel (as a human/agent), triggering delivery. */
  postMessage(req: { channel: ChannelRef; sender: string; text: string }): Promise<{ message: Message }>;
  /**
   * Observability-only read of a channel's transcript, for test/provisioning
   * tooling (e.g. asserting what agents replied). This is NOT an agent action:
   * it carries no agent identity, advances no read waterline, and is unaffected
   * by channel alignment. It lives on the admin plane precisely so the agent
   * data plane (`ServerApi`) can stay "identity must come through the proxy" —
   * a test harness peeking at a transcript must not self-assert an agentId.
   */
  readChannel(req: { channel: ChannelRef; limit?: number }): Promise<Page<Message>>;
}

/* ------------------------------------------------------------------ */
/* Enrollment — the MACHINE credential surface (server-side)           */
/* ------------------------------------------------------------------ */

/**
 * The third server-side surface, distinct from `AdminApi` (administrator, creates
 * resources) and `ServerApi` (agent, authed by voucher). The caller here is a
 * **machine/daemon**, authed by its `machineKey`. It exists for the credential
 * bootstrap: an agent has no credential yet, and a daemon must not hold admin
 * powers — so a machine exchanges its machineKey for a per-agent **runner key**
 * (tier 2) for an agent it runs. The daemon feeds that runner key to its local
 * `CredentialBroker`, which mints the per-launch voucher (tier 3).
 *
 * Trust tiers: machine master key (tier 1, server-issued on enrollment) →
 * per-agent runner key (tier 2, this surface) → voucher (tier 3, broker).
 */
export interface EnrollmentApi {
  /**
   * Exchange a valid machine key for a per-agent runner credential. Validates the
   * machineKey (401 if unknown) and that the agent exists (404 if not). Returns a
   * scoped, revocable `sk_agent_` runner key the daemon's proxy swaps in.
   *
   * MVP: does NOT yet enforce that `agentId` is bound to this machine (no
   * machine↔agent assignment table) — TODO once that ownership model exists.
   */
  mintAgentCredential(req: { machineKey: string; agentId: AgentId }): Promise<{ runnerKey: string; expiresAt?: number }>;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export interface ServerApiError {
  /** Stable machine code, e.g. "NOT_FOUND", "AMBIGUOUS_REF", "FORBIDDEN". */
  code: string;
  message: string;
  /** Optional recovery hint. */
  suggestedNextAction?: string;
}

/* ------------------------------------------------------------------ */
/* ChannelRef <-> structured parsing                                   */
/* ------------------------------------------------------------------ */

/** A parsed channel ref: the channel location + an optional message seq (`#N`). */
export interface ParsedRef {
  /** Server segment (a real server id/name, or `.dm`). */
  server: string;
  /** Channel name (or DM peer when `server === DM_SERVER`). */
  channel: string;
  /** Thread root seq when the ref points into a thread (`/server/channel/#N`). */
  threadRootSeq?: Seq;
  /** Message seq when the ref pins a specific message (`/server/channel#N`). */
  seq?: Seq;
}

/**
 * Parse a path ref into its parts. Grammar:
 *   /<server>/<channel>          → { server, channel }
 *   /<server>/<channel>#N        → { server, channel, seq:N }
 *   /<server>/<channel>/#N       → { server, channel, threadRootSeq:N }
 *   /.dm/<peer>[...]             → DM (server = ".dm", channel = peer)
 */
export function parseRef(ref: ChannelRef): ParsedRef {
  if (!ref.startsWith("/")) throw new Error(`ref must start with "/": ${ref}`);
  const body = ref.slice(1);
  const parts = body.split("/");
  if (parts.length < 2) throw new Error(`ref needs /<server>/<channel>: ${ref}`);
  const server = parts[0];
  // Trailing "#N" on the last segment pins a message seq.
  let seq: Seq | undefined;
  let threadRootSeq: Seq | undefined;

  // Thread form: /server/channel/#N  → last part is "#N".
  if (parts.length >= 3 && parts[parts.length - 1].startsWith("#")) {
    threadRootSeq = parseSeq(parts[parts.length - 1]);
    return { server, channel: parts[1], threadRootSeq };
  }
  // Message form: /server/channel#N (channel segment carries the #N).
  const chSeg = parts[1];
  const hashIdx = chSeg.indexOf("#");
  if (hashIdx >= 0) {
    seq = parseSeq(chSeg.slice(hashIdx));
    return { server, channel: chSeg.slice(0, hashIdx), seq };
  }
  return { server, channel: chSeg };
}

/** Format the channel portion of a ParsedRef back to a path ref (no #seq). */
export function formatRef(p: { server: string; channel: string; threadRootSeq?: Seq }): ChannelRef {
  const base = `/${p.server}/${p.channel}`;
  return p.threadRootSeq !== undefined ? `${base}/#${p.threadRootSeq}` : base;
}

/** "#12" → 12 ; "12" → 12. */
export function parseSeq(s: string): Seq {
  const n = Number(s.startsWith("#") ? s.slice(1) : s);
  if (!Number.isFinite(n)) throw new Error(`bad seq: ${s}`);
  return n;
}

/** 12 → "#12". */
export function formatSeq(seq: Seq): string {
  return `#${seq}`;
}
