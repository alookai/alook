import { describe, it, expect, vi } from "vitest"
import { forceCloseCommunityMachine } from "./machine-disconnect"

describe("forceCloseCommunityMachine", () => {
  it("posts /community-machine/<token>/force-close via WS_DO_WORKER", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ closed: 1 }), { status: 200 })
    )
    const env = {
      WS_DO_WORKER: { fetch: fetchMock },
    } as unknown as Env
    await forceCloseCommunityMachine(env, "cmt_abc")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("http://internal/community-machine/cmt_abc/force-close")
    expect(init?.method).toBe("POST")
  })

  it("url-encodes the token segment", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("ok", { status: 200 })
    )
    const env = { WS_DO_WORKER: { fetch: fetchMock } } as unknown as Env
    await forceCloseCommunityMachine(env, "cmt_with/slash")
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://internal/community-machine/cmt_with%2Fslash/force-close"
    )
  })
})
