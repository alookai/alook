import type {
  BuiltinBackendId,
  ClaudeConfig,
  CodexConfig,
  CursorConfig,
  OpenCodeConfig,
  PiConfig,
  PreparedExecutionResource,
  JsonValue,
} from "../contract.js";

export type BackendConfig = ClaudeConfig | CodexConfig | CursorConfig | OpenCodeConfig | PiConfig;

export type WellKnownTransportKind =
  | "stdio_stream"
  | "stdio_rpc"
  | "http_sse"
  | "in_process_sdk"
  | "one_shot_cli";

export interface AdapterTransport {
  readonly kind: WellKnownTransportKind | (string & {});
  readonly protocol: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export type TerminalOwnership =
  | "transport_request"
  | "vendor_message"
  | "prompt_invocation"
  | "lane_generation";

export interface BackendExecution {
  readonly lifetime: "session" | "turn";
  readonly transport: AdapterTransport;
  readonly wakeStart: "immediate" | "deferred";
  readonly terminalOwnership: TerminalOwnership;
  readonly turnSilence?: {
    readonly nativeIdleTimeoutMs: number;
    readonly daemonGraceMs: number;
    readonly recoveryGraceMs: number;
    readonly maxRecoveryExtensions: number;
  };
}

export const DEFAULT_NATIVE_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_DAEMON_GRACE_MS = 60_000;
export const DEFAULT_RECOVERY_GRACE_MS = 60_000;
export const DEFAULT_MAX_RECOVERY_EXTENSIONS = 1;

export type InputMode = "busy" | "idle";
export interface EncodeMessageOptions { mode?: InputMode }

export type AdapterEvent =
  | { kind: "session_init"; sessionId: string }
  | { kind: "assistant_reasoning_delta"; text: string }
  | { kind: "assistant_reasoning_completed"; text: string }
  | { kind: "assistant_message_delta"; text: string }
  | { kind: "assistant_message_completed"; text: string }
  | { kind: "tool_call"; name: string; input: unknown }
  | { kind: "tool_output"; name: string }
  | { kind: "compaction_started" }
  | { kind: "compaction_finished" }
  | { kind: "review_started" }
  | { kind: "review_finished" }
  | { kind: "internal_progress"; source?: string; itemType?: string; payloadBytes?: number }
  | { kind: "runtime_diagnostic"; severity?: string; source?: string; message: string }
  | { kind: "runtime_recovery"; stage: "retrying" | "recovered"; source?: string }
  | { kind: "runtime_metric"; name: "sse_reconnect"; increment: 1 }
  | { kind: "turn_owner"; receipt: string; nativeTurnId?: string }
  | { kind: "turn_end"; sessionId?: string; turnOwner?: string }
  | { kind: "error"; message: string }
  | { kind: "telemetry"; name: "token_usage" | "rate_limits"; source: string; usageKind?: string; attrs: Record<string, unknown> };

export interface LaneStartInput {
  readonly text: string;
  readonly sessionId?: string;
  readonly terminalOwner?: string;
}

export interface LaneSendInput extends LaneStartInput {
  readonly mode: InputMode;
}

export type LaneAdmission =
  | { readonly ok: true; readonly acceptedAs: "prompt" | "steer"; readonly receipt: string }
  | { readonly ok: false; readonly reason: string; readonly error?: string };

export interface LaneInterruptInput {
  readonly requestId?: string;
  readonly reason?: string;
}

export interface LaneStopInput {
  readonly reason?: string;
  readonly signal?: "SIGTERM" | "SIGINT" | "SIGKILL";
  readonly forceAfterMs?: number;
}

export interface RuntimeLaneExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly reason: "requested" | "runtime_exit";
}

export interface RuntimeLaneEventMap {
  readonly runtime_event: AdapterEvent;
  readonly stderr: string;
  readonly error: unknown;
  readonly exit: RuntimeLaneExit;
}

export interface RuntimeLane {
  readonly currentSessionId: string | null;
  start(input: LaneStartInput): Promise<LaneAdmission>;
  send(input: LaneSendInput): Promise<LaneAdmission>;
  interrupt(input: LaneInterruptInput): Promise<boolean>;
  stop(input: LaneStopInput): Promise<void>;
  on<K extends keyof RuntimeLaneEventMap>(
    event: K,
    listener: (value: RuntimeLaneEventMap[K]) => void,
  ): void;
}

export interface RuntimeLaneOpenOptions {
  readonly onRawStdoutLine?: (line: string) => void;
}

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
  readonly stdin?: {
    readonly destroyed?: boolean;
    readonly writable?: boolean;
    readonly writableEnded?: boolean;
    write(chunk: string): unknown;
  } | null;
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
  openLane(
    ctx: AdapterLaunchContext<Id, Config>,
    options?: RuntimeLaneOpenOptions,
  ): Promise<RuntimeLane>;
  /** Binds a logical turn to an authoritative vendor/transport invocation. */
  beginTurn?(): string;
}
