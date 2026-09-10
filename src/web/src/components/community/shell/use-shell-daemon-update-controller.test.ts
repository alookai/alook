import { describe, expect, it, vi } from "vitest"
import {
  daemonUpdateCollapseStorageKey,
  daemonUpdateRequestMachineIds,
  dispatchMachineUpdateRequests,
} from "./use-shell-daemon-update-controller"
import type { UserBarUpdateState } from "./user-bar-extension-state"

function update(
  values: Partial<UserBarUpdateState> = {},
): UserBarUpdateState {
  return {
    phase: "expanded",
    targetMachineIds: ["accepted", "failed", "pending"],
    acceptedMachineIds: [],
    failedMachineIds: [],
    pendingMachineIds: [],
    ...values,
  }
}

describe("Community daemon update controller helpers", () => {
  it("scopes the collapsed preference by viewer and target daemon version", () => {
    expect(daemonUpdateCollapseStorageKey("user-1", "0.1.35")).toBe(
      "alook:daemon-update-collapsed:user-1:0.1.35",
    )
  })

  it("dispatches every initial target except accepted or pending Machines", () => {
    expect(daemonUpdateRequestMachineIds(update({
      acceptedMachineIds: ["accepted"],
      pendingMachineIds: ["pending"],
    }), ["accepted", "failed", "pending"])).toEqual(["failed"])
  })

  it("retries only failed Machines that remain eligible", () => {
    expect(daemonUpdateRequestMachineIds(update({
      phase: "retry",
      acceptedMachineIds: ["accepted"],
      failedMachineIds: ["failed", "completed"],
    }), ["accepted", "failed"])).toEqual(["failed"])
  })

  it("preserves accepted and failed request outcomes without short-circuiting", async () => {
    const requestUpdate = vi.fn(async (machineId: string) => {
      if (machineId === "failed") throw new Error("offline race")
    })
    await expect(dispatchMachineUpdateRequests(
      ["accepted", "failed", "accepted-2"],
      requestUpdate,
    )).resolves.toEqual({
      acceptedMachineIds: ["accepted", "accepted-2"],
      failedMachineIds: ["failed"],
    })
    expect(requestUpdate.mock.calls).toEqual([
      ["accepted"],
      ["failed"],
      ["accepted-2"],
    ])
  })
})
