import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeReasoningCatalog } from "../../contract.js";
import { normalizeRuntimeModelId, RUNTIME_MODEL_CATALOG_MAX } from "../../internal/modelCatalog.js";
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

export function parseAgyModelCatalog(output: string): RuntimeReasoningCatalog | undefined {
  const models: RuntimeReasoningCatalog["models"][number][] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\t+(.+)$/);
    const id = normalizeRuntimeModelId(match?.[1]);
    const displayName = match?.[2]?.trim();
    if (!id || !displayName || seen.has(id)) continue;
    if (models.length === RUNTIME_MODEL_CATALOG_MAX) break;
    seen.add(id);
    models.push({ id, displayName: displayName.slice(0, 256), supportedReasoningEfforts: [] });
  }
  return models.length ? { updateMode: "unsupported", models } : undefined;
}

async function readAgyCommand(spec: ReturnType<typeof agySpawnSpec>, args: string[], includeStderr: boolean): Promise<string> {
  const child = spawnAgentProcess(spec.command, args, { cwd: process.cwd(), env: { ...process.env, CI: "1", AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, shell: spec.shell, stdin: "ignore" });
  try {
    return await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("timeout")), includeStderr ? 5_000 : 30_000);
      const fail = () => { clearTimeout(timer); reject(new Error("command failed")); };
      const collect = (chunk: { toString(): string }) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > (includeStderr ? 64 * 1024 : 1024 * 1024)) fail();
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", includeStderr ? collect : () => {});
      child.on("error", fail);
      child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(output); else fail(); });
    });
  } finally { if (child.pid) await killProcessTree(child.pid, { graceMs: 100 }); }
}

export async function probeAgy(command?: string, includeModels = false): Promise<ProbeResult> {
  const spec = agySpawnSpec(command);
  const version = probeCommandVersion(spec.command);
  if (!version.ok) return { status: "unhealthy", lastError: version.error };
  let help: string;
  try { help = await readAgyCommand(spec, ["--help"], true); }
  catch { return { status: "unhealthy", version: version.version, lastError: "agy_stream_probe_failed" }; }
  if (!["--input-format", "--output-format", "stream-json", "--conversation"].every((flag) => help.includes(flag))) {
    return { status: "unhealthy", version: version.version, lastError: "agy_stream_incompatible" };
  }
  if (!includeModels || !/\bmodels\b/.test(help)) return { status: "healthy", version: version.version };
  try {
    const reasoning = parseAgyModelCatalog(await readAgyCommand(spec, ["models"], false));
    return reasoning ? { status: "healthy", version: version.version, reasoning }
      : { status: "unhealthy", version: version.version, lastError: "agy_model_catalog_invalid" };
  } catch { return { status: "unhealthy", version: version.version, lastError: "agy_model_probe_failed" }; }
}
