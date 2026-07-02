import { describe, it, expect, vi } from "vitest"

// The DO module imports cloudflare:workers and @alook/shared; stub both so we
// can pull in parseRuntimes without dragging the rest of the runtime in.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}))

vi.mock("@alook/shared", () => {
  const noop = () => {}
  const noopLogger = { debug: noop, info: noop, warn: noop, error: noop, child: () => noopLogger }
  return {
    createDb: () => ({}),
    createLogger: () => noopLogger,
    queries: {},
    COMMUNITY_MACHINE_HEARTBEAT_MS: 1000,
    COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS: 1000,
  }
})

import { parseRuntimes } from "./ws-durable"

describe("parseRuntimes — runtimeReport input", () => {
  it("returns parsed list with id + version", () => {
    expect(
      parseRuntimes({
        runtimeReport: [
          { id: "claude", version: "1.0.42" },
          { id: "codex", version: "0.8.1" },
        ],
      })
    ).toEqual([
      { id: "claude", version: "1.0.42" },
      { id: "codex", version: "0.8.1" },
    ])
  })

  it("drops the version field when oversize but keeps the entry", () => {
    const longVersion = "x".repeat(200)
    expect(parseRuntimes({ runtimeReport: [{ id: "claude", version: longVersion }] })).toEqual([
      { id: "claude" },
    ])
  })

  it("dedups duplicate ids, keeping the first occurrence", () => {
    expect(
      parseRuntimes({
        runtimeReport: [
          { id: "claude" },
          { id: "claude", version: "2" },
        ],
      })
    ).toEqual([{ id: "claude" }])
  })

  it("truncates oversize lists at 64", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` }))
    const out = parseRuntimes({ runtimeReport: items })
    expect(out).toHaveLength(64)
    expect(out[0]).toEqual({ id: "r0" })
    expect(out[63]).toEqual({ id: "r63" })
  })

  it("skips malformed per-entry inputs", () => {
    const out = parseRuntimes({
      runtimeReport: [
        { id: "" },
        { id: 123 },
        { id: "a".repeat(200) },
        { id: "bad id!" },
        { id: "claude" },
      ],
    })
    expect(out).toEqual([{ id: "claude" }])
  })

  it("permits valid id character classes", () => {
    const ids = ["claude", "kimi", "vendor.cli", "vendor/cli", "@vendor/cli", "cli_v2"]
    const out = parseRuntimes({ runtimeReport: ids.map((id) => ({ id })) })
    expect(out.map((r) => r.id)).toEqual(ids)
  })
})

describe("parseRuntimes — legacy runtimes input", () => {
  it("maps a string array through the same validator", () => {
    expect(parseRuntimes({ runtimes: ["claude", "codex"] })).toEqual([
      { id: "claude" },
      { id: "codex" },
    ])
  })
  it("rejects bad entries in the legacy path", () => {
    expect(parseRuntimes({ runtimes: ["claude", "bad id!", ""] })).toEqual([
      { id: "claude" },
    ])
  })
})

describe("parseRuntimes — absent / malformed top-level", () => {
  it("returns [] when neither field is provided", () => {
    expect(parseRuntimes({})).toEqual([])
  })
  it("returns [] when runtimeReport is a string", () => {
    expect(parseRuntimes({ runtimeReport: "claude" as unknown as never })).toEqual([])
  })
  it("returns [] when runtimeReport is a number", () => {
    expect(parseRuntimes({ runtimeReport: 42 as unknown as never })).toEqual([])
  })
  it("returns [] when runtimeReport is an object (non-array)", () => {
    expect(parseRuntimes({ runtimeReport: { id: "claude" } as unknown as never })).toEqual([])
  })
})
