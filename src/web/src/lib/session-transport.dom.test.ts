import { afterEach, expect, it, vi } from "vitest"

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it("fences an SDK created before installation and resumes its real get-session transport", async () => {
  const backend = vi.fn<typeof fetch>().mockResolvedValue(Response.json(null))
  vi.stubGlobal("fetch", backend)
  const { authClient } = await import("./auth-session")
  const { installSessionTransport, beginSessionSignOut } = await import("./session-transport")
  installSessionTransport()
  const lease = beginSessionSignOut(() => {})
  await expect(authClient.getSession()).rejects.toMatchObject({ name: "AbortError" })
  expect(backend).not.toHaveBeenCalled()
  lease.release()
  expect((await authClient.getSession()).data).toBeNull()
  expect(backend).toHaveBeenCalledOnce()
})
