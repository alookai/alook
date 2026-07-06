/**
 * AgentRouter — the host-side control-plane consumer.
 *
 * The server pushes `HostCommand`s down a `HostControlChannel`; the router turns
 * them into `AgentProcessManager` calls. It is deliberately thin and does NO
 * addressing — every `agent:deliver` already names its recipient `agentId`
 * (the server decided who receives). The host just executes.
 *
 *   agent:start   → register + deliver wakeMessage (manager spawns single-flight)
 *   agent:deliver → manager.deliver(agentId, message)
 *   agent:stop    → manager.stop(agentId)
 *
 * It also reports readiness + session ids back up the channel, ACKs at-least-once
 * deliveries (dedup by deliveryId so an agent never sees a duplicate wake), and
 * supplies a resync snapshot so the server recovers this host's state after a
 * dropped control connection.
 */
import type { HostCommand, HostControlChannel, HostReady, Message, AgentSessionReport, SessionErrorFrame } from "../server/contract.js";
import { parseSeq } from "../server/contract.js";
import type { AgentProcessManager } from "./managerRuntime.js";

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
  /** Runtime descriptors (id + optional version) reported in the ready handshake. */
  runtimeReport: Array<{ id: string; version?: string }>;
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
   * Transform the raw message text into the prompt the agent actually sees.
   * The default passes text through unchanged. A real deployment replaces this
   * with a notify-style wake ("you have N messages, pull inbox").
   */
  transformWakeText?: (message: Message) => string;
}

export class AgentRouter {
  private readonly running = new Set<string>();
  /** Delivery ids already accepted — dedups redelivery so no duplicate wake. */
  private readonly seenDeliveries = new Set<string>();

  constructor(private readonly opts: AgentRouterOpts) {}

  /** Wire the command handler + resync provider and announce readiness. */
  async start(): Promise<void> {
    this.opts.channel.onCommand((cmd) => this.onCommand(cmd));
    // Resync provider: re-announce current state on every (re)connect so the
    // server recovers this host's running set + live sessions after a drop.
    this.opts.channel.onResync?.(() => ({
      ready: this.buildReady(),
      sessions: this.opts.manager.liveSessionReports() as AgentSessionReport[],
    }));
    await this.opts.channel.reportReady(this.buildReady());
  }

  private buildReady(): HostReady {
    return {
      runtimeReport: this.opts.runtimeReport,
      runningAgents: [...this.running],
      hostname: this.opts.hostname,
      platform: this.opts.platform,
      arch: this.opts.arch,
      osRelease: this.opts.osRelease,
      daemonVersion: this.opts.daemonVersion,
    };
  }

  private async onCommand(cmd: HostCommand): Promise<void> {
    switch (cmd.type) {
      case "agent:start":
        try {
          await this.opts.onBeforeAgent?.(cmd.agentId);
          this.opts.manager.register(cmd.agentId, {
            runtimeConfig: cmd.config,
            sessionId: cmd.sessionId,
            launchId: cmd.launchId,
          });
          this.running.add(cmd.agentId);
          if (cmd.wakeMessage) this.deliver(cmd.agentId, cmd.wakeMessage, cmd.deliveryId);
          await this.opts.channel.reportStartedAck?.({
            agentId: cmd.agentId,
            launchId: cmd.launchId,
            status: "ok",
          });
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
            await this.opts.channel.reportStartedAck?.({
              agentId: cmd.agentId,
              launchId: cmd.launchId,
              status: "error",
              error: {
                code: "bot_runtime_missing",
                message: err.message,
              },
            });
            return;
          }
          // Any other throw — including onBeforeAgent throws that used to be
          // swallowed silently — surfaces as a structured error ack.
          await this.opts.channel.reportStartedAck?.({
            agentId: cmd.agentId,
            launchId: cmd.launchId,
            status: "error",
            error: {
              code: classifyErrorCode(err),
              message: err instanceof Error ? err.message : String(err),
            },
          });
          return;
        }
        break;
      case "agent:deliver":
        try {
          await this.opts.onBeforeAgent?.(cmd.agentId);
          this.running.add(cmd.agentId);
          this.deliver(cmd.agentId, cmd.message, cmd.deliveryId);
        } catch (err) {
          await this.opts.channel.reportDeliverAck({
            agentId: cmd.agentId,
            deliveryId: cmd.deliveryId,
            status: "error",
            error: {
              code: classifyErrorCode(err),
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
        break;
      case "agent:stop":
        try {
          this.running.delete(cmd.agentId);
          void this.opts.manager.stop(cmd.agentId);
          await this.opts.channel.reportStoppedAck?.({
            agentId: cmd.agentId,
            status: "ok",
          });
        } catch (err) {
          await this.opts.channel.reportStoppedAck?.({
            agentId: cmd.agentId,
            status: "error",
            error: {
              code: classifyErrorCode(err),
              message: err instanceof Error ? err.message : String(err),
            },
          });
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

  /**
   * Hand an addressed message to the manager. At-least-once: a redelivered id is
   * deduped (not re-woken) but STILL acked, so the server can retire it.
   */
  private deliver(agentId: string, message: Message, deliveryId?: string): void {
    if (deliveryId !== undefined && this.seenDeliveries.has(deliveryId)) {
      void this.opts.channel.reportDeliverAck({ agentId, deliveryId });
      return;
    }
    this.opts.manager.register(agentId);
    const text = this.opts.transformWakeText ? this.opts.transformWakeText(message) : message.content.text;
    this.opts.manager.deliver(agentId, { seq: parseSeq(message.seq), text });
    if (deliveryId !== undefined) {
      this.seenDeliveries.add(deliveryId);
      void this.opts.channel.reportDeliverAck({ agentId, deliveryId });
    }
  }
}
