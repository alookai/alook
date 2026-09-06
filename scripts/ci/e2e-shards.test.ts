import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  createE2eMatrix,
  DEFAULT_SPEC_SECONDS,
  discoverE2eSpecs,
  E2E_FIXED_SETUP_SECONDS,
  E2E_SAFETY_MARGIN_SECONDS,
  E2E_SHARD_BUDGET_SECONDS,
  E2E_SPEC_BUDGET_SECONDS,
  planE2eShards,
  resolvePlaywrightImage,
  resolvePlaywrightVersion,
  runCli,
  SPEC_SECONDS,
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
    const specSeconds = first.map((shard) => shard.spec_seconds)
    const predictedSeconds = first.map((shard) => shard.predicted_seconds)

    expect(first).toEqual(second)
    expect(Object.keys(SPEC_SECONDS).sort()).toEqual(specs)
    expect(first).toHaveLength(9)
    expect([...assigned].sort()).toEqual(specs)
    expect(new Set(assigned).size).toBe(specs.length)
    expect(specSeconds).toEqual([
      147.775, 147.715, 147.351, 148.789, 146.004, 147.401, 148.302, 147.005, 147.628,
    ])
    expect(predictedSeconds).toEqual([
      222.775, 222.715, 222.351, 223.789, 221.004, 222.401, 223.302, 222.005, 222.628,
    ])
    expect(first.every((shard) => (
      shard.fixed_setup_seconds === E2E_FIXED_SETUP_SECONDS
      && shard.safety_margin_seconds === E2E_SAFETY_MARGIN_SECONDS
      && shard.predicted_seconds
        === shard.spec_seconds + E2E_FIXED_SETUP_SECONDS + E2E_SAFETY_MARGIN_SECONDS
    ))).toBe(true)
    expect(Math.max(...predictedSeconds)).toBeLessThanOrEqual(E2E_SHARD_BUDGET_SECONDS)
    expect(first).toHaveLength(
      Math.ceil(specSeconds.reduce((total, seconds) => total + seconds, 0)
        / E2E_SPEC_BUDGET_SECONDS),
    )
  })

  it("includes an unknown spec with a conservative default weight", () => {
    const shards = planE2eShards(["known.spec.ts", "new.spec.ts"], {
      weights: { "known.spec.ts": 5 },
    })

    expect(shards.flatMap((shard) => shard.files).sort()).toEqual([
      "known.spec.ts",
      "new.spec.ts",
    ])
    expect(DEFAULT_SPEC_SECONDS).toBe(E2E_SPEC_BUDGET_SECONDS)
    expect(shards.find((shard) => shard.files.includes("new.spec.ts"))?.files)
      .toEqual(["new.spec.ts"])
    expect(shards.map((shard) => shard.spec_seconds).sort((a, b) => a - b))
      .toEqual([5, E2E_SPEC_BUDGET_SECONDS])
    expect(shards.map((shard) => shard.predicted_seconds).sort((a, b) => a - b))
      .toEqual([80, E2E_SHARD_BUDGET_SECONDS])
  })

  it("increments the total-time lower bound when LPT does not fit", () => {
    const weights = {
      "a.spec.ts": 3,
      "b.spec.ts": 3,
      "c.spec.ts": 2,
      "d.spec.ts": 2,
      "e.spec.ts": 2,
    }
    const shards = planE2eShards(Object.keys(weights), {
      weights,
      budgetSeconds: 6,
      fixedSetupSeconds: 0,
      safetyMarginSeconds: 0,
    })

    expect(Math.ceil(12 / 6)).toBe(2)
    expect(shards).toHaveLength(3)
    expect(shards.every((shard) => shard.spec_seconds <= 6)).toBe(true)
  })

  it("rejects duplicate or empty paths and invalid planning values", () => {
    expect(() => planE2eShards(["a.spec.ts", "a.spec.ts"])).toThrow("unique")
    expect(() => planE2eShards([])).toThrow("at least one")
    expect(() => planE2eShards([""])).toThrow("non-empty strings")
    expect(() => planE2eShards(["a.spec.ts"], { budgetSeconds: 0 }))
      .toThrow("positive spec budget")
    expect(() => planE2eShards(["a.spec.ts"], { defaultSeconds: Number.NaN }))
      .toThrow("positive finite")
    expect(() => planE2eShards(["a.spec.ts"], { weights: { "a.spec.ts": 0 } }))
      .toThrow("positive finite")
    expect(() => planE2eShards(["a.spec.ts"], { fixedSetupSeconds: Number.NaN }))
      .toThrow("non-negative finite")
    expect(() => planE2eShards(["a.spec.ts"], { safetyMarginSeconds: -1 }))
      .toThrow("non-negative finite")
  })

  it("requires an oversized spec to be split or given a stable case manifest", () => {
    expect(() => planE2eShards(["slow.spec.ts"], {
      weights: { "slow.spec.ts": E2E_SPEC_BUDGET_SECONDS + 0.001 },
    })).toThrow("split the spec or add a stable case manifest")
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
    expect(matrix.include).toHaveLength(1)
    expect(matrix.include.every((entry) => entry.total === 1)).toBe(true)
    expect(matrix.include[0]).toMatchObject({
      spec_seconds: 46.383,
      fixed_setup_seconds: 60,
      safety_margin_seconds: 15,
      predicted_seconds: 121.383,
    })
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
      spec_seconds: 5.485,
      fixed_setup_seconds: 60,
      safety_margin_seconds: 15,
      predicted_seconds: 80.485,
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

  it("rejects the all sentinel when combined with explicit specs", () => {
    expect(() => createE2eMatrix(["all", "54-blog-multizone.spec.ts"]))
      .toThrow("all sentinel")
  })
})

describe("E2E shard CLI", () => {
  it("writes an explicit matrix and human-readable summary", () => {
    const directory = mkdtempSync(join(tmpdir(), "alook-e2e-cli-"))
    const output = join(directory, "output")
    const summary = join(directory, "summary.md")
    try {
      runCli([
        "--specs-json", JSON.stringify(["54-blog-multizone.spec.ts"]),
        "--output", output,
        "--summary", summary,
      ])

      expect(readFileSync(output, "utf8")).toContain(
        "src/test/e2e-ui/54-blog-multizone.spec.ts",
      )
      expect(readFileSync(summary, "utf8")).toContain(
        "| 1/1 | 5.485s | 60s | 15s | 80.485s |",
      )
      expect(readFileSync(summary, "utf8")).toContain(
        "Predicted Playwright command step; 240s budget per shard",
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("prints the default live inventory without an output file", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      runCli([])

      const matrix = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join(""))
      expect(matrix.include.flatMap((entry: { specs: string[] }) => entry.specs))
        .toHaveLength(discoverE2eSpecs().length)
    } finally {
      stdout.mockRestore()
    }
  })

  it("rejects malformed specs JSON values", () => {
    expect(() => runCli(["--specs-json", JSON.stringify({ spec: "54-blog-multizone.spec.ts" })]))
      .toThrow("JSON array")
    expect(() => runCli(["--specs-json", JSON.stringify([42])]))
      .toThrow("JSON array")
  })
})
