import { lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { parseArgs } from "./desktop-release-artifacts.mjs"

function read(project, name) {
  const path = join(project, name)
  if (!lstatSync(path).isFile()) throw new Error(`Android project file is not regular: ${name}`)
  return readFileSync(path, "utf8")
}

function dependency(text, declaration, coordinate, label) {
  const escaped = coordinate.replaceAll(".", "\\.")
  const matches = [...text.matchAll(new RegExp(`^\\s*${declaration}\\("${escaped}:([0-9.]+)"\\)\\s*$`, "gm"))]
  if (matches.length !== 1) throw new Error(`Android ${label} declaration must occur exactly once`)
  return matches[0][1]
}

function properties(text) {
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

export function verifyAndroidProject(project) {
  const root = read(project, "build.gradle.kts")
  const buildSrc = read(project, "buildSrc/build.gradle.kts")
  const agp = dependency(root, "classpath", "com.android.tools.build:gradle", "root AGP")
  const supportAgp = dependency(buildSrc, "implementation", "com.android.tools.build:gradle", "buildSrc AGP")
  const kotlin = dependency(root, "classpath", "org.jetbrains.kotlin:kotlin-gradle-plugin", "Kotlin")
  const wrapper = properties(read(project, "gradle/wrapper/gradle-wrapper.properties"))
  const distribution = wrapper.get("distributionUrl")
  if (agp !== "9.3.1" || supportAgp !== agp || kotlin !== "2.2.10" ||
      distribution !== "https\\://services.gradle.org/distributions/gradle-9.6.1-bin.zip") {
    throw new Error("Android toolchain must match CLI2.12.1 root/buildSrc AGP9.3.1, Kotlin2.2.10 and Gradle9.6.1")
  }
  const config = properties(read(project, "gradle.properties"))
  for (const name of ["android.builtInKotlin", "android.newDsl", "android.proguard.failOnMissingFiles"]) {
    if (config.get(name) !== "false") throw new Error(`Android compatibility requires ${name}=false`)
  }
  read(project, "app/proguard-rules.pro")
  return { agp, supportAgp, kotlin, gradle: "9.6.1", builtInKotlin: false, newDsl: false, failOnMissingProguardFiles: false }
}

export function main(argv = process.argv.slice(2), runtime = process) {
  const args = parseArgs(["verify", ...argv])
  if (!args.project) throw new Error("Expected --project Android project directory")
  runtime.stdout.write(`${JSON.stringify(verifyAndroidProject(args.project))}\n`)
}

export function runIfMain(metaUrl, argvPath = process.argv[1], argv = process.argv.slice(2), runtime = process) {
  if (!argvPath || metaUrl !== pathToFileURL(argvPath).href) return false
  try {
    main(argv, runtime)
  } catch (error) {
    runtime.stderr.write(`${error.message}\n`)
    runtime.exitCode = 1
  }
  return true
}

runIfMain(import.meta.url)
