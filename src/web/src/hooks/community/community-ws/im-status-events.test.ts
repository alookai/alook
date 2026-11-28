import { describe, expect, it } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { BotImQrStatusResponse, BotWebhookSummary } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { handleBotImStatus } from "./im-status-events"

function makeWeChatSummary(overrides: Partial<BotWebhookSummary> = {}): BotWebhookSummary {
  return {
    id: "im_wx_1",
    botId: "bot_1",
    name: "WeChat",
    provider: "wechat",
    category: "im",
    transport: "daemon_poll",
    connectionStatus: "scan_required",
    hasSigningSecret: false,
    hasOutboundCredentials: false,
    accessPolicy: "allowlist",
    allowedSenders: [],
    requireMentionInGroups: false,
    botUsername: null,
    botAccountLabel: null,
    region: null,
    feishuAppId: null,
    machineName: "MacBook Pro",
    machineOnline: true,
    daemonLastError: null,
    eventFilter: null,
    instruction: "",
    enabled: true,
    lastTriggeredAt: null,
    createdAt: "2026-11-28T08:00:00.000Z",
    updatedAt: "2026-11-28T08:00:00.000Z",
    lastDelivery: null,
    ...overrides,
  }
}

describe("handleBotImStatus", () => {
  it("projects QR scan transitions and updates cached trigger connectionStatus", () => {
    const queryClient = new QueryClient()
    const webhooksKey = communityKeys.botWebhooks("bot_1")
    const qrKey = communityKeys.botImQrStatus("bot_1", "im_wx_1")
    queryClient.setQueryData(webhooksKey, { webhooks: [makeWeChatSummary()] })

    handleBotImStatus(
      {
        type: "community:bot.im_status",
        machineId: "m_1",
        botId: "bot_1",
        triggerId: "im_wx_1",
        provider: "wechat",
        status: "pending",
        sessionId: "sess_1",
        qrUrl: "https://liteapp.weixin.qq.com/q/demo",
        expiresAt: "2026-11-28T08:05:00.000Z",
      },
      { queryClient } as never,
    )
    expect(queryClient.getQueryData<BotImQrStatusResponse>(qrKey)).toMatchObject({
      qrStatus: "pending",
      qrUrl: "https://liteapp.weixin.qq.com/q/demo",
      sessionId: "sess_1",
    })

    handleBotImStatus(
      {
        type: "community:bot.im_status",
        machineId: "m_1",
        botId: "bot_1",
        triggerId: "im_wx_1",
        provider: "wechat",
        status: "scanned",
      },
      { queryClient } as never,
    )
    expect(queryClient.getQueryData<BotImQrStatusResponse>(qrKey)).toMatchObject({
      qrStatus: "scanned",
      qrUrl: "https://liteapp.weixin.qq.com/q/demo",
    })

    handleBotImStatus(
      {
        type: "community:bot.im_status",
        machineId: "m_1",
        botId: "bot_1",
        triggerId: "im_wx_1",
        provider: "wechat",
        status: "confirmed",
        botAccountLabel: "a5ac…@im.bot",
      },
      { queryClient } as never,
    )
    expect(queryClient.getQueryData<BotImQrStatusResponse>(qrKey)).toMatchObject({
      qrStatus: "confirmed",
      connectionStatus: "connected",
      botAccountLabel: "a5ac…@im.bot",
    })
    expect(queryClient.getQueryData<{ webhooks: BotWebhookSummary[] }>(webhooksKey)?.webhooks[0]).toMatchObject({
      connectionStatus: "connected",
      botAccountLabel: "a5ac…@im.bot",
      daemonLastError: null,
    })

    handleBotImStatus(
      {
        type: "community:bot.im_status",
        machineId: "m_1",
        botId: "bot_1",
        triggerId: "im_wx_1",
        provider: "wechat",
        status: "session_expired",
        error: "Session expired (-14)",
      },
      { queryClient } as never,
    )
    expect(queryClient.getQueryData<{ webhooks: BotWebhookSummary[] }>(webhooksKey)?.webhooks[0]).toMatchObject({
      connectionStatus: "session_expired",
      daemonLastError: "Session expired (-14)",
    })
  })
})
