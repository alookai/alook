import { afterEach, expect, it, vi } from "vitest"
import { observeWorkerOperation } from "./worker"
import { resolveObservationBuild } from "./build"
import { createWebWorkerHandler, workerRequestAttributes } from "../worker-runtime"

const native = vi.hoisted(() => ({ tracing: undefined as ExecutionContext["tracing"] | undefined }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ ctx: { tracing: native.tracing } }) }))
afterEach(() => { native.tracing = undefined; vi.unstubAllEnvs() })

it("passes execution to native request spans and filters private attributes", async () => {
  const span = { setAttribute: vi.fn() }
  const enterSpan = vi.fn((_name: string, run: (span: unknown) => unknown) => run(span))
  native.tracing = { enterSpan } as unknown as ExecutionContext["tracing"]
  const value = Promise.resolve("same-result")
  expect(observeWorkerOperation("auth.get_session", { auth_instance: "reused", token: "PRIVATE" }, () => value)).toBe(value)
  expect(await value).toBe("same-result")
  expect(enterSpan).toHaveBeenCalledOnce()
  expect(span.setAttribute.mock.calls).toEqual([["auth_instance", "reused"]])
  native.tracing = undefined
  expect(observeWorkerOperation("auth.get_session", {}, () => value)).toBe(value)
})

it("records received trace context and actual Worker version without claiming a native parent", () => {
  const build = resolveObservationBuild({ NEXT_PUBLIC_FARO_RELEASE: "a".repeat(40), NEXT_PUBLIC_FARO_ENVIRONMENT: "qa" })
  const request = new Request("https://fixture.test/c/me?token=PRIVATE", { headers: { traceparent: `00-${"b".repeat(32)}-${"c".repeat(16)}-01`, tracestate: "PRIVATE" } })
  const fields = workerRequestAttributes(request, { CF_VERSION_METADATA: { id: "real-version" } } as Env, build)
  expect(fields).toMatchObject({ release: "a".repeat(40), environment: "qa", worker_version: "real-version", trace_context: "received", upstream_trace_id: "b".repeat(32), upstream_span_id: "c".repeat(16) })
  expect(fields).not.toHaveProperty("parent_span_id")
  expect(JSON.stringify(fields)).not.toContain("PRIVATE")
  for (const traceparent of ["bad", `00-${"0".repeat(32)}-${"c".repeat(16)}-01`]) {
    expect(workerRequestAttributes(new Request(request, { headers: { traceparent } }), {} as Env, build)).toMatchObject({ trace_context: "missing", worker_version_status: "missing", upstream_trace_id: undefined })
  }
})

it("uses explicit missing build provenance when the caller supplies no profile", async () => {
  vi.stubEnv("GITHUB_SHA", "a".repeat(40))
  vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", "production")
  const response = new Response("same-body")
  const fetch = vi.fn(async () => response)
  const setAttribute = vi.fn()
  const enterSpan = vi.fn((_name: string, execute: (span: unknown) => unknown) => execute({ setAttribute }))
  const handler = createWebWorkerHandler({ fetch })
  const returned = await handler.fetch!(new Request("https://fixture.test/c/me"), {} as CloudflareEnv,
    { tracing: { enterSpan } } as unknown as ExecutionContext)
  expect(returned).toBe(response)
  expect(await returned.text()).toBe("same-body")
  expect(fetch).toHaveBeenCalledOnce()
  expect(Object.fromEntries(setAttribute.mock.calls)).toMatchObject({ release_status: "missing", environment_status: "missing", worker_version_status: "missing" })
  expect(JSON.stringify(setAttribute.mock.calls)).not.toContain("a".repeat(40))
  expect(JSON.stringify(setAttribute.mock.calls)).not.toContain("production")
})
