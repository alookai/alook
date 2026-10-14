import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProbeResult } from "../../internal/adapter.js";
import { killProcessTree, spawnAgentProcess } from "../../internal/killTree.js";
import { probeCommandVersion, resolveCommandOnPath, resolveSpawnSpec, type ProbeDeps } from "../../internal/probe.js";

export function agySpawnSpec(command?: string, deps: ProbeDeps = {}, platform = process.platform): { command: string; args: string[]; shell: boolean } {
  const explicit = command?.trim();
  if (explicit) return resolveSpawnSpec("agy", [], explicit, deps, platform);
  const home = deps.homeDir ?? homedir();
  const installed = platform === "win32" ? join(process.env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "agy", "bin", "agy.exe") : join(home, ".local", "bin", "agy");
  const selected = resolveCommandOnPath("agy", deps) ?? (existsSync(installed) ? installed : "agy");
  return resolveSpawnSpec("agy", [], selected, deps, platform);
}

export async function probeAgy(command?: string): Promise<ProbeResult> {
  const spec = agySpawnSpec(command);
  const version = probeCommandVersion(spec.command);
  if (!version.ok) return { status: "unhealthy", lastError: version.error };
  const child = spawnAgentProcess(spec.command, ["--help"], { cwd: process.cwd(), env: { ...process.env, CI: "1" }, shell: spec.shell, stdin: "ignore" });
  try {
    const help = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("timeout")), 3_000);
      const fail = () => { clearTimeout(timer); reject(new Error("help failed")); };
      const collect = (chunk: { toString(): string }) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > 64 * 1024) fail();
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", fail);
      child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(output); else fail(); });
    });
    return ["--input-format", "--output-format", "stream-json", "--conversation"].every((flag) => help.includes(flag))
      ? { status: "healthy", version: version.version }
      : { status: "unhealthy", version: version.version, lastError: "agy_stream_incompatible" };
  } catch { return { status: "unhealthy", version: version.version, lastError: "agy_stream_probe_failed" }; }
  finally { if (child.pid) await killProcessTree(child.pid, { graceMs: 100 }); }
}
