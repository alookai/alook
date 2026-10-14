import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agySpawnSpec, probeAgy } from "./probe.js";

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), "alook-agy-probe-")); directories.push(path); return path; }

describe("official agy entry", () => {
  it("respects explicit commands and prefers PATH over the official installation", () => {
    const home = directory();
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "agy"), "installed");
    const deps = { homeDir: home, which: () => "/path/agy" };
    expect(agySpawnSpec("/custom/cli", deps, "darwin")).toMatchObject({ command: "/custom/cli", shell: false });
    expect(agySpawnSpec(undefined, deps, "darwin")).toMatchObject({ command: "/path/agy" });
    expect(agySpawnSpec(undefined, { homeDir: home, which: () => null }, "darwin")).toMatchObject({ command: join(bin, "agy") });
  });
  it("finds the Windows native installation and supports explicit shim paths", () => {
    const home = directory();
    const bin = join(home, "AppData", "Local", "agy", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "agy.exe"), "installed");
    vi.stubEnv("LOCALAPPDATA", undefined);
    expect(agySpawnSpec(undefined, { homeDir: home, which: () => null }, "win32")).toMatchObject({ command: join(bin, "agy.exe"), shell: false });
    const redirected = join(directory(), "redirected local data");
    const entry = join(redirected, "agy", "bin", "agy.exe");
    mkdirSync(join(redirected, "agy", "bin"), { recursive: true });
    writeFileSync(entry, "redirected installation");
    vi.stubEnv("LOCALAPPDATA", redirected);
    expect(agySpawnSpec(undefined, { homeDir: home, which: () => null }, "win32")).toMatchObject({ command: entry, shell: false });
    expect(agySpawnSpec(undefined, { homeDir: home, which: () => "C:\\path\\agy.exe" }, "win32")).toMatchObject({ command: "C:\\path\\agy.exe" });
    expect(agySpawnSpec("C:\\custom cli\\agy.cmd", {}, "win32")).toMatchObject({ shell: true });
  });
  it.skipIf(process.platform === "win32")("requires actual stream flags and captures native stderr help", async () => {
    const file = join(directory(), "agy");
    const script = (help: string, hang = false) => `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('1.3.4')}else{process.stderr.write(${JSON.stringify(help)});${hang ? "setInterval(()=>{},1000);" : ""}}\n`;
    writeFileSync(file, script("--input-format --output-format stream-json --conversation"), { mode: 0o755 });
    expect(await probeAgy(file)).toEqual({ status: "healthy", version: "1.3.4" });
    writeFileSync(file, script("ordinary CLI"), { mode: 0o755 });
    expect(await probeAgy(file)).toMatchObject({ status: "unhealthy", lastError: "agy_stream_incompatible" });
    writeFileSync(file, script("x".repeat(65537)), { mode: 0o755 });
    expect(await probeAgy(file)).toMatchObject({ status: "unhealthy", lastError: "agy_stream_probe_failed" });
    writeFileSync(file, script("", true), { mode: 0o755 });
    expect(await probeAgy(file)).toMatchObject({ status: "unhealthy", lastError: "agy_stream_probe_failed" });
    expect(await probeAgy(join(directory(), "missing"))).toMatchObject({ status: "unhealthy" });
  });
});
