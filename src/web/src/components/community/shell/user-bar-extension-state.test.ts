import { describe, expect, it } from "vitest"
import {
  initialUserBarExtensionState,
  userBarExtensionReducer,
  userBarUpdateBadgePhase,
  type UserBarExtensionAction,
  type UserBarExtensionState,
} from "./user-bar-extension-state"

function reduce(
  actions: UserBarExtensionAction[],
  initial: UserBarExtensionState = initialUserBarExtensionState,
) {
  return actions.reduce(userBarExtensionReducer, initial)
}

describe("userBarExtensionReducer", () => {
  it("opens the first eligible update or restores its persisted badge", () => {
    expect(reduce([{
      type: "update.sync",
      collapsed: false,
      eligibleMachineIds: ["m1", "m2"],
    }])).toEqual({
      active: "update",
      update: {
        phase: "expanded",
        targetMachineIds: ["m1", "m2"],
        acceptedMachineIds: [],
        failedMachineIds: [],
        pendingMachineIds: [],
      },
    })
    expect(reduce([{
      type: "update.sync",
      collapsed: true,
      eligibleMachineIds: ["m1"],
    }])).toEqual({
      active: "none",
      update: {
        phase: "collapsedBadge",
        targetMachineIds: ["m1"],
        acceptedMachineIds: [],
        failedMachineIds: [],
        pendingMachineIds: [],
      },
    })
  })

  it.each(["inbox", "profile"] as const)(
    "lets %s take the slot and collapses an expanded update",
    (extension) => {
      const state = reduce([
        { type: "update.sync", collapsed: false, eligibleMachineIds: ["m1"] },
        { type: "extension.open", extension },
      ])
      expect(state.active).toBe(extension)
      expect(state.update?.phase).toBe("collapsedBadge")
      expect(userBarUpdateBadgePhase(state)).toBe("collapsedBadge")
    },
  )

  it("does not let a late availability sync steal the active Inbox slot", () => {
    const inbox = reduce([{ type: "extension.open", extension: "inbox" }])
    expect(userBarExtensionReducer(inbox, {
      type: "update.sync",
      collapsed: false,
      eligibleMachineIds: ["m1"],
    })).toMatchObject({
      active: "inbox",
      update: { phase: "collapsedBadge", targetMachineIds: ["m1"] },
    })
  })

  it("restores the update from its badge without losing truthful progress", () => {
    const updating = reduce([
      { type: "update.sync", collapsed: false, eligibleMachineIds: ["m1"] },
      { type: "update.dispatch", machineIds: ["m1"] },
      {
        type: "update.settle",
        acceptedMachineIds: ["m1"],
        failedMachineIds: [],
      },
      { type: "update.collapse" },
    ])
    expect(updating.active).toBe("none")
    expect(updating.update).toMatchObject({
      phase: "updating",
      acceptedMachineIds: ["m1"],
      failedMachineIds: [],
    })
    expect(userBarUpdateBadgePhase(updating)).toBe("updating")
    expect(userBarExtensionReducer(updating, { type: "update.open" })).toMatchObject({
      active: "update",
      update: { phase: "updating", acceptedMachineIds: ["m1"] },
    })
  })

  it("keeps accepted and failed outcomes separate for a failure-only retry", () => {
    const retry = reduce([
      {
        type: "update.sync",
        collapsed: false,
        eligibleMachineIds: ["accepted", "failed"],
      },
      { type: "update.dispatch", machineIds: ["accepted", "failed"] },
      {
        type: "update.settle",
        acceptedMachineIds: ["accepted"],
        failedMachineIds: ["failed"],
      },
    ])
    expect(retry).toMatchObject({
      active: "update",
      update: {
        phase: "retry",
        acceptedMachineIds: ["accepted"],
        failedMachineIds: ["failed"],
        pendingMachineIds: [],
      },
    })
    const retrying = userBarExtensionReducer(retry, {
      type: "update.dispatch",
      machineIds: ["failed"],
    })
    expect(retrying.update).toMatchObject({
      phase: "updating",
      acceptedMachineIds: ["accepted"],
      failedMachineIds: [],
      pendingMachineIds: ["failed"],
    })
  })

  it("does not reclaim the slot when a request settles after an Inbox takeover", () => {
    const inbox = reduce([
      { type: "update.sync", collapsed: false, eligibleMachineIds: ["m1"] },
      { type: "update.dispatch", machineIds: ["m1"] },
      { type: "extension.open", extension: "inbox" },
    ])

    expect(userBarExtensionReducer(inbox, {
      type: "update.settle",
      acceptedMachineIds: ["m1"],
      failedMachineIds: [],
    })).toMatchObject({
      active: "inbox",
      update: { phase: "updating", acceptedMachineIds: ["m1"] },
    })
  })

  it("prunes completed Machines and clears only when no target remains eligible", () => {
    const retry = reduce([
      {
        type: "update.sync",
        collapsed: false,
        eligibleMachineIds: ["accepted", "failed"],
      },
      { type: "update.dispatch", machineIds: ["accepted", "failed"] },
      {
        type: "update.settle",
        acceptedMachineIds: ["accepted"],
        failedMachineIds: ["failed"],
      },
    ])
    const failedOnly = userBarExtensionReducer(retry, {
      type: "update.eligibility",
      eligibleMachineIds: ["failed"],
    })
    expect(failedOnly.update).toMatchObject({
      phase: "retry",
      targetMachineIds: ["failed"],
      acceptedMachineIds: [],
      failedMachineIds: ["failed"],
    })
    expect(userBarExtensionReducer(failedOnly, {
      type: "update.eligibility",
      eligibleMachineIds: [],
    })).toEqual(initialUserBarExtensionState)
  })

  it("adds newly eligible Machines without losing accepted outcomes", () => {
    const state = reduce([
      { type: "update.sync", collapsed: false, eligibleMachineIds: ["a"] },
      { type: "update.dispatch", machineIds: ["a"] },
      { type: "update.settle", acceptedMachineIds: ["a"], failedMachineIds: [] },
      { type: "update.eligibility", eligibleMachineIds: ["a", "b"] },
    ])

    expect(state.update).toMatchObject({
      phase: "updating",
      targetMachineIds: ["a", "b"],
      acceptedMachineIds: ["a"],
    })
  })

  it("clears the active update when eligibility ends", () => {
    const active = reduce([{
      type: "update.sync",
      collapsed: false,
      eligibleMachineIds: ["m1"],
    }])
    expect(userBarExtensionReducer(active, { type: "update.clear" })).toEqual(
      initialUserBarExtensionState,
    )
  })

  it("ignores stale close events and duplicate eligibility syncs", () => {
    const profile = reduce([
      { type: "update.sync", collapsed: false, eligibleMachineIds: ["m1"] },
      { type: "extension.open", extension: "profile" },
    ])
    expect(userBarExtensionReducer(profile, {
      type: "extension.close",
      extension: "inbox",
    })).toBe(profile)
    expect(userBarExtensionReducer(profile, {
      type: "update.sync",
      collapsed: false,
      eligibleMachineIds: ["m1"],
    })).toBe(profile)
  })

  it("ignores update-only actions before update state exists", () => {
    expect(userBarExtensionReducer(initialUserBarExtensionState, {
      type: "update.open",
    })).toBe(initialUserBarExtensionState)
    expect(userBarExtensionReducer(initialUserBarExtensionState, {
      type: "update.settle",
      acceptedMachineIds: ["stale"],
      failedMachineIds: [],
    })).toBe(initialUserBarExtensionState)
    expect(userBarExtensionReducer(initialUserBarExtensionState, {
      type: "update.collapse",
    })).toBe(initialUserBarExtensionState)
  })

  it("closes the requested non-update extension without update state", () => {
    expect(userBarExtensionReducer({ active: "inbox", update: null }, {
      type: "extension.close",
      extension: "inbox",
    })).toEqual(initialUserBarExtensionState)
  })
})
