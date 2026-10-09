import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAntigravityCatalog, antigravityReasoningCatalog } from "./catalog.js";
import type { ProbeResult, SpawnedProcessHandle } from "../../internal/adapter.js";
import { killProcessTree, spawnAgentProcess } from "../../internal/killTree.js";
import { asRecord } from "../../internal/utils.js";
import { resolveSpawnSpec } from "../../internal/probe.js";

export function antigravitySpawnSpec(command?: string, platform = process.platform): { command: string; args: string[]; shell: boolean } {
  return resolveSpawnSpec(platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par", platform === "linux" ? ["--uid="] : [], command);
}

type ProbeOptions = {
  timeoutMs?: number;
  cacheDirectory?: string;
  spawn?: typeof spawnAgentProcess;
  cleanup?: (proc: SpawnedProcessHandle) => Promise<void>;
};

export async function probeAntigravity(command?: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const spec = antigravitySpawnSpec(command);
  const identity = createHash("sha256").update(JSON.stringify([spec.command, process.env.GEMINI_HOME ?? ""])).digest("hex").slice(0, 16);
  const directory = options.cacheDirectory ?? join(homedir(), ".cache", "alook", "antigravity-probe", identity);
  const cacheFile = join(directory, "session");
  let cachedSessionId: string | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const value = readFileSync(cacheFile, "utf8");
      if (/^[A-Za-z0-9_-]{1,100}$/.test(value)) cachedSessionId = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch {
    return { status: "unhealthy", lastError: "antigravity_acp_probe_storage_failed" };
  }
  let proc: SpawnedProcessHandle;
  try {
    proc = (options.spawn ?? spawnAgentProcess)(spec.command, spec.args, {
      cwd: directory, env: { ...process.env, CI: "1" }, shell: spec.shell,
    });
  } catch {
    return { status: "unhealthy", lastError: "antigravity_acp_spawn_failed" };
  }
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let bytes = 0;
    let version: string | undefined;
    let sessionRequestId = 0;
    let loading = false;
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
    const timer = setTimeout(() => fail("antigravity_acp_timeout"), options.timeoutMs ?? (process.platform === "win32" ? 30_000 : 10_000));
    const write = (value: unknown) => {
      try {
        if (!proc.stdin || proc.stdin.destroyed || proc.stdin.writableEnded || proc.stdin.writable === false) {
          fail("antigravity_acp_stdin_closed");
          return;
        }
        proc.stdin.write(`${JSON.stringify(value)}\n`);
      } catch { fail("antigravity_acp_write_failed"); }
    };
    const requestSession = (sessionId?: string) => {
      loading = sessionId !== undefined;
      sessionRequestId = sessionRequestId ? sessionRequestId + 1 : 2;
      write({ jsonrpc: "2.0", id: sessionRequestId, method: loading ? "session/load" : "session/new", params: {
        cwd: directory, mcpServers: [], ...(sessionId ? { sessionId } : {}),
      } });
    };
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
        if (settled) return;
        if (!line.trim()) continue;
        let message: Record<string, unknown> | null;
        try { message = asRecord(JSON.parse(line)); } catch { return fail("antigravity_acp_invalid_json"); }
        if (message?.method) {
          if (message.method === "session/request_permission" && (typeof message.id === "number" || typeof message.id === "string")) {
            write({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
          }
          continue;
        }
        if (sessionRequestId && message?.id === sessionRequestId) {
          if (message.jsonrpc !== "2.0" || (!("result" in message) && !("error" in message))) return fail("antigravity_acp_invalid_json");
          const error = asRecord(message.error);
          if (loading && error && (error.code === -32002 || /session.*(?:not found|missing|unknown)/i.test(String(error.message)))) {
            requestSession();
            continue;
          }
          if (error) {
            finish({ status: "healthy", ...(version ? { version } : {}) });
            continue;
          }
          const result = asRecord(message.result);
          const sessionId = loading ? cachedSessionId : result?.sessionId;
          if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)
            || (loading && result?.sessionId !== undefined && result.sessionId !== sessionId)) return fail("antigravity_acp_invalid_session");
          if (!loading) {
            try {
              const temporary = `${cacheFile}.${randomUUID()}.tmp`;
              writeFileSync(temporary, sessionId, { mode: 0o600 });
              renameSync(temporary, cacheFile);
            } catch { return fail("antigravity_acp_probe_storage_failed"); }
          }
          const catalog = parseAntigravityCatalog(result);
          finish({ status: "healthy", ...(version ? { version } : {}),
            ...(catalog ? { reasoning: antigravityReasoningCatalog(catalog) } : {}),
          });
          continue;
        }
        if (message?.id !== 1 || sessionRequestId) continue;
        const result = asRecord(message.result);
        if (message.jsonrpc !== "2.0" || message.error || result?.protocolVersion !== 1
          || asRecord(result.agentCapabilities)?.loadSession !== true
          || asRecord(result.agentInfo)?.name !== "antigravity-acp") return fail("antigravity_acp_incompatible");
        const reportedVersion = asRecord(result.agentInfo)?.version;
        version = typeof reportedVersion === "string" ? reportedVersion : undefined;
        requestSession(cachedSessionId);
      }
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "alook-agent-driver", version: "1" },
    } });
  });
}
