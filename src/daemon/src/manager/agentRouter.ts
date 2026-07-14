/**
 * AgentRouter — the host-side control-plane consumer.
 *
 * The server pushes `HostCommand`s down a `HostControlChannel`; the router turns
 * them into `AgentProcessManager` calls. It is deliberately thin and does NO
 * addressing — every command already names its recipient `agentId` (the
 * server decided who receives). The host just executes.
 *
 *   agent:wake → register (server-pushed RuntimeConfig) + deliver the
 *                bodiless unread-notice prompt. The MANAGER (not this
 *                router, and not the server) decides whether that means
 *                spawning a fresh process, notifying an already-running one,
 *                or coalescing the notice for the next turn — see
 *                `AgentProcessManager`/`managerPolicy`.
 *   agent:stop → manager.stop(agentId)
 *
 * It also reports readiness + session ids back up the channel, ACKs
 * `agent:wake`/`agent:stop` outcomes, and supplies a resync snapshot so the
 * server recovers this host's state after a dropped control connection.
 */
import type { HostCommand, HostControlChannel, HostReady, HostReadyRuntime, UnreadNotice, AgentSessionReport, SessionErrorFrame } from "../server/contract.js";
import type { AgentProcessManager } from "./managerRuntime.js";
import { createLogger, type Logger } from "../logger.js";

/**
 * Thrown by a `driverFor` implementation when the server asked for a runtime
 * that isn't available on this host. Caught by `AgentRouter` and forwarded
 * to the server as a `session.error{code:"runtime_not_available"}` frame so
 * the web-side machine card can surface the mismatch inline.
 */
/**
 * Thrown by onBeforeAgent when a command names a bot the daemon has never
 * heard of (post-warmup or after bot:removed evicted the cache entry).
 * Surfaces as `bot_unknown` in the ack frame.
 */
export class UnknownBotError extends Error {
  constructor(public readonly botId: string) {
    super(`Bot not in this daemon's cache: ${botId}`);
    this.name = "UnknownBotError";
  }
}

/**
 * Thrown by onBeforeAgent when the daemon's `enrollAgent` HTTP call fails
 * (server 5xx, network error, etc.).
 */
export class BotEnrollFailedError extends Error {
  constructor(public readonly botId: string, cause: unknown) {
    super(
      `Failed to enroll bot ${botId}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "BotEnrollFailedError";
  }
}

function classifyErrorCode(err: unknown): string {
  if (err instanceof UnknownBotError) return "bot_unknown";
  if (err instanceof BotEnrollFailedError) return "bot_enroll_failed";
  if (err instanceof UnknownRuntimeError) return "bot_runtime_missing";
  return "internal_error";
}

export class UnknownRuntimeError extends Error {
  constructor(public readonly requested: string | undefined, public readonly available: string[]) {
    super(
      `Runtime not available on this host: ${requested ?? "<unspecified>"} — installed: ${available.join(", ") || "(none)"}`
    );
    this.name = "UnknownRuntimeError";
  }
}

export interface AgentRouterOpts {
  manager: AgentProcessManager;
  channel: HostControlChannel;
  /** Runtime descriptors reported in the ready handshake. Copied into a live mutable map. */
  runtimeReport: HostReadyRuntime[];
  hostname?: string;
  platform?: string;
  arch?: string;
  osRelease?: string;
  daemonVersion?: string;
  /**
   * Called before registering/delivering to an agent. The daemon uses this to
   * enroll the agent (fetch its runner key) so the credential proxy can swap
   * vouchers. Must complete before the agent is spawned.
   */
  onBeforeAgent?: (agentId: string) => Promise<void>;
  /**
   * Format the bodiless `UnreadNotice` into the prompt text the agent
   * actually sees. The default is a fixed "you have unread messages in
   * channel X" line. Deliberately does NOT include the inbox-pull
   * instruction — that's `wakePromptFooter` on `ManagerRuntimeOpts`, appended
   * once after coalescing/dedup so a burst of notices doesn't repeat it.
   */
  formatUnreadNoticeText?: (notice: UnreadNotice) => string;
  /**
   * Coalescer scheduler for on-demand ready-frame resends. Defaults to
   * `queueMicrotask` so a burst of health mutations in the same tick collapse
   * into one wire frame. Tests inject a synchronous scheduler.
   */
  scheduleReadyResend?: (fn: () => void) => void;
  /** Defaults to `createLogger({ header: "@alook/daemon:router" })`. */
  logger?: Logger;
}

function defaultFormatUnreadNoticeText(notice: UnreadNotice): string {
  return `You have unread messages in channel ${notice.channel}.`;
}

export class AgentRouter {
  private readonly running = new Set<string>();
  /**
   * Mutable per-runtime health map. Seeded from the startup snapshot passed
   * on construction; mutated live by `markRuntimeUnhealthy` / `markRuntimeHealthy`
   * so the router owns the single source of truth for /community's picker
   * gating. See plans/community-machine-presence-fix.md.
   *
   * Insertion order preserves the runtime ordering the daemon reported at
   * startup — Map iterates in insertion order — so the ready frame lists
   * runtimes deterministically across reports.
   */
  private readonly runtimes = new Map<string, HostReadyRuntime>();
  /** Coalescer: one microtask-scheduled `sendReady` per burst of mutations. */
  private pendingResend = false;
  private readonly scheduleResend: (fn: () => void) => void;
  private readonly log: Logger;

  constructor(private readonly opts: AgentRouterOpts) {
    this.log = opts.logger ?? createLogger({ header: "@alook/daemon:router" });
    this.scheduleResend = opts.scheduleReadyResend ?? queueMicrotask.bind(globalThis);
    for (const r of opts.runtimeReport) {
      this.runtimes.set(r.id, {
        id: r.id,
        version: r.version,
        status: r.status ?? "healthy",
        lastError: r.lastError,
        lastErrorAt: r.lastErrorAt,
      });
    }
  }

  /** Wire the command handler + resync provider and announce readiness. */
  async start(): Promise<void> {
    this.opts.channel.onCommand((cmd) => this.onCommand(cmd));
    // Resync provider: re-announce current state on every (re)connect so the
    // server recovers this host's running set + live sessions after a drop.
    // Reads the LIVE map so unhealthy marks accumulated during the disconnect
    // window survive reconnect (detectRuntimes() is one-shot at daemon start —
    // it is NOT re-invoked here).
    this.opts.channel.onResync?.(() => ({
      ready: this.buildReady(),
      sessions: this.opts.manager.liveSessionReports() as AgentSessionReport[],
    }));
    await this.opts.channel.reportReady(this.buildReady());
  }

  /**
   * Current ready snapshot. Public for the createDaemon wiring that hooks
   * this into `wsControlChannel.sendReady()` for on-demand resends.
   */
  buildReady(): HostReady {
    return {
      runtimeReport: [...this.runtimes.values()],
      runningAgents: [...this.running],
      hostname: this.opts.hostname,
      platform: this.opts.platform,
      arch: this.opts.arch,
      osRelease: this.opts.osRelease,
      daemonVersion: this.opts.daemonVersion,
    };
  }

  /** Runtime ids currently reported healthy. Insertion-ordered. */
  healthyRuntimeIds(): string[] {
    const out: string[] = [];
    for (const r of this.runtimes.values()) {
      if (r.status === "healthy") out.push(r.id);
    }
    return out;
  }

  /**
   * True iff the daemon currently believes this runtime is usable. Unknown
   * ids return false — an id the daemon never advertised was never usable.
   * Used by `driverFor` in `createDaemon.ts` to short-circuit dispatch to a
   * known-unhealthy runtime with `UnknownRuntimeError`; see the plan.
   */
  isRuntimeHealthy(id: string): boolean {
    return this.runtimes.get(id)?.status === "healthy";
  }

  /**
   * Mark a runtime unhealthy after a spawn failure (ENOENT, pre-handshake
   * exit, etc.). Idempotent: a call whose (status, lastError) matches the
   * existing entry is a no-op and does NOT schedule a resend. Silent no-op
   * on unknown ids — the daemon never advertised them, so we don't want to
   * synthesize a phantom entry on the wire.
   */
  markRuntimeUnhealthy(id: string, reason: string): void {
    const existing = this.runtimes.get(id);
    if (!existing) return;
    const nowIso = new Date().toISOString();
    if (existing.status === "unhealthy" && existing.lastError === reason) return;
    this.runtimes.set(id, {
      ...existing,
      status: "unhealthy",
      lastError: reason,
      lastErrorAt: nowIso,
    });
    this.log.warn("runtime marked unhealthy", { runtimeId: id, reason });
    this.scheduleReadyFrameResend();
  }

  /**
   * Mark a runtime healthy after a successful post-handshake `runtime_event`.
   * Clears `lastError` / `lastErrorAt` — leaving them stale would render a
   * healthy chip with a "last failed with X" tooltip, which is worse than no
   * tooltip. Idempotent + no-op for unknown ids, same as markRuntimeUnhealthy.
   */
  markRuntimeHealthy(id: string): void {
    const existing = this.runtimes.get(id);
    if (!existing) return;
    if (existing.status === "healthy" && !existing.lastError && !existing.lastErrorAt) return;
    this.runtimes.set(id, {
      id: existing.id,
      version: existing.version,
      status: "healthy",
    });
    this.log.info("runtime marked healthy again", { runtimeId: id });
    this.scheduleReadyFrameResend();
  }

  /**
   * Drop an agent from the running set because the daemon itself decided to
   * stop it — idle hibernation or stall-recovery termination — WITHOUT a
   * server-sent `agent:stop`. Keeps `runningAgents` on `ready` frames aligned
   * with what's really live, so the server's `reconcileBotActivityFromRunningAgents`
   * safety net can clear stale "still running" pills on reconnect. Idempotent
   * for unknown ids.
   */
  markLocallyStopped(agentId: string): void {
    if (!this.running.delete(agentId)) return;
    this.log.info("agent removed from running set (local stop)", { agentId });
    this.scheduleReadyFrameResend();
  }

  private scheduleReadyFrameResend(): void {
    if (this.pendingResend) return;
    this.pendingResend = true;
    this.scheduleResend(() => {
      this.pendingResend = false;
      // sendReady on the channel no-ops when the socket isn't open (see
      // WsControlChannel.sendFrame). Health mutations while offline just
      // update the map; the next resyncOnConnect flushes the current state.
      try {
        this.opts.channel.sendReady?.(this.buildReady());
      } catch {
        // A transport failure here must not crash the host — the next
        // reconnect's resync provider re-emits the current state.
      }
    });
  }

  private async onCommand(cmd: HostCommand): Promise<void> {
    switch (cmd.type) {
      case "agent:wake":
        this.log.info("agent:wake received", {
          agentId: cmd.agentId,
          channel: cmd.unreadNotice.channel,
          latestSeq: cmd.unreadNotice.latestSeq,
        });
        try {
          await this.opts.onBeforeAgent?.(cmd.agentId);
          this.opts.manager.register(cmd.agentId, {
            runtimeConfig: cmd.config,
            sessionId: cmd.sessionId,
            launchId: cmd.launchId,
          });
          this.running.add(cmd.agentId);
          const text = (this.opts.formatUnreadNoticeText ?? defaultFormatUnreadNoticeText)(cmd.unreadNotice);
          // The manager (not this router) decides spawn vs. in-process notify
          // vs. coalesce — see managerPolicy's `onWake`.
          this.opts.manager.deliver(cmd.agentId, { seq: cmd.unreadNotice.latestSeq, text });
          await this.opts.channel.reportWakeAck?.({
            agentId: cmd.agentId,
            launchId: cmd.launchId,
            status: "ok",
          });
          this.log.info("agent:wake ack", { agentId: cmd.agentId, status: "ok" });
        } catch (err) {
          if (err instanceof UnknownRuntimeError) {
            // Forward a structured session.error so the server / machine DO
            // can render "runtime not available" on the card instead of
            // crashing the launch lifecycle.
            const frame: SessionErrorFrame = {
              type: "session.error",
              code: "runtime_not_available",
              agentId: cmd.agentId,
              payload: {
                requested: err.requested ?? null,
                available: err.available,
              },
            };
            await this.opts.channel.reportSessionError?.(frame);
            await this.opts.channel.reportWakeAck?.({
              agentId: cmd.agentId,
              launchId: cmd.launchId,
              status: "error",
              error: {
                code: "bot_runtime_missing",
                message: err.message,
              },
            });
            this.log.info("agent:wake ack", {
              agentId: cmd.agentId,
              status: "error",
              "error.code": "bot_runtime_missing",
            });
            return;
          }
          // Any other throw — including onBeforeAgent throws that used to be
          // swallowed silently — surfaces as a structured error ack.
          {
            const code = classifyErrorCode(err);
            await this.opts.channel.reportWakeAck?.({
              agentId: cmd.agentId,
              launchId: cmd.launchId,
              status: "error",
              error: {
                code,
                message: err instanceof Error ? err.message : String(err),
              },
            });
            this.log.info("agent:wake ack", { agentId: cmd.agentId, status: "error", "error.code": code });
          }
          return;
        }
        break;
      case "agent:stop":
        this.log.info("agent:stop received", { agentId: cmd.agentId });
        try {
          this.running.delete(cmd.agentId);
          void this.opts.manager.stop(cmd.agentId);
          await this.opts.channel.reportStoppedAck?.({
            agentId: cmd.agentId,
            status: "ok",
          });
          this.log.info("agent:stop ack", { agentId: cmd.agentId, status: "ok" });
        } catch (err) {
          const code = classifyErrorCode(err);
          await this.opts.channel.reportStoppedAck?.({
            agentId: cmd.agentId,
            status: "error",
            error: {
              code,
              message: err instanceof Error ? err.message : String(err),
            },
          });
          this.log.info("agent:stop ack", { agentId: cmd.agentId, status: "error", "error.code": code });
        }
        break;
      // bot:* frames are handled at the daemon layer (createDaemon), NOT here.
      // agentRouter is intentionally thin on control-plane routing.
      case "bot:added":
      case "bot:updated":
      case "bot:removed":
        break;
    }
  }
}
