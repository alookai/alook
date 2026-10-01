import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(
  resolve(import.meta.dirname, "../../.github/workflows/desktop-release.yml"),
  "utf8",
).replace(/\r\n/g, "\n")

function preflight(step: string, boundary?: string): string {
  const start = workflow.indexOf(`      - name: ${step}\n`)
  const end = workflow.indexOf("      - name:", start + 1)
  const body = workflow.slice(start, end).split("        run: |\n")[1]
  const stop = boundary ? body?.indexOf(boundary) ?? -1 : body?.length ?? -1
  if (start < 0 || stop < 0) throw new Error(`Missing safe preflight boundary: ${step}`)
  return body.slice(0, stop).replace(/^          /gm, "")
}

const macScript = preflight("Prepare fail-closed macOS signing", "          umask 077")
const windowsScript = preflight("Preflight Windows release inputs")
const shellEnvironment = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
}
const macInputs: Record<string, string> = {
  APPLE_CERTIFICATE: "offline-certificate",
  APPLE_CERTIFICATE_PASSWORD: "offline-password",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Offline Test (AAAAAAAAAA)",
  APPLE_TEAM_ID: "AAAAAAAAAA",
  APPLE_API_ISSUER: "offline-issuer",
  APPLE_API_KEY: "offline-api-key",
  APPLE_API_PRIVATE_KEY: "offline-api-private-key",
  TAURI_SIGNING_PRIVATE_KEY: "offline-updater-private-key",
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
}
const windowsInputs: Record<string, string> = {
  TAURI_SIGNING_PRIVATE_KEY: "offline-updater-private-key",
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
}

function run(shell: "bash" | "pwsh", script: string, inputs: Record<string, string>) {
  const args = shell === "bash"
    ? ["-c", script]
    : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]
  const result = spawnSync(shell, args, {
    encoding: "utf8",
    env: { ...shellEnvironment, ...inputs },
    timeout: 10_000,
  })
  if (result.error) throw result.error
  return { status: result.status, output: result.stdout + result.stderr }
}

describe("macOS actual release preflight", () => {
  it.each(["", "offline-encrypted-key-password"])("accepts updater password %j", password => {
    expect(run("bash", macScript, { ...macInputs, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password }).status).toBe(0)
  })

  it.each(["TAURI_SIGNING_PRIVATE_KEY", "APPLE_CERTIFICATE", "APPLE_API_PRIVATE_KEY"])(
    "rejects missing required %s even with an empty updater password",
    name => {
      const inputs = { ...macInputs, [name]: "" }
      const result = run("bash", macScript, inputs)
      expect(result.status).not.toBe(0)
      expect(result.output).toContain(`Missing required macOS release input: ${name}`)
    },
  )
})

const hasPowerShell = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "exit 0"], {
  timeout: 10_000,
}).status === 0

describe.skipIf(!hasPowerShell)("Windows actual release preflight (requires pwsh)", () => {
  it.each(["", "offline-encrypted-key-password"])("accepts updater password %j", password => {
    expect(run("pwsh", windowsScript, { ...windowsInputs, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password }).status).toBe(0)
  })

  it.each(["TAURI_SIGNING_PRIVATE_KEY"])(
    "rejects missing required %s even with an empty updater password",
    name => {
      const inputs = { ...windowsInputs, [name]: "" }
      const result = run("pwsh", windowsScript, inputs)
      expect(result.status).not.toBe(0)
      expect(result.output).toContain(`Missing required Windows release input: ${name}`)
    },
  )
})
