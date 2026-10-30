import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createShardManifest, verifyArtifactClosure, verifyMergedReport } from "./e2e-shard-artifacts.mjs"

const root = resolve(import.meta.dirname, "../..")
const extractor = join(root, "scripts/ci/extract-report-artifacts.py")
const temporary: string[] = []
const matrix = { include: [{ shard: 1, total: 1, specs: ["a.spec.ts"] }] }

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "alook-report-extract-"))
  temporary.push(directory)
  return directory
}

const fixtureBuilder = String.raw`
import base64, io, json, pathlib, struct, sys, warnings, zipfile
target, manifest, options = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
inner = io.BytesIO()
with zipfile.ZipFile(inner, "w") as archive:
    archive.writestr("report.jsonl", '{"type":"begin"}\n')
blob = inner.getvalue()
comment = b"padding-" + b"PK\x07\x08" + struct.pack("<III", 0, len(blob) + 13, 0) + b"end"
blob = blob[:-2] + struct.pack("<H", len(comment)) + comment
class NonSeekable(io.BytesIO):
    def seek(self, *args):
        raise io.UnsupportedOperation()
outer = NonSeekable()
member = options.get("member", "blob-report/report.zip")
with warnings.catch_warnings():
    warnings.simplefilter("ignore", UserWarning)
    with zipfile.ZipFile(outer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=0) as archive:
        if options.get("directories"):
            archive.writestr("blob-report/", b"")
            archive.writestr("e2e-shard-manifest/", b"")
        if options.get("symlink"):
            info = zipfile.ZipInfo(member)
            info.create_system = 3
            info.external_attr = 0o120777 << 16
            archive.writestr(info, b"outside")
        else:
            archive.writestr(member, blob)
        if options.get("duplicate"):
            archive.writestr(member, blob)
        if not options.get("missing"):
            archive.writestr("e2e-shard-manifest/shard-manifest.json", manifest)
        if options.get("extra"):
            archive.writestr("unexpected.txt", b"unexpected")
data = bytearray(outer.getvalue())
if options.get("crc"):
    central = data.index(b"PK\x01\x02")
    data[central + 16] ^= 1
pathlib.Path(target).write_bytes(data)
early = None
boundary = None
if not options:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        info = archive.infolist()[0]
        name_length, extra_length = struct.unpack_from("<HH", data, info.header_offset + 26)
        start = info.header_offset + 30 + name_length + extra_length
        found = data.index(b"PK\x07\x08", start)
        early = found - start
        boundary = info.compress_size
        assert early < boundary
        assert struct.unpack_from("<I", data, found + 8)[0] == early
        assert info.flag_bits & 8
        assert archive.testzip() is None
print(json.dumps({"blob": base64.b64encode(blob).decode(), "early": early, "boundary": boundary}))
`

function archive(directory: string, options: Record<string, unknown> = {}, shard = 1, total = 1, attempt = 1) {
  mkdirSync(directory, { recursive: true })
  const manifest = createShardManifest({ runId: "run-1", attempt, sha: "source-sha", shard, total, specs: [`${shard === 1 ? "a" : "b"}.spec.ts`] })
  const result = execFileSync("python3", ["-c", fixtureBuilder, join(directory, "opaque-download"), JSON.stringify(manifest), JSON.stringify(options)], { encoding: "utf8" })
  return { manifest, ...JSON.parse(result) as { blob: string; early: number | null; boundary: number | null } }
}

function extract(raw: string, output: string) {
  return spawnSync("python3", [extractor, "--root", raw, "--output", output], { encoding: "utf8" })
}

describe("central-directory report artifact extraction", () => {
  it("extracts a complete valid ZIP despite an earlier descriptor satisfying the stream parser's size predicate", () => {
    const directory = workspace()
    const raw = join(directory, "raw")
    const expected = archive(raw)
    const output = join(directory, "extracted")
    const before = readFileSync(join(raw, "opaque-download"))
    const result = extract(raw, output)
    expect(result.status).toBe(0)
    expect(expected.early).toBeLessThan(expected.boundary!)
    expect(readFileSync(join(output, "blob-report/report.zip"))).toEqual(Buffer.from(expected.blob, "base64"))
    expect(JSON.parse(readFileSync(join(output, "e2e-shard-manifest/shard-manifest.json"), "utf8"))).toEqual(expected.manifest)
    expect(readFileSync(join(raw, "opaque-download"))).toEqual(before)
    expect(verifyArtifactClosure({ root: output, output: join(directory, "verified"), matrix, runId: "run-1", attempt: 1, sha: "source-sha", executedShards: new Set([1]) }).manifests).toEqual([expected.manifest])
    expect(verifyMergedReport({ report: { suites: [{ file: "a.spec.ts" }] }, matrix })).toEqual(["a.spec.ts"])
  })

  it("retains named multi-artifact directories and the original source, spec and attempt guards", () => {
    const directory = workspace()
    const raw = join(directory, "raw")
    archive(join(raw, "blob-report-run-1-1"), {}, 1, 2, 1)
    archive(join(raw, "blob-report-run-1-2"), { directories: true }, 2, 2, 2)
    const output = join(directory, "extracted")
    expect(extract(raw, output).status).toBe(0)
    const two = { include: [...matrix.include.map(entry => ({ ...entry, total: 2 })), { shard: 2, total: 2, specs: ["b.spec.ts"] }] }
    const args = { root: output, output: join(directory, "verified"), matrix: two, runId: "run-1", attempt: 2, sha: "source-sha", executedShards: new Set([2]) }
    expect(verifyArtifactClosure(args).manifests.map(item => item.attempt)).toEqual([1, 2])
    expect(() => verifyArtifactClosure({ ...args, sha: "wrong" })).toThrow("SHA mismatch")
    expect(() => verifyArtifactClosure({ ...args, executedShards: new Set([1, 2]) })).toThrow("artifact is stale")
    expect(() => verifyArtifactClosure({ ...args, matrix: { include: [two.include[0], { ...two.include[1], specs: ["wrong.spec.ts"] }] } })).toThrow("specs mismatch")
    expect(() => verifyMergedReport({ report: { suites: [{ file: "a.spec.ts" }] }, matrix: two })).toThrow("merged report spec set mismatch")
  })

  it.each(["../escape.zip", "/escape.zip", "blob-report/../escape.zip", "blob-report\\escape.zip", "C:/escape.zip", "blob-report/./report.zip"])("rejects unsafe member %s before publishing output", member => {
    const directory = workspace()
    const raw = join(directory, "raw")
    archive(raw, { member })
    const output = join(directory, "extracted")
    const result = extract(raw, output)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Unsafe")
    expect(existsSync(output)).toBe(false)
    expect(existsSync(join(directory, "escape.zip"))).toBe(false)
  })

  it.each(["duplicate", "missing", "extra", "symlink", "crc"])("rejects %s ZIP input before publishing output", mode => {
    const directory = workspace()
    const raw = join(directory, "raw")
    archive(raw, { [mode]: true })
    const output = join(directory, "extracted")
    expect(extract(raw, output).status).not.toBe(0)
    expect(existsSync(output)).toBe(false)
  })

  it("validates every archive before publishing any artifact", () => {
    const directory = workspace()
    const raw = join(directory, "raw")
    archive(join(raw, "blob-report-run-1-1"))
    archive(join(raw, "blob-report-run-1-2"), { crc: true })
    const output = join(directory, "extracted")
    expect(extract(raw, output).status).not.toBe(0)
    expect(existsSync(output)).toBe(false)
  })

  it.each(["empty", "mixed", "extra-file", "malformed", "directory", "symlink"])("rejects %s raw download layout", mode => {
    const directory = workspace()
    const raw = join(directory, "raw")
    archive(raw)
    if (mode === "empty") rmSync(join(raw, "opaque-download"))
    if (mode === "mixed") mkdirSync(join(raw, "unexpected-directory"))
    if (mode === "extra-file") writeFileSync(join(raw, "another-download"), "extra")
    if (mode === "malformed") writeFileSync(join(raw, "opaque-download"), "not ZIP")
    if (mode === "directory") { rmSync(join(raw, "opaque-download")); mkdirSync(join(raw, "artifact-directory")) }
    if (mode === "symlink") { const file = join(directory, "outside.zip"); writeFileSync(file, readFileSync(join(raw, "opaque-download"))); rmSync(join(raw, "opaque-download")); symlinkSync(file, join(raw, "opaque-download")) }
    const output = join(directory, "extracted")
    expect(extract(raw, output).status).not.toBe(0)
    expect(existsSync(output)).toBe(false)
  })

  it("preserves existing outputs and rejects overlapping paths", () => {
    const directory = workspace()
    const raw = join(directory, "raw")
    archive(raw)
    const output = join(directory, "extracted")
    mkdirSync(output)
    writeFileSync(join(output, "existing"), "keep")
    expect(extract(raw, output).status).not.toBe(0)
    expect(readFileSync(join(output, "existing"), "utf8")).toBe("keep")
    expect(extract(raw, join(raw, "nested-output")).status).not.toBe(0)
    expect(existsSync(join(raw, "nested-output"))).toBe(false)
  })

  it("keeps the fixed download action's fatal digest check and every downstream validator", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8").split("  merge-reports:")[1]!.split("  ci-gate:")[0]!
    expect(workflow).toContain("actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333")
    expect(workflow).toContain("skip-decompress: true")
    expect(workflow).toContain("digest-mismatch: error")
    expect(workflow).toContain("path: downloaded-blob-report-archives")
    const extraction = workflow.indexOf("python3 scripts/ci/extract-report-artifacts.py --root downloaded-blob-report-archives --output downloaded-blob-reports")
    const validation = workflow.indexOf("e2e-shard-artifacts.mjs verify-artifacts")
    const merge = workflow.indexOf("playwright merge-reports")
    const finalValidation = workflow.indexOf("e2e-shard-artifacts.mjs verify-merged")
    expect(extraction).toBeGreaterThan(0)
    expect(validation).toBeGreaterThan(extraction)
    expect(merge).toBeGreaterThan(validation)
    expect(finalValidation).toBeGreaterThan(merge)
  })
})
