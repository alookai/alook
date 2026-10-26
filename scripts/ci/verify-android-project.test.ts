import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { readAndroidToolchain, androidSdkComponents } from "./android-toolchain.mjs"
import { runIfMain, verifyAndroidProject } from "./verify-android-project.mjs"

const selected = readAndroidToolchain()
const directories: string[] = []
const canonical = resolve(import.meta.dirname, "../../src/desktop/src-tauri/gen/android")

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alook-android-toolchain-"))
  directories.push(root)
  for (const file of ["build.gradle.kts", "gradle.properties", "app/build.gradle.kts", "app/proguard-rules.pro", "app/src/main/AndroidManifest.xml"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    cpSync(join(canonical, file), join(root, file))
  }
  mkdirSync(join(root, "buildSrc"))
  writeFileSync(join(root, "buildSrc/build.gradle.kts"), `plugins { \`kotlin-dsl\` }\ndependencies {\n    implementation("com.android.tools.build:gradle:${selected.agp}")\n}\n`)
  mkdirSync(join(root, "gradle/wrapper"), { recursive: true })
  writeFileSync(join(root, "gradle/wrapper/gradle-wrapper.properties"), `distributionUrl=https\\://services.gradle.org/distributions/gradle-${selected.gradle}-bin.zip\n`)
  return root
}

function change(root: string, file: string, before: string, after: string) {
  const path = join(root, file)
  writeFileSync(path, readFileSync(path, "utf8").replace(before, after))
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("post-init Android toolchain validation", () => {
  it("checks fresh support against tracked configuration and leaves custom app/manifest bytes intact", () => {
    const root = fixture()
    const app = readFileSync(join(root, "app/build.gradle.kts"))
    const manifest = readFileSync(join(root, "app/src/main/AndroidManifest.xml"))
    expect(verifyAndroidProject(root)).toEqual({
      agp: selected.agp, supportAgp: selected.agp, kotlin: selected.kotlin, gradle: selected.gradle, builtInKotlin: false, newDsl: false, failOnMissingProguardFiles: false, jvmTarget: "11", tauriScriptFile: true, releaseLint: true,
    })
    expect(readFileSync(join(root, "app/build.gradle.kts"))).toEqual(app)
    expect(readFileSync(join(root, "app/src/main/AndroidManifest.xml"))).toEqual(manifest)
  })

  it.each([
    'apply(from = "tauri.build.gradle.kts")',
    "",
    'apply(from = file("tauri.build.gradle.kts"))\napply(from = "tauri.build.gradle.kts")',
    'apply(from = file("other.gradle.kts"))',
  ])("rejects incompatible generated-script application: %s", after => {
    const root = fixture()
    change(root, "app/build.gradle.kts", 'apply(from = file("tauri.build.gradle.kts"))', after)
    expect(() => verifyAndroidProject(root)).toThrow("must apply the generated Tauri script once through file()")
  })

  it.each(["checkReleaseBuilds", "abortOnError"])("rejects disabling %s to bypass release lint", name => {
    const root = fixture()
    change(root, "app/build.gradle.kts", "android {", `android {\n    lint {\n        ${name} = false\n    }`)
    expect(() => verifyAndroidProject(root)).toThrow("must retain release lint and fatal error blocking")
  })

  it.each([
    ['jvmTarget = "11"', 'jvmTarget = "1.8"'],
    ["targetCompatibility = JavaVersion.VERSION_11", "targetCompatibility = JavaVersion.VERSION_1_8"],
    ["sourceCompatibility = JavaVersion.VERSION_11", "sourceCompatibility = JavaVersion.VERSION_17"],
    ["targetCompatibility = JavaVersion.VERSION_11", ""],
    ['jvmTarget = "11"', 'jvmTarget = "11"\n        jvmTarget = "1.8"'],
  ])("rejects missing or conflicting application JVM target: %s", (before, after) => {
    const root = fixture()
    change(root, "app/build.gradle.kts", before, after)
    expect(() => verifyAndroidProject(root)).toThrow("Android application requires explicit Java/Kotlin JVM target 11")
  })

  it.each([
    ["build.gradle.kts", '${alookToolchain.getProperty("alook.agp")}', "8.11.0"],
    ["build.gradle.kts", '${alookToolchain.getProperty("alook.kotlin")}', "1.9.25"],
    ["buildSrc/build.gradle.kts", `gradle:${selected.agp}`, "gradle:8.11.0"],
    ["gradle/wrapper/gradle-wrapper.properties", `gradle-${selected.gradle}-bin.zip`, "gradle-8.14.3-bin.zip"],
  ])("rejects incompatible post-init declaration in %s", (file, before, after) => {
    const root = fixture()
    change(root, file, before, after)
    expect(() => verifyAndroidProject(root)).toThrow("Android toolchain must match")
  })


  it.each(Object.keys(selected))("rejects an unsupported post-init %s selection", name => {
    const root = fixture()
    const value = selected[name as keyof typeof selected]
    change(root, "gradle.properties", `alook.${name}=${value}`, `alook.${name}=0`)
    expect(() => verifyAndroidProject(root)).toThrow(`must match supported alook.${name}`)
  })

  it.each(["compileSdk", "targetSdk", "buildToolsVersion", "ndkVersion"])("rejects an app %s that ignores the selected configuration", name => {
    const root = fixture()
    const file = "app/build.gradle.kts"
    const text = readFileSync(join(root, file), "utf8")
    writeFileSync(join(root, file), text.replace(new RegExp(`(${name}\\s*=)[^\\n]+`), '$1 "0"'))
    expect(() => verifyAndroidProject(root)).toThrow(`${name} must use the selected supported toolchain`)
  })

  it("exports exactly the selected SDK, build tools and NDK to the actual release shell", () => {
    const helper = resolve(import.meta.dirname, "android-toolchain.mjs")
    const output = spawnSync(process.execPath, [helper], { encoding: "utf8" })
    expect(output.status, output.stderr).toBe(0)
    expect(output.stdout.trim().split("\n")).toEqual(androidSdkComponents())
  })

  it.skipIf(process.platform === "win32")("installs the supported components and refuses a missing or nonexecutable selected NDK", () => {
    const root = fixture()
    const sdk = join(root, "Android SDK with spaces")
    const manager = join(sdk, "cmdline-tools/latest/bin/sdkmanager")
    const ndk = join(sdk, "ndk", selected.ndk, "ndk-build")
    const log = join(root, "installed-components")
    const environment = join(root, "github-env")
    mkdirSync(dirname(manager), { recursive: true })
    writeFileSync(manager, '#!/bin/sh\nif [ "$1" = --licenses ]; then exit 0; fi\nprintf "%s\\n" "$@" > "$SDK_FIXTURE_LOG"\n', { mode: 0o755 })
    const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/mobile-release.yml"), "utf8")
    const step = workflow.split("      - name: Install Android SDK components\n")[1].split("      - name:")[0]
    const shell = step.split("        run: |\n")[1].replace(/^          /gm, "")
    const run = () => spawnSync("bash", ["-c", shell], {
      cwd: resolve(import.meta.dirname, "../.."),
      env: { ...process.env, ANDROID_HOME: sdk, GITHUB_ENV: environment, SDK_FIXTURE_LOG: log },
      encoding: "utf8", timeout: 10_000,
    })
    expect(run().status).not.toBe(0)
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(androidSdkComponents())
    mkdirSync(dirname(ndk), { recursive: true })
    writeFileSync(ndk, "#!/bin/sh\nexit 0\n", { mode: 0o644 })
    expect(run().status).not.toBe(0)
    chmodSync(ndk, 0o755)
    const valid = run()
    expect(valid.status, valid.stderr).toBe(0)
    expect(readFileSync(environment, "utf8").trim()).toBe(`NDK_HOME=${dirname(ndk)}`)
  })

  it.each(["android.builtInKotlin", "android.newDsl", "android.proguard.failOnMissingFiles"])("rejects missing or enabled %s", name => {
    const root = fixture()
    change(root, "gradle.properties", `${name}=false`, `${name}=true`)
    expect(() => verifyAndroidProject(root)).toThrow(`${name}=false`)
    change(root, "gradle.properties", `${name}=true`, "")
    expect(() => verifyAndroidProject(root)).toThrow(`${name}=false`)
  })

  it("rejects absent generated buildSrc rather than trusting local root pins", () => {
    const root = fixture()
    rmSync(join(root, "buildSrc"), { recursive: true })
    expect(() => verifyAndroidProject(root)).toThrow()
  })

  it("requires the app's own ProGuard rules despite the project-wide missing-file compatibility switch", () => {
    const root = fixture()
    const rules = join(root, "app/proguard-rules.pro")
    rmSync(rules)
    expect(() => verifyAndroidProject(root)).toThrow("proguard-rules.pro")
    mkdirSync(rules)
    expect(() => verifyAndroidProject(root)).toThrow("not regular")
  })

  it("rejects conflicting duplicate properties", () => {
    const root = fixture()
    const file = join(root, "gradle.properties")
    writeFileSync(file, readFileSync(file, "utf8") + "\nandroid.newDsl=true\n")
    expect(() => verifyAndroidProject(root)).toThrow("Duplicate Android property: android.newDsl")
  })

  it("rejects malformed declarations and nonregular project files", () => {
    const root = fixture()
    change(root, "gradle.properties", "android.newDsl=false", "unsupported property")
    expect(() => verifyAndroidProject(root)).toThrow("Unsupported Android property declaration")
    rmSync(join(root, "build.gradle.kts"))
    mkdirSync(join(root, "build.gradle.kts"))
    expect(() => verifyAndroidProject(root)).toThrow("not regular")
    rmSync(join(root, "build.gradle.kts"), { recursive: true })
    writeFileSync(join(root, "build.gradle.kts"), "")
    expect(() => verifyAndroidProject(root)).toThrow("declaration must occur exactly once")
  })

  it("runs the CLI entry only for its own path and exposes prebuild failure", () => {
    const root = fixture()
    const helper = resolve(import.meta.dirname, "verify-android-project.mjs")
    let stdout = ""
    let stderr = ""
    const runtime = {
      exitCode: 0,
      stdout: { write: (text: string) => { stdout += text } },
      stderr: { write: (text: string) => { stderr += text } },
    }
    expect(runIfMain(pathToFileURL(helper).href, undefined, ["--project", root], runtime)).toBe(false)
    expect(runIfMain(pathToFileURL(helper).href, `${helper}.other`, ["--project", root], runtime)).toBe(false)
    expect(runIfMain(pathToFileURL(helper).href, helper, ["--project", root], runtime)).toBe(true)
    expect(JSON.parse(stdout).failOnMissingProguardFiles).toBe(false)
    expect(runIfMain(pathToFileURL(helper).href, helper, [], runtime)).toBe(true)
    expect(runtime.exitCode).toBe(1)
    expect(stderr).toContain("Expected --project")
  })

  it("runs the actual CLI with generated files and fails before build on incompatible configuration", () => {
    const root = fixture()
    const helper = resolve(import.meta.dirname, "verify-android-project.mjs")
    const valid = spawnSync(process.execPath, [helper, "--project", root], { encoding: "utf8" })
    expect(valid.status, valid.stderr).toBe(0)
    expect(JSON.parse(valid.stdout).gradle).toBe(selected.gradle)
    change(root, "gradle.properties", "android.builtInKotlin=false", "android.builtInKotlin=true")
    const invalid = spawnSync(process.execPath, [helper, "--project", root], { encoding: "utf8" })
    expect(invalid.status).not.toBe(0)
    expect(invalid.stderr).toContain("android.builtInKotlin=false")
  })

  it("rejects the real Java11/Kotlin1.8 release blocker through the prebuild CLI", () => {
    const root = fixture()
    const helper = resolve(import.meta.dirname, "verify-android-project.mjs")
    change(root, "app/build.gradle.kts", 'jvmTarget = "11"', 'jvmTarget = "1.8"')
    const invalid = spawnSync(process.execPath, [helper, "--project", root], { encoding: "utf8" })
    expect(invalid.status).not.toBe(0)
    expect(invalid.stdout).toBe("")
    expect(invalid.stderr).toContain("Android application requires explicit Java/Kotlin JVM target 11 (Kotlin target)")
  })

  it("rejects the original FIR-triggering script form through the prebuild CLI", () => {
    const root = fixture()
    const helper = resolve(import.meta.dirname, "verify-android-project.mjs")
    change(root, "app/build.gradle.kts", 'apply(from = file("tauri.build.gradle.kts"))', 'apply(from = "tauri.build.gradle.kts")')
    const invalid = spawnSync(process.execPath, [helper, "--project", root], { encoding: "utf8" })
    expect(invalid.status).not.toBe(0)
    expect(invalid.stdout).toBe("")
    expect(invalid.stderr).toContain("must apply the generated Tauri script once through file()")
  })
})
