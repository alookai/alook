import { describe, expect, it, vi } from "vitest"
import {
  consumeFirstSignupGuideHandoff,
  readFirstSignupGuideHandoff,
  writeFirstSignupGuideHandoff,
} from "./first-signup-guide"

function storage(initial?: string) {
  let value = initial ?? null
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next }),
    removeItem: vi.fn(() => { value = null }),
  }
}

describe("first-signup guide handoff", () => {
  it("writes a versioned one-shot handoff with a stable avatar seed", () => {
    const target = storage()

    const written = writeFirstSignupGuideHandoff(target, 1_000, "signup-id")

    expect(written).toEqual({
      version: 1,
      seed: "alook-guide-signup-id",
      createdAt: 1_000,
    })
    expect(readFirstSignupGuideHandoff(target, 1_001)).toEqual(written)
  })

  it.each([
    ["malformed", "not-json"],
    ["wrong version", JSON.stringify({ version: 2, seed: "seed", createdAt: 1_000 })],
    ["empty seed", JSON.stringify({ version: 1, seed: "", createdAt: 1_000 })],
    ["expired", JSON.stringify({ version: 1, seed: "seed", createdAt: 1_000 })],
  ])("removes a %s handoff", (_label, value) => {
    const target = storage(value)
    const now = value.includes('"seed":"seed"') ? 1_000 + 10 * 60 * 1000 + 1 : 1_001

    expect(readFirstSignupGuideHandoff(target, now)).toBeNull()
    expect(target.removeItem).toHaveBeenCalledOnce()
  })

  it("consumes only the matching handoff", () => {
    const target = storage(JSON.stringify({ version: 1, seed: "same", createdAt: 1_000 }))

    consumeFirstSignupGuideHandoff("different", target)
    expect(target.removeItem).not.toHaveBeenCalled()

    consumeFirstSignupGuideHandoff("same", target)
    expect(target.removeItem).toHaveBeenCalledOnce()
    expect(readFirstSignupGuideHandoff(target, 1_001)).toBeNull()
  })

  it("fails closed when browser storage is unavailable", () => {
    expect(writeFirstSignupGuideHandoff(null, 1_000, "id")).toBeNull()
    expect(readFirstSignupGuideHandoff(null, 1_000)).toBeNull()
    expect(() => consumeFirstSignupGuideHandoff("seed", null)).not.toThrow()
  })
})
