export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type BuiltinBackendId = "claude" | "codex" | "cursor" | "opencode" | "pi";
export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | (string & Record<never, never>);

export type RuntimeSettingsUpdate = {
  readonly reasoningEffort: ReasoningEffort | null;
};

export type RuntimeSettingsUpdateResult =
  | { readonly status: "applied" }
  | { readonly status: "unsupported"; readonly error?: AgentDriverError }
  | { readonly status: "failed"; readonly error: AgentDriverError };

export type RuntimeReasoningCatalog = {
  readonly updateMode: "live_next_turn" | "context_preserving_restart" | "unsupported";
  readonly defaultModelId?: string;
  readonly models: readonly {
    readonly id: string;
    readonly displayName?: string;
    readonly supportedReasoningEfforts: readonly {
      readonly value: ReasoningEffort;
      readonly description?: string;
    }[];
    readonly defaultReasoningEffort?: ReasoningEffort;
  }[];
};

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

export interface ModelBackendConfig extends BaseBackendConfig {
  readonly model: ModelSelection;
}

export type CursorConfig = ModelBackendConfig;
export type OpenCodeConfig = ModelBackendConfig;

export interface PiConfig extends Omit<BaseBackendConfig, "command"> {
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
  readonly sessionLifetime: "persistent" | "per_turn";
  readonly midTurnDelivery: "steer" | "safe_boundary_queue" | "next_turn_queue";
  readonly interrupt: boolean;
}

export type FixedCapabilities<
  Provider extends boolean,
  Reasoning extends boolean,
  Fast extends boolean,
  Tools extends boolean,
  Command extends boolean,
  Delivery extends BackendCapabilities["midTurnDelivery"],
  Lifetime extends BackendCapabilities["sessionLifetime"],
> = BackendCapabilities & {
  readonly modelSelection: "launchable";
  readonly providerConfiguration: Provider;
  readonly reasoningEffort: Reasoning;
  readonly fastMode: Fast;
  readonly disallowedTools: Tools;
  readonly commandOverride: Command;
  readonly resume: "by_id";
  readonly sessionLifetime: Lifetime;
  readonly midTurnDelivery: Delivery;
  readonly interrupt: true;
};

export type ClaudeCapabilities = FixedCapabilities<true, true, true, true, true, "safe_boundary_queue", "persistent">;
export type CodexCapabilities = FixedCapabilities<false, true, true, false, true, "safe_boundary_queue", "persistent">;
export type CursorCapabilities = FixedCapabilities<false, false, false, false, true, "steer", "persistent">;
export type OpenCodeCapabilities = FixedCapabilities<false, false, false, false, true, "steer", "persistent">;
export type PiCapabilities = FixedCapabilities<true, true, false, false, false, "steer", "persistent">;

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

export type TokenMetricDelta = number | null;

export interface TokenUsageDelta {
  readonly input: TokenMetricDelta;
  readonly output: TokenMetricDelta;
  readonly cache: TokenMetricDelta;
}

export type QuotaErrorCode =
  | "unavailable"
  | "unauthorized"
  | "network"
  | "provider_error"
  | "invalid_response";

export type QuotaProductIdentity =
  | { readonly kind: "reported"; readonly id: string; readonly displayName: string }
  | { readonly kind: "unknown"; readonly displayName: string };

export type QuotaModelIdentity =
  | { readonly kind: "reported"; readonly id: string }
  | { readonly kind: "not_applicable" }
  | { readonly kind: "unknown" };

export type QuotaWindowIdentity =
  | { readonly kind: "rolling"; readonly durationSeconds: number; readonly displayName: string }
  | { readonly kind: "calendar"; readonly period: "day" | "week" | "month"; readonly displayName: string }
  | {
      readonly kind: "provider_defined";
      readonly id: string;
      readonly durationSeconds?: number;
      readonly displayName: string;
    };

export interface QuotaLimit {
  readonly bucket: {
    readonly limitId: string;
    readonly product: QuotaProductIdentity;
    readonly model: QuotaModelIdentity;
    readonly window: QuotaWindowIdentity;
  };
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

export type ProviderQuotaObservation =
  | {
      readonly status: "available";
      readonly sourceEpoch: string;
      readonly planName?: string;
      readonly freshForSeconds: number;
      readonly limits: readonly QuotaLimit[];
    }
  | {
      readonly status: "error";
      readonly sourceEpoch: string;
      readonly code: QuotaErrorCode;
      readonly retryable: boolean;
    };

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
  | { readonly type: "backend_turn_started"; readonly turnId: string; readonly backendTurnId: string }
  | { readonly type: "work_heartbeat"; readonly turnId: string }
  | {
      readonly type: "assistant_reasoning_completed";
      readonly turnId: string;
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly type: "assistant_message_completed";
      readonly turnId: string;
      readonly text: string;
      readonly truncated: boolean;
    }
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
      readonly type: "recovery";
      readonly turnId?: string;
      readonly stage: "retrying" | "recovered";
      readonly source?: string;
    }
  | {
      readonly type: "token_usage";
      readonly turnId?: string;
      readonly source: string;
      readonly usage: TokenUsageDelta;
    }
  | {
      readonly type: "rate_limits";
      readonly turnId?: string;
      readonly source: string;
      readonly quota: ProviderQuotaObservation;
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
  readonly diagnostics: {
    readonly deliveryPhase:
      | "idle"
      | "admission_wait"
      | "steering"
      | "next_turn_queued"
      | "compacting"
      | "reviewing"
      | "tool_wait"
      | "working";
    readonly turnSilence: {
      readonly nativeIdleTimeoutMs: number;
      readonly daemonGraceMs: number;
      readonly recoveryGraceMs: number;
      readonly maxRecoveryExtensions: number;
      readonly normalBudgetMs: number;
    };
    readonly metrics: {
      readonly physicalOpenCount: number;
      readonly turnCount: number;
      readonly commandAdmissionCount: number;
      readonly commandAdmissionLatencyTotalMs: number;
      readonly queueDwellCount: number;
      readonly queueDwellTotalMs: number;
      readonly sseReconnectCount: number;
      /** Current blocker count only; call identities and tool names are never exposed. */
      readonly outstandingToolUses?: number;
      /** Outstanding calls whose adapter did not provide a stable identity. */
      readonly anonymousOutstandingToolUses?: number;
      /** Duplicate starts, unmatched finishes, or unattributable lifecycle events. */
      readonly toolLifecycleMismatchCount?: number;
      readonly resumeOutcome: "not_requested" | "pending" | "resumed" | "reset_required" | "failed";
      readonly terminalOwnerKind:
        | "transport_request"
        | "vendor_message"
        | "prompt_invocation"
        | "lane_generation";
    };
  };
}

export interface AgentEventStream<Event> extends AsyncIterable<Event> {
  readonly maxBufferedBytes: 4_194_304;
}

export type ExtensionNames<Specs, Id extends BackendId<Specs>> = Extract<keyof ExtensionsOf<Specs, Id>, string>;
export type ExtensionInput<Specs, Id extends BackendId<Specs>, Name extends ExtensionNames<Specs, Id>> =
  ExtensionsOf<Specs, Id>[Name] extends BackendExtensionSpec<infer Input, infer _Output>
    ? Input
    : never;
export type ExtensionOutput<Specs, Id extends BackendId<Specs>, Name extends ExtensionNames<Specs, Id>> =
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
  updateSettings?(input: RuntimeSettingsUpdate): Promise<RuntimeSettingsUpdateResult>;
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
  | {
      readonly status: "healthy";
      readonly version?: string;
      readonly capabilities: Capabilities;
      readonly reasoning?: RuntimeReasoningCatalog;
    }
  | {
      readonly status: "unhealthy";
      readonly error: AgentDriverError;
      readonly capabilities: Capabilities;
      readonly reasoning?: RuntimeReasoningCatalog;
    };

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
  readonly environmentLayers: Readonly<Record<
    "base" | "hostStatic" | "identityProtected" | "platformProtected" |
    "runtimeProtected" | "networkProtected" | "credentialSensitive",
    Readonly<Record<string, string | undefined>>
  >>;
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
