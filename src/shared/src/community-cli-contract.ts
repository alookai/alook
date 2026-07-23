/**
 * Server API contract — the agent ⇄ server boundary.
 *
 * This is the single shared contract that BOTH sides implement against:
 *   - the **agent CLI** (the client) calls these methods;
 *   - a **server** (real Alook, or the local mock for tests) answers them.
 *
 * Lifted from `src/daemon/src/server/contract.ts` into `@alook/shared` so the
 * real server routes (`src/web`) and the wake producer/consumer
 * (`src/web`, `src/wake-worker`) can share the exact same types the daemon's
 * CLI and mock server already implement against. `src/daemon`'s
 * `contract.ts` re-exports everything from here — see that file.
 *
 * Domain model (Alook is Discord-like):
 *   User ──< Agent ──< (participates in) Server/workspace ──< Channel ──< Message
 *   - one User owns many Agents;
 *   - one Agent participates in many Servers (workspaces);
 *   - one Server has many Channels (+ DMs + threads);
 *   => because an agent spans multiple servers, **every Target carries a
 *      `server` reference** (a bare `#channel` would be ambiguous across servers).
 *
 * IDs are **nanoid** strings (not UUIDs).
 */

import type { RuntimeConfig } from "./runtime-config";
import type { ChannelType } from "./utils/community-roles";

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
 * The DM pseudo-server segment. DMs are standalone and global (Discord-style) —
 * not under any real server. In a path ref the DM "server" segment is `.dm`.
 */
export const DM_SERVER = ".dm";

/**
 * A path-style channel/target ref string — the ONE addressing grammar exposed
 * to the agent. Plain and direct:
 *
 *     /<server>/<channel>            a channel
 *     /<server>/<channel>#N          the N-th message (seq) in that channel
 *     /<server>/<channel>/#N         the thread rooted at message #N
 *     /.dm/<peer>                    a DM (DM is the standalone `.dm` server);
 *                                    <peer> is the peer's global handle
 *                                    (`name#0042`, e.g. `/.dm/gusye#1231`),
 *                                    NOT a raw user id — see `parseRef`'s
 *                                    `.dm`-specific branch below.
 *     /.dm/<peer>#N , /.dm/<peer>/#N a DM message / DM thread
 *
 * A message is located by **channel + seq** (`<channelRef>#N`) — there is no id.
 *
 * `<server>`/`<channel>` are server/channel display *names*, guaranteed free
 * of whitespace, `/`, and `#` (normalized via `slugify()` at creation/rename
 * time), so each segment is always a single, unambiguous token.
 */
export type ChannelRef = string;

/**
 * Structured form of a target, kept for internal routing/resolution. The wire/
 * agent-facing form is the `ChannelRef` path string above; `parseRef`/`formatRef`
 * convert between them.
 */
export type Target =
  | { server: ServerId; kind: "channel"; channel: ChannelId | string }
  | { server: typeof DM_SERVER; kind: "dm"; peer: AgentId | UserId | string /** global handle (`name#0042`) on the wire; resolved server-side to a real id */ }
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
 *   - `channel` — the path ref, e.g. "/demo-workspace/general" or "/.dm/gustavo#4821".
 *   - `sender`  — "@handle" (`name#0042`, no id, no human/agent/system type).
 *   - `content` — `{ text }` today; an object (not a bare string) so future
 *                 content kinds (attachments, embeds, …) can be added without
 *                 breaking the shape.
 *   - `time`    — ISO-8601 timestamp.
 * No `id`, no `type`.
 */
/**
 * Read-side attachment ref surfaced by inbox pull / send response / resolve.
 * Bots only ever see id + friendly metadata; the routable URL, R2 key, and
 * per-uploader scope are server-only. `contentType` is `string | null` here
 * (matches legacy rows whose stored content_type was null); the write-side
 * upload/download response coerces to `"application/octet-stream"` so bots
 * have a non-null contract for their own writes.
 */
export interface AgentAttachmentRef {
  id: string;
  filename: string;
  contentType: string | null;
  size: number | null;
}

export interface MessageContent {
  text: string;
  /** Populated only on the read side (`inboxPull`, `send` response, `resolve`). */
  attachments?: AgentAttachmentRef[];
  /** Future: embeds, etc. — added without breaking `text`. */
  [extra: string]: unknown;
}

/** Local file to upload, as read by the daemon before hitting the wire. */
export type FileHandle = {
  data: Blob | Uint8Array;
  filename: string;
  contentType?: string;
};

export type AgentAttachmentUploadResult = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
};

export type AgentAttachmentDownloadResult = {
  path: string;
  filename: string;
  contentType: string;
  size: number;
};

export interface Message {
  /** Per-channel sequence in display form, e.g. "#12". */
  seq: string;
  /** Path ref of the containing channel/DM. */
  channel: ChannelRef;
  /** Sender global handle (`name#0042`), e.g. "@gustavo#4821". */
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
   * Attachment ids returned by prior `attachmentUpload` calls. Order matters —
   * position on the resulting message is stamped left-to-right (0-indexed).
   */
  attachments?: string[];
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
 * Upload a local file as a pending attachment for a future `send`. The returned
 * id is the same one that surfaces on the sent message (id continuity across
 * pending → persisted lifecycle).
 */
export interface AttachmentUploadRequest {
  agentId: AgentId;
  target: ChannelRef;
  file: FileHandle;
}

export interface AttachmentDownloadRequest {
  agentId: AgentId;
  id: string;
  destPath: string;
}

/**
 * Sent: the message landed. Blocked: the channel has unseen messages the agent
 * must align to first (pull, then resend) — `latestSeq` is the current waterline.
 */
export type SendResponse =
  | { state: "sent"; message: Message }
  | { state: "blocked"; reason: "unaligned"; unreadCount: number; latestSeq: Seq };

export interface CommunityAgentReactAddResponse {
  ok: true;
  duplicate?: boolean;
}

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

/**
 * One channel as surfaced to the agent CLI (`channel list`). Deliberately
 * drops `id`/`serverId`/`kind` — every other agent-facing command addresses
 * channels by `ChannelRef`, never by raw id, so `ref` is the only locator an
 * agent needs (and is directly reusable as `--channel`/`--target`). `type`
 * is real per-row data (`"text"` vs `"forum"`), not the always-`"channel"`
 * `kind` the old shape hardcoded. `visibility` is derived from the channel's
 * category — `"private"` iff the row's category has `private = 1`, else
 * `"public"` — and lets the agent decide whether to enumerate members via
 * `channel member` or fall back to `server member`.
 */
export interface ChannelListItem {
  ref: ChannelRef;
  name: string;
  type: ChannelType;
  visibility: "public" | "private";
}

/**
 * A category as surfaced to the agent CLI (`channel list`). Wire-only,
 * de-normalized on read — the agent never addresses a category by id, so
 * category ids are NOT emitted. `private` mirrors `community_category.private`.
 */
export interface CategoryRef {
  name: string;
  private: boolean;
}

/**
 * One category-bucketed group of channels in `channel list`'s grouped
 * response. `category === null` is the uncategorized bucket (Discord-style,
 * emitted first).
 */
export interface ChannelGroup {
  category: CategoryRef | null;
  channels: ChannelListItem[];
}

/**
 * `alook channel member` result — a public channel/forum returns a hint
 * pointing at `alook server member` (no roster enumeration); everything else
 * (private channel, private forum, forum post, thread) returns the concrete
 * roster.
 */
export type ChannelMemberResult =
  | { visibility: "public"; hint: string }
  | { visibility: "private"; members: ServerMember[] };

/** One server member, as surfaced to the agent CLI (`server member`). */
export interface ServerMember {
  /** "name#0042" — always via `formatHandle`, never a bare name. */
  handle: string;
  /** "owner" | "admin" | "member" — never null on the wire (defaults to "member"). */
  role: string;
  nickname?: string;
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

  /** Channels visible to the agent, grouped by category, optionally scoped to one server. */
  listChannels(req: ListChannelsRequest): Promise<{ groups: ChannelGroup[] }>;

  /**
   * Members visible to the agent for a channel/thread ref. Public top-level
   * channels/forums return a hint pointing at `alook server member`; private
   * channels, private forums, forum posts, and threads (regardless of parent
   * visibility) return the concrete roster.
   */
  channelMember(req: { agentId?: AgentId; channel: ChannelRef }): Promise<ChannelMemberResult>;

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

  /** Members of a server, resolved by id-or-name (never id-only, never name-only). */
  listMembers(req: { agentId: AgentId; server: string }): Promise<{ members: ServerMember[] }>;

  /** Join a server via an invite link/token. Throws on any rejection — see plan's I/O contract. */
  joinServer(req: { agentId: AgentId; invite: string }): Promise<{ server: Server }>;

  /** Upload a local file as a pending attachment scoped to `target`. */
  attachmentUpload(req: AttachmentUploadRequest): Promise<AgentAttachmentUploadResult>;

  /** Download an attachment by id, writing to `destPath` (atomic temp-then-rename). */
  attachmentDownload(req: AttachmentDownloadRequest): Promise<AgentAttachmentDownloadResult>;

  /** React to a message with a single emoji. Duplicates are idempotent (`duplicate:true`, no fan-out). */
  reactAdd(req: { channel: ChannelRef; seq: Seq; emoji: string }): Promise<CommunityAgentReactAddResponse>;
}

/* ------------------------------------------------------------------ */
/* Unread wake notice                                                  */
/* ------------------------------------------------------------------ */

/**
 * A bodiless "you have unread work" signal — deliberately carries no message
 * content. The daemon turns this into a fixed inbox-pull prompt; the agent
 * must call `inboxPull` to fetch the actual message content from the server,
 * which remains the only source of truth for message bodies.
 */
export interface UnreadNotice {
  kind: "unread_notice";
  /** Path ref of the scope with unread work (channel, thread, or DM). */
  channel: ChannelRef;
  /** The high-water seq that triggered this notice, for `AgentMsg.seq`. */
  latestSeq: Seq;
  /**
   * When the notice targets a DM, the DM's conversation id. Populated
   * server-side (`buildUnreadWakeCommand`) so the daemon can emit
   * `agent_typing` frames for the correct DM scope without parsing
   * `channel: ChannelRef` (a peer-handle path). Absent for channel/thread
   * wakes — bot typing is DM-only for now.
   */
  dmConversationId?: string;
}

/* ------------------------------------------------------------------ */
/* Control plane — server → host commands                              */
/* ------------------------------------------------------------------ */

/**
 * Commands the SERVER pushes DOWN to a host (daemon). This is the control plane —
 * distinct from the agent-initiated data plane (`ServerApi`). The server owns
 * ADDRESSING: every command already names its recipient `agentId`; the host
 * never fans out by channel membership.
 *
 * `agent:wake` is the ONE semantic unread-wake command — "ensure this agent
 * handles unread work." The server/wake-worker does not decide whether a
 * daemon process is already running; that is daemon-owned state. The daemon
 * decides whether to spawn a fresh process, notify an already-running one, or
 * coalesce the notice for the next turn (see `AgentProcessManager`).
 */
export type HostCommand =
  | {
    type: "agent:wake";
    agentId: AgentId;
    /**
     * The full structured runtime configuration the server stores for this
     * agent (runtime / model / provider / mode / effort). The host resolves it
     * into launch fields — see `runtime-config.ts`.
     */
    config: RuntimeConfig;
    /** Resume an existing runtime session, if any (separate from RuntimeConfig). */
    sessionId?: string;
    /** Unique id for this wake/launch attempt (correlates host↔server). */
    launchId: string;
    /** The bodiless unread signal — the daemon prompts "pull your inbox". */
    unreadNotice: UnreadNotice;
  }
  | { type: "agent:stop"; agentId: AgentId }
  // ─── Bot lifecycle events (server → daemon) ────────────────────────────
  // Colon-namespaced to match the agent:* naming convention. Delivered to
  // the specific machine's daemon connection via the WS DO. On the daemon,
  // these mutate the in-memory `botsById` cache and trigger `manager.stop`
  // when a running bot's config changes.
  | {
    type: "bot:added";
    botId: AgentId;
    name: string;
    /** 4-digit tag (`computeDiscriminator`) — pairs with `name` for the bot's global handle. */
    discriminator: string;
    description?: string;
    /** The owning user's name + discriminator — pairs into the owner's global handle. Required — see BotAddedFrame. */
    ownerName: string;
    ownerDiscriminator: string;
  }
  | {
    type: "bot:updated";
    botId: AgentId;
    name: string;
    /** 4-digit tag (`computeDiscriminator`) — pairs with `name` for the bot's global handle. */
    discriminator: string;
    description?: string;
    /** The owning user's name + discriminator — pairs into the owner's global handle. Required — see BotUpdatedFrame. */
    ownerName: string;
    ownerDiscriminator: string;
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
 * Derived activity state for a bot, reported daemon → server. NOT a raw
 * passthrough of `AgentProcessManager`'s internal FSM status — see
 * `deriveActivity` in `src/daemon/src/manager/managerRuntime.ts`.
 */
export type AgentActivityState = "idle" | "starting" | "running" | "stopping";

/**
 * Bot audit-log event kinds/payloads mirrored from the wire zod schema
 * (`BotAuditEventSchema` in `./schemas.ts`). The daemon emits these upward
 * through `HostControlChannel.reportBotAuditEvent`; ws-do stamps `createdAt`
 * and appends to `community_bot_activity_event`.
 */
export type BotAuditEventPayload =
  | { kind: "cli_invocation"; payload: { subcommand: string } }
  | { kind: "tool_call"; payload: { name: string; target?: string } }
  | { kind: "thinking"; payload: { text: string; truncated: boolean; chars: number } }
  | {
      kind: "wake_trigger";
      payload: {
        messageId: string;
        channel: ChannelRef;
        seq: Seq;
        senderId: string;
        senderHandle: string;
        reason: "unread" | "mention";
      };
    };

export interface HostBotAuditEventFrame {
  type: "bot_audit_event";
  agentId: AgentId;
  sessionId?: string | null;
  launchId?: string | null;
  event: BotAuditEventPayload;
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
   * Reply to an `agent:wake` command with the wake outcome — "daemon
   * accepted/handled the wake command", NOT "process started" (a wake may
   * spawn, notify an already-running process, or coalesce for later).
   * Optional so the local mock channel can omit it.
   */
  reportWakeAck?(info: {
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
   * can't fulfil an `agent:wake` (e.g. runtime not installed) — the server
   * routes the frame through the machine DO which stashes it as an overlay
   * on the machine summary so the web card renders it inline.
   */
  reportSessionError?(frame: SessionErrorFrame): Promise<void>;
  /**
   * Report a bot's derived activity state after it changes. Optional so the
   * local mock channel can omit it.
   */
  reportAgentActivity?(info: { agentId: AgentId; state: AgentActivityState }): Promise<void>;
  /**
   * Emit an `agent_typing` frame for the given (agentId, dmConversationId)
   * scope — the daemon-metered heartbeat that keeps the "bot is typing…" pill
   * lit for a working bot. Optional so LocalControlChannel can omit.
   */
  reportAgentTyping?(info: { agentId: AgentId; dmConversationId: string }): void;
  /**
   * Emit an `agent_typing_stop` frame for the given scope — one-shot on turn
   * end so the pill disappears immediately instead of dangling until the
   * client's 8s auto-expire. Optional so LocalControlChannel can omit.
   */
  reportAgentTypingStop?(info: { agentId: AgentId; dmConversationId: string }): void;
  /**
   * Report a bot audit event (cli_invocation | tool_call | thinking) upward.
   * Optional so LocalControlChannel can omit — matches `reportAgentActivity?`
   * convention. ws-do stamps `createdAt` and enforces the 500-row retention.
   */
  reportBotAuditEvent?(frame: HostBotAuditEventFrame): Promise<void>;
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
 * Server-side provisioning, separate from the agent's daily `ServerApi`. Used
 * in production by privileged callers to create servers/agents/channels and
 * inject messages. `postMessage` writes
 * the message; real deployments separately enqueue an `agent:wake` for any
 * bot behind on the new message (see `src/web`'s wake producer +
 * `src/wake-worker`'s consumer) — this admin surface does not itself compute
 * or dispatch control-plane commands.
 */
export interface AdminApi {
  /** Create a user (owner of agents). */
  createUser(req: { name: string }): Promise<{ user: User }>;
  /**
   * Create an agent. An agent is a USER's asset and exists independently of any
   * server — it joins servers later via `addAgentToServer`. No server here.
   *
   * `machineKey` optionally binds the agent to that machine (mirrors production's
   * bot↔machine binding), enabling `EnrollmentApi.mintAgentCredential` to reject
   * a mint from a different machine. Omitting it leaves the agent unbound.
   */
  createAgent(req: {
    userId: UserId;
    name: string;
    runtime?: string;
    instruction?: string;
    machineKey?: string;
  }): Promise<{ agent: Agent }>;
  createServer(req: { name: string }): Promise<{ server: Server }>;
  /** Membership is a separate agent↔server relation; an agent may join many. */
  addAgentToServer(req: { agentId: AgentId; server: ServerId }): Promise<void>;
  createChannel(req: { server: ServerId; name: string; kind?: ChannelKind }): Promise<{ channel: Channel }>;
  /** Inject a message into a channel (as a human/agent), triggering delivery. */
  postMessage(req: { channel: ChannelRef; sender: string; text: string }): Promise<{ message: Message }>;
  /** Provisioning/test surface: mint an invite token for `server join` to consume. */
  createInvite(req: { server: ServerId; createdBy: UserId }): Promise<{ token: string }>;
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
   * Implementations MUST also enforce that `agentId` is bound to THIS machine
   * (404 if bound elsewhere or unbound) — see the production `enroll-agent`
   * route's binding check.
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
 *   /<server>/<channel>/#N#M     → { server, channel, threadRootSeq:N, seq:M }
 *   /.dm/<peer>[...]             → DM (server = ".dm", channel = peer, a
 *                                  `name#0042` handle) — see the `.dm`-specific
 *                                  branch below, which differs from the
 *                                  generic channel-ref `#`-split (a handle's
 *                                  `#0042` suffix must NOT be mistaken for a
 *                                  pinned-message seq).
 */
export function parseRef(ref: ChannelRef): ParsedRef {
  if (!ref.startsWith("/")) throw new Error(`ref must start with "/": ${ref}`);
  const body = ref.slice(1);
  const parts = body.split("/");
  if (parts.length < 2) throw new Error(`ref needs /<server>/<channel>: ${ref}`);
  const server = parts[0];
  // Trailing "#N" on the last segment pins a message seq.
  let seq: Seq | undefined;

  // Thread form: /server/channel/#N or /server/channel/#N#M  → last part
  // starts with "#". `#M` (when present) is the message seq WITHIN the
  // thread channel's own seq space.
  if (parts.length >= 3 && parts[parts.length - 1].startsWith("#")) {
    const tail = parseThreadTail(parts[parts.length - 1]);
    return { server, channel: parts[1], ...tail };
  }
  const chSeg = parts[1];

  // DM-specific branch: a DM peer segment is a `name#0042` handle, not a bare
  // channel name — the generic "first #" split below would mis-parse
  // `gusye#1231` as peer="gusye", seq=1231. Find the LAST "#" instead: if
  // there's exactly one "#" in the segment and the tail is exactly 4 digits,
  // the WHOLE segment is the handle (the common case). Otherwise (2+ "#"s,
  // or a non-4-digit tail) the text after the last "#" is a seq/thread root,
  // matching `gusye#1231#42` (pin) / `gusye#1231/#42` (thread, handled by the
  // thread-form branch above) — see plan §1 for the accepted `a#b` ambiguity.
  if (server === DM_SERVER) {
    const lastHash = chSeg.lastIndexOf("#");
    if (lastHash < 0) return { server, channel: chSeg };
    const firstHash = chSeg.indexOf("#");
    const tail = chSeg.slice(lastHash + 1);
    const isBareHandle = firstHash === lastHash && /^\d{4}$/.test(tail);
    if (isBareHandle) return { server, channel: chSeg };
    // A non-numeric tail after the last `#` isn't a valid seq — rather
    // than throwing (which crashes every caller not wrapped in
    // try/catch), fall back to treating the whole segment as the
    // channel/handle. The resolution layer (`parseNameAndTag` in
    // `resolve-ref.ts`) still rejects the shape cleanly with a 400,
    // instead of a 500 from a raw throw.
    const tailNum = Number(tail.startsWith("#") ? tail.slice(1) : tail);
    if (!Number.isFinite(tailNum)) return { server, channel: chSeg };
    seq = parseSeq(tail);
    return { server, channel: chSeg.slice(0, lastHash), seq };
  }

  // Message form: /server/channel#N (channel segment carries the #N).
  const hashIdx = chSeg.indexOf("#");
  if (hashIdx >= 0) {
    seq = parseSeq(chSeg.slice(hashIdx));
    return { server, channel: chSeg.slice(0, hashIdx), seq };
  }
  return { server, channel: chSeg };
}

/**
 * Split the trailing thread segment (`#N` or `#N#M`) of a thread-form ref
 * into a `{ threadRootSeq, seq? }` pair. Called with the raw last segment
 * (leading `#` present).
 *
 * Every token that reaches `parseSeq` here must first be checked for empty:
 * a naive `Number("") === 0` would otherwise silently accept `##5` as
 * `{ threadRootSeq:0, seq:5 }` or `#5#` as `{ threadRootSeq:5, seq:0 }` and
 * hand a bogus seq to the wire. Explicit `#0#5` / `#5#0` remain permissive
 * — the server rejects seq/root 0 at `resolve-ref.ts`.
 */
function parseThreadTail(segment: string): { threadRootSeq: Seq; seq?: Seq } {
  const stripped = segment.startsWith("#") ? segment.slice(1) : segment;
  const tokens = stripped.split("#");
  if (tokens.length < 1 || tokens.length > 2) {
    throw new Error(`bad thread ref tail: #${stripped}`);
  }
  for (const t of tokens) {
    if (!t) throw new Error(`bad thread ref tail: #${stripped} (empty seq)`);
  }
  const threadRootSeq = parseSeq(tokens[0]);
  if (tokens.length === 1) return { threadRootSeq };
  return { threadRootSeq, seq: parseSeq(tokens[1]) };
}

/**
 * Format a ParsedRef back to a path ref. Valid combinations:
 *   {}                             → /server/channel
 *   { threadRootSeq }              → /server/channel/#N
 *   { threadRootSeq, seq }         → /server/channel/#N#M
 * A bare `seq` (no `threadRootSeq`) is NOT supported — the message form
 * `/server/channel#N` puts `#N` on the channel segment, not on a trailing
 * path segment, and no caller needs to emit that shape via formatRef today.
 */
export function formatRef(p: {
  server: string;
  channel: string;
  threadRootSeq?: Seq;
  seq?: Seq;
}): ChannelRef {
  if (p.seq !== undefined && p.threadRootSeq === undefined) {
    throw new Error("formatRef: seq without threadRootSeq is not supported");
  }
  const base = `/${p.server}/${p.channel}`;
  if (p.threadRootSeq === undefined) return base;
  if (p.seq === undefined) return `${base}/#${p.threadRootSeq}`;
  return `${base}/#${p.threadRootSeq}#${p.seq}`;
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
