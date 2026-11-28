import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  DaemonImTriggerConfig,
  ImStatusFrame,
} from "../server/contract.js";

const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_CHANNEL_VERSION = "1.0.2";
const ILINK_POLL_TIMEOUT_MS = 38_000;
const ILINK_QR_TTL_MS = 5 * 60 * 1000;
const ILINK_QR_POLL_INTERVAL_MS = 2_000;
const MAX_LOCAL_REPLY_REFS = 500;
const SESSION_EXPIRED_ERRCODE = -14;

export interface WeChatReplyRefEntry {
  peerUserId: string;
  contextToken: string;
  updatedAtMs: number;
}

export interface WeChatStoredState {
  version: 1;
  accountId: string | null;
  token: string | null;
  baseUrl: string;
  cursor: string;
  replyRefs: Record<string, WeChatReplyRefEntry>;
}

export interface WeChatInboundEvent {
  trigger: DaemonImTriggerConfig;
  ref: string;
  senderId: string;
  senderLabel: string;
  text: string;
  timeIso: string;
  externalDeliveryId: string | null;
}

export interface WeChatBlockedEvent {
  trigger: DaemonImTriggerConfig;
  senderId: string;
  senderLabel: string;
  text: string;
  externalDeliveryId: string | null;
}

export interface WeChatAdapterCallbacks {
  onStatus: (frame: ImStatusFrame) => void;
  onInboundMessage: (event: WeChatInboundEvent) => Promise<void>;
  onBlockedMessage: (event: WeChatBlockedEvent) => Promise<void>;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}

function randomWeChatUinHeader(): string {
  const num = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(num), "utf8").toString("base64");
}

function newWeChatReplyRef(): string {
  return `ext_wx_${randomBytes(9).toString("base64url")}`;
}

function isAllowed(config: DaemonImTriggerConfig, senderId: string): boolean {
  if (config.accessPolicy === "anyone") return true;
  const target = senderId.trim().toLowerCase();
  return config.allowedSenders.some((entry) => entry.trim().toLowerCase() === target);
}

function sanitizeSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_") || "_";
}

export class WeChatIlinkAdapter {
  private config: DaemonImTriggerConfig;
  private state: WeChatStoredState;
  private pollAbort: AbortController | null = null;
  private qrAbort: AbortController | null = null;
  private stopped = false;
  private readonly fetchImpl: typeof fetch;
  private readonly qrPollIntervalMs: number;

  constructor(
    private readonly stateRootDir: string,
    config: DaemonImTriggerConfig,
    private readonly callbacks: WeChatAdapterCallbacks,
  ) {
    this.config = config;
    this.fetchImpl = callbacks.fetchImpl ?? fetch;
    this.qrPollIntervalMs = callbacks.pollIntervalMs ?? ILINK_QR_POLL_INTERVAL_MS;
    this.state = this.loadState();
  }

  get key(): string {
    return `${this.config.botId}:${this.config.triggerId}`;
  }

  get triggerConfig(): DaemonImTriggerConfig {
    return this.config;
  }

  hasReplyRef(ref: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.state.replyRefs, ref);
  }

  private stateFilePath(): string {
    const dir = join(this.stateRootDir, sanitizeSegment(this.config.botId), "im");
    return join(dir, `wechat-${sanitizeSegment(this.config.triggerId)}.json`);
  }

  private loadState(): WeChatStoredState {
    const file = this.stateFilePath();
    if (!existsSync(file)) {
      return {
        version: 1,
        accountId: null,
        token: null,
        baseUrl: DEFAULT_ILINK_BASE_URL,
        cursor: "",
        replyRefs: {},
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<WeChatStoredState>;
      return {
        version: 1,
        accountId: typeof parsed.accountId === "string" ? parsed.accountId : null,
        token: typeof parsed.token === "string" ? parsed.token : null,
        baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.startsWith("http")
          ? parsed.baseUrl.replace(/\/+$/, "")
          : DEFAULT_ILINK_BASE_URL,
        cursor: typeof parsed.cursor === "string" ? parsed.cursor : "",
        replyRefs: parsed.replyRefs && typeof parsed.replyRefs === "object" ? parsed.replyRefs : {},
      };
    } catch {
      return {
        version: 1,
        accountId: null,
        token: null,
        baseUrl: DEFAULT_ILINK_BASE_URL,
        cursor: "",
        replyRefs: {},
      };
    }
  }

  private saveState(): void {
    const file = this.stateFilePath();
    const dir = join(this.stateRootDir, sanitizeSegment(this.config.botId), "im");
    const tmp = join(dir, `.wechat-${randomUUID()}.tmp`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      // Bound replyRefs to MAX_LOCAL_REPLY_REFS newest entries.
      const entries = Object.entries(this.state.replyRefs);
      if (entries.length > MAX_LOCAL_REPLY_REFS) {
        entries.sort((a, b) => b[1].updatedAtMs - a[1].updatedAtMs);
        this.state.replyRefs = Object.fromEntries(entries.slice(0, MAX_LOCAL_REPLY_REFS));
      }
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600, flag: "wx" });
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  start(): void {
    this.stopped = false;
    if (this.config.enabled && this.state.token) {
      this.callbacks.onStatus({
        type: "im_status",
        botId: this.config.botId,
        triggerId: this.config.triggerId,
        provider: "wechat",
        status: "connected",
        botAccountLabel: this.state.accountId,
        error: null,
      });
      this.ensurePollLoop();
    }
  }

  updateConfig(next: DaemonImTriggerConfig): void {
    this.config = next;
    if (!next.enabled) {
      this.stopPollLoop();
    } else if (this.state.token && !this.stopped) {
      this.ensurePollLoop();
    }
  }

  stop(deleteLocalState = false): void {
    this.stopped = true;
    this.stopPollLoop();
    this.stopQrLoop();
    if (deleteLocalState) {
      try {
        rmSync(this.stateFilePath(), { force: true });
      } catch {
        // Best-effort local cleanup.
      }
    }
  }

  private stopPollLoop(): void {
    if (this.pollAbort) {
      this.pollAbort.abort();
      this.pollAbort = null;
    }
  }

  private stopQrLoop(): void {
    if (this.qrAbort) {
      this.qrAbort.abort();
      this.qrAbort = null;
    }
  }

  async startQrLogin(requestId: string): Promise<void> {
    this.stopQrLoop();
    const abort = new AbortController();
    this.qrAbort = abort;

    try {
      const res = await this.fetchImpl(
        `${this.state.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`,
        { method: "GET", signal: abort.signal },
      );
      const data = (await res.json().catch(() => null)) as {
        qrcode?: string;
        qrcode_img_content?: string;
        errmsg?: string;
      } | null;
      const qrcode = typeof data?.qrcode === "string" && data.qrcode.trim() ? data.qrcode.trim() : null;
      const qrUrl = typeof data?.qrcode_img_content === "string" && data.qrcode_img_content.trim()
        ? data.qrcode_img_content.trim()
        : null;
      if (!res.ok || !qrcode || !qrUrl) {
        this.callbacks.onStatus({
          type: "im_status",
          requestId,
          botId: this.config.botId,
          triggerId: this.config.triggerId,
          provider: "wechat",
          status: "error",
          error: data?.errmsg || `WeChat QR request failed (${res.status})`,
        });
        return;
      }

      const expiresAt = new Date(Date.now() + ILINK_QR_TTL_MS).toISOString();
      this.callbacks.onStatus({
        type: "im_status",
        requestId,
        botId: this.config.botId,
        triggerId: this.config.triggerId,
        provider: "wechat",
        status: "pending",
        sessionId: qrcode,
        qrUrl,
        expiresAt,
        error: null,
      });

      void this.pollQrStatus(qrcode, qrUrl, expiresAt, abort.signal);
    } catch (err) {
      if (abort.signal.aborted) return;
      this.callbacks.onStatus({
        type: "im_status",
        requestId,
        botId: this.config.botId,
        triggerId: this.config.triggerId,
        provider: "wechat",
        status: "error",
        error: err instanceof Error ? err.message : "Failed to reach WeChat iLink",
      });
    }
  }

  private async pollQrStatus(
    qrcode: string,
    qrUrl: string,
    expiresAt: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deadlineMs = Date.parse(expiresAt);
    let lastStatus = "wait";
    while (!signal.aborted && !this.stopped && Date.now() < deadlineMs) {
      try {
        const res = await this.fetchImpl(
          `${this.state.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
          {
            method: "GET",
            headers: { "iLink-App-ClientVersion": "1" },
            signal,
          },
        );
        const data = (await res.json().catch(() => null)) as {
          status?: string;
          bot_token?: string;
          ilink_bot_id?: string;
          baseurl?: string;
        } | null;

        const status = data?.status ?? "wait";
        if (status === "scaned" && lastStatus !== "scaned") {
          lastStatus = "scaned";
          this.callbacks.onStatus({
            type: "im_status",
            botId: this.config.botId,
            triggerId: this.config.triggerId,
            provider: "wechat",
            status: "scanned",
            sessionId: qrcode,
            qrUrl,
            expiresAt,
            error: null,
          });
        } else if (status === "confirmed" && typeof data?.bot_token === "string" && data.bot_token.trim()) {
          this.state.token = data.bot_token.trim();
          this.state.accountId = typeof data.ilink_bot_id === "string" && data.ilink_bot_id.trim()
            ? data.ilink_bot_id.trim()
            : this.state.accountId;
          if (typeof data.baseurl === "string" && data.baseurl.startsWith("http")) {
            this.state.baseUrl = data.baseurl.replace(/\/+$/, "");
          }
          this.state.cursor = "";
          this.saveState();
          this.callbacks.onStatus({
            type: "im_status",
            botId: this.config.botId,
            triggerId: this.config.triggerId,
            provider: "wechat",
            status: "confirmed",
            sessionId: qrcode,
            botAccountLabel: this.state.accountId,
            error: null,
          });
          if (this.config.enabled) {
            this.ensurePollLoop();
          }
          return;
        } else if (status === "expired") {
          this.callbacks.onStatus({
            type: "im_status",
            botId: this.config.botId,
            triggerId: this.config.triggerId,
            provider: "wechat",
            status: "expired",
            sessionId: qrcode,
            error: "QR code expired",
          });
          return;
        }
      } catch {
        if (signal.aborted || this.stopped) return;
      }

      await sleepWithSignal(this.qrPollIntervalMs, signal);
    }

    if (!signal.aborted && !this.stopped) {
      this.callbacks.onStatus({
        type: "im_status",
        botId: this.config.botId,
        triggerId: this.config.triggerId,
        provider: "wechat",
        status: "expired",
        sessionId: qrcode,
        error: "QR code expired",
      });
    }
  }

  private ensurePollLoop(): void {
    if (this.pollAbort || this.stopped || !this.config.enabled || !this.state.token) return;
    const abort = new AbortController();
    this.pollAbort = abort;
    void this.runPollLoop(abort.signal);
  }

  private async runPollLoop(signal: AbortSignal): Promise<void> {
    let backoffMs = 2_000;
    while (!signal.aborted && !this.stopped && this.config.enabled && this.state.token) {
      const reqAbort = new AbortController();
      const onParentAbort = () => reqAbort.abort();
      signal.addEventListener("abort", onParentAbort, { once: true });
      const timeout = setTimeout(() => reqAbort.abort(), ILINK_POLL_TIMEOUT_MS);

      try {
        const res = await this.fetchImpl(`${this.state.baseUrl}/ilink/bot/getupdates`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.state.token}`,
            AuthorizationType: "ilink_bot_token",
            "X-WECHAT-UIN": randomWeChatUinHeader(),
          },
          body: JSON.stringify({
            get_updates_buf: this.state.cursor,
            base_info: { channel_version: ILINK_CHANNEL_VERSION },
          }),
          signal: reqAbort.signal,
        });
        clearTimeout(timeout);
        signal.removeEventListener("abort", onParentAbort);

        const data = (await res.json().catch(() => null)) as {
          ret?: number;
          errcode?: number;
          errmsg?: string;
          get_updates_buf?: string;
          msgs?: Array<{
            message_id?: string | number;
            from_user_id?: string;
            message_type?: number;
            context_token?: string;
            create_time_ms?: number;
            item_list?: Array<{ type?: number; text_item?: { text?: string } }>;
          }>;
        } | null;

        if (data?.errcode === SESSION_EXPIRED_ERRCODE) {
          this.stopPollLoop();
          this.callbacks.onStatus({
            type: "im_status",
            botId: this.config.botId,
            triggerId: this.config.triggerId,
            provider: "wechat",
            status: "session_expired",
            botAccountLabel: this.state.accountId,
            error: "WeChat session expired — scan QR code to reconnect",
          });
          return;
        }

        if (!res.ok || (data?.ret !== undefined && data.ret !== 0)) {
          await sleepWithSignal(backoffMs, signal);
          backoffMs = Math.min(30_000, backoffMs * 2);
          continue;
        }

        backoffMs = 2_000;
        if (typeof data?.get_updates_buf === "string" && data.get_updates_buf !== this.state.cursor) {
          this.state.cursor = data.get_updates_buf;
          this.saveState();
        }

        const msgs = Array.isArray(data?.msgs) ? data.msgs : [];
        for (const msg of msgs) {
          // Only process inbound user messages (message_type === 1).
          if (msg.message_type !== 1) continue;
          const senderId = typeof msg.from_user_id === "string" ? msg.from_user_id.trim() : "";
          if (!senderId) continue;
          const textParts = (msg.item_list ?? [])
            .filter((item) => item.type === 1 && typeof item.text_item?.text === "string")
            .map((item) => item.text_item!.text!.trim())
            .filter(Boolean);
          const text = textParts.join("\n").trim();
          if (!text) continue;

          const externalDeliveryId = msg.message_id !== undefined ? `wx_${String(msg.message_id)}` : null;

          if (!isAllowed(this.config, senderId)) {
            await this.callbacks.onBlockedMessage({
              trigger: this.config,
              senderId,
              senderLabel: senderId,
              text,
              externalDeliveryId,
            });
            continue;
          }

          const ref = newWeChatReplyRef();
          const contextToken = typeof msg.context_token === "string" ? msg.context_token : "";
          this.state.replyRefs[ref] = {
            peerUserId: senderId,
            contextToken,
            updatedAtMs: Date.now(),
          };
          this.saveState();

          const timeIso = typeof msg.create_time_ms === "number" && msg.create_time_ms > 0
            ? new Date(msg.create_time_ms).toISOString()
            : new Date().toISOString();

          await this.callbacks.onInboundMessage({
            trigger: this.config,
            ref,
            senderId,
            senderLabel: senderId,
            text,
            timeIso,
            externalDeliveryId,
          });
        }
      } catch {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onParentAbort);
        if (signal.aborted || this.stopped) return;
        await sleepWithSignal(backoffMs, signal);
        backoffMs = Math.min(30_000, backoffMs * 2);
      }
    }
  }

  async sendMessage(
    ref: string,
    text: string,
  ): Promise<{ ok: true; messageId: string | null } | { ok: false; status: number; error: string }> {
    if (!this.config.enabled) {
      return { ok: false, status: 409, error: "WeChat IM trigger is paused" };
    }
    if (!this.state.token) {
      return { ok: false, status: 409, error: "WeChat is not linked — scan QR code first" };
    }
    const entry = this.state.replyRefs[ref];
    if (!entry) {
      return { ok: false, status: 404, error: "WeChat reply ref not found" };
    }

    const clientId = `alook_${randomUUID()}`;
    try {
      const res = await this.fetchImpl(`${this.state.baseUrl}/ilink/bot/sendmessage`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.state.token}`,
          AuthorizationType: "ilink_bot_token",
          "X-WECHAT-UIN": randomWeChatUinHeader(),
        },
        body: JSON.stringify({
          msg: {
            from_user_id: "",
            to_user_id: entry.peerUserId,
            client_id: clientId,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text } }],
            context_token: entry.contextToken,
          },
          base_info: { channel_version: ILINK_CHANNEL_VERSION },
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        ret?: number;
        errcode?: number;
        errmsg?: string;
      } | null;

      if (data?.errcode === SESSION_EXPIRED_ERRCODE) {
        this.stopPollLoop();
        this.callbacks.onStatus({
          type: "im_status",
          botId: this.config.botId,
          triggerId: this.config.triggerId,
          provider: "wechat",
          status: "session_expired",
          botAccountLabel: this.state.accountId,
          error: "WeChat session expired — scan QR code to reconnect",
        });
        return { ok: false, status: 409, error: "WeChat session expired" };
      }
      if (!res.ok || (data?.ret !== undefined && data.ret !== 0)) {
        return { ok: false, status: 502, error: data?.errmsg || `WeChat sendmessage failed (${res.status})` };
      }
      return { ok: true, messageId: clientId };
    } catch (err) {
      return {
        ok: false,
        status: 502,
        error: err instanceof Error ? err.message : "WeChat iLink unreachable",
      };
    }
  }
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
