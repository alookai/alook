import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import type { BotSummary } from "@/hooks/community/use-bots"

// Online-only UI contract (Ruthann #1274/#1280 / Shelly gate):
// - provider picker is `bot-provider-picker` radiogroup (same shape as create)
// - provider change → AlertDialog first; confirm then PATCH; dispatched toast
// - model switch → "Model switch to … dispatched" only after PATCH succeeds
// - no offline-saved / next-wake toast copy

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
  },
}))

const toastApiError = vi.fn()
vi.mock("@/lib/api/client", () => ({ toastApiError: (...a: unknown[]) => toastApiError(...a) }))

const updateMutateAsync = vi.fn()
vi.mock("@/hooks/community/use-bots", () => ({
  useUpdateBot: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
  useUploadBotAvatar: () => ({ mutateAsync: vi.fn() }),
}))

const useMachinesMock = vi.fn()
vi.mock("@/hooks/community/use-machines", () => ({
  useMachines: () => useMachinesMock(),
}))

const HEALTHY_MACHINES = {
  machines: [
    {
      id: "mac1",
      daemonVersion: "0.1.24",
      availableRuntimes: [
        { id: "claude", status: "healthy" },
        { id: "codex", status: "healthy" },
      ],
    },
  ],
}

const reasoningFieldRenders: Array<{
  daemonVersion: string | undefined
  value: string | null
}> = []

vi.mock("@/components/community/shell/community-sheet", () => {
  const React = require("react")
  return {
    CommunitySheet: ({ children, footer }: {
      children?: React.ReactNode
      footer?: React.ReactNode | ((requestClose: () => void) => React.ReactNode)
    }) => React.createElement(
      "div",
      { "data-mock": "sheet" },
      children,
      typeof footer === "function" ? footer(vi.fn()) : footer,
    ),
  }
})

vi.mock("@/components/ui/button", () => {
  const React = require("react")
  return {
    Button: ({ children, onClick, disabled }: any) =>
      React.createElement("button", { onClick, disabled }, children),
  }
})

vi.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children?: React.ReactNode }) =>
    require("react").createElement("label", null, children),
}))

vi.mock("@/components/ui/alert-dialog", () => {
  const React = require("react")
  return {
    AlertDialog: ({
      open,
      children,
    }: {
      open: boolean
      children?: React.ReactNode
    }) => (open ? React.createElement("div", { "data-testid": "provider-confirm" }, children) : null),
    AlertDialogContent: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    AlertDialogHeader: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    AlertDialogFooter: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    AlertDialogTitle: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("h2", null, children),
    AlertDialogDescription: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("p", null, children),
    AlertDialogCancel: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("button", { "data-testid": "provider-cancel" }, children),
    AlertDialogAction: ({
      children,
      onClick,
    }: {
      children?: React.ReactNode
      onClick?: () => void
    }) =>
      React.createElement(
        "button",
        { "data-testid": "provider-confirm-action", onClick },
        children,
      ),
  }
})

vi.mock("@/components/provider-logo", () => ({
  ProviderLogo: () => require("react").createElement("span", { "data-mock": "provider-logo" }),
}))

vi.mock("@/lib/utils", () => ({
  cn: (...a: unknown[]) => a.filter(Boolean).join(" "),
}))

vi.mock("./bot-form-fields", () => ({
  BotFormFields: ({ setDescription }: { setDescription: (value: string) => void }) =>
    require("react").createElement("button", {
      "data-testid": "set-description",
      onClick: () => setDescription("Updated description"),
    }),
}))
const modelFieldRenders: Array<{ runtime: { id: string; reasoning?: unknown } | null }> = []
vi.mock("./model-field", () => {
  const React = require("react")
  return {
    ModelField: ({ runtime, onChange }: {
      runtime: { id: string; reasoning?: unknown } | null
      onChange: (v: string | null) => void
    }) => {
      modelFieldRenders.push({ runtime })
      return React.createElement("button", {
        "data-testid": "set-model",
        onClick: () => onChange("claude-sonnet-4-6"),
      })
    },
  }
})
vi.mock("./reasoning-effort-field", () => {
  const React = require("react")
  return {
    ReasoningEffortField: ({ onChange, daemonVersion, value }: {
      onChange: (value: string | null) => void
      daemonVersion?: string
      value: string | null
    }) => {
      reasoningFieldRenders.push({ daemonVersion, value })
      return React.createElement("button", {
        "data-testid": "set-reasoning-effort",
        onClick: () => onChange("xhigh"),
      })
    },
  }
})
vi.mock("@/components/avatar", () => ({
  isPhotoAvatarUrl: () => false,
}))
vi.mock("@/lib/avatar/seed-url", () => ({
  serializeBeamSeed: (s: string) => `beam:${s}`,
  parseBeamSeed: () => true,
}))

import { EditBotSheet } from "./edit-bot-sheet"

const BOT: BotSummary = {
  id: "b1",
  name: "Blake",
  description: "",
  image: "beam:b1",
  machineId: "mac1",
  runtime: "claude",
  modelName: null,
  lastRefreshContextAt: null,
  dailyActivity: [],
}

function renderSheet(bot: BotSummary = BOT): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(EditBotSheet, { bot, open: true, onOpenChange: vi.fn() }),
    )
  })
  return renderer
}

function saveButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    (n) => n.type === "button" && !n.props["data-testid"] && n.props.children === "Save",
  )
}

function pickRuntime(renderer: TestRenderer.ReactTestRenderer, value: string) {
  const radio = renderer.root.find(
    (n) => n.type === "input" && n.props.name === "edit-bot-runtime" && n.props.value === value,
  )
  act(() => radio.props.onChange({ target: { value } }))
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function runtimeRadio(renderer: TestRenderer.ReactTestRenderer, value: string) {
  return renderer.root.find(
    (n) => n.type === "input" && n.props.name === "edit-bot-runtime" && n.props.value === value,
  )
}

describe("EditBotSheet — model switch toast (online-only)", () => {
  beforeEach(() => {
    toastSuccess.mockReset()
    toastError.mockReset()
    toastApiError.mockReset()
    updateMutateAsync.mockReset()
    useMachinesMock.mockReturnValue(HEALTHY_MACHINES)
  })

  it("uses only the bot machine's catalog when another machine reports the same runtime", () => {
    const reasoning = (id: string) => ({
      updateMode: "unsupported",
      models: [{ id, supportedReasoningEfforts: [] }],
    })
    useMachinesMock.mockReturnValue({
      machines: [
        { id: "mac1", availableRuntimes: [{ id: "claude", status: "healthy", reasoning: reasoning("mac-model") }] },
        { id: "mac2", availableRuntimes: [{ id: "claude", status: "healthy", reasoning: reasoning("other-model") }] },
      ],
    })
    modelFieldRenders.length = 0
    renderSheet()
    expect(modelFieldRenders.at(-1)?.runtime?.reasoning).toEqual(reasoning("mac-model"))
  })

  it("PATCH success → 'Model switch to <new> dispatched'", async () => {
    updateMutateAsync.mockResolvedValue({ bot: { ...BOT, modelName: "claude-sonnet-4-6" } })
    const renderer = renderSheet()
    expect(renderer.root.find((n) => n.props?.["data-testid"] === "bot-provider-picker")).toBeTruthy()
    act(() => renderer.root.find((n) => n.props?.["data-testid"] === "set-model").props.onClick())
    act(() => {
      void saveButton(renderer).props.onClick()
    })
    await flush()
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b1", model: "claude-sonnet-4-6" }),
    )
    expect(toastSuccess).toHaveBeenCalledWith("Model switch to claude-sonnet-4-6 dispatched")
    expect(toastSuccess.mock.calls.join(" ")).not.toMatch(/offline|next wake|applies when/i)
  })

  it("PATCH failure → toastApiError, no success toast", async () => {
    updateMutateAsync.mockRejectedValue(new Error("Bot offline"))
    const renderer = renderSheet()
    act(() => renderer.root.find((n) => n.props?.["data-testid"] === "set-model").props.onClick())
    act(() => {
      void saveButton(renderer).props.onClick()
    })
    await flush()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastApiError).toHaveBeenCalled()
  })
})

describe("EditBotSheet — reasoning effort", () => {
  beforeEach(() => {
    reasoningFieldRenders.length = 0
    toastSuccess.mockReset()
    toastApiError.mockReset()
    updateMutateAsync.mockReset()
    useMachinesMock.mockReturnValue(HEALTHY_MACHINES)
  })

  it("passes only the bot daemon version into the shared field", () => {
    renderSheet()
    expect(reasoningFieldRenders).toContainEqual({
      daemonVersion: "0.1.24",
      value: null,
    })
  })

  it("does not PATCH reasoning effort when stored Default remains unchanged", async () => {
    updateMutateAsync.mockResolvedValue({ bot: BOT })
    const renderer = renderSheet({ ...BOT, reasoningEffort: null })
    act(() => {
      void saveButton(renderer).props.onClick()
    })
    await flush()

    expect(updateMutateAsync).toHaveBeenCalledOnce()
    expect(updateMutateAsync.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort")
  })

  it("preserves stored Low on an old daemon when saving an unrelated field", async () => {
    const bot = { ...BOT, reasoningEffort: "low" as const }
    updateMutateAsync.mockResolvedValue({
      bot: { ...bot, description: "Updated description" },
    })
    const renderer = renderSheet(bot)
    expect(reasoningFieldRenders).toContainEqual({
      daemonVersion: "0.1.24",
      value: "low",
    })

    act(() => renderer.root.findByProps({ "data-testid": "set-description" }).props.onClick())
    act(() => {
      void saveButton(renderer).props.onClick()
    })
    await flush()

    expect(updateMutateAsync).toHaveBeenCalledOnce()
    expect(updateMutateAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: "b1", description: "Updated description" }),
    )
    expect(updateMutateAsync.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort")
  })

  it("PATCHes the explicit effort without provider confirmation and reports next-turn application", async () => {
    updateMutateAsync.mockResolvedValue({
      bot: { ...BOT, reasoningEffort: "xhigh", runtimeConfigRevision: 2 },
      application: "next_turn",
    })
    const renderer = renderSheet()
    act(() => renderer.root.findByProps({ "data-testid": "set-reasoning-effort" }).props.onClick())
    act(() => {
      void saveButton(renderer).props.onClick()
    })
    await flush()

    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b1", reasoningEffort: "xhigh" }),
    )
    expect(renderer.root.findAllByProps({ "data-testid": "provider-confirm" })).toHaveLength(0)
    expect(toastSuccess).toHaveBeenCalledWith("Reasoning effort saved. Next turn takes effect.")
  })
})

describe("EditBotSheet — provider switch AlertDialog + toast", () => {
  beforeEach(() => {
    toastSuccess.mockReset()
    toastError.mockReset()
    toastApiError.mockReset()
    updateMutateAsync.mockReset()
    useMachinesMock.mockReturnValue(HEALTHY_MACHINES)
  })

  it("Save with new provider opens confirm dialog and does not PATCH yet", () => {
    const renderer = renderSheet()
    pickRuntime(renderer, "codex")
    act(() => {
      void saveButton(renderer).props.onClick()
    })
    expect(renderer.root.findAll((n) => n.props?.["data-testid"] === "provider-confirm")).toHaveLength(
      1,
    )
    expect(updateMutateAsync).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("confirm → PATCH with runtime + cleared model, then dispatched toast", async () => {
    updateMutateAsync.mockResolvedValue({ bot: { ...BOT, runtime: "codex", modelName: null } })
    const renderer = renderSheet({ ...BOT, modelName: "claude-sonnet-4-6" })
    pickRuntime(renderer, "codex")
    act(() => {
      void saveButton(renderer).props.onClick()
    })
    act(() =>
      renderer.root
        .find((n) => n.props?.["data-testid"] === "provider-confirm-action")
        .props.onClick(),
    )
    await flush()
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "b1",
        runtime: "codex",
        model: null,
      }),
    )
    expect(toastSuccess).toHaveBeenCalledWith("Provider switch to codex dispatched")
    expect(toastSuccess.mock.calls.join(" ")).not.toMatch(/offline|next wake|applies when/i)
  })

  it("cancel dialog → no PATCH", () => {
    const renderer = renderSheet()
    pickRuntime(renderer, "codex")
    act(() => {
      void saveButton(renderer).props.onClick()
    })
    expect(renderer.root.find((n) => n.props?.["data-testid"] === "provider-cancel")).toBeTruthy()
    expect(updateMutateAsync).not.toHaveBeenCalled()
  })
})

describe("EditBotSheet — current unhealthy runtime stays selectable (Alli #1287 / Ruthann #1289)", () => {
  beforeEach(() => {
    useMachinesMock.mockReturnValue({
      machines: [
        {
          id: "mac1",
          availableRuntimes: [
            { id: "claude", status: "unhealthy" },
            { id: "codex", status: "healthy" },
            { id: "cursor", status: "unhealthy" },
          ],
        },
      ],
    })
  })

  it("selected current runtime is not disabled even when unhealthy; other unhealthy candidates are", () => {
    const renderer = renderSheet({ ...BOT, runtime: "claude" })
    const current = runtimeRadio(renderer, "claude")
    const otherUnhealthy = runtimeRadio(renderer, "cursor")
    const healthy = runtimeRadio(renderer, "codex")
    expect(current.props.checked).toBe(true)
    expect(current.props.disabled).toBe(false)
    expect(otherUnhealthy.props.disabled).toBe(true)
    expect(healthy.props.disabled).toBe(false)
  })

  it("shows a stored removed runtime as unavailable and allows switching without changing bot data first", () => {
    useMachinesMock.mockReturnValue(HEALTHY_MACHINES)
    const renderer = renderSheet({ ...BOT, runtime: "gemini", modelName: "legacy-model" })
    const removed = runtimeRadio(renderer, "gemini")
    const healthy = runtimeRadio(renderer, "codex")

    expect(removed.props.checked).toBe(true)
    expect(removed.props.disabled).toBe(false)
    expect(renderer.root.findAll((n) => n.type === "span" && n.props.children === "unavailable")).toHaveLength(1)
    expect(healthy.props.disabled).toBe(false)

    act(() => healthy.props.onChange())
    expect(runtimeRadio(renderer, "codex").props.checked).toBe(true)
    expect(updateMutateAsync).not.toHaveBeenCalled()
  })
})
