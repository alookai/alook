import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createE2eMatrix,
  discoverE2eSpecs,
  E2E_SHARD_COUNT,
  planE2eShards,
  resolvePlaywrightImage,
  resolvePlaywrightVersion,
} from "./e2e-shards.mjs"

describe("resolvePlaywrightVersion", () => {
  const lockfile = `
importers:

  src/web:
    devDependencies:
      '@playwright/test':
        specifier: ^1.62.1
        version: 1.62.1

  src/ws-do:
    dependencies: {}
`

  it("resolves the exact web importer version and official image", () => {
    expect(resolvePlaywrightVersion(lockfile)).toBe("1.62.1")
    expect(resolvePlaywrightVersion(lockfile.replaceAll("\n", "\r\n"))).toBe("1.62.1")
    expect(resolvePlaywrightImage(lockfile)).toBe(
      "mcr.microsoft.com/playwright:v1.62.1-noble",
    )
  })

  it("rejects missing importers, missing dependencies, and malformed versions", () => {
    expect(() => resolvePlaywrightVersion("importers:\n")).toThrow("src/web importer")
    expect(() => resolvePlaywrightVersion(lockfile.replace("'@playwright/test'", "vitest")))
      .toThrow("exact @playwright/test version")
    expect(() => resolvePlaywrightVersion(lockfile.replace("version: 1.62.1", "version: latest")))
      .toThrow("invalid @playwright/test version")
  })
})

describe("discoverE2eSpecs", () => {
  it("discovers nested specs in deterministic order", () => {
    const root = mkdtempSync(join(tmpdir(), "alook-e2e-specs-"))
    try {
      mkdirSync(join(root, "nested"))
      writeFileSync(join(root, "z.spec.ts"), "")
      writeFileSync(join(root, "nested", "a.spec.ts"), "")
      writeFileSync(join(root, "ignored.ts"), "")

      expect(discoverE2eSpecs(root)).toEqual(["nested/a.spec.ts", "z.spec.ts"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("planE2eShards", () => {
  it("assigns every spec exactly once with deterministic duration balance", () => {
    const specs = discoverE2eSpecs()
    const first = planE2eShards(specs)
    const second = planE2eShards([...specs].reverse())
    const assigned = first.flatMap((shard) => shard.files)
    const totals = first.map((shard) => shard.predicted_seconds)

    expect(first).toEqual(second)
    expect(first).toHaveLength(E2E_SHARD_COUNT)
    expect([...assigned].sort()).toEqual(specs)
    expect(new Set(assigned).size).toBe(specs.length)
    expect(totals.sort((left, right) => left - right)).toEqual([550, 551, 551, 553, 555])
    expect(Math.max(...totals) / Math.min(...totals)).toBeLessThanOrEqual(1.15)
  })

  it("includes an unknown spec with a conservative default weight", () => {
    const shards = planE2eShards(["known.spec.ts", "new.spec.ts"], 2, {
      "known.spec.ts": 5,
    }, 60)

    expect(shards.flatMap((shard) => shard.files).sort()).toEqual([
      "known.spec.ts",
      "new.spec.ts",
    ])
    expect(shards.map((shard) => shard.predicted_seconds).sort((a, b) => a - b)).toEqual([5, 60])
  })

  it("rejects duplicate paths and invalid shard counts", () => {
    expect(() => planE2eShards(["a.spec.ts", "a.spec.ts"])).toThrow("unique")
    expect(() => planE2eShards([])).toThrow("at least one")
    expect(() => planE2eShards(["a.spec.ts"], 0)).toThrow("positive integer")
  })
})

describe("createE2eMatrix", () => {
  it("emits shell-safe repo-local spec arguments", () => {
    const matrix = createE2eMatrix([
      "01-auth.spec.ts",
      "02-server-channel-message.spec.ts",
      "03-realtime-multiuser.spec.ts",
      "04-dm.spec.ts",
      "05-mention-bot.spec.ts",
    ])
    const argumentsList = matrix.include.flatMap((entry) => entry.specs)

    expect(argumentsList.sort()).toEqual([
      "src/test/e2e-ui/01-auth.spec.ts",
      "src/test/e2e-ui/02-server-channel-message.spec.ts",
      "src/test/e2e-ui/03-realtime-multiuser.spec.ts",
      "src/test/e2e-ui/04-dm.spec.ts",
      "src/test/e2e-ui/05-mention-bot.spec.ts",
    ])
    expect(matrix.include.every((entry) => entry.total === E2E_SHARD_COUNT)).toBe(true)
    expect(matrix.include.every(
      (entry) => entry.image === "mcr.microsoft.com/playwright:v1.62.1-noble",
    )).toBe(true)
  })

  it("creates one shard for the Blog contract and rejects specs outside inventory", () => {
    const matrix = createE2eMatrix(["54-blog-multizone.spec.ts"])

    expect(matrix.include).toHaveLength(1)
    expect(matrix.include[0]).toMatchObject({
      shard: 1,
      total: 1,
      predicted_seconds: 60,
      specs: ["src/test/e2e-ui/54-blog-multizone.spec.ts"],
    })
    expect(() => createE2eMatrix(["future.spec.ts"])).toThrow("inventory")
  })

  it("expands the all sentinel to the exact live inventory", () => {
    const matrix = createE2eMatrix(["all"])
    const assigned = matrix.include.flatMap((entry) => entry.specs)

    expect(assigned).toHaveLength(discoverE2eSpecs().length)
    expect(new Set(assigned).size).toBe(assigned.length)
  })
})
