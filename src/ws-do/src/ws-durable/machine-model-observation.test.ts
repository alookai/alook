import { beforeEach, describe, expect, it, vi } from "vitest"
import { handleModelObservationFrame } from "./machine-model-observation"
import type { WsDurableContext } from "./internal"

const mocks = vi.hoisted(() => ({ owned: vi.fn(), record: vi.fn(), warn: vi.fn() }))
vi.mock("@alook/shared", async (original) => ({
  ...await original<typeof import("@alook/shared")>(), createDb: () => ({}),
  withD1Retry: (run: () => Promise<void>) => run(),
  queries: { communityBot: { getBotOwnedBy: mocks.owned, recordBotModelObservation: mocks.record } },
}))

const frame = { type: "agent_model", agentId: "bot", backendId: "codex", sessionInstanceId: "epoch", model: "served", source: "response", observedAt: "2026-11-17T02:00:00.000Z" }
const identity = { userId: "owner", machineId: "machine", credentialHash: "hash" }
const context = { env: { DB: {} }, log: { warn: mocks.warn } } as unknown as WsDurableContext

beforeEach(() => {
  mocks.owned.mockReset().mockResolvedValue({ machineId: "machine", runtime: "codex", ownerUserId: "owner", isActive: true })
  mocks.record.mockReset().mockResolvedValue(undefined)
  mocks.warn.mockReset()
})

describe("authenticated model observation ingestion", () => {
  it("scopes the read to the authenticated owner and keeps the write on the existing bound-bot path", async () => {
    expect(await handleModelObservationFrame(context, frame, identity)).toBe(true)
    expect(mocks.owned).toHaveBeenCalledWith({}, "bot", "owner")
    const { type: _, ...report } = frame
    expect(mocks.record).toHaveBeenCalledExactlyOnceWith({}, "owner", "machine", report)
  })

  it.each([{ machineId: "other" }, { ownerUserId: "other" }, { runtime: "claude" }, { isActive: false }])("consumes but cannot write a mismatched binding: %j", async mismatch => {
    mocks.owned.mockResolvedValue({ machineId: "machine", runtime: "codex", ownerUserId: "owner", isActive: true, ...mismatch })
    expect(await handleModelObservationFrame(context, frame, identity)).toBe(true)
    expect(mocks.record).not.toHaveBeenCalled()
  })

  it("rejects malformed/future data and isolates write errors", async () => {
    expect(await handleModelObservationFrame(context, { ...frame, model: "bad\nmodel" }, identity)).toBe(false)
    expect(await handleModelObservationFrame(context, { ...frame, observedAt: "2099-01-01T00:00:00.000Z" }, identity)).toBe(true)
    expect(mocks.record).not.toHaveBeenCalled()
    mocks.record.mockRejectedValue(new Error("database unavailable"))
    await expect(handleModelObservationFrame(context, frame, identity)).resolves.toBe(true)
    expect(mocks.warn).toHaveBeenCalledWith("ws_frame_dropped", expect.objectContaining({ frame_type: "agent_model", phase: "write" }))
  })
})
