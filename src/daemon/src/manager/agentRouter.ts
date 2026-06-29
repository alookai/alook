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
import type { HostCommand, HostControlChannel, HostReady, Message, AgentSessionReport } from "../server/contract";
import { parseSeq } from "../server/contract";
import type { AgentProcessManager } from "./managerRuntime";

export interface AgentRouterOpts {
  manager: AgentProcessManager;
  channel: HostControlChannel;
  /** Runtime ids this host can launch (reported in the ready handshake). */
  runtimes: string[];
  hostname?: string;
  os?: string;
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
      runtimes: this.opts.runtimes,
      runningAgents: [...this.running],
      hostname: this.opts.hostname,
      os: this.opts.os,
    };
  }

  private async onCommand(cmd: HostCommand): Promise<void> {
    switch (cmd.type) {
      case "agent:start":
        await this.opts.onBeforeAgent?.(cmd.agentId);
        this.opts.manager.register(cmd.agentId, {
          runtimeConfig: cmd.config,
          sessionId: cmd.sessionId,
          launchId: cmd.launchId,
        });
        this.running.add(cmd.agentId);
        if (cmd.wakeMessage) this.deliver(cmd.agentId, cmd.wakeMessage, cmd.deliveryId);
        break;
      case "agent:deliver":
        await this.opts.onBeforeAgent?.(cmd.agentId);
        this.running.add(cmd.agentId);
        this.deliver(cmd.agentId, cmd.message, cmd.deliveryId);
        break;
      case "agent:stop":
        this.running.delete(cmd.agentId);
        void this.opts.manager.stop(cmd.agentId);
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
