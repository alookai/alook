import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries, communityMachine: { ...actual.queries.communityMachine, listMachinesForUser: mocks.list } } }
})
import { readPlatformMachines, projectModelOptions } from "./machine-options.server"

beforeEach(() => vi.clearAllMocks())
it("scopes the machine list to the owner and projects both online and offline targets", async () => {
  const db = {} as never
  mocks.list.mockResolvedValueOnce([{ id: "m1", displayName: "Work", status: "online", daemonVersion: "1.0", hostname: "private" }, { id: "m2", displayName: "Home", status: "offline", daemonVersion: "0.9" }])
  expect(await readPlatformMachines(db, "owner", "m1")).toEqual({ machines: [{ id: "m1", name: "Work", status: "online", daemonVersion: "1.0" }, { id: "m2", name: "Home", status: "offline", daemonVersion: "0.9" }], requesterMachineId: "m1" })
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith(db, "owner")
})
it("keeps reported model defaults, display names and effort values", () => {
  const option = projectModelOptions("m1", { id: "codex", reasoning: { updateMode: "live_next_turn", catalogOrigin: "native_report", defaultModelId: "model/a", models: [{ id: "model/a", displayName: "Model A", supportedReasoningEfforts: [{ value: "high" }], defaultReasoningEffort: "high" }, { id: "custom/b", supportedReasoningEfforts: [] }] } })
  expect(option).toEqual({ machineId: "m1", backendId: "codex", source: "stored_report", readAt: expect.any(String), observedAt: null, catalogOrigin: "native_report", catalogState: "reported", modelRequired: false, defaultModelId: "model/a", models: [{ id: "model/a", displayName: "Model A", reasoningEfforts: [{ value: "high" }], defaultReasoningEffort: "high" }, { id: "custom/b", reasoningEfforts: [], defaultReasoningEffort: null }] })
})
it("distinguishes an unreported catalog from a reported empty catalog", () => {
  expect(projectModelOptions("m1", { id: "opencode" })).toMatchObject({ modelRequired: true, catalogState: "not_reported", catalogOrigin: "unknown", defaultModelId: null, models: null })
  expect(projectModelOptions("m1", { id: "codex", reasoning: { updateMode: "live_next_turn", models: [] } })).toMatchObject({ catalogState: "reported", defaultModelId: null, models: [] })
})
