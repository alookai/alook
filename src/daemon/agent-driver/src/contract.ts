export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type BuiltinBackendId = "claude" | "codex" | "cursor" | "opencode" | "pi";
export type ReasoningEffort = "low" | "medium" | "high";

export type ModelSelection =
  | { readonly kind: "default" }
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "custom"; readonly name: string };

export type DefaultProvider = { readonly kind: "default" };
export type ClaudeProvider =
  | DefaultProvider
  | { readonly kind: "custom_endpoint"; readonly apiUrl: string; readonly apiKey: string };
export type PiProvider =
  | DefaultProvider
  | {
      readonly kind: "builtin";
      readonly providerId: "google" | "openai" | "openrouter" | (string & {});
      readonly apiKey: string;
    };

export interface BaseBackendConfig {
  readonly command?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface ClaudeConfig extends BaseBackendConfig {
  readonly model: ModelSelection;
  readonly provider: ClaudeProvider;
  readonly reasoningEffort?: ReasoningEffort;
  readonly mode: "default" | "fast";
  readonly disallowedTools?: string;
}

export interface CodexConfig extends BaseBackendConfig {
  readonly model: ModelSelection;
  readonly reasoningEffort?: ReasoningEffort;
  readonly mode: "default" | "fast";
}

export interface CursorConfig extends BaseBackendConfig {
  readonly model: ModelSelection;
}

export interface OpenCodeConfig extends BaseBackendConfig {
  readonly model: ModelSelection;
}

export interface PiConfig extends BaseBackendConfig {
  readonly model: ModelSelection;
  readonly provider: PiProvider;
  readonly reasoningEffort?: ReasoningEffort;
}

export interface BackendCapabilities {
  readonly modelSelection: "launchable" | "suggestion_only" | "unsupported";
  readonly providerConfiguration: boolean;
  readonly reasoningEffort: boolean;
  readonly fastMode: boolean;
  readonly disallowedTools: boolean;
  readonly commandOverride: boolean;
  readonly resume: "by_id" | "none";
  readonly midTurnDelivery: "steer" | "safe_boundary_queue" | "next_turn_queue";
  readonly interrupt: boolean;
}

export type ClaudeCapabilities = BackendCapabilities & {
  readonly modelSelection: "launchable";
  readonly providerConfiguration: true;
  readonly reasoningEffort: true;
  readonly fastMode: true;
  readonly disallowedTools: true;
  readonly commandOverride: true;
  readonly resume: "by_id";
  readonly midTurnDelivery: "safe_boundary_queue";
  readonly interrupt: true;
};

export type CodexCapabilities = BackendCapabilities & {
  readonly modelSelection: "launchable";
  readonly providerConfiguration: false;
  readonly reasoningEffort: true;
  readonly fastMode: true;
  readonly disallowedTools: false;
  readonly commandOverride: true;
  readonly resume: "by_id";
  readonly midTurnDelivery: "safe_boundary_queue";
  readonly interrupt: true;
};

export type CursorCapabilities = BackendCapabilities & {
  readonly modelSelection: "launchable";
  readonly providerConfiguration: false;
  readonly reasoningEffort: false;
  readonly fastMode: false;
  readonly disallowedTools: false;
  readonly commandOverride: true;
  readonly resume: "by_id";
  readonly midTurnDelivery: "next_turn_queue";
  readonly interrupt: true;
};

export type OpenCodeCapabilities = CursorCapabilities;

export type PiCapabilities = BackendCapabilities & {
  readonly modelSelection: "launchable";
  readonly providerConfiguration: true;
  readonly reasoningEffort: true;
  readonly fastMode: false;
  readonly disallowedTools: false;
  readonly commandOverride: true;
  readonly resume: "by_id";
  readonly midTurnDelivery: "steer";
  readonly interrupt: true;
};

export interface BackendExtensionSpec<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}

export interface BackendTypeSpec<Config, Capabilities, Extensions, ExtraEvent> {
  readonly config: Config;
  readonly capabilities: Capabilities;
  readonly extensions: Extensions;
  readonly extraEvent: ExtraEvent;
}

export interface BuiltinBackendSpecs {
  readonly claude: BackendTypeSpec<ClaudeConfig, ClaudeCapabilities, {}, never>;
  readonly codex: BackendTypeSpec<CodexConfig, CodexCapabilities, {}, never>;
  readonly cursor: BackendTypeSpec<CursorConfig, CursorCapabilities, {}, never>;
  readonly opencode: BackendTypeSpec<OpenCodeConfig, OpenCodeCapabilities, {}, never>;
  readonly pi: BackendTypeSpec<PiConfig, PiCapabilities, {}, never>;
}

export type BackendId<Specs> = Extract<keyof Specs, string>;
export type ConfigOf<Specs, Id extends BackendId<Specs>> =
  Specs[Id] extends BackendTypeSpec<infer Config, infer _Caps, infer _Extensions, infer _Event>
    ? Config
    : never;
export type CapabilitiesOf<Specs, Id extends BackendId<Specs>> =
  Specs[Id] extends BackendTypeSpec<infer _Config, infer Caps, infer _Extensions, infer _Event>
    ? Caps
    : never;
export type ExtensionsOf<Specs, Id extends BackendId<Specs>> =
  Specs[Id] extends BackendTypeSpec<infer _Config, infer _Caps, infer Extensions, infer _Event>
    ? Extensions
    : never;
export type ExtraEventOf<Specs, Id extends BackendId<Specs>> =
  Specs[Id] extends BackendTypeSpec<infer _Config, infer _Caps, infer _Extensions, infer Event>
    ? Event
    : never;

export interface AgentInstructions {
  readonly format: "markdown";
  readonly content: string;
}

export interface AgentLaunchContext {
  readonly workingDirectory: string;
  readonly instructions: AgentInstructions;
  readonly resumeSessionId?: string;
  readonly launchId: string;
}

export interface AgentMessage {
  readonly id: string;
  readonly kind: "user" | "system" | "recovery";
  readonly text: string;
  readonly sequence?: number;
}

export interface AgentDriverError {
  readonly category:
    | "runtime_unavailable"
    | "authentication"
    | "configuration"
    | "protocol"
    | "process"
    | "sdk"
    | "timeout"
    | "cancelled"
    | "buffer_overflow"
    | "internal";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

export type OpenSessionResult<Specs, Id extends BackendId<Specs>> =
  | {
      readonly ok: true;
      readonly session: AgentSession<Specs, Id>;
      readonly capabilities: CapabilitiesOf<Specs, Id>;
    }
  | { readonly ok: false; readonly error: AgentDriverError };

export type DeliveryReceipt =
  | {
      readonly status: "accepted";
      readonly delivery: "prompt" | "steer";
      readonly commandId: string;
      readonly turnId: string;
    }
  | {
      readonly status: "queued";
      readonly reason: "unsafe_boundary" | "runtime_busy" | "waiting_for_message";
      readonly commandId: string;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "closed"
        | "unsupported"
        | "invalid_input"
        | "runtime_unavailable"
        | "already_started"
        | "not_started"
        | "duplicate_conflict";
      readonly error?: AgentDriverError;
    };

export type InterruptResult =
  | { readonly status: "accepted"; readonly requestId: string; readonly turnId: string }
  | { readonly status: "not_running" }
  | { readonly status: "unsupported" }
  | { readonly status: "closed" }
  | { readonly status: "failed"; readonly error: AgentDriverError };

export interface StopInput {
  readonly reason: "owner_request" | "idle_timeout" | "stalled" | "shutdown" | "reset";
  readonly forceAfterMs: number;
}

export type StopReceipt =
  | { readonly status: "accepted"; readonly requestId: string }
  | { readonly status: "already_stopping"; readonly requestId: string }
  | { readonly status: "closed"; readonly result: AgentSessionResult }
  | { readonly status: "failed"; readonly error: AgentDriverError };

export type HostCleanupResult =
  | { readonly status: "not_acquired" }
  | { readonly status: "released" }
  | { readonly status: "failed"; readonly error: AgentDriverError }
  | { readonly status: "timed_out"; readonly error: AgentDriverError };

export type AgentSessionResult =
  | {
      readonly outcome: "completed";
      readonly requested: false;
      readonly backendSessionId?: string;
      readonly exitCode?: 0 | null;
      readonly signal?: null;
      readonly cleanup: HostCleanupResult;
    }
  | {
      readonly outcome: "stopped";
      readonly requested: true;
      readonly backendSessionId?: string;
      readonly exitCode?: number | null;
      readonly signal?: string | null;
      readonly cleanup: HostCleanupResult;
    }
  | {
      readonly outcome: "crashed";
      readonly requested: false;
      readonly backendSessionId?: string;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly error?: AgentDriverError;
      readonly cleanup: HostCleanupResult;
    }
  | {
      readonly outcome: "failed_to_start";
      readonly requested: false;
      readonly error: AgentDriverError;
      readonly cleanup: HostCleanupResult;
    }
  | {
      readonly outcome: "forced";
      readonly requested: true;
      readonly backendSessionId?: string;
      readonly error: AgentDriverError;
      readonly cleanup: HostCleanupResult;
    };

export type AgentTurnResult =
  | { readonly outcome: "success"; readonly backendSessionId: string }
  | { readonly outcome: "interrupted"; readonly backendSessionId?: string }
  | { readonly outcome: "failed"; readonly backendSessionId?: string; readonly error: AgentDriverError };

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
}

export type CoreAgentEventPayload =
  | { readonly type: "session_started"; readonly backendSessionId: string }
  | {
      readonly type: "command_queued";
      readonly commandId: string;
      readonly reason: "unsafe_boundary" | "runtime_busy" | "waiting_for_message";
    }
  | {
      readonly type: "command_accepted";
      readonly commandId: string;
      readonly turnId: string;
      readonly delivery: "prompt" | "steer";
    }
  | {
      readonly type: "command_failed";
      readonly commandId: string;
      readonly turnId?: string;
      readonly error: AgentDriverError;
    }
  | { readonly type: "turn_started"; readonly turnId: string; readonly commandIds: readonly string[] }
  | { readonly type: "thinking_delta"; readonly turnId: string; readonly text: string }
  | { readonly type: "text_delta"; readonly turnId: string; readonly text: string }
  | {
      readonly type: "tool_started";
      readonly turnId: string;
      readonly callId?: string;
      readonly name: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "tool_finished";
      readonly turnId: string;
      readonly callId?: string;
      readonly name: string;
      readonly output?: JsonValue;
    }
  | { readonly type: "compaction_started"; readonly turnId: string }
  | { readonly type: "compaction_finished"; readonly turnId: string }
  | { readonly type: "review_started"; readonly turnId: string }
  | { readonly type: "review_finished"; readonly turnId: string }
  | {
      readonly type: "internal_progress";
      readonly turnId?: string;
      readonly source?: string;
      readonly itemType?: string;
      readonly payloadBytes?: number;
    }
  | {
      readonly type: "diagnostic";
      readonly turnId?: string;
      readonly severity: "debug" | "info" | "warning" | "error";
      readonly source?: string;
      readonly message: string;
    }
  | {
      readonly type: "token_usage";
      readonly turnId?: string;
      readonly source: string;
      readonly usage: TokenUsage;
      readonly details: JsonObject;
    }
  | {
      readonly type: "rate_limits";
      readonly turnId?: string;
      readonly source: string;
      readonly details: JsonObject;
    }
  | {
      readonly type: "turn_completed";
      readonly turnId: string;
      readonly commandIds: readonly string[];
      readonly result: AgentTurnResult;
    }
  | { readonly type: "session_failed"; readonly error: AgentDriverError }
  | { readonly type: "session_closed"; readonly result: AgentSessionResult };

export interface AgentEventEnvelope {
  readonly sequence: number;
  readonly sessionInstanceId: string;
  readonly at: number;
}

export type AgentEvent<Specs, Id extends BackendId<Specs>> =
  AgentEventEnvelope & (CoreAgentEventPayload | ExtraEventOf<Specs, Id>);

export interface AgentSessionSnapshot {
  readonly sessionInstanceId: string;
  readonly state:
    | "new"
    | "awaiting_first_message"
    | "starting"
    | "idle"
    | "working"
    | "stopping"
    | "closed";
  readonly backendSessionId?: string;
  readonly activeTurn?: { readonly turnId: string; readonly commandIds: readonly string[] };
  readonly queuedCommands: readonly {
    readonly commandId: string;
    readonly kind: AgentMessage["kind"];
  }[];
  readonly lastEventSequence: number;
}

export interface AgentEventStream<Event> extends AsyncIterable<Event> {
  readonly maxBufferedBytes: 4_194_304;
}

type ExtensionNames<Specs, Id extends BackendId<Specs>> = Extract<keyof ExtensionsOf<Specs, Id>, string>;
type ExtensionInput<Specs, Id extends BackendId<Specs>, Name extends ExtensionNames<Specs, Id>> =
  ExtensionsOf<Specs, Id>[Name] extends BackendExtensionSpec<infer Input, infer _Output>
    ? Input
    : never;
type ExtensionOutput<Specs, Id extends BackendId<Specs>, Name extends ExtensionNames<Specs, Id>> =
  ExtensionsOf<Specs, Id>[Name] extends BackendExtensionSpec<infer _Input, infer Output>
    ? Output
    : never;

export type ExtensionResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly error: AgentDriverError };

export interface AgentSession<Specs, Id extends BackendId<Specs>> {
  readonly backend: Id;
  readonly capabilities: CapabilitiesOf<Specs, Id>;
  readonly sessionInstanceId: string;
  readonly events: AgentEventStream<AgentEvent<Specs, Id>>;
  readonly closed: Promise<AgentSessionResult>;
  start(message: AgentMessage): Promise<DeliveryReceipt>;
  send(message: AgentMessage): Promise<DeliveryReceipt>;
  interrupt(input: { readonly requestId: string; readonly reason: string }): Promise<InterruptResult>;
  stop(input: StopInput): Promise<StopReceipt>;
  snapshot(): AgentSessionSnapshot;
  invokeExtension<Name extends ExtensionNames<Specs, Id>>(
    name: Name,
    input: ExtensionInput<Specs, Id, Name>,
  ): Promise<ExtensionResult<ExtensionOutput<Specs, Id, Name>>>;
}

export interface ProbeInput<Specs, Id extends BackendId<Specs>> {
  readonly backend: Id;
  readonly command?: string;
}

export type BackendProbe<Capabilities> =
  | { readonly status: "healthy"; readonly version?: string; readonly capabilities: Capabilities }
  | { readonly status: "unhealthy"; readonly error: AgentDriverError; readonly capabilities: Capabilities };

export interface OpenSessionInput<Specs, Id extends BackendId<Specs>> {
  readonly backend: Id;
  readonly launch: AgentLaunchContext;
  readonly config: ConfigOf<Specs, Id>;
}

export interface AgentDriverSdk<Specs = BuiltinBackendSpecs> {
  readonly backendIds: readonly BackendId<Specs>[];
  probe<Id extends BackendId<Specs>>(
    input: ProbeInput<Specs, Id>,
  ): Promise<BackendProbe<CapabilitiesOf<Specs, Id>>>;
  open<Id extends BackendId<Specs>>(
    input: OpenSessionInput<Specs, Id>,
  ): Promise<OpenSessionResult<Specs, Id>>;
}

export interface PrepareExecutionInput {
  readonly backend: string;
  readonly launchId: string;
  readonly workingDirectory: string;
}

export type PrepareExecutionResult =
  | { readonly ok: true; readonly resource: PreparedExecutionResource }
  | { readonly ok: false; readonly error: AgentDriverError };

export interface RawOutputEvent {
  readonly backend: string;
  readonly launchId: string;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface PreparedExecutionResource {
  readonly environmentLayers: {
    readonly base: Readonly<Record<string, string | undefined>>;
    readonly hostStatic: Readonly<Record<string, string | undefined>>;
    readonly identityProtected: Readonly<Record<string, string | undefined>>;
    readonly platformProtected: Readonly<Record<string, string | undefined>>;
    readonly runtimeProtected: Readonly<Record<string, string | undefined>>;
    readonly networkProtected: Readonly<Record<string, string | undefined>>;
    readonly credentialSensitive: Readonly<Record<string, string | undefined>>;
  };
  readonly executablePath?: string;
  release(input: {
    readonly reason: "normal" | "failed_start" | "crash" | "requested_stop" | "consumer_closed";
    readonly signal: AbortSignal;
    readonly deadlineAt: number;
  }): Promise<void>;
}

export interface AgentDriverHost {
  prepareExecution(input: PrepareExecutionInput): Promise<PrepareExecutionResult>;
  onRawOutput(event: RawOutputEvent): void;
  now(): number;
  createId(): string;
}

export interface DefaultAgentDriverHostOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly onRawOutput?: (event: RawOutputEvent) => void;
}

export interface CreateAgentDriverSdkOptions {
  readonly host?: AgentDriverHost;
  readonly hostReleaseTimeoutMs?: number;
}
