import type {
  BuiltinBackendId,
  ClaudeConfig,
  CodexConfig,
  CursorConfig,
  OpenCodeConfig,
  PiConfig,
  PreparedExecutionResource,
} from "../contract.js";

export type BackendConfig = ClaudeConfig | CodexConfig | CursorConfig | OpenCodeConfig | PiConfig;

export type BackendExecution =
  | { kind: "persistent_process"; input: "direct" | "safe_boundary" }
  | { kind: "per_turn_process"; start: "immediate" | "deferred"; afterTurn: "natural_exit" | "terminate" }
  | { kind: "in_process_sdk"; input: "direct" };

export type InputMode = "busy" | "idle";
export interface EncodeMessageOptions { mode?: InputMode }

export type AdapterEvent =
  | { kind: "session_init"; sessionId: string }
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string; input: unknown }
  | { kind: "tool_output"; name: string }
  | { kind: "compaction_started" }
  | { kind: "compaction_finished" }
  | { kind: "review_started" }
  | { kind: "review_finished" }
  | { kind: "internal_progress"; source?: string; itemType?: string; payloadBytes?: number }
  | { kind: "runtime_diagnostic"; severity?: string; source?: string; message: string }
  | { kind: "turn_end"; sessionId?: string }
  | { kind: "error"; message: string }
  | { kind: "telemetry"; name: "token_usage" | "rate_limits"; source: string; usageKind?: string; attrs: Record<string, unknown> };

export interface AdapterRuntimeContext {
  agentId: string;
  serverId: string;
  computerId: string;
  computerName: string;
  hostname: string;
  os: string;
  daemonVersion: string;
  workspacePath: string;
}

export interface AdapterLaunchConfig<Config = BackendConfig> {
  sessionId?: string;
  runtimeConfig?: Config;
  description?: string;
  runtimeContext?: AdapterRuntimeContext;
  agentName?: string;
  agentDiscriminator?: string;
  agentHandle?: string;
  ownerHandle?: string;
}

export interface AdapterLaunchContext<Id extends string = BuiltinBackendId, Config = BackendConfig> {
  backend: Id;
  agentId: string;
  launchId: string;
  workingDirectory: string;
  standingPrompt: string;
  prompt: string;
  prepared: PreparedExecutionResource;
  config: AdapterLaunchConfig<Config>;
}

export interface SpawnedProcessHandle {
  readonly stdout?: { on(event: "data", listener: (chunk: { toString(): string }) => void): unknown } | null;
  readonly stderr?: { on(event: "data", listener: (chunk: { toString(): string }) => void): unknown } | null;
  readonly stdin?: { readonly destroyed?: boolean; write(chunk: string): unknown } | null;
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill(signal?: "SIGTERM" | "SIGINT" | "SIGKILL"): boolean;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "exit" | "close", listener: (code: number | null, signal: string | null) => void): unknown;
}

export interface SpawnedProcess { process: SpawnedProcessHandle }
export interface ProbeResult { status: "healthy" | "unhealthy"; version?: string; lastError?: string }

export interface VendorSessionHandle {
  prompt(text: string): void | Promise<void>;
  steer(text: string): void | Promise<void>;
  abort?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
  readonly isStreaming?: boolean;
}

export interface BackendAdapter<Id extends string = BuiltinBackendId, Config = BackendConfig> {
  readonly id: Id;
  readonly instructionDelivery:
    | { readonly kind: "native" }
    | { readonly kind: "workspace_file"; readonly canonical: string; readonly aliases: readonly string[] };
  readonly execution: BackendExecution;
  probe(command?: string): ProbeResult | Promise<ProbeResult>;
  spawn?(ctx: AdapterLaunchContext<Id, Config>): Promise<SpawnedProcess>;
  openSdkSession?(ctx: AdapterLaunchContext<Id, Config>): Promise<unknown>;
  normalizeLine(line: string): AdapterEvent[];
  readonly currentSessionId: string | null;
  encodeMessage(text: string, sessionId: string | null, opts?: EncodeMessageOptions): string | null;
}
