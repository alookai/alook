import type { RuntimeReasoningCatalog } from "../../contract.js";
import type { SpawnedProcessHandle } from "../../internal/adapter.js";
import { killProcessTree, spawnAgentProcess } from "../../internal/killTree.js";
import { normalizeRuntimeModelId, RUNTIME_MODEL_CATALOG_MAX } from "../../internal/modelCatalog.js";
import { resolveSpawnSpec } from "../../internal/probe.js";
import { asRecord, jsonRpcRequest, tryParseJsonLine } from "../../internal/utils.js";

const ACP_PROTOCOL_VERSION = 1;
const AUTH_METHOD_ID = "cached_token";
const INTERACTIVE_AUTH_METHOD_IDS = new Set(["grok.com"]);
const CATALOG_PROBE_TIMEOUT_MS = 15_000;
const CATALOG_NOTIFICATION_GRACE_MS = 50;
const CATALOG_PROBE_OUTPUT_MAX_BYTES = 1024 * 1024;
const MODEL_DISPLAY_NAME_MAX = 256;
const DESCRIPTION_MAX = 512;

type ProbeSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean },
) => SpawnedProcessHandle;

interface GrokAcpCatalogProbeOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly outputMaxBytes?: number;
  readonly catalogGraceMs?: number;
  readonly spawn?: ProbeSpawn;
  readonly cleanup?: (process: SpawnedProcessHandle) => Promise<void>;
}

export type GrokAcpProbeResult =
  | { readonly status: "compatible"; readonly reasoning?: RuntimeReasoningCatalog }
  | {
      readonly status: "unhealthy";
      readonly lastError:
        | "grok_acp_spawn_failed"
        | "grok_acp_transport_unavailable"
        | "grok_acp_invalid_response"
        | "grok_acp_initialize_failed"
        | "grok_acp_protocol_incompatible"
        | "grok_acp_load_session_unsupported"
        | "grok_acp_cached_auth_unsupported"
        | "grok_acp_authentication_failed"
        | "grok_acp_output_limit"
        | "grok_acp_process_failed"
        | "grok_acp_probe_failed"
        | "grok_acp_probe_timeout";
    };

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function modelMeta(model: Record<string, unknown>): Record<string, unknown> {
  return asRecord(model._meta) ?? asRecord(model.meta) ?? {};
}

function reasoningCatalog(model: Record<string, unknown>) {
  const meta = modelMeta(model);
  if (meta.supportsReasoningEffort !== true) {
    return { supportedReasoningEfforts: [] as RuntimeReasoningCatalog["models"][number]["supportedReasoningEfforts"] };
  }
  const raw = Array.isArray(meta.reasoningEfforts)
    ? meta.reasoningEfforts
    : Array.isArray(meta.reasoning_efforts)
      ? meta.reasoning_efforts
      : [];
  const seen = new Set<string>();
  const supportedReasoningEfforts: RuntimeReasoningCatalog["models"][number]["supportedReasoningEfforts"][number][] = [];
  let markedDefault: string | undefined;
  for (const item of raw) {
    const row = typeof item === "string" ? { value: item } : asRecord(item);
    const value = normalizeRuntimeModelId(row?.value ?? row?.id);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const description = boundedText(row?.description, DESCRIPTION_MAX);
    supportedReasoningEfforts.push({ value, ...(description ? { description } : {}) });
    if (row?.default === true) markedDefault = value;
  }
  const reportedDefault = normalizeRuntimeModelId(meta.reasoningEffort ?? meta.reasoning_effort);
  const defaultReasoningEffort = [reportedDefault, markedDefault]
    .find((value) => value && seen.has(value));
  return {
    supportedReasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  };
}

export function parseGrokModelCatalog(value: unknown): RuntimeReasoningCatalog | undefined {
  const snapshot = asRecord(value);
  const available = Array.isArray(snapshot?.availableModels) ? snapshot.availableModels : [];
  const seen = new Set<string>();
  const models: RuntimeReasoningCatalog["models"][number][] = [];
  for (const item of available) {
    const model = asRecord(item);
    const id = normalizeRuntimeModelId(model?.modelId);
    if (!model || !id || seen.has(id)) continue;
    if (models.length >= RUNTIME_MODEL_CATALOG_MAX) return undefined;
    seen.add(id);
    const displayName = boundedText(model.name, MODEL_DISPLAY_NAME_MAX);
    models.push({ id, ...(displayName ? { displayName } : {}), ...reasoningCatalog(model) });
  }
  if (models.length === 0) return undefined;
  const currentModelId = normalizeRuntimeModelId(snapshot?.currentModelId);
  return {
    updateMode: "live_next_turn",
    ...(currentModelId && seen.has(currentModelId) ? { defaultModelId: currentModelId } : {}),
    models,
  };
}

function catalogFromInitialize(result: Record<string, unknown>): RuntimeReasoningCatalog | undefined {
  const meta = asRecord(result._meta) ?? asRecord(result.meta);
  return parseGrokModelCatalog(meta?.modelState);
}

async function cleanupProbeProcess(process: SpawnedProcessHandle): Promise<void> {
  if (process.pid) {
    await killProcessTree(process.pid, { graceMs: 250 }).catch(() => {});
    return;
  }
  if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
}

export async function probeGrokAcpCatalog(
  command?: string,
  options: GrokAcpCatalogProbeOptions = {},
): Promise<GrokAcpProbeResult> {
  const cwd = options.cwd ?? process.cwd();
  const spec = resolveSpawnSpec("grok", ["agent", "--no-leader", "stdio"], command);
  let processHandle: SpawnedProcessHandle;
  try {
    processHandle = (options.spawn ?? spawnAgentProcess)(spec.command, spec.args, {
      cwd,
      env: { ...process.env, CI: "1", GROK_DISABLE_AUTOUPDATER: "1" },
      shell: spec.shell,
    });
  } catch {
    return { status: "unhealthy", lastError: "grok_acp_spawn_failed" };
  }

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let outputBytes = 0;
    let expectedId = 1;
    let authenticated = false;
    let catalog: RuntimeReasoningCatalog | undefined;
    let catalogGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: GrokAcpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (catalogGraceTimer) clearTimeout(catalogGraceTimer);
      const cleanup = options.cleanup ?? cleanupProbeProcess;
      void Promise.resolve().then(() => cleanup(processHandle)).catch(() => {}).finally(() => resolve(value));
    };
    const write = (method: string, params: Record<string, unknown>, id: number) => {
      const stdin = processHandle.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded || stdin.writable === false) {
        return finish({ status: "unhealthy", lastError: "grok_acp_transport_unavailable" });
      }
      try {
        stdin.write(`${jsonRpcRequest(method, params, id)}\n`);
      } catch {
        finish({ status: "unhealthy", lastError: "grok_acp_transport_unavailable" });
      }
    };
    const onLine = (line: string) => {
      const message = asRecord(tryParseJsonLine(line));
      if (!message) return finish({ status: "unhealthy", lastError: "grok_acp_invalid_response" });
      if (typeof message.method === "string") {
        if (message.method === "_x.ai/models/update" || message.method === "x.ai/models/update") {
          catalog = parseGrokModelCatalog(message.params) ?? catalog;
          if (authenticated && catalog) finish({ status: "compatible", reasoning: catalog });
        }
        return;
      }
      if (message.id !== expectedId) return;
      if (message.error !== undefined) {
        return finish({
          status: "unhealthy",
          lastError: expectedId === 1
            ? "grok_acp_initialize_failed"
            : "grok_acp_authentication_failed",
        });
      }
      if (!("result" in message)) {
        return finish({ status: "unhealthy", lastError: "grok_acp_invalid_response" });
      }
      const result = asRecord(message.result) ?? {};
      if (expectedId === 1) {
        const capabilities = asRecord(result.agentCapabilities);
        const methods = Array.isArray(result.authMethods) ? result.authMethods : [];
        const methodIds = methods.flatMap((method) => {
          const id = asRecord(method)?.id;
          return typeof id === "string" ? [id] : [];
        });
        if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
          return finish({ status: "unhealthy", lastError: "grok_acp_protocol_incompatible" });
        }
        if (capabilities?.loadSession !== true) {
          return finish({ status: "unhealthy", lastError: "grok_acp_load_session_unsupported" });
        }
        if (!methodIds.includes(AUTH_METHOD_ID)) {
          if (methodIds.some((id) => INTERACTIVE_AUTH_METHOD_IDS.has(id))) {
            return finish({ status: "unhealthy", lastError: "grok_acp_authentication_failed" });
          }
          return finish({ status: "unhealthy", lastError: "grok_acp_cached_auth_unsupported" });
        }
        catalog = catalogFromInitialize(result) ?? catalog;
        expectedId = 2;
        write("authenticate", { methodId: AUTH_METHOD_ID }, expectedId);
        return;
      }
      authenticated = true;
      if (catalog) return finish({ status: "compatible", reasoning: catalog });
      catalogGraceTimer = setTimeout(
        () => finish({ status: "compatible" }),
        options.catalogGraceMs ?? CATALOG_NOTIFICATION_GRACE_MS,
      );
      catalogGraceTimer.unref?.();
    };

    const timer = setTimeout(
      () => finish({ status: "unhealthy", lastError: "grok_acp_probe_timeout" }),
      options.timeoutMs ?? CATALOG_PROBE_TIMEOUT_MS,
    );
    timer.unref?.();
    processHandle.stdout?.on("data", (chunk) => {
      if (settled) return;
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > (options.outputMaxBytes ?? CATALOG_PROBE_OUTPUT_MAX_BYTES)) {
        return finish({ status: "unhealthy", lastError: "grok_acp_output_limit" });
      }
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
    });
    processHandle.stderr?.on("data", (chunk) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk.toString());
      if (outputBytes > (options.outputMaxBytes ?? CATALOG_PROBE_OUTPUT_MAX_BYTES)) {
        finish({ status: "unhealthy", lastError: "grok_acp_output_limit" });
      }
    });
    const finishFromProcess = () => finish({
      status: "unhealthy",
      lastError: "grok_acp_process_failed",
    });
    processHandle.on("error", finishFromProcess);
    processHandle.on("exit", finishFromProcess);
    write("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "alook-agent-driver-probe", version: "0.1.31" },
    }, expectedId);
  });
}
