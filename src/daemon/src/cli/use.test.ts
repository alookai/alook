import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { Command } from "commander"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

describe("Automation CLI input and response recovery", () => {
  it("keeps parent and child help and argument errors silent for the outer JSON handler", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      for (const [args, code] of [
        [["use", "--help"], "commander.helpDisplayed"],
        [["use", "--unknown"], "commander.unknownOption"],
        [["use", "machine", "--help"], "commander.helpDisplayed"],
        [["use", "machine", "--unknown"], "commander.unknownOption"],
      ] as const) {
        const { run, output } = program()
        await expect(run([...args])).rejects.toMatchObject({ code })
        expect(output).not.toHaveBeenCalled()
      }
      expect(stdout).not.toHaveBeenCalled()
      expect(stderr).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }
  })

  it("reads a private code file before the environment and rejects oversized files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alook-use-"))
    const file = join(dir, "code")
    try {
      vi.stubEnv("ALOOK_ACCESS_CODE", "wrong")
      await writeFile(file, `  ${secret}\n`, { mode: 0o600 })
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ machines: [] }))
      await program().run(["use", "--access-code-file", file, "machine", "--list"])
      expect(vi.mocked(fetch).mock.lastCall?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${secret}` })
      await writeFile(file, "x".repeat(1025))
      await expect(program().run(["use", "--access-code-file", file, "machine", "--list"])).rejects.toThrow("file is too large")
      expect(fetch).toHaveBeenCalledOnce()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it("refuses missing credentials, malformed JSON and oversized requests before sending", async () => {
    for (const value of ["", "bad"]) {
      vi.stubEnv("ALOOK_ACCESS_CODE", value)
      await expect(program().run(["use", "machine", "--list"])).rejects.toThrow("Set ALOOK_ACCESS_CODE")
    }
    vi.stubEnv("ALOOK_ACCESS_CODE", secret)
    for (const [value, error] of [["not-json", "Invalid request JSON"], ["x".repeat(131073), "too large"]]) {
      await expect(program().run(["use", "server", "--create", value])).rejects.toThrow(error)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it("uses the production default and only sends credentials to a bare approved origin", async () => {
    vi.stubEnv("ALOOK_SERVER_URL", "")
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ machines: [] }))
    await program().run(["use", "machine", "--list"])
    expect(vi.mocked(fetch).mock.lastCall?.[0]).toBe("https://alook.ai/api/community/machines")
    for (const origin of ["https://user@example.com", "https://:pass@example.com", "https://example.com?q=x", "https://example.com#x", "https://example.com/path"]) {
      await expect(program().run(["use", "--server-url", origin, "machine", "--list"])).rejects.toThrow("must be a server origin")
    }
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("reports unreadable and invalid server envelopes without replaying a request", async () => {
    const responses = [new Response("not-json", { status: 502 }), ...[null, [], 42].map((body) => Response.json(body))]
    for (const response of responses) {
      vi.mocked(fetch).mockClear().mockResolvedValueOnce(response)
      await expect(program().run(["use", "machine", "--list"])).rejects.toThrow(/valid result|invalid result/)
      expect(fetch).toHaveBeenCalledOnce()
    }
    vi.mocked(fetch).mockClear().mockRejectedValueOnce(new Error("offline"))
    await expect(program().run(["use", "machine", "--list"])).rejects.toThrow("Automation request failed")
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("keeps safe error codes and retry guidance while redacting the code", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: `DENIED_${secret}` }, { status: 503 }))
    await expect(program().run(["use", "machine", "--list"])).rejects.toMatchObject({ message: "Automation failed: HTTP 503", code: "DENIED_[redacted]" })
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({}, { status: 429 }))
    await expect(program().run(["use", "machine", "--list"])).rejects.toMatchObject({ hint: "Retry after the indicated seconds" })
  })

  it("rejects incomplete or malformed minimal list identities", async () => {
    for (const [kind, body] of [
      ["machine", { machines: {} }], ["machine", { machines: [null] }], ["machine", { machines: ["bad"] }],
      ["machine", { machines: [{}] }], ["machine", { machines: [{ name: 1 }] }],
      ["machine", { machines: [{ name: "Mac" }] }], ["machine", { machines: [{ name: "Mac", id: 1 }] }],
      ["friend", { friends: [{ name: "Alice", handle: 1 }] }],
    ] as const) {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(body))
      await expect(program().run(["use", kind, "--list"])).rejects.toThrow(/invalid list|invalid identity/)
    }
  })

  it("refuses incomplete invitation receipts instead of claiming a message was sent", async () => {
    for (const invitation of [null, "bad", {}, { sent: false }, { sent: true }, { sent: true, server: 1 }, { sent: true, server: "demo#0001" }, { sent: true, server: "demo#0001", friend: 1 }]) {
      vi.mocked(fetch).mockClear().mockResolvedValueOnce(Response.json({ invitation }))
      await expect(program().run(["use", "server", "--invite", '{"server":"demo#0001","friend":"Alice#0001"}'])).rejects.toThrow("invalid invitation result")
      expect(fetch).toHaveBeenCalledOnce()
    }
  })

  it("refuses incomplete creation receipts instead of inventing a resource identity", async () => {
    for (const server of [null, "bad", {}, { id: "s" }, { id: "s", name: "demo" }, { id: 1, name: "demo", discriminator: "0001" }, { id: "s", name: 1, discriminator: "0001" }, { id: "s", name: "demo", discriminator: 1 }]) {
      vi.mocked(fetch).mockClear().mockResolvedValueOnce(Response.json({ server }))
      await expect(program().run(["use", "server", "--create", '{"name":"demo"}'])).rejects.toThrow("invalid result")
      expect(fetch).toHaveBeenCalledOnce()
    }
  })
})
