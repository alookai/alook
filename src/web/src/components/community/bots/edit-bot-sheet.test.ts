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
      availableRuntimes: [
        { id: "claude", status: "healthy" },
        { id: "codex", status: "healthy" },
      ],
    },
  ],
}

vi.mock("@/components/ui/sheet", () => {
  const React = require("react")
  const pass = (name: string) =>
    function P({ children }: { children?: React.ReactNode }) {
      return React.createElement("div", { "data-mock": name }, children)
    }
  return {
    Sheet: pass("sheet"),
    SheetBody: pass("body"),
    SheetContent: pass("content"),
    SheetDescription: pass("desc"),
    SheetFooter: pass("footer"),
    SheetHeader: pass("header"),
    SheetTitle: pass("title"),
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
  BotFormFields: () => require("react").createElement("div"),
}))
vi.mock("./model-field", () => {
  const React = require("react")
  return {
    ModelField: ({ onChange }: { onChange: (v: string | null) => void }) =>
      React.createElement("button", {
        "data-testid": "set-model",
        onClick: () => onChange("claude-sonnet-4-6"),
      }),
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
