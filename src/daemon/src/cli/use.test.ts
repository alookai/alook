import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { Command } from "commander"
import { registerUseCommands } from "./use"

const secret = "aac_" + "a".repeat(64)
function program() {
  const root = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  const output = vi.fn()
  registerUseCommands(root, output)
  return { output, run: (args: string[]) => root.parseAsync(args, { from: "user" }) }
}
beforeEach(() => { vi.stubEnv("ALOOK_ACCESS_CODE", secret); vi.stubEnv("ALOOK_SERVER_URL", "http://localhost:4328"); vi.stubGlobal("fetch", vi.fn()) })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe("use automation CLI", () => {
  it("creates a bot through the existing API without proxy or agent identity and maps backendId", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ bot: { id: "b1", name: "Helper", discriminator: "0042" } }, { status: 201 }))
    const { run, output } = program()
    await run(["use", "bot", "--create", JSON.stringify({ name: "Helper", machineId: "mac1", backendId: "codex", model: "gpt-6" })])
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe("http://localhost:4328/api/community/bots")
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: `Bearer ${secret}` } })
    expect(JSON.parse(init!.body as string)).toMatchObject({ runtime: "codex", machineId: "mac1" })
    expect(output).toHaveBeenCalledExactlyOnceWith({ success: { bot: { id: "b1", handle: "Helper#0042" } } })
  })
  it("returns a server URL, never the access code", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ server: { id: "s1", name: "demo", discriminator: "0042", ownerId: "private" } }, { status: 201 }))
    const { run, output } = program()
    await run(["use", "server", "--create", '{"name":"demo"}'])
    expect(output).toHaveBeenCalledExactlyOnceWith({ success: { server: { id: "s1", handle: "demo#0042", url: "http://localhost:4328/c/channels/s1" } } })
    expect(JSON.stringify(output.mock.calls)).not.toContain(secret)
  })
  it("rejects invalid input and insecure remote targets before network I/O", async () => {
    for (const args of [ ["use", "server", "--create", "null"], ["use", "bot", "--create", '{"name":"x"}'], ["use", "--server-url", "http://example.com", "server", "--create", '{"name":"x"}'] ]) {
      await expect(program().run(args)).rejects.toThrow()
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it("does not retry an unknown creation result or leak secret in server errors", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("connection reset"))
    await expect(program().run(["use", "server", "--create", '{"name":"demo"}'])).rejects.toThrow("result may be unknown")
    expect(fetch).toHaveBeenCalledOnce()
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: `rejected ${secret}` }, { status: 401 }))
    await expect(program().run(["use", "server", "--create", '{"name":"demo"}'])).rejects.toThrow("rejected [redacted]")
  })
  it("returns rate-limit recovery and refuses redirects", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "Rate limited" }, { status: 429, headers: { "Retry-After": "60" } }))
    await expect(program().run(["use", "server", "--create", '{"name":"demo"}'])).rejects.toMatchObject({ hint: "Retry after 60 seconds" })
  })
  it("lists three minimal identities through their existing GET APIs", async () => {
    for (const [kind, path, result, expected] of [
      ["machine", "/api/community/machines", { machines: [{ id: "mac1", name: "Mac", hostname: "secret-host" }] }, { machines: [{ id: "mac1", name: "Mac" }] }],
      ["friend", "/api/community/friends/accepted", { friends: [{ name: "Alice", handle: "Alice#0001", email: "private" }] }, { friends: [{ name: "Alice", handle: "Alice#0001" }] }],
      ["server", "/api/community/servers", { servers: [{ name: "demo", handle: "demo#0001", ownerId: "private" }] }, { servers: [{ name: "demo", handle: "demo#0001" }] }],
    ] as const) {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(result))
      const { run, output } = program()
      await run(["use", kind, "--list"])
      expect(vi.mocked(fetch).mock.lastCall).toMatchObject([`http://localhost:4328${path}`, { method: "GET" }])
      expect(output).toHaveBeenCalledExactlyOnceWith({ success: expected })
    }
  })
  it("invites one full friend handle through the existing invites endpoint without generic message access", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ invitation: { server: "demo#0001", friend: "Alice#0001", sent: true } }, { status: 201 }))
    const { run, output } = program()
    await run(["use", "server", "--invite", '{"server":"demo#0001","friend":"Alice#0001"}'])
    expect(vi.mocked(fetch).mock.lastCall).toMatchObject(["http://localhost:4328/api/community/servers/demo%230001/invites", { method: "POST", body: '{"friend":"Alice#0001"}' }])
    expect(output).toHaveBeenCalledExactlyOnceWith({ success: { invitation: { server: "demo#0001", friend: "Alice#0001", sent: true } } })
    await expect(program().run(["use", "server", "--list", "--create", '{"name":"demo"}'])).rejects.toThrow("exactly one")
  })
})
