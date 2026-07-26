import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import type { BotSummary } from "@/hooks/community/use-bots"

// Drive the edit sheet's submit() and assert the toast copy branches on the
// PATCH response (applied / deliveryError / plain-offline). The Sheet portals,
// so mock the shell + heavy children to passthroughs and stub the mutation.

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock("sonner", () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) } }))
vi.mock("@/lib/api/client", () => ({ toastApiError: vi.fn() }))

const updateMutateAsync = vi.fn()
vi.mock("@/hooks/community/use-bots", () => ({
  useUpdateBot: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
  useUploadBotAvatar: () => ({ mutateAsync: vi.fn() }),
}))

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
  return { Button: ({ children, onClick }: any) => React.createElement("button", { onClick }, children) }
})
vi.mock("./bot-form-fields", () => ({ BotFormFields: () => require("react").createElement("div") }))
vi.mock("./model-field", () => {
  const React = require("react")
  // Expose the onChange so the test can set a new model, revealing modelChanged.
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
}

function renderAndSwitchModel(response: unknown): { save: () => void } {
  updateMutateAsync.mockResolvedValue(response)
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(EditBotSheet, { bot: BOT, open: true, onOpenChange: vi.fn() }),
    )
  })
  // Change the model via the mocked ModelField.
  const setModel = renderer.root.find((n) => n.props?.["data-testid"] === "set-model")
  act(() => setModel.props.onClick())
  // Find the Save button (last button rendered in the footer).
  const buttons = renderer.root.findAll((n) => n.type === "button" && !n.props["data-testid"])
  const save = buttons.at(-1)!
  return { save: () => act(() => { void save.props.onClick() }) }
}

describe("EditBotSheet — model switch toast copy", () => {
  beforeEach(() => {
    toastSuccess.mockReset()
    toastError.mockReset()
    updateMutateAsync.mockReset()
  })

  it("applied:true → 'Model switched to <new>'", async () => {
    const { save } = renderAndSwitchModel({ bot: { ...BOT, modelName: "claude-sonnet-4-6" }, applied: true, deliveryError: false })
    save()
    await Promise.resolve(); await Promise.resolve()
    expect(toastSuccess).toHaveBeenCalledWith("Model switched to claude-sonnet-4-6")
  })

  it("deliveryError:true → couldn't-reach copy", async () => {
    const { save } = renderAndSwitchModel({ bot: { ...BOT, modelName: "claude-sonnet-4-6" }, applied: false, deliveryError: true })
    save()
    await Promise.resolve(); await Promise.resolve()
    expect(toastSuccess).toHaveBeenCalledWith("Model saved — couldn't reach the bot just now; it'll apply on the next wake")
  })

  it("plain offline (applied:false, deliveryError:false) → applies-when-online copy", async () => {
    const { save } = renderAndSwitchModel({ bot: { ...BOT, modelName: "claude-sonnet-4-6" }, applied: false, deliveryError: false })
    save()
    await Promise.resolve(); await Promise.resolve()
    expect(toastSuccess).toHaveBeenCalledWith("Model saved — applies when the bot comes online")
  })
})
