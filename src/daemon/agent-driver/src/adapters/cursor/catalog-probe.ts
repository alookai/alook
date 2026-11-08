import type { RuntimeReasoningCatalog } from "../../contract.js";
import type { SpawnedProcessHandle } from "../../internal/adapter.js";
import { runBoundedDiscoveryProcess, type DiscoveryProcessControl, type DiscoveryProcessDependencies } from "../../internal/discovery-process.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import {
  normalizeRuntimeModelId,
  RUNTIME_MODEL_CATALOG_MAX,
} from "../../internal/modelCatalog.js";
import { resolveSpawnSpec } from "../../internal/probe.js";
import { jsonRpcRequest, tryParseJsonLine } from "../../internal/utils.js";

const ACP_PROTOCOL_VERSION = 1;
const AUTH_METHOD_ID = "cursor_login";
const CATALOG_PROBE_TIMEOUT_MS = 15_000;
const CATALOG_PROBE_OUTPUT_MAX_BYTES = 1024 * 1024;
const MODEL_DISPLAY_NAME_MAX = 256;
const MODEL_OPTION_NESTING_MAX = 16;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function normalizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const displayName = value.trim();
  return displayName && displayName.length <= MODEL_DISPLAY_NAME_MAX ? displayName : undefined;
}

export function flattenCursorAcpSelectOptions(
  value: unknown,
  depth = 0,
): Array<{ value: string; name?: string }> {
  if (!Array.isArray(value) || depth > MODEL_OPTION_NESTING_MAX) return [];
  const options: Array<{ value: string; name?: string }> = [];
  for (const item of value) {
    if (Array.isArray(item)) {
      options.push(...flattenCursorAcpSelectOptions(item, depth + 1));
      continue;
    }
    const candidate = record(item);
    if (!candidate) continue;
    const exactValue = normalizeRuntimeModelId(candidate.value);
    if (exactValue) {
      const name = normalizeDisplayName(candidate.name);
      options.push({ value: exactValue, ...(name ? { name } : {}) });
    }
    if (Array.isArray(candidate.options)) {
      options.push(...flattenCursorAcpSelectOptions(candidate.options, depth + 1));
    }
  }
  return options;
}

export function parseCursorAcpModelCatalog(session: unknown): RuntimeReasoningCatalog | undefined {
  const payload = record(session);
  const configOptions = Array.isArray(payload?.configOptions) ? payload.configOptions : [];
  const modelConfig = configOptions.map(record).find((option) => option?.id === "model") ?? null;
  if (!modelConfig) return undefined;
  const seen = new Set<string>();
  const models: RuntimeReasoningCatalog["models"][number][] = [];
  for (const option of flattenCursorAcpSelectOptions(modelConfig.options)) {
    if (option.value === "default[]" || seen.has(option.value)) continue;
    if (models.length >= RUNTIME_MODEL_CATALOG_MAX) break;
    seen.add(option.value);
    models.push({
      id: option.value,
      ...(option.name ? { displayName: option.name } : {}),
      supportedReasoningEfforts: [],
    });
  }
  return models.length > 0 ? { updateMode: "unsupported", models } : undefined;
}

export async function probeCursorAcpCatalog(
  command?: string,
  options: DiscoveryProcessDependencies = {},
): Promise<RuntimeReasoningCatalog | undefined> {
  const cwd = options.cwd ?? process.cwd();
  const spec = resolveSpawnSpec("cursor-agent", ["acp"], command);
  let processHandle: SpawnedProcessHandle;
  try {
    processHandle = (options.spawn ?? spawnAgentProcess)(spec.command, spec.args, {
      cwd,
      env: { ...process.env, CI: "1" },
      shell: spec.shell,
    });
  } catch {
    return undefined;
  }

  let control: DiscoveryProcessControl<RuntimeReasoningCatalog | undefined>;
  let buffer = "";
  let requestId = 0;
  let expectedId = 0;
  let expectedMethod = "";
  const finish = (catalog?: RuntimeReasoningCatalog) => control.finish(catalog);
  const request = (method: string, params: JsonRecord) => {
    if (control.settled) return;
    expectedId = ++requestId;
    expectedMethod = method;
    control.write(`${jsonRpcRequest(method, params, expectedId)}\n`);
  };
  const onLine = (line: string) => {
    const parsed = tryParseJsonLine(line);
    const message = record(parsed);
    if (!message) return finish();
    if (message.id !== expectedId) return;
    if (message.error !== undefined) return finish();
    if (!Object.prototype.hasOwnProperty.call(message, "result")) return finish();
    if (expectedMethod === "authenticate") {
      request("session/new", { cwd, mcpServers: [] });
      return;
    }
    const result = record(message.result);
    if (!result) return finish();
    if (expectedMethod === "initialize") {
      const authMethods = Array.isArray(result.authMethods) ? result.authMethods : [];
      if (result.protocolVersion !== ACP_PROTOCOL_VERSION
        || !authMethods.some((method) => record(method)?.id === AUTH_METHOD_ID)) return finish();
      request("authenticate", { methodId: AUTH_METHOD_ID });
      return;
    }
    if (expectedMethod !== "session/new"
      || typeof result.sessionId !== "string"
      || !result.sessionId.trim()) return finish();
    finish(parseCursorAcpModelCatalog(result));
  };

  try {
    return await runBoundedDiscoveryProcess<RuntimeReasoningCatalog | undefined>({
      process: processHandle, label: "Cursor", timeoutMs: options.timeoutMs ?? CATALOG_PROBE_TIMEOUT_MS,
      outputMaxBytes: options.outputMaxBytes ?? CATALOG_PROBE_OUTPUT_MAX_BYTES,
      cleanup: options.cleanup, exitEvent: "exit",
      onStdout: (text) => {
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (control.settled) break;
          if (line.trim()) onLine(line);
        }
      },
      onExit: () => finish(),
      onStart: (transport) => {
        control = transport;
        request("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "alook-agent-driver-probe", version: "0.1.25" },
        });
      },
    });
  } catch { return undefined; }
}
