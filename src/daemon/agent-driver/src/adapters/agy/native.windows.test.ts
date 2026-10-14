import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentDriverSdk } from "../../index.js";
import { resolveCommandOnPath } from "../../internal/probe.js";
import { agySpawnSpec } from "./probe.js";

const roots: string[] = [];
const native = process.env.ALOOK_NATIVE_AGY_PATH;
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe.skipIf(process.platform !== "win32" || !native)("official Windows agy 1.3.4", () => {
  it.each(["PATH", "standard", "redirected", "explicit"])("discovers the real binary through %s", async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "Alook agy native QA "));
    roots.push(root);
    const home = join(root, "profile");
    const local = mode === "redirected" ? join(root, "redirected local data") : join(home, "AppData", "Local");
    const entry = mode === "explicit" ? join(root, "custom install", "agy.exe") : join(local, "agy", "bin", "agy.exe");
    mkdirSync(dirname(entry), { recursive: true });
    mkdirSync(home, { recursive: true });
    copyFileSync(native!, entry);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("LOCALAPPDATA", local);
    vi.stubEnv("CI", "1");
    vi.stubEnv("GEMINI_API_KEY", undefined);
    vi.stubEnv("GOOGLE_API_KEY", undefined);
    const system = process.env.SystemRoot!;
    vi.stubEnv("PATH", [...(mode === "PATH" ? [dirname(entry)] : []), join(system, "System32"), join(system, "System32", "WindowsPowerShell", "v1.0"), dirname(process.execPath)].join(delimiter));
    const found = resolveCommandOnPath("agy");
    const { dev, ino } = statSync(entry);
    if (mode === "PATH") expect(statSync(found!)).toMatchObject({ dev, ino });
    else expect(found).toBeNull();
    const command = mode === "explicit" ? entry : undefined;
    expect(statSync(agySpawnSpec(command).command)).toMatchObject({ dev, ino });
    const sdk = createAgentDriverSdk();
    const result = await sdk.probe({ backend: "agy", includeModels: false, ...(command ? { command } : {}) });
    console.log(JSON.stringify({ mode, status: result.status, version: result.status === "healthy" ? result.version : undefined, errorCode: result.status === "unhealthy" ? result.error.code : undefined }));
    expect(result).toMatchObject({ status: "healthy", version: "1.3.4" });
    console.log(JSON.stringify({ backend: "agy", mode, os: release(), node: process.version,
      sha512: createHash("sha512").update(readFileSync(entry)).digest("hex"), version: "1.3.4", probe: "healthy", includeModels: false }));
  }, 60_000);
});
