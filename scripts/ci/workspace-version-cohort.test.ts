import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { expect, it } from "vitest"
import { workspacePackageRoots } from "../workspace-packages.mjs"
import { isolatedRepositoryGitEnvironment } from "./repository-git.mjs"

it("bumps the manifest cohort including Storybook while retaining independent packages and optional release triggers", () => {
  const repository = resolve(import.meta.dirname, "../.."), root = mkdtempSync(resolve(tmpdir(), "alook-version-cohort-"))
  const write = (file: string, contents: string) => { const target = resolve(root, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, contents) }
  const read = (file: string) => readFileSync(resolve(root, file), "utf8")
  const roots = workspacePackageRoots(repository)
  const env = isolatedRepositoryGitEnvironment()
  expect(roots).toEqual(["src/shared", "src/daemon", "src/daemon/agent-driver", "src/web", "src/email-worker", "src/ws-do", "src/queue-worker", "src/app", "src/desktop", "tests/utils", "src/storybook"])
  try {
    write("pnpm-workspace.yaml", readFileSync(resolve(repository, "pnpm-workspace.yaml"), "utf8"))
    for (const name of ["bump-version.mjs", "workspace-packages.mjs"]) write(`scripts/${name}`, readFileSync(resolve(repository, "scripts", name), "utf8"))
    for (const directory of [...roots, "src/benchmark", "src/videos/gtm"]) write(`${directory}/package.json`, JSON.stringify({ name: directory, version: directory === "src/shared" ? "0.1.9" : "0.0.2" }))
    write("src/desktop/src-tauri/tauri.conf.json", JSON.stringify({ version: "0.1.9" }))
    write("src/desktop/src-tauri/gen/apple/project.yml", "settings:\n  CFBundleShortVersionString: 0.1.9\n")
    write("src/desktop/src-tauri/Cargo.toml", '[package]\nname = "alook-desktop"\nversion = "0.1.9"\n')
    write("src/desktop/src-tauri/Cargo.lock", '[[package]]\nname = "alook-desktop"\nversion = "0.1.9"\n')
    write("src/desktop/.deploy-version", "keep-desktop\n")
    write("src/desktop/.deploy-version-mobile", "keep-mobile\n")
    write("src/web/wrangler.toml", '[vars]\nMIN_CLI_VERSION = "0.0.1"\n')
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, stdio: "pipe" })
    git("init", "--quiet")
    git("config", "user.name", "Version fixture")
    git("config", "user.email", "fixture@example.test")
    git("config", "commit.gpgsign", "false")
    execFileSync(process.execPath, [resolve(root, "scripts/bump-version.mjs"), "patch"], { cwd: root, env, stdio: "pipe", timeout: 15_000 })
    for (const directory of roots) expect(JSON.parse(read(`${directory}/package.json`)).version).toBe(directory === "tests/utils" ? "0.0.2" : "0.1.10")
    for (const directory of ["src/benchmark", "src/videos/gtm"]) expect(JSON.parse(read(`${directory}/package.json`)).version).toBe("0.0.2")
    for (const directory of ["src/web", "src/email-worker", "src/ws-do", "src/queue-worker"]) expect(read(`${directory}/.deploy-version`)).toBe("0.1.10\n")
    expect(JSON.parse(read("src/desktop/src-tauri/tauri.conf.json")).version).toBe("0.1.10")
    expect(read("src/desktop/src-tauri/gen/apple/project.yml")).toContain("CFBundleShortVersionString: 0.1.10")
    expect(read("src/desktop/.deploy-version")).toBe("keep-desktop\n")
    expect(read("src/desktop/.deploy-version-mobile")).toBe("keep-mobile\n")
    expect(read("src/web/wrangler.toml")).toContain('MIN_CLI_VERSION = "0.0.1"')
    expect(git("log", "-1", "--format=%s").toString().trim()).toBe("release: v0.1.10")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
