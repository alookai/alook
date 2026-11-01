import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { Command } from "commander"
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerUseCommands } from "./use"

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  return { ...actual, stat: vi.fn(actual.stat) }
})

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
  it("expires its supplied code without a target identity and refuses malformed success or repeated expiry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ expired: true }))
    const { run, output } = program()
    await run(["use", "expire"])
    expect(fetch).toHaveBeenCalledExactlyOnceWith("http://localhost:4328/api/community/automation/expire", expect.objectContaining({
      method: "POST", headers: expect.objectContaining({ Authorization: `Bearer ${secret}` }), body: "{}",
    }))
    expect(output).toHaveBeenCalledExactlyOnceWith({ success: { expired: true } })
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ expired: false }))
    await expect(program().run(["use", "expire"])).rejects.toThrow("invalid expiration result")
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Invalid or unauthorized access code" }, { status: 401 }))
    await expect(program().run(["use", "expire"])).rejects.toThrow("Invalid or unauthorized access code")
  })

  it("creates a bot through the dedicated API without proxy or agent identity and maps backendId", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ bot: { id: "b1", name: "Helper", discriminator: "0042" } }, { status: 201 }))
    const { run, output } = program()
    await run(["use", "bot", "--create", JSON.stringify({ name: "Helper", machineId: "mac1", backendId: "codex", model: "gpt-6" })])
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe("http://localhost:4328/api/community/automation/bots")
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
  it("lists three minimal identities through their dedicated GET APIs", async () => {
    for (const [kind, path, result, expected] of [
      ["machine", "/api/community/automation/machines", { machines: [{ id: "mac1", name: "Mac", status: "online", backends: [], hostname: "secret-host" }] }, { machines: [{ id: "mac1", name: "Mac", status: "online", backends: [] }] }],
      ["friend", "/api/community/automation/friends", { friends: [{ name: "Alice", handle: "Alice#0001", is_my_bot: false, email: "private" }] }, { friends: [{ name: "Alice", handle: "Alice#0001", is_my_bot: false }] }],
      ["server", "/api/community/automation/servers", { servers: [{ name: "demo", handle: "demo#0001", ownerId: "private", channels: [] }] }, { servers: [{ name: "demo", handle: "demo#0001", channels: [] }] }],
    ] as const) {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(result))
      const { run, output } = program()
      await run(["use", kind, "--list"])
      expect(vi.mocked(fetch).mock.lastCall).toMatchObject([`http://localhost:4328${path}`, { method: "GET" }])
      expect(output).toHaveBeenCalledExactlyOnceWith({ success: expected })
    }
  })
  it("returns top-level server channel identities and strips unrelated fields", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ servers: [{ name: "demo", handle: "demo#0001", channels: [
      { name: "general", type: "text", ref: "/demo#0001/general", id: "internal", topic: "hidden" },
      { name: "ideas", type: "forum", ref: "/demo#0001/ideas" },
    ] }] }))
    const { run, output } = program()
    await run(["use", "server", "--list"])
    expect(output).toHaveBeenCalledExactlyOnceWith({ success: { servers: [{ name: "demo", handle: "demo#0001", channels: [
      { name: "general", type: "text", ref: "/demo#0001/general" },
      { name: "ideas", type: "forum", ref: "/demo#0001/ideas" },
    ] }] } })
  })
  it("rejects malformed or child-thread server channel results", async () => {
    for (const channels of [undefined, {}, [{ name: "child", type: "thread", ref: "/demo#0001/general/#1" }], [{ name: "general", type: "text" }]]) {
      vi.mocked(fetch).mockResolvedValue(Response.json({ servers: [{ name: "demo", handle: "demo#0001", channels }] }))
      await expect(program().run(["use", "server", "--list"])).rejects.toThrow("invalid server channel list")
    }
  })
  it("preserves own-bot flags and online/offline status while omitting unrelated API fields", async () => {
    const friends = [{ name: "Helper", handle: "Helper#0001", is_my_bot: true }, { name: "Alice", handle: "Alice#0002", is_my_bot: false }]
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ friends: friends.map((friend) => ({ ...friend, ownerId: "private" })) }))
    const friendCommand = program()
    await friendCommand.run(["use", "friend", "--list"])
    expect(friendCommand.output).toHaveBeenCalledExactlyOnceWith({ success: { friends } })
    const machines = [{ id: "mac1", name: "Running", status: "online", backends: [] }, { id: "mac2", name: "Stopped", status: "offline", backends: [] }]
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ machines: machines.map((machine) => ({ ...machine, hostname: "private" })) }))
    const machineCommand = program()
    await machineCommand.run(["use", "machine", "--list"])
    expect(machineCommand.output).toHaveBeenCalledExactlyOnceWith({ success: { machines } })
  })
  it("invites one full friend handle through the existing invites endpoint without generic message access", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ invitation: { server: "demo#0001", friend: "Alice#0001", sent: true } }, { status: 201 }))
    const { run, output } = program()
    await run(["use", "server", "--invite", '{"server":"demo#0001","friend":"Alice#0001"}'])
    expect(vi.mocked(fetch).mock.lastCall).toMatchObject(["http://localhost:4328/api/community/automation/servers/demo%230001/invites", { method: "POST", body: '{"friend":"Alice#0001"}' }])
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
        const root = new Command().exitOverride()
        const output = vi.fn()
        registerUseCommands(root, output)
        await expect(root.parseAsync([...args], { from: "user" })).rejects.toMatchObject({ code })
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
    expect(vi.mocked(fetch).mock.lastCall?.[0]).toBe("https://alook.ai/api/community/automation/machines")
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
      ["machine", { machines: [{ name: "Mac", id: "mac1" }] }],
      ...[null, true, "connected"].map((status) => ["machine", { machines: [{ name: "Mac", id: "mac1", status }] }] as const),
      ["friend", { friends: [{ name: "Alice", handle: 1 }] }],
      ["friend", { friends: [{ name: "Alice", handle: "Alice#0001" }] }],
      ...[null, "true", 1].map((is_my_bot) => ["friend", { friends: [{ name: "Alice", handle: "Alice#0001", is_my_bot }] }] as const),
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

describe("Automation backend and model reads", () => {
  const backend = { id: "codex", version: "1", health: "healthy", modelRequired: false }
  const catalog = { machineId: "mac/1", backendId: "custom/x", source: "fresh_discovery", requestId: "request", readAt: "2026-10-29T00:00:00Z", observedAt: "2026-10-29T00:00:00Z",
    modelRequired: false, defaultModelId: "provider/a",
    models: [{ id: "provider/a", displayName: "A", reasoningEfforts: [{ value: "high", description: "More" }], defaultReasoningEffort: "high" }] }
  it("keeps backend fields while stripping diagnostics", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ machines: [{ id: "m", name: "M", status: "online", backends: [{ ...backend, catalogState: "reported", catalogOrigin: "native_report", lastError: "private" }] }] }))
    const command = program()
    await command.run(["use", "machine", "--list"])
    expect(command.output).toHaveBeenCalledWith({ success: { machines: [{ id: "m", name: "M", status: "online", backends: [backend] }] } })
  })
  it("rejects missing or malformed backend metadata", async () => {
    for (const backends of [undefined, null, {}, [null], [{ ...backend, health: "up" }], [{ ...backend, modelRequired: "false" }]]) {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ machines: [{ id: "m", name: "M", status: "online", backends }] }))
      await expect(program().run(["use", "machine", "--list"])).rejects.toThrow("invalid backend list")
    }
  })
  it("reads the selected backend catalog with encoded targets and projects models and efforts", async () => {
    vi.mocked(fetch).mockImplementationOnce(async (_url, init) => Response.json({ ...catalog, requestId: JSON.parse(init!.body as string).requestId, catalogState: "reported", catalogOrigin: "native_report", private: "hidden", models: catalog.models.map((model) => ({ ...model, private: "hidden" })) }))
    const command = program()
    await command.run(["use", "machine", "--list-models", "--id", "mac/1", "--backend", "custom/x"])
    expect(fetch).toHaveBeenCalledExactlyOnceWith("http://localhost:4328/api/community/automation/machines/mac%2F1/discover-models", expect.objectContaining({ method: "POST", body: expect.any(String) }))
    const requestId = JSON.parse(vi.mocked(fetch).mock.lastCall![1]!.body as string).requestId
    expect(command.output).toHaveBeenCalledExactlyOnceWith({ success: { ...catalog, requestId } })
  })
  it("preserves unreported versus empty catalogs and rejects malformed or mismatched reports", async () => {
    for (const report of [{ ...catalog, source: "cached_report", models: [] }, { ...catalog, models: null, defaultModelId: null }]) {
      vi.mocked(fetch).mockImplementationOnce(async (_url, init) => Response.json({ ...report, requestId: JSON.parse(init!.body as string).requestId }))
      const command = program()
      await command.run(["use", "machine", "--list-models", "--id", "mac/1", "--backend", "custom/x"])
      expect(command.output).toHaveBeenCalledWith({ success: { ...report, requestId: expect.any(String) } })
    }
    for (const report of [{}, { ...catalog, source: "stored_report" }, { ...catalog, machineId: "other" }, { ...catalog, backendId: "other" }, { ...catalog, models: undefined }, { ...catalog, models: [{ id: "x", reasoningEfforts: "high", defaultReasoningEffort: null }] }]) {
      vi.mocked(fetch).mockImplementationOnce(async (_url, init) => Response.json({ ...report, requestId: JSON.parse(init!.body as string).requestId }))
      await expect(program().run(["use", "machine", "--list-models", "--id", "mac/1", "--backend", "custom/x"])).rejects.toThrow("invalid model list")
    }
  })
  it("bypasses the server cache only when --refresh is requested", async () => {
    vi.mocked(fetch).mockImplementationOnce(async (_url, init) => Response.json({ ...catalog, requestId: JSON.parse(init!.body as string).requestId }))
    await program().run(["use", "machine", "--list-models", "--id", "mac/1", "--backend", "custom/x", "--refresh"])
    expect(JSON.parse(vi.mocked(fetch).mock.lastCall![1]!.body as string)).toMatchObject({ runtimeId: "custom/x", refresh: true })
  })
  it("rejects a different request receipt and never retries a failed discovery POST", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(catalog))
    await expect(program().run(["use", "machine", "--list-models", "--id", "mac/1", "--backend", "custom/x"])).rejects.toThrow("invalid model list")
    vi.mocked(fetch).mockClear().mockRejectedValueOnce(new Error("connection reset"))
    await expect(program().run(["use", "machine", "--list-models", "--id", "mac/1", "--backend", "custom/x"])).rejects.toThrow("result may be unknown")
    expect(fetch).toHaveBeenCalledOnce()
  })
  it("rejects missing targets, target flags on list and mixed actions before I/O", async () => {
    for (const args of [["--list-models"], ["--list-models", "--id", "m"], ["--list-models", "--backend", "x"], ["--list-models", "--id", " ", "--backend", "x"], ["--list", "--id", "m"], ["--list", "--backend", "x"], ["--list", "--refresh"], ["--list", "--list-models", "--id", "m", "--backend", "x"]]) {
      await expect(program().run(["use", "machine", ...args])).rejects.toThrow(/requires|require|exactly one/)
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("Automation file message send", () => {
  async function fileRun(bytes: string | Uint8Array, callback: (path: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "alook-use-message-"))
    try {
      const path = join(dir, "message.txt")
      await writeFile(path, bytes)
      await callback(path)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
  it("sends exact UTF-8 file contents as me or a bot using only the dedicated API", async () => {
    await fileRun("你好\nline two\n", async (path) => {
      for (const identity of ["me", "@Helper#0001"]) {
        vi.mocked(fetch).mockClear().mockResolvedValueOnce(Response.json({ state: "sent", seq: "#1", deduped: false }, { status: 201 }))
        const { run, output } = program()
        await run(["use", "message", "--send", "--target", "/.dm/Alice#0002", "--as", identity, "--file", path])
        expect(fetch).toHaveBeenCalledExactlyOnceWith("http://localhost:4328/api/community/automation/messages", expect.objectContaining({ method: "POST", redirect: "error" }))
        expect(JSON.parse(vi.mocked(fetch).mock.lastCall![1]!.body as string)).toEqual({ target: "/.dm/Alice#0002", as: identity, content: "你好\nline two\n", nonce: expect.any(String) })
        expect(output).toHaveBeenCalledWith({ success: { state: "sent", seq: "#1", deduped: false } })
      }
    })
  })
  it("rejects invalid/missing identities, targets, actions and files before network I/O", async () => {
    await fileRun("valid", async (path) => {
      for (const args of [[], ["--send"], ["--send", "--target", "/demo#0001/general", "--as", "me"], ["--target", "/demo#0001/general", "--as", "me", "--file", path], ["--send", "--target", "id", "--as", "me", "--file", path], ["--send", "--target", "/demo#0001/general", "--as", "Helper#0001", "--file", path], ["--send", "--target", "/demo#0001/general", "--as", "me", "--file", `${path}.missing`]]) {
        await expect(program().run(["use", "message", ...args])).rejects.toThrow()
      }
    })
    for (const bytes of [" ", "x".repeat(4001), "x".repeat(16001), new Uint8Array([0xc3, 0x28])]) {
      await fileRun(bytes, async (path) => {
        await expect(program().run(["use", "message", "--send", "--target", "/demo#0001/general", "--as", "me", "--file", path])).rejects.toThrow()
      })
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it("rejects a message file that grows beyond its inspected size", async () => {
    await fileRun("x".repeat(16001), async (path) => {
      vi.mocked(stat).mockResolvedValueOnce({ size: 10, isFile: () => true } as never)
      await expect(program().run(["use", "message", "--send", "--target", "/demo#0001/general", "--as", "me", "--file", path])).rejects.toThrow("Message file is too large")
      expect(fetch).not.toHaveBeenCalled()
    })
  })
  it("surfaces blocked sends, malformed receipts and unknown results without retry", async () => {
    await fileRun("body", async (path) => {
      const args = ["use", "message", "--send", "--target", "/demo#0001/general", "--as", "@Helper#0001", "--file", path]
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ state: "blocked", reason: "unaligned" }))
      await expect(program().run(args)).rejects.toMatchObject({ code: "unaligned" })
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({}))
      await expect(program().run(args)).rejects.toThrow("invalid message result")
      vi.mocked(fetch).mockClear().mockRejectedValueOnce(new Error("reset"))
      await expect(program().run(args)).rejects.toThrow("result may be unknown")
      expect(fetch).toHaveBeenCalledOnce()
    })
  })
})

it("reads a server roster page with encoded handles and cursor and strips extra fields", async () => {
  const page = { server: "team#0042", url: "https://alook.ai/c/channels/s1", members: [{ handle: "Helper#0001", role: "member", email: "private" }], hasMore: true, cursor: "date|member" }
  vi.mocked(fetch).mockResolvedValue(Response.json(page))
  const { run, output } = program()
  await run(["use", "server", "--members", "team#0042", "--cursor", "date|last"])
  expect(fetch).toHaveBeenCalledExactlyOnceWith("http://localhost:4328/api/community/automation/servers/team%230042/members?cursor=date%7Clast", expect.objectContaining({ method: "GET" }))
  expect(output).toHaveBeenCalledExactlyOnceWith({ success: { ...page, members: [{ handle: "Helper#0001", role: "member" }] } })
})
it("rejects malformed member pages and conflicting roster actions", async () => {
  for (const args of [ ["use", "server", "--members", "bad"], ["use", "server", "--members", "team#0042", "--list"], ["use", "server", "--list", "--cursor", "date|id"] ]) {
    await expect(program().run(args)).rejects.toThrow()
  }
  expect(fetch).not.toHaveBeenCalled()
  for (const result of [ { server: "team#0042", members: [], hasMore: true }, { server: "team#0042", url: "https://alook.ai/c/channels/s1", members: [], hasMore: true } ]) {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(result))
    await expect(program().run(["use", "server", "--members", "team#0042"])).rejects.toThrow("invalid member list")
  }
})

it("accepts a final roster page and refuses a different server's roster", async () => {
  const page = { server: "team#0042", url: "https://alook.ai/c/channels/s1", members: [{ handle: "Owner#0001", role: "owner" }], hasMore: false }
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(page))
  const { run, output } = program()
  await run(["use", "server", "--members", "team#0042"])
  expect(output).toHaveBeenCalledExactlyOnceWith({ success: page })
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...page, server: "other#0042" }))
  await expect(program().run(["use", "server", "--members", "team#0042"])).rejects.toThrow("invalid member list")
})
