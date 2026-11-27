import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import type { BotWebhookDelivery, BotWebhookSummary } from "@alook/shared"

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
    creating: false,
    updating: false,
    deleting: false,
    testing: false,
    testingWebhookId: null,
    togglingWebhookId: null,
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
  hasSigningSecret: true,
  eventFilter: null,
  instruction: "Check logs when CI fails",
  enabled: true,
  lastTriggeredAt: "2026-11-27T08:00:00.000Z",
  createdAt: "2026-11-27T07:00:00.000Z",
  updatedAt: "2026-11-27T07:00:00.000Z",
  lastDelivery: {
    id: "whd_0",
    status: "dispatched",
    eventType: "workflow_run.completed",
    summary: "alookai/alook: CI failure (#1488)",
    lastError: null,
    createdAt: "2026-11-27T08:00:00.000Z",
  },
  ...overrides,
})

describe("BotWebhooksSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.webhooks = []
    mocks.isPending = false
    mocks.isError = false
    mocks.isFetching = false
    mocks.deliveries = []
    mocks.deliveriesPending = false
    mocks.deliveriesError = false
  })

  it("separates source choice from dedicated create forms, keeps General last, omits GitHub event checkboxes, and reveals one-time credentials", async () => {
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

    expect(view.getByText("No webhooks yet")).toBeInTheDocument()
    fireEvent.click(view.getByTestId(tid.botWebhooksCreateOpen))

    expect(view.getByText("Choose a source")).toBeInTheDocument()
    const githubBtn = view.getByTestId(tid.botWebhookProviderSelect("github"))
    const openaiBtn = view.getByTestId(tid.botWebhookProviderSelect("openai"))
    const cloudflareBtn = view.getByTestId(tid.botWebhookProviderSelect("cloudflare"))
    const genericBtn = view.getByTestId(tid.botWebhookProviderSelect("generic"))
    expect(githubBtn.compareDocumentPosition(genericBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(openaiBtn.compareDocumentPosition(genericBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(cloudflareBtn.compareDocumentPosition(genericBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(view.queryByText(/Standard Webhooks/i)).not.toBeInTheDocument()

    fireEvent.click(genericBtn)
    expect(view.getByText("New General webhook")).toBeInTheDocument()
    expect(view.getByTestId(tid.botWebhookRequireSecret)).toBeInTheDocument()
    expect(view.queryByText("GitHub events")).not.toBeInTheDocument()

    fireEvent.click(view.getByTestId(tid.botWebhookChangeProvider))
    fireEvent.click(view.getByTestId(tid.botWebhookProviderSelect("github")))

    expect(view.getByText("New GitHub webhook")).toBeInTheDocument()
    expect(view.getByTestId(tid.botWebhookNameInput)).toHaveValue("GitHub")
    expect(view.queryByTestId(tid.botWebhookRequireSecret)).not.toBeInTheDocument()
    expect(view.queryByText("GitHub events")).not.toBeInTheDocument()

    fireEvent.change(view.getByTestId(tid.botWebhookNameInput), { target: { value: "Repo CI" } })
    fireEvent.change(view.getByTestId(tid.botWebhookInstructionInput), { target: { value: "Fix red CI" } })
    fireEvent.click(view.getByTestId(tid.botWebhookSubmit))

    await waitFor(() => expect(view.getByTestId(tid.botWebhookCredentialsPanel)).toBeInTheDocument())
    expect(mocks.createWebhook).toHaveBeenCalledWith({
      name: "Repo CI",
      provider: "github",
      instruction: "Fix red CI",
      eventFilter: null,
    })
    expect(view.getByTestId(tid.botWebhookUrlValue)).toHaveValue("https://alook.ai/api/webhooks/bot/tok_secret_123")
    expect(view.getByTestId(tid.botWebhookSecretValue)).toHaveValue("whsec_abc123")
    expect(view.getByText("Connect in GitHub")).toBeInTheDocument()

    fireEvent.click(view.getByRole("button", { name: "Copy Webhook URL" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://alook.ai/api/webhooks/bot/tok_secret_123"))

    fireEvent.click(view.getByRole("button", { name: "Done" }))
    fireEvent.click(view.getByRole("button", { name: "I've saved them" }))
    expect(view.queryByTestId(tid.botWebhookCredentialsPanel)).not.toBeInTheDocument()
  })

  it("supports external-secret platforms by creating URL first and saving pasted signing secret inline", async () => {
    const created = webhookItem({
      id: "wh_stripe",
      name: "Stripe",
      provider: "stripe",
      hasSigningSecret: false,
      lastDelivery: null,
    })
    mocks.createWebhook.mockResolvedValue({
      webhook: created,
      webhookUrl: "https://alook.ai/api/webhooks/bot/tok_stripe_1",
      signingSecret: null,
    })
    mocks.updateWebhook.mockResolvedValue({
      webhook: { ...created, hasSigningSecret: true },
    })

    const view = render(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )

    fireEvent.click(view.getByTestId(tid.botWebhooksCreateOpen))
    fireEvent.click(view.getByTestId(tid.botWebhookProviderSelect("stripe")))
    expect(view.getByText("New Stripe webhook")).toBeInTheDocument()
    expect(view.getByTestId(tid.botWebhookNameInput)).toHaveValue("Stripe")

    fireEvent.click(view.getByTestId(tid.botWebhookSubmit))
    await waitFor(() => expect(view.getByTestId(tid.botWebhookCredentialsPanel)).toBeInTheDocument())
    expect(view.getByTestId(tid.botWebhookUrlValue)).toHaveValue("https://alook.ai/api/webhooks/bot/tok_stripe_1")
    expect(view.queryByTestId(tid.botWebhookSecretValue)).not.toBeInTheDocument()

    fireEvent.change(view.getByTestId(tid.botWebhookExternalSecretInput), {
      target: { value: "whsec_live_12345678" },
    })
    fireEvent.click(view.getByTestId(tid.botWebhookExternalSecretSave))

    await waitFor(() =>
      expect(mocks.updateWebhook).toHaveBeenCalledWith("wh_stripe", {
        signingSecret: "whsec_live_12345678",
      }),
    )
    expect(view.getByText("Signing secret saved — verified delivery is active.")).toBeInTheDocument()
  })

  it("supports toggling enabled, sending test notifications, deliveries panel, rotate, and delete", async () => {
    mocks.webhooks = [webhookItem()]
    mocks.deliveries = [
      {
        id: "whd_1",
        webhookId: "wh_1",
        eventType: "test",
        summary: "Test notification for alook CI",
        status: "pending",
        lastError: "machine_offline",
        externalDeliveryId: null,
        createdAt: "2026-11-27T08:05:00.000Z",
        dispatchedAt: null,
      },
    ]
    mocks.updateWebhook.mockResolvedValue({
      webhook: webhookItem({ enabled: false }),
      webhookUrl: "https://alook.ai/api/webhooks/bot/tok_rotated_456",
      signingSecret: "whsec_rotated",
    })
    mocks.testWebhook.mockResolvedValue({ delivery: mocks.deliveries[0] })
    mocks.deleteWebhook.mockResolvedValue(undefined)

    const view = render(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )

    expect(view.getByTestId(tid.botWebhookCard("wh_1"))).toBeInTheDocument()
    expect(view.getByText("alookai/alook: CI failure (#1488)")).toBeInTheDocument()

    fireEvent.click(view.getByTestId(tid.botWebhookTest("wh_1")))
    await waitFor(() => expect(mocks.testWebhook).toHaveBeenCalledWith("wh_1"))
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Test queued — Evan's machine is offline")
    expect(view.getByTestId(tid.botWebhookDeliveryRow("whd_1"))).toBeInTheDocument()
    expect(view.getByText("Machine offline — queued until reconnect")).toBeInTheDocument()

    fireEvent.click(view.getByTestId(tid.botWebhookToggle("wh_1")))
    await waitFor(() => expect(mocks.updateWebhook).toHaveBeenCalledWith("wh_1", { enabled: false }))

    fireEvent.click(view.getByTestId(tid.botWebhookRotate("wh_1")))
    fireEvent.click(view.getByRole("button", { name: "Rotate credentials" }))
    await waitFor(() => expect(view.getByTestId(tid.botWebhookCredentialsPanel)).toBeInTheDocument())
    expect(view.getByTestId(tid.botWebhookUrlValue)).toHaveValue("https://alook.ai/api/webhooks/bot/tok_rotated_456")

    fireEvent.click(view.getByRole("button", { name: "Done" }))
    fireEvent.click(view.getByRole("button", { name: "I've saved them" }))

    fireEvent.click(view.getByTestId(tid.botWebhookDelete("wh_1")))
    fireEvent.click(view.getByRole("button", { name: "Delete webhook" }))
    await waitFor(() => expect(mocks.deleteWebhook).toHaveBeenCalledWith("wh_1"))
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Deleted alook CI")
  })

  it("shows load error with retry action when fetch fails", () => {
    mocks.isError = true
    mocks.isPending = false
    const view = render(
      <BotWebhooksSheet bot={{ id: "bot_1", name: "Evan", image: null }} open onOpenChange={() => {}} />,
    )
    expect(view.getByText("Could not load webhooks.")).toBeInTheDocument()
  })
})
