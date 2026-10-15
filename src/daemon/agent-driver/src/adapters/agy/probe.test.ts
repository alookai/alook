import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agySpawnSpec, probeAgy, parseAgyModelCatalog } from "./probe.js";
import { createAgentDriverSdk } from "../../index.js";

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


describe("AGY on-demand native catalog", () => {
  it.skipIf(process.platform === "win32")("rejects a successful native command with no usable model rows", async () => {
    const command = join(directory(), "agy");
    writeFileSync(command, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('1.3.5');else if(process.argv.includes('--help'))console.error('--input-format --output-format stream-json --conversation models');else console.log('No available models');\n`, { mode: 0o755 });
    expect(await createAgentDriverSdk().probe({ backend: "agy", command })).toMatchObject({ status: "unhealthy", error: { code: "agy_model_catalog_invalid" } });
  });
  it.skipIf(process.platform === "win32")("keeps installation healthy when the native catalog requires authentication", async () => {
    const root = directory();
    const command = join(root, "agy");
    const calls = join(root, "calls");
    writeFileSync(command, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},process.argv[2]+String.fromCharCode(10));if(process.argv.includes('--version'))console.log('1.3.4');else if(process.argv.includes('--help'))console.error('--input-format --output-format stream-json --conversation models');else{console.error('Please sign in to view available models');process.exit(1);}\n`, { mode: 0o755 });
    const sdk = createAgentDriverSdk();
    expect(await sdk.probe({ backend: "agy", command, includeModels: false })).toMatchObject({ status: "healthy", version: "1.3.4" });
    expect(readFileSync(calls, "utf8")).toBe("--version\n--help\n");
    expect(await sdk.probe({ backend: "agy", command })).toMatchObject({ status: "unhealthy", error: { code: "agy_model_probe_failed" } });
    expect(readFileSync(calls, "utf8")).toBe("--version\n--help\n--version\n--help\nmodels\n");
    expect(await sdk.probe({ backend: "agy", command, includeModels: false })).toMatchObject({ status: "healthy", version: "1.3.4" });
  });
  it("reads TSV output, rejects diagnostics, deduplicates and bounds models", () => {
    expect(parseAgyModelCatalog("Fetching models...\nmodel-high\tNative high\nmodel-high\tDuplicate\nmodel-low\tNative low\n")).toEqual({ updateMode: "unsupported", models: [
      { id: "model-high", displayName: "Native high", supportedReasoningEfforts: [] },
      { id: "model-low", displayName: "Native low", supportedReasoningEfforts: [] },
    ] });
    expect(parseAgyModelCatalog(Array.from({ length: 1025 }, (_, index) => `model-${index}\tNative ${index}`).join("\n"))?.models).toHaveLength(1024);
    expect(parseAgyModelCatalog("Sign in first")).toBeUndefined();
  });
  it.skipIf(process.platform === "win32")("runs models only for an explicit catalog probe", async () => {
    const root = directory();
    const file = join(root, "agy");
    const calls = join(root, "calls");
    writeFileSync(file, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},process.argv[2]+String.fromCharCode(10));if(process.argv.includes('--version'))console.log('1.3.5');else if(process.argv.includes('--help'))console.error('--input-format --output-format stream-json --conversation models');else if(process.argv.includes('models')){console.error('Fetching models...');console.log('native-model\tNative Model');}\n`, { mode: 0o755 });
    expect(await probeAgy(file, false)).toEqual({ status: "healthy", version: "1.3.5" });
    expect(readFileSync(calls, "utf8")).toBe("--version\n--help\n");
    expect(await probeAgy(file, true)).toMatchObject({ status: "healthy", reasoning: { models: [{ id: "native-model", displayName: "Native Model" }] } });
    expect(readFileSync(calls, "utf8")).toBe("--version\n--help\n--version\n--help\nmodels\n");
  });
})
