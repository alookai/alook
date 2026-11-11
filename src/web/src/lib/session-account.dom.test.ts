import { expect, it, vi } from "vitest"
import { waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { serversProjectedQueryFn } from "@/hooks/community/use-servers"
import { communityKeys } from "@/lib/query-keys"
import { serverRailResponseFixture } from "@/test/community-resource-fixtures"
import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION } from "@alook/shared"
import { createSessionTransport } from "./session-transport"
import { SESSION_ACCOUNT_HEADER, SESSION_ACCOUNT_MISMATCH_HEADER } from "./session-account"

it.each(["A", "B"])("qualifies queued A servers publication when cookie identity becomes %s before SDK publication", async nextAccount => {
  const { client, registry } = await createCommunityQueryOwner("A")
  let releaseHeaders!: () => void
  const held = new Promise<void>(resolve => { releaseHeaders = resolve })
  const native = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    if (String(input).endsWith("/sign-in/email")) {
      await held
      return Response.json({ user: { id: nextAccount } })
    }
    expect(String(input)).toBe("/api/community/servers")
    expect(new Headers(init?.headers).get(SESSION_ACCOUNT_HEADER)).toBe("A")
    // The server-policy tests independently prove this rejection occurs before
    // business code. Here the actual API/query/projection consumes its response.
    if (nextAccount !== "A") return Response.json({ error: "account changed" }, { status: 409, headers: { [SESSION_ACCOUNT_MISMATCH_HEADER]: "1" } })
    return Response.json(serverRailResponseFixture({ servers: [{ id: "only-A-server", name: "A server", ownerId: "A" }] }, "A"), { headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_CONTRACT_VERSION) } })
  })
  const transport = createSessionTransport(native, "http://localhost:3000")
  vi.stubGlobal("fetch", transport.fetch)
  try {
    const identity = transport.fetch("/api/auth/sign-in/email", { method: "POST" })
    await waitFor(() => expect(native).toHaveBeenCalledTimes(1))
    const read = client.query({ queryKey: communityKeys.servers(), queryFn: serversProjectedQueryFn(client), staleTime: 0 }).catch(error => error)
    await Promise.resolve()
    expect(native).toHaveBeenCalledTimes(1)
    releaseHeaders()
    await identity
    if (nextAccount === "B") {
      expect(await read).toMatchObject({ name: "AbortError" })
      expect(client.getQueryData(communityKeys.servers())).toBeUndefined()
      expect(registry.collections.servers.size).toBe(0)
    } else {
      expect(await read).toEqual(["only-A-server"])
      expect(registry.collections.servers.get("only-A-server")).toMatchObject({ ownerId: "A" })
    }
    expect(registry.sessionViewer()).toBe("A")
  } finally { vi.unstubAllGlobals() }
})
