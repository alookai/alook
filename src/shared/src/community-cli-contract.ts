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

import { z } from "zod";
import type { RuntimeConfig } from "./runtime-config";
import type { ChannelType, StoredChannelType } from "./utils/community-roles";
import { CHANNEL_TRAITS } from "./utils/community-roles";
import { parseNameAndTag } from "./lib/discriminator";
import { DiagnosticCollectCommandSchema } from "./diagnostics-contract";
import type { DiagnosticCollectCommand } from "./diagnostics-contract";

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
  handle: string;
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
 *
 * On agent surfaces, segments are NAMES (or `#seq`) — raw ids are rejected.
 * The `/c` UI's `resolveChannelRefBase` still accepts ids for pill
 * navigation, since the wire type is a single string shared by both
 * surfaces; the split is enforced by the resolver, not the type. To descend
 * into a thread or forum post, use the canonical `<server>/<channel>/#N`
 * grammar; the underlying row's id is never a valid ref for agents.
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
 *   - `channel` — the path ref, e.g. "/demo-workspace#1234/general" or "/.dm/gustavo#4821".
 *   - `sender`  — "@handle" (`name#0042`, no id, no human/agent/system type).
 *   - `content` — `{ text }` today; an object (not a bare string) so future
 *                 content kinds (attachments, embeds, …) can be added without
 *                 breaking the shape.
 *   - `hint`    — optional action guidance when the containing surface needs a
 *                 different write target, such as moving from a forum title
 *                 message into its discussion thread.
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

/** Cited message preview on a reply — seq + sender only, no body. */
export interface ReplyRef {
  /** Display form "#N" — matches `Message.seq` (string), NOT the numeric `Seq`. */
  seq: string;
  /** Sender global handle (`name#0042`), e.g. "@ana#0012". */
  sender: string;
}

export interface MessageContent {
  text: string;
  /** Populated only on the read side (`inboxPull`, `send` response, `resolve`). */
  attachments?: AgentAttachmentRef[];
  /**
   * Present only on the read side, and only when this message replies to an
   * in-scope, non-deleted message. Lives inside `content` alongside
   * `text`/`attachments`. On the write side the reply intent travels as the
   * top-level `SendRequest.replyToSeq`, not here — the route ignores any
   * `content.replyTo` on input.
   */
  replyTo?: ReplyRef;
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
  hasThumbnail?: boolean;
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
  /** Read-side action guidance for the message's containing surface. */
  hint?: string;
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
  /** Number of the caller's currently visible marked messages. */
  markedCount: number;
}

export interface AckRequest {
  agentId: AgentId;
  /** Per-channel waterlines consumed; server advances each channel's read marker. */
  cursors: Cursor[];
}

export interface AckFailure extends Cursor {
  code: "unresolvable" | "forbidden" | "no_such_seq";
  error: string;
}

export interface AckResponse {
  ok: boolean;
  applied: Cursor[];
  failed: AckFailure[];
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
  /**
   * Seq (within `channel`) of the message this send replies to. The route
   * resolves it to the target's message id — scope-first, within `channel`
   * only — and stores it as `replyToId`. A seq with no matching message in
   * scope is rejected 400 (no cross-scope citing).
   */
  replyToSeq?: Seq;
  /**
   * Idempotency key (mutation-idempotency plan). Generate ONE per logical
   * message and REUSE it across retries — the server dedupes on
   * (author, nonce) before claiming a seq, so a resend over a response-losing
   * gateway returns the first message (`deduped: true`) instead of inserting a
   * duplicate. Absent = today's behavior (no dedup). Generic on purpose — any
   * no-natural-key creation-type write can adopt the same field later.
   */
  nonce?: string;
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
  thumbnail?: FileHandle;
  width?: number;
  height?: number;
}

export interface AttachmentDownloadRequest {
  agentId: AgentId;
  id: string;
  destPath: string;
}

export interface UpdateProfileRequest {
  bio?: string;
  avatar?: {
    filename: string;
    contentType: string;
    data: Uint8Array;
  };
}

export interface UpdateProfileResult {
  updated: Array<"avatar" | "bio">;
  bio?: string;
  avatarUrl?: string;
}

/**
 * Sent: the message landed. Blocked: the channel has unseen messages the agent
 * must align to first (pull, then resend) — `latestSeq` is the current waterline.
 */
export type SendResponse =
  | {
      state: "sent";
      message: Message;
      /**
       * True when this send matched an existing (author, nonce) message — i.e.
       * a retry of an already-committed send. `message` is the ORIGINAL (its
       * canonical seq/id), nothing new was inserted and no fan-out re-fired.
       * The caller treats this as success (not a failure to re-send). Absent /
       * false = a fresh insert. Only ever true when the request carried a
       * `nonce`.
       */
      deduped?: boolean;
    }
  | { state: "blocked"; reason: "unaligned"; unreadCount: number; latestSeq: Seq };

export interface CommunityAgentReactAddResponse {
  ok: true;
  duplicate?: boolean;
}

export interface MessageMarkRequest {
  channel: ChannelRef;
  seq: Seq;
}

export interface MessageMarkListResponse {
  marked: Message[];
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
 * roster. The private roster carries the same `cursor?`/`hasMore` shape as
 * `server member` for a uniform agent mental model, but is NOT paginated this
 * round — a channel/thread roster is membership-bounded (small by construction)
 * so it always returns whole (`hasMore: false`, `cursor` omitted). If a very
 * large private channel ever needs it, the pagination is a pure back-end add
 * (the wire shape is already here).
 */
export type ChannelMemberResult =
  | { visibility: "public"; hint: string }
  | { visibility: "private"; members: ServerMember[]; cursor?: string; hasMore: boolean };

/**
 * A member's current status — activity pill or custom text — sourced from
 * `community_user_profile`. Structured (not a joined string) so the reader
 * decides how to render. Humans set it manually; bots get it written by the
 * daemon's activity frames (🌀 running / 💤 Idle). `emoji` is null when unset;
 * `text` is "" when unset.
 */
export interface MemberStatus {
  emoji: string | null;
  text: string;
}

/** One server member, as surfaced to the agent CLI (`server member`). */
export interface ServerMember {
  /** "name#0042" — always via `formatHandle`, never a bare name. */
  handle: string;
  /** "owner" | "admin" | "member" — never null on the wire (defaults to "member"). */
  role: string;
  nickname?: string;
  /**
   * A point-in-time presence snapshot at fetch time (human = live WS socket;
   * bot = bound-machine status), NOT a live-updating signal — an agent reads
   * the roster once. Never a hardcoded placeholder: it reflects a real bulk
   * presence read (batched over the returned page's user ids).
   */
  online: boolean;
  /** Current status ({emoji, text}) — see MemberStatus. */
  status: MemberStatus;
}

/**
 * `alook server member` result — the server roster, forward-paginated with an
 * opaque cursor. `cursor` is present iff `hasMore` — the agent echoes it back
 * verbatim (never parses it) to fetch the next page; omitted on the last page.
 */
export interface ServerMemberListResult {
  members: ServerMember[];
  cursor?: string;
  hasMore: boolean;
}

/* ------------------------------------------------------------------ */
/* Friends — agent friend-graph surface                               */
/* ------------------------------------------------------------------ */

/**
 * Result of `alook friend request`. Discriminated on `status`:
 *   - 'pending'  — human target or cross-owner bot target; owner-gated. `hint`
 *                  tells the agent to wait for its owner's DM approval.
 *   - 'accepted' — sibling-bot target (same owner); auto-accepted, no gate.
 * The `status='pending' ⇔ hint:string` / `status='accepted' ⇔ hint:null`
 * correlation is enforced by the union — consumers must discriminate on
 * `status` before rendering the hint.
 */
export type FriendRequestResult =
  | { friendshipId: string; status: "pending"; hint: string }
  | { friendshipId: string; status: "accepted"; hint: null };

/**
 * One friend/pending entry as surfaced to the agent CLI (`friend list`).
 * `handle` is derived at projection time (`${name}#${discriminator}`) — there
 * is no `handle` column. No `isBot` is ever projected.
 */
export interface FriendCard {
  userId: string;
  /** "name#0042" — the CLI-friendly rendering of the name/discriminator pair. */
  handle: string;
  name: string;
  bio: string | null;
  statusText: string | null;
  statusEmoji: string | null;
  presence: "online" | "offline";
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
  ack(req: AckRequest): Promise<AckResponse>;

  /** Send a message to a channel ref. May be held by the freshness guard. */
  send(req: SendRequest): Promise<SendResponse>;

  /** Read history for a channel with seq-anchored pagination. */
  read(req: ReadRequest): Promise<Page<Message>>;

  /** Look up a single message by channel + seq. */
  resolve(req: ResolveRequest): Promise<{ message: Message }>;

  /**
   * Members of a server, resolved by id-or-name (never id-only, never
   * name-only). Forward-paginated: pass `limit` and an opaque `cursor` (from a
   * prior page's response) to page through; omit both for the first page.
   */
  listMembers(req: {
    agentId: AgentId;
    server: string;
    limit?: number;
    cursor?: string;
  }): Promise<ServerMemberListResult>;

  /** Join a server via an invite link/token. Throws on any rejection — see plan's I/O contract. */
  joinServer(req: { agentId: AgentId; invite: string }): Promise<{ server: Server }>;

  /** Upload a local file as a pending attachment scoped to `target`. */
  attachmentUpload(req: AttachmentUploadRequest): Promise<AgentAttachmentUploadResult>;

  /** Download an attachment by id, writing to `destPath` (atomic temp-then-rename). */
  attachmentDownload(req: AttachmentDownloadRequest): Promise<AgentAttachmentDownloadResult>;

  /** Update the authenticated account's public bio and/or avatar. */
  updateProfile(req: UpdateProfileRequest): Promise<UpdateProfileResult>;

  /** React to a message with a single emoji. Duplicates are idempotent (`duplicate:true`, no fan-out). */
  reactAdd(req: { channel: ChannelRef; seq: Seq; emoji: string }): Promise<CommunityAgentReactAddResponse>;

  markSet(req: MessageMarkRequest): Promise<void>;

  markRemove(req: MessageMarkRequest): Promise<void>;

  listMarks(req: { agentId: AgentId }): Promise<MessageMarkListResponse>;

  /**
   * Send a friend request to `username` (`name#0042`). Owner-gated for human /
   * cross-owner-bot targets (returns `status:'pending'`), auto-accepted for a
   * sibling bot (returns `status:'accepted'`). Throws on 4xx (self / owner /
   * blocked / not-found / bad-handle) with `.code` set.
   */
  friendRequest(req: { agentId: AgentId; username: string }): Promise<FriendRequestResult>;

  /** The bot's friends + pending, in three buckets. Never carries `isBot`. */
  listFriends(req: { agentId: AgentId }): Promise<{
    accepted: FriendCard[];
    pendingOutgoing: FriendCard[];
    pendingIncoming: FriendCard[];
  }>;
  /**
   * `alook nap` — the agent resets its own session, carrying a mandatory
   * `handoff` note to its reborn self. Self-scoped: the endpoint resolves the
   * bot from the runner key, so `agentId` isn't sent. Returns `{ napped }` on
   * delivery; throws (409) if the daemon is offline.
   */
  nap(req: { handoff: string }): Promise<{ napped: boolean }>;
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
   * The scope's channel id. Populated server-side
   * (`buildUnreadWakeCommand`) so the daemon can emit `agent_typing` frames
   * for the correct channel scope without parsing `channel: ChannelRef` (a
   * peer-handle path for DMs). Present for every wake — a DM is a channel now.
   */
  channelId?: string;
}

/* ------------------------------------------------------------------ */
/* Control plane — server → host commands                              */
/* ------------------------------------------------------------------ */

export const CONTROL_HEARTBEAT_CAPABILITY = "control-heartbeat-v1";

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
  | { type: "machine:heartbeat"; nonce: string }
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
  /**
   * Owner-triggered reset. Carries `config` because the daemon may not have
   * this agent registered yet (fresh daemon, bot never woken since last
   * restart). Daemon MUST `register` the agent, write a `reset_session`
   * system row to the timeline, kill any running process, and deliver a
   * synthetic rewake — see `AgentProcessManager.resetSession`.
   */
  | { type: "agent:reset"; agentId: AgentId; config: RuntimeConfig; launchId: string }
  /**
   * Agent-self-initiated reset ("nap"). Mechanically the twin of `agent:reset`
   * — same register + `nap` timeline barrier + kill + fresh-session rewake —
   * but self-requested and carrying a mandatory `handoff`: the agent's own
   * note to its reborn self, spliced into the nap rewake prompt (NOT a message
   * to anyone, NOT a persisted file). See `AgentProcessManager.resetSession`
   * and the `agent:nap` case in `agentRouter`.
   */
  | { type: "agent:nap"; agentId: AgentId; config: RuntimeConfig; launchId: string; handoff: string }
  /**
   * Owner-triggered model switch. The twin of `agent:reset` — same
   * stop-and-immediate-rewake orchestration and boundary conditions — but it
   * PRESERVES the session (no `reset_session` row, no timeline barrier), so the
   * agent picks up whatever it was doing on the new model. `config` already
   * carries the new model (see `RuntimeConfig.model`). This is an EXPEDITE, not
   * the record: D1 remains authoritative and every subsequent `agent:wake`
   * reads the model fresh, so a lost frame merely means the bot is late to the
   * new model, never wrong about it. See `AgentProcessManager.switchModel`.
   */
  | { type: "agent:model_switch"; agentId: AgentId; config: RuntimeConfig; launchId: string }
  /**
   * Owner-triggered BATCH reset — reset every agent bound to this machine in a
   * SINGLE command (not N fanned-out `agent:reset` frames). The server
   * enumerates the machine's full binding set and packs one `resets` entry per
   * agent (each the payload of a normal `agent:reset`: agentId + config +
   * launchId). The daemon loops `AgentProcessManager.resetSession` over the
   * array, reusing the exact per-agent reset path — so a bound-but-idle agent
   * cold-starts (register + fresh session), same as a single reset on an idle
   * bot. Each per-agent reset is independent (a failure is a per-agent error
   * ack, not a batch abort). The daemon MUST gate each `agentId` on its own
   * `botsById` (bound) set — an agentId it doesn't own is a no-op+warn (defends
   * the reconnect transient + closes the pre-existing "register+spawn any
   * agentId" hole). Routed by machineId to the single daemon that owns it (one
   * live credential per machineId). See the `machine:reset_all` case in
   * `agentRouter` and plans/daemon-batch-reset.md.
   */
  | { type: "machine:reset_all"; resets: Array<{ agentId: AgentId; config: RuntimeConfig; launchId: string }> }
  | { type: "machine:update" }
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
  }
  | DiagnosticCollectCommand;

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
  /** Capability gates for wire behavior that is unsafe to assume on legacy daemons. */
  capabilities?: string[];
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
    }
  | {
      kind: "error";
      payload: {
        scope: "spawn" | "runtime" | "exit" | "handshake_timeout" | "model_switch" | "reset";
        code: string;
        message: string;
        model: string | null;
      };
    }
  // Reset/nap completion events. Owner reset/nap are emitted by the DO when the
  // reborn agent's `agent_session` frame lands; `idle_timeout` is emitted by
  // the daemon only after its local six-hour reset barrier commits. `trigger`
  // distinguishes the entry-point so my-bots can read "was reset" vs "slept";
  // `actorId` never travels — it is the bot owner, resolved server-side at the
  // landing (reset is owner-only). See plans/reset-nap-completion-rehome.md.
  | { kind: "session_reset"; payload: { trigger: "single" | "reset_all" | "idle_timeout" } }
  | { kind: "nap"; payload: { trigger: "nap" } };

export interface HostBotAuditEventFrame {
  type: "bot_audit_event";
  /** Stable id for reliable events; required on `session_reset/idle_timeout`. */
  eventId?: string;
  /** Durable barrier completion time; required on `session_reset/idle_timeout`. */
  occurredAt?: string;
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
  launchId?: string;
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
   * Emit an `agent_typing` frame for the given (agentId, channelId) scope —
   * the daemon-metered heartbeat that keeps the "bot is typing…" pill lit for
   * a working bot. Optional so LocalControlChannel can omit.
   */
  reportAgentTyping?(info: { agentId: AgentId; channelId: string }): void;
  /**
   * Emit an `agent_typing_stop` frame for the given scope — one-shot on turn
   * end so the pill disappears immediately instead of dangling until the
   * client's 8s auto-expire. Optional so LocalControlChannel can omit.
   */
  reportAgentTypingStop?(info: { agentId: AgentId; channelId: string }): void;
  /**
   * Report a bot audit event upward. Automatic idle-reset completions are
   * retained and replayed by the real WS channel until the server acknowledges
   * their durable write; other audit events remain point-in-time. Optional so
   * LocalControlChannel can omit — matches `reportAgentActivity?` convention.
   * ws-do stamps `createdAt` and enforces the 500-row retention.
   */
  reportBotAuditEvent?(frame: HostBotAuditEventFrame): Promise<void>;
  /**
   * Register a resync provider invoked on every (re)connect: it returns the
   * host's current `ready` snapshot + live agent sessions + each live agent's
   * current derived activity, which the channel re-sends so the server can
   * recover this host's state after a drop. Activities are replayed because
   * `agent_activity` is edge-triggered — a frame dropped mid-disconnect is
   * otherwise lost, stranding the profile pill on a stale state. Optional so the
   * in-process `LocalControlChannel` (no reconnect) can omit it.
   */
  onResync?(provider: () => {
    ready: HostReady;
    sessions: AgentSessionReport[];
    activities: Array<{ agentId: AgentId; state: AgentActivityState }>;
  }): void;
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
  /** Hard-close a half-open client socket when the implementation supports it (`ws`). */
  terminate?(): void;
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
  /** Server segment (a real server id/handle, or `.dm`). */
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
 *
 * (The old `/<server>/<forum>/<post>` forum-post form is GONE, not merely
 * unsupported — a post is now addressed like any other thread, by-root-seq.
 * A 3-segment ref whose last segment doesn't start with "#" no longer
 * matches any grammar rule below and throws, same as any other malformed
 * ref; callers already render an unparseable ref as plain literal text
 * rather than a clickable pill, so an old-style link degrades cleanly
 * instead of silently resolving to the wrong target.)
 */
export function parseRef(ref: ChannelRef): ParsedRef {
  if (!ref.startsWith("/")) throw new Error(`ref must start with "/": ${ref}`);
  const body = ref.slice(1);
  const parts = body.split("/");
  if (parts.length < 2) throw new Error(`ref needs /<server>/<channel>: ${ref}`);
  const server = parts[0];
  if (server !== DM_SERVER && !parseNameAndTag(server)) {
    throw new Error(`server ref must use a name#discriminator handle: ${ref}`);
  }
  // Trailing "#N" on the last segment pins a message seq.
  let seq: Seq | undefined;

  // Thread form: /server/channel/#N or /server/channel/#N#M  → last part
  // starts with "#". `#M` (when present) is the message seq WITHIN the
  // thread channel's own seq space.
  if (parts.length >= 3 && parts[parts.length - 1].startsWith("#")) {
    const tail = parseThreadTail(parts[parts.length - 1]);
    return { server, channel: parts[1], ...tail };
  }

  // Any other 3+ segment shape (the old forum-post form's territory) no
  // longer names a valid ref — reject rather than silently truncate to the
  // first two segments.
  if (parts.length >= 3 && server !== DM_SERVER) {
    throw new Error(`ref has too many segments: ${ref}`);
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
    const isBareHandle = firstHash === lastHash && /^\d{4,}$/.test(tail);
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
 * A bare `seq` (without `threadRootSeq`) is NOT supported — the top-level
 * message form `/server/channel#N` puts `#N` on the channel segment, not on
 * a trailing path segment, and no caller needs to emit that shape via
 * formatRef today.
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

/**
 * The single canonical-ref EMITTER (trait model B1, red-line ①). Every place
 * that turns a stored channel into its addressable `ChannelRef` — the agent
 * inbox's `resolveScopeRefs` (per-message + per-scope refs), the wake notice's
 * `resolveUnreadNoticeChannel`, `listChannels` — used to hand-pick the
 * `formatRef` shape by re-branching on the channel's type, so the SAME
 * type→shape mapping lived in multiple copies and could drift (a post emitted
 * one way here, another way there → a ref that won't round-trip). This funnels
 * all of them through ONE dispatch keyed on `CHANNEL_TRAITS[type].addressing`,
 * so a channel type has exactly one addressing identity by construction.
 *
 * `scope` is the already-resolved context each caller gathers (server/parent
 * names, the DM peer segment, the thread root seq) — this function does no I/O,
 * it only selects the ref SHAPE from the addressing trait. A caller that can't
 * supply the field an addressing value needs (e.g. a thread with no resolvable
 * root seq) passes it `undefined` and gets `null` back, so the caller keeps its
 * existing "unresolvable → fallback/skip" handling rather than emitting a bogus
 * ref. The exhaustive `switch` (with the `never` tail) forces every new
 * addressing value to be handled here or the build fails.
 */
export type CanonicalRefScope = {
  type: StoredChannelType;
  /** Server handle (channel arm). Absent/irrelevant for a DM. */
  serverHandle?: string;
  /** The channel's own stored name — the top-level channel's name. */
  name?: string;
  /** Parent channel display name — for by-root-seq. */
  parentName?: string;
  /** Thread root message seq — for by-root-seq. */
  rootSeq?: Seq;
  /** DM peer handle segment (`name#0042`) — for by-peer-identity. */
  peerSegment?: string;
};

export function formatCanonicalRef(scope: CanonicalRefScope): ChannelRef | null {
  const addressing = CHANNEL_TRAITS[scope.type].addressing;
  switch (addressing) {
    case "by-server-name": {
      // Top-level channel/forum: `/server/<name>`.
      if (scope.serverHandle === undefined || scope.name === undefined) return null;
      return formatRef({ server: scope.serverHandle, channel: scope.name });
    }
    case "by-root-seq": {
      // Thread: `/server/<parent-channel>/#<rootSeq>`.
      if (scope.serverHandle === undefined || scope.parentName === undefined || scope.rootSeq === undefined) return null;
      return formatRef({ server: scope.serverHandle, channel: scope.parentName, threadRootSeq: scope.rootSeq });
    }
    case "by-peer-identity": {
      // DM: `/.dm/<peer#0042>`.
      if (scope.peerSegment === undefined) return null;
      return formatRef({ server: DM_SERVER, channel: scope.peerSegment });
    }
    default: {
      // Exhaustiveness: a new AddressingTrait value must add a case above.
      const _never: never = addressing;
      return _never;
    }
  }
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

// ---------------------------------------------------------------------------
// Downlink (server → daemon) command validation
// ---------------------------------------------------------------------------
//
// The mirror of the uplink (daemon → server) frame `safeParse`s in `src/ws-do`
// (`HostReadyMessageSchema`, `SessionErrorFrameSchema`, `AgentActivityMessageSchema`,
// … in ws-durable.ts). Before this, the daemon's `WsControlChannel.onMessage`
// trusted the frame's SHAPE blindly (`typeof frame.type === "string"` then
// `frame as HostCommand`), so a malformed/half-written frame or a producer bug
// reached the router's arms as a lie. `HostCommandSchema` closes exactly that
// asymmetry — the uplink was validated, the downlink was not.
//
// Colocated with the `HostCommand` TYPE (above) rather than in `schemas.ts`
// on purpose: the daemon reaches this file via the `@alook/shared/community-cli-contract`
// subpath (see `src/daemon/src/server/contract.ts`) and deliberately never
// imports the main `@alook/shared` barrel, which would drag the server/DB code
// (drizzle, queries) into the daemon bundle. The lockstep guard below also only
// compiles here, where the `HostCommand` type is in scope.
//
// SHALLOW by design (CTO ruling — plans/daemon-downlink-zod.md): validate the
// discriminant `type` + each arm's REQUIRED top-level scalars, and enumerate
// EVERY top-level field per arm (including optional load-bearing ones like
// `wake.sessionId`) so zod's default strip drops nothing real. The nested typed
// blobs — `config: RuntimeConfig` and `unreadNotice: UnreadNotice` — stay
// `z.unknown()` opaque passthrough: their interiors carry optional load-bearing
// fields (`unreadNotice.channelId?`, resume `sessionId?`) that a hand-listed
// object schema would most easily strip by accident, and the #6 failure surface
// is the TOP LEVEL (missing `type`/`agentId`/`launchId`, a half-written frame),
// not a blob's interior. `resolveLaunchFieldsOrDefault` re-parses `config`
// downstream with its own defaulting, so deep-validating it here would only turn
// a forward-compatible server field into a hard drop on an older daemon.
export const HostCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("machine:heartbeat"),
    nonce: z.string().min(1).max(128),
  }),
  z.object({
    type: z.literal("agent:wake"),
    agentId: z.string().min(1),
    config: z.unknown(),
    sessionId: z.string().optional(),
    launchId: z.string().min(1),
    unreadNotice: z.unknown(),
  }),
  z.object({
    type: z.literal("agent:stop"),
    agentId: z.string().min(1),
  }),
  z.object({
    type: z.literal("agent:reset"),
    agentId: z.string().min(1),
    config: z.unknown(),
    launchId: z.string().min(1),
  }),
  z.object({
    type: z.literal("agent:nap"),
    agentId: z.string().min(1),
    config: z.unknown(),
    launchId: z.string().min(1),
    handoff: z.string().min(1),
  }),
  z.object({
    type: z.literal("agent:model_switch"),
    agentId: z.string().min(1),
    config: z.unknown(),
    launchId: z.string().min(1),
  }),
  z.object({
    type: z.literal("machine:reset_all"),
    resets: z.array(
      z.object({
        agentId: z.string().min(1),
        config: z.unknown(),
        launchId: z.string().min(1),
      }),
    ),
  }),
  z.strictObject({
    type: z.literal("machine:update"),
  }),
  // The `bot:*` arms are NOT what #6 targets — the daemon acts on `agent:*`;
  // `bot:*` merely mutate/evict the `botsById` cache at the createDaemon layer.
  // Per the CTO scope ("bot:* covered for union-completeness, no bespoke
  // checks"), validate only the discriminant + the load-bearing `botId` (the
  // key the cache is keyed on / removed by) and keep the descriptive fields
  // OPTIONAL. Requiring `ownerName`/`discriminator` here would be a bespoke
  // check AND a behavior change — the daemon today processes a partial bot
  // frame (updating whatever fields it carries) rather than dropping it, and a
  // dropped bot frame would silently stale the cache (wrong `agentHandle`),
  // which is worse than the shallow-shape lie #6 is fixing on the command path.
  z.object({
    type: z.literal("bot:added"),
    botId: z.string().min(1),
    name: z.string().optional(),
    discriminator: z.string().optional(),
    description: z.string().optional(),
    ownerName: z.string().optional(),
    ownerDiscriminator: z.string().optional(),
  }),
  z.object({
    type: z.literal("bot:updated"),
    botId: z.string().min(1),
    name: z.string().optional(),
    discriminator: z.string().optional(),
    description: z.string().optional(),
    ownerName: z.string().optional(),
    ownerDiscriminator: z.string().optional(),
  }),
  z.object({
    type: z.literal("bot:removed"),
    botId: z.string().min(1),
  }),
  DiagnosticCollectCommandSchema,
]);

// Z2 — type↔schema lockstep. The `[T] extends [U]` tuple-wrap defeats union
// distribution so the WHOLE `HostCommand` union must be assignable to the
// schema's inferred type in one shot: a future `HostCommand` arm not added to
// the union above fails to compile (the mirror of #4's capability-completeness
// guard). Direction is `HostCommand extends infer` (not the reverse) because
// the `z.unknown()` blobs make `infer` strictly WIDER than `HostCommand` —
// `RuntimeConfig`/`UnreadNotice` are assignable to `unknown`, never the reverse.
type _HostCommandSchemaCoversType =
  [HostCommand] extends [z.infer<typeof HostCommandSchema>] ? true : never;
const _hostCommandSchemaCoversType: _HostCommandSchemaCoversType = true;
void _hostCommandSchemaCoversType;
