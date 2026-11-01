import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CommunityMachineIdentity, WsDurableContext } from "./internal"
const mocks = vi.hoisted(() => ({ bot: vi.fn(), epoch: vi.fn(), notify: vi.fn() }))
vi.mock("@alook/shared", async original => ({
  ...await original<typeof import("@alook/shared")>(), createDb: () => ({}),
  queries: { communityBot: { getBotOwnedBy: mocks.bot }, communityMachineSession: { transitionMachineSessionEpoch: mocks.epoch } },
}))
vi.mock("./presence-typing", () => ({ notifyUserDO: mocks.notify }))
import { handlePiiResultFrame } from "./machine-pii"
const identity: CommunityMachineIdentity = { userId: "owner", machineId: "machine", credentialHash: "synthetic-hash" }
const context = { env: { DB: {} }, log: { warn: vi.fn() } } as unknown as WsDurableContext
const frame = { type: "pii_result", botId: "bot", requestId: "request", result: { status: "complete", snapshot: { revision: 1, plugins: [] } } }
describe("PII results", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.bot.mockResolvedValue({ machineId: "machine" }); mocks.epoch.mockResolvedValue({ type: "transitioned" }) })
  it("checks current owner, binding and credential epoch before routing metadata only to the owner", async () => {
    expect(await handlePiiResultFrame(context, frame, identity)).toBe(true)
    expect(mocks.bot).toHaveBeenCalledWith({}, "bot", "owner")
    expect(mocks.epoch).toHaveBeenCalledWith({}, { type: "renew", epoch: identity })
    expect(mocks.notify).toHaveBeenCalledWith(context, "owner", { ...frame, type: "community:bot.pii", machineId: "machine" })
  })
  it("drops removed/rebound bots and revoked epochs", async () => {
    for (const bot of [null, { machineId: "other" }]) {
      mocks.bot.mockResolvedValue(bot)
      expect(await handlePiiResultFrame(context, frame, identity)).toBe(true)
    }
    expect(mocks.epoch).not.toHaveBeenCalled()
    mocks.bot.mockResolvedValue({ machineId: "machine" })
    mocks.epoch.mockResolvedValue({ type: "stale_epoch" })
    await handlePiiResultFrame(context, frame, identity)
    expect(mocks.notify).not.toHaveBeenCalled()
  })
  it("rejects results carrying source or invalid schema without querying or notifying", async () => {
    const result = { status: "complete", snapshot: { revision: 1, plugins: [{ id: "p", name: "p", description: "d", enabled: true, source: "private code" }] } }
    await handlePiiResultFrame(context, { ...frame, result }, identity)
    await handlePiiResultFrame(context, { ...frame, requestId: "" }, identity)
    expect(mocks.bot).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
  })
  it("contains owner-notification failures without logging preview text or raw exceptions", async () => {
    mocks.notify.mockRejectedValueOnce(new Error("PRIVATE_EXCEPTION"))
    const preview = { ...frame, result: { ...frame.result, output: "PRIVATE_SAMPLE" } }
    expect(await handlePiiResultFrame(context, preview, identity)).toBe(true)
    expect(context.log.warn).toHaveBeenCalledWith("PII result unavailable", { machineId: "machine" })
    expect(JSON.stringify(vi.mocked(context.log.warn).mock.calls)).not.toContain("PRIVATE_")
  })
  it("relays bounded preview output with the captured revision through the same owner checks", async () => {
    const preview = { ...frame, result: { ...frame.result, output: "filtered-output", triggeredFilters: [{ id: "email", name: "Email addresses" }] } }
    await handlePiiResultFrame(context, preview, identity)
    expect(mocks.notify).toHaveBeenCalledWith(context, "owner", { ...preview, type: "community:bot.pii", machineId: "machine" })
  })
})
