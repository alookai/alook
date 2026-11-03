import { describe, expect, it } from "vitest"
import { resolveBotCreationConfiguration } from "./community-bot-creation"

const machine = { id: "machine", status: "online" }
const backends = ["qoder", "copilot", "cursor-sdk", "pi-durable"]

describe("new backend creation configuration", () => {
  it.each(backends)("preserves the reported %s model and effort", (backendId) => {
    const runtime = { id: backendId, status: "healthy" as const, reasoning: { updateMode: "unsupported" as const, models: [{ id: "provider/model", supportedReasoningEfforts: [{ value: "high" }] }] } }
    expect(resolveBotCreationConfiguration(machine, runtime, { backendId, model: "provider/model", reasoningEffort: "high" }).supported).toBe(true)
    expect(() => resolveBotCreationConfiguration(machine, runtime, { backendId, model: "provider/model", reasoningEffort: "invalid" })).toThrow("not supported")
    expect(() => resolveBotCreationConfiguration(machine, { ...runtime, status: "unhealthy" }, { backendId, model: "provider/model" })).toThrow("currently unavailable")
  })
  it.each([null, "", "   "])("rejects Pi Durable without a model: %s", (model) => {
    expect(() => resolveBotCreationConfiguration(machine, { id: "pi-durable", status: "healthy" }, { backendId: "pi-durable", model })).toThrow("Choose a model before saving")
  })
  it.each(["qoder", "copilot", "cursor-sdk", "codex"])("keeps %s native defaults", (backendId) => {
    expect(resolveBotCreationConfiguration(machine, { id: backendId, status: "healthy" }, { backendId }).supported).toBe(true)
  })
})
