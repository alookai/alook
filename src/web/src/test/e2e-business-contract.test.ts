import { afterEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { protectCommunityJsonResponse, rejectUnknownCommunityContract } from "@/lib/middleware/response-cache"
import { communityFixtureFetch } from "./e2e-ui/_fixtures/business-contract"
import { createSeed } from "./e2e-ui/_fixtures/seed"
import { WEB_URL } from "./e2e-ui/_setup/paths"

vi.mock("./e2e-ui/_fixtures/community-fixture", () => ({ sessionCookie: vi.fn(), userId: vi.fn() }))
vi.mock("./e2e-ui/_fixtures/manifest", () => ({ manifest: () => ({ users: {} }) }))
afterEach(() => vi.unstubAllGlobals())

function transport(handler: (request: Request) => Promise<Response> | Response) {
  const accepted: Request[] = []
  const fetchMock = vi.fn(async (url: string | URL, options?: RequestInit) => {
    const request = new Request(url, options)
    const refused = rejectUnknownCommunityContract(request)
    if (!refused) accepted.push(request)
    return protectCommunityJsonResponse(request, refused ?? await handler(request))
  })
  vi.stubGlobal("fetch", fetchMock)
  return { accepted, fetchMock }
}

describe("owned fixture current protocol", () => {
  it("connects an explicit current fixture request through actual guard and confirmation", async () => {
    const h = transport(() => Response.json({ id: "receipt" }))
    expect(await (await communityFixtureFetch(`${WEB_URL}/api/community/operation`, { method: "POST", headers: { Cookie: "fixture", Origin: WEB_URL } })).json()).toEqual({ id: "receipt" })
    expect(h.accepted).toHaveLength(1)
    expect(h.accepted[0].headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    expect(h.accepted[0].headers.get("Cookie")).toBe("fixture")
    for (const version of [null, BUSINESS_SCHEMA_VERSION - 1]) {
      const response = await fetch(`${WEB_URL}/api/community/operation`, { headers: version === null ? {} : { [COMMUNITY_CONTRACT_HEADER]: String(version) } })
      expect(response.status).toBe(400)
    }
    expect(h.accepted).toHaveLength(1)
  })
  it.each([null, BUSINESS_SCHEMA_VERSION - 1, BUSINESS_SCHEMA_VERSION + 1])("rejects an unconfirmed successful fixture response (%s)", async version => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "receipt" }, { headers: version === null ? {} : { [COMMUNITY_CONTRACT_HEADER]: String(version) } })))
    await expect(communityFixtureFetch(`${WEB_URL}/api/community/operation`)).rejects.toThrow("did not confirm current business version")
  })
  it("preserves original failed status and body for the caller's error evidence", async () => {
    const response = new Response("original failure", { status: 500 })
    vi.stubGlobal("fetch", vi.fn(async () => response))
    expect(await communityFixtureFetch(`${WEB_URL}/api/community/operation`)).toBe(response)
    expect(response.bodyUsed).toBe(false)
  })
  it("runs actual server/join/retirement preconditions without accepting a generic400 join", async () => {
    let joinError = "Already a member"
    const h = transport(request => {
      const path = new URL(request.url).pathname
      if (path.endsWith("/join")) return Response.json({ error: joinError }, { status: 400 })
      if (path.endsWith("/invites")) return Response.json({ invite: { token: "token" } })
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      return Response.json({ server: { id: "server" } }, { status: 201 })
    })
    const seed = createSeed({ sessionCookie: () => "fixture-cookie", userId: key => key, users: () => ({ alice: { userId: "alice" }, bob: { userId: "bob" } }) })
    expect(await seed.seedServer("alice", "current")).toBe("server")
    await seed.seedJoinServer("alice", "bob", "server")
    joinError = "Invalid or expired invite"
    await expect(seed.seedJoinServer("alice", "bob", "server")).rejects.toThrow("Invalid or expired invite")
    await seed.retireSeedServers("alice", ["server"])
    expect(h.accepted.map(request => request.method)).toEqual(["POST", "POST", "POST", "POST", "POST", "DELETE"])
    expect(h.accepted.every(request => request.headers.get(COMMUNITY_CONTRACT_HEADER) === String(BUSINESS_SCHEMA_VERSION))).toBe(true)
  })
})

describe("stock caller isolated serialized execution", () => {
  async function evaluateCallback(file: string, fragment: string) {
    const { readFileSync } = await import("node:fs")
    const ts = await import("typescript")
    const { runInNewContext } = await import("node:vm")
    const source = readFileSync(new URL(`./e2e-ui/${file}`, import.meta.url), "utf8")
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    let callback = ""
    function visit(node: import("typescript").Node) {
      if (ts.isCallExpression(node) && /\.evaluate$/.test(node.expression.getText(ast)) && node.arguments[0]?.getText(ast).includes(fragment)) {
        callback = node.arguments[0].getText(ast)
        expect(node.arguments[1]?.getText(ast)).toContain("businessHeaders: CURRENT_COMMUNITY_FIXTURE_HEADERS")
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    expect(callback).not.toBe("")
    return (fetchImpl: typeof fetch) => runInNewContext(ts.transpileModule(`(${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { fetch: fetchImpl, Headers }) as (arg: unknown) => Promise<number>
  }
  it.each([
    { file: "29-multi-device-read-state.spec.ts", fragment: "/channels/${channelId}/messages", arg: { channelId: "channel", content: "test" }, method: "POST" },
    { file: "29-multi-device-read-state.spec.ts", fragment: "/notifications/channel/${channelId}", arg: { value: "channel" }, method: "PUT" },
    { file: "27-canonical-forum-post-delete.spec.ts", fragment: "/messages/${openerId}", arg: { value: "message" }, method: "DELETE" },
  ])("executes the actual $method callback in $file without module-scope globals", async ({ file, fragment, arg, method }) => {
    const { CURRENT_COMMUNITY_FIXTURE_HEADERS } = await import("./e2e-ui/_fixtures/business-contract")
    const factory = await evaluateCallback(file, fragment)
    let version = BUSINESS_SCHEMA_VERSION as number
    const fetchImpl = vi.fn(async (_path: string | URL | Request, _options?: RequestInit) => Response.json({ ok: true }, { status: 201, headers: { [COMMUNITY_CONTRACT_HEADER]: String(version) } }))
    const callback = factory(fetchImpl)
    expect(await callback({ ...arg, businessHeaders: CURRENT_COMMUNITY_FIXTURE_HEADERS })).toBe(201)
    expect(fetchImpl.mock.calls[0][1]?.method).toBe(method)
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    version--
    await expect(callback({ ...arg, businessHeaders: CURRENT_COMMUNITY_FIXTURE_HEADERS })).rejects.toThrow("did not confirm current business version")
  })
  it("qualifies current Playwright responses and preserves original failed status", async () => {
    const { confirmCommunityFixtureApiResponse, CURRENT_COMMUNITY_FIXTURE_HEADERS } = await import("./e2e-ui/_fixtures/business-contract")
    const good = { ok: () => true, headers: () => CURRENT_COMMUNITY_FIXTURE_HEADERS }
    expect(await confirmCommunityFixtureApiResponse(Promise.resolve(good))).toBe(good)
    await expect(confirmCommunityFixtureApiResponse(Promise.resolve({ ok: () => true, headers: () => ({}) }))).rejects.toThrow("did not confirm current business version")
    const failed = { ok: () => false, headers: () => ({}) }
    expect(await confirmCommunityFixtureApiResponse(Promise.resolve(failed))).toBe(failed)
  })
  it("confirms only the case-insensitive contract header when Playwright merges response cookies", async () => {
    const { confirmCommunityFixtureApiResponse } = await import("./e2e-ui/_fixtures/business-contract")
    const good = { ok: () => true, headers: () => ({
      [COMMUNITY_CONTRACT_HEADER.toUpperCase()]: String(BUSINESS_SCHEMA_VERSION),
      "set-cookie": "fixture-a=value-a; Path=/\nfixture-b=value-b; Path=/",
    }) }
    expect(await confirmCommunityFixtureApiResponse(Promise.resolve(good))).toBe(good)
    for (const version of [String(BUSINESS_SCHEMA_VERSION - 1), String(BUSINESS_SCHEMA_VERSION + 1)]) {
      await expect(confirmCommunityFixtureApiResponse(Promise.resolve({ ...good, headers: () => ({ [COMMUNITY_CONTRACT_HEADER.toLowerCase()]: version }) })))
        .rejects.toThrow("did not confirm current business version")
    }
  })
  it("admits current notification frames in wire order while retaining exact rejected raw frames", async () => {
    const { EventEmitter } = await import("node:events")
    const { captureNotificationRequests } = await import("./e2e-ui/_fixtures/community-notification-requests")
    const { encodeCommunityBrowserEvent, encodeCommunityBrowserEventBatch, prepareCommunityDeliveryEvents } = await import("@alook/shared")
    const { communityWsEventFixtures } = await import("../../../shared/test/community-ws-events.fixtures")
    const page = new EventEmitter()
    const socket = new EventEmitter()
    const trace = captureNotificationRequests(page as unknown as Parameters<typeof captureNotificationRequests>[0])
    page.emit("websocket", socket)
    const before = communityWsEventFixtures["community:presence.update"]
    const children = [communityWsEventFixtures["community:reaction.remove"], communityWsEventFixtures["community:channel.delete"]]
    const after = communityWsEventFixtures["community:identity.update"]
    const first = encodeCommunityBrowserEvent(before), last = encodeCommunityBrowserEvent(after)
    const prepared = await prepareCommunityDeliveryEvents(children)
    if (!first.ok || !last.ok || !prepared.ok) throw new Error("Current notification fixtures did not encode")
    const batch = await encodeCommunityBrowserEventBatch({ events: children, operationId: `message:${"a".repeat(43)}`, operationDigest: prepared.prepared.digest })
    if (!batch.ok) throw new Error("Current notification batch did not encode")
    const raw = [first.body, batch.body, last.body, JSON.stringify(before),
      JSON.stringify({ ...batch.batch, type: "community:events.batch.v2" }),
      JSON.stringify({ ...batch.batch, wireDigest: "0".repeat(64) }), "{"]
    trace.phase("wire")
    for (const payload of raw) socket.emit("framereceived", { payload })
    trace.phase("after-wire")
    await trace.framesSettled()
    expect(trace.rawFrames).toEqual(raw)
    expect(trace.events).toEqual([before, ...children, after])
    expect(trace.timeline.filter(item => item.kind === "event").every(item => item.phase === "wire")).toBe(true)
    expect(trace.timeline.filter(item => item.kind === "event").map(item => item.type)).toEqual([before, ...children, after].map(event => event.type))
  })

  it("uses an actual current error body for stock retry faults", async () => {
    const { currentCommunityFixtureError } = await import("./e2e-ui/_fixtures/business-contract")
    const { apiFetch } = await import("@/lib/api/client")
    const fault = currentCommunityFixtureError("forced controlled retry", 400)
    vi.stubGlobal("fetch", vi.fn(async () => new Response(fault.body, { status: fault.status, headers: { ...fault.headers, "Content-Type": fault.contentType } })))
    await expect(apiFetch("/api/community/billing")).rejects.toMatchObject({ name: "ApiError", status: 400, message: "forced controlled retry" })
  })
})
