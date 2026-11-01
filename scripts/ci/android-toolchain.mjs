import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

export const androidPolicyPath = fileURLToPath(new URL("../../src/desktop/src-tauri/gen/android/gradle.properties", import.meta.url))

export function androidProperties(text) {
  const values = new Map()
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith("#") || value.startsWith("!")) continue
    const match = /^([^\s=:]+)\s*[=:]\s*(.*?)\s*$/.exec(value)
    if (!match) throw new Error("Unsupported Android property declaration")
    if (values.has(match[1])) throw new Error(`Duplicate Android property: ${match[1]}`)
    values.set(match[1], match[2])
  }
  return values
}

export function readAndroidToolchain() {
  const properties = androidProperties(readFileSync(androidPolicyPath, "utf8"))
  const selected = /** @type {Record<"agp" | "kotlin" | "gradle" | "compileSdk" | "buildTools" | "ndk", string>} */ ({})
  for (const name of ["agp", "kotlin", "gradle", "compileSdk", "buildTools", "ndk"]) {
    const value = properties.get(`alook.${name}`)
    const pattern = name === "compileSdk" ? /^[1-9][0-9]*$/ : /^[0-9]+\.[0-9]+\.[0-9]+$/
    if (!value || !pattern.test(value)) throw new Error(`Invalid supported Android selection: alook.${name}`)
    selected[name] = value
  }
  return selected
}

export function androidSdkComponents(selected = readAndroidToolchain()) {
  return [`platforms;android-${selected.compileSdk}`, `build-tools;${selected.buildTools}`, `ndk;${selected.ndk}`]
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { process.stdout.write(`${androidSdkComponents().join("\n")}\n`) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
