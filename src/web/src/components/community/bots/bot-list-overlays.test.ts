import React from "react"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BotListController } from "./bot-list-types"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
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
vi.mock("./bot-activity-modal", () => ({ BotActivityModal: host("activity") }))
vi.mock("./bug-report-dialog", () => ({ BugReportDialog: host("bug") }))
vi.mock("./create-bot-sheet", () => ({ CreateBotSheet: host("create") }))
vi.mock("./edit-bot-sheet", () => ({ EditBotSheet: host("edit") }))
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: host("alert"),
  AlertDialogAction: host("alert-action"),
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
    setActivityOpen: noop,
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

  it("returns exactly eight named elements without an aggregate reconciliation boundary", () => {
    const emptySlots = renderBotListOverlaySlots(controller())
    expect(emptySlots.bug).toBeNull()
    const slots = renderBotListOverlaySlots(controller({
      bugReportBot: { id: "b1", name: "Blake" },
    }))
    expect(Object.keys(slots)).toEqual([
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
    expect(Object.values(slots).map((slot) =>
      (slot!.type as React.ComponentType).displayName)).toEqual([
      "Host(create)",
      "Host(help)",
      "Host(edit)",
      "Host(activity)",
      "Host(bug)",
      "Host(alert)",
      "Host(alert)",
      "Host(alert)",
    ])
    const source = readWebSource("src/components/community/bots/bot-list-overlays.tsx")
    expect(source).not.toMatch(/<>|<React\.Fragment|return\s*\[/)
  })

  it("keeps selected child props and the conditional keyed bug slot", () => {
    const bot = { id: "b1", name: "Blake" }
    const setEditOpen = vi.fn()
    const setActivityOpen = vi.fn()
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
      setActivityOpen,
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
    expect(slots.activity.props).toEqual({ bot, open: true, onOpenChange: setActivityOpen })
    expect(slots.help.props).toEqual({
      open: true,
      onOpenChange: state.setHelpOpen,
    })
    expect(slots.bug?.key).toBe("b1")
    expect(slots.bug?.props).toEqual({ bot, open: true, onOpenChange: setBugReportOpen })

    act(() => slots.edit.props.onOpenChange(false))
    act(() => slots.activity.props.onOpenChange(false))
    act(() => slots.bug?.props.onOpenChange(false))
    expect(setEditOpen).toHaveBeenCalledWith(false)
    expect(setActivityOpen).toHaveBeenCalledWith(false)
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
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => { renderer = TestRenderer.create(slot) })
      return renderer
    })
    expect(renders.map((renderer) => renderer.root.findByType("alert").props.open))
      .toEqual([true, true, true])
    act(() => renders[0]!.root.findByType("alert").props.onOpenChange(true))
    act(() => renders[1]!.root.findByType("alert").props.onOpenChange(true))
    act(() => renders[2]!.root.findByType("alert").props.onOpenChange(true))
    expect(setConfirmDelete).not.toHaveBeenCalled()
    expect(setConfirmReset).not.toHaveBeenCalled()
    expect(setConfirmResetMachine).not.toHaveBeenCalled()
    act(() => renders[0]!.root.findByType("alert").props.onOpenChange(false))
    act(() => renders[1]!.root.findByType("alert").props.onOpenChange(false))
    act(() => renders[2]!.root.findByType("alert").props.onOpenChange(false))
    expect(setConfirmDelete).toHaveBeenCalledWith(null)
    expect(setConfirmReset).toHaveBeenCalledWith(null)
    expect(setConfirmResetMachine).toHaveBeenCalledWith(null)

    act(() => renders[0]!.root.findByType("alert-action").props.onClick())
    act(() => renders[1]!.root.findByProps({ "data-testid": "bot-reset-confirm" }).props.onClick())
    act(() => renders[2]!.root.findByProps({ "data-testid": "machine-reset-all-confirm" }).props.onClick())
    expect(deleteConfirmedBot).toHaveBeenCalledOnce()
    expect(resetConfirmedBot).toHaveBeenCalledOnce()
    expect(resetConfirmedMachine).toHaveBeenCalledOnce()

    expect(renders[0]!.root.findByType("alert-description").children.join(""))
      .toBe("The bot will leave every server it's in and its runner key will be revoked. Past messages remain in history with the bot's current name and avatar.")
    expect(renders[0]!.root.findByType("alert-title").children.join(""))
      .toBe("Delete Blake?")
    expect(renders[0]!.root.findByType("alert-action").props.className)
      .toBe("bg-destructive text-destructive-foreground hover:bg-destructive/90")
    expect(renders[1]!.root.findByType("alert-description").children.join(""))
      .toBe("Its running process will stop and it'll start a fresh session that picks up unfinished work from its notes.")
    expect(renders[1]!.root.findByType("alert-title").children.join(""))
      .toBe("Reset this bot's session?")
    expect(renders[2]!.root.findByType("alert-description").children.join(""))
      .toBe("Every agent on this machine will start a fresh session. Any that aren't currently running will be woken too.")
  })

  it("keeps reset-machine title fallback and selected machine name", () => {
    const without = renderBotListOverlaySlots(controller())
    const withMachine = renderBotListOverlaySlots(controller({ confirmResetMachine: "mac1" }))
    let first!: TestRenderer.ReactTestRenderer
    let second!: TestRenderer.ReactTestRenderer
    act(() => {
      first = TestRenderer.create(without.resetMachineDialog)
      second = TestRenderer.create(withMachine.resetMachineDialog)
    })
    const title = (renderer: TestRenderer.ReactTestRenderer) =>
      renderer.root.findByType("alert-title").children.join("")
    expect(title(first)).toBe("Reset all agents on this machine?")
    expect(title(second)).toBe("Reset all agents on My Mac?")
  })
})
