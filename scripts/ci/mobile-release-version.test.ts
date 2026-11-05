import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/mobile-release.yml"), "utf8")
const versionStep = workflow.split("      - name: Read and verify mobile release version\n")[1]
  .split("\n      - name:")[0]
const script = versionStep.split("        run: |\n")[1].split("\n")
  .map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n")

function runVersionStep(event: string, marker: string | null, packageVersion = "0.1.64", tauriVersion = packageVersion) {
  const root = mkdtempSync(resolve(tmpdir(), "alook-mobile-version-"))
  const output = resolve(root, "output")
  try {
    mkdirSync(resolve(root, "src/desktop/src-tauri"), { recursive: true })
    writeFileSync(resolve(root, "src/desktop/package.json"), JSON.stringify({ version: packageVersion }))
    writeFileSync(resolve(root, "src/desktop/src-tauri/tauri.conf.json"), JSON.stringify({ version: tauriVersion }))
    if (marker !== null) writeFileSync(resolve(root, "src/desktop/.deploy-version-mobile"), marker + "\n")
    writeFileSync(output, "")
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output },
      encoding: "utf8",
      timeout: 10_000,
    })
    if (result.error) throw result.error
    return { status: result.status, output: readFileSync(output, "utf8") }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("mobile build version validation", () => {
  it.each(["0.1.63", null])("builds a manual candidate with an older or absent release marker: %s", marker => {
    expect(runVersionStep("workflow_dispatch", marker)).toEqual({ status: 0, output: "value=0.1.64\n" })
  })

  it("accepts an automatic release only when its marker matches the package and Tauri", () => {
    expect(runVersionStep("push", "0.1.64")).toEqual({ status: 0, output: "value=0.1.64\n" })
  })

  it.each(["0.1.63", null])("rejects an automatic release with an older or absent marker: %s", marker => {
    const result = runVersionStep("push", marker)
    expect(result.status).not.toBe(0)
    expect(result.output).toBe("")
  })

  it.each(["push", "workflow_dispatch"])("rejects package and Tauri disagreement for %s", event => {
    const result = runVersionStep(event, "0.1.64", "0.1.64", "0.1.65")
    expect(result.status).not.toBe(0)
    expect(result.output).toBe("")
  })
})
