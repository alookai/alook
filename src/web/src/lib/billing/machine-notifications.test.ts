import { beforeEach, describe, expect, it, vi } from "vitest"
import { queries } from "@alook/shared"
import { forceCloseCommunityMachinesByDoNames } from "@/lib/community/machine-disconnect"
import { broadcastToUser } from "@/lib/broadcast"
import { fanOutPresenceUpdate } from "@/lib/community/fanout"
import { notifyDisconnectedMachines } from "./reconcile"
vi.mock("@/lib/community/machine-disconnect", () => ({ forceCloseCommunityMachinesByDoNames: vi.fn(async () => {}) }))
vi.mock("@/lib/broadcast", () => ({ broadcastToUser: vi.fn(async () => {}) }))
vi.mock("@/lib/community/fanout", () => ({ fanOutPresenceUpdate: vi.fn(async () => {}) }))
vi.mock("@/lib/community/bot-push", () => ({ pushBotEventToMachine: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries,
    communityMachine: { ...actual.queries.communityMachine, getMachineByIdForUser: vi.fn() },
    communityBot: { ...actual.queries.communityBot, listBotsBoundToMachine: vi.fn() },
  } }
})
const machine = { machineId: "m", userId: "owner", doName: "old-do" }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(queries.communityMachine.getMachineByIdForUser).mockResolvedValue({ status: "offline", lastSeenAt: "then" } as never)
  vi.mocked(queries.communityBot.listBotsBoundToMachine).mockResolvedValue([{ id: "bot" }] as never)
})
describe("committed machine disconnection notifications", () => {
  it("closes captured epochs once and broadcasts owner-scoped machine and bot status", async () => {
    await notifyDisconnectedMachines({} as Env, {} as never, [machine, machine, { ...machine, doName: null }])
    expect(forceCloseCommunityMachinesByDoNames).toHaveBeenCalledWith({}, ["old-do"])
    expect(broadcastToUser).toHaveBeenCalledExactlyOnceWith("owner", { type: "community:machine.status", machineId: "m", status: "offline", lastSeenAt: "then" })
    expect(queries.communityBot.listBotsBoundToMachine).toHaveBeenCalledWith({}, "m", "owner")
    expect(fanOutPresenceUpdate).toHaveBeenCalledExactlyOnceWith("bot", false, "owner")
  })
  it("does not mark a manually reconnected machine or its bots offline", async () => {
    vi.mocked(queries.communityMachine.getMachineByIdForUser).mockResolvedValue({ status: "online" } as never)
    await notifyDisconnectedMachines({} as Env, {} as never, [machine])
    expect(forceCloseCommunityMachinesByDoNames).toHaveBeenCalledWith({}, ["old-do"])
    expect(broadcastToUser).not.toHaveBeenCalled()
    expect(fanOutPresenceUpdate).not.toHaveBeenCalled()
  })
  it("stops bot notifications if reconnect wins between broadcasts", async () => {
    vi.mocked(queries.communityMachine.getMachineByIdForUser).mockResolvedValueOnce({ status: "offline", lastSeenAt: null } as never).mockResolvedValueOnce({ status: "online" } as never)
    await notifyDisconnectedMachines({} as Env, {} as never, [machine])
    expect(broadcastToUser).toHaveBeenCalledWith("owner", expect.objectContaining({ lastSeenAt: expect.any(String) }))
    expect(fanOutPresenceUpdate).not.toHaveBeenCalled()
  })
  it("skips deleted rows and contains post-commit delivery failures", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(queries.communityMachine.getMachineByIdForUser).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("unavailable"))
    await notifyDisconnectedMachines({} as Env, {} as never, [machine, { machineId: "n", userId: "owner", doName: null }])
    expect(broadcastToUser).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith("billing_post_commit_machine_notification_failed", { machineId: "n" })
    warning.mockRestore()
  })
})
