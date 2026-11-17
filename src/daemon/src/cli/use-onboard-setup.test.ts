import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Command } from "commander"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerUseCommands } from "./use"

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }))
vi.mock("node:readline/promises", () => ({ createInterface: () => ({ question: mocks.question, close: mocks.close }) }))
let directory: string
const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
const secret = "aac_" + "b".repeat(64)
const preflight = { machines: [{ id: "m1", status: "online", backends: [{ id: "codex-app", health: "healthy", modelRequired: false }, { id: "claude", health: "healthy", modelRequired: false }] }] }
const receipt = { state: "sent", server: { id: "s1", handle: "Team#0042", url: "http://localhost:4328/c/channels/s1", channel: "/Team#0042/all" }, bots: [{ id: "b1", handle: "Mireille#0042" }], message: { seq: "#1" } }
const posts = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")
const options = (bot = "Mireille:codex-app") => ["use", "onboard-setup", "--server", "Team", "--machine", "m1", "--bot", bot, "--task-file", join(directory, "task.txt")]
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
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => Response.json(init?.method === "POST" ? receipt : preflight)))
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
  mocks.question.mockReset(); mocks.close.mockReset()
})
afterEach(async () => {
  if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
  else Reflect.deleteProperty(process.stdin, "isTTY")
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

it("runs one stateless setup without expiring access or writing local state", async () => {
  const first = command()
  await first.run()
  const body = JSON.parse(posts()[0]![1]!.body as string)
  expect(body).toMatchObject({ server: { name: "Team" }, bots: [{ name: "Mireille", machineId: "m1", backendId: "codex-app" }], firstTask: "Review the draft and agree a next step." })
  expect(body).not.toHaveProperty("requestId")
  expect(first.output).toHaveBeenCalledWith({ success: receipt })
  expect(await readdir(directory)).toEqual(["task.txt"])
  expect(posts()).toHaveLength(1)
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("expire"))).toBe(false)
})

it("requires an explicit backend choice in agent mode and creates nothing before it is confirmed", async () => {
  await expect(command().run(options("Mireille"))).rejects.toMatchObject({ code: "BACKEND_SELECTION_REQUIRED" })
  expect(posts()).toHaveLength(0)
  expect(await readdir(directory)).toEqual(["task.txt"])
})

it("offers actual healthy backends interactively rather than inheriting the setup assistant", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
  mocks.question.mockResolvedValue("2")
  await command().run(options("Mireille"))
  expect(mocks.question).toHaveBeenCalledWith(expect.stringContaining("codex-app\n2. claude"))
  expect(JSON.parse(posts()[0]![1]!.body as string).bots[0].backendId).toBe("claude")
  expect(mocks.close).toHaveBeenCalledOnce()
})

it("does not retry an unknown response and asks the agent to inspect existing resources", async () => {
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    if (init?.method !== "POST") return Response.json(preflight)
    throw new Error("connection reset")
  })
  await expect(command().run()).rejects.toMatchObject({ hint: expect.stringContaining("check the server and bots") })
  expect(posts()).toHaveLength(1)
  expect(await readdir(directory)).toEqual(["task.txt"])
})


it("surfaces incomplete cleanup IDs and preserves rate-limit recovery", async () => {
  vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === "POST"
    ? Response.json({ error: "limited", cleanup: "incomplete", remaining: { serverId: "s1", botIds: ["b1"] } }, { status: 429, headers: { "Retry-After": "9" } }) : Response.json(preflight))
  await expect(command().run()).rejects.toMatchObject({ hint: expect.stringContaining('Inspect remaining resources: {"serverId":"s1","botIds":["b1"]}. Retry after 9 seconds') })
  expect(posts()).toHaveLength(1)
})
