import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ list: vi.fn(), connect: vi.fn(), push: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries, communityBot: { listBotsForOwner: mocks.list }, communityFriendship: { ensureSiblingBotFriendship: mocks.connect } } }
})
vi.mock("./bot-push", () => ({ pushBotEventToMachine: mocks.push }))
import { completeBotCreation } from "./bot-creation.server"

beforeEach(() => vi.clearAllMocks())
it("connects each new sibling pair once and still pushes every created bot after a friendship failure", async () => {
  mocks.list.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "existing" }])
  mocks.connect.mockRejectedValueOnce(new Error("temporary friendship failure")).mockResolvedValue({ blocked: false })
  const bots = ["a", "b"].map(id => ({ id, name: id, discriminator: "0001", description: "Role", machineId: "machine" }))
  await completeBotCreation({} as Env, {} as never, "owner", { name: "Owner", discriminator: "0002" }, bots)
  expect(mocks.list).toHaveBeenCalledWith({}, "owner")
  expect(mocks.connect.mock.calls.map(([, pair]) => pair)).toEqual([{ botA: "a", botB: "b" }, { botA: "a", botB: "existing" }, { botA: "b", botB: "existing" }])
  expect(mocks.push.mock.calls.map(([, machineId, event]) => [machineId, event.type, event.botId])).toEqual([["machine", "bot:added", "a"], ["machine", "bot:added", "b"]])
})
