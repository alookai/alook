import { expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ machines: vi.fn(), bots: vi.fn() }))
vi.mock("@alook/shared", async (original) => {
  const actual = await original<typeof import("@alook/shared")>()
  return { ...actual, queries: { ...actual.queries,
    communityMachine: { ...actual.queries.communityMachine, listMachinesForUser: mocks.machines, listMachineBackendQuotasForUser: vi.fn(async () => new Map()) },
    communityBot: { ...actual.queries.communityBot, listBotsForOwner: mocks.bots, getBotDailyActivityForOwner: vi.fn(async () => new Map()), getBotDailyTokenUsageForOwner: vi.fn(async () => new Map()) },
    productPlan: { ...actual.queries.productPlan, resolveMachinesMaxForUser: vi.fn(async () => ({ plan: "free", value: 10 })), getBotCapacitySummary: vi.fn(async () => ({ plan: "free", limit: 10, ownedCount: 4, activeCount: 4 })) },
  } }
})
import { readCommunityMachines } from "./machines.server"
import { readCommunityBots } from "./bots.server"

const backends = ["qoder", "copilot", "cursor-sdk", "pi-durable"]
it("reports unsupported quota for installed SDK backends and keeps unknown backends unknown", async () => {
  mocks.machines.mockResolvedValue([{ id: "machine", status: "online", availableRuntimes: [...backends, "unknown"].map(id => ({ id })) }])
  const result = await readCommunityMachines({} as never, "owner")
  expect(result.machines[0].quota.map(({ capability }) => capability)).toEqual([...backends.map(() => "unsupported"), "unknown"])
})
it("reports supported usage for all four new backends without inventing measured tokens", async () => {
  mocks.bots.mockResolvedValue([...backends, "unknown"].map((runtime, index) => ({ id: `bot-${index}`, runtime, name: runtime, discriminator: "1234", description: "", image: null, avatarVersion: 0, presence: "offline", ownerUserId: "owner" })))
  const result = await readCommunityBots({} as never, "owner")
  expect(result.bots.map(({ usage }) => usage.capability)).toEqual([...backends.map(() => "supported"), "unknown"])
  expect(result.bots[0].usage.days.at(-1)?.metrics).toEqual({ input: null, output: null, cache: null })
})
