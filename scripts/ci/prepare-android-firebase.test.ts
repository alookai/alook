import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

import { prepareAndroidFirebase } from "./prepare-android-firebase.mjs"
const fixture = {
  project_info: { project_id: "alook-prod", project_number: "190599692413" },
  client: [{
    client_info: {
      mobilesdk_app_id: "1:190599692413:android:316a5d23e2888ac6ce7114",
      android_client_info: { package_name: "ai.alook.android" },
    },
    api_key: [{ current_key: "private-fixture-sentinel" }],
  }],
}
function run(raw: string | undefined) {
  const cwd = mkdtempSync(join(tmpdir(), "firebase-ci-"))
  const target = join(cwd, "src/desktop/src-tauri/gen/android/app/google-services.json")
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, "previous-config", { mode: 0o644 })
  try {
    let status = 0
    let output = ""
    try {
      prepareAndroidFirebase(raw, target)
    } catch (error) {
      status = 1
      output = String(error)
    }
    return { status, output, content: readFileSync(target, "utf8"), mode: statSync(target).mode & 0o777 }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}
describe("Android Firebase release configuration", () => {
  it("restores the exact configuration and tightens an existing file without logging its API key", () => {
    const raw = JSON.stringify(fixture)
    const result = run(raw)
    expect(result.status).toBe(0)
    expect(result.content).toBe(raw)
    if (process.platform !== "win32") expect(result.mode).toBe(0o600)
    expect(result.output).not.toContain("private-fixture-sentinel")
  })
  it.each([undefined, "private-fixture-sentinel", "null", "{}"])("rejects missing or malformed configuration without overwriting a file: %s", (raw) => {
    const result = run(raw)
    expect(result.status).not.toBe(0)
    expect(result.content).toBe("previous-config")
    expect(result.output).not.toContain("private-fixture-sentinel")
  })
  it.each(["project", "number", "package", "app", "key", "blankKey", "nonStringKey"])("rejects mismatched or missing %s", (field) => {
    const config = structuredClone(fixture)
    if (field === "project") config.project_info.project_id = "wrong-project"
    if (field === "number") config.project_info.project_number = "0"
    if (field === "package") config.client[0].client_info.android_client_info.package_name = "wrong.package"
    if (field === "app") config.client[0].client_info.mobilesdk_app_id = "wrong-app"
    if (field === "key") config.client[0].api_key = []
    if (field === "blankKey") config.client[0].api_key[0].current_key = " "
    if (field === "nonStringKey") Object.assign(config.client[0].api_key[0], { current_key: null })
    const result = run(JSON.stringify(config))
    expect(result.status).not.toBe(0)
    expect(result.content).toBe("previous-config")
    expect(result.output).not.toContain("private-fixture-sentinel")
  })
})
