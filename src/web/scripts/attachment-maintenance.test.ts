import { describe, expect, it } from "vitest"
import { assertLocalMaintenance } from "./attachment-maintenance"

describe("attachment maintenance production restriction", () => {
  it("rejects remote D1 and R2 configurations independently", () => {
    expect(() => assertLocalMaintenance({ d1_databases: [{ remote: true }] })).toThrow("remote apply is disabled")
    expect(() => assertLocalMaintenance({ r2_buckets: [{ remote: true }] })).toThrow("remote apply is disabled")
    expect(() => assertLocalMaintenance({ d1_databases: [{ remote: false }], r2_buckets: [{}] })).not.toThrow()
  })
})

it("a complete hand-filled proof cannot enable remote CLI apply", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join, resolve } = await import("node:path")
  const { spawnSync } = await import("node:child_process")
  const directory = mkdtempSync(join(tmpdir(), "alook-attachment-guard-"))
  try {
    const configPath = join(directory, "wrangler.jsonc")
    const localState = join(directory, "state")
    const proofPath = join(directory, "proof.json")
    const stopped = spawnSync(process.execPath, ["-e", "process.exit(0)"])
    writeFileSync(configPath, JSON.stringify({
      name: "qa-file-remote-guard", compatibility_date: "2026-10-10",
      d1_databases: [{ binding: "DB", database_name: "qa", database_id: "00000000-0000-0000-0000-000000000001", remote: true }],
      r2_buckets: [{ binding: "COMMUNITY_MEDIA", bucket_name: "qa-file-remote-guard", remote: true }],
    }))
    writeFileSync(proofPath, JSON.stringify({ configPath, localState, writersStopped: true, invocationsDrained: true,
      evidence: "hand-filled, no actual production evidence", stoppedWriterPids: [stopped.pid], expiresAt: new Date(Date.now() + 60_000).toISOString() }))
    const result = spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/attachment-maintenance.ts"),
      "collect", "--config", configPath, "--manifest", join(directory, "manifest.jsonl"), "--apply", "--local-state", localState, "--quiescence-proof", proofPath],
      { encoding: "utf8", timeout: 20_000 })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("production/remote apply is disabled")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
