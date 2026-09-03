import { describe, expect, it } from "vitest"
import { buildExecutionPlan, loadScopeManifest } from "./changed-scopes.mjs"
import { validateCharacterization } from "./characterization-guard.mjs"

const candidateSha = "a".repeat(40)
const fixtureSha = "b".repeat(40)
const sourcePath = "src/cli/commands/update.ts"

function validInput() {
  const manifest = loadScopeManifest()
  const changes = [{ status: "M", path: sourcePath }]
  return {
    repository: "alookai/alook",
    refName: `ci-characterization/${candidateSha.slice(0, 12)}/package`,
    eventSha: fixtureSha,
    candidateSha,
    fixtureSha,
    expectedClass: "package",
    candidatePr: {
      state: "open",
      head: { sha: candidateSha, repo: { full_name: "alookai/alook" } },
    },
    refSha: fixtureSha,
    parentShas: [candidateSha],
    isAncestor: true,
    fileMode: "100644",
    changes,
    plan: buildExecutionPlan(changes, {
      baseSha: candidateSha,
      headSha: fixtureSha,
      diagnosticOnly: true,
    }),
    integrityBlobs: Object.fromEntries(
      manifest.integrity_paths.map((path: string) => [path, { candidate: "blob", fixture: "blob" }]),
    ),
    manifest,
  }
}

describe("validateCharacterization", () => {
  it("accepts only a locked same-repository direct-parent source fixture", () => {
    const result = validateCharacterization(validInput())

    expect(result).toMatchObject({
      base_sha: candidateSha,
      head_sha: fixtureSha,
      expected_class: "package",
      diagnostic_only: true,
      source_path: sourcePath,
    })
  })

  it.each([
    ["fork", { candidatePr: { state: "open", head: { sha: candidateSha, repo: { full_name: "fork/alook" } } } }],
    ["prefix", { refName: "feature/not-characterization" }],
    ["event SHA", { eventSha: "c".repeat(40) }],
    ["ref tip", { refSha: "c".repeat(40) }],
    ["open", { candidatePr: { state: "closed", head: { sha: candidateSha, repo: { full_name: "alookai/alook" } } } }],
    ["candidate head", { candidatePr: { state: "open", head: { sha: "c".repeat(40), repo: { full_name: "alookai/alook" } } } }],
    ["direct parent", { parentShas: ["c".repeat(40)] }],
    ["merge commit", { parentShas: [candidateSha, "c".repeat(40)] }],
    ["ancestor", { isAncestor: false }],
    ["regular source", { fileMode: "120000" }],
    ["single source", { changes: [{ status: "M", path: sourcePath }, { status: "M", path: "src/cli/lib/config.ts" }] }],
    ["deletion", { changes: [{ status: "D", path: sourcePath }] }],
    ["class", { expectedClass: "shared" }],
  ])("rejects invalid %s evidence", (_label, override) => {
    expect(() => validateCharacterization({ ...validInput(), ...override })).toThrow()
  })

  it("rejects policy blob drift and non-coverable fixture paths", () => {
    const drift = validInput()
    drift.integrityBlobs[".github/workflows/ci.yml"] = {
      candidate: "one",
      fixture: "two",
    }
    expect(() => validateCharacterization(drift)).toThrow("blob")

    const testPath = "src/cli/commands/update.test.ts"
    const nonCoverable = validInput()
    nonCoverable.changes = [{ status: "M", path: testPath }]
    nonCoverable.plan = buildExecutionPlan(nonCoverable.changes, {
      baseSha: candidateSha,
      headSha: fixtureSha,
      diagnosticOnly: true,
    })
    expect(() => validateCharacterization(nonCoverable)).toThrow("coverable")
  })

  it("rejects full, mixed, unknown, and non-diagnostic plans", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      "src/cli/commands/update.ts",
      "unexpected/file.ts",
    ]) {
      const input = validInput()
      input.changes = path === "src/cli/commands/update.ts"
        ? [{ status: "M", path }, { status: "M", path: "src/shared/src/semver.ts" }]
        : [{ status: "M", path }]
      input.plan = buildExecutionPlan(input.changes, {
        baseSha: candidateSha,
        headSha: fixtureSha,
        diagnosticOnly: path !== "unexpected/file.ts",
      })
      expect(() => validateCharacterization(input)).toThrow()
    }
  })
})
