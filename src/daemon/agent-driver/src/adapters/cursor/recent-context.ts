import type { RecentContextDiscoveryData, RecentContextDiscoveryRequest } from "../../contract.js";
import {
  type DiscoveryProcessControl,
  type DiscoveryProcessDependencies,
  runBoundedDiscoveryProcess,
} from "../../internal/discovery-process.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import { resolveSpawnSpec } from "../../internal/probe.js";
import { RecentContextCollector } from "../../internal/recent-context.js";
import { asRecord, jsonRpcRequest, tryParseJsonLine } from "../../internal/utils.js";

const ACP_PROTOCOL_VERSION = 1;
const AUTH_METHOD_ID = "cursor_login";
const CURSOR_DISCOVERY_TIMEOUT_MS = 30_000;
const CURSOR_DISCOVERY_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

type CursorRecentContextDependencies = DiscoveryProcessDependencies;

export async function discoverCursorRecentContext(
  request: RecentContextDiscoveryRequest,
  dependencies: CursorRecentContextDependencies = {},
): Promise<RecentContextDiscoveryData> {
  const collector = new RecentContextCollector(request, "unavailable");
  if (collector.satisfied) return collector.result();
  const spec = resolveSpawnSpec("cursor-agent", ["acp"], request.command);
  const processHandle = (dependencies.spawn ?? spawnAgentProcess)(spec.command, spec.args, {
    cwd: dependencies.cwd ?? process.cwd(),
    env: { ...process.env, CI: "1" },
    shell: spec.shell,
  });

  let buffer = "";
  let requestId = 0;
  let expectedId = 0;
  let expectedMethod = "";
  const seenCursors = new Set<string>();
  const requestRpc = (
    method: string,
    params: Record<string, unknown>,
    control: DiscoveryProcessControl<RecentContextDiscoveryData>,
  ) => {
    expectedId = ++requestId;
    expectedMethod = method;
    control.write(`${jsonRpcRequest(method, params, expectedId)}\n`);
  };
  const requestPage = (control: DiscoveryProcessControl<RecentContextDiscoveryData>, cursor?: string) =>
    requestRpc("session/list", cursor ? { cursor } : {}, control);
  const onLine = (line: string, control: DiscoveryProcessControl<RecentContextDiscoveryData>) => {
    const message = asRecord(tryParseJsonLine(line));
    if (!message || message.id !== expectedId) return;
    if (message.error !== undefined) return control.fail("Cursor discovery request failed");
    const result = asRecord(message.result);
    if (!result) return control.fail("Cursor discovery returned an invalid response");
    if (expectedMethod === "initialize") {
      if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
        return control.fail("Cursor discovery protocol is incompatible");
      }
      const capabilities = asRecord(result.agentCapabilities);
      const sessionCapabilities = asRecord(capabilities?.sessionCapabilities);
      if (sessionCapabilities?.list !== true && !asRecord(sessionCapabilities?.list)) {
        return control.fail("Cursor session listing is unavailable");
      }
      const authMethods = Array.isArray(result.authMethods) ? result.authMethods : [];
      if (!authMethods.some((method) => asRecord(method)?.id === AUTH_METHOD_ID)) {
        return control.fail("Cursor discovery authentication is unavailable");
      }
      requestRpc("authenticate", { methodId: AUTH_METHOD_ID }, control);
      return;
    }
    if (expectedMethod === "authenticate") {
      requestPage(control);
      return;
    }
    if (expectedMethod !== "session/list") return control.fail("Cursor discovery state is invalid");
    const sessions = Array.isArray(result.sessions)
      ? result.sessions
      : Array.isArray(result.data)
        ? result.data
        : [];
    for (const value of sessions) {
      const session = asRecord(value);
      if (!session) continue;
      collector.add({ projectPath: session.cwd, modifiedAt: session.updatedAt });
      if (collector.satisfied) return control.finish(collector.result());
    }
    const nextCursor = typeof result.nextCursor === "string" && result.nextCursor
      ? result.nextCursor
      : undefined;
    if (!nextCursor) return control.finish(collector.result());
    if (seenCursors.has(nextCursor)) return control.fail("Cursor discovery cursor repeated");
    seenCursors.add(nextCursor);
    requestPage(control, nextCursor);
  };

  return runBoundedDiscoveryProcess({
    process: processHandle,
    label: "Cursor",
    timeoutMs: dependencies.timeoutMs ?? CURSOR_DISCOVERY_TIMEOUT_MS,
    outputMaxBytes: dependencies.outputMaxBytes ?? CURSOR_DISCOVERY_OUTPUT_MAX_BYTES,
    cleanup: dependencies.cleanup,
    exitEvent: "exit",
    onStdout: (text, final, control) => {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line, control);
      if (final && buffer.trim()) {
        const line = buffer;
        buffer = "";
        onLine(line, control);
      }
    },
    onExit: (_code, _signal, control) => control.fail("Cursor discovery process exited early"),
    onStart: (control) => requestRpc("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "alook-agent-driver-discovery", version: "0.1.31" },
    }, control),
  });
}
