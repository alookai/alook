import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { buildExecutionPlan, loadScopeManifest } from "./changed-scopes.mjs"
import {
  blobAt,
  runCli,
  runIfMain,
  validateCharacterization,
} from "./characterization-guard.mjs"

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

function cliRuntime(sourcePath: string | null) {
  const manifest = loadScopeManifest()
  return {
    manifest,
    execFileSync: vi.fn((_file: string, args: string[], options: unknown) => {
      if (args[0] === "ls-remote") return `${fixtureSha}\trefs/heads/test\n`
      if (args[0] === "show") return `${candidateSha}\n`
      if (args[0] === "diff") return sourcePath === null ? Buffer.alloc(0) : Buffer.from(`M\0${sourcePath}\0`)
      if (args[0] === "ls-tree") return `100644 blob\t${sourcePath}\n`
      throw new Error(`unexpected git call: ${args.join(" ")} / ${String(options)}`)
    }),
    spawnSync: vi.fn((_file: string, args: string[]) => {
      if (args[0] === "merge-base") return { status: 0, stdout: "", stderr: "" }
      if (args[0] === "rev-parse") return { status: 0, stdout: "policy-blob\n", stderr: "" }
      throw new Error(`unexpected spawned git call: ${args.join(" ")}`)
    }),
  }
}

function cliArgs(candidatePrJson: string, expectedClass: string) {
  return [
    "--repository", "alookai/alook",
    "--ref-name", `ci-characterization/${candidateSha.slice(0, 12)}/${expectedClass}`,
    "--event-sha", fixtureSha,
    "--candidate-sha", candidateSha,
    "--fixture-sha", fixtureSha,
    "--expected-class", expectedClass,
    "--candidate-pr-json", candidatePrJson,
  ]
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
    ["SHA format", { eventSha: "A".repeat(40) }],
    ["expected class", { expectedClass: "future" }],
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
    const missingIntegrity = validInput()
    delete missingIntegrity.integrityBlobs[Object.keys(missingIntegrity.integrityBlobs)[0]]
    expect(() => validateCharacterization(missingIntegrity)).toThrow("blob set")

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

    const blogContent = validInput()
    const blogContentPath = "src/web/blog/src/content/example.mdx"
    blogContent.expectedClass = "blog"
    blogContent.refName = `ci-characterization/${candidateSha.slice(0, 12)}/blog`
    blogContent.changes = [{ status: "M", path: blogContentPath }]
    blogContent.plan = buildExecutionPlan(blogContent.changes, {
      baseSha: candidateSha,
      headSha: fixtureSha,
      diagnosticOnly: true,
    })
    expect(() => validateCharacterization(blogContent)).toThrow("coverable")
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

    const boundary = validInput()
    boundary.plan = buildExecutionPlan(boundary.changes, {
      baseSha: "c".repeat(40),
      headSha: fixtureSha,
      diagnosticOnly: true,
    })
    expect(() => validateCharacterization(boundary)).toThrow("SHA boundary")
  })
})

describe("characterization guard CLI", () => {
  it.each([
    ["package", "src/cli/src/commands/inbox.ts"],
    ["blog", "src/web/blog/src/lib/posts.ts"],
    ["shared", "src/shared/src/semver.ts"],
  ])("emits locked %s evidence from the full command path", (expectedClass, sourcePath) => {
    const directory = mkdtempSync(join(tmpdir(), "alook-characterization-"))
    const candidatePrJson = join(directory, "candidate.json")
    const output = join(directory, "output")
    const summary = join(directory, "summary.md")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      writeFileSync(candidatePrJson, JSON.stringify({
        state: "open",
        head: { sha: candidateSha, repo: { full_name: "alookai/alook" } },
      }))
      const args = [
        ...cliArgs(candidatePrJson, expectedClass),
        "--output", output,
        "--summary", summary,
      ]
      const runtime = cliRuntime(sourcePath)
      if (expectedClass === "package") {
        runIfMain("file:///tmp/characterization-guard.mjs", "/tmp/characterization-guard.mjs", args, runtime)
      } else {
        runCli(args, runtime)
      }

      expect(readFileSync(output, "utf8")).toContain(`base_sha=${candidateSha}`)
      expect(readFileSync(summary, "utf8")).toContain(`Class: \`${expectedClass}\``)
      const result = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join(""))
      expect(result).toMatchObject({ expected_class: expectedClass, source_path: sourcePath })
    } finally {
      stdout.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("requires the full locked argument set", () => {
    expect(() => runCli([])).toThrow("--repository is required")
  })

  it("rejects an empty Git diff through its absent file mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "alook-characterization-empty-"))
    const candidatePrJson = join(directory, "candidate.json")
    try {
      writeFileSync(candidatePrJson, JSON.stringify({
        state: "open",
        head: { sha: candidateSha, repo: { full_name: "alookai/alook" } },
      }))
      expect(() => runCli(
        cliArgs(candidatePrJson, "package"),
        cliRuntime(null),
      )).toThrow("regular source file")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("maps present, absent, and invalid integrity blobs", () => {
    expect(blobAt(candidateSha, "codecov.yml", {
      spawnSync: () => ({ status: 0, stdout: "blob\n", stderr: "" }),
    })).toBe("blob")
    for (const stderr of [
      "fatal: path exists on disk, but not in commit",
      "fatal: path does not exist in commit",
    ]) {
      expect(blobAt(candidateSha, "codecov.yml", {
        spawnSync: () => ({ status: 128, stdout: "", stderr }),
      })).toBeNull()
    }
    expect(() => blobAt(candidateSha, "codecov.yml", {
      spawnSync: () => ({ status: 128, stdout: "", stderr: "fatal: transport failed" }),
    })).toThrow("cannot resolve integrity path")
  })
})
