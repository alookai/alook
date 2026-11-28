import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createElement, type PropsWithChildren } from "react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { useBotWebhookDeliveries, useBotWebhooks } from "./use-bot-webhooks"
import type { BotWebhookDelivery, BotWebhookSummary } from "@alook/shared"

const apiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

const sampleWebhook = (overrides: Partial<BotWebhookSummary> = {}): BotWebhookSummary => ({
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
  machineName: null,
  machineOnline: null,
  daemonLastError: null,
  eventFilter: ["workflow_run", "pull_request"],
  instruction: "Check failing logs",
  enabled: true,
  lastTriggeredAt: null,
  createdAt: "2026-11-27T08:00:00.000Z",
  updatedAt: "2026-11-27T08:00:00.000Z",
  lastDelivery: null,
  ...overrides,
})

const sampleDelivery = (overrides: Partial<BotWebhookDelivery> = {}): BotWebhookDelivery => ({
  id: "whd_1",
  webhookId: "wh_1",
  direction: "inbound",
  eventType: "test",
  summary: "Test notification for alook CI",
  senderId: null,
  senderLabel: null,
  chatLabel: null,
  status: "dispatched",
  lastError: null,
  externalDeliveryId: null,
  createdAt: "2026-11-27T08:05:00.000Z",
  dispatchedAt: "2026-11-27T08:05:01.000Z",
  ...overrides,
})

function setupWebhooks(botId = "bot_1", open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client }, children)
  return {
    ...renderHook(
      (props: { botId: string; open: boolean }) => useBotWebhooks(props.botId, props.open),
      { initialProps: { botId, open }, wrapper },
    ),
    client,
  }
}

function setupDeliveries(botId = "bot_1", webhookId: string | null = "wh_1", open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client }, children)
  return renderHook(
    (props: { botId: string; webhookId: string | null; open: boolean }) =>
      useBotWebhookDeliveries(props.botId, props.webhookId, props.open),
    { initialProps: { botId, webhookId, open }, wrapper },
  )
}

describe("useBotWebhooks", () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it("loads lazily only when open and parses list response", async () => {
    apiFetch.mockResolvedValue({ webhooks: [sampleWebhook()] })
    const view = setupWebhooks("bot_1", false)
    expect(apiFetch).not.toHaveBeenCalled()

    view.rerender({ botId: "bot_1", open: true })
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/community/bots/bot_1/webhooks",
      expect.objectContaining({ authenticationAccount: "viewer" }),
    )
    expect(view.result.current.webhooks).toHaveLength(1)
    expect(view.result.current.webhooks[0]?.name).toBe("alook CI")
  })

  it("supports create, update/rotate, test, and delete mutations with cache updates", async () => {
    const initial = sampleWebhook()
    const created = sampleWebhook({ id: "wh_2", name: "Deploy hook", provider: "generic", hasSigningSecret: false, eventFilter: null })
    const rotated = { ...created, updatedAt: "2026-11-27T08:10:00.000Z" }
    const testDelivery = sampleDelivery({ id: "whd_test", webhookId: "wh_2" })

    apiFetch.mockImplementation((path: string, options: RequestInit = {}) => {
      if (path === "/api/community/bots/bot_1/webhooks" && !options.method) {
        return Promise.resolve({ webhooks: [initial] })
      }
      if (path === "/api/community/bots/bot_1/webhooks" && options.method === "POST") {
        return Promise.resolve({
          webhook: created,
          webhookUrl: "https://alook.ai/api/webhooks/bot/tok_created",
          signingSecret: null,
        })
      }
      if (path === "/api/community/bots/bot_1/webhooks/wh_2" && options.method === "PATCH") {
        return Promise.resolve({
          webhook: rotated,
          webhookUrl: "https://alook.ai/api/webhooks/bot/tok_rotated",
          signingSecret: null,
        })
      }
      if (path === "/api/community/bots/bot_1/webhooks/wh_2/test" && options.method === "POST") {
        return Promise.resolve({ delivery: testDelivery })
      }
      if (path === "/api/community/bots/bot_1/webhooks/wh_2" && options.method === "DELETE") {
        return Promise.resolve({ deleted: true })
      }
      return Promise.reject(new Error(`Unexpected request: ${options.method ?? "GET"} ${path}`))
    })

    const view = setupWebhooks("bot_1", true)
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))

    const createResult = await act(() =>
      view.result.current.createWebhook({ name: "Deploy hook", provider: "generic", instruction: "" }),
    )
    expect(createResult.webhookUrl).toBe("https://alook.ai/api/webhooks/bot/tok_created")
    expect(createResult.signingSecret).toBeNull()

    const rotateResult = await act(() =>
      view.result.current.updateWebhook("wh_2", { rotateCredentials: true }),
    )
    expect(rotateResult.webhookUrl).toBe("https://alook.ai/api/webhooks/bot/tok_rotated")

    const testResult = await act(() => view.result.current.testWebhook("wh_2"))
    expect(testResult.delivery.status).toBe("dispatched")

    await act(() => view.result.current.deleteWebhook("wh_2"))
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/community/bots/bot_1/webhooks/wh_2",
      expect.objectContaining({ method: "DELETE" }),
    )
  })
})

describe("useBotWebhookDeliveries", () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it("fetches deliveries only when open and webhookId is present", async () => {
    apiFetch.mockResolvedValue({ deliveries: [sampleDelivery()] })
    const view = setupDeliveries("bot_1", null, false)
    expect(apiFetch).not.toHaveBeenCalled()

    view.rerender({ botId: "bot_1", webhookId: "wh_1", open: true })
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/community/bots/bot_1/webhooks/wh_1/deliveries",
      expect.objectContaining({ authenticationAccount: "viewer" }),
    )
    expect(view.result.current.deliveries[0]?.id).toBe("whd_1")
  })
})
