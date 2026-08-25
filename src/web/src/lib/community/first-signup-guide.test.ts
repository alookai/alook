import { afterEach, describe, expect, it, vi } from "vitest"
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
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

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

  it("fails closed outside a browser when storage is not provided", () => {
    expect(writeFirstSignupGuideHandoff(undefined, 1_000, "id")).toBeNull()
    expect(readFirstSignupGuideHandoff(undefined, 1_000)).toBeNull()
    expect(() => consumeFirstSignupGuideHandoff("seed")).not.toThrow()
  })

  it("falls back to time and Math.random when crypto UUIDs are unavailable", () => {
    const target = storage()
    vi.stubGlobal("crypto", {})
    vi.spyOn(Math, "random").mockReturnValue(0.25)

    expect(writeFirstSignupGuideHandoff(target, 1_000)).toEqual({
      version: 1,
      seed: "alook-guide-1000-0.25",
      createdAt: 1_000,
    })
  })

  it("ignores an empty handoff when consuming", () => {
    const target = storage()

    expect(() => consumeFirstSignupGuideHandoff("seed", target)).not.toThrow()
    expect(target.removeItem).not.toHaveBeenCalled()
  })

  it("uses session storage when no storage override is provided", () => {
    const target = storage()
    vi.stubGlobal("window", { sessionStorage: target })

    expect(writeFirstSignupGuideHandoff(undefined, 1_000, "browser-id")).toEqual({
      version: 1,
      seed: "alook-guide-browser-id",
      createdAt: 1_000,
    })
    expect(readFirstSignupGuideHandoff(undefined, 1_001)?.seed).toBe("alook-guide-browser-id")
    consumeFirstSignupGuideHandoff("alook-guide-browser-id")
    expect(target.removeItem).toHaveBeenCalledOnce()
  })

  it("fails closed when session storage access throws", () => {
    vi.stubGlobal("window", {
      get sessionStorage() {
        throw new Error("storage disabled")
      },
    })

    expect(writeFirstSignupGuideHandoff(undefined, 1_000, "id")).toBeNull()
    expect(readFirstSignupGuideHandoff(undefined, 1_000)).toBeNull()
    expect(() => consumeFirstSignupGuideHandoff("seed")).not.toThrow()
  })

  it("fails closed when storage operations throw", () => {
    const writeFailure = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw new Error("write failed") }),
      removeItem: vi.fn(),
    }
    expect(writeFirstSignupGuideHandoff(writeFailure, 1_000, "id")).toBeNull()

    const readFailure = {
      getItem: vi.fn(() => { throw new Error("read failed") }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    expect(readFirstSignupGuideHandoff(readFailure, 1_000)).toBeNull()

    const consumeFailure = {
      getItem: vi.fn(() => "not-json"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    expect(() => consumeFirstSignupGuideHandoff("seed", consumeFailure)).not.toThrow()
    expect(consumeFailure.removeItem).toHaveBeenCalledOnce()
  })
})
