import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonImDeliveryReport, ImStatusFrame } from "../server/contract.js";
import { ImConnectorManager } from "./imConnectorManager.js";

describe("ImConnectorManager + WeChatIlinkAdapter", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "alook-im-test-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("runs QR login -> 0600 credential save -> getupdates inbound allow/block -> local ext_wx reply -> -14 session_expired", async () => {
    const statuses: ImStatusFrame[] = [];
    const delivered: Array<{ botId: string; line: string }> = [];
    const reports: DaemonImDeliveryReport[] = [];

    let qrStatusCalls = 0;
    let pollCalls = 0;
    const sentMessages: unknown[] = [];

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/ilink/bot/get_bot_qrcode")) {
        return new Response(
          JSON.stringify({
            qrcode: "qr_sess_1",
            qrcode_img_content: "https://ilinkai.weixin.qq.com/qr/abc",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/ilink/bot/get_qrcode_status")) {
        qrStatusCalls += 1;
        if (qrStatusCalls === 1) {
          return new Response(JSON.stringify({ status: "scaned" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            status: "confirmed",
            bot_token: "wx_secret_token_999",
            ilink_bot_id: "mybot@im.bot",
            baseurl: "https://ilinkai.weixin.qq.com",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/ilink/bot/getupdates")) {
        pollCalls += 1;
        if (pollCalls === 1) {
          return new Response(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "cursor_1",
              msgs: [
                {
                  message_id: "m_blocked",
                  from_user_id: "stranger_wx",
                  message_type: 1,
                  context_token: "ctx_stranger",
                  create_time_ms: 1764330000000,
                  item_list: [{ type: 1, text_item: { text: "who is this" } }],
                },
                {
                  message_id: "m_allowed",
                  from_user_id: "gus_wx",
                  message_type: 1,
                  context_token: "ctx_secret_gus_1",
                  create_time_ms: 1764330005000,
                  item_list: [{ type: 1, text_item: { text: "deploy status?" } }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (pollCalls === 2) {
          // Wait briefly before returning session expired so sendExternalReply can run first.
          await new Promise((r) => setTimeout(r, 80));
          return new Response(JSON.stringify({ errcode: -14, errmsg: "session expired" }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: "cursor_1", msgs: [] }), {
          status: 200,
        });
      }
      if (url.includes("/ilink/bot/sendmessage")) {
        sentMessages.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const manager = new ImConnectorManager({
      stateRootDir: rootDir,
      onStatus: (frame) => statuses.push(frame),
      onDeliverImEvent: async (botId, line) => {
        delivered.push({ botId, line });
      },
      onReportDelivery: async (report) => {
        reports.push(report);
      },
      fetchImpl,
      qrPollIntervalMs: 5,
    });

    manager.syncTriggers([
      {
        triggerId: "bwh_wx_1",
        botId: "bot_1",
        provider: "wechat",
        name: "My WeChat",
        enabled: true,
        accessPolicy: "allowlist",
        allowedSenders: ["gus_wx"],
        instruction: "Keep replies short",
      },
    ]);

    await manager.handleCommand({
      type: "im:qr_start",
      requestId: "req_qr_1",
      botId: "bot_1",
      triggerId: "bwh_wx_1",
      provider: "wechat",
    });

    await vi.waitFor(() => {
      expect(delivered).toHaveLength(1);
    }, { timeout: 2000 });

    // Verify 0600 file permissions and local persistence.
    const stateFile = join(rootDir, "bot_1", "im", "wechat-bwh_wx_1.json");
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(stateFile, "utf8")).toContain("wx_secret_token_999");

    // Verify inbound NDJSON never leaks context_token or bot_token.
    const inboundLine = delivered[0]!.line;
    expect(inboundLine).not.toContain("\n");
    expect(inboundLine).not.toContain("ctx_secret_gus_1");
    expect(inboundLine).not.toContain("wx_secret_token_999");
    const parsedInbound = JSON.parse(inboundLine);
    expect(parsedInbound.kind).toBe("im");
    expect(parsedInbound.platform).toBe("wechat");
    expect(parsedInbound.ref).toMatch(/^ext_wx_/);
    expect(parsedInbound.sender).toEqual({ id: "gus_wx", name: "gus_wx" });
    expect(parsedInbound.text).toBe("deploy status?");

    // Verify stranger was blocked and reported to History.
    expect(reports.some((r) => r.status === "blocked" && r.senderId === "stranger_wx")).toBe(true);
    expect(reports.some((r) => r.status === "dispatched" && r.recordAuditWake === true)).toBe(true);

    // Reply via local sendExternalReply using opaque ext_wx_* ref.
    const reply = await manager.sendExternalReply("bot_1", parsedInbound.ref, "All green!");
    expect(reply.ok).toBe(true);
    expect(sentMessages).toHaveLength(1);
    expect((sentMessages[0] as any).msg.to_user_id).toBe("gus_wx");
    expect((sentMessages[0] as any).msg.context_token).toBe("ctx_secret_gus_1");
    expect((sentMessages[0] as any).msg.item_list[0].text_item.text).toBe("All green!");

    // Wait for -14 session_expired status emission.
    await vi.waitFor(() => {
      expect(statuses.some((s) => s.status === "session_expired")).toBe(true);
    }, { timeout: 2000 });

    expect(statuses.map((s) => s.status)).toEqual(
      expect.arrayContaining(["pending", "scanned", "confirmed", "session_expired"]),
    );

    manager.stopAll();
  });
});
