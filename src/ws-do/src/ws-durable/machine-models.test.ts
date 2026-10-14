import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMockWebSocket } from "../__mocks__/cf"
import { cleanupHarness, createDO, mockUpsertMachineByMachineId, mockTouchMachineHeartbeat, mockStubFetch, mockGetMachineByIdForUser, resetHarness } from "./test-harness"
const identity = { userId: "owner", machineId: "machine", credentialHash: "a".repeat(64) }
const catalog = { updateMode: "unsupported", models: [{ id: "native-model", supportedReasoningEfforts: [] }] }
const frame = { type: "runtime_models", runtimeId: "codex", requestId: "request", result: { status: "complete", runtimeReport: [{ id: "codex", status: "healthy", reasoning: catalog }] } }
function setup() {
  const state = createDO()
  state.store.set("community-machine-identity", identity)
  const socket = createMockWebSocket()
  socket.serializeAttachment({ type: "community-machine", authenticated: true, ...identity })
  return { ...state, socket }
}
describe("model discovery frames", () => {
  beforeEach(() => {
    resetHarness()
    mockUpsertMachineByMachineId.mockResolvedValue({ machine: { id: "machine" } })
    mockTouchMachineHeartbeat.mockResolvedValue({ machine: { id: "machine" } })
    mockGetMachineByIdForUser.mockResolvedValue(null)
    mockStubFetch.mockClear()
  })
  afterEach(() => cleanupHarness())
  it("persists under the credential epoch before notifying only the owner", async () => {
    const { durable, socket, env } = setup()
    await durable.webSocketMessage(socket as any, JSON.stringify(frame))
    expect(mockUpsertMachineByMachineId).toHaveBeenCalledWith(expect.anything(), "owner", "machine", { availableRuntimes: frame.result.runtimeReport }, identity.credentialHash)
    expect(mockUpsertMachineByMachineId.mock.invocationCallOrder[0]).toBeLessThan(mockStubFetch.mock.invocationCallOrder[0])
    expect(env.WS_DO.idFromName).toHaveBeenCalledWith("user:owner")
    expect(mockGetMachineByIdForUser).not.toHaveBeenCalled()
    expect(mockStubFetch).toHaveBeenCalledTimes(1)
    const request = mockStubFetch.mock.calls[0][0] as Request
    expect(await request.json()).toMatchObject({ type: "community:runtime.models", machineId: "machine", runtimeId: "codex", requestId: "request", result: { status: "complete", catalog } })
  })
  it("drops results from revoked epochs", async () => {
    mockUpsertMachineByMachineId.mockResolvedValue(null)
    const { durable, socket } = setup()
    await durable.webSocketMessage(socket as any, JSON.stringify(frame))
    expect(mockStubFetch).not.toHaveBeenCalled()
  })
  it("reports persistence failure without claiming a discovered catalog", async () => {
    mockUpsertMachineByMachineId.mockRejectedValue(new Error("private db error"))
    const { durable, socket } = setup()
    await durable.webSocketMessage(socket as any, JSON.stringify(frame))
    expect(await (mockStubFetch.mock.calls[0][0] as Request).json()).toMatchObject({ result: { status: "error", code: "model_discovery_failed" } })
  })
  it("fences an error response without replacing runtime catalogs", async () => {
    const { durable, socket } = setup()
    await durable.webSocketMessage(socket as any, JSON.stringify({ ...frame, result: { status: "error", code: "auth_required", message: "Sign in" } }))
    expect(mockTouchMachineHeartbeat).toHaveBeenCalledWith(expect.anything(), "owner", "machine", identity.credentialHash)
    expect(mockUpsertMachineByMachineId).not.toHaveBeenCalled()
    expect(await (mockStubFetch.mock.calls[0][0] as Request).json()).toMatchObject({ result: { status: "error", code: "auth_required" } })
  })
  it("drops malformed or mismatched-runtime results", async () => {
    const { durable, socket } = setup()
    await durable.webSocketMessage(socket as any, JSON.stringify({ ...frame, runtimeId: "missing" }))
    await durable.webSocketMessage(socket as any, JSON.stringify({ ...frame, requestId: "" }))
    expect(mockUpsertMachineByMachineId).not.toHaveBeenCalled()
    expect(mockStubFetch).not.toHaveBeenCalled()
  })
})
