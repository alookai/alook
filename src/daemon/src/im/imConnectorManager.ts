import type {
  DaemonImDeliveryReport,
  DaemonImTriggerConfig,
  ExternalSendResponse,
  ImCommand,
  ImStatusFrame,
} from "../server/contract.js";
import { WeChatIlinkAdapter, type WeChatBlockedEvent, type WeChatInboundEvent } from "./wechatIlinkAdapter.js";

const IM_TEXT_MAX_LENGTH = 4_096;
const IM_SUMMARY_MAX_LENGTH = 240;

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 1))}…`;
}

function summarize(value: string): string {
  return truncate(value.replace(/\s+/g, " ").trim(), IM_SUMMARY_MAX_LENGTH);
}

function buildCompactWeChatLine(event: WeChatInboundEvent): string {
  const payload: Record<string, unknown> = {
    kind: "im",
    platform: "wechat",
    trigger: event.trigger.name || "WeChat",
    ref: event.ref,
    chat: { type: "dm" },
    sender: { id: event.senderId, name: event.senderLabel },
    text: truncate(event.text, IM_TEXT_MAX_LENGTH),
    mentioned: true,
    time: event.timeIso,
  };
  const instruction = event.trigger.instruction.trim();
  if (instruction) payload.instruction = instruction;
  return JSON.stringify(payload);
}

export interface ImConnectorManagerOpts {
  stateRootDir: string;
  onStatus: (frame: ImStatusFrame) => void;
  onDeliverImEvent: (botId: string, promptLine: string) => Promise<void>;
  onReportDelivery: (report: DaemonImDeliveryReport) => Promise<void>;
  fetchImpl?: typeof fetch;
  qrPollIntervalMs?: number;
}

export class ImConnectorManager {
  private readonly adapters = new Map<string, WeChatIlinkAdapter>();
  private stopped = false;

  constructor(private readonly opts: ImConnectorManagerOpts) {}

  private key(botId: string, triggerId: string): string {
    return `${botId}:${triggerId}`;
  }

  private createAdapter(config: DaemonImTriggerConfig): WeChatIlinkAdapter {
    return new WeChatIlinkAdapter(this.opts.stateRootDir, config, {
      onStatus: (frame) => this.opts.onStatus(frame),
      onInboundMessage: (event) => this.handleInbound(event),
      onBlockedMessage: (event) => this.handleBlocked(event),
      fetchImpl: this.opts.fetchImpl,
      pollIntervalMs: this.opts.qrPollIntervalMs,
    });
  }

  private async handleInbound(event: WeChatInboundEvent): Promise<void> {
    const line = buildCompactWeChatLine(event);
    await this.opts.onDeliverImEvent(event.trigger.botId, line);
    void this.opts
      .onReportDelivery({
        triggerId: event.trigger.triggerId,
        botId: event.trigger.botId,
        direction: "inbound",
        status: "dispatched",
        eventType: "im.message",
        summary: summarize(event.text),
        senderId: event.senderId,
        senderLabel: event.senderLabel,
        chatLabel: "DM",
        externalDeliveryId: event.externalDeliveryId,
        occurredAtMs: Date.now(),
        recordAuditWake: true,
      })
      .catch(() => undefined);
  }

  private async handleBlocked(event: WeChatBlockedEvent): Promise<void> {
    void this.opts
      .onReportDelivery({
        triggerId: event.trigger.triggerId,
        botId: event.trigger.botId,
        direction: "inbound",
        status: "blocked",
        eventType: "im.message",
        summary: summarize(event.text),
        senderId: event.senderId,
        senderLabel: event.senderLabel,
        chatLabel: "DM",
        externalDeliveryId: event.externalDeliveryId,
        lastError: "sender_not_allowed",
        occurredAtMs: Date.now(),
        recordAuditWake: false,
      })
      .catch(() => undefined);
  }

  syncTriggers(triggers: readonly DaemonImTriggerConfig[]): void {
    if (this.stopped) return;
    const seen = new Set<string>();
    for (const config of triggers) {
      if (config.provider !== "wechat") continue;
      const k = this.key(config.botId, config.triggerId);
      seen.add(k);
      const existing = this.adapters.get(k);
      if (existing) {
        existing.updateConfig(config);
      } else {
        const adapter = this.createAdapter(config);
        this.adapters.set(k, adapter);
        adapter.start();
      }
    }
    for (const [k, adapter] of this.adapters) {
      if (!seen.has(k)) {
        adapter.stop(false);
        this.adapters.delete(k);
      }
    }
  }

  async handleCommand(command: ImCommand): Promise<void> {
    if (this.stopped) return;
    const k = this.key(command.botId, command.triggerId);
    if (command.type === "im:config_sync") {
      if (command.action === "delete") {
        const existing = this.adapters.get(k);
        if (existing) {
          existing.stop(true);
          this.adapters.delete(k);
        }
        return;
      }
      const existing = this.adapters.get(k);
      const nextConfig: DaemonImTriggerConfig = {
        triggerId: command.triggerId,
        botId: command.botId,
        provider: command.provider,
        name: command.name ?? existing?.triggerConfig.name ?? "WeChat",
        enabled: command.enabled ?? existing?.triggerConfig.enabled ?? true,
        accessPolicy: command.accessPolicy ?? existing?.triggerConfig.accessPolicy ?? "allowlist",
        allowedSenders: command.allowedSenders ?? existing?.triggerConfig.allowedSenders ?? [],
        instruction: command.instruction ?? existing?.triggerConfig.instruction ?? "",
      };
      if (existing) {
        existing.updateConfig(nextConfig);
      } else {
        const adapter = this.createAdapter(nextConfig);
        this.adapters.set(k, adapter);
        adapter.start();
      }
      return;
    }

    if (command.type === "im:qr_start") {
      let adapter = this.adapters.get(k);
      if (!adapter) {
        adapter = this.createAdapter({
          triggerId: command.triggerId,
          botId: command.botId,
          provider: command.provider,
          name: "WeChat",
          enabled: true,
          accessPolicy: "allowlist",
          allowedSenders: [],
          instruction: "",
        });
        this.adapters.set(k, adapter);
      }
      await adapter.startQrLogin(command.requestId);
    }
  }

  async sendExternalReply(
    botId: string,
    externalRef: string,
    text: string,
  ): Promise<
    | { ok: true; response: ExternalSendResponse }
    | { ok: false; status: number; error: string }
  > {
    let targetAdapter: WeChatIlinkAdapter | null = null;
    for (const adapter of this.adapters.values()) {
      if (adapter.triggerConfig.botId === botId && adapter.hasReplyRef(externalRef)) {
        targetAdapter = adapter;
        break;
      }
    }
    if (!targetAdapter) {
      return { ok: false, status: 404, error: "WeChat reply ref not found for this bot" };
    }

    const result = await targetAdapter.sendMessage(externalRef, text);
    void this.opts
      .onReportDelivery({
        triggerId: targetAdapter.triggerConfig.triggerId,
        botId,
        direction: "outbound",
        status: result.ok ? "dispatched" : "failed",
        eventType: "im.reply",
        summary: summarize(text),
        lastError: result.ok ? null : truncate(result.error, 240),
        occurredAtMs: Date.now(),
        recordAuditWake: false,
      })
      .catch(() => undefined);

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      response: {
        state: "sent",
        externalRef,
        platform: "wechat",
        messageId: result.messageId,
      },
    };
  }

  stopAll(): void {
    this.stopped = true;
    for (const adapter of this.adapters.values()) {
      adapter.stop(false);
    }
    this.adapters.clear();
  }
}
