import { expect, it } from "vitest"
import { resolveTransportProfile } from "./transport-profile"

it("selects only explicit loopback development endpoints and never duplicates the production sink", () => {
  const collector = "https://collector.example/collect/public"
  expect(resolveTransportProfile("development", "http://127.0.0.1:14318", collector)).toEqual({ kind: "otlp", urls: ["http://127.0.0.1:14318/v1/traces", "http://127.0.0.1:14318/v1/logs"] })
  expect(resolveTransportProfile("production", "http://127.0.0.1:14318", collector)).toEqual({ kind: "faro", urls: [collector] })
  expect(resolveTransportProfile("test", undefined, collector)?.kind).toBe("faro")
  for (const endpoint of ["http://evil.example:4318", "http://127.0.0.1.evil:4318", "https://localhost:4318", "http://localhost", "http://localhost:4318/v1", "http://user@localhost:4318", "http://localhost:4318/?token=private", "malformed"]) expect(resolveTransportProfile("development", endpoint, collector)).toBeUndefined()
  for (const collector of [undefined, "http://localhost:4318", "https://user:password@collector.example", "https://collector.example?key=secret"]) expect(resolveTransportProfile("production", "http://localhost:4318", collector)).toBeUndefined()
})
