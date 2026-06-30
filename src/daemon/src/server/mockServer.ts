/**
 * MockServer — an in-memory implementation of the `ServerApi` contract.
 *
 * For local execution + tests: holds servers, channels, a per-channel message
 * log (with per-channel seq), and per-agent read waterlines — all in memory, no
 * network. The CLI (in test mode) and example harnesses talk to it exactly as
 * they would the real server, exercising the contract end to end.
 *
 * Addressing is by `ChannelRef` path strings (`/server/channel`, `/.dm/peer`);
 * messages are located by channel + seq. The agent-facing `Message` is flat:
 * `{ seq:"#N", channel, sender:"@handle", content:{text}, time }`.
 */
import type {
  ServerApi,
  Server,
  Channel,
  Message,
  ChannelRef,
  Seq,
  InboxRow,
  InboxSnapshot,
  InboxFlag,
  AgentId,
  ServerId,
  InboxPullRequest,
  InboxPullResponse,
  AckRequest,
  SendRequest,
  SendResponse,
  ReadRequest,
  ResolveRequest,
  ListChannelsRequest,
  Page,
  AdminApi,
  Agent,
  User,
  ChannelKind,
  UserId,
  HostCommand,
  EnrollmentApi,
} from "./contract.js";
import { DM_SERVER, parseRef, formatSeq } from "./contract.js";
import * as crypto from "crypto";
import type { RuntimeConfig } from "../runtimeConfig.js";
import { makeRuntimeConfig } from "../runtimeConfig.js";

/** Internal stored row — richer than the flat agent-facing Message. */
interface StoredMessage {
  seq: Seq;
  channel: ChannelRef;
  senderHandle: string; // "@name"
  text: string;
  time: string;
  mention?: boolean;
}

interface SeedMember {
  id: string;
  /** Handle without "@", e.g. "gustavo". */
  name: string;
}

export interface MockServerSeed {
  servers: Array<{
    id: string;
    name: string;
    agents: string[];
    channels: Array<{ id: string; name: string; kind?: "channel" | "dm"; description?: string }>;
  }>;
  members?: SeedMember[];
}

export interface MockServerPersistState {
  seed?: MockServerSeed;
  messages: StoredMessage[];
  seqCounters: Array<[string, number]>;
  reads: Array<{ agentId: string; channel: string; seq: Seq }>;
}

export class MockServer implements ServerApi, AdminApi, EnrollmentApi {
  private readonly servers = new Map<string, Server>();
  private readonly channels = new Map<string, Channel>();
  /** serverId → set of agentIds participating. */
  private readonly membership = new Map<string, Set<string>>();
  /** agentId → handle ("@name") for sender stamping. */
  private readonly agentHandles = new Map<string, string>();
  /** agentId → RuntimeConfig — what `agent:start` will carry. */
  private readonly agentConfigs = new Map<string, RuntimeConfig>();
  /** channelRef → ordered messages. */
  private readonly log = new Map<ChannelRef, StoredMessage[]>();
  /** channelRef → next seq. */
  private readonly seqCounter = new Map<ChannelRef, number>();
  /** agentId → (channelRef → last acked seq). */
  private readonly readMarks = new Map<string, Map<ChannelRef, Seq>>();
  private seed?: MockServerSeed;

  /** Control-plane sink: a connected host registers here to receive commands. */
  private commandSink: ((cmd: HostCommand) => void | Promise<void>) | null = null;
  /** Agents the host has reported as running (so we deliver vs. start). */
  private readonly runningAgents = new Set<string>();
  private launchCounter = 0;
  private deliveryCounter = 0;
  /** deliveryId → unacked delivery (for at-least-once redelivery on reconnect). */
  private readonly unackedDeliveries = new Map<string, HostCommand>();
  /** Valid machine keys this server issued on enrollment (tier-1). */
  private readonly machineKeys = new Set<string>();
  /** runnerKey → agentId, so a swapped-in runner key is traceable (tier-2). */
  private readonly runnerKeys = new Map<string, string>();

  constructor(seed?: MockServerSeed) {
    this.seed = seed;
    if (seed) this.applySeed(seed);
  }

  /* ----- enrollment (machine credential surface) ----- */

  /**
   * Enroll a machine: issue a tier-1 `sk_machine_` key the server thereafter
   * trusts. In a real deployment this is an out-of-band/admin step; the local
   * `mock-server` entrypoint calls it once at startup and prints the key so the
   * daemon can be launched with it. Returns the machine key.
   */
  enrollMachine(): string {
    const machineKey = `sk_machine_${crypto.randomBytes(24).toString("base64url")}`;
    this.machineKeys.add(machineKey);
    return machineKey;
  }

  /**
   * Is this a machine key the server issued? Used by the control-plane transport
   * to authenticate a connecting daemon (Bearer machineKey) before accepting it.
   */
  verifyMachineKey(key: string | undefined): boolean {
    return !!key && this.machineKeys.has(key);
  }

  async mintAgentCredential(req: { machineKey: string; agentId: AgentId }): Promise<{ runnerKey: string; expiresAt?: number }> {
    if (!this.machineKeys.has(req.machineKey)) {
      throw apiError("UNAUTHORIZED_MACHINE", "unknown or invalid machine key");
    }
    if (!this.agentHandles.has(req.agentId)) {
      throw apiError("NOT_FOUND", `agent ${req.agentId} not found`);
    }
    // MVP: no machine↔agent binding check yet (TODO once that table exists).
    const runnerKey = `sk_agent_${crypto.randomBytes(24).toString("base64url")}`;
    this.runnerKeys.set(runnerKey, req.agentId);
    return { runnerKey };
  }

  /* ----- control plane (server → host) ----- */

  /** A host attaches its command handler; returns the current running set tracker. */
  attachHost(sink: (cmd: HostCommand) => void | Promise<void>): void {
    this.commandSink = sink;
  }
  /** Host reports an agent started (so subsequent messages `agent:deliver`). */
  markRunning(agentId: string): void {
    this.runningAgents.add(agentId);
  }
  markStopped(agentId: string): void {
    this.runningAgents.delete(agentId);
  }
  /**
   * Replace the running set wholesale with what a (re)connecting host reports.
   * Idempotent refresh — a host that crashed and came back with fewer agents
   * must not leave stale "running" entries that suppress agent:start.
   */
  resetRunningAgents(agentIds: string[]): void {
    this.runningAgents.clear();
    for (const id of agentIds) this.runningAgents.add(id);
  }

  /** Compute recipients for a message and push control commands to the host. */
  private dispatchToRecipients(stored: StoredMessage): void {
    if (!this.commandSink) return;
    const message = toAgentMessage(stored);
    for (const agentId of this.recipientsFor(stored)) {
      this.deliveryCounter += 1;
      const deliveryId = `dlv_${this.deliveryCounter}`;
      let cmd: HostCommand;
      if (this.runningAgents.has(agentId)) {
        cmd = { type: "agent:deliver", agentId, message, deliveryId };
      } else {
        // Not running → start it (with the triggering message), then it's running.
        const config = this.agentConfigs.get(agentId) ?? makeRuntimeConfig({ runtime: "mock" });
        this.launchCounter += 1;
        cmd = { type: "agent:start", agentId, config, wakeMessage: message, deliveryId, launchId: `launch_${this.launchCounter}` };
        this.runningAgents.add(agentId);
      }
      // Track for at-least-once until the host acks; then push to the host.
      this.unackedDeliveries.set(deliveryId, cmd);
      this.commandSink(cmd);
    }
  }

  /** Host acked a delivery — retire it so it isn't redelivered. */
  ackDelivery(deliveryId: string): void {
    this.unackedDeliveries.delete(deliveryId);
  }

  /**
   * Re-push every still-unacked delivery to the (reconnected) host. The host
   * dedups by deliveryId, so redelivering an already-processed message is safe.
   */
  redeliverUnacked(): void {
    if (!this.commandSink) return;
    for (const cmd of this.unackedDeliveries.values()) this.commandSink(cmd);
  }

  /**
   * SERVER-side addressing: who should receive this message? Agents that are
   * members of the channel's server (for a real channel) or the DM peer (for a
   * DM), excluding the sender. The host never does this — it's server policy.
   */
  private recipientsFor(stored: StoredMessage): string[] {
    const p = parseRef(stored.channel);
    if (p.server === DM_SERVER) {
      // DM: deliver to the peer agent if it's a known agent (by handle).
      const peerAgent = [...this.agentHandles].find(([, h]) => h === `@${p.channel}`)?.[0];
      return peerAgent && `@${this.agentHandles.get(peerAgent)}` !== stored.senderHandle ? [peerAgent] : peerAgent ? [peerAgent] : [];
    }
    const serverId = this.resolveServerId(p.server);
    if (!serverId) return [];
    const members = this.membership.get(serverId) ?? new Set();
    return [...members].filter((agentId) => this.agentHandles.get(agentId) !== stored.senderHandle);
  }

  private applySeed(seed: MockServerSeed): void {
    for (const m of seed.members ?? []) this.agentHandles.set(m.id, `@${m.name}`);
    for (const a of seed.members ?? []) {
      if (!this.agentConfigs.has(a.id)) {
        this.agentConfigs.set(a.id, makeRuntimeConfig({ runtime: "mock", agentName: a.name, agentHandle: `@${a.name}` }));
      }
    }
    for (const s of seed.servers) {
      this.servers.set(s.id, { id: s.id, name: s.name });
      this.membership.set(s.id, new Set(s.agents));
      for (const c of s.channels) {
        this.channels.set(c.id, {
          id: c.id,
          serverId: s.id,
          name: c.name,
          kind: c.kind ?? "channel",
          description: c.description,
        });
      }
    }
  }

  /* ----- persistence ----- */

  dumpState(): MockServerPersistState {
    const messages: StoredMessage[] = [];
    for (const arr of this.log.values()) messages.push(...arr);
    const reads: Array<{ agentId: string; channel: string; seq: Seq }> = [];
    for (const [agentId, marks] of this.readMarks) {
      for (const [channel, seq] of marks) reads.push({ agentId, channel, seq });
    }
    return { seed: this.seed, messages, seqCounters: [...this.seqCounter.entries()], reads };
  }

  static restore(state: MockServerPersistState): MockServer {
    const mock = new MockServer(state.seed);
    for (const [ref, seq] of state.seqCounters) mock.seqCounter.set(ref, seq);
    for (const m of state.messages) {
      const arr = mock.log.get(m.channel) ?? [];
      arr.push(m);
      mock.log.set(m.channel, arr);
    }
    for (const r of state.reads) {
      let marks = mock.readMarks.get(r.agentId);
      if (!marks) {
        marks = new Map();
        mock.readMarks.set(r.agentId, marks);
      }
      marks.set(r.channel, r.seq);
    }
    return mock;
  }

  /* ----- test/seed helpers (not part of ServerApi) ----- */

  /** Inject a message as if `senderHandle` (e.g. "@gustavo") posted it. */
  post(input: { channel: ChannelRef; sender: string; text: string; mention?: boolean }): Message {
    return toAgentMessage(
      this.append(input.channel, input.sender.startsWith("@") ? input.sender : `@${input.sender}`, input.text, input.mention),
    );
  }

  private append(channelArg: ChannelRef, senderHandle: string, text: string, mention?: boolean): StoredMessage {
    // Validate + canonicalize so id/name variants key the same log.
    this.assertChannelExists(channelArg);
    const channel = this.canon(channelArg);
    const seq = (this.seqCounter.get(channel) ?? 0) + 1;
    this.seqCounter.set(channel, seq);
    const msg: StoredMessage = { seq, channel, senderHandle, text, time: new Date().toISOString(), mention };
    const arr = this.log.get(channel) ?? [];
    arr.push(msg);
    this.log.set(channel, arr);
    // Control plane: push delivery/start commands to the connected host (if any).
    this.dispatchToRecipients(msg);
    return msg;
  }

  private assertChannelExists(channel: ChannelRef): void {
    const p = parseRef(channel);
    if (p.server === DM_SERVER) return; // DMs are implicit
    const serverId = this.resolveServerId(p.server);
    const ok =
      serverId &&
      [...this.channels.values()].some((c) => c.serverId === serverId && (c.name === p.channel || c.id === p.channel));
    if (!ok) throw apiError("NOT_FOUND", `channel ${channel} not found`);
  }

  private readMark(agentId: AgentId, channel: ChannelRef): Seq {
    return this.readMarks.get(agentId)?.get(channel) ?? 0;
  }

  /** Canonical channel refs the agent can receive in (its servers' channels). */
  private agentChannels(agentId: AgentId): ChannelRef[] {
    const refs: ChannelRef[] = [];
    for (const [serverId, agents] of this.membership) {
      if (!agents.has(agentId)) continue;
      for (const ch of this.channels.values()) {
        // Canonical /serverId/channelId (matches what append() keys on).
        if (ch.serverId === serverId) refs.push(`/${serverId}/${ch.id}`);
      }
    }
    // Plus any DM channels that already have a log addressed to this agent's handle.
    const handle = this.agentHandles.get(agentId);
    if (handle) {
      for (const ref of this.log.keys()) {
        if (ref.startsWith(`/${DM_SERVER}/`) && !refs.includes(ref)) refs.push(ref);
      }
    }
    return refs;
  }

  private resolveServerId(serverRef: string): ServerId | undefined {
    if (this.servers.has(serverRef)) return serverRef;
    return [...this.servers.values()].find((s) => s.name === serverRef)?.id;
  }

  /**
   * Canonicalize a channel ref to `/serverId/channelId[...]` so the log is keyed
   * consistently whether the caller used server/channel NAMES or IDS. DM refs
   * are returned unchanged (the `.dm` server + peer are already canonical).
   */
  private canon(ref: ChannelRef): ChannelRef {
    const p = parseRef(ref);
    if (p.server === DM_SERVER) return ref;
    const serverId = this.resolveServerId(p.server);
    if (!serverId) return ref; // unknown — leave as-is (validation happens elsewhere)
    const ch = [...this.channels.values()].find(
      (c) => c.serverId === serverId && (c.name === p.channel || c.id === p.channel),
    );
    const channelSeg = ch ? ch.id : p.channel;
    const base = `/${serverId}/${channelSeg}`;
    return p.threadRootSeq !== undefined ? `${base}/#${p.threadRootSeq}` : base;
  }

  /* ----- ServerApi ----- */

  async listServers(req: { agentId: AgentId }): Promise<{ servers: Server[] }> {
    const servers: Server[] = [];
    for (const [serverId, agents] of this.membership) {
      if (agents.has(req.agentId)) {
        const s = this.servers.get(serverId);
        if (s) servers.push(s);
      }
    }
    return { servers };
  }

  async listChannels(req: ListChannelsRequest): Promise<{ channels: Channel[] }> {
    const myServers = new Set((await this.listServers({ agentId: req.agentId })).servers.map((s) => s.id));
    const channels = [...this.channels.values()].filter(
      (c) => myServers.has(c.serverId) && (!req.server || c.serverId === req.server),
    );
    return { channels };
  }

  async inboxPull(req: InboxPullRequest): Promise<InboxPullResponse> {
    const out: StoredMessage[] = [];
    const handle = this.agentHandles.get(req.agentId);
    let truncated = false;
    for (const channel of this.agentChannels(req.agentId)) {
      const mark = this.readMark(req.agentId, channel);
      for (const m of this.log.get(channel) ?? []) {
        if (m.seq <= mark) continue;
        if (handle && m.senderHandle === handle) continue; // skip own messages
        if (req.max && out.length >= req.max) {
          truncated = true;
          break;
        }
        out.push(m);
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return { messages: out.map(toAgentMessage), hasMore: truncated };
  }

  async inboxSnapshot(req: { agentId: AgentId }): Promise<InboxSnapshot> {
    const handle = this.agentHandles.get(req.agentId);
    const rows: InboxRow[] = [];
    for (const channel of this.agentChannels(req.agentId)) {
      const mark = this.readMark(req.agentId, channel);
      const unread = (this.log.get(channel) ?? []).filter((m) => m.seq > mark && m.senderHandle !== handle);
      if (unread.length === 0) continue;
      const flags: InboxFlag[] = [];
      if (channel.startsWith(`/${DM_SERVER}/`)) flags.push("dm");
      if (unread.some((m) => m.mention)) flags.push("mention");
      rows.push({
        channel,
        pendingCount: unread.length,
        firstPendingSeq: unread[0].seq,
        latestSeq: unread[unread.length - 1].seq,
        latestSender: unread[unread.length - 1].senderHandle,
        flags,
      });
    }
    rows.sort((a, b) => (b.latestSeq ?? 0) - (a.latestSeq ?? 0));
    return { rows, pendingChannels: rows.length, pendingMessages: rows.reduce((n, r) => n + r.pendingCount, 0) };
  }

  async ack(req: AckRequest): Promise<void> {
    let marks = this.readMarks.get(req.agentId);
    if (!marks) {
      marks = new Map();
      this.readMarks.set(req.agentId, marks);
    }
    for (const c of req.cursors) {
      const key = this.canon(c.channel);
      marks.set(key, Math.max(marks.get(key) ?? 0, c.seq));
    }
  }

  async send(req: SendRequest): Promise<SendResponse> {
    const channel = this.canon(req.channel);
    const latestSeq = this.seqCounter.get(channel) ?? 0;
    // Channel alignment: if the agent hasn't seen the channel's latest messages,
    // block the send (no bypass) — it must pull/read to align, then resend. The
    // server is the source of truth: it falls back to the agent's tracked read
    // waterline when the caller doesn't supply `seenUpToSeq`, so alignment is
    // enforced server-side and can't be skipped by a client that simply omits it.
    const seen = req.seenUpToSeq ?? this.readMark(req.agentId, channel);
    if (latestSeq > seen) {
      return { state: "blocked", reason: "unaligned", unreadCount: latestSeq - seen, latestSeq };
    }
    const handle = this.agentHandles.get(req.agentId) ?? `@${req.agentId}`;
    const stored = this.append(req.channel, handle, req.content.text);
    await this.ack({ agentId: req.agentId, cursors: [{ channel: stored.channel, seq: stored.seq }] });
    return { state: "sent", message: toAgentMessage(stored) };
  }

  async read(req: ReadRequest): Promise<Page<Message>> {
    let items = [...(this.log.get(this.canon(req.channel)) ?? [])];
    if (req.before !== undefined) items = items.filter((m) => m.seq < req.before!);
    if (req.after !== undefined) items = items.filter((m) => m.seq > req.after!);
    const limit = req.limit ?? 20;
    if (req.around !== undefined) {
      items.sort((a, b) => Math.abs(a.seq - req.around!) - Math.abs(b.seq - req.around!));
      items = items.slice(0, limit).sort((a, b) => a.seq - b.seq);
      return { items: items.map(toAgentMessage), hasMore: false, latestSeq: items[items.length - 1]?.seq };
    }
    const hasMore = items.length > limit;
    items = items.slice(-limit);
    return { items: items.map(toAgentMessage), hasMore, latestSeq: items[items.length - 1]?.seq };
  }

  async resolve(req: ResolveRequest): Promise<{ message: Message }> {
    const found = (this.log.get(this.canon(req.channel)) ?? []).find((m) => m.seq === req.seq);
    if (!found) throw apiError("NOT_FOUND", `message ${req.channel}${formatSeq(req.seq)} not found`);
    return { message: toAgentMessage(found) };
  }

  /* ----- AdminApi (provisioning / test surface) ----- */

  private adminCounter = 0;
  private readonly users = new Map<string, User>();
  private mkId(prefix: string): string {
    this.adminCounter += 1;
    return `${prefix}_${this.adminCounter}`;
  }

  async createUser(req: { name: string }): Promise<{ user: User }> {
    const user: User = { id: this.mkId("user"), name: req.name };
    this.users.set(user.id, user);
    return { user };
  }

  async createAgent(req: {
    userId: UserId;
    name: string;
    runtime?: string;
    instruction?: string;
  }): Promise<{ agent: Agent }> {
    // Agent is the user's asset — created independent of any server.
    const agent: Agent = { id: this.mkId("agent"), name: req.name, userId: req.userId };
    this.agentHandles.set(agent.id, `@${req.name}`);
    // The agent's identity (name + instruction) lives in its RuntimeConfig — the
    // same config downlinked via agent:start — so the daemon gets it from the
    // server, not by inventing it.
    this.agentConfigs.set(
      agent.id,
      makeRuntimeConfig({ runtime: req.runtime ?? "mock", agentName: req.name, agentHandle: `@${req.name}`, instruction: req.instruction }),
    );
    return { agent };
  }

  async createServer(req: { name: string }): Promise<{ server: Server }> {
    const server: Server = { id: this.mkId("srv"), name: req.name };
    this.servers.set(server.id, server);
    this.membership.set(server.id, new Set());
    return { server };
  }

  async addAgentToServer(req: { agentId: AgentId; server: ServerId }): Promise<void> {
    const serverId = this.resolveServerId(req.server) ?? req.server;
    if (!this.servers.has(serverId)) throw apiError("NOT_FOUND", `server ${req.server} not found`);
    (this.membership.get(serverId) ?? this.membership.set(serverId, new Set()).get(serverId)!).add(req.agentId);
  }

  async createChannel(req: { server: ServerId; name: string; kind?: ChannelKind }): Promise<{ channel: Channel }> {
    const serverId = this.resolveServerId(req.server) ?? req.server;
    if (!this.servers.has(serverId)) throw apiError("NOT_FOUND", `server ${req.server} not found`);
    const channel: Channel = { id: this.mkId("ch"), serverId, name: req.name, kind: req.kind ?? "channel" };
    this.channels.set(channel.id, channel);
    return { channel };
  }

  async postMessage(req: { channel: ChannelRef; sender: string; text: string }): Promise<{ message: Message }> {
    // append() handles validation + control-plane dispatch to recipients.
    return { message: this.post({ channel: req.channel, sender: req.sender, text: req.text }) };
  }

  async readChannel(req: { channel: ChannelRef; limit?: number }): Promise<Page<Message>> {
    // Observability-only: no agent identity, no waterline advance, no alignment.
    const all = [...(this.log.get(this.canon(req.channel)) ?? [])];
    const limit = req.limit ?? 20;
    const hasMore = all.length > limit;
    const items = all.slice(-limit);
    return { items: items.map(toAgentMessage), hasMore, latestSeq: items[items.length - 1]?.seq };
  }
}

/** Project the internal stored row to the flat agent-facing Message. */
function toAgentMessage(m: StoredMessage): Message {
  return { seq: formatSeq(m.seq), channel: m.channel, sender: m.senderHandle, content: { text: m.text }, time: m.time };
}

function apiError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
