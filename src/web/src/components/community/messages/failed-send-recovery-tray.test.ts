import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  dismiss: vi.fn(async () => undefined),
  list: vi.fn(),
}))

vi.mock("@/lib/community/replica/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community/replica/store")>(),
  dismissCommunityReplicaIntent: mocks.dismiss,
  listCommunityReplicaIntents: mocks.list,
}))

import { FailedSendRecoveryTray } from "./failed-send-recovery-tray"

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("FailedSendRecoveryTray", () => {
  it("keeps a revoked send reachable with Copy and Dismiss after route retirement", async () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal("window", { addEventListener, removeEventListener })
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    mocks.list.mockResolvedValue([{
      intentId: "intent-revoked",
      intent: {
        intentId: "intent-revoked",
        kind: "message.send",
        scope: { kind: "channel", id: "channel-revoked" },
        createdAt: "2026-09-06T03:00:00.000+08:00",
        payload: { content: "please keep this text" },
      },
      state: "canonical-rejected",
      outcome: {
        intentId: "intent-revoked",
        status: "rejected",
        code: "permission-denied",
        reason: "Access revoked",
      },
    }])

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(FailedSendRecoveryTray, { accountId: "viewer" }),
      )
      await Promise.resolve()
    })

    expect(renderer.root.findByProps({ "aria-label": "Unsent messages" })).toBeTruthy()
    expect(renderer.root.findAllByType("p").some((node) => (
      node.children.includes("Message not sent")
    ))).toBe(true)
    const buttons = renderer.root.findAllByType("button")
    await act(async () => buttons.find((button) => button.children.includes("Copy text"))!.props.onClick())
    expect(writeText).toHaveBeenCalledWith("please keep this text")

    await act(async () => buttons.find((button) => button.props["aria-label"] === "Dismiss unsent message")!.props.onClick())
    expect(mocks.dismiss).toHaveBeenCalledWith("viewer", "intent-revoked")
    expect(renderer.root.findAllByProps({ "aria-label": "Unsent messages" })).toHaveLength(0)
  })
})
