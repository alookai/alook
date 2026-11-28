import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import type { BotImQrStatusResponse, BotWebhookDelivery, BotWebhookSummary } from "@alook/shared"

const mocks = vi.hoisted(() => ({
  webhooks: [] as BotWebhookSummary[],
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  testWebhook: vi.fn(),
  allowSender: vi.fn(),
  startImQr: vi.fn(),
  startingQrTriggerId: null as string | null,
  qrState: null as BotImQrStatusResponse | null,
  deliveries: [] as BotWebhookDelivery[],
  deliveriesPending: false,
  deliveriesError: false,
  deliveriesRefetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}))

vi.mock("@/hooks/community/use-bot-webhooks", () => ({
  useBotWebhooks: () => ({
    data: (mocks.isPending || mocks.isError) && mocks.webhooks.length === 0 ? undefined : { webhooks: mocks.webhooks },
    webhooks: mocks.webhooks,
    isPending: mocks.isPending,
    isError: mocks.isError,
    isFetching: mocks.isFetching,
    refetch: mocks.refetch,
    createWebhook: mocks.createWebhook,
    updateWebhook: mocks.updateWebhook,
    deleteWebhook: mocks.deleteWebhook,
    testWebhook: mocks.testWebhook,
    allowSender: mocks.allowSender,
    startImQr: mocks.startImQr,
    creating: false,
    updating: false,
    deleting: false,
    testing: false,
    testingWebhookId: null,
    togglingWebhookId: null,
    allowingSenderKey: null,
    startingQrTriggerId: mocks.startingQrTriggerId,
    pending: false,
    capture: () => Object.assign(() => {}, { signal: new AbortController().signal }),
  }),
  useBotWebhookDeliveries: () => ({
    data: mocks.deliveriesPending ? undefined : { deliveries: mocks.deliveries },
    deliveries: mocks.deliveries,
    isPending: mocks.deliveriesPending,
    isError: mocks.deliveriesError,
    isFetching: false,
    refetch: mocks.deliveriesRefetch,
  }),
  useBotImQrStatus: () => ({
    data: mocks.qrState ?? undefined,
    qrState: mocks.qrState,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}))

vi.mock("@/hooks/community/use-community-view-source", () => ({
  useCommunityViewSource: () => ({
    capture: () => Object.assign(() => {}, { signal: new AbortController().signal }),
  }),
}))

vi.mock("../shell/community-sheet", () => ({
  CommunitySheet: ({
    children,
    title,
    description,
    contentTestId,
  }: React.PropsWithChildren<{ title: React.ReactNode; description?: React.ReactNode; contentTestId?: string }>) => (
    <div data-testid={contentTestId}>
      <h2>{title}</h2>
      <div>{description}</div>
      {children}
    </div>
  ),
}))

vi.mock("@/components/avatar", () => ({
  AgentAvatar: ({ name, seed }: { name: string; seed: string }) => (
    <span data-avatar-name={name} data-avatar-seed={seed} />
  ),
}))

vi.mock("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmLabel,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean
    title: string
    description: string
    confirmLabel?: string
    onConfirm: () => void
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <p>{title}</p>
        <p>{description}</p>
        <button type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button type="button" data-confirm-action="true" onClick={onConfirm}>
          {confirmLabel ?? "Confirm"}
        </button>
      </div>
    ) : null,
}))

import { BotWebhooksSheet } from "./bot-webhooks-sheet"

const webhookItem = (overrides: Partial<BotWebhookSummary> = {}): BotWebhookSummary => ({
  id: "wh_1",
  botId: "bot_1",
  name: "alook CI",
  provider: "github",
  category: "webhook",
  transport: "cloud_webhook",
  connectionStatus: "connected",
  hasSigningSecret: true,
  hasOutboundCredentials: false,
  accessPolicy: "allowlist",
  allowedSenders: [],
  requireMentionInGroups: true,
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
  lastTriggeredAt: "2026-11-27T08:00:00.000Z",
  createdAt: "2026-11-27T07:00:00.000Z",
  updatedAt: "2026-11-27T07:00:00.000Z",
  lastDelivery: {
    id: "whd_0",
    direction: "inbound",
    senderId: null,
    senderLabel: null,
    chatLabel: null,
    status: "dispatched",
    eventType: "workflow_run.completed",
    summary: "alookai/alook: CI failure (#1488)",
    lastError: null,
    createdAt: "2026-11-27T08:00:00.000Z",
  },
  ...overrides,
})

const imItem = (overrides: Partial<BotWebhookSummary> = {}): BotWebhookSummary =>
  webhookItem({
    id: "im_1",
    name: "Telegram",
    provider: "telegram",
    category: "im",
    transport: "cloud_webhook",
    connectionStatus: "connected",
    hasSigningSecret: true,
    hasOutboundCredentials: true,
    botUsername: "evan_bot",
    lastDelivery: null,
    ...overrides,
  })

describe("BotWebhooksSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.webhooks = []
    mocks.isPending = false
    mocks.isError = false
    mocks.isFetching = false
    mocks.startingQrTriggerId = null
    mocks.qrState = null
    mocks.deliveries = []
    mocks.deliveriesPending = false
    mocks.deliveriesError = false
  })

  it("renders Triggers dual tabs (IM | Webhooks), separates Slack into IM, and supports GitHub webhook creation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const created = webhookItem({ id: "wh_new", name: "Repo CI", provider: "github" })
    mocks.createWebhook.mockResolvedValue({
      webhook: created,
      webhookUrl: "https://alook.ai/api/webhooks/bot/tok_secret_123",
      signingSecret: "whsec_abc123",
    })

    const view = render(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )

    expect(view.getByText("Triggers")).toBeInTheDocument()
    expect(view.getByTestId(tid.botTriggersTab("im"))).toHaveAttribute("aria-selected", "true")
    expect(view.getByText("No IM channels yet")).toBeInTheDocument()

    fireEvent.click(view.getByTestId(tid.botTriggersTab("webhook")))
    expect(view.getByText("No webhooks yet")).toBeInTheDocument()
    fireEvent.click(view.getByTestId(tid.botWebhooksCreateOpen))

    expect(view.getByText("Choose a source")).toBeInTheDocument()
    expect(view.queryByTestId(tid.botWebhookProviderSelect("slack"))).not.toBeInTheDocument()
    expect(view.queryByTestId(tid.botWebhookProviderSelect("telegram"))).not.toBeInTheDocument()
    const githubBtn = view.getByTestId(tid.botWebhookProviderSelect("github"))
    const openaiBtn = view.getByTestId(tid.botWebhookProviderSelect("openai"))
    const cloudflareBtn = view.getByTestId(tid.botWebhookProviderSelect("cloudflare"))
    const genericBtn = view.getByTestId(tid.botWebhookProviderSelect("generic"))
    expect(githubBtn.compareDocumentPosition(genericBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(openaiBtn.compareDocumentPosition(genericBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(cloudflareBtn.compareDocumentPosition(genericBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(genericBtn)
    expect(view.getByText("New Custom app trigger")).toBeInTheDocument()
    expect(view.getByTestId(tid.botWebhookRequireSecret)).toBeInTheDocument()

    fireEvent.click(view.getByTestId(tid.botWebhookChangeProvider))
    fireEvent.click(view.getByTestId(tid.botWebhookProviderSelect("github")))

    expect(view.getByText("New GitHub trigger")).toBeInTheDocument()
    expect(view.getByTestId(tid.botWebhookNameInput)).toHaveValue("GitHub")
    expect(view.queryByTestId(tid.botWebhookRequireSecret)).not.toBeInTheDocument()

    fireEvent.change(view.getByTestId(tid.botWebhookNameInput), { target: { value: "Repo CI" } })
    fireEvent.click(view.getByTestId(tid.botWebhookSubmit))

    await waitFor(() => expect(view.getByTestId(tid.botWebhookCredentialsPanel)).toBeInTheDocument())
    expect(mocks.createWebhook).toHaveBeenCalledWith({
      name: "Repo CI",
      provider: "github",
      instruction: "",
      eventFilter: null,
    })
    expect(view.getByTestId(tid.botWebhookUrlValue)).toHaveValue("https://alook.ai/api/webhooks/bot/tok_secret_123")
    expect(view.getByTestId(tid.botWebhookSecretValue)).toHaveValue("whsec_abc123")
    expect(view.getByText("Connect in GitHub")).toBeInTheDocument()

    fireEvent.click(view.getByRole("button", { name: "Copy Trigger link" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://alook.ai/api/webhooks/bot/tok_secret_123"))

    fireEvent.click(view.getByRole("button", { name: "Done" }))
    fireEvent.click(view.getByRole("button", { name: "I've saved them" }))
    expect(view.queryByTestId(tid.botWebhookCredentialsPanel)).not.toBeInTheDocument()
  })

  it("supports external-key webhook platforms by creating link first and saving pasted key inline", async () => {
    const created = webhookItem({
      id: "wh_stripe",
      name: "Stripe",
      provider: "stripe",
      connectionStatus: "setup_required",
      hasSigningSecret: false,
      lastDelivery: null,
    })
    mocks.createWebhook.mockResolvedValue({
      webhook: created,
      webhookUrl: "https://alook.ai/api/webhooks/bot/tok_stripe_1",
      signingSecret: null,
    })
    mocks.updateWebhook.mockResolvedValue({
      webhook: { ...created, hasSigningSecret: true, connectionStatus: "connected" },
    })

    const view = render(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )

    fireEvent.click(view.getByTestId(tid.botTriggersTab("webhook")))
    fireEvent.click(view.getByTestId(tid.botWebhooksCreateOpen))
    fireEvent.click(view.getByTestId(tid.botWebhookProviderSelect("stripe")))
    expect(view.getByText("New Stripe trigger")).toBeInTheDocument()

    fireEvent.click(view.getByTestId(tid.botWebhookSubmit))
    await waitFor(() => expect(view.getByTestId(tid.botWebhookCredentialsPanel)).toBeInTheDocument())
    expect(view.getByTestId(tid.botWebhookUrlValue)).toHaveValue("https://alook.ai/api/webhooks/bot/tok_stripe_1")

    fireEvent.change(view.getByTestId(tid.botWebhookExternalSecretInput), {
      target: { value: "whsec_live_12345678" },
    })
    fireEvent.click(view.getByTestId(tid.botWebhookExternalSecretSave))

    await waitFor(() =>
      expect(mocks.updateWebhook).toHaveBeenCalledWith("wh_stripe", {
        signingSecret: "whsec_live_12345678",
      }),
    )
    expect(view.getByText("Verification key saved — Stripe triggers are active.")).toBeInTheDocument()
  })

  it("connects Telegram in one step without showing a manual callback URL screen", async () => {
    const created = imItem({
      id: "im_tg_new",
      name: "Telegram",
      provider: "telegram",
      botUsername: "my_alook_bot",
    })
    mocks.createWebhook.mockResolvedValue({
      webhook: created,
      webhookUrl: "https://alook.ai/api/webhooks/bot/tg_auto_registered",
      signingSecret: null,
    })

    const view = render(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )

    fireEvent.click(view.getByTestId(tid.botWebhooksCreateOpen))
    expect(view.getByText("Connect an IM platform")).toBeInTheDocument()
    expect(view.getByTestId(tid.botWebhookProviderSelect("telegram"))).toBeInTheDocument()
    expect(view.getByTestId(tid.botWebhookProviderSelect("feishu"))).toBeInTheDocument()
    expect(view.getByTestId(tid.botWebhookProviderSelect("slack"))).toBeInTheDocument()
    expect(view.getByTestId(tid.botWebhookProviderSelect("wechat"))).toBeInTheDocument()

    fireEvent.click(view.getByTestId(tid.botWebhookProviderSelect("telegram")))
    expect(view.getByRole("heading", { name: "Connect Telegram" })).toBeInTheDocument()
    fireEvent.change(view.getByTestId(tid.botImBotTokenInput), {
      target: { value: "123456:AA_test_token" },
    })
    fireEvent.click(view.getByTestId(tid.botWebhookSubmit))

    await waitFor(() =>
      expect(mocks.createWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Telegram",
          provider: "telegram",
          botToken: "123456:AA_test_token",
          accessPolicy: "allowlist",
          allowedSenders: [],
          requireMentionInGroups: true,
        }),
      ),
    )
    expect(view.queryByTestId(tid.botWebhookCredentialsPanel)).not.toBeInTheDocument()
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Connected as @my_alook_bot")
  })

  it("connects Feishu/Lark and bidirectional Slack with Event Callback URL reveal and no Send test", async () => {
    const feishuCreated = imItem({
      id: "im_fs_new",
      name: "Feishu",
      provider: "feishu",
      region: "global",
      feishuAppId: "cli_12345",
      connectionStatus: "setup_required",
    })
    mocks.createWebhook.mockResolvedValueOnce({
      webhook: feishuCreated,
      webhookUrl: "https://alook.ai/api/webhooks/bot/tok_fs_1",
      signingSecret: null,
    })

    const view = render(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )

    fireEvent.click(view.getByTestId(tid.botWebhooksCreateOpen))
    fireEvent.click(view.getByTestId(tid.botWebhookProviderSelect("feishu")))
    fireEvent.click(view.getByTestId(tid.botImFeishuRegion("global")))
    fireEvent.change(view.getByTestId(tid.botImFeishuAppIdInput), { target: { value: "cli_12345" } })
    fireEvent.change(view.getByTestId(tid.botImFeishuAppSecretInput), { target: { value: "fs_secret_1234" } })
    fireEvent.click(view.getByTestId(tid.botWebhookSubmit))

    await waitFor(() => expect(view.getByTestId(tid.botWebhookCredentialsPanel)).toBeInTheDocument())
    expect(mocks.createWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "feishu",
        feishuRegion: "global",
        feishuAppId: "cli_12345",
        feishuAppSecret: "fs_secret_1234",
      }),
    )
    expect(view.getByText("Event Callback URL")).toBeInTheDocument()
    expect(view.queryByRole("button", { name: /Send test/i })).not.toBeInTheDocument()
  })

  it("requires both Signing Secret and Bot Token when creating bidirectional Slack IM", async () => {
    const slackCreated = imItem({
      id: "im_sl_new",
      name: "Slack",
      provider: "slack",
      connectionStatus: "connected",
    })
    mocks.createWebhook.mockResolvedValue({
      webhook: slackCreated,
      webhookUrl: "https://alook.ai/api/webhooks/bot/tok_sl_1",
      signingSecret: null,
    })

    const view = render(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )

    fireEvent.click(view.getByTestId(tid.botWebhooksCreateOpen))
    fireEvent.click(view.getByTestId(tid.botWebhookProviderSelect("slack")))
    fireEvent.change(view.getByTestId(tid.botWebhookExternalSecretInput), {
      target: { value: "slack_signing_secret_123" },
    })
    fireEvent.change(view.getByTestId(tid.botImBotTokenInput), {
      target: { value: "xoxb-test-token-123" },
    })
    fireEvent.click(view.getByTestId(tid.botWebhookSubmit))

    await waitFor(() => expect(view.getByTestId(tid.botWebhookCredentialsPanel)).toBeInTheDocument())
    expect(mocks.createWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "slack",
        signingSecret: "slack_signing_secret_123",
        botToken: "xoxb-test-token-123",
      }),
    )
    expect(view.getByText("Event Request URL")).toBeInTheDocument()
  })

  it("renders IM history with blocked sender one-click Allow and outbound Replied rows", async () => {
    const tg = imItem({ id: "im_tg_1", name: "Telegram", allowedSenders: [] })
    mocks.webhooks = [tg]
    mocks.deliveries = [
      {
        id: "del_blocked",
        webhookId: "im_tg_1",
        direction: "inbound",
        senderId: "998877",
        senderLabel: "Alice",
        chatLabel: "DM",
        eventType: "im.message",
        summary: "Hey bot, can you hear me?",
        status: "blocked",
        lastError: "sender_not_allowed",
        externalDeliveryId: "tg-1",
        createdAt: "2026-11-28T08:05:00.000Z",
        dispatchedAt: null,
      },
      {
        id: "del_reply",
        webhookId: "im_tg_1",
        direction: "outbound",
        senderId: null,
        senderLabel: null,
        chatLabel: "DM",
        eventType: "im.reply",
        summary: "Yes, loud and clear!",
        status: "dispatched",
        lastError: null,
        externalDeliveryId: "tg-2",
        createdAt: "2026-11-28T08:06:00.000Z",
        dispatchedAt: "2026-11-28T08:06:00.000Z",
      },
    ]
    mocks.allowSender.mockResolvedValue({
      webhook: { ...tg, allowedSenders: ["998877"] },
      added: true,
    })

    const view = render(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )

    expect(view.queryByTestId(tid.botWebhookTest("im_tg_1"))).not.toBeInTheDocument()
    fireEvent.click(view.getByTestId(tid.botWebhookDeliveriesToggle("im_tg_1")))

    expect(view.getByText("Blocked · not allowed")).toBeInTheDocument()
    expect(view.getByText("DM · Alice")).toBeInTheDocument()
    expect(view.getByText("Replied")).toBeInTheDocument()

    fireEvent.click(view.getByTestId(tid.botImAllowSender("del_blocked")))
    await waitFor(() => expect(mocks.allowSender).toHaveBeenCalledWith("im_tg_1", "998877"))
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Sender allowed")
  })

  it("renders WeChat QR login panel states including SVG QR, scanned overlay, confirmed, and offline guard", async () => {
    const wechat = imItem({
      id: "im_wx_1",
      name: "WeChat",
      provider: "wechat",
      transport: "daemon_poll",
      connectionStatus: "session_expired",
      hasSigningSecret: false,
      hasOutboundCredentials: false,
      requireMentionInGroups: false,
      botUsername: null,
      botAccountLabel: "a5ac…@im.bot",
      machineName: "Gus's MacBook",
      machineOnline: true,
    })
    mocks.webhooks = [wechat]
    mocks.qrState = {
      triggerId: "im_wx_1",
      connectionStatus: "scan_required",
      qrStatus: "pending",
      sessionId: "qr_sess_1",
      qrUrl: "https://liteapp.weixin.qq.com/q/7VuYN?qrcode=0123456789abcdef",
      expiresAt: "2026-11-28T08:10:00.000Z",
      botAccountLabel: null,
      error: null,
    }

    const view = render(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )

    expect(view.getByText("Session expired")).toBeInTheDocument()
    fireEvent.click(view.getByTestId(tid.botImRescan("im_wx_1")))

    expect(view.getByTestId(tid.botImQrPanel)).toBeInTheDocument()
    expect(view.getByTestId(tid.botImQrSvg)).toBeInTheDocument()
    expect(view.getByText("Scan with WeChat on your phone.")).toBeInTheDocument()

    mocks.qrState = { ...mocks.qrState, qrStatus: "scanned" }
    view.rerender(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )
    expect(view.getByText("Scanned — confirm on phone")).toBeInTheDocument()

    mocks.qrState = {
      ...mocks.qrState,
      qrStatus: "confirmed",
      connectionStatus: "connected",
      botAccountLabel: "a5ac…@im.bot",
    }
    view.rerender(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )
    expect(view.getByText("Connected via Gus's MacBook")).toBeInTheDocument()
    expect(view.getByText("a5ac…@im.bot")).toBeInTheDocument()
  })

  it("supports toggling enabled, sending test notifications, trigger history, reset link, and delete for webhooks", async () => {
    mocks.webhooks = [webhookItem()]
    mocks.deliveries = [
      {
        id: "whd_1",
        webhookId: "wh_1",
        direction: "inbound",
        senderId: null,
        senderLabel: null,
        chatLabel: null,
        eventType: "test",
        summary: "Test notification for alook CI",
        status: "pending",
        lastError: "machine_offline",
        externalDeliveryId: null,
        createdAt: "2026-11-27T08:05:00.000Z",
        dispatchedAt: null,
      },
      {
        id: "whd_ping",
        webhookId: "wh_1",
        direction: "inbound",
        senderId: null,
        senderLabel: null,
        chatLabel: null,
        eventType: "ping",
        summary: "GitHub ping from alookai/alook",
        status: "ignored",
        lastError: null,
        externalDeliveryId: null,
        createdAt: "2026-11-27T08:00:00.000Z",
        dispatchedAt: null,
      },
    ]
    mocks.updateWebhook.mockResolvedValue({
      webhook: webhookItem({ enabled: false, connectionStatus: "paused" }),
      webhookUrl: "https://alook.ai/api/webhooks/bot/tok_rotated_456",
      signingSecret: "whsec_rotated",
    })
    mocks.testWebhook.mockResolvedValue({ delivery: mocks.deliveries[0] })
    mocks.deleteWebhook.mockResolvedValue(undefined)

    const view = render(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )

    expect(view.getByTestId(tid.botTriggersTab("webhook"))).toHaveAttribute("aria-selected", "true")
    expect(view.getByTestId(tid.botWebhookCard("wh_1"))).toBeInTheDocument()

    fireEvent.click(view.getByTestId(tid.botWebhookTest("wh_1")))
    await waitFor(() => expect(mocks.testWebhook).toHaveBeenCalledWith("wh_1"))
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Test queued — Evan's machine is offline")
    expect(view.getByText("Recent triggers")).toBeInTheDocument()
    expect(view.getByTestId(tid.botWebhookDeliveryRow("whd_1"))).toBeInTheDocument()
    expect(view.getByText("Machine offline — queued until reconnect")).toBeInTheDocument()
    expect(view.getByTestId(tid.botWebhookDeliveryRow("whd_ping"))).toBeInTheDocument()
    expect(view.getByText("Connected")).toBeInTheDocument()

    fireEvent.click(view.getByTestId(tid.botWebhookToggle("wh_1")))
    await waitFor(() => expect(mocks.updateWebhook).toHaveBeenCalledWith("wh_1", { enabled: false }))

    fireEvent.click(view.getByTestId(tid.botWebhookRotate("wh_1")))
    fireEvent.click(view.getByRole("button", { name: "Reset link" }))
    await waitFor(() => expect(view.getByTestId(tid.botWebhookCredentialsPanel)).toBeInTheDocument())
    expect(view.getByTestId(tid.botWebhookUrlValue)).toHaveValue("https://alook.ai/api/webhooks/bot/tok_rotated_456")

    fireEvent.click(view.getByRole("button", { name: "Done" }))
    fireEvent.click(view.getByRole("button", { name: "I've saved them" }))

    fireEvent.click(view.getByTestId(tid.botWebhookDelete("wh_1")))
    fireEvent.click(view.getByRole("button", { name: "Delete trigger" }))
    await waitFor(() => expect(mocks.deleteWebhook).toHaveBeenCalledWith("wh_1"))
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Deleted alook CI")
  })

  it("shows load error with retry action when fetch fails", () => {
    mocks.isError = true
    mocks.isPending = false
    const view = render(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )
    expect(view.getByText("Could not load triggers.")).toBeInTheDocument()
  })
})
