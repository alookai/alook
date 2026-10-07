import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { runIfMain, verifyAndroidProject } from "./verify-android-project.mjs"

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
  writeFileSync(join(root, "buildSrc/build.gradle.kts"), 'plugins { `kotlin-dsl` }\ndependencies {\n    implementation("com.android.tools.build:gradle:9.3.1")\n}\n')
  mkdirSync(join(root, "gradle/wrapper"), { recursive: true })
  writeFileSync(join(root, "gradle/wrapper/gradle-wrapper.properties"), 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.6.1-bin.zip\n')
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
      agp: "9.3.1", supportAgp: "9.3.1", kotlin: "2.2.10", gradle: "9.6.1", builtInKotlin: false, newDsl: false, failOnMissingProguardFiles: false,
    })
    expect(readFileSync(join(root, "app/build.gradle.kts"))).toEqual(app)
    expect(readFileSync(join(root, "app/src/main/AndroidManifest.xml"))).toEqual(manifest)
  })

  it.each([
    ["build.gradle.kts", "gradle:9.3.1", "gradle:8.11.0"],
    ["build.gradle.kts", "kotlin-gradle-plugin:2.2.10", "kotlin-gradle-plugin:1.9.25"],
    ["buildSrc/build.gradle.kts", "gradle:9.3.1", "gradle:8.11.0"],
    ["gradle/wrapper/gradle-wrapper.properties", "gradle-9.6.1-bin.zip", "gradle-8.14.3-bin.zip"],
  ])("rejects incompatible post-init declaration in %s", (file, before, after) => {
    const root = fixture()
    change(root, file, before, after)
    expect(() => verifyAndroidProject(root)).toThrow("Android toolchain must match")
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
    expect(JSON.parse(valid.stdout).gradle).toBe("9.6.1")
    change(root, "gradle.properties", "android.builtInKotlin=false", "android.builtInKotlin=true")
    const invalid = spawnSync(process.execPath, [helper, "--project", root], { encoding: "utf8" })
    expect(invalid.status).not.toBe(0)
    expect(invalid.stderr).toContain("android.builtInKotlin=false")
  })
})
