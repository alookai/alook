import handler, { DOQueueHandler } from "../../custom-worker"
import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => vi.unstubAllEnvs())

describe("custom Worker composition", () => {
  it("composes the generated OpenNext module with the production runtime seam", async () => {
    const wsFetch = vi.fn(async () => new Response("ws"))
    const env = { WS_DO_WORKER: { fetch: wsFetch } } as unknown as CloudflareEnv

    const response = await handler.fetch!(
      new Request("https://worker.test/pricing"),
      env,
      {} as ExecutionContext,
    )

    expect(DOQueueHandler).toBeDefined()
    expect(await response.text()).toBe("node-open-next")
    expect(response.headers.get("x-open-next")).toBe("node-stub")
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate")
    expect(wsFetch).not.toHaveBeenCalled()
  })

  it("uses the resolved Next build provenance on the first request before OpenNext initializes process.env", async () => {
    vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", "b".repeat(40))
    vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", "production")
    const setAttribute = vi.fn()
    const enterSpan = vi.fn((_name: string, run: (span: unknown) => unknown) => run({ setAttribute }))
    const response = await handler.fetch!(new Request("https://worker.test/c/me?_rsc=PRIVATE"),
      { CF_VERSION_METADATA: { id: "actual-worker-version" } } as unknown as CloudflareEnv,
      { tracing: { enterSpan } } as unknown as ExecutionContext)
    expect(response.headers.get("x-open-next")).toBe("node-stub")
    expect(enterSpan.mock.calls[0]?.[0]).toBe("web.request")
    expect(Object.fromEntries(setAttribute.mock.calls)).toMatchObject({ release: "a".repeat(40), environment: "qa", worker_version: "actual-worker-version", request_kind: "rsc" })
    expect(JSON.stringify(setAttribute.mock.calls)).not.toContain("PRIVATE")
    expect(JSON.stringify(setAttribute.mock.calls)).not.toContain("b".repeat(40))
  })
})
