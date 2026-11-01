import { describe, expect, it } from "vitest"
import { PiiCommandSchema, PiiLocalRequestSchema, PiiResultFrameSchema } from "../src/pii-contract"

describe("PII preview contract", () => {
  const command = { type: "pii:manage", botId: "bot", requestId: "request", operation: { action: "preview", text: "test input", expectedRevision: 0 } }
  it("requires a captured revision, bounds UTF-8 and exposes no preview through the agent local API", () => {
    expect(PiiCommandSchema.safeParse(command).success).toBe(true)
    expect(PiiLocalRequestSchema.safeParse(command.operation).success).toBe(false)
    for (const operation of [{ ...command.operation, text: "中".repeat(400) }, { ...command.operation, text: " " }, { action: "preview", text: "test" }, { ...command.operation, source: "private code" }]) {
      expect(PiiCommandSchema.safeParse({ ...command, operation }).success).toBe(false)
    }
  })
  it("bounds preview output and error metadata without accepting original exception fields", () => {
    const frame = { type: "pii_result", botId: "bot", requestId: "request", result: { status: "complete", snapshot: { revision: 3, plugins: [] }, output: "filtered output" } }
    expect(PiiResultFrameSchema.safeParse(frame).success).toBe(true)
    for (const output of ["", " ", "中".repeat(400)]) expect(PiiResultFrameSchema.safeParse({ ...frame, result: { ...frame.result, output } }).success).toBe(false)
    expect(PiiResultFrameSchema.safeParse({ ...frame, result: { status: "error", code: "PII_PLUGIN_FAILED", pluginId: "plugin" } }).success).toBe(true)
    expect(PiiResultFrameSchema.safeParse({ ...frame, result: { status: "error", code: "PII_PLUGIN_FAILED", message: "original exception" } }).success).toBe(false)
  })
})

it("preserves bounded matched-filter metadata and accepts legacy responses", () => {
  const result = { status: "complete", snapshot: { revision: 1, plugins: [] }, output: "filtered" }
  const frame = { type: "pii_result", botId: "bot", requestId: "req", result }
  const triggeredFilters = [{ id: "email", name: "Email addresses" }]
  expect(PiiResultFrameSchema.parse({ ...frame, result: { ...result, triggeredFilters } }).result).toMatchObject({ triggeredFilters })
  expect(PiiResultFrameSchema.safeParse(frame).success).toBe(true)
  expect(PiiResultFrameSchema.safeParse({ ...frame, result: { ...result, triggeredFilters: [] } }).success).toBe(true)
  for (const invalid of [[{ id: "email", name: "" }], Array(33).fill(triggeredFilters[0]), [{ ...triggeredFilters[0], source: "secret" }]]) {
    expect(PiiResultFrameSchema.safeParse({ ...frame, result: { ...result, triggeredFilters: invalid } }).success).toBe(false)
  }
})
