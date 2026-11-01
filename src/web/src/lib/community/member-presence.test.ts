import { beforeEach, describe, expect, it, vi } from "vitest"
import { fetchOnlineUserIds } from "./member-presence"

const transport = vi.hoisted(() => vi.fn())
vi.mock("@/lib/broadcast", () => ({ wsDoFetch: transport }))
beforeEach(() => { transport.mockReset() })

const env = {} as Env
const requested = ["online-user", "offline-user", "unchecked-user"]
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } })

describe("CLI member online-id reads", () => {
  it("returns an empty Set without contacting upstream for an empty member page", async () => {
    expect(await fetchOnlineUserIds(env, [], "server")).toEqual(new Set())
    expect(transport).not.toHaveBeenCalled()
  })

  it("returns only confirmed requested online ids as a Set from one bulk read", async () => {
    transport.mockResolvedValueOnce(json({ online: ["online-user", "online-user"], offline: ["offline-user"] }))
    const result = await fetchOnlineUserIds(env, requested, "server")
    expect(result).toBeInstanceOf(Set)
    expect(result).toEqual(new Set(["online-user"]))
    expect(transport).toHaveBeenCalledExactlyOnceWith(env, "/presence/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: requested }),
    }, { label: "server" })
    expect(requested).toEqual(["online-user", "offline-user", "unchecked-user"])
  })

  it.each(["all offline", "no confirmed ids"] as const)("keeps the Set contract for %s", async scenario => {
    transport.mockResolvedValueOnce(json({ online: [], offline: scenario === "all offline" ? requested : [] }))
    expect(await fetchOnlineUserIds(env, requested, "server")).toEqual(new Set())
    expect(transport).toHaveBeenCalledOnce()
  })

  it.each(["non-OK", "network"] as const)("keeps the CLI result empty after an upstream %s failure", async failure => {
    if (failure === "non-OK") transport.mockResolvedValueOnce(new Response(null, { status: 503 }))
    else transport.mockRejectedValueOnce(new Error("Unavailable presence service"))
    expect(await fetchOnlineUserIds(env, requested, "server")).toEqual(new Set())
    expect(transport).toHaveBeenCalledOnce()
  })

  it.each(["invalid JSON", "missing offline", "conflicting ids", "unknown field"] as const)("does not admit online ids from %s", async invalid => {
    if (invalid === "invalid JSON") transport.mockResolvedValueOnce(new Response("invalid JSON"))
    else if (invalid === "missing offline") transport.mockResolvedValueOnce(json({ online: ["online-user"] }))
    else if (invalid === "conflicting ids") transport.mockResolvedValueOnce(json({ online: ["online-user"], offline: ["online-user"] }))
    else transport.mockResolvedValueOnce(json({ online: ["online-user"], offline: [], unexpected: true }))
    expect(await fetchOnlineUserIds(env, requested, "server")).toEqual(new Set())
  })

  it.each(["online", "offline"] as const)("rejects a bulk result with an unrequested %s id", async field => {
    transport.mockResolvedValueOnce(json(field === "online"
      ? { online: ["online-user", "outside-request"], offline: [] }
      : { online: ["online-user"], offline: ["outside-request"] }))
    expect(await fetchOnlineUserIds(env, requested, "server")).toEqual(new Set())
  })
})
