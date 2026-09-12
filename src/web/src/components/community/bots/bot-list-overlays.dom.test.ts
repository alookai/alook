import React from "react"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BotListController } from "./bot-list-types"
import { fireEvent, render } from "@/test/react-dom-harness"

const webRoot = process.cwd().endsWith("/src/web")
  ? process.cwd()
  : resolve(process.cwd(), "src/web")
const readWebSource = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

function host(name: string) {
  const Host = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement(name, props, children)
  Host.displayName = `Host(${name})`
  return Host
}

vi.mock("@/components/community/onboarding-tiles/agent-help-gallery", () => ({
  AgentHelpGallery: host("help"),
}))
vi.mock("@/components/community/billing/billing-sheet", () => ({ BillingSheet: host("billing") }))
vi.mock("./bot-activity-modal", () => ({ BotActivityModal: host("activity") }))
vi.mock("./bug-report-dialog", () => ({ BugReportDialog: host("bug") }))
vi.mock("./create-bot-sheet", () => ({ CreateBotSheet: host("create") }))
vi.mock("./edit-bot-sheet", () => ({ EditBotSheet: host("edit") }))
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open, onOpenChange }: React.PropsWithChildren<{
    open: boolean
    onOpenChange: (open: boolean) => void
  }>) => React.createElement("div", {
    "data-host": "alert",
    "data-open": String(open),
  },
  React.createElement("button", {
    "data-alert-open": "true",
    onClick: () => onOpenChange(true),
  }),
  React.createElement("button", {
    "data-alert-open": "false",
    onClick: () => onOpenChange(false),
  }), children),
  AlertDialogAction: ({ children, ...props }: React.ComponentProps<"button">) =>
    React.createElement("button", { ...props, "data-host": "alert-action" }, children),
  AlertDialogCancel: host("alert-cancel"),
  AlertDialogContent: host("alert-content"),
  AlertDialogDescription: host("alert-description"),
  AlertDialogFooter: host("alert-footer"),
  AlertDialogHeader: host("alert-header"),
  AlertDialogTitle: host("alert-title"),
}))

import { renderBotListOverlaySlots } from "./bot-list-overlays"

function controller(overrides: Partial<BotListController> = {}): BotListController {
  const noop = vi.fn()
  return {
    createOpen: false,
    setCreateOpen: noop,
    onBotCreated: noop,
    guidedActive: false,
    guidedAvatarSeed: undefined,
    helpOpen: false,
    setHelpOpen: noop,
    editingBot: null,
    editOpen: false,
    setEditOpen: noop,
    activityBot: null,
    activityOpen: false,
    activityGeneration: 0,
    onActivityOpenChange: noop,
    onActivityOpenChangeComplete: noop,
    openActivity: noop,
    bugReportBot: null,
    bugReportOpen: false,
    setBugReportOpen: noop,
    confirmDelete: null,
    setConfirmDelete: noop,
    confirmReset: null,
    setConfirmReset: noop,
    confirmResetMachine: null,
    setConfirmResetMachine: noop,
    machineName: () => "My Mac",
    deleteConfirmedBot: noop,
    resetConfirmedBot: noop,
    resetConfirmedMachine: noop,
    ...overrides,
  } as BotListController
}

describe("renderBotListOverlaySlots", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns all named elements without an aggregate reconciliation boundary", () => {
    const emptySlots = renderBotListOverlaySlots(controller())
    expect(emptySlots.bug).toBeNull()
    const slots = renderBotListOverlaySlots(controller({
      bugReportBot: { id: "b1", name: "Blake" },
    }))
    expect(Object.keys(slots)).toEqual([
      "billing",
      "create",
      "help",
      "edit",
      "activity",
      "bug",
      "deleteDialog",
      "resetDialog",
      "resetMachineDialog",
    ])
    for (const slot of Object.values(slots)) {
      expect(React.isValidElement(slot)).toBe(true)
      expect(Array.isArray(slot)).toBe(false)
      if (React.isValidElement(slot)) expect(slot.type).not.toBe(React.Fragment)
    }
    expect(Object.values(slots).slice(0, 6).map((slot) =>
      (slot!.type as React.ComponentType).displayName)).toEqual([
      "Host(billing)",
      "Host(create)",
      "Host(help)",
      "Host(edit)",
      "Host(activity)",
      "Host(bug)",
    ])
    expect(slots.deleteDialog.type).toBe(slots.resetDialog.type)
    expect(slots.resetDialog.type).toBe(slots.resetMachineDialog.type)
    const source = readWebSource("src/components/community/bots/bot-list-overlays.tsx")
    expect(source).not.toMatch(/<>|<React\.Fragment|return\s*\[/)
  })

  it("keeps selected child props and the conditional keyed bug slot", () => {
    const bot = { id: "b1", name: "Blake" }
    const setEditOpen = vi.fn()
    const onActivityOpenChange = vi.fn()
    const onActivityOpenChangeComplete = vi.fn()
    const setBugReportOpen = vi.fn()
    const state = controller({
      createOpen: true,
      guidedActive: true,
      guidedAvatarSeed: "seed",
      helpOpen: true,
      editingBot: bot as BotListController["editingBot"],
      editOpen: true,
      setEditOpen,
      activityBot: bot as BotListController["activityBot"],
      activityOpen: true,
      activityGeneration: 7,
      onActivityOpenChange,
      onActivityOpenChangeComplete,
      bugReportBot: bot,
      bugReportOpen: true,
      setBugReportOpen,
    })
    const slots = renderBotListOverlaySlots(state)
    expect(slots.create.props).toEqual({
      open: true,
      onOpenChange: state.setCreateOpen,
      onCreated: state.onBotCreated,
      guided: true,
      avatarSeed: "seed",
    })
    expect(slots.edit.props).toEqual({ bot, open: true, onOpenChange: setEditOpen })
    expect(slots.activity.key).toBe("7")
    expect(slots.activity.props).toMatchObject({
      bot,
      open: true,
      onOpenChange: onActivityOpenChange,
    })
    expect(slots.activity.props.onOpenChangeComplete).toEqual(expect.any(Function))
    expect(slots.help.props).toEqual({
      open: true,
      onOpenChange: state.setHelpOpen,
    })
    expect(slots.bug?.key).toBe("b1")
    expect(slots.bug?.props).toEqual({ bot, open: true, onOpenChange: setBugReportOpen })

    slots.edit.props.onOpenChange(false)
    slots.activity.props.onOpenChange(false)
    slots.activity.props.onOpenChangeComplete(false)
    slots.activity.props.onOpenChangeComplete(true)
    slots.bug?.props.onOpenChange(false)
    expect(setEditOpen).toHaveBeenCalledWith(false)
    expect(onActivityOpenChange).toHaveBeenCalledWith(false)
    expect(onActivityOpenChangeComplete).toHaveBeenNthCalledWith(1, false, 7)
    expect(onActivityOpenChangeComplete).toHaveBeenNthCalledWith(2, true, 7)
    expect(setBugReportOpen).toHaveBeenCalledWith(false)
    expect(state.editingBot).toBe(bot)
    expect(state.activityBot).toBe(bot)
    expect(state.bugReportBot).toBe(bot)
  })

  it("wires dialog close clearing and exact confirmed actions", () => {
    const setConfirmDelete = vi.fn()
    const setConfirmReset = vi.fn()
    const setConfirmResetMachine = vi.fn()
    const deleteConfirmedBot = vi.fn()
    const resetConfirmedBot = vi.fn()
    const resetConfirmedMachine = vi.fn()
    const state = controller({
      confirmDelete: { id: "b1", name: "Blake" } as BotListController["confirmDelete"],
      setConfirmDelete,
      confirmReset: { id: "b1", name: "Blake" } as BotListController["confirmReset"],
      setConfirmReset,
      confirmResetMachine: "mac1",
      setConfirmResetMachine,
      deleteConfirmedBot,
      resetConfirmedBot,
      resetConfirmedMachine,
    })
    const slots = renderBotListOverlaySlots(state)
    const renders = [slots.deleteDialog, slots.resetDialog, slots.resetMachineDialog].map((slot) => {
      return render(slot)
    })
    expect(renders.map((renderer) => (
      renderer.container.querySelector('[data-host="alert"]')?.getAttribute("data-open") === "true"
    )))
      .toEqual([true, true, true])
    for (const renderer of renders) {
      fireEvent.click(renderer.container.querySelector('[data-alert-open="true"]')!)
    }
    expect(setConfirmDelete).not.toHaveBeenCalled()
    expect(setConfirmReset).not.toHaveBeenCalled()
    expect(setConfirmResetMachine).not.toHaveBeenCalled()
    for (const renderer of renders) {
      fireEvent.click(renderer.container.querySelector('[data-alert-open="false"]')!)
    }
    expect(setConfirmDelete).toHaveBeenCalledWith(null)
    expect(setConfirmReset).toHaveBeenCalledWith(null)
    expect(setConfirmResetMachine).toHaveBeenCalledWith(null)

    fireEvent.click(renders[0]!.container.querySelector('[data-host="alert-action"]')!)
    fireEvent.click(renders[1]!.getByTestId("bot-reset-confirm"))
    fireEvent.click(renders[2]!.getByTestId("machine-reset-all-confirm"))
    expect(deleteConfirmedBot).toHaveBeenCalledOnce()
    expect(resetConfirmedBot).toHaveBeenCalledOnce()
    expect(resetConfirmedMachine).toHaveBeenCalledOnce()

    expect(renders[0]!.container.querySelector("alert-description")?.textContent)
      .toBe("The bot will leave every server it's in and its runner key will be revoked. Past messages remain in history with the bot's current name and avatar.")
    expect(renders[0]!.container.querySelector("alert-title")?.textContent)
      .toBe("Delete Blake?")
    expect(renders[0]!.container.querySelector('[data-host="alert-action"]')?.className)
      .toBe("bg-destructive text-destructive-foreground hover:bg-destructive/90")
    expect(renders[1]!.container.querySelector("alert-description")?.textContent)
      .toBe("Its running process will stop and it'll start a fresh session that picks up unfinished work from its notes.")
    expect(renders[1]!.container.querySelector("alert-title")?.textContent)
      .toBe("Reset this bot's session?")
    expect(renders[2]!.container.querySelector("alert-description")?.textContent)
      .toBe("Every agent on this machine will start a fresh session. Any that aren't currently running will be woken too.")
  })

  it("keeps reset-machine title fallback and selected machine name", () => {
    const without = renderBotListOverlaySlots(controller())
    const withMachine = renderBotListOverlaySlots(controller({ confirmResetMachine: "mac1" }))
    const first = render(without.resetMachineDialog)
    const second = render(withMachine.resetMachineDialog)
    const title = (renderer: typeof first) =>
      renderer.container.querySelector("alert-title")?.textContent
    expect(title(first)).toBe("Reset all agents on this machine?")
    expect(title(second)).toBe("Reset all agents on My Mac?")
  })
})
