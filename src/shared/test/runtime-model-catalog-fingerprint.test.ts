import { expect, it } from "vitest"
import { fingerprintRuntimeModelCatalog } from "../src/runtime-models-contract"
import type { RuntimeReasoningCatalog } from "../src/runtime-config"
it("compares catalog data independently of object key insertion order", async () => {
  const first: RuntimeReasoningCatalog = { updateMode: "unsupported", defaultModelId: "a", models: [{ id: "a", supportedReasoningEfforts: [{ value: "high", description: "More" }] }] }
  const second: RuntimeReasoningCatalog = { models: [{ supportedReasoningEfforts: [{ description: "More", value: "high" }], id: "a" }], defaultModelId: "a", updateMode: "unsupported" }
  expect(await fingerprintRuntimeModelCatalog(first)).toMatch(/^[a-f0-9]{64}$/)
  expect(await fingerprintRuntimeModelCatalog(first)).toBe(await fingerprintRuntimeModelCatalog(second))
  expect(await fingerprintRuntimeModelCatalog({ ...first, defaultModelId: "b" })).not.toBe(await fingerprintRuntimeModelCatalog(first))
})
it("distinguishes missing catalogs, reported-empty catalogs and model/effort changes", async () => {
  const empty: RuntimeReasoningCatalog = { updateMode: "unsupported", models: [] }
  const model: RuntimeReasoningCatalog = { ...empty, models: [{ id: "a", supportedReasoningEfforts: [] }] }
  const effort: RuntimeReasoningCatalog = { ...empty, models: [{ id: "a", supportedReasoningEfforts: [{ value: "high" }] }] }
  const hashes = await Promise.all([null, empty, model, effort].map(fingerprintRuntimeModelCatalog))
  expect(new Set(hashes).size).toBe(4)
})
