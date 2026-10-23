import { describe, expect, it, vi } from "vitest"
import { Command } from "commander"
import { registerPlatformCommands } from "./platform"
import { createProxyServerApi } from "./proxyServerApi"

async function run(args: string[], fetchImpl = vi.fn(async () => Response.json({ machines: [] }))) {
  const output = vi.fn()
  const program = new Command("alook").exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  registerPlatformCommands(program, () => createProxyServerApi({ proxyUrl: "http://proxy", voucher: "vch_private", fetchImpl }), output)
  await program.parseAsync(args, { from: "user" })
  return { output, fetchImpl }
}
const bot = { name: "Reviewer", machineId: "m1", backendId: "codex", model: "full/model-id", reasoningEffort: "high", description: "Check sources", reason: "Independent review" }

describe("platform command registration through the real proxy API client", () => {
  it("uses exactly two action-flag entrypoints and no-argument help has no network effects", async () => {
    const fetchImpl = vi.fn()
    const result = await run(["platform", "machine"], fetchImpl)
    expect(result.output.mock.calls[0][0].success.usage).toContain("--models")
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(run(["platform", "bot", "--list", "--create", JSON.stringify(bot)], fetchImpl)).rejects.toMatchObject({ code: "INVALID_ACTION" })
    await expect(run(["platform", "machine", "--backends", "--models", "--id", "m1"], fetchImpl)).rejects.toMatchObject({ code: "INVALID_ACTION" })
    await expect(run(["platform", "bot", "--request-status", "request"], fetchImpl)).rejects.toThrow("unknown option")
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it("normalizes one or multiple --create flags to one request and preserves independent configurations", async () => {
    for (const items of [[bot], [bot, { ...bot, name: "Researcher", model: "other/model", reasoningEffort: "low" }]]) {
      const fetchImpl = vi.fn(async () => Response.json({ status: "pending", count: items.length, requestId: "request" }))
      const result = await run(["platform", "bot", ...items.flatMap((item) => ["--create", JSON.stringify(item)])], fetchImpl)
      expect(fetchImpl).toHaveBeenCalledOnce()
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe("http://proxy/api/community/bots/creation-requests")
      expect(JSON.parse(init.body as string)).toMatchObject({ requestId: expect.any(String), bots: items })
      expect(init.headers).toEqual(expect.objectContaining({ authorization: "Bearer vch_private" }))
      expect(result.output).toHaveBeenCalledWith({ success: { status: "pending", count: items.length, requestId: "request" } })
    }
  })
  it("rejects invalid JSON, blank reason, owner injection and an oversized batch before transport", async () => {
    const fetchImpl = vi.fn()
    await expect(run(["platform", "bot", "--create", "{"], fetchImpl)).rejects.toMatchObject({ code: "INVALID_PROPOSAL", platformDetails: { itemIndex: 1 } })
    await expect(run(["platform", "bot", "--create", JSON.stringify(bot), "--create", JSON.stringify({ ...bot, reason: " " })], fetchImpl)).rejects.toMatchObject({ code: "REASON_REQUIRED", platformDetails: { itemIndex: 2, field: "reason" } })
    await expect(run(["platform", "bot", "--create", JSON.stringify({ ...bot, reason: "x".repeat(1001) })], fetchImpl)).rejects.toMatchObject({ code: "INVALID_PROPOSAL", platformDetails: { itemIndex: 1, field: "reason" } })
    await expect(run(["platform", "bot", "--create", JSON.stringify({ ...bot, ownerId: "stranger" })], fetchImpl)).rejects.toMatchObject({ code: "INVALID_PROPOSAL" })
    await expect(run(["platform", "bot", ...Array.from({ length: 21 }, () => ["--create", JSON.stringify(bot)]).flat()], fetchImpl)).rejects.toMatchObject({ code: "INVALID_PROPOSAL" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it("reads target models with the full model ID and never sends a self-asserted identity", async () => {
    const result = await run(["platform", "machine", "--models", "--id", "machine/one", "--backend", "codex", "--model", "provider/model"])
    expect(result.fetchImpl.mock.calls[0][0]).toBe("http://proxy/api/community/machines/machine%2Fone/models?backend=codex&model=provider%2Fmodel")
  })
})
