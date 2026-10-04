import type { ProbeResult, SpawnedProcessHandle } from "../../internal/adapter.js";
import { killProcessTree, spawnAgentProcess } from "../../internal/killTree.js";
import { asRecord } from "../../internal/utils.js";
import { resolveSpawnSpec } from "../../internal/probe.js";

export function antigravitySpawnSpec(command?: string, platform = process.platform): { command: string; args: string[]; shell: boolean } {
  return resolveSpawnSpec(platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par", platform === "linux" ? ["--uid="] : [], command);
}

type ProbeOptions = {
  timeoutMs?: number;
  spawn?: typeof spawnAgentProcess;
  cleanup?: (proc: SpawnedProcessHandle) => Promise<void>;
};

export async function probeAntigravity(command?: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const spec = antigravitySpawnSpec(command);
  let proc: SpawnedProcessHandle;
  try {
    proc = (options.spawn ?? spawnAgentProcess)(spec.command, spec.args, {
      cwd: process.cwd(), env: { ...process.env, CI: "1" }, shell: spec.shell,
    });
  } catch {
    return { status: "unhealthy", lastError: "antigravity_acp_spawn_failed" };
  }
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let bytes = 0;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cleanup = options.cleanup ?? (async (child: SpawnedProcessHandle) => {
        if (child.pid) await killProcessTree(child.pid, { graceMs: 250 });
        else child.kill("SIGTERM");
      });
      void cleanup(proc).then(() => resolve(result), () => resolve({ status: "unhealthy", lastError: "antigravity_acp_cleanup_failed" }));
    };
    const fail = (lastError: string) => finish({ status: "unhealthy", lastError });
    const timer = setTimeout(() => fail("antigravity_acp_timeout"), options.timeoutMs ?? 10_000);
    proc.on("error", () => fail("antigravity_acp_spawn_failed"));
    proc.on("exit", () => fail("antigravity_acp_process_exited"));
    proc.stderr?.on("data", () => {});
    proc.stdout?.on("data", (chunk) => {
      if (settled) return;
      const text = chunk.toString();
      bytes += Buffer.byteLength(text);
      if (bytes > 1024 * 1024) return fail("antigravity_acp_output_limit");
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: Record<string, unknown> | null;
        try { message = asRecord(JSON.parse(line)); } catch { return fail("antigravity_acp_invalid_json"); }
        if (message?.id !== 1) continue;
        const result = asRecord(message.result);
        if (message.jsonrpc !== "2.0" || message.error || result?.protocolVersion !== 1
          || asRecord(result.agentCapabilities)?.loadSession !== true
          || asRecord(result.agentInfo)?.name !== "antigravity-acp") return fail("antigravity_acp_incompatible");
        const version = asRecord(result.agentInfo)?.version;
        finish({ status: "healthy", ...(typeof version === "string" ? { version } : {}) });
      }
    });
    try {
      if (!proc.stdin || proc.stdin.destroyed || proc.stdin.writableEnded || proc.stdin.writable === false) return fail("antigravity_acp_stdin_closed");
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "alook-agent-driver", version: "1" },
      } })}\n`);
    } catch { fail("antigravity_acp_write_failed"); }
  });
}
