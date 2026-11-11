import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries, communityMachine: { ...actual.queries.communityMachine, listMachinesForUser: mocks.list } } }
})
import { readPlatformMachines, projectModelOptions, projectMachineBackends } from "./machine-options.server"

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
it.each([["qoder", false], ["copilot", false], ["cursor-sdk", true], ["pi-durable", true]] as const)("projects %s model options without losing effort or required-model semantics", (backendId, modelRequired) => {
  expect(projectModelOptions("m1", { id: backendId, reasoning: { updateMode: "unsupported", models: [{ id: "provider/model", supportedReasoningEfforts: [{ value: "high" }] }] } })).toMatchObject({
    backendId, modelRequired, models: [{ id: "provider/model", reasoningEfforts: [{ value: "high" }] }],
  })
})

it("keeps App and CLI versions and model catalogs separate without offering the legacy alias", () => {
  const app = { id: "codex-app", status: "healthy" as const, version: "0.1", reasoning: { updateMode: "live_next_turn" as const, defaultModelId: "app-model", models: [{ id: "app-model", supportedReasoningEfforts: [] }] } }
  const cli = { id: "codex-cli", status: "healthy" as const, version: "0.2", reasoning: { updateMode: "live_next_turn" as const, models: [{ id: "cli-model", supportedReasoningEfforts: [] }] } }
  expect(projectMachineBackends([{ id: "codex", status: "healthy" }, app, cli]).map(({ id, version }) => ({ id, version }))).toEqual([{ id: "codex-app", version: "0.1" }, { id: "codex-cli", version: "0.2" }])
  expect(projectModelOptions("m1", app)).toMatchObject({ backendId: "codex-app", defaultModelId: "app-model", models: [{ id: "app-model" }] })
  expect(projectModelOptions("m1", cli)).toMatchObject({ backendId: "codex-cli", models: [{ id: "cli-model" }] })
})
