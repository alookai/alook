import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({ owned: vi.fn(), actor: vi.fn(), human: vi.fn(), bot: vi.fn(), admit: vi.fn() }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ primary: true }) }))
vi.mock("@alook/shared", async (original) => ({ ...await original<typeof import("@alook/shared")>(), queries: { automation: { getOwnedBotByHandle: mocks.owned } } }))
vi.mock("@/lib/middleware/community-agent-runner-auth", () => ({ resolveOwnedBotActor: mocks.actor }))
vi.mock("./message-send.server", () => ({ handleHumanSend: mocks.human, handleBotSend: mocks.bot }))
import { sendAutomationMessage } from "./automation-message.server"
const body = { target: "/demo#0001/general", as: "me", content: "你好\nsecond line\n", nonce: "n1" }
const req = (input: unknown = body) => new NextRequest("http://localhost/api/community/automation/messages", { method: "POST", body: JSON.stringify(input) })
const ctx = { env: { DB: {} } as Env, userId: "owner", beforeCreate: mocks.admit }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.owned.mockResolvedValue({ id: "ownbot" })
  mocks.actor.mockResolvedValue({ kind: "bot", actor: { botUserId: "ownbot" } })
  mocks.admit.mockResolvedValue(null)
  mocks.human.mockResolvedValue(Response.json({ message: { id: "hm", seq: 3 } }, { status: 201 }))
  mocks.bot.mockResolvedValue(Response.json({ state: "sent", message: { seq: "#4" } }))
})
it("uses the code owner, exact file content and existing human sender with ref addressing", async () => {
  const response = await sendAutomationMessage(req(), ctx)
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({ state: "sent", seq: "#3", deduped: false })
  expect(mocks.human).toHaveBeenCalledWith({ primary: true }, "owner", ctx.env,
    { ref: body.target, createDmIfMissing: true, createThreadIfMissing: true }, { content: body.content, nonce: "n1" }, expect.any(Number))
  expect(mocks.admit).toHaveBeenCalledOnce()
  expect(mocks.owned).not.toHaveBeenCalled()
  expect(mocks.bot).not.toHaveBeenCalled()
})
it("resolves ownership and ordinary bot eligibility before invoking the existing bot sender as that bot", async () => {
  const response = await sendAutomationMessage(req({ ...body, as: "@Helper#0001", target: "/.dm/Alice#0002" }), ctx)
  expect(await response.json()).toEqual({ state: "sent", seq: "#4", deduped: false })
  expect(mocks.owned).toHaveBeenCalledWith({ primary: true }, "owner", "Helper#0001")
  expect(mocks.actor).toHaveBeenCalledWith({ primary: true }, "ownbot", "owner")
  expect(mocks.bot).toHaveBeenCalledExactlyOnceWith({ primary: true }, "ownbot", ctx.env,
    { channel: "/.dm/Alice#0002", content: { text: body.content }, nonce: "n1" })
  expect(mocks.human).not.toHaveBeenCalled()
})
it("rejects foreign/deleted/human handles and ineligible bot bindings without spending a send or calling a sender", async () => {
  mocks.owned.mockResolvedValueOnce(null)
  expect((await sendAutomationMessage(req({ ...body, as: "@Other#0001" }), ctx)).status).toBe(404)
  mocks.actor.mockResolvedValueOnce({ kind: "error", response: Response.json({ error: "inactive" }, { status: 403 }) })
  expect((await sendAutomationMessage(req({ ...body, as: "@Helper#0001" }), ctx)).status).toBe(403)
  expect(mocks.admit).not.toHaveBeenCalled()
  expect(mocks.human).not.toHaveBeenCalled()
  expect(mocks.bot).not.toHaveBeenCalled()
})
it("rejects invalid identity/target/content and spoofed body fields before any actor lookup", async () => {
  for (const input of [null, {}, { ...body, as: "owner" }, { ...body, as: "Helper#0001" }, { ...body, as: "@Helper" }, { ...body, target: "channel-id" }, { ...body, content: " " }, { ...body, content: "x".repeat(4001) }, { ...body, userId: "foreign" }, { ...body, seenUpToSeq: 999 }]) {
    expect((await sendAutomationMessage(req(input), ctx)).status).toBe(400)
  }
  expect(mocks.owned).not.toHaveBeenCalled()
  expect(mocks.admit).not.toHaveBeenCalled()
  expect(mocks.human).not.toHaveBeenCalled()
  expect(mocks.bot).not.toHaveBeenCalled()
})
it("returns quota failures and original alignment/permission failures without changing them", async () => {
  mocks.admit.mockResolvedValueOnce(Response.json({ error: "limited" }, { status: 429, headers: { "Retry-After": "17" } }))
  const limited = await sendAutomationMessage(req(), ctx)
  expect(limited.status).toBe(429)
  expect(limited.headers.get("Retry-After")).toBe("17")
  expect(mocks.human).not.toHaveBeenCalled()
  const blocked = { state: "blocked", reason: "unaligned", unreadCount: 2, latestSeq: 4 }
  mocks.bot.mockResolvedValueOnce(Response.json(blocked))
  expect(await (await sendAutomationMessage(req({ ...body, as: "@Helper#0001" }), ctx)).json()).toEqual(blocked)
  mocks.human.mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }))
  expect((await sendAutomationMessage(req(), ctx)).status).toBe(403)
})

it("keeps the same Automation receipt for human and bot forum openers and replays", async () => {
  mocks.human.mockResolvedValueOnce(Response.json({ message: { seq: 8 }, threadId: "thread-h", deduped: true }))
  expect(await (await sendAutomationMessage(req(), ctx)).json()).toEqual({ state: "sent", seq: "#8", threadId: "thread-h", deduped: true })
  mocks.bot.mockResolvedValueOnce(Response.json({ state: "sent", message: { seq: "#9" }, threadId: "thread-b", deduped: true }))
  expect(await (await sendAutomationMessage(req({ ...body, as: "@Helper#0001" }), ctx)).json()).toEqual({ state: "sent", seq: "#9", threadId: "thread-b", deduped: true })
})
