import { lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { parseArgs } from "./desktop-release-artifacts.mjs"
import { androidProperties as properties, readAndroidToolchain } from "./android-toolchain.mjs"

function read(project, name) {
  const path = join(project, name)
  if (!lstatSync(path).isFile()) throw new Error(`Android project file is not regular: ${name}`)
  return readFileSync(path, "utf8")
}

function dependency(text, declaration, coordinate, label) {
  const escaped = coordinate.replaceAll(".", "\\.")
  const matches = [...text.matchAll(new RegExp(`^\\s*${declaration}\\("${escaped}:([^\\n]+)"\\)\\s*$`, "gm"))]
  if (matches.length !== 1) throw new Error(`Android ${label} declaration must occur exactly once`)
  return matches[0][1]
}

const propertyLoader = 'rootProject.file("gradle.properties").inputStream().use { load(it) }'
const selection = name => '${alookToolchain.getProperty("alook.' + name + '")}'

function applicationJvmTarget(app) {
  for (const [label, pattern] of [
    ["Java source", /^\s*sourceCompatibility\s*=\s*JavaVersion\.VERSION_([A-Z0-9_]+)\s*$/gm],
    ["Java target", /^\s*targetCompatibility\s*=\s*JavaVersion\.VERSION_([A-Z0-9_]+)\s*$/gm],
    ["Kotlin target", /^\s*jvmTarget\s*=\s*"([0-9.]+)"\s*$/gm],
  ]) {
    const targets = [...app.matchAll(pattern)]
    if (targets.length !== 1 || targets[0][1] !== "11") {
      throw new Error(`Android application requires explicit Java/Kotlin JVM target 11 (${label})`)
    }
  }
  return "11"
}

function applicationLint(app) {
  const scripts = [...app.matchAll(/^\s*apply\(\s*from\s*=\s*(.+)\)\s*$/gm)]
  if (scripts.length !== 1 || scripts[0][1] !== 'file("tauri.build.gradle.kts")') {
    throw new Error("Android application must apply the generated Tauri script once through file() for lint compatibility")
  }
  if (/^\s*(?:checkReleaseBuilds|abortOnError)\s*=\s*false\s*$/m.test(app)) {
    throw new Error("Android application must retain release lint and fatal error blocking")
  }
  return { tauriScriptFile: true, releaseLint: true }
}

export function verifyAndroidProject(project) {
  const selected = readAndroidToolchain()
  const root = read(project, "build.gradle.kts")
  const buildSrc = read(project, "buildSrc/build.gradle.kts")
  const rootAgp = dependency(root, "classpath", "com.android.tools.build:gradle", "root AGP")
  const supportAgp = dependency(buildSrc, "implementation", "com.android.tools.build:gradle", "buildSrc AGP")
  const rootKotlin = dependency(root, "classpath", "org.jetbrains.kotlin:kotlin-gradle-plugin", "Kotlin")
  const wrapper = properties(read(project, "gradle/wrapper/gradle-wrapper.properties"))
  const distribution = wrapper.get("distributionUrl")
  if (!root.includes(propertyLoader) || rootAgp !== selection("agp") || supportAgp !== selected.agp || rootKotlin !== selection("kotlin") ||
      distribution !== `https\\://services.gradle.org/distributions/gradle-${selected.gradle}-bin.zip`) {
    throw new Error("Android toolchain must match the selected supported root/buildSrc AGP, Kotlin and Gradle configuration")
  }
  const config = properties(read(project, "gradle.properties"))
  for (const [name, version] of Object.entries(selected)) {
    if (config.get(`alook.${name}`) !== version) throw new Error(`Android toolchain must match supported alook.${name}=${version}`)
  }
  for (const name of ["android.builtInKotlin", "android.newDsl", "android.proguard.failOnMissingFiles"]) {
    if (config.get(name) !== "false") throw new Error(`Android compatibility requires ${name}=false`)
  }
  read(project, "app/proguard-rules.pro")
  const app = read(project, "app/build.gradle.kts")
  if (!app.includes(propertyLoader)) throw new Error("Android app must read the supported toolchain properties")
  for (const [name, expression] of [
    ["compileSdk", 'alookToolchain.getProperty("alook.compileSdk").toInt()'],
    ["targetSdk", 'alookToolchain.getProperty("alook.compileSdk").toInt()'],
    ["buildToolsVersion", 'alookToolchain.getProperty("alook.buildTools")'],
    ["ndkVersion", 'alookToolchain.getProperty("alook.ndk")'],
  ]) {
    const declarations = [...app.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "gm"))]
    if (declarations.length !== 1 || declarations[0][1] !== expression) throw new Error(`Android ${name} must use the selected supported toolchain`)
  }
  const jvmTarget = applicationJvmTarget(app)
  const lint = applicationLint(app)
  return { agp: selected.agp, supportAgp, kotlin: selected.kotlin, gradle: selected.gradle, builtInKotlin: false, newDsl: false, failOnMissingProguardFiles: false, jvmTarget, ...lint }
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
