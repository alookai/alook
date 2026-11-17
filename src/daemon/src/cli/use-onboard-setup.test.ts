import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Command } from "commander"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerUseCommands } from "./use"

let directory: string
const secret = "aac_" + "b".repeat(64)
const receipt = { state: "sent", server: { handle: "Team#0042", url: "http://localhost:4328/c/channels/s1", channel: "/Team#0042/all" }, bots: ["Mireille#0042"], message: { seq: "#1" } }
const options = (bots = ["Mireille#0042"]) => ["use", "onboard-setup", "--server", "Team", ...bots.flatMap(id => ["--bot", id]), "--task-file", join(directory, "task.txt")]
function command() {
  const root = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  const output = vi.fn()
  registerUseCommands(root, output)
  return { output, run: (args = options()) => root.parseAsync(args, { from: "user" }) }
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "alook-onboard-cli-"))
  await writeFile(join(directory, "task.txt"), "Review the draft and agree a next step.")
  vi.stubEnv("ALOOK_ACCESS_CODE", secret)
  vi.stubEnv("ALOOK_SERVER_URL", "http://localhost:4328")
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(receipt)))
})
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

it("posts only existing bot handles once without preflight, bot creation, expiry or local recovery state", async () => {
  const first = command()
  await first.run(options(["Mireille#0042", "Thiago#0043"]))
  expect(fetch).toHaveBeenCalledOnce()
  const [url, init] = vi.mocked(fetch).mock.calls[0]!
  expect(url).toBe("http://localhost:4328/api/community/automation/onboard-setup")
  expect(init?.method).toBe("POST")
  expect(JSON.parse(init!.body as string)).toEqual({ server: { name: "Team" }, bots: ["Mireille#0042", "Thiago#0043"], firstTask: "Review the draft and agree a next step." })
  expect(first.output).toHaveBeenCalledWith({ success: receipt })
  expect(await readdir(directory)).toEqual(["task.txt"])
})

it("rejects repeated bot handles and obsolete creation options before any request", async () => {
  await expect(command().run(options(["Mireille#0042", "Mireille#0042"]))).rejects.toThrow("Choose each bot once")
  await expect(command().run([...options(), "--machine", "m1"])).rejects.toThrow("unknown option")
  expect(fetch).not.toHaveBeenCalled()
})

it("rejects an invalid UTF-8 task before any request", async () => {
  await writeFile(join(directory, "task.txt"), Buffer.from([0xff]))
  await expect(command().run()).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
})

it("does not retry an unknown response and asks the agent to inspect server membership", async () => {
  vi.mocked(fetch).mockRejectedValue(new Error("connection reset"))
  await expect(command().run()).rejects.toMatchObject({ hint: expect.stringContaining("check the server and its bot membership") })
  expect(fetch).toHaveBeenCalledOnce()
  expect(await readdir(directory)).toEqual(["task.txt"])
})

it("surfaces only the remaining server handle and preserves rate-limit recovery", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ error: "limited", cleanup: "incomplete", remaining: { server: "Team#0042" } }, { status: 429, headers: { "Retry-After": "9" } }))
  await expect(command().run()).rejects.toMatchObject({ hint: expect.stringContaining('Inspect remaining resources: {"server":"Team#0042"}. Retry after 9 seconds') })
  expect(fetch).toHaveBeenCalledOnce()
})

it("rejects database bot IDs and never exposes malformed cleanup identifiers", async () => {
  await expect(command().run(options(["database-bot-id"]))).rejects.toThrow("Use a full handle")
  expect(fetch).not.toHaveBeenCalled()
  vi.mocked(fetch).mockResolvedValue(Response.json({ error: "limited", cleanup: "incomplete", remaining: { serverId: "private-database-id" } }, { status: 429 }))
  await expect(command().run()).rejects.toMatchObject({ hint: expect.not.stringContaining("private-database-id") })
})
