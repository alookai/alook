import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ connect: vi.fn(), push: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries, communityFriendship: { ensureNewSiblingBotFriendships: mocks.connect } } }
})
vi.mock("./bot-push", () => ({ pushBotEventToMachine: mocks.push }))
import { completeBotCreation, botCreationFailure } from "./bot-creation.server"

beforeEach(() => vi.clearAllMocks())
it("connects new siblings in one batch and still pushes every created bot after a friendship failure", async () => {
  mocks.connect.mockRejectedValueOnce(new Error("temporary friendship failure"))
  const bots = ["a", "b"].map(id => ({ id, name: id, discriminator: "0001", description: "Role", machineId: "machine" }))
  await completeBotCreation({} as Env, {} as never, "owner", { name: "Owner", discriminator: "0002" }, bots)
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({}, "owner", ["a", "b"])
  expect(mocks.push.mock.calls.map(([, machineId, event]) => [machineId, event.type, event.botId])).toEqual([["machine", "bot:added", "a"], ["machine", "bot:added", "b"]])
})

it("preserves unexpected errors for the route error handler", () => {
  const error = new Error("unexpected creation failure")
  expect(() => botCreationFailure(error, { requestId: "request" })).toThrow(error)
})
