import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createShardManifest,
  expectedMatrix,
  fetchExecutedShards,
  resolveExecutedShards,
  verifyArtifactClosure,
  verifyMergedReport,
} from "./e2e-shard-artifacts.mjs"

const matrix = {
  include: [
    { shard: 1, total: 2, specs: ["src/test/e2e-ui/a.spec.ts"] },
    { shard: 2, total: 2, specs: ["src/test/e2e-ui/b.spec.ts"] },
  ],
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function artifactRoot(attempts = [1, 2]) {
  const root = mkdtempSync(join(tmpdir(), "alook-shard-artifacts-"))
  roots.push(root)
  for (let shard = 1; shard <= 2; shard += 1) {
    const artifact = join(root, `blob-report-run-1-${shard}`)
    mkdirSync(join(artifact, "blob-report"), { recursive: true })
    mkdirSync(join(artifact, "e2e-shard-manifest"), { recursive: true })
    writeFileSync(join(artifact, "blob-report", `report-${shard}.zip`), `zip-${shard}`)
    writeFileSync(join(artifact, "e2e-shard-manifest", "shard-manifest.json"), JSON.stringify(
      createShardManifest({
        runId: "run-1",
        attempt: attempts[shard - 1],
        sha: "abc123",
        shard,
        total: 2,
        specs: matrix.include[shard - 1]!.specs,
      }),
    ))
  }
  return root
}

describe("expectedMatrix", () => {
  it("rejects duplicate cross-shard assignment", () => {
    expect(() => expectedMatrix({ include: [
      { shard: 1, total: 2, specs: ["src/test/e2e-ui/a.spec.ts"] },
      { shard: 2, total: 2, specs: ["src/test/e2e-ui/a.spec.ts"] },
    ] })).toThrow("assigned to shards")
  })
})

describe("resolveExecutedShards", () => {
  const jobs = [
    { name: "UI Playwright E2E (1/2)", started_at: "2026-08-25T17:02:50Z" },
    { name: "UI Playwright E2E (2/2)", started_at: "2026-08-25T17:13:26Z" },
    { name: "Merge Playwright Reports", started_at: "2026-08-25T17:19:19Z" },
  ]

  it("excludes carry-forward jobs older than run_started_at", () => {
    expect([...resolveExecutedShards({
      jobs,
      runStartedAt: "2026-08-25T17:13:19Z",
      expectedTotal: 2,
    })]).toEqual([2])
  })

  it("accepts a merge-only rerun with a complete carry-forward roster", () => {
    expect(resolveExecutedShards({
      jobs,
      runStartedAt: "2026-08-25T17:20:00Z",
      expectedTotal: 2,
    })).toEqual(new Set())
  })

  it("rejects an incomplete attempt job roster", () => {
    expect(() => resolveExecutedShards({
      jobs: [jobs[0]],
      runStartedAt: "2026-08-25T17:20:00Z",
      expectedTotal: 2,
    })).toThrow("attempt job roster is missing UI Playwright shards: 2")
  })

  it("rejects a shard outside the declared matrix range", () => {
    expect(() => resolveExecutedShards({
      jobs: [{ name: "UI Playwright E2E (3/2)", started_at: "2026-08-25T17:13:26Z" }],
      runStartedAt: "2026-08-25T17:13:19Z",
      expectedTotal: 2,
    })).toThrow("out-of-range shard")
  })

  it("fetches the run and paged attempt jobs with actions-read API semantics", async () => {
    const urls: string[] = []
    const fetchImpl = async (url: string) => {
      urls.push(url)
      return {
        ok: true,
        json: async () => url.includes("/jobs?")
          ? { jobs }
          : { run_attempt: 2, run_started_at: "2026-08-25T17:13:19Z" },
      } as Response
    }
    await expect(fetchExecutedShards({
      repository: "alookai/alook",
      runId: "run-1",
      attempt: 2,
      expectedTotal: 2,
      token: "redacted",
      fetchImpl,
      apiUrl: "https://example.invalid",
    })).resolves.toEqual(new Set([2]))
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain("/attempts/2/jobs?per_page=100&page=1")
  })
})

describe("verifyArtifactClosure", () => {
  it("accepts all previous-attempt artifacts for a merge-only rerun", () => {
    const root = artifactRoot([1, 1])
    const output = join(root, "..", `${root.split("/").at(-1)}-merged`)
    roots.push(output)
    const result = verifyArtifactClosure({
      root,
      output,
      matrix,
      runId: "run-1",
      attempt: 2,
      sha: "abc123",
      executedShards: new Set(),
    })
    expect(result.manifests.map((manifest) => manifest.attempt)).toEqual([1, 1])
    expect(readFileSync(join(output, "shard-1-report-1.zip"), "utf8")).toBe("zip-1")
    expect(readFileSync(join(output, "shard-2-report-2.zip"), "utf8")).toBe("zip-2")
  })

  it("accepts an older unexecuted shard and a fresh executed shard", () => {
    const root = artifactRoot([1, 2])
    const output = join(root, "..", `${root.split("/").at(-1)}-merged`)
    roots.push(output)
    const result = verifyArtifactClosure({
      root,
      output,
      matrix,
      runId: "run-1",
      attempt: 2,
      sha: "abc123",
      executedShards: new Set([2]),
    })
    expect(result.expectedSpecs).toEqual(["a.spec.ts", "b.spec.ts"])
    expect(readFileSync(join(output, "shard-2-report-2.zip"), "utf8")).toBe("zip-2")
  })

  it("fails when an executed shard still has the previous attempt manifest", () => {
    const root = artifactRoot([1, 1])
    expect(() => verifyArtifactClosure({
      root,
      output: join(root, "merged"),
      matrix,
      runId: "run-1",
      attempt: 2,
      sha: "abc123",
      executedShards: new Set([2]),
    })).toThrow("shard 2 executed in attempt 2 but artifact is stale from attempt 1")
  })

  it.each([
    ["wrong run ID", (manifest: any) => { manifest.runId = "wrong" }, "run ID mismatch"],
    ["wrong SHA", (manifest: any) => { manifest.sha = "wrong" }, "SHA mismatch"],
    ["wrong specs", (manifest: any) => { manifest.specs = ["unexpected.spec.ts"] }, "specs mismatch"],
  ])("rejects %s", (_, mutate, message) => {
    const root = artifactRoot([2, 2])
    const path = join(root, "blob-report-run-1-2", "e2e-shard-manifest", "shard-manifest.json")
    const manifest = JSON.parse(readFileSync(path, "utf8"))
    mutate(manifest)
    writeFileSync(path, JSON.stringify(manifest))
    expect(() => verifyArtifactClosure({
      root,
      output: join(root, "merged"),
      matrix,
      runId: "run-1",
      attempt: 2,
      sha: "abc123",
      executedShards: new Set([1, 2]),
    })).toThrow(message)
  })

  it("rejects a missing shard directory", () => {
    const root = artifactRoot([2, 2])
    rmSync(join(root, "blob-report-run-1-1"), { recursive: true })
    expect(() => verifyArtifactClosure({
      root,
      output: join(root, "merged"),
      matrix,
      runId: "run-1",
      attempt: 2,
      sha: "abc123",
      executedShards: new Set([1, 2]),
    })).toThrow("exactly match matrix shards")
  })

  it("rejects an unexpected shard directory", () => {
    const root = artifactRoot([2, 2])
    mkdirSync(join(root, "blob-report-run-1-3"))
    expect(() => verifyArtifactClosure({
      root,
      output: join(root, "merged"),
      matrix,
      runId: "run-1",
      attempt: 2,
      sha: "abc123",
      executedShards: new Set([1, 2]),
    })).toThrow("exactly match matrix shards")
  })

  it.each([
    ["missing manifest", (artifact: string) => {
      rmSync(join(artifact, "e2e-shard-manifest", "shard-manifest.json"))
    }, "exactly one manifest"],
    ["empty blob", (artifact: string) => {
      writeFileSync(join(artifact, "blob-report", "report-1.zip"), "")
    }, "blob zip is empty"],
    ["multiple blobs", (artifact: string) => {
      writeFileSync(join(artifact, "blob-report", "extra.zip"), "extra")
    }, "exactly one blob zip"],
  ])("rejects an artifact with a %s", (_, mutate, message) => {
    const root = artifactRoot([2, 2])
    mutate(join(root, "blob-report-run-1-1"))
    expect(() => verifyArtifactClosure({
      root,
      output: join(root, "merged"),
      matrix,
      runId: "run-1",
      attempt: 2,
      sha: "abc123",
      executedShards: new Set([1, 2]),
    })).toThrow(message)
  })
})

describe("verifyMergedReport", () => {
  it("accepts the exact normalized unique spec set", () => {
    expect(verifyMergedReport({
      matrix,
      report: { suites: [
        { file: "a.spec.ts", suites: [] },
        { file: "src/test/e2e-ui/b.spec.ts", suites: [] },
        { file: "a.spec.ts", suites: [] },
      ] },
    })).toEqual(["a.spec.ts", "b.spec.ts"])
  })

  it.each([
    ["missing", [{ file: "a.spec.ts" }]],
    ["unexpected", [{ file: "a.spec.ts" }, { file: "b.spec.ts" }, { file: "c.spec.ts" }]],
  ])("rejects an exact-set %s report", (_, suites) => {
    expect(() => verifyMergedReport({ matrix, report: { suites } })).toThrow("spec set mismatch")
  })
})
